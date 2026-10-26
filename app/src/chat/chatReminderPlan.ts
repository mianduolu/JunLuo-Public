import type { MusicSong } from '../ai/subjectiveMessages';
import type { JunLuoAlarmRecord } from '../schedule/alarmStore';
import type { ChatReminderMode, ChatReminderRepeat, ChatReminderScope } from '../schedule/chatReminderTypes';
import { validateChatReminderRepeat } from '../schedule/chatReminderPolicy';
import { assertChatReminderMetadata } from '../sync/syncScheduleSemantic';

export type ReminderDraft = { title: string; note: string; triggerAt: number; mode: ChatReminderMode;
  repeat: ChatReminderRepeat; songRequest?: { title: string; artist: string }; musicSong?: MusicSong };
export type ReminderPlanSource = { sessionId: string; messageId: string; createdAt: number; contentRevision: string };
export type ReminderPlanRow = { id: string; operationId: string; action: 'create' | 'update' | 'cancel';
  scope: ChatReminderScope; draft?: ReminderDraft; expected?: JunLuoAlarmRecord;
  state: 'pending' | 'saving' | 'saved' | 'conflict' | 'unknown' | 'failed'; result?: JunLuoAlarmRecord; code?: string };
export type ChatReminderPlanCard = { version: 1; revision: number; source: ReminderPlanSource;
  status: 'active' | 'restored'; rows: ReminderPlanRow[]; feedback: { remainingRequests: number; claimed: boolean } };
