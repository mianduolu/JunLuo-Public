import { assistantLifeStateStorageBridge as storage } from '../sync/syncAssistantLifeStateStorageBridge';
import { assertAssistantLifeStateRecord, upgradeLegacyConversationAfterglowState } from '../sync/syncAssistantLifeState';
import {
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import type { JunluoWantChange } from '../life/junluoInnerState';
import type { AssistantAffectBasket } from '../ai/assistantAffectPaper';
import type { ContactWaiting } from '../proactive/contactWaiting';
import type { SharedExperienceCandidate, SharedExperienceProgress } from '../ai/assistantSharedExperienceMaterial';
import { loadJunluoDesireState } from '../life/junluoInnerStateStore';
import { compareChatAfterglowPositions, type ChatAfterglowBookmark, type ChatAfterglowPosition } from './chatAfterglowProbe';

export const CONVERSATION_AFTERGLOW_STATE_KEY = 'junluo.assistant.conversationAfterglowState';
export const INNER_STATE_MIN_INTERVAL_MS = 15 * 60 * 1000;
export const INTERNAL_PAPER_RETRY_INTERVAL_MS = 5 * 60 * 1000;
export const INTERNAL_PAPER_MAX_ATTEMPTS = 3;

export type ChatSupplement = {
  sessionId: string;
  unreadRefs: Array<ChatAfterglowPosition & { revision: string }>;
  backgroundRefs: Array<ChatAfterglowPosition & { revision: string }>;
};

// A failed batch keeps references and its spent requests, never another copy of the text.
export type InternalPaperRetry = {
  contactWaiting?: ContactWaiting;
  chatSupplement?: ChatSupplement;
  generationKey: string;
  attemptedAt: number;
  attempts: 1 | 2 | 3;
  retryAfter: number;
  sessionId?: string;
  refs: Array<ChatAfterglowPosition & { revision: string }>;
  end?: ChatAfterglowPosition;
  materials: InnerMaterialRef[];
};
type SkippedInternalPaperBatch = { generationKey: string; at: number };

export type SharedExperiencePaper<T> = {
  attempts: number;
  retryAt?: number;
  result?: T | null;
};
export type SharedExperienceBatch = Omit<SharedExperienceCandidate, 'material' | 'document'> & {
  outingRefs?: InnerMaterialRef[];
  chatSupplement?: ChatSupplement;
  segments?: import('../ai/assistantCrossPageExperience').ExperienceSegments;
  generationKey: string;
  preparedAt: number;
  wants: SharedExperiencePaper<JunluoWantChange[]>;
  affect: SharedExperiencePaper<AssistantAffectBasket>;
};
export type SharedExperienceState = SharedExperienceProgress & {
  updatedAt: number;
  lastReadingAttemptAt?: number;
  lastCrossPageAttemptAt?: number;
  batch?: SharedExperienceBatch;
  lastFinished?: { generationKey: string; at: number; outcome: 'saved' | 'skipped' };
};

export type InnerMaterialRef = {
  kind: 'care' | 'heart' | 'dream' | 'life' | 'poke';
  id: string;
  createdAt: number;
  revision: string;
};
export type InnerMaterialProgress = {
  pokes?: Record<string, string>;
  activatedAt: number;
  dream?: ChatAfterglowPosition;
  care: Record<string, string>;
  hearts: string[];
  life: Record<string, string>;
};

export type InnerUpdatePending = {
  chatSupplement?: ChatSupplement;
  generationKey: string;
  source: 'life' | 'afterglow';
  materialKey: string;
  attemptedAt: number;
  sessionId?: string;
  refs: Array<ChatAfterglowPosition & { revision: string }>;
  end?: ChatAfterglowPosition;
  wants: JunluoWantChange[] | null;
  materials: InnerMaterialRef[];
  applied: boolean;
};

export type InnerUpdateState = ChatAfterglowBookmark & {
  schemaVersion: 3;
  paper: 'wants';
  materials: InnerMaterialProgress;
  updatedAt: number;
  lastAttemptAt?: number;
  generatedAt?: number;
  lastLifeMaterialKey?: string;
  pending?: InnerUpdatePending;
  retry?: InternalPaperRetry;
  lastSkipped?: SkippedInternalPaperBatch;
  affect?: AffectUpdateState;
  experience?: SharedExperienceState;
};

export type AffectUpdatePending = {
  contactWaiting?: ContactWaiting;
  pokeRefs?: Array<ChatAfterglowPosition & { revision: string }>;
  generationKey: string;
  attemptedAt: number;
  sessionId?: string;
  refs: Array<ChatAfterglowPosition & { revision: string }>;
  end?: ChatAfterglowPosition;
  lifeRefs: Array<ChatAfterglowPosition & { revision: string }>;
  affect: AssistantAffectBasket | null;
  applied: boolean;
};
export type AffectUpdateState = ChatAfterglowBookmark & {
  pokes?: Record<string, string>;
  paper: 'affect';
  updatedAt: number;
  lastAttemptAt?: number;
  retryAfter?: number;
  generatedAt?: number;
  life: Record<string, string>;
  pending?: AffectUpdatePending;
  retry?: InternalPaperRetry;
  lastSkipped?: SkippedInternalPaperBatch;
};

export function innerMaterialKey(value: unknown) {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

export async function loadInnerUpdateState(): Promise<InnerUpdateState | null> {
  const raw = await storage.getItem(CONVERSATION_AFTERGLOW_STATE_KEY);
  if (!raw) return null;
  const value = JSON.parse(raw) as InnerUpdateState;
  if (value?.schemaVersion !== 3) return null;
  assertAssistantLifeStateRecord('conversation-afterglow', 'conversation-afterglow', value);
  return value;
}

// Data conversion only: never execute or translate the retired compound answer.
async function upgradeStoredBookmark(now: number): Promise<InnerUpdateState | null> {
  const raw = await storage.getItem(CONVERSATION_AFTERGLOW_STATE_KEY);
  if (!raw) return null;
  const old = JSON.parse(raw);
  if (old?.schemaVersion === 3) return null;
  // Storage/upgrade failures of the numeric state must not erase a trusted old bookmark.
  const desires = await loadJunluoDesireState();
  try {
    return upgradeLegacyConversationAfterglowState(old, now, desires.recentProcessedOperations) as InnerUpdateState;
  } catch { return null; }
}

let stateWrites: Promise<unknown> = Promise.resolve();

export function updateInnerUpdateState(
  dataEpoch: number | null,
  update: (state: InnerUpdateState | null) => InnerUpdateState | null,
): Promise<InnerUpdateState | null> {
  const work = stateWrites.catch(() => undefined).then(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const previous = await loadInnerUpdateState();
      const next = update(previous);
      if (!next || next === previous || !canCommitBackupRestoreDataEpoch(dataEpoch)) return previous;
      const saved = { ...next, updatedAt: Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1) };
      for (let attempt = 0; ; attempt++) {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return previous;
        try {
          await storage.setItem(CONVERSATION_AFTERGLOW_STATE_KEY, JSON.stringify(saved));
          break;
        } catch (error) { if (attempt === 3) throw error; }
      }
      return saved;
    });
    return result.committed ? result.value : null;
  });
  stateWrites = work;
  return work;
}

