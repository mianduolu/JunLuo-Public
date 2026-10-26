import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadStoredAlarmRecords, type JunLuoAlarmRecord } from '../schedule/alarmStore';
import { createReminderPlanCard, type ReminderDraft, type ReminderPlanRow } from '../chat/chatReminderPlan';
import type { JunLuoToolAgentContinuationMessage } from './toolAgentMessages';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import { resolveReminderSong } from '../schedule/chatReminderSong';

type Source = { sessionId: string; messageId: string; content: string; createdAt: number };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_ARGUMENTS');
  return value as Record<string, unknown>;
};
export function reminderLocalDate(at: number) {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export function reminderDateAt(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('INVALID_ARGUMENTS');
  const [y, m, d] = value.split('-').map(Number); const date = new Date(y, m - 1, d);
  if (reminderLocalDate(date.getTime()) !== value) throw new Error('INVALID_ARGUMENTS');
  return date.getTime();
}
function clockAt(value: unknown) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error('INVALID_ARGUMENTS');
  return value.split(':').map(Number);
}
export function reminderDraftFromInput(values: Record<string, unknown>, original?: JunLuoAlarmRecord, sourceCreatedAt?: number): ReminderDraft {
  let relativeAt: number | undefined;
  if (values.afterMinutes !== undefined) {
    const delayMs = typeof values.afterMinutes === 'number' ? values.afterMinutes * 60_000 : NaN;
    const anchor = sourceCreatedAt ?? NaN, nextAt = anchor + delayMs;
    if (original || values.date !== undefined || values.clock !== undefined || (values.repeat ?? 'once') !== 'once'
      || !Number.isSafeInteger(anchor) || anchor < 0 || !Number.isSafeInteger(delayMs) || delayMs <= 0
      || !Number.isSafeInteger(nextAt) || !Number.isFinite(new Date(nextAt).getTime())) throw new Error('INVALID_ARGUMENTS');
    relativeAt = nextAt;
  }
  const at = new Date(relativeAt ?? original?.triggerAt ?? 0);
  const [hour, minute] = values.clock === undefined ? [at.getHours(), at.getMinutes()] : clockAt(values.clock);
  const date = values.date === undefined ? new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime() : reminderDateAt(values.date);
  const triggerAt = new Date(relativeAt ?? date); if (relativeAt === undefined) triggerAt.setHours(hour, minute, 0, 0);
  const meta = original?.chatReminder;
  const repeatKind = values.repeat ?? (meta?.kind === 'series' ? meta.repeat.kind : 'once');
  const oldRepeat = meta?.kind === 'series' ? meta.repeat : undefined;
  const weekdays = values.weekdays ?? (oldRepeat?.kind === 'weekly' ? oldRepeat.weekdays : undefined);
  if (!['once', 'daily', 'weekly'].includes(String(repeatKind))
    || repeatKind === 'weekly' && (!Array.isArray(weekdays) || !weekdays.length || weekdays.some(day => !Number.isInteger(day) || Number(day) < 0 || Number(day) > 6))) throw new Error('INVALID_ARGUMENTS');
  const title = values.title ?? original?.title; const note = values.note ?? meta?.note ?? '';
  const mode = values.mode ?? meta?.mode ?? (original?.soundMode === 'music' ? 'music' : 'notification');
  if (typeof title !== 'string' || !title.trim() || title.length > 1000 || typeof note !== 'string' || note.length > 10000
    || !['notification', 'music'].includes(String(mode))) throw new Error('INVALID_ARGUMENTS');
  const song = values.song === undefined ? undefined : object(values.song);
  if (song && (typeof song.title !== 'string' || !song.title.trim() || typeof song.artist !== 'string' || !song.artist.trim()
    || Object.keys(song).some(key => !['title', 'artist'].includes(key)))) throw new Error('INVALID_ARGUMENTS');
  return { title, note, triggerAt: triggerAt.getTime(), mode: mode as ReminderDraft['mode'],
    repeat: repeatKind === 'once' ? { kind: 'once' } : repeatKind === 'daily' ? { kind: 'daily', hour, minute }
      : { kind: 'weekly', hour, minute, weekdays: [...new Set(weekdays as number[])] },
    ...(song ? { songRequest: { title: String(song.title), artist: String(song.artist) } } : original?.musicSong ? { musicSong: original.musicSong } : {}) };
}