export type ReminderPlanResult = Pick<ReminderPlanRow, 'id' | 'action' | 'state' | 'result' | 'code'>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export function reminderSourceRevision(source: { content: string; createdAt: number }) { return JSON.stringify([source.createdAt, source.content]); }
export function isReminderPlanSourceCurrent(source: ReminderPlanSource, message?: { id: string; role: string; content: string; createdAt: number } | null) {
  return !!message && message.role === 'you' && message.id === source.messageId
    && reminderSourceRevision(message) === source.contentRevision;
}
export function reminderDraftError(draft: ReminderDraft) {
  if (!draft.title.trim() || !time(draft.triggerAt) || !['notification', 'music'].includes(draft.mode)) return 'REMINDER_INVALID';
  try { validateChatReminderRepeat(draft.repeat); } catch { return 'REMINDER_REPEAT_INVALID'; }
  if (draft.mode === 'music' && (!draft.musicSong || !draft.musicSong.id || !draft.musicSong.name)) return 'MUSIC_UNRESOLVED';
  return undefined;
}
// Shared verbatim with the desktop chat.core guard; this is pure data validation.
export function isReminderPlanCardData(value: unknown): boolean {
  const obj = (item: unknown): item is Record<string, unknown> => !!item && typeof item === 'object' && !Array.isArray(item);
  const keys = (item: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(key => key in item)
    && Object.keys(item).every(key => required.includes(key) || optional.includes(key));
  const string = (item: unknown, limit = 10000) => typeof item === 'string' && item.length <= limit;
  const id = (item: unknown) => string(item, 1000) && !!(item as string).trim()
    && !/^(?:[a-z]:[\\/]|file:|content:|\/|\\\\)/i.test(item as string);
  const at = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0;
  const song = (item: unknown) => obj(item) && keys(item, ['id', 'name'], ['artist', 'album', 'cover', 'duration'])
    && id(item.id) && string(item.name, 1000) && !!(item.name as string).trim()
    && ['artist', 'album', 'cover'].every(key => item[key] === undefined || string(item[key], 5000))
    && (item.cover === undefined || !/^(?:[a-z]:[\\/]|file:|content:|\/|\\\\)/i.test(String(item.cover)))
    && (item.duration === undefined || typeof item.duration === 'number' && Number.isFinite(item.duration) && item.duration >= 0);
  const repeat = (item: unknown) => obj(item) && ['once', 'daily', 'weekly'].includes(String(item.kind))
    && keys(item, item.kind === 'once' ? ['kind'] : item.kind === 'daily' ? ['kind', 'hour', 'minute'] : ['kind', 'hour', 'minute', 'weekdays'])
    && (item.kind === 'once' || Number.isInteger(item.hour) && Number(item.hour) >= 0 && Number(item.hour) <= 23
      && Number.isInteger(item.minute) && Number(item.minute) >= 0 && Number(item.minute) <= 59)
    && (item.kind !== 'weekly' || Array.isArray(item.weekdays) && item.weekdays.length > 0 && new Set(item.weekdays).size === item.weekdays.length
      && item.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6));
  const alarm = (item: unknown) => {
    if (!obj(item) || !keys(item, ['id', 'title', 'message', 'triggerAt', 'status', 'soundMode', 'createdAt', 'updatedAt', 'chatReminder'],
      ['musicKeyword', 'musicSong', 'musicFallbackToNotification', 'musicPlayStatus', 'musicPlayAttemptedAt', 'musicPlayResultSummary', 'musicPlayErrorMessage',
        'strongAlarmNativeId', 'strongAlarmRingtone', 'strongAlarmRingStatus', 'strongAlarmTriggeredAt', 'strongAlarmNotificationShown', 'strongAlarmErrorMessage',
        'strongAlarmExactAlarmAllowed', 'strongAlarmNotificationEnabled', 'strongAlarmBatteryOptimizationIgnored', 'vibrate', 'notificationId', 'cancelledAt'])
      || !id(item.id) || !string(item.title, 1000) || !(item.title as string).trim() || !string(item.message)
      || !['pending', 'delivered', 'cancelled'].includes(String(item.status)) || !['notification', 'music'].includes(String(item.soundMode))
      || !at(item.triggerAt) || !at(item.createdAt) || !at(item.updatedAt) || !obj(item.chatReminder)
      || item.chatReminder.mode !== item.soundMode || item.musicSong !== undefined && !song(item.musicSong)) return false;
    if (['musicKeyword', 'musicPlayResultSummary', 'musicPlayErrorMessage', 'strongAlarmErrorMessage'].some(key => item[key] !== undefined && !string(item[key]))) return false;
    if (['notificationId', 'strongAlarmNativeId'].some(key => item[key] !== undefined && !id(item[key]))) return false;
    if (['musicPlayAttemptedAt', 'strongAlarmTriggeredAt', 'cancelledAt'].some(key => item[key] !== undefined && !at(item[key]))) return false;
    if (['vibrate', 'musicFallbackToNotification', 'strongAlarmNotificationShown', 'strongAlarmExactAlarmAllowed', 'strongAlarmNotificationEnabled', 'strongAlarmBatteryOptimizationIgnored']
      .some(key => item[key] !== undefined && typeof item[key] !== 'boolean')) return false;
    if (item.musicPlayStatus !== undefined && !['pending', 'played', 'failed', 'skipped'].includes(String(item.musicPlayStatus))) return false;
    if (item.strongAlarmRingtone !== undefined && !['default', 'gentle', 'urgent'].includes(String(item.strongAlarmRingtone))) return false;
    if (item.strongAlarmRingStatus !== undefined && !['pending', 'started', 'stopped', 'failed'].includes(String(item.strongAlarmRingStatus))) return false;
    try { assertChatReminderMetadata(item.chatReminder); return true; } catch { return false; }
  };
  if (!obj(value) || !keys(value, ['version', 'revision', 'source', 'status', 'rows', 'feedback']) || value.version !== 1 || !at(value.revision)
    || !obj(value.source) || !keys(value.source, ['sessionId', 'messageId', 'createdAt', 'contentRevision'])
    || !id(value.source.sessionId) || !id(value.source.messageId) || !at(value.source.createdAt) || !string(value.source.contentRevision, 100000)
    || !(value.source.contentRevision as string).length || !['active', 'restored'].includes(String(value.status))
    || !obj(value.feedback) || !keys(value.feedback, ['remainingRequests', 'claimed']) || !at(value.feedback.remainingRequests)
    || Number(value.feedback.remainingRequests) > 1 || typeof value.feedback.claimed !== 'boolean'
    || !Array.isArray(value.rows) || value.rows.length > 50) return false;
  const ids = new Set<string>();
  return value.rows.every(row => {
    if (!obj(row) || !keys(row, ['id', 'operationId', 'action', 'scope', 'state'], ['draft', 'expected', 'result', 'code'])
      || !id(row.id) || ids.has(String(row.id)) || !id(row.operationId)
      || !['create', 'update', 'cancel'].includes(String(row.action)) || !['once', 'future'].includes(String(row.scope))
      || !['pending', 'saving', 'saved', 'conflict', 'unknown', 'failed'].includes(String(row.state))
      || row.code !== undefined && !string(row.code, 1000)) return false;
    ids.add(String(row.id));
    if (row.action !== 'create' && (!alarm(row.expected) || (row.expected as Record<string, unknown>).id !== row.id)) return false;
    if (row.expected !== undefined && !alarm(row.expected)) return false;
    if (row.action !== 'cancel') {
      const draft = row.draft;
      if (!obj(draft) || !keys(draft, ['title', 'note', 'triggerAt', 'mode', 'repeat'], ['songRequest', 'musicSong'])
        || !string(draft.title, 1000) || !string(draft.note) || !at(draft.triggerAt) || !['notification', 'music'].includes(String(draft.mode)) || !repeat(draft.repeat)) return false;
      if (draft.songRequest !== undefined && (!obj(draft.songRequest) || !keys(draft.songRequest, ['title', 'artist'])
        || !string(draft.songRequest.title, 1000) || !string(draft.songRequest.artist, 1000))) return false;
      if (draft.musicSong !== undefined && !song(draft.musicSong)) return false;
    }
    else if ('draft' in row && row.draft !== undefined) return false;
    return (row.result === undefined || alarm(row.result)) && (row.state !== 'saved' || alarm(row.result));
  });
}
export function isChatReminderPlanCard(value: unknown): value is ChatReminderPlanCard { return isReminderPlanCardData(value); }
export function createReminderPlanCard(source: { sessionId: string; messageId: string; content: string; createdAt: number }, rows: ReminderPlanRow[]): ChatReminderPlanCard {
  const card: ChatReminderPlanCard = { version: 1, revision: 0, status: 'active', rows,
    source: { sessionId: source.sessionId, messageId: source.messageId, createdAt: source.createdAt, contentRevision: reminderSourceRevision(source) },
    feedback: { remainingRequests: 1, claimed: false } };
  if (!isChatReminderPlanCard(card)) throw new Error('REMINDER_CARD_INVALID');
  return JSON.parse(JSON.stringify(card));
}
export function editReminderPlan(card: ChatReminderPlanCard, id: string, patch: Partial<ReminderDraft> | null) {
  const row = card.rows.find(item => item.id === id);
  if (card.status !== 'active' || !row || ['saving', 'saved', 'unknown'].includes(row.state)) return null;
  const next = { ...card, revision: card.revision + 1, rows: patch === null ? card.rows.filter(item => item.id !== id)
    : card.rows.map(item => item.id === id ? { ...item, draft: item.draft ? { ...item.draft, ...patch,
      ...(patch.songRequest ? { musicSong: undefined } : {}) } : undefined, state: 'pending' as const, code: undefined } : item) };
  return isChatReminderPlanCard(next) ? next : null;
}
export function restoreReminderPlanCardsInStorage(storage: Record<string, string>) {
  const result = { ...storage };
  let changed = false;
  const restored = (item: ChatReminderPlanCard) => { changed = true; return { ...item, status: 'restored', revision: item.revision + 1,
    feedback: { remainingRequests: 0, claimed: true } }; };
  const visit = (value: unknown): unknown => Array.isArray(value) ? value.map(visit) : object(value)
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'reminderPlanCard' && isChatReminderPlanCard(item) ? restored(item) : visit(item)])) : value;
  for (const key of Object.keys(result)) if (key.startsWith('junluo.chat.')) {
    try { changed = false; const value = visit(JSON.parse(result[key])); if (changed) result[key] = JSON.stringify(value); } catch { /* Existing restore validation reports damaged encodings. */ }
  }
  return result;
}