export async function initializeInnerUpdateBookmark(now: number, dataEpoch: number | null) {
  if (await loadInnerUpdateState()) return loadInnerUpdateState();
  const upgraded = await upgradeStoredBookmark(now);
  return updateInnerUpdateState(dataEpoch, state => state ?? upgraded ?? {
    schemaVersion: 3, paper: 'wants', activatedAt: now, updatedAt: now, cursors: {}, lateMessages: {},
    materials: { activatedAt: now, care: {}, hearts: [], life: {} },
  });
}

export async function initializeAffectBookmark(now: number, dataEpoch: number | null) {
  await initializeInnerUpdateBookmark(now, dataEpoch);
  const next = await updateInnerUpdateState(dataEpoch, state => !state || state.affect ? state : {
    ...state, affect: { paper: 'affect', activatedAt: now, updatedAt: now, cursors: {}, lateMessages: {}, life: {} },
  });
  return next?.affect ?? null;
}

export async function initializeSharedExperienceBookmark(now: number, dataEpoch: number | null) {
  await initializeAffectBookmark(now, dataEpoch);
  const previous = await loadInnerUpdateState();
  if (previous?.experience?.crossPageActivatedAt !== undefined) return previous;
  const { loadLetters } = await import('../letters/letterStore');
  const chatOwned = Object.fromEntries((await loadLetters()).filter(letter => letter.kind === 'exchange'
    && letter.chatMessageIds?.length).map(letter => [`letter-exchange:${letter.id}`, 'chat-owned']));
  return updateInnerUpdateState(dataEpoch, state => !state || state.experience?.crossPageActivatedAt !== undefined ? state : {
    ...state, experience: { ...(state.experience ?? { activatedAt: now, processed: {}, focus: {} }),
      updatedAt: now, crossPageActivatedAt: now, processed: { ...state.experience?.processed, ...chatOwned } },
  });
}

