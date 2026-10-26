import { loadDayTemplate, persistDayTemplate, runUserRoutineWrite, validateDayTemplate, type DayTemplate } from './dayTemplate';
import { getScheduleDatabase } from './scheduleDatabase';
import { buildDayTemplateInstances, dayTemplateInstanceFromRow, loadStoredDayTemplateInstances,
  type DayTemplateInstance, type DayTemplateInstanceRow } from './dayTemplateInstanceStore';
import { USER_ROUTINE_KINDS, USER_ROUTINE_TITLES, isRoutineDate, mergeRoutineItem, parseUserRoutinePatch,
  patchUsualRoutine, routineTimeAt, routineTimestampText, usualRoutineItems,
  type RoutineItem, type UserRoutinePatch, type UserRoutineRead, type UserRoutineSaveState } from './userRoutinePolicy';
import { parseOwnDayPlanTime } from './ownDayPlanPolicy';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { JunLuoToolCall } from '../tools/toolTypes';
import { userRoutineIdentity } from './userRoutineSaveState';
import { runScheduleSemanticCaptureExclusive } from '../sync/syncScheduleSemanticCaptureQueue';
export type { RoutineItem, UserRoutinePatch, UserRoutineRead } from './userRoutinePolicy';

const zone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
function versionOf(template: DayTemplate, records: DayTemplateInstance[]) {
  return userRoutineIdentity([template, records.filter(item => item.source === 'day').map(item =>
    [item.id, item.startAt ?? null, item.endAt ?? null, item.enabled, item.operationId ?? null]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}
function asItem(item: DayTemplateInstance, timeZone: string): RoutineItem {
  return { enabled: item.enabled, source: item.source,
    ...(item.startAt !== undefined ? { time: routineTimestampText(item.startAt, timeZone) } : {}),
    ...(item.startAt !== undefined && item.endAt !== undefined && item.endAt > item.startAt ? { minutes: (item.endAt - item.startAt) / 60000 } : {}) };
}

async function readStrict(date: string, timeZone: string): Promise<{ value: UserRoutineRead; template: DayTemplate; records: DayTemplateInstance[] }> {
  if (date !== 'usual' && !isRoutineDate(date)) throw new Error('routine-date-invalid');
  const template = await loadDayTemplate();
  const records = date === 'usual' ? [] : await loadStoredDayTemplateInstances(date);
  let items = usualRoutineItems(template);
  if (date !== 'usual') {
    const now = Date.now();
    items = {};
    if (template.enabled) {
      for (const instance of buildDayTemplateInstances(date, template, now, timeZone)) {
        if (instance.startAt! >= now) items[instance.kind] = asItem(instance, timeZone);
      }
    }
    for (const record of records) {
      // Historical saved plans never change when the usual template is edited.
      if (record.source === 'day' || record.status === 'completed' || (record.startAt ?? Infinity) < now) items[record.kind] = asItem(record, timeZone);
    }
  }
  return { template, records, value: { status: Object.keys(items).length ? 'ok' : 'unset', subject: 'you', date,
    enabled: template.enabled, items, version: versionOf(template, records) } };
}

export async function readUserRoutine(date = 'usual', timeZone = zone()): Promise<UserRoutineRead> {
  if (date !== 'usual' && !isRoutineDate(date)) throw new Error('routine-date-invalid');
  try { return (await readStrict(date, timeZone)).value; }
  catch { return { status: 'unavailable', subject: 'you', date, enabled: false, items: {}, version: '' }; }
}

/** Pure selection: a query cannot create past instances or completion facts. */
export async function readEffectiveUserRoutineRange(startAt: number, endAt: number, timeZone = zone()): Promise<DayTemplateInstance[]> {
  if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) throw new Error('routine-range-invalid');
  const template = await loadDayTemplate(), database = await getScheduleDatabase(), now = Date.now();
  const startDate = routineTimestampText(startAt, timeZone).slice(0, 10), endDate = routineTimestampText(endAt, timeZone).slice(0, 10);
  const previous = new Date(`${startDate}T12:00:00Z`); previous.setUTCDate(previous.getUTCDate() - 1);
  const firstDate = previous.toISOString().slice(0, 10);
  const stored = (await database.getAllAsync<DayTemplateInstanceRow>(`SELECT * FROM day_template_instances WHERE
    (date_key >= ? AND date_key <= ?) OR (start_at < ? AND COALESCE(end_at,start_at) >= ?)`, firstDate, endDate, endAt, startAt)).map(dayTemplateInstanceFromRow);
  const selected = new Map<string, DayTemplateInstance>();
  for (let day = new Date(`${firstDate}T12:00:00Z`); day.toISOString().slice(0, 10) <= endDate; day.setUTCDate(day.getUTCDate() + 1)) {
    const key = day.toISOString().slice(0, 10);
    for (const item of buildDayTemplateInstances(key, template, now, timeZone)) {
      // Yesterday's owning date may still have a future overnight sleep; never invent past items.
      if (item.startAt! >= now) selected.set(item.id, item);
    }
  }
  for (const item of stored) {
    if (item.source === 'day' || item.status === 'completed' || (item.startAt ?? Infinity) < now) selected.set(item.id, item);
  }
  return [...selected.values()].filter(item => item.enabled && item.startAt !== undefined && item.startAt < endAt
    && (item.endAt ?? item.startAt) >= startAt && (item.source === 'day' || template.enabled || item.status === 'completed' || item.startAt < now))
    .sort((a, b) => a.startAt! - b.startAt! || a.id.localeCompare(b.id));
}

export type UserRoutineSaveOptions = {
  operationId: string; expectedVersion?: string; isCurrent?: () => boolean | Promise<boolean>;
  dataEpoch?: number; call?: JunLuoToolCall; timeZone?: string; source?: UserRoutineSaveState['source'];
};
export type UserRoutineSaveResult = {
  status: 'saved' | 'not_saved' | 'unknown'; routine: UserRoutineRead; changedKinds: Array<typeof USER_ROUTINE_KINDS[number]>; reason?: string;
};

function changedKinds(patch: UserRoutinePatch) { return USER_ROUTINE_KINDS.filter(kind => patch[kind] !== undefined); }
async function operationWasSaved(state: UserRoutineSaveState) {
  if (state.patch.date === 'usual') return (await loadDayTemplate()).operationId === state.operationId;
  const records = await loadStoredDayTemplateInstances(state.patch.date);
  return changedKinds(state.patch).every(kind => records.find(item => item.kind === kind)?.operationId === state.operationId);
}

async function applyOnce(state: UserRoutineSaveState, valid: () => Promise<boolean>) {
  const { template, records, value } = await readStrict(state.patch.date, state.timeZone);
  if (value.version !== state.expectedVersion || !await valid()) throw new Error('routine-source-changed');
  if (state.patch.date === 'usual') {
    const next = state.fullTemplate ? { ...validateDayTemplate(state.fullTemplate), operationId: state.operationId }
      : state.globalEnabled === undefined ? patchUsualRoutine(template, state.patch, state.operationId)
      : { ...template, enabled: state.globalEnabled, operationId: state.operationId };
    await persistDayTemplate(next, template);
    return;
  }
  const usual = usualRoutineItems(template), now = Date.now();
  const next = changedKinds(state.patch).map(kind => {
    const previous = records.find(item => item.kind === kind);
    let prior: RoutineItem | undefined = previous ? asItem(previous, state.timeZone) : usual[kind];
    if (!previous && prior?.time) prior = { ...prior, time: routineTimestampText(routineTimeAt(state.patch.date, prior.time, state.timeZone,
      kind === 'sleep' && !!template.wakeTime && prior.time <= template.wakeTime), state.timeZone) };
    const merged = mergeRoutineItem(prior, state.patch[kind]!, 'day');
    const startAt = merged.time ? parseOwnDayPlanTime(merged.time, state.timeZone) : undefined;
    const endAt = startAt !== undefined && merged.minutes ? startAt + merged.minutes * 60000 : undefined;
    if (endAt !== undefined && (!Number.isSafeInteger(endAt) || Math.abs(endAt) > 8.64e15)) throw new Error('routine-duration-invalid');
    return { id: `${state.patch.date}:${kind}`, dateKey: state.patch.date, kind, title: USER_ROUTINE_TITLES[kind],
      startAt, endAt,
      enabled: merged.enabled, createdAt: previous?.createdAt ?? now, updatedAt: now };
  });
  const database = await getScheduleDatabase();
  await runScheduleSemanticCaptureExclusive(() => database.withExclusiveTransactionAsync(async transaction => {
    const fresh = (await transaction.getAllAsync<DayTemplateInstanceRow>('SELECT * FROM day_template_instances WHERE date_key = ?', state.patch.date)).map(dayTemplateInstanceFromRow);
    if (versionOf(await loadDayTemplate(), fresh) !== state.expectedVersion || !await valid()) throw new Error('routine-source-changed');
    for (const item of next) await transaction.runAsync(`INSERT INTO day_template_instances
      (id,date_key,kind,title,start_at,end_at,status,template_hash,source,enabled,operation_id,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'pending',?,'day',?,?,?,?)
      ON CONFLICT(date_key,kind) DO UPDATE SET title=excluded.title,start_at=excluded.start_at,end_at=excluded.end_at,
        template_hash=excluded.template_hash,source='day',enabled=excluded.enabled,operation_id=excluded.operation_id,updated_at=excluded.updated_at`,
    item.id, item.dateKey, item.kind, item.title, item.startAt ?? null, item.endAt ?? null, JSON.stringify(template), item.enabled ? 1 : 0,
    state.operationId, item.createdAt, item.updatedAt);
  }));
}

function save(patch: UserRoutinePatch, options: UserRoutineSaveOptions, globalEnabled?: boolean, fullTemplate?: DayTemplate): Promise<UserRoutineSaveResult> {
  return runUserRoutineWrite(async () => {
    const timeZone = options.timeZone ?? zone(), dataEpoch = options.dataEpoch ?? captureBackupRestoreDataEpoch();
    if (dataEpoch === null || !options.operationId) throw new Error('routine-save-context-invalid');
    const { loadToolAuditRecord, recordUserRoutineSave } = await import('../tools/toolAuditStore');
    const prior = await loadToolAuditRecord(options.operationId);
    const call = options.call ?? { callId: options.operationId, toolId: 'schedule.save_routine', requestedBy: 'manual' as const,
      createdAt: prior?.createdAt ?? Date.now(), input: patch };
    let state: UserRoutineSaveState = prior?.routineSave ?? { version: 1, operationId: options.operationId, dataEpoch, attempts: 0,
      stage: 'pending', updatedAt: Date.now(), expectedVersion: options.expectedVersion ?? (await readStrict(patch.date, timeZone)).value.version,
      patch, timeZone, ...(globalEnabled === undefined ? {} : { globalEnabled }), ...(fullTemplate ? { fullTemplate } : {}), ...(options.source ? { source: options.source } : {}) };
    const valid = async () => canCommitBackupRestoreDataEpoch(dataEpoch) && (!options.isCurrent || await options.isCurrent());
    const result = async (status: UserRoutineSaveResult['status'], reason?: string): Promise<UserRoutineSaveResult> => ({ status,
      routine: await readUserRoutine(patch.date, timeZone), changedKinds: changedKinds(patch), ...(reason ? { reason } : {}) });
    if (state.dataEpoch !== dataEpoch || userRoutineIdentity(state.patch) !== userRoutineIdentity(patch) || state.globalEnabled !== globalEnabled
      || userRoutineIdentity(state.fullTemplate) !== userRoutineIdentity(fullTemplate) || userRoutineIdentity(state.source) !== userRoutineIdentity(options.source)) return result('not_saved', 'routine-operation-changed');
    if (!await valid()) return result('not_saved', 'routine-source-changed');
    if (state.stage === 'complete') return result('saved');
    if (state.stage === 'failed') return result('not_saved', 'routine-save-exhausted');
    const journal = async () => {
      state = { ...state, updatedAt: Math.max(Date.now(), state.updatedAt + 1) };
      const saved = await runBackupRestoreDataEpochCommit(dataEpoch, () => recordUserRoutineSave(call, state));
      if (!saved.committed) throw new Error('routine-epoch-changed');
    };
    try {
      if (await operationWasSaved(state)) { state = { ...state, stage: 'complete' }; await journal(); return result('saved'); }
      if (prior?.routineSave && (await readStrict(patch.date, timeZone)).value.version !== state.expectedVersion) {
        return result('unknown', 'routine-readback-superseded');
      }
    } catch { return result('unknown', 'routine-readback-failed'); }
    while (state.attempts < 4) {
      if (!await valid()) return result('not_saved', 'routine-source-changed');
      state = { ...state, attempts: state.attempts + 1, stage: 'pending' };
      // Persist this count first; a failed journal never authorizes a business write.
      try { await journal(); } catch { return result('not_saved', 'routine-journal-failed'); }
      try {
        const outcome = await runBackupRestoreDataEpochCommit(dataEpoch, () => applyOnce(state, valid));
        if (!outcome.committed) return result('not_saved', 'routine-epoch-changed');
        state = { ...state, stage: 'complete' };
        await journal();
        return result('saved');
      } catch (error) {
        try {
          if (await operationWasSaved(state)) {
            state = { ...state, stage: 'complete' };
            await journal().catch(() => undefined);
            return result('saved');
          }
        } catch {
          state = { ...state, stage: 'unknown' }; await journal().catch(() => undefined);
          return result('unknown', 'routine-readback-failed');
        }
        if (error instanceof Error && /invalid|without-time|source-changed|epoch-changed/.test(error.message)) {
          state = { ...state, stage: 'failed' }; await journal().catch(() => undefined);
          return result('not_saved', error.message);
        }
      }
    }
    state = { ...state, stage: 'failed' }; await journal().catch(() => undefined);
    return result('not_saved', 'routine-save-exhausted');
  });
}

export function saveUserRoutinePatch(input: UserRoutinePatch, options: UserRoutineSaveOptions) {
  return save(parseUserRoutinePatch(input, options.timeZone ?? zone()), options);
}
export function setUserRoutineEnabled(enabled: boolean, options: UserRoutineSaveOptions) {
  if (typeof enabled !== 'boolean') throw new Error('routine-enabled-invalid');
  return save({ date: 'usual' }, options, enabled);
}

export function saveUserRoutineTemplate(template: DayTemplate, options: UserRoutineSaveOptions & { expectedTemplate?: DayTemplate }) {
  const normalized = validateDayTemplate(template);
  return save({ date: 'usual' }, { ...options, expectedVersion: options.expectedTemplate
    ? versionOf(validateDayTemplate(options.expectedTemplate), []) : options.expectedVersion }, undefined, normalized);
}

/** Called by the existing local recovery entry; never starts a model request. */
export async function resumeUserRoutineSaves(dataEpoch: number) {
  const { loadRecentToolCalls } = await import('../tools/toolAuditStore');
  for (const record of await loadRecentToolCalls(200)) {
    const state = record.routineSave;
    if (!state || state.dataEpoch !== dataEpoch || !['pending', 'unknown'].includes(state.stage)) continue;
    const isCurrent = async () => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      if (record.source !== 'chat') return record.source === 'manual';
      if (!state.source) return false;
      const { loadChatSessionMessage } = await import('../chat/chatStorage');
      const { fingerprintPromptText } = await import('../ai/promptCacheMetrics');
      const message = await loadChatSessionMessage(state.source.sessionId, state.source.messageId);
      return !!message && fingerprintPromptText(JSON.stringify([message.id, message.role, message.content, message.createdAt])) === state.source.revision;
    };
    const call: JunLuoToolCall = { callId: record.callId, toolId: 'schedule.save_routine', input: state.patch,
      requestedBy: record.source, createdAt: record.createdAt };
    try {
      if (!await isCurrent()) continue;
      await save(state.patch, { operationId: state.operationId, dataEpoch, expectedVersion: state.expectedVersion,
        timeZone: state.timeZone, source: state.source, call, isCurrent }, state.globalEnabled,
      state.fullTemplate ? validateDayTemplate(state.fullTemplate) : undefined);
    } catch { /* Temporary source/storage failure is not permission to replay. */ }
  }
}
