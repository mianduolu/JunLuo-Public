import { chatRelationshipStorageBridge as AsyncStorage } from '../sync/syncChatRelationshipStorageBridge';
import { isPokeInteraction, type PokeInteraction, type PendingPokeExperience } from './chatPokeExperience';

const SLEEP_INTERACTION_KEY = 'junluo.chat.sleepInteraction.v1';
const POKE_ROUND_COOLDOWN_MS = 10 * 60 * 1000;
const CLAIM_LEASE_MS = 2 * 60 * 1000;
const STORAGE_WAIT_MS = 2500;

type PendingSleepReply = {
  claimedAt?: number;
  claimToken?: string;
  messageIds: string[];
  sessionId: string;
  updatedAt: number;
};

type SleepInteractionState = {
  pokeExperiences?: PendingPokeExperience[];
  pending?: PendingSleepReply;
  pokeCount: number;
  pokeReplyLastAt: number;
  pokeRoundStartedAt: number;
  updatedAt: number;
};

export type SleepReplyClaim = {
  messageIds: string[];
  sessionId: string;
  token: string;
};

const emptyState: SleepInteractionState = {
  pokeCount: 0,
  pokeReplyLastAt: 0,
  pokeRoundStartedAt: 0,
  updatedAt: 0,
};

let stateQueue = Promise.resolve();
let pendingWrite: Promise<void> | undefined;

async function waitForStorage<T>(work: Promise<T>, operation: 'read' | 'write'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`sleep_interaction_${operation}_timeout`)), STORAGE_WAIT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeState(value: unknown): SleepInteractionState {
  if (!value || typeof value !== 'object') return emptyState;
  const candidate = value as Partial<SleepInteractionState>;
  const pending = candidate.pending && typeof candidate.pending === 'object'
    ? candidate.pending as Partial<PendingSleepReply>
    : undefined;
  return {
    ...(Array.isArray(candidate.pokeExperiences) ? { pokeExperiences: candidate.pokeExperiences.filter(
      fact => isPokeInteraction(fact) && (fact.targetSessionId === null || typeof fact.targetSessionId === 'string')
        && (fact.replyMessageIds === undefined || (Array.isArray(fact.replyMessageIds)
          && fact.replyMessageIds.every(id => typeof id === 'string' && !!id))),
    ) } : {}),
    pending:
      pending &&
      typeof pending.sessionId === 'string' &&
      Array.isArray(pending.messageIds)
        ? {
          claimedAt: typeof pending.claimedAt === 'number' ? pending.claimedAt : undefined,
          claimToken: typeof pending.claimToken === 'string' ? pending.claimToken : undefined,
          messageIds: pending.messageIds.filter((id): id is string => typeof id === 'string'),
          sessionId: pending.sessionId,
          updatedAt: typeof pending.updatedAt === 'number' ? pending.updatedAt : 0,
        }
        : undefined,
    pokeCount: typeof candidate.pokeCount === 'number' ? Math.max(0, candidate.pokeCount) : 0,
    pokeReplyLastAt: typeof candidate.pokeReplyLastAt === 'number' ? candidate.pokeReplyLastAt : 0,
    pokeRoundStartedAt: typeof candidate.pokeRoundStartedAt === 'number' ? candidate.pokeRoundStartedAt : 0,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  };
}

async function loadState(requirePokeCounter = false) {
  // Reads can be abandoned; an already issued write must settle before later state can be merged.
  if (pendingWrite) await waitForStorage(pendingWrite, 'write');
  const raw = await waitForStorage(AsyncStorage.getItem(SLEEP_INTERACTION_KEY), 'read');
  if (raw === null) return emptyState;
  try {
    const parsed = JSON.parse(raw) as Partial<SleepInteractionState> | null;
    if (requirePokeCounter && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) {
      throw new Error('Invalid saved sleep interaction record');
    }
    const state = normalizeState(parsed);
    if (requirePokeCounter && (!Number.isInteger(parsed!.pokeCount)
      || !['pokeCount', 'pokeReplyLastAt', 'pokeRoundStartedAt'].every((key) => {
        const value = parsed![key as keyof SleepInteractionState];
        return typeof value === 'number' && Number.isFinite(value) && value >= 0;
      }))) {
      return { ...state, pokeCount: 0, pokeReplyLastAt: 0, pokeRoundStartedAt: 0 };
    }
    return state;
  } catch (error) {
    if (requirePokeCounter) throw error;
    return emptyState;
  }
}

async function mutateState<T>(
  mutate: (state: SleepInteractionState) => { state: SleepInteractionState; value: T },
  requirePokeCounter = false,
  canCommit: () => boolean = () => true,
) {
  let result!: T;
  stateQueue = stateQueue.catch(() => undefined).then(async () => {
    if (!canCommit()) throw new Error('sleep_interaction_stale');
    const current = await loadState(requirePokeCounter);
    if (!canCommit()) throw new Error('sleep_interaction_stale');
    const next = mutate(current);
    result = next.value;
    const writing = AsyncStorage.setItem(SLEEP_INTERACTION_KEY, JSON.stringify(next.state));
    pendingWrite = writing;
    const clearPendingWrite = () => { if (pendingWrite === writing) pendingWrite = undefined; };
    void writing.then(clearPendingWrite, clearPendingWrite);
    await waitForStorage(writing, 'write');
  });
  await stateQueue;
  return result;
}

