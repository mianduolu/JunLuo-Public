import type { OwnedDayPlanBatch, OwnedDayPlanEntry, OwnScheduleSave, ScheduleSaveConflict } from './ownScheduleSaveState';
import { formatOwnDayPlanTime } from './ownDayPlanPolicy';
import { ownScheduleEntryIsFinal } from './ownScheduleSaveState';
export { ownScheduleEntryIsFinal } from './ownScheduleSaveState';
export { normalizeOwnScheduleSave } from './ownScheduleSaveState';
export type { OwnScheduleSave } from './ownScheduleSaveState';
import type { JunLuoToolCall } from '../tools/toolTypes';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { readingMessageRevision, readingMessageSourcesCurrent } from '../chat/chatReadingReferences';

async function ownScheduleSourceCurrent(source: OwnScheduleSave['source']) {
  if (!source) return true;
  const { loadChatSessionMessage } = await import('../chat/chatStorage');
  const message = await loadChatSessionMessage(source.sessionId, source.messageId);
  return !!message && readingMessageRevision(message) === source.revision
    && await readingMessageSourcesCurrent(source.readingSources ?? [], id => loadChatSessionMessage(source.sessionId, id));
}

export function formatScheduleSaveConflict(conflict: ScheduleSaveConflict,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const time = (value: number) => formatOwnDayPlanTime(value, timeZone);
  return [`想调整的时段：${time(conflict.startAt)}—${time(conflict.endAt)}`,
    ...(conflict.kind === 'sleep' ? ['这项安排与 I 已保存的睡眠时段重叠。',
      `这一觉的安排：${time(conflict.conflictStartAt)}—${time(conflict.conflictEndAt)}`]
      : [`与这项安排重叠：${conflict.title}`,
        `这项安排的时间：${time(conflict.conflictStartAt)}—${time(conflict.conflictEndAt)}`]),
  ].join('\n');
}

export function ownScheduleEntryReceipt(entry: OwnedDayPlanEntry, stage: OwnScheduleSave['stage'],
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  if (entry.saved) return ['日程已保存。', entry.choiceError].filter(Boolean).join('\n');
  const error = entry.preparationError ?? entry.error;
  if (error && /^(找不到标签 |标签 |接着已有安排做和重新选择内容，|《)/.test(error)) return error;
  if (error === 'schedule-duration-ended') return '这项活动已经结束，本次时长修改没有生效。';
  if (error === 'schedule-duration-cancelled') return '这项安排已经取消，本次时长修改没有生效。';
  if (!ownScheduleEntryIsFinal(entry) && (stage === 'unknown' || stage === 'pending')) return '日程保存结果暂时无法确认。';
  const conflict = entry.conflict;
  return ['这次还没保存好，日程暂时还是原来的安排。', conflict ? formatScheduleSaveConflict(conflict, timeZone) : ''].filter(Boolean).join('\n');
}

export function ownScheduleSaveSummary(value: OwnScheduleSave) {
  return value.batch.entries.map(entry => `${entry.targetScheduleId}｜${ownScheduleEntryReceipt(entry, value.stage)}`).join('\n');
}

/** Reuse the original tool/night journals; only current, explicitly referenced plans receive a receipt. */
export async function loadOwnScheduleRelevantReceipts(items: readonly import('./scheduleStore').ScheduleItem[], timeZone: string) {
  const result = new Map<string, { at: number; text: string }>();
  if (!items.length) return result;
  const { schedulePlanVersion } = await import('./scheduleStore');
  const consider = async (batch: OwnedDayPlanBatch, stage: OwnScheduleSave['stage'], at: number) => {
    for (const entry of batch.entries) {
      const item = items.find(value => value.id === entry.targetScheduleId);
      if (!item || entry.saved && !entry.choiceError) continue;
      if (entry.saved && entry.choiceError) {
        const { loadOwnReadingChoice } = await import('./ownedDayPlanStore');
        const actual = await loadOwnReadingChoice(item);
        if (actual?.choice.operationId !== entry.id) continue;
      } else if (entry.sourcePlanVersion !== undefined
        ? entry.sourcePlanVersion !== schedulePlanVersion(item) : entry.sourceUpdatedAt !== item.updatedAt) continue;
      if ((result.get(item.id)?.at ?? -1) > at) continue;
      result.set(item.id, { at, text: ownScheduleEntryReceipt(entry, stage, timeZone) });
    }
  };
  const { loadRecentToolCalls } = await import('../tools/toolAuditStore');
  for (const record of await loadRecentToolCalls(200)) if (record.scheduleSave) {
    await consider(record.scheduleSave.batch, record.scheduleSave.stage, record.scheduleSave.updatedAt);
  }
  const { listAssistantLifeDays, loadAssistantLifeDay } = await import('../ai/assistantLifeTimeline');
  for (const key of await listAssistantLifeDays()) {
    const day = await loadAssistantLifeDay(key);
    for (const phase of ['prepare', 'wake'] as const) {
      const run = day?.nightSleepPlan?.dayPlan?.[phase];
      if (run?.batch) await consider(run.batch, run.status === 'failed' ? 'failed'
        : run.status === 'complete' ? 'complete' : 'pending', run.updatedAt);
    }
  }
  return result;
}

