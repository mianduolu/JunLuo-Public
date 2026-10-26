import { isPokeInteraction, type PokeInteraction } from './chatPokeExperience';
import { getTheaterBackstageContext, type TheaterBackstageMessageSource } from '../ai/subjectiveMessages';

export const CHAT_AFTERGLOW_SCAN_PAGE_SIZE = 60;
export const CHAT_AFTERGLOW_MAX_ROUNDS = 6;

export type ChatAfterglowPosition = {
  id: string;
  createdAt: number;
};

export type ChatAfterglowBookmark = {
  activatedAt: number;
  cursors: Record<string, ChatAfterglowPosition>;
  lateMessages?: Record<string, ChatAfterglowPosition[]>;
};

export type ChatAfterglowMessage = ChatAfterglowPosition & {
  content: string;
  role: 'I' | 'you';
  pokeInteraction?: PokeInteraction;
  deliveryStatus?: 'failed';
  theaterBackstage?: TheaterBackstageMessageSource;
};

type ChatAfterglowMessagePage<TMessage extends ChatAfterglowMessage> = {
  messages: TMessage[];
  startIndex: number;
  totalCount: number;
};

export type ChatAfterglowCandidate<TMessage extends ChatAfterglowMessage = ChatAfterglowMessage> = {
  conversation: (Pick<ChatAfterglowMessage, 'role' | 'content'> & { time: string })[];
  iMessage: TMessage;
  messages: TMessage[];
  rounds: TMessage[][];
  sessionId: string;
  youMessage?: TMessage;
};

type ChatAfterglowSessionIndex<TMessage extends ChatAfterglowMessage> = {
  id: string;
  messageCount?: number;
  messages: TMessage[];
  updatedAt: number;
};

type ResolveChatAfterglowCandidateInput<TMessage extends ChatAfterglowMessage> = {
  bookmark: ChatAfterglowBookmark;
  excludeSessionIds?: ReadonlySet<string>;
  minimumRounds?: number;
  /** Shared-experience catch-up stops at the saved boundary, not at newer live replies. */
  beforeAt?: number;
  batch?: { sessionId?: string; refs: readonly ChatAfterglowPosition[] };
  isUsableMessage?: (message: TMessage) => boolean;
  loadOrder: (sessionId: string) => Promise<ChatAfterglowPosition[]>;
  loadPage: (
    sessionId: string,
    options: { beforeIndex: number; limit: number },
  ) => Promise<ChatAfterglowMessagePage<TMessage>>;
  sessions: readonly ChatAfterglowSessionIndex<TMessage>[];
};

