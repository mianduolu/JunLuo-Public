import { getLocalDateKey, loadAssistantLifeDays, type AssistantTimelineEntry } from '../ai/assistantLifeTimeline';
import { loadAssistantState } from '../ai/assistantState';
import { isReplyOnlyHistoryLabels } from '../ai/replyTransportFormatting';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { getDisplayedChatMessageContent, isLetterChatProjection } from '../chat/chatMessageDisplay';
import { loadChatSessionMessageOrder, loadChatSessionMessagePage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { BAIYUN_EMOTION_IDS } from '../life/junluoInnerState';
import { emotionDetail } from '../life/junluoInnerStatePresentation';
import { loadJunluoAffectState } from '../life/junluoInnerStateStore';
import { formatContactWaitingDuration } from '../proactive/contactWaiting';
import { getLetterMemoryParts, type LetterMemoryPart } from './letterMemorySource';
import { loadLetters, type LetterEntry } from './letterStore';

const DAY_MS = 24 * 60 * 60 * 1000;
const validTime = (at: number | undefined, now: number): at is number => (
  typeof at === 'number' && Number.isFinite(at) && at > 0 && at <= now
);
const timeText = (at: number) => new Date(at).toLocaleString('zh-CN');

function ordinaryChatMessages(messages: readonly SubjectiveMessage[], now: number) {
  return messages.filter(message => (message.role === 'I' || message.role === 'you')
    && (message.source === undefined || message.source === 'chat')
    && message.deliveryStatus !== 'failed' && !message.theaterBackstage && !message.theaterBackstagePending
    && !isLetterChatProjection(message) && validTime(message.createdAt, now))
    .map(message => ({ ...message, content: getDisplayedChatMessageContent(message) }))
    .filter(message => !!message.content.trim()
      && !(message.role === 'I' && isReplyOnlyHistoryLabels(message.content)));
}

/** Count consecutive bubbles together while preserving their saved order and full bodies. */
export function selectLetterChatMessages(messages: readonly SubjectiveMessage[], now: number) {
  const rounds: SubjectiveMessage[][] = [];
  for (const message of ordinaryChatMessages(messages, now)) {
    const previous = rounds.at(-1);
    if (!previous || message.role === 'you' && previous.some(line => line.role === 'I')) rounds.push([message]);
    else previous.push(message);
  }
  const complete = rounds.filter(round => round.some(line => line.role === 'you') && round.some(line => line.role === 'I'));
  const tail = rounds.at(-1);
  return [...complete.slice(-6).flat(), ...(tail?.every(line => line.role === 'you') ? tail : [])];
}

async function loadLetterChatMessages(now: number) {
  let beforeIndex = (await loadChatSessionMessageOrder(PRIMARY_CHAT_SESSION_ID, { strict: true })).length;
  let messages: SubjectiveMessage[] = [];
  while (beforeIndex > 0) {
    const page = await loadChatSessionMessagePage(PRIMARY_CHAT_SESSION_ID, { beforeIndex, limit: 60 });
    if (!page.messages.length || page.startIndex >= beforeIndex) throw new Error('letter-writing-chat-unavailable');
    messages = [...page.messages, ...messages];
    const ordinary = ordinaryChatMessages(messages, now);
    const selected = selectLetterChatMessages(messages, now);
    const completeRounds = selected.filter((message, index) => message.role === 'I' && selected[index - 1]?.role === 'you').length;
    // An earlier usable bubble proves that the first selected you group is not cut by a page boundary.
    if (completeRounds === 6 && ordinary.findIndex(message => message.id === selected[0].id) > 0) return selected;
    beforeIndex = page.startIndex;
  }
  return selectLetterChatMessages(messages, now);
}

function eligibleLetterParts(letter: LetterEntry, now: number): LetterMemoryPart[] {
  if (!validTime(letter.createdAt, now)) return [];
  const parts = getLetterMemoryParts(letter).filter(part => validTime(part.createdAt, now) && validTime(part.availableAt, now));
  if (letter.kind === 'future-self') {
    return letter.status === 'completed' && validTime(letter.dueAt, now) && validTime(letter.openedAt, now)
      ? parts.filter(part => part.part === 'original') : [];
  }
  if (letter.direction === 'ai-to-you' && (letter.status === 'waiting_user' || letter.status === 'completed')
    && validTime(letter.deliveredAt, now)) {
    if (!parts.some(part => part.part === 'original')) return [];
    return parts.filter(part => part.part === 'original'
      || letter.status === 'completed' && validTime(letter.completedAt, now));
  }
  if (letter.direction === 'you-to-ai' && letter.status === 'completed' && validTime(letter.deliveredAt, now)
    && parts.some(part => part.part === 'original') && parts.some(part => part.part === 'reply')) return parts;
  return [];
}

export function selectRecentLetterWritingRecord(letters: readonly LetterEntry[], now: number, currentLetterId?: string) {
  return letters.filter(letter => letter.id !== currentLetterId)
    .map(letter => ({ letter, parts: eligibleLetterParts(letter, now) }))
    .filter(record => record.parts.length > 0)
    .sort((left, right) => Math.max(...right.parts.map(part => part.availableAt))
      - Math.max(...left.parts.map(part => part.availableAt)) || left.letter.id.localeCompare(right.letter.id))[0];
}

function letterContactTimes(letters: readonly LetterEntry[], now: number) {
  let you: number | undefined;
  let I: number | undefined;
  for (const letter of letters) {
    if (letter.kind === 'exchange' && letter.direction === 'you-to-ai'
      && ['waiting_ai', 'failed', 'completed'].includes(letter.status)
      && letter.content.trim() && validTime(letter.createdAt, now)) you = Math.max(you ?? 0, letter.createdAt);
    for (const part of eligibleLetterParts(letter, now)) {
      if (part.role === 'you' && part.part === 'reply') you = Math.max(you ?? 0, part.availableAt);
      if (part.role === 'I') I = Math.max(I ?? 0, part.availableAt);
    }
  }
  return { you, I };
}

function formatRecentLetter(record: ReturnType<typeof selectRecentLetterWritingRecord>) {
  if (!record) return undefined;
  return {
    标题: record.letter.title,
    来往: record.parts.map(part => ({
      subject: part.role,
      类型: part.label,
      ...(part.part === 'original' ? {
        写下时间: timeText(part.createdAt),
        ...(part.label === '未来信' ? { 拆开时间: timeText(part.availableAt) }
          : part.role === 'I' ? { 送达时间: timeText(part.availableAt) } : {}),
      } : { 保存时间: timeText(part.createdAt) }),
      正文: part.content,
    })),
  };
}

function selectLifeEntries(entries: readonly AssistantTimelineEntry[], now: number) {
  const byId = new Map<string, AssistantTimelineEntry>();
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id.trim() || !validTime(entry.at, now) || entry.at < now - 7 * DAY_MS
      || typeof entry.title !== 'string' || typeof entry.activity !== 'string' || !entry.activity.trim()) continue;
    const previous = byId.get(entry.id);
    if (!previous || entry.at > previous.at) byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((left, right) => left.at - right.at || left.id.localeCompare(right.id)).slice(-3);
}