/** Numbers are granted only by the actual transport, never by tool settlement. */
export function createReminderChatHost(input: { source?: Source; dataEpoch: number; signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>; remainingRequests: () => number; allowFinalCreate?: () => boolean }, ports = {
    load: loadStoredAlarmRecords, resolveSong: resolveReminderSong,
  }) {
  const pages = new Map<string, { visible: unknown[]; targets: Map<number, JunLuoAlarmRecord> }>();
  const delivered = new Map<number, JunLuoAlarmRecord>();
  const proposals = new Map<string, ReminderPlanRow[]>();
  let nextItem = 1;
  const current = async () => !!input.source && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch)
    && (!input.isCurrent || await input.isCurrent());
  const finalCreateAllowed = () => input.remainingRequests() === 0 && input.allowFinalCreate?.() === true
    && !input.signal?.aborted && canCommitBackupRestoreDataEpoch(input.dataEpoch);
  const execute = async (call: JunLuoToolCall, providerCallId = call.callId): Promise<JunLuoToolResult> => {
    try {
      if (!await current()) throw new Error('REMINDER_SOURCE_CHANGED');
      if (call.toolId === 'reminder.query') {
        const { startDate, endDate } = call.input;
        if (Object.keys(call.input).some(key => !['startDate', 'endDate'].includes(key))) throw new Error('INVALID_ARGUMENTS');
        const from = startDate === undefined ? -Infinity : reminderDateAt(startDate);
        const end = endDate === undefined ? Infinity : reminderDateAt(endDate);
        if (from > end) throw new Error('INVALID_ARGUMENTS');
        const until = Number.isFinite(end) ? new Date(end) : null; until?.setDate(until.getDate() + 1);
        const all = await ports.load();
        const records = all.filter(row => row.chatReminder?.kind !== 'series' && row.triggerAt >= from
          && row.triggerAt < (until?.getTime() ?? Infinity)
          && (startDate !== undefined || endDate !== undefined || row.status === 'pending' && row.triggerAt >= Date.now()))
          .sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id));
        const firstItem = nextItem;
        const visible = records.slice(0, 50).map((row, index) => ({ item: firstItem + index, date: reminderLocalDate(row.triggerAt),
          clock: `${String(new Date(row.triggerAt).getHours()).padStart(2, '0')}:${String(new Date(row.triggerAt).getMinutes()).padStart(2, '0')}`,
          title: row.title, mode: row.chatReminder?.mode ?? row.soundMode,
          status: row.chatReminder?.kind === 'occurrence' ? row.chatReminder.terminalReason ?? row.status : row.status,
          ...(row.chatReminder?.kind === 'occurrence' ? { message: row.chatReminder.chatDelivery?.state ?? 'pending',
            notification: row.chatReminder.notificationEvidence?.state ?? 'pending',
            ...(row.chatReminder.mode === 'music' ? { music: row.chatReminder.musicEvidence?.state ?? 'pending' } : {}) } : {}),
          note: row.chatReminder?.note ?? '', ...(row.musicSong ? { song: { title: row.musicSong.name, artist: row.musicSong.artist } } : {}) }));
        while (JSON.stringify(visible).length > 9500) visible.pop();
        if (!await current()) throw new Error('REMINDER_SOURCE_CHANGED');
        nextItem += visible.length;
        pages.set(providerCallId, { visible, targets: new Map(records.slice(0, visible.length).map((row, index) => [firstItem + index, row])) });
        return createToolSuccessResult(call, '', { reminders: visible, hasMore: records.length > visible.length });
      }
      if (input.remainingRequests() < 1 && !(call.toolId === 'reminder.propose_reminders' && finalCreateAllowed())) throw new Error('CHAT_MODEL_REQUEST_BUDGET_EXHAUSTED');
      if (proposals.has(providerCallId)) return createToolSuccessResult(call, '', { proposed: proposals.get(providerCallId)!.length });
      if (Object.keys(call.input).some(key => key !== 'reminders') || !Array.isArray(call.input.reminders)
        || !call.input.reminders.length || call.input.reminders.length > 50) throw new Error('INVALID_ARGUMENTS');
      const rows: ReminderPlanRow[] = [];
      for (const value of call.input.reminders) {
        const values = object(value);
        if (Object.keys(values).some(key => !['date', 'clock', 'repeat', 'weekdays', 'mode', 'title', 'note', 'song', 'item', 'scope', ...(call.toolId === 'reminder.propose_reminders' ? ['afterMinutes'] : [])].includes(key))) throw new Error('INVALID_ARGUMENTS');
        const create = call.toolId === 'reminder.propose_reminders';
        const cancel = call.toolId === 'reminder.propose_cancellations';
        if (!create && !cancel && call.toolId !== 'reminder.propose_updates') throw new Error('INVALID_ARGUMENTS');
        let expected: JunLuoAlarmRecord | undefined;
        if (!create) {
          if (!Number.isInteger(values.item) || !['once', 'future'].includes(String(values.scope))) throw new Error('INVALID_ARGUMENTS');
          expected = delivered.get(Number(values.item));
          if (!expected?.chatReminder || expected.chatReminder.kind !== 'occurrence') throw new Error('REMINDER_TARGET_UNSUPPORTED');
          const latest = (await ports.load()).find(row => row.id === expected!.id);
          if (!latest || JSON.stringify(latest) !== JSON.stringify(expected)) throw new Error('REMINDER_TARGET_CHANGED');
        } else if (values.item !== undefined || values.scope !== undefined
          || values.afterMinutes === undefined && (values.date === undefined || values.clock === undefined)) throw new Error('INVALID_ARGUMENTS');
        if (cancel && Object.keys(values).some(key => !['item', 'scope'].includes(key)) || !create && !cancel && Object.keys(values).length <= 2) throw new Error('INVALID_ARGUMENTS');
        const id = expected?.id ?? `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
        let draft: ReminderDraft | undefined;
        if (!cancel) {
          // Repeat belongs to the series, not to the displayed occurrence.
          const original = expected?.chatReminder?.kind === 'occurrence'
            ? (await ports.load()).find(row => row.id === (expected!.chatReminder as { seriesId: string }).seriesId) : undefined;
          draft = reminderDraftFromInput(values, expected ? { ...expected, chatReminder: original?.chatReminder ?? expected.chatReminder } : undefined,
            create ? input.source!.createdAt : undefined);
          if (draft.mode === 'music' && draft.songRequest) {
            try { draft.musicSong = await ports.resolveSong(draft.songRequest, `${providerCallId}:${rows.length}`, current); }
            catch { /* An unresolved music row stays editable and is not disguised as a message reminder. */ }
          }
        }
        rows.push({ id, operationId: `${providerCallId}:${rows.length}`, action: create ? 'create' : cancel ? 'cancel' : 'update',
          scope: create ? 'future' : values.scope as 'once' | 'future', draft, expected, state: 'pending' });
      }
      const ids = new Set([...proposals.values()].flatMap(rows => rows.map(row => row.id)));
      for (const row of rows) { if (ids.has(row.id)) throw new Error('INVALID_ARGUMENTS'); ids.add(row.id); }
      if (!await current()) throw new Error('REMINDER_SOURCE_CHANGED');
      proposals.set(providerCallId, rows);
      return createToolSuccessResult(call, '', { proposed: rows.length });
    } catch (error) {
      return createToolErrorResult(call, createToolError('EXECUTION_FAILED', error instanceof Error ? error.message : 'EXECUTION_FAILED'), '没有执行工具');
    }
  };
  return { execute,
    observeDelivered(messages: readonly JunLuoToolAgentContinuationMessage[]) {
      delivered.clear();
      for (const message of messages) if (message.kind === 'tool_result') {
        const page = pages.get(message.callId); if (!page) continue;
        try {
          const receipt = JSON.parse(message.content);
          const data = message.toolId === 'system.use_package' ? receipt.reminderQueryResult?.data : receipt.data;
          if (receipt.dataOmitted || receipt.reminderQueryResult?.dataOmitted || JSON.stringify(data?.reminders) !== JSON.stringify(page.visible)) continue;
          page.targets.forEach((row, item) => delivered.set(item, row));
        } catch { /* Omitted results grant no target. */ }
      }
    },
    card(results: readonly JunLuoToolResult[]) {
      const rows = results.filter(result => result.ok).flatMap(result => proposals.get(result.callId) ?? []);
      return rows.length && input.source && (input.remainingRequests() >= 1
        || finalCreateAllowed() && rows.every(row => row.action === 'create')) ? createReminderPlanCard(input.source, rows) : undefined;
    },
  };
}