export function recordSleepingMessage(sessionId: string, messageId: string, now = Date.now(), canCommit?: () => boolean) {
  return mutateState((state) => {
    const sameSession = state.pending?.sessionId === sessionId;
    const messageIds = sameSession ? state.pending!.messageIds : [];
    return {
      state: {
        ...state,
        pending: {
          ...(sameSession ? state.pending : {}),
          messageIds: messageIds.includes(messageId) ? messageIds : [...messageIds, messageId],
          sessionId,
          updatedAt: now,
        },
        updatedAt: now,
      },
      value: undefined,
    };
  }, false, canCommit);
}

export function claimSleepingReply(now = Date.now()): Promise<SleepReplyClaim | null> {
  return mutateState((state) => {
    const pending = state.pending;
    if (!pending?.messageIds.length) return { state, value: null };
    if (pending.claimToken && pending.claimedAt && now - pending.claimedAt < CLAIM_LEASE_MS) {
      return { state, value: null };
    }
    const token = `sleep-reply-${now}-${Math.random().toString(36).slice(2, 9)}`;
    return {
      state: {
        ...state,
        pending: { ...pending, claimedAt: now, claimToken: token },
        updatedAt: now,
      },
      value: { messageIds: pending.messageIds, sessionId: pending.sessionId, token },
    };
  });
}

export async function hasPendingSleepingReply() {
  await stateQueue.catch(() => undefined);
  return Boolean((await loadState()).pending?.messageIds.length);
}

export function confirmSleepingReply(claim: SleepReplyClaim, now = Date.now()) {
  return mutateState((state) => ({
    state: state.pending?.claimToken === claim.token
      ? withoutAnsweredSleepingMessages(state, claim.sessionId, claim.messageIds, now)
      : state,
    value: undefined,
  }));
}

function withoutAnsweredSleepingMessages(state: SleepInteractionState, sessionId: string, messageIds: readonly string[], now: number) {
  if (state.pending?.sessionId !== sessionId) return state;
  const answered = new Set(messageIds);
  const remaining = state.pending.messageIds.filter(id => !answered.has(id));
  if (remaining.length === state.pending.messageIds.length) return state;
  return { ...state, updatedAt: now, pending: remaining.length
    ? { ...state.pending, messageIds: remaining, claimedAt: undefined, claimToken: undefined }
    : undefined };
}

/** Only call after the reply covering these original you IDs is durably saved. */
export function completeSleepingMessages(sessionId: string, messageIds: readonly string[], now = Date.now()) {
  return mutateState(state => ({
    state: withoutAnsweredSleepingMessages(state, sessionId, messageIds, now), value: undefined,
  }));
}

export function releaseSleepingReply(claim: SleepReplyClaim, now = Date.now()) {
  return mutateState((state) => ({
    state: state.pending?.claimToken === claim.token
      ? {
        ...state,
        pending: { ...state.pending, claimedAt: undefined, claimToken: undefined },
        updatedAt: now,
      }
      : state,
    value: undefined,
  }));
}

export function recordPoke(now = Date.now(), experience?: PokeInteraction, canCommit?: () => boolean) {
  return mutateState((state) => {
    if (experience && state.pokeExperiences?.some(item => item.id === experience.id)) {
      return { state, value: { pokeCount: state.pokeCount, shouldRequestReply: true } };
    }
    const roundReferenceAt = Math.max(state.pokeRoundStartedAt, state.pokeReplyLastAt);
    const continuesRound =
      roundReferenceAt > 0 && now - roundReferenceAt < POKE_ROUND_COOLDOWN_MS;
    const pokeCount = continuesRound ? state.pokeCount + 1 : 1;
    return {
      state: {
        ...state,
        pokeCount,
        ...(experience && pokeCount <= 2 ? { pokeExperiences: [...(state.pokeExperiences ?? []),
          { ...experience, targetSessionId: experience.sourceSessionId }] } : {}),
        pokeRoundStartedAt: continuesRound ? state.pokeRoundStartedAt : now,
        updatedAt: now,
      },
      value: { pokeCount, shouldRequestReply: pokeCount <= 2 },
    };
  }, true, canCommit);
}

export async function loadPendingPokeExperiences(): Promise<PendingPokeExperience[]> {
  return (await loadState(true)).pokeExperiences ?? [];
}

export function updatePokeExperience(id: string, patch: Pick<Partial<PendingPokeExperience>,
  'wokeAt' | 'sleepMessageIds' | 'replyToMessageIds' | 'targetSessionId' | 'replyMessageIds'>, canCommit?: () => boolean) {
  return mutateState(state => ({ state: { ...state,
    updatedAt: Date.now(),
    pokeExperiences: state.pokeExperiences?.map(fact => fact.id === id ? { ...fact, ...patch } : fact),
  }, value: undefined }), true, canCommit);
}

export function removePokeExperiences(ids: readonly string[], canCommit?: () => boolean) {
  return mutateState(state => ({ state: { ...state,
    updatedAt: Date.now(),
    pokeExperiences: state.pokeExperiences?.filter(fact => !ids.includes(fact.id)),
  }, value: undefined }), true, canCommit);
}

export function recordPokeReplySent(now = Date.now()) {
  return mutateState((state) => ({
    state: {
      ...state,
      pokeReplyLastAt: now,
      updatedAt: now,
    },
    value: undefined,
  }));
}
