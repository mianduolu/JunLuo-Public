import type { MusicSong } from '../ai/subjectiveMessages';
import { assertChatReminderMetadata } from '../sync/syncScheduleSemantic';
import { loadAlarmRecords, loadStoredAlarmRecords, mutateAlarmRecords, type JunLuoAlarmRecord } from './alarmStore';
import { chatReminderAttemptId, chatReminderOccurrenceId, nextChatReminderAt, validateChatReminderRepeat } from './chatReminderPolicy';
import type { ChatReminderMode, ChatReminderOccurrence, ChatReminderRepeat, ChatReminderScope, ChatReminderSeries } from './chatReminderTypes';

export type ChatReminderSeriesRecord = JunLuoAlarmRecord & { chatReminder: ChatReminderSeries };
export type ChatReminderOccurrenceRecord = JunLuoAlarmRecord & { chatReminder: ChatReminderOccurrence };
export type ChatReminderRecord = ChatReminderSeriesRecord | ChatReminderOccurrenceRecord;
export type ChatReminderSaveResult = { series: ChatReminderSeriesRecord; occurrence: ChatReminderOccurrenceRecord | null };
export type ChatReminderDefinitionInput = {
  title: string;
  triggerAt: number;
  mode: ChatReminderMode;
  repeat: ChatReminderRepeat;
  musicSong?: MusicSong;
  note?: string;
};
export type CreateChatReminderInput = ChatReminderDefinitionInput & { id?: string; operationId: string; sourceMessageId?: string };
export type UpdateChatReminderInput = {
  targetId: string;
  scope: ChatReminderScope;
  expectedRevision: number;
  operationId: string;
  patch: Partial<ChatReminderDefinitionInput>;
};
export type CancelChatReminderInput = Omit<UpdateChatReminderInput, 'patch'>;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const isSeries = (record: JunLuoAlarmRecord): record is ChatReminderSeriesRecord => record.chatReminder?.kind === 'series';
const isOccurrence = (record: JunLuoAlarmRecord): record is ChatReminderOccurrenceRecord => record.chatReminder?.kind === 'occurrence';

function assertDefinition(input: ChatReminderDefinitionInput) {
  if (!input.title.trim() || input.title.length > 1000 || !Number.isSafeInteger(input.triggerAt) || input.triggerAt < 0) {
    throw new Error('chat-reminder-invalid-definition');
  }
  validateChatReminderRepeat(input.repeat);
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 10_000)) throw new Error('chat-reminder-invalid-note');
  if (input.mode !== 'notification' && input.mode !== 'music') throw new Error('chat-reminder-invalid-mode');
  if (input.mode === 'music' && (!input.musicSong?.id.trim() || !input.musicSong.name.trim())) {
    throw new Error('chat-reminder-saved-song-required');
  }
}

function assertVersion(record: ChatReminderRecord, revision: number, operationId: string) {
  if (record.chatReminder.lastOperationId === operationId) return false;
  if (record.chatReminder.revision !== revision) throw new Error('chat-reminder-stale-version');
  return true;
}

function findTarget(records: JunLuoAlarmRecord[], id: string): ChatReminderRecord {
  const record = records.find(item => item.id === id);
  if (!record || (!isSeries(record) && !isOccurrence(record))) throw new Error('chat-reminder-not-found');
  return record;
}

function seriesFor(records: JunLuoAlarmRecord[], target: ChatReminderRecord) {
  const series = isSeries(target) ? target : findTarget(records, target.chatReminder.seriesId);
  if (!isSeries(series)) throw new Error('chat-reminder-series-not-found');
  return series;
}

function currentOccurrence(records: JunLuoAlarmRecord[], series: ChatReminderSeriesRecord) {
  return records.find((record): record is ChatReminderOccurrenceRecord => isOccurrence(record)
    && record.id === series.chatReminder.nextOccurrenceId) ?? null;
}

