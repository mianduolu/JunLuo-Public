import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { ownDayPlanIds, parseOwnScheduleEntries } from '../schedule/ownDayPlanPolicy';
import { loadOwnActiveHabits, saveOwnHabitChanges, type OwnHabitChanges } from '../schedule/habitStore';
import { prepareOwnedDayPlanBatch, type OwnedDayPlanBatch } from '../schedule/ownedDayPlanStore';
import { saveOwnScheduleToolBatch, ownScheduleSaveSummary } from '../schedule/ownScheduleSave';
import { loadReadingLibraryStrict } from '../reading/readingStore';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import { ownReadingAvailability, ownReadingLabels } from '../schedule/ownReadingSelectionMaterial';
import { readingMessageRevision, readingMessageSourcesCurrent, type ReadingMessageSource } from '../chat/chatReadingReferences';

export function parseOwnHabitChanges(input: Record<string, unknown>): OwnHabitChanges {
  if (Object.keys(input).some(key => !['entries', 'stopIds'].includes(key)) || !Array.isArray(input.entries)) throw new Error('invalid-own-habit-input');
  const stopIds = ownDayPlanIds(input.stopIds);
  const entries = input.entries.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid-own-habit-entry');
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !['id', 'title', 'frequency', 'count', 'weekDays', 'minutes'].includes(key))
      || !(value.id === null || typeof value.id === 'string' && value.id.trim())
      || typeof value.title !== 'string' || !value.title.trim()
      || !['daily', 'weekly', 'weekdays'].includes(String(value.frequency))
      || !Number.isSafeInteger(value.count) || Number(value.count) <= 0
      || !Array.isArray(value.weekDays) || value.weekDays.some(day => !Number.isInteger(day) || day < 1 || day > 7)
      || new Set(value.weekDays).size !== value.weekDays.length
      || (value.frequency === 'weekdays' ? !value.weekDays.length : value.weekDays.length !== 0)
      || !(value.minutes === null || Number.isSafeInteger(value.minutes) && Number(value.minutes) > 0)) throw new Error('invalid-own-habit-entry');
    return value as OwnHabitChanges['entries'][number];
  });
  const targets = [...entries.flatMap(entry => entry.id ? [entry.id] : []), ...stopIds];
  if (new Set(targets).size !== targets.length) throw new Error('duplicate-own-habit-target');
  return { entries, stopIds };
}

