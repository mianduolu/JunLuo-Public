import type { SubjectiveMessage } from '../ai/subjectiveMessages';

export const HEART_CORPUS_INDEX_KEY = 'junluo.chat.heartCorpusIndex.v1';
export const LIKED_HEART_ROUND_IDS_KEY = 'junluo.chat.likedStyleReferenceIds';

export type HeartCorpusEntryV1 = {
  replyRoundId: string;
  sessionId: string | null;
  youMessageIds: string[];
  iMessageIds: string[];
  firstHeartedAt: number | null;
  lastHeartedAt: number | null;
};

export type HeartCorpusIndexV1 = {
  schemaVersion: 1;
  entries: HeartCorpusEntryV1[];
  updatedAt: number;
};

export type HeartReplyRound = {
  exportable: boolean;
  firstId: string;
  iMessages: SubjectiveMessage[];
  replyRoundId: string;
  youMessages: SubjectiveMessage[];
};

export type ResolvedHeartCorpusRound = HeartReplyRound & {
  entry: HeartCorpusEntryV1;
  sessionId: string;
};

function isFiniteTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableTimestamp(value: unknown): value is number | null {
  return value === null || isFiniteTimestamp(value);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.length > 0);
}

function parseEntry(value: unknown): HeartCorpusEntryV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as Partial<HeartCorpusEntryV1>;
  if (
    typeof entry.replyRoundId !== 'string'
    || !entry.replyRoundId
    || (entry.sessionId !== null && typeof entry.sessionId !== 'string')
    || !isStringList(entry.youMessageIds)
    || !isStringList(entry.iMessageIds)
    || !entry.iMessageIds.length
    || entry.iMessageIds[0] !== entry.replyRoundId
    || !isNullableTimestamp(entry.firstHeartedAt)
    || !isNullableTimestamp(entry.lastHeartedAt)
  ) return null;
  return {
    replyRoundId: entry.replyRoundId,
    sessionId: entry.sessionId ?? null,
    youMessageIds: [...entry.youMessageIds],
    iMessageIds: [...entry.iMessageIds],
    firstHeartedAt: entry.firstHeartedAt,
    lastHeartedAt: entry.lastHeartedAt,
  };
}

export function createEmptyHeartCorpusIndex(updatedAt = 0): HeartCorpusIndexV1 {
  return { schemaVersion: 1, entries: [], updatedAt };
}

export function parseHeartCorpusIndex(raw: string | null): HeartCorpusIndexV1 {
  if (!raw) return createEmptyHeartCorpusIndex();
  try {
    const value = JSON.parse(raw) as Partial<HeartCorpusIndexV1>;
    if (!value || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      return createEmptyHeartCorpusIndex();
    }
    const byId = new Map<string, HeartCorpusEntryV1>();
    for (const item of value.entries) {
      const entry = parseEntry(item);
      if (entry) byId.set(entry.replyRoundId, entry);
    }
    return {
      schemaVersion: 1,
      entries: [...byId.values()],
      updatedAt: isFiniteTimestamp(value.updatedAt) ? value.updatedAt : 0,
    };
  } catch {
    return createEmptyHeartCorpusIndex();
  }
}

export function parseLikedHeartRoundIds(raw: string | null) {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter(
      (item): item is string => typeof item === 'string' && item.length > 0,
    ))];
  } catch {
    return [];
  }
}

function isOrdinaryPrivateMessage(message: SubjectiveMessage) {
  return message.source === undefined || message.source === 'chat';
}

function isPureTextMessage(message: SubjectiveMessage) {
  return !!message.content.trim()
    && !message.images?.length
    && !message.sticker
    && !message.voice
    && !message.replyTo
    && !message.voiceCallRecord
    && !message.musicCard
    && !message.musicCards?.length
    && !message.schedulePlanCard
    && !message.goalTimeCreditCard
    && !message.scheduleChangeCard
    && !message.toolCallCards?.length;
}