let saving: Promise<unknown> = Promise.resolve();
/** Reuse the tool's parsed batch and journal; never regenerate, never reset the four saves. */
export function saveOwnScheduleToolBatch(call: JunLuoToolCall, initial: OwnedDayPlanBatch | undefined,
  dataEpoch: number, valid: () => Promise<boolean>, source?: OwnScheduleSave['source'],
  onProgress?: (batch: OwnedDayPlanBatch) => Promise<void>): Promise<OwnScheduleSave> {
  const work: Promise<OwnScheduleSave> = saving.then(async (): Promise<OwnScheduleSave> => {
    const { loadToolAuditRecord, recordOwnScheduleSave } = await import('../tools/toolAuditStore');
    const { persistOwnedDayPlanBatch, reconcileOwnedDayPlanBatch } = await import('./ownedDayPlanStore');
    const prior = await loadToolAuditRecord(call.callId);
    let state: OwnScheduleSave = prior?.scheduleSave ?? { version: 1, dataEpoch,
      batch: initial!, attempts: 0, stage: 'pending', updatedAt: Date.now(), ...(source ? { source } : {}) };
    if (!state.batch || state.batch.opId !== call.callId || state.dataEpoch !== dataEpoch) throw new Error('schedule-save-source-changed');
    if (state.stage === 'complete' || state.stage === 'failed') return state;
    const write = async () => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new Error('schedule-save-epoch-changed');
      state = { ...state, updatedAt: Math.max(Date.now(), state.updatedAt + 1) };
      const result = await runBackupRestoreDataEpochCommit(dataEpoch, () => recordOwnScheduleSave(call, state));
      if (!result.committed) throw new Error('schedule-save-epoch-changed');
    };
    if (prior?.scheduleSave) {
      try { state = { ...state, batch: await reconcileOwnedDayPlanBatch(state.batch) }; }
      catch { return { ...state, stage: 'unknown' }; }
    } else await write();
    await onProgress?.(state.batch);
    while (state.attempts < 4 && state.batch.entries.some(entry => !entry.saved && !ownScheduleEntryIsFinal(entry))) {
      if (!await valid() || !await ownScheduleSourceCurrent(state.source)) return state;
      state = { ...state, attempts: state.attempts + 1, stage: 'pending' };
      await write(); // This write must succeed before the database is touched.
      try {
        const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
          if (!await valid() || !await ownScheduleSourceCurrent(state.source)) return state.batch;
          return persistOwnedDayPlanBatch(state.batch);
        });
        if (!committed.committed) return state;
        state = { ...state, batch: committed.value };
      } catch {
        try { state = { ...state, batch: await reconcileOwnedDayPlanBatch(state.batch) }; }
        catch { state = { ...state, stage: 'unknown' }; await write(); return state; }
      }
      await onProgress?.(state.batch);
      await write();
    }
    state = { ...state, stage: state.batch.entries.every(entry => entry.saved) ? 'complete' : 'failed' };
    await write();
    return state;
  });
  saving = work.catch(() => undefined);
  return work;
}

/** The existing Android activity check calls this; there is no new scheduler. */
export async function resumeOwnScheduleSaves(dataEpoch: number) {
  const { loadRecentToolCalls, recordOwnScheduleSave } = await import('../tools/toolAuditStore');
  for (const record of await loadRecentToolCalls(200)) {
    const state = record.scheduleSave;
    if (!state || state.dataEpoch !== dataEpoch || !['pending', 'unknown'].includes(state.stage)) continue;
    const call: JunLuoToolCall = { callId: record.callId, toolId: 'schedule.save_own', input: {},
      requestedBy: record.source, createdAt: record.createdAt };
    const sourceValid = async () => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      if (record.source === 'chat') {
        if (!state.source) return false;
        if (!await ownScheduleSourceCurrent(state.source)) return false;
      }
      const { loadReadingLibraryStrict } = await import('../reading/readingStore');
      const books = await loadReadingLibraryStrict();
      return state.batch.entries.filter(entry => !entry.saved && !entry.preparationError && entry.action !== 'cancel')
        .every(entry => !entry.readingId || books.some(book => book.id === entry.readingId));
    };
    try {
      if (!await sourceValid()) {
        const { reconcileOwnedDayPlanBatch } = await import('./ownedDayPlanStore');
        const batch = await reconcileOwnedDayPlanBatch(state.batch);
        if (canCommitBackupRestoreDataEpoch(dataEpoch)) await runBackupRestoreDataEpochCommit(dataEpoch,
          () => recordOwnScheduleSave(call, { ...state, batch, stage: 'failed', updatedAt: Math.max(Date.now(), state.updatedAt + 1) }));
        continue;
      }
      await saveOwnScheduleToolBatch(call, undefined, dataEpoch, sourceValid);
    } catch {
      // A temporary read failure is not source deletion; retain this original local stage.
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    }
  }
}