/** One host-bound turn; semantic agreement stays in the approved model tool, not a keyword detector. */
export async function createOwnScheduleTurn(input: {
  dataEpoch: number; signal?: AbortSignal; sourceMessageId?: string; sourceSessionId?: string;
  isCurrent?: () => boolean | Promise<boolean>;
  scheduleVersions?: Record<string, number>; habitVersions?: Record<string, number>;
  onHabitsSaved?: (versions: Record<string, number>) => Promise<void>;
  lifeAgent?: boolean;
  nearStatus?: { allowedIds: string[] };
  onSchedulesSaved?: (batch: OwnedDayPlanBatch) => Promise<void>;
  readingSources?: ReadingMessageSource[];
}) {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  let habits = await loadOwnActiveHabits();
  const habitVersions = { ...(input.habitVersions ?? Object.fromEntries(habits.map(item => [item.id, item.updatedAt]))) };
  const scheduleVersions = { ...input.scheduleVersions };
  let readingLabels: Record<string, string> = {};
  const expectedChoiceVersions: Record<string, number> = {};
  const observedReadingIds = new Set<string>();
  const results = new Map<string, JunLuoToolResult>();
  const valid = async () => !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch)
    && (!input.isCurrent || await input.isCurrent())
    && (input.lifeAgent || !!input.sourceMessageId && !!input.sourceSessionId);
  const observe = async (result: JunLuoToolResult) => {
    if (!result.ok || result.toolId !== 'schedule.query_agenda') return;
    const records = (result.data as { scheduleItems?: Array<{ itemId: string; updatedAt?: number; readingId?: string; localId?: string; nextReadingId?: string | null }> } | undefined)?.scheduleItems;
    const store = await import('../schedule/scheduleStore');
    const items = (await Promise.all((records ?? []).map(item => store.loadScheduleItemById(item.itemId))))
      .filter((item): item is NonNullable<typeof item> => !!item && records!.some(record => record.itemId === item.id && record.updatedAt === item.updatedAt));
    for (const item of items) scheduleVersions[item.id] = store.schedulePlanVersion(item);
    const selection = await ownReadingLabels(items, await ownReadingAvailability(await loadReadingLibraryStrict()), readingLabels);
    readingLabels = selection.readingLabels;
    Object.assign(expectedChoiceVersions, selection.expectedChoiceVersions);
    for (const fact of Object.values(selection.facts)) {
      if (fact.currentReadingId) observedReadingIds.add(fact.currentReadingId);
      if (fact.nextReadingId) observedReadingIds.add(fact.nextReadingId);
    }
    for (const record of records ?? []) if (selection.facts[record.itemId]) {
      record.localId = selection.facts[record.itemId].localId;
      record.readingId = selection.facts[record.itemId].currentReadingId;
      record.nextReadingId = selection.facts[record.itemId].nextReadingId;
    }
  };
  const execute = async (call: JunLuoToolCall): Promise<JunLuoToolResult> => {
    if (!await valid()) return createToolErrorResult(call, createToolError('STALE_DATA_EPOCH', 'schedule-turn-stale'), '');
    const previous = results.get(call.callId);
    if (previous) return previous;
    const now = call.createdAt;
    const commit = async <T>(fn: () => Promise<T>) => {
      if (!await valid()) throw new Error('schedule-turn-stale');
      const outcome = await runBackupRestoreDataEpochCommit(input.dataEpoch, fn);
      if (!outcome.committed) throw new Error('schedule-turn-stale');
      return outcome.value;
    };
    let result: JunLuoToolResult;
    try {
      if (call.toolId === 'schedule.save_own_habits') {
        const changes = parseOwnHabitChanges(call.input);
        // Reuse the same input, call identity and timestamps for all four local saves.
        let saved: Awaited<ReturnType<typeof saveOwnHabitChanges>> | undefined;
        for (let attempt = 0; attempt < 4; attempt += 1) {
          try {
            saved = await commit(() => saveOwnHabitChanges(changes, call.callId, now, habitVersions));
            for (const item of saved.entries) habitVersions[item.id] = item.updatedAt;
            for (const id of saved.stoppedIds) delete habitVersions[id];
            await input.onHabitsSaved?.({ ...habitVersions });
          } catch (error) {
            if (!await valid() || attempt === 3) {
              if (saved) break;
              throw error;
            }
            continue;
          }
          if (!saved.errors.length || saved.errors.every(error => /invalid|duplicate|target-/.test(error.code))) break;
        }
        if (!saved) throw new Error('own-habit-save-failed');
        const text = [...saved.entries.map(item => `已保存习惯：${item.id}｜${item.title}`),
          ...saved.stoppedIds.map(id => `已停止习惯：${id}｜${habits.find(item => item.id === id)?.title ?? id}`),
          ...saved.errors.map(error => `习惯操作未完成：${changes.entries.find(item => item.id === error.id)?.title ?? error.id}｜${error.code}`)].join('\n');
        result = saved.errors.length ? { ...createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'own-habit-save-incomplete'), text), data: saved }
          : createToolSuccessResult(call, text, saved);
        habits = await loadOwnActiveHabits();
      } else if (call.toolId === 'schedule.save_own' && (!input.lifeAgent || input.nearStatus)) {
        if (Object.keys(call.input).some(key => !['entries', 'cancelIds'].includes(key))) throw new Error('invalid-day-plan-field');
        const entries = parseOwnScheduleEntries(call.input.entries, { startAt: 0, endAt: Number.MAX_SAFE_INTEGER, timeZone }, true);
        const cancelIds = ownDayPlanIds(call.input.cancelIds);
        if (input.nearStatus && (entries.some(entry => !entry.id || entry.owner !== 'I' || !input.nearStatus!.allowedIds.includes(entry.id)
          || entry.localId !== undefined || entry.continueFrom !== undefined || entry.nextReadingId !== undefined)
          || cancelIds.some(id => !input.nearStatus!.allowedIds.includes(id)))) throw new Error('schedule-home-target-forbidden');
        // A reschedule is not a request to detach the original reading/habit.
        const unchangedReadingIds = new Map<string, Set<string>>();
        for (const entry of entries) if (entry.id) {
          const item = await (await import('../schedule/scheduleStore')).loadScheduleItemById(entry.id);
          if (item) {
            if (scheduleVersions[item.id] === (await import('../schedule/scheduleStore')).schedulePlanVersion(item)) {
              const choice = await (await import('../schedule/ownedDayPlanStore')).loadOwnReadingChoice(item);
              unchangedReadingIds.set(entry.id, new Set([item.readingId, choice?.choice.currentReadingId, choice?.choice.nextReadingId]
                .filter((id): id is string => !!id)));
            }
            if (entry.readingId === null) entry.readingId = item.readingId ?? null;
            if (entry.habitId === undefined) entry.habitId = item.habitId;
            if (input.nearStatus && (entry.readingId !== (item.readingId ?? null) || entry.habitId !== item.habitId)) throw new Error('schedule-home-reference-changed');
            // Home may move the slot, never reselect the cached A after the shared cursor reached B.
            if (input.nearStatus && item.execution?.readingChoice) delete entry.readingId;
          }
        }
        const books = await loadReadingLibraryStrict();
        if (entries.some(entry => entry.readingId && !books.some(book => book.id === entry.readingId)
          || entry.habitId && !habits.some(habit => habit.id === entry.habitId))) throw new Error('schedule-reference-unavailable');
        const usedReadingSources: ReadingMessageSource[] = [];
        if (input.readingSources !== undefined) {
          for (const entry of entries) for (const readingId of [entry.readingId, entry.nextReadingId]) {
            if (!readingId || observedReadingIds.has(readingId) || entry.id && unchangedReadingIds.get(entry.id)?.has(readingId)) continue;
            const reference = input.readingSources.find(source => source.readingId === readingId);
            if (!reference) throw new Error('schedule-reading-reference-not-provided');
            if (!usedReadingSources.some(source => source.messageId === reference.messageId)) usedReadingSources.push(reference);
          }
          if (!input.sourceSessionId || !await readingMessageSourcesCurrent(usedReadingSources,
            id => import('../chat/chatStorage').then(store => store.loadChatSessionMessage(input.sourceSessionId!, id)))) {
            throw new Error('schedule-reading-reference-changed');
          }
        }
        const prepared: OwnedDayPlanBatch = await prepareOwnedDayPlanBatch({ opId: call.callId, entries, cancelIds,
          allowedOwners: input.nearStatus ? ['I'] : ['I', 'I 和 you'], expectedVersions: scheduleVersions,
          readingLabels, expectedChoiceVersions, readingAvailability: await ownReadingAvailability(books) });
        let saved: import('../schedule/ownScheduleSaveState').OwnScheduleSave;
        const source = !input.lifeAgent && input.sourceMessageId && input.sourceSessionId ? await (async () => {
          const message = await (await import('../chat/chatStorage')).loadChatSessionMessage(input.sourceSessionId!, input.sourceMessageId!);
          if (!message) throw new Error('schedule-chat-source-unavailable');
          return { sessionId: input.sourceSessionId!, messageId: input.sourceMessageId!,
            revision: readingMessageRevision(message), ...(usedReadingSources.length ? { readingSources: usedReadingSources } : {}) };
        })() : undefined;
        try { saved = await saveOwnScheduleToolBatch(call, prepared, input.dataEpoch, valid, source, input.onSchedulesSaved); }
        catch (error) {
          // An acknowledgement write can fail after the actual schedule committed.
          // Reconcile only; never spend another save here or call the model again.
          try {
            const prior = (await (await import('./toolAuditStore')).loadToolAuditRecord(call.callId))?.scheduleSave;
            const batch = await (await import('../schedule/ownedDayPlanStore')).reconcileOwnedDayPlanBatch(prior?.batch ?? prepared);
            saved = { version: 1, dataEpoch: input.dataEpoch, attempts: prior?.attempts ?? 0,
              batch, updatedAt: Date.now(), stage: batch.entries.every(entry => entry.saved) ? 'complete' : 'unknown' };
          } catch {
            result = createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'schedule-save-unconfirmed'), '日程保存结果暂时无法确认。');
            results.set(call.callId, result); return result;
          }
        }
        const batch = saved.batch;
        if (batch.entries.some(entry => entry.saved)) {
          await import('../schedule/ownScheduleExecution').then(module => module.reconcileOwnScheduleAdjustments(Date.now())).catch(() => undefined);
        }
        let summary = ownScheduleSaveSummary(saved);
        for (const entry of batch.entries.filter(entry => entry.saved)) {
          const store = await import('../schedule/scheduleStore');
          const item = await store.loadScheduleItemById(entry.targetScheduleId).catch(() => null);
          if (item) scheduleVersions[item.id] = store.schedulePlanVersion(item);
          if (item) {
            const choice = await (await import('../schedule/ownedDayPlanStore')).loadOwnReadingChoice(item);
            if (choice) expectedChoiceVersions[choice.root.id] = choice.choice.version;
          }
          if (item?.execution?.adjustment?.pending || item?.execution?.durationChange?.pending) summary = summary.replace(`${entry.targetScheduleId}｜日程已保存。`,
            `${entry.targetScheduleId}｜日程已保存，活动收尾尚未完成。`);
        }
        const failed = batch.entries.some(entry => !entry.saved || entry.choiceError);
        result = failed ? { ...createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'schedule-save-incomplete'), summary), data: batch }
          : createToolSuccessResult(call, summary, batch);
        if (batch.entries.some(entry => entry.saved)) {
          await import('../life/sleepPlanRuntime').then(module => module.reconcileSleepPlanLocally()).catch(() => undefined);
        }
      } else throw new Error('schedule-tool-not-allowed');
    } catch (error) {
      result = createToolErrorResult(call, createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : 'schedule-save-failed'), '');
    }
    results.set(call.callId, result);
    return result;
  };
  return { execute, observe, scheduleVersions, habitVersions };
}