function makeOccurrence(series: ChatReminderSeriesRecord, triggerAt: number, now: number): ChatReminderOccurrenceRecord {
  const id = chatReminderOccurrenceId(series.id, triggerAt, series.chatReminder.revision);
  if (id.length > 250) throw new Error('chat-reminder-id-too-long');
  return {
    id, title: series.title, message: '', triggerAt, status: 'pending', soundMode: series.chatReminder.mode,
    ...(series.musicSong ? { musicSong: clone(series.musicSong) } : {}), createdAt: now, updatedAt: now,
    chatReminder: {
      version: 1, kind: 'occurrence', revision: 1, mode: series.chatReminder.mode,
      lastOperationId: series.chatReminder.lastOperationId, seriesId: series.id,
      seriesRevision: series.chatReminder.revision, scheduledAt: triggerAt, snoozeCount: 0,
      attemptId: chatReminderAttemptId(id),
      ...(series.chatReminder.note !== undefined ? { note: series.chatReminder.note } : {}),
    },
  };
}

function result(records: JunLuoAlarmRecord[], series: ChatReminderSeriesRecord): ChatReminderSaveResult {
  return clone({ series, occurrence: currentOccurrence(records, series) });
}

async function commit<T>(work: (records: JunLuoAlarmRecord[]) => T) {
  return mutateAlarmRecords(records => {
    const next = clone(records);
    const value = work(next);
    for (const record of next) assertChatReminderMetadata(record.chatReminder);
    return { records: next, value: clone(value) };
  });
}

export async function loadAllChatReminders(): Promise<ChatReminderRecord[]> {
  return (await loadStoredAlarmRecords()).filter((record): record is ChatReminderRecord => isSeries(record) || isOccurrence(record));
}

export async function getChatReminderOccurrence(id: string): Promise<ChatReminderOccurrenceRecord | null> {
  const record = (await loadAllChatReminders()).find(item => item.id === id);
  return record && isOccurrence(record) ? record : null;
}

export async function loadChatReminderOccurrences(options: { dueAt?: number; includeTerminal?: boolean } = {}) {
  return (await loadAllChatReminders()).filter((record): record is ChatReminderOccurrenceRecord => isOccurrence(record)
    && (options.includeTerminal || record.status === 'pending')
    && (options.dueAt === undefined || record.triggerAt <= options.dueAt));
}

export async function queryChatReminders(options: { title?: string; includeCancelled?: boolean } = {}) {
  const records = await loadAllChatReminders();
  return records.filter(isSeries).filter(record => (options.includeCancelled || record.status !== 'cancelled')
    && (!options.title || record.title.includes(options.title))).map(series => result(records, series));
}

/** Legacy alarms remain read-only results; series rows are not due reminders. */
export async function queryReminderRecords(options: { title?: string; includeTerminal?: boolean } = {}) {
  return (await loadAlarmRecords({ includePast: true })).filter(record => record.chatReminder?.kind !== 'series'
    && (options.includeTerminal || record.status === 'pending')
    && (!options.title || record.title.includes(options.title)));
}

export function createChatReminder(input: CreateChatReminderInput, now = Date.now()) {
  assertDefinition(input);
  return commit(records => {
    const id = input.id ?? `chat-reminder-${input.operationId}`;
    if (!id || id.length > 180 || !input.operationId) throw new Error('chat-reminder-invalid-id');
    const existing = records.find(record => record.id === id);
    if (existing) {
      if (!isSeries(existing) || existing.chatReminder.lastOperationId !== input.operationId) throw new Error('chat-reminder-id-conflict');
      return result(records, existing);
    }
    const series: ChatReminderSeriesRecord = {
      id, title: input.title.trim(), message: '', triggerAt: input.triggerAt,
      status: 'pending', soundMode: input.mode, createdAt: now, updatedAt: now,
      ...(input.mode === 'music' ? { musicSong: clone(input.musicSong) } : {}),
      chatReminder: { version: 1, kind: 'series', revision: 1, mode: input.mode,
        repeat: clone(input.repeat), lastOperationId: input.operationId,
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}) },
    };
    const occurrence = makeOccurrence(series, input.triggerAt, now);
    series.chatReminder.nextOccurrenceId = occurrence.id;
    records.push(series, occurrence);
    return result(records, series);
  });
}