export function compareChatAfterglowPositions(left: ChatAfterglowPosition, right: ChatAfterglowPosition) {
  return left.createdAt - right.createdAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export function formatChatAfterglowMessageTime(createdAt: number) {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

/** Keep actions as system facts, never turn a poke into a synthetic you utterance. */
export function formatChatAfterglowConversation(
  messages: readonly ChatAfterglowMessage[],
  pokeFacts: readonly PokeInteraction[] = [],
) {
  const facts = new Map(pokeFacts.filter(isPokeInteraction).map(poke => [poke.id, poke]));
  const delivered = messages.filter(message => message.deliveryStatus !== 'failed');
  for (const message of delivered) {
    if (message.role === 'I' && isPokeInteraction(message.pokeInteraction))
      facts.set(message.pokeInteraction.id, message.pokeInteraction);
  }
  const conversation = (items: readonly ChatAfterglowMessage[]) => {
    const groups: string[] = [];
    let group: ChatAfterglowMessage[] = [];
    const flush = () => {
      if (!group.length) return;
      const context = getTheaterBackstageContext(group[0]);
      groups.push(`${context ? `${context}\n` : ''}${JSON.stringify(group.map(message => ({
        role: message.role, time: formatChatAfterglowMessageTime(message.createdAt), content: message.content,
      })))}`);
      group = [];
    };
    for (const message of items) {
      const previous = group.at(-1);
      if (previous && (getTheaterBackstageContext(message, previous)
        || (!!getTheaterBackstageContext(previous) !== !!getTheaterBackstageContext(message)))) flush();
      group.push(message);
    }
    flush();
    return groups.length ? groups.join('\n\n') : '[]';
  };
  if (!facts.size) return conversation(delivered);
  const entries: ({ id: string; createdAt: number } & (
    { message: ChatAfterglowMessage; poke?: never } | { poke: PokeInteraction; message?: never }
  ))[] = [
    ...delivered.map(message => ({ id: message.id, createdAt: message.createdAt, message })),
    ...[...facts.values()].map(poke => ({ id: poke.id, createdAt: poke.pokedAt, poke })),
  ];
  entries.sort((left, right) => left.createdAt - right.createdAt
    || Number(!!right.poke) - Number(!!left.poke) || compareChatAfterglowPositions(left, right));
  const parts: string[] = [];
  let group: ChatAfterglowMessage[] = [];
  const flush = () => { if (group.length) parts.push(conversation(group)); group = []; };
  for (const entry of entries) {
    if (entry.message) group.push(entry.message);
    else {
      flush();
      parts.push(`【you 戳了 I】\n\n发生时间：${formatChatAfterglowMessageTime(entry.poke.pokedAt)}\nyou 戳了 I。`
        + (entry.poke.wokeAt !== undefined ? '\n这次戳戳把 I 叫醒了。' : ''));
    }
  }
  flush();
  return parts.join('\n\n');
}

function makeCandidate<TMessage extends ChatAfterglowMessage>(sessionId: string, rounds: TMessage[][]) {
  const messages = rounds.flat();
  return {
    conversation: messages.map(({ role, content, createdAt }) => ({
      role, content, time: formatChatAfterglowMessageTime(createdAt),
    })),
    iMessage: messages.at(-1)!,
    messages,
    rounds,
    sessionId,
    youMessage: messages.findLast((message) => message.role === 'you'),
  };
}

export function trimChatAfterglowCandidate<TMessage extends ChatAfterglowMessage>(
  candidate: ChatAfterglowCandidate<TMessage>,
  roundCount: number,
): ChatAfterglowCandidate<TMessage> | null {
  const rounds = candidate.rounds.slice(0, Math.max(0, Math.floor(roundCount)));
  return rounds.length ? makeCandidate(candidate.sessionId, rounds) : null;
}

export async function resolveChatAfterglowCandidate<TMessage extends ChatAfterglowMessage>({
  bookmark,
  excludeSessionIds,
  minimumRounds = 1,
  beforeAt,
  batch,
  isUsableMessage,
  loadOrder,
  loadPage,
  sessions,
}: ResolveChatAfterglowCandidateInput<TMessage>): Promise<ChatAfterglowCandidate<TMessage> | null> {
  const unreadSessions: { sessionId: string; entries: { position: ChatAfterglowPosition; index: number }[] }[] = [];
  for (const session of sessions) {
    if (excludeSessionIds?.has(session.id)) continue;
    if (batch && session.id !== batch.sessionId) continue;
    const batchIds = batch && new Set(batch.refs.map(ref => ref.id));
    const cursor = bookmark.cursors[session.id];
    const lateIds = new Set(bookmark.lateMessages?.[session.id]?.map(({ id }) => id));
    const entries = (await loadOrder(session.id)).map((position, index) => ({ position, index }))
      .filter(({ position }) => position.createdAt > bookmark.activatedAt
        && (beforeAt === undefined || position.createdAt < beforeAt)
        && (!batchIds || batchIds.has(position.id))
        && (lateIds.has(position.id) || !cursor || compareChatAfterglowPositions(position, cursor) > 0));
    if (entries.length) unreadSessions.push({ sessionId: session.id, entries });
  }
  unreadSessions.sort((left, right) => (
    left.entries[0].position.createdAt - right.entries[0].position.createdAt
      || (left.sessionId < right.sessionId ? -1 : left.sessionId > right.sessionId ? 1 : 0)
  ));

  for (const { sessionId, entries } of unreadSessions) {
    const rounds: TMessage[][] = [];
    let round: TMessage[] = [];
    let hasYou = false;
    let hasReply = false;
    let pokeId: string | undefined;
    for (let offset = 0; offset < entries.length;) {
      const startIndex = entries[offset].index;
      let endOffset = offset + 1;
      // Page only unread contiguous indices; late arrivals must not reload already-read text between them.
      while (endOffset < entries.length
        && endOffset - offset < CHAT_AFTERGLOW_SCAN_PAGE_SIZE
        && entries[endOffset].index === entries[endOffset - 1].index + 1) endOffset += 1;
      const page = await loadPage(sessionId, {
        beforeIndex: entries[endOffset - 1].index + 1,
        limit: endOffset - offset,
      });
      // A concurrent deletion or reorder invalidates this page's positions; retry on the next ordinary opportunity.
      if (page.startIndex !== startIndex || page.messages.length !== endOffset - offset
        || page.messages.some((message, index) => (
          compareChatAfterglowPositions(message, entries[offset + index].position) !== 0
        ))) return null;
      for (const message of page.messages) {
        if ('voiceCallRecord' in message && message.voiceCallRecord) continue;
        if (isUsableMessage && !isUsableMessage(message)) continue;
        if (message.role === 'I' && message.deliveryStatus === 'failed') continue;
        const nextPokeId = message.role === 'I' && isPokeInteraction(message.pokeInteraction)
          ? message.pokeInteraction.id : undefined;
        if (hasReply && (message.role === 'you' || (nextPokeId && nextPokeId !== pokeId))) {
          rounds.push(round);
          if (rounds.length === CHAT_AFTERGLOW_MAX_ROUNDS) return makeCandidate(sessionId, rounds);
          round = [];
          hasYou = false;
          hasReply = false;
          pokeId = undefined;
        }
        if (nextPokeId && message.pokeInteraction?.replyToMessageIds) {
          const repliedIds = new Set(message.pokeInteraction.replyToMessageIds);
          round = round.filter(item => item.role !== 'you' || repliedIds.has(item.id));
          hasYou = round.some(item => item.role === 'you');
        }
        round.push(message);
        if (message.role === 'you') hasYou = true;
        else if (hasYou || nextPokeId) hasReply = true;
        if (nextPokeId) pokeId = nextPokeId;
      }
      offset = endOffset;
    }
    if (hasReply) rounds.push(round);
    if (rounds.length >= minimumRounds) return makeCandidate(sessionId, rounds);
  }
  return null;
}