export async function loadAffectUpdateState() {
  return (await loadInnerUpdateState())?.affect ?? null;
}

export async function updateAffectUpdateState(dataEpoch: number | null, update: (state: AffectUpdateState) => AffectUpdateState) {
  const result = await updateInnerUpdateState(dataEpoch, state => {
    if (!state?.affect) return state;
    const affect = update(state.affect);
    return affect === state.affect ? state : { ...state, affect: { ...affect, updatedAt: Math.max(Date.now(), state.affect.updatedAt + 1) } };
  });
  return result?.affect ?? null;
}

// Called only for IDs not already present in chat storage, before their first write.
// Keep references, not a second copy of the messages. Old imports precede activatedAt.
export function registerLateInnerUpdateMessages(
  sessionId: string,
  messages: readonly ChatAfterglowPosition[],
  dataEpoch: number | null,
) {
  if (!messages.length) return Promise.resolve(null);
  return updateInnerUpdateState(dataEpoch, state => {
    if (!state) return state;
    const affect = state.affect;
    if (affect) {
      const saved = affect.cursors[sessionId];
      const active = affect.pending ?? affect.retry;
      const pendingEnd = active?.sessionId === sessionId ? active.end : undefined;
      const end = pendingEnd && (!saved || compareChatAfterglowPositions(pendingEnd, saved) > 0) ? pendingEnd : saved;
      const previous = affect.lateMessages?.[sessionId] ?? [];
      const known = new Set(previous.map(item => item.id));
      const additions = end ? messages.filter(message => message.createdAt > affect.activatedAt
        && compareChatAfterglowPositions(message, end) <= 0 && !known.has(message.id)) : [];
      if (additions.length) state = { ...state, affect: { ...affect, updatedAt: Math.max(Date.now(), affect.updatedAt + 1),
        lateMessages: { ...affect.lateMessages, [sessionId]: [...previous, ...additions.map(({ id, createdAt }) => ({ id, createdAt }))] } } };
    }
    const savedCursor = state?.cursors[sessionId];
    const active = state?.pending ?? state?.retry;
    const ends = [active?.sessionId === sessionId ? active.end : undefined,
      ...[state.pending?.chatSupplement, state.retry?.chatSupplement, state.experience?.batch?.chatSupplement]
        .flatMap(supplemental => supplemental?.sessionId === sessionId ? supplemental.unreadRefs : [])]
      .filter(Boolean) as ChatAfterglowPosition[];
    const pendingEnd = ends.sort(compareChatAfterglowPositions).at(-1);
    const cursor = pendingEnd && (!savedCursor || compareChatAfterglowPositions(pendingEnd, savedCursor) > 0) ? pendingEnd : savedCursor;
    if (!state || !cursor) return state;
    const previous = state.lateMessages?.[sessionId] ?? [];
    const known = new Set(previous.map(item => item.id));
    const additions = messages.filter(message => message.createdAt > state.activatedAt
      && compareChatAfterglowPositions(message, cursor) <= 0 && !known.has(message.id));
    return additions.length ? {
      ...state,
      lateMessages: { ...state.lateMessages, [sessionId]: [...previous, ...additions.map(({ id, createdAt }) => ({ id, createdAt }))] },
    } : state;
  });
}

export function finishAffectUpdateBatch(state: AffectUpdateState,
  pending: Pick<AffectUpdatePending, 'generationKey' | 'sessionId' | 'refs' | 'end' | 'lifeRefs' | 'pokeRefs'>, now: number,
  order: readonly ChatAfterglowPosition[] = [], outcome: 'saved' | 'skipped' = 'saved'): AffectUpdateState {
  const { pending: _pending, retry: _retry, retryAfter: _retryAfter, ...base } = state;
  const next = { ...base, ...(outcome === 'saved' ? { generatedAt: now }
    : { lastSkipped: { generationKey: pending.generationKey, at: now } }), life: { ...state.life } };
  pending.lifeRefs.forEach(ref => { next.life[ref.id] = ref.revision; });
  if (pending.pokeRefs?.length) next.pokes = { ...state.pokes,
    ...Object.fromEntries(pending.pokeRefs.map(ref => [ref.id, ref.revision])) };
  if (!pending.sessionId || !pending.end) return next;
  const sessionId = pending.sessionId;
  const previous = state.cursors[sessionId];
  const end = pending.end;
  const consumed = new Set(pending.refs.map(ref => ref.id));
  const remaining = new Map((state.lateMessages?.[sessionId] ?? []).filter(ref => !consumed.has(ref.id)).map(ref => [ref.id, ref]));
  for (const ref of order) {
    if (ref.createdAt > state.activatedAt && !consumed.has(ref.id)
      && (!previous || compareChatAfterglowPositions(ref, previous) > 0)
      && compareChatAfterglowPositions(ref, end) <= 0) remaining.set(ref.id, ref);
  }
  return { ...next,
    cursors: { ...state.cursors, [sessionId]: !previous || compareChatAfterglowPositions(end, previous) > 0 ? end : previous },
    lateMessages: { ...state.lateMessages, [sessionId]: [...remaining.values()] },
  };
}