export function updateChatReminder(input: UpdateChatReminderInput, now = Date.now()) {
  return commit(records => {
    const target = findTarget(records, input.targetId);
    const series = seriesFor(records, target);
    if (!assertVersion(target, input.expectedRevision, input.operationId)) return result(records, series);
    if (series.status === 'cancelled' || target.status !== 'pending') throw new Error('chat-reminder-not-editable');
    const base = input.scope === 'future' ? series : target;
    const definition: ChatReminderDefinitionInput = { title: base.title, triggerAt: base.triggerAt,
      mode: base.chatReminder.mode, repeat: series.chatReminder.repeat, musicSong: base.musicSong,
      note: base.chatReminder.note, ...input.patch };
    assertDefinition(definition);
    if (input.scope === 'future') {
      const current = currentOccurrence(records, series);
      if (current?.status === 'pending') { current.status = 'cancelled'; current.cancelledAt = now; current.updatedAt = now; current.chatReminder.revision += 1; }
      series.title = definition.title.trim(); series.triggerAt = definition.triggerAt; series.soundMode = definition.mode;
      series.musicSong = definition.mode === 'music' ? clone(definition.musicSong) : undefined;
      series.updatedAt = now;
      series.chatReminder = { ...series.chatReminder, repeat: clone(definition.repeat), mode: definition.mode,
        revision: series.chatReminder.revision + 1, lastOperationId: input.operationId, note: definition.note };
      const next = makeOccurrence(series, definition.triggerAt, now);
      series.chatReminder.nextOccurrenceId = next.id;
      records.push(next);
      if (isOccurrence(target)) target.chatReminder.lastOperationId = input.operationId;
    } else {
      if (!isOccurrence(target) || target.chatReminder.chatDelivery) throw new Error('chat-reminder-once-requires-pending-occurrence');
      if (input.patch.repeat) throw new Error('chat-reminder-repeat-requires-future-scope');
      target.title = definition.title.trim(); target.triggerAt = definition.triggerAt; target.soundMode = definition.mode;
      target.musicSong = definition.mode === 'music' ? clone(definition.musicSong) : undefined;
      target.message = ''; target.notificationId = undefined; target.updatedAt = now;
      target.chatReminder = { version: 1, kind: 'occurrence', mode: definition.mode,
        revision: target.chatReminder.revision + 1, lastOperationId: input.operationId,
        seriesId: target.chatReminder.seriesId, seriesRevision: target.chatReminder.seriesRevision,
        scheduledAt: target.chatReminder.scheduledAt, snoozeCount: target.chatReminder.snoozeCount,
        attemptId: `${target.id}:edit:${target.chatReminder.revision + 1}` };
      if (definition.note !== undefined) target.chatReminder.note = definition.note;
    }
    return result(records, series);
  });
}

export function cancelChatReminder(input: CancelChatReminderInput, now = Date.now()) {
  return commit(records => {
    const target = findTarget(records, input.targetId);
    const series = seriesFor(records, target);
    if (!assertVersion(target, input.expectedRevision, input.operationId)) return result(records, series);
    const cancelled = input.scope === 'future'
      ? records.filter(record => record.id === series.id || (isOccurrence(record) && record.chatReminder.seriesId === series.id && record.status === 'pending'))
      : [target];
    if (input.scope === 'once' && !isOccurrence(target)) throw new Error('chat-reminder-once-requires-occurrence');
    if (input.scope === 'once' && target.status !== 'pending') throw new Error('chat-reminder-not-editable');
    for (const record of cancelled) {
      if (!record.chatReminder || record.status !== 'pending') continue;
      record.status = 'cancelled'; record.cancelledAt = now; record.updatedAt = now;
      record.chatReminder.revision += 1; record.chatReminder.lastOperationId = input.operationId;
    }
    target.chatReminder.lastOperationId = input.operationId;
    return result(records, series);
  });
}