export async function loadLetterWritingMaterials(now: number, currentLetterId?: string): Promise<string> {
  if (!validTime(now, now)) throw new Error('letter-writing-time-invalid');
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('letter-writing-data-epoch-changed');
  const dateKeys = Array.from({ length: 8 }, (_, offset) => {
    const date = new Date(now);
    date.setDate(date.getDate() - offset);
    return getLocalDateKey(date);
  });
  const [chat, letters, days, state, affect] = await Promise.all([
    loadLetterChatMessages(now), loadLetters(), loadAssistantLifeDays(dateKeys), loadAssistantState(), loadJunluoAffectState(true),
  ]);
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('letter-writing-data-epoch-changed');
  const contact = letterContactTimes(letters, now);
  const chatAt = chat.filter(message => message.role === 'you').reduce<number | undefined>(
    (latest, message) => Math.max(latest ?? 0, message.createdAt), undefined);
  const intervals = {
    距you上次聊天: formatContactWaitingDuration(now, chatAt) || undefined,
    距you上次寄信或回信: formatContactWaitingDuration(now, contact.you) || undefined,
    距I上次信件送达或拆开: formatContactWaitingDuration(now, contact.I) || undefined,
  };
  const life = selectLifeEntries(days.flatMap(day => day?.timelineEntries ?? []), now);
  // The public reader normalizes absent legacy text timestamps to 0; 0 cannot certify when the words were saved.
  const stateAt = state.textUpdatedAt === undefined ? state.updatedAt : state.textUpdatedAt;
  const currentState = state.sourceType !== 'default' && validTime(stateAt, now) && !!state.activity.trim() ? {
    subject: 'I', 记录时间: timeText(stateAt), 标题: state.title, 正文: state.activity,
  } : undefined;
  const primary = affect.emotions.primary;
  const currentEmotion = primary && validTime(primary.occurredAt, now)
    && BAIYUN_EMOTION_IDS.includes(primary.emotionId) && ['I', 'you', 'other', 'situation'].includes(primary.target)
    && Number.isFinite(primary.intensity) && primary.intensity >= 0 && primary.intensity <= 1
    && typeof primary.operationId === 'string' && !!primary.operationId.trim()
    && typeof primary.sourceId === 'string' && !!primary.sourceId.trim() ? {
      subject: 'I', 记录时间: timeText(primary.occurredAt), 感受: emotionDetail(primary, true),
    } : undefined;
  return JSON.stringify({
    现在: timeText(now),
    联系间隔: Object.values(intervals).some(Boolean) ? intervals : undefined,
    最近聊天: chat.length ? chat.map(message => ({ subject: message.role, 时间: timeText(message.createdAt), 正文: message.content })) : undefined,
    最近信件: formatRecentLetter(selectRecentLetterWritingRecord(letters, now, currentLetterId)),
    I最近记下的生活: life.length ? life.map(entry => ({ subject: 'I', 记录时间: timeText(entry.at), 标题: entry.title, 正文: entry.activity })) : undefined,
    I目前保存的状态: currentState,
    I目前保存的感受: currentEmotion,
  });
}