export function finishInnerUpdateBatch(state: InnerUpdateState,
  pending: Pick<InnerUpdatePending, 'generationKey' | 'source' | 'materialKey' | 'sessionId' | 'refs' | 'end' | 'materials' | 'chatSupplement'>,
  now: number, order: readonly ChatAfterglowPosition[] = [], outcome: 'saved' | 'skipped' = 'saved',
  supplementOrder: readonly ChatAfterglowPosition[] = order): InnerUpdateState {
  const { pending: _pending, retry: _retry, ...base } = state;
  const materials: InnerMaterialProgress = { ...state.materials,
    ...(state.materials.pokes ? { pokes: { ...state.materials.pokes } } : {}),
    care: { ...state.materials.care }, hearts: [...state.materials.hearts], life: { ...state.materials.life } };
  for (const ref of pending.materials) {
    if (outcome !== 'saved' && ref.kind === 'life' && ref.id.startsWith('nearby-outing:')) continue;
    if (ref.kind === 'dream') {
      if (!materials.dream || compareChatAfterglowPositions(ref, materials.dream) > 0)
        materials.dream = { id: ref.id, createdAt: ref.createdAt };
    } else if (ref.kind === 'heart') {
      if (!materials.hearts.includes(ref.id)) materials.hearts.push(ref.id);
    } else if (ref.kind === 'poke') {
      (materials.pokes ??= {})[ref.id] = ref.revision;
    } else materials[ref.kind][ref.id] = ref.revision;
  }
  const next = finishFirstPaperChatSupplement({ ...base, materials, ...(outcome === 'saved' ? { generatedAt: now }
    : { lastSkipped: { generationKey: pending.generationKey, at: now } }) }, pending.chatSupplement, supplementOrder);
  if (pending.source === 'life') return { ...next, lastLifeMaterialKey: pending.materialKey };
  const sessionId = pending.sessionId!;
  const previous = next.cursors[sessionId];
  const end = pending.end!;
  const consumed = new Set(pending.refs.map(ref => ref.id));
  const remaining = new Map((next.lateMessages?.[sessionId] ?? []).filter(ref => !consumed.has(ref.id)).map(ref => [ref.id, ref]));
  for (const ref of order) {
    if (ref.createdAt > state.activatedAt && !consumed.has(ref.id)
      && (!previous || compareChatAfterglowPositions(ref, previous) > 0)
      && compareChatAfterglowPositions(ref, end) <= 0) remaining.set(ref.id, ref);
  }
  return {
    ...next,
    cursors: { ...next.cursors, [sessionId]: !previous || compareChatAfterglowPositions(end, previous) > 0 ? end : previous },
    lateMessages: { ...next.lateMessages, [sessionId]: [...remaining.values()] },
  };
}

/** Also used after a shared pair's receipt: do not clear another paper's journal. */
export function finishFirstPaperChatSupplement(state: InnerUpdateState, supplement: ChatSupplement | undefined,
  order: readonly ChatAfterglowPosition[]): InnerUpdateState {
  if (!supplement?.unreadRefs.length) return state;
  const { sessionId, unreadRefs } = supplement;
  const previous = state.cursors[sessionId];
  const last = [...unreadRefs].sort(compareChatAfterglowPositions).at(-1)!;
  const end = { id: last.id, createdAt: last.createdAt };
  const consumed = new Set(unreadRefs.map(ref => ref.id));
  const remaining = new Map((state.lateMessages?.[sessionId] ?? []).filter(ref => !consumed.has(ref.id)).map(ref => [ref.id, ref]));
  for (const ref of order) if (ref.createdAt > state.activatedAt && !consumed.has(ref.id)
    && (!previous || compareChatAfterglowPositions(ref, previous) > 0)
    && compareChatAfterglowPositions(ref, end) <= 0) remaining.set(ref.id, ref);
  return { ...state,
    cursors: { ...state.cursors, [sessionId]: !previous || compareChatAfterglowPositions(end, previous) > 0 ? end : previous },
    lateMessages: { ...state.lateMessages, [sessionId]: [...remaining.values()] } };
}