/** No model, notification or playback work may run in this short serialized callback. */
export function updateChatReminderOccurrence(input: {
  occurrenceId: string;
  expectedRevision?: number;
  predicate?: (record: ChatReminderOccurrenceRecord) => boolean;
  update: (record: ChatReminderOccurrenceRecord) => ChatReminderOccurrenceRecord;
}, now = Date.now()): Promise<ChatReminderOccurrenceRecord | null> {
  return commit(records => {
    const index = records.findIndex(record => record.id === input.occurrenceId && isOccurrence(record));
    if (index < 0) return null;
    const current = records[index] as ChatReminderOccurrenceRecord;
    if (input.expectedRevision !== undefined && current.chatReminder.revision !== input.expectedRevision) return null;
    if (input.predicate && !input.predicate(clone(current))) return null;
    const next = input.update(clone(current));
    if (!isOccurrence(next) || next.id !== current.id || next.chatReminder.seriesId !== current.chatReminder.seriesId) {
      throw new Error('chat-reminder-occurrence-identity-changed');
    }
    if (JSON.stringify(next) === JSON.stringify(current)) return current;
    next.chatReminder.revision = current.chatReminder.revision + 1;
    next.updatedAt = now;
    records[index] = next;
    return next;
  });
}

export function snoozeChatReminder(input: { occurrenceId: string; expectedRevision: number; operationId: string; triggerAt: number }, now = Date.now()) {
  return commit(records => {
    const target = findTarget(records, input.occurrenceId);
    if (!isOccurrence(target)) throw new Error('chat-reminder-once-requires-occurrence');
    if (!assertVersion(target, input.expectedRevision, input.operationId)) return target;
    const series = seriesFor(records, target);
    if (series.status === 'cancelled' || target.status === 'cancelled' || !Number.isSafeInteger(input.triggerAt) || input.triggerAt <= now) {
      throw new Error('chat-reminder-cannot-snooze');
    }
    target.triggerAt = input.triggerAt; target.status = 'pending'; target.updatedAt = now;
    const meta = target.chatReminder;
    target.chatReminder = { ...meta, version: 1, kind: 'occurrence', mode: meta.mode,
      revision: meta.revision + 1, lastOperationId: input.operationId, seriesId: meta.seriesId,
      seriesRevision: meta.seriesRevision, scheduledAt: meta.scheduledAt, snoozeCount: meta.snoozeCount + 1,
      attemptId: chatReminderAttemptId(target.id, meta.snoozeCount + 1) };
    delete target.chatReminder.musicEvidence;
    delete target.chatReminder.terminalReason;
    if (meta.note !== undefined) target.chatReminder.note = meta.note;
    return target;
  });
}

export function advanceChatReminder(seriesId: string, now = Date.now()) {
  return commit(records => {
    const series = findTarget(records, seriesId);
    if (!isSeries(series)) throw new Error('chat-reminder-series-not-found');
    const current = currentOccurrence(records, series);
    if (series.status !== 'pending' || !current || current.status === 'pending') return result(records, series);
    const triggerAt = nextChatReminderAt(series.chatReminder.repeat, Math.max(now, current.chatReminder.scheduledAt));
    series.updatedAt = now; series.chatReminder.revision += 1;
    if (triggerAt === null) {
      series.status = 'delivered'; delete series.chatReminder.nextOccurrenceId;
      return result(records, series);
    }
    const next = makeOccurrence(series, triggerAt, now);
    series.triggerAt = triggerAt; series.chatReminder.nextOccurrenceId = next.id;
    records.push(next);
    return result(records, series);
  });
}