export function findHeartReplyRound(
  messages: readonly SubjectiveMessage[],
  anchorId: string,
): HeartReplyRound | null {
  const anchorIndex = messages.findIndex((message) => message.id === anchorId);
  const anchor = messages[anchorIndex];
  if (anchor?.role === 'I' && anchor.source === 'proactive-message' && anchor.deliveryStatus !== 'failed') {
    // Proactive bubbles arrive separately; later deliveries must not change an existing favorite.
    return {
      exportable: isPureTextMessage(anchor),
      firstId: anchor.id,
      iMessages: [anchor],
      replyRoundId: anchor.id,
      youMessages: [],
    };
  }
  if (anchorIndex < 0 || !anchor || anchor.role !== 'I' || !isOrdinaryPrivateMessage(anchor)) {
    return null;
  }

  let iStart = anchorIndex;
  while (
    iStart > 0
    && messages[iStart - 1]?.role === 'I'
    && isOrdinaryPrivateMessage(messages[iStart - 1]!)
  ) iStart -= 1;

  const iMessages: SubjectiveMessage[] = [];
  for (let index = iStart; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role !== 'I' || !isOrdinaryPrivateMessage(message)) break;
    iMessages.push(message);
  }
  if (!iMessages.length) return null;

  let youStart = iStart;
  while (
    youStart > 0
    && messages[youStart - 1]?.role === 'you'
    && isOrdinaryPrivateMessage(messages[youStart - 1]!)
  ) youStart -= 1;
  const youMessages = messages.slice(youStart, iStart);
  if (!youMessages.length) return null;

  return {
    exportable: [...youMessages, ...iMessages].every(isPureTextMessage),
    firstId: iMessages[0]!.id,
    iMessages,
    replyRoundId: iMessages[0]!.id,
    youMessages,
  };
}

export function createHeartCorpusEntry(input: {
  legacy: boolean;
  now: number;
  round: HeartReplyRound;
  sessionId: string | null;
}): HeartCorpusEntryV1 {
  return {
    replyRoundId: input.round.replyRoundId,
    sessionId: input.sessionId,
    youMessageIds: input.round.youMessages.map((message) => message.id),
    iMessageIds: input.round.iMessages.map((message) => message.id),
    firstHeartedAt: input.legacy ? null : input.now,
    lastHeartedAt: input.legacy ? null : input.now,
  };
}

export function buildHeartCorpusMarkdown(rounds: readonly ResolvedHeartCorpusRound[]) {
  const lines = ['# 爱心语料', ''];
  rounds.forEach((round, index) => {
    lines.push(`## 第 ${index + 1} 轮`, '');
    if (round.youMessages.length) {
      lines.push('### 我说', '');
      round.youMessages.forEach((message) => lines.push(message.content.trim(), ''));
    }
    lines.push('### 你说', '');
    round.iMessages.forEach((message) => lines.push(message.content.trim(), ''));
  });
  return lines.join('\n').trimEnd() + '\n';
}

export function buildHeartCorpusJsonl(rounds: readonly ResolvedHeartCorpusRound[]) {
  return rounds.map((round) => JSON.stringify({
    schemaVersion: 1,
    messages: [
      ...round.youMessages.map((message) => ({ role: 'you' as const, content: message.content.trim() })),
      ...round.iMessages.map((message) => ({ role: 'I' as const, content: message.content.trim() })),
    ],
  })).join('\n') + (rounds.length ? '\n' : '');
}

export function sortHeartCorpusForDisplay(
  rounds: readonly ResolvedHeartCorpusRound[],
) {
  return [...rounds].sort((left, right) => {
    const leftAt = left.entry.lastHeartedAt ?? left.iMessages[0]?.createdAt ?? 0;
    const rightAt = right.entry.lastHeartedAt ?? right.iMessages[0]?.createdAt ?? 0;
    return rightAt - leftAt || left.replyRoundId.localeCompare(right.replyRoundId);
  });
}

export function sortHeartCorpusForExport(
  rounds: readonly ResolvedHeartCorpusRound[],
) {
  return [...rounds].sort((left, right) => (
    (left.youMessages[0]?.createdAt ?? left.iMessages[0]?.createdAt ?? 0)
      - (right.youMessages[0]?.createdAt ?? right.iMessages[0]?.createdAt ?? 0)
    || left.replyRoundId.localeCompare(right.replyRoundId)
  ));
}
