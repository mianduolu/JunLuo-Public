import {
  wishPoolLifeStorageBridge as AsyncStorage,
  runWishPoolLifeStorageMutation,
} from '../sync/syncWishPoolLifeStorageBridge';

import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  emptyWishCollaboration,
  isWishDiscussionDecision,
  isWishDiscussionPurpose,
  isWishSavedReply,
  readWishCollaboration,
  type WishCollaborationState,
  type WishConfirmation,
  type WishDiscussion,
  type WishDiscussionDecision,
  type WishDiscussionPurpose,
  type WishSavedReply,
} from './wishPoolDiscussionState';

export const WISH_POOL_STORAGE_KEY = 'junluo.wishPool.v1';
export const WISH_POOL_PENDING_CHAT_HANDOFF_KEY = 'junluo.wishPool.pendingChatHandoff.v1';

export type WishOwner = 'I' | 'you';
export type WishStatus =
  | 'candidate'
  | 'not-adopted'
  | 'active'
  | 'in-progress'
  | 'deferred'
  | 'fulfilled'
  | 'released'
  | 'removed';
export type WishOrigin = 'manual' | 'chat' | 'proactive' | 'bookshelf-review';
export type CreatableWishOrigin = Exclude<WishOrigin, 'bookshelf-review'>;

export type WishCompletionEvidence = {
  kind: 'you-confirmation' | 'tool-success';
  sourceId: string;
  occurredAt: number;
};

export type WishItem = {
  id: string;
  owner: WishOwner;
  content: string;
  status: WishStatus;
  origin: WishOrigin;
  sourceMessageId?: string;
  castAt?: number;
  legacyBookshelfItemId?: string;
  legacyProjectId?: string;
  pulledCount: number;
  lastPulledAt?: number;
  redrawEligibleAt?: number;
  startedAt?: number;
  deferredAt?: number;
  fulfilledAt?: number;
  releasedAt?: number;
  removedAt?: number;
  removedBy?: WishOwner;
  completionEvidence?: WishCompletionEvidence;
  createdAt: number;
  updatedAt: number;
};

export type WishPoolEventType =
  | 'proposed'
  | 'discussion-confirmed'
  | 'created'
  | 'pulled'
  | 'started'
  | 'deferred'
  | 'reactivated'
  | 'fulfilled'
  | 'released'
  | 'removed'
  | 'removal-question-persisted'
  | 'removal-discussed';

export type WishPoolEvent = {
  id: string;
  type: WishPoolEventType;
  wishId: string;
  actor?: WishOwner;
  sourceId?: string;
  evidence?: WishCompletionEvidence;
  occurredAt: number;
};

export type WishRemovalDiscussionStatus =
  | 'pending-question'
  | 'question-persisted'
  | 'discussed';

export type WishRemovalDiscussion = {
  id: string;
  wishId: string;
  content: string;
  removedAt: number;
  status: WishRemovalDiscussionStatus;
  questionMessageId?: string;
  questionPersistedAt?: number;
  discussionReplyMessageId?: string;
  discussedAt?: number;
  createdAt: number;
  updatedAt: number;
};

export type WishActionReceipt = {
  operation: 'create' | 'pull' | 'start' | 'defer' | 'fulfill' | 'release' | 'propose';
  sourceId: string;
  wishId: string;
  occurredAt: number;
};

export type WishPoolSnapshot = {
  schemaVersion: 1 | 2;
  collaboration?: WishCollaborationState;
  wishes: WishItem[];
  events: WishPoolEvent[];
  removalDiscussions: WishRemovalDiscussion[];
  actionReceipts: WishActionReceipt[];
  updatedAt: number;
};

export type WishActionRequest =
  | { action: 'create'; content: string; origin?: 'chat' | 'proactive' }
  | { action: 'pull'; wishId: string }
  | { action: 'start'; wishId: string }
  | { action: 'defer'; wishId: string }
  | { action: 'release'; wishId: string };

export type WishActionResult = {
  action: WishActionRequest['action'];
  outcome: 'applied' | 'duplicate' | 'replayed';
  wish: WishItem;
};

export type WishChatHandoff = {
  wishId: string;
  owner: WishOwner;
  content: string;
  status: WishStatus;
  createdAt: number;
};

export type WishPoolErrorCode =
  | 'capacity-reached'
  | 'forbidden'
  | 'invalid-action'
  | 'invalid-content'
  | 'invalid-evidence'
  | 'invalid-origin'
  | 'invalid-source'
  | 'invalid-transition'
  | 'invalid-storage'
  | 'discussion-busy'
  | 'stale-discussion'
  | 'not-found'
  | 'restore-in-progress';

export class WishPoolError extends Error {
  constructor(
    public readonly code: WishPoolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WishPoolError';
  }
}

const WISH_POOL_SCHEMA_VERSION = 1 as const;
const MAX_CONTENT_LENGTH = 160;
const MAX_EVENTS = 200;
const MAX_I_ACTIVE_WISHES = 12;
const REDRAW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const OWNER_VALUES = new Set<WishOwner>(['I', 'you']);
const STATUS_VALUES = new Set<WishStatus>(['candidate', 'not-adopted', 'active', 'in-progress', 'deferred', 'fulfilled', 'released', 'removed']);
const ORIGIN_VALUES = new Set<WishOrigin>(['manual', 'chat', 'proactive', 'bookshelf-review']);
const CREATABLE_ORIGIN_VALUES = new Set<CreatableWishOrigin>(['manual', 'chat', 'proactive']);
const EVENT_VALUES = new Set<WishPoolEventType>([
  'proposed', 'discussion-confirmed',
  'created', 'pulled', 'started', 'deferred', 'reactivated', 'fulfilled', 'released', 'removed',
  'removal-question-persisted', 'removal-discussed',
]);
const DISCUSSION_STATUS_VALUES = new Set<WishRemovalDiscussionStatus>([
  'pending-question', 'question-persisted', 'discussed',
]);
const RECEIPT_OPERATION_VALUES = new Set<WishActionReceipt['operation']>([
  'create', 'pull', 'start', 'defer', 'fulfill', 'release', 'propose',
]);
const NON_TERMINAL_STATUSES = new Set<WishStatus>(['active', 'in-progress', 'deferred']);

let mutationQueue: Promise<void> = Promise.resolve();

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function optionalTimestamp(value: unknown) {
  return isTimestamp(value) ? value : undefined;
}

function storedId(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= 200 ? normalized : undefined;
}

function requireId(value: unknown, code: WishPoolErrorCode = 'invalid-source') {
  const normalized = storedId(value);
  if (!normalized) throw new WishPoolError(code, 'Expected a non-empty identifier.');
  return normalized;
}

export function normalizeWishContent(value: unknown) {
  if (typeof value !== 'string') {
    throw new WishPoolError('invalid-content', 'Wish content must be text.');
  }
  const normalized = value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  const length = Array.from(normalized).length;
  if (length < 1 || length > MAX_CONTENT_LENGTH) {
    throw new WishPoolError('invalid-content', `Wish content must contain 1-${MAX_CONTENT_LENGTH} characters.`);
  }
  return normalized;
}

export function wishContentFingerprint(value: string) {
  return normalizeWishContent(value)
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}\s_]+/gu, '');
}

function normalizeCompletionEvidence(value: unknown): WishCompletionEvidence | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind !== 'you-confirmation' && value.kind !== 'tool-success') return undefined;
  const sourceId = storedId(value.sourceId);
  if (!sourceId || !isTimestamp(value.occurredAt)) return undefined;
  return { kind: value.kind, sourceId, occurredAt: value.occurredAt };
}

function requireCompletionEvidence(value: unknown) {
  const evidence = normalizeCompletionEvidence(value);
  if (!evidence) {
    throw new WishPoolError('invalid-evidence', 'Wish completion requires confirmation or a successful tool receipt.');
  }
  return evidence;
}

function normalizeWishItem(value: unknown): WishItem | null {
  if (!isRecord(value)) return null;
  const id = storedId(value.id);
  if (!id || !OWNER_VALUES.has(value.owner as WishOwner)) return null;
  if (!STATUS_VALUES.has(value.status as WishStatus) || !ORIGIN_VALUES.has(value.origin as WishOrigin)) return null;
  if (!isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  let content: string;
  try {
    content = normalizeWishContent(value.content);
  } catch {
    return null;
  }
  return {
    id,
    owner: value.owner as WishOwner,
    content,
    status: value.status as WishStatus,
    origin: value.origin as WishOrigin,
    sourceMessageId: storedId(value.sourceMessageId),
    castAt: optionalTimestamp(value.castAt),
    legacyBookshelfItemId: storedId(value.legacyBookshelfItemId),
    legacyProjectId: storedId(value.legacyProjectId),
    pulledCount: typeof value.pulledCount === 'number' && Number.isFinite(value.pulledCount)
      ? Math.max(0, Math.floor(value.pulledCount))
      : 0,
    lastPulledAt: optionalTimestamp(value.lastPulledAt),
    redrawEligibleAt: optionalTimestamp(value.redrawEligibleAt),
    startedAt: optionalTimestamp(value.startedAt),
    deferredAt: optionalTimestamp(value.deferredAt),
    fulfilledAt: optionalTimestamp(value.fulfilledAt),
    releasedAt: optionalTimestamp(value.releasedAt),
    removedAt: optionalTimestamp(value.removedAt),
    removedBy: OWNER_VALUES.has(value.removedBy as WishOwner) ? value.removedBy as WishOwner : undefined,
    completionEvidence: normalizeCompletionEvidence(value.completionEvidence),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeEvent(value: unknown): WishPoolEvent | null {
  if (!isRecord(value)) return null;
  const id = storedId(value.id);
  const wishId = storedId(value.wishId);
  if (!id || !wishId || !EVENT_VALUES.has(value.type as WishPoolEventType) || !isTimestamp(value.occurredAt)) return null;
  return {
    id,
    type: value.type as WishPoolEventType,
    wishId,
    actor: OWNER_VALUES.has(value.actor as WishOwner) ? value.actor as WishOwner : undefined,
    sourceId: storedId(value.sourceId),
    evidence: normalizeCompletionEvidence(value.evidence),
    occurredAt: value.occurredAt,
  };
}

function normalizeRemovalDiscussion(value: unknown): WishRemovalDiscussion | null {
  if (!isRecord(value)) return null;
  const id = storedId(value.id);
  const wishId = storedId(value.wishId);
  if (!id || !wishId || !DISCUSSION_STATUS_VALUES.has(value.status as WishRemovalDiscussionStatus)) return null;
  if (!isTimestamp(value.removedAt) || !isTimestamp(value.createdAt) || !isTimestamp(value.updatedAt)) return null;
  let content: string;
  try {
    content = normalizeWishContent(value.content);
  } catch {
    return null;
  }
  return {
    id,
    wishId,
    content,
    removedAt: value.removedAt,
    status: value.status as WishRemovalDiscussionStatus,
    questionMessageId: storedId(value.questionMessageId),
    questionPersistedAt: optionalTimestamp(value.questionPersistedAt),
    discussionReplyMessageId: storedId(value.discussionReplyMessageId),
    discussedAt: optionalTimestamp(value.discussedAt),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeReceipt(value: unknown): WishActionReceipt | null {
  if (!isRecord(value)) return null;
  const sourceId = storedId(value.sourceId);
  const wishId = storedId(value.wishId);
  if (!sourceId || !wishId || !RECEIPT_OPERATION_VALUES.has(value.operation as WishActionReceipt['operation'])) return null;
  if (!isTimestamp(value.occurredAt)) return null;
  return { operation: value.operation as WishActionReceipt['operation'], sourceId, wishId, occurredAt: value.occurredAt };
}

function emptySnapshot(): WishPoolSnapshot {
  return {
    schemaVersion: WISH_POOL_SCHEMA_VERSION,
    wishes: [],
    events: [],
    removalDiscussions: [],
    actionReceipts: [],
    updatedAt: 0,
  };
}

function normalizeSnapshot(value: unknown): WishPoolSnapshot {
  if (!isRecord(value)) throw new WishPoolError('invalid-storage', 'Wish pool storage must be an object.');
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1 && value.schemaVersion !== 2) {
    throw new WishPoolError('invalid-storage', 'Unsupported wish pool schema.');
  }
  const wishes = Array.isArray(value.wishes)
    ? value.wishes.map(normalizeWishItem).filter((item): item is WishItem => !!item)
    : [];
  const wishIds = new Set(wishes.map((wish) => wish.id));
  const events = Array.isArray(value.events)
    ? value.events.map(normalizeEvent).filter((event): event is WishPoolEvent => !!event && wishIds.has(event.wishId)).slice(-MAX_EVENTS)
    : [];
  const removalDiscussions = Array.isArray(value.removalDiscussions)
    ? value.removalDiscussions.map(normalizeRemovalDiscussion)
      .filter((discussion): discussion is WishRemovalDiscussion => !!discussion && wishIds.has(discussion.wishId))
    : [];
  const actionReceipts = Array.isArray(value.actionReceipts)
    ? value.actionReceipts.map(normalizeReceipt)
      .filter((receipt): receipt is WishActionReceipt => !!receipt && wishIds.has(receipt.wishId))
    : [];
  let collaboration: WishCollaborationState | undefined;
  if (value.schemaVersion === 2) {
    try {
      if (!Array.isArray(value.wishes) || wishes.length !== value.wishes.length
        || new Set(wishes.map((wish) => wish.id)).size !== wishes.length
        || !Array.isArray(value.events) || events.length !== Math.min(MAX_EVENTS, value.events.length)
        || !Array.isArray(value.actionReceipts) || actionReceipts.length !== value.actionReceipts.length
        || !Array.isArray(value.removalDiscussions) || removalDiscussions.length !== value.removalDiscussions.length) {
        throw new Error('Incomplete wish snapshot.');
      }
      collaboration = readWishCollaboration(value.collaboration, wishes);
    } catch {
      throw new WishPoolError('invalid-storage', 'Invalid wish pool collaboration snapshot.');
    }
  } else if (value.collaboration !== undefined) {
    throw new WishPoolError('invalid-storage', 'Wish collaboration requires schema version 2.');
  }
  return {
    schemaVersion: value.schemaVersion === 2 ? 2 : WISH_POOL_SCHEMA_VERSION,
    ...(collaboration ? { collaboration } : {}),
    wishes,
    events,
    removalDiscussions,
    actionReceipts,
    updatedAt: isTimestamp(value.updatedAt) ? value.updatedAt : 0,
  };
}

export async function loadWishPoolSnapshot(): Promise<WishPoolSnapshot> {
  const raw = await AsyncStorage.getItem(WISH_POOL_STORAGE_KEY);
  if (!raw) return emptySnapshot();
  try {
    return normalizeSnapshot(JSON.parse(raw) as unknown);
  } catch (error) {
    if (error instanceof WishPoolError) throw error;
    throw new WishPoolError('invalid-storage', 'Wish pool storage is not valid JSON.');
  }
}

function enqueueMutation<T>(work: () => Promise<T>) {
  const turn = mutationQueue.catch(() => undefined);
  let release!: () => void;
  const occupied = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueue = turn.then(() => occupied);
  return turn.then(work).finally(release);
}

type SnapshotMutation<T> = {
  snapshot: WishPoolSnapshot;
  value: T;
};

function mutateWishPool<T>(mutation: (snapshot: WishPoolSnapshot) => SnapshotMutation<T>) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, () => runWishPoolLifeStorageMutation(async (write) => {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) throw new WishPoolError('restore-in-progress', 'Wish write belongs to an old restore epoch.');
      const current = await loadWishPoolSnapshot();
      const result = mutation(current);
      if (result.snapshot !== current) {
        await write(WISH_POOL_STORAGE_KEY, JSON.stringify(result.snapshot));
      }
      return result.value;
    }));
    if (!committed.committed) {
      throw new WishPoolError('restore-in-progress', 'Wish pool changed while backup restore was active.');
    }
    return committed.value;
  });
}

function mutateAuxiliaryStorage<T>(work: () => Promise<T>) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, work);
    if (!committed.committed) {
      throw new WishPoolError('restore-in-progress', 'Wish pool changed while backup restore was active.');
    }
    return committed.value;
  });
}

function makeId(prefix: string, now: number) {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeEvent(
  type: WishPoolEventType,
  wishId: string,
  now: number,
  details: Pick<WishPoolEvent, 'actor' | 'sourceId' | 'evidence'> = {},
): WishPoolEvent {
  return {
    id: makeId('wish-event', now),
    type,
    wishId,
    actor: details.actor,
    sourceId: details.sourceId,
    evidence: details.evidence,
    occurredAt: now,
  };
}

function appendEvent(snapshot: WishPoolSnapshot, event: WishPoolEvent, now: number): WishPoolSnapshot {
  return {
    ...snapshot,
    events: [...snapshot.events, event].slice(-MAX_EVENTS),
    updatedAt: now,
  };
}

function replaceWish(snapshot: WishPoolSnapshot, wish: WishItem): WishPoolSnapshot {
  return { ...snapshot, wishes: snapshot.wishes.map((item) => item.id === wish.id ? wish : item) };
}

function addReceipt(
  snapshot: WishPoolSnapshot,
  operation: WishActionReceipt['operation'],
  sourceId: string,
  wishId: string,
  now: number,
): WishPoolSnapshot {
  if (snapshot.actionReceipts.some((receipt) => receipt.operation === operation && receipt.sourceId === sourceId)) {
    return snapshot;
  }
  return {
    ...snapshot,
    actionReceipts: [...snapshot.actionReceipts, { operation, sourceId, wishId, occurredAt: now }],
    updatedAt: now,
  };
}

function findReceipt(snapshot: WishPoolSnapshot, operation: WishActionReceipt['operation'], sourceId: string) {
  return snapshot.actionReceipts.find((receipt) => receipt.operation === operation && receipt.sourceId === sourceId);
}

function requireWish(snapshot: WishPoolSnapshot, wishId: string) {
  const wish = snapshot.wishes.find((item) => item.id === wishId);
  if (!wish) throw new WishPoolError('not-found', 'Wish was not found.');
  return wish;
}

function replaceWishWithEvent(snapshot: WishPoolSnapshot, wish: WishItem, event: WishPoolEvent, now: number) {
  return appendEvent(replaceWish(snapshot, wish), event, now);
}

function findDuplicateWish(snapshot: WishPoolSnapshot, owner: WishOwner, content: string) {
  const fingerprint = wishContentFingerprint(content);
  return snapshot.wishes.find((wish) => (
    wish.owner === owner
    && NON_TERMINAL_STATUSES.has(wish.status)
    && wishContentFingerprint(wish.content) === fingerprint
  ));
}

function createWish(
  snapshot: WishPoolSnapshot,
  owner: WishOwner,
  content: string,
  origin: WishOrigin,
  now: number,
  sourceMessageId?: string,
) {
  const duplicate = findDuplicateWish(snapshot, owner, content);
  if (duplicate) return { snapshot, wish: duplicate, duplicate: true };
  if (
    owner === 'I'
    && snapshot.wishes.filter((wish) => wish.owner === 'I' && (wish.status === 'active' || wish.status === 'in-progress')).length >= MAX_I_ACTIVE_WISHES
  ) {
    throw new WishPoolError('capacity-reached', 'I already has 12 active wishes.');
  }
  const wish: WishItem = {
    id: makeId('wish', now),
    owner,
    content,
    status: 'active',
    origin,
    sourceMessageId,
    pulledCount: 0,
    createdAt: now,
    updatedAt: now,
  };
  const next = appendEvent(
    { ...snapshot, wishes: [...snapshot.wishes, wish], updatedAt: now },
    makeEvent('created', wish.id, now, { actor: owner, sourceId: sourceMessageId }),
    now,
  );
  return { snapshot: next, wish, duplicate: false };
}

function requireOrigin(value: unknown): CreatableWishOrigin {
  if (!CREATABLE_ORIGIN_VALUES.has(value as CreatableWishOrigin)) throw new WishPoolError('invalid-origin', 'Unknown wish origin.');
  return value as CreatableWishOrigin;
}

function requireTransition(wish: WishItem, status: WishStatus) {
  if (wish.status !== status) throw new WishPoolError('invalid-transition', `Wish cannot transition from ${wish.status}.`);
}

function receiptReplay(snapshot: WishPoolSnapshot, operation: WishActionReceipt['operation'], sourceId: string) {
  const receipt = findReceipt(snapshot, operation, sourceId);
  return receipt ? requireWish(snapshot, receipt.wishId) : null;
}

function pullWish(snapshot: WishPoolSnapshot, wishId: string, drawer: WishOwner, now: number, sourceId?: string) {
  const wish = requireWish(snapshot, wishId);
  requireTransition(wish, 'active');
  if (wish.redrawEligibleAt !== undefined && wish.redrawEligibleAt > now) {
    throw new WishPoolError('invalid-transition', 'Wish is still in its redraw cooldown.');
  }
  if (wish.owner === drawer) throw new WishPoolError('forbidden', 'A wish can only be drawn by the opposite owner.');
  const nextWish: WishItem = {
    ...wish,
    pulledCount: wish.pulledCount + 1,
    lastPulledAt: now,
    redrawEligibleAt: now + REDRAW_COOLDOWN_MS,
    updatedAt: now,
  };
  const next = replaceWishWithEvent(
    snapshot,
    nextWish,
    makeEvent('pulled', wish.id, now, { actor: drawer, sourceId }),
    now,
  );
  return { snapshot: next, wish: nextWish };
}

function startWishMutation(snapshot: WishPoolSnapshot, wishId: string, sourceId: string, now: number) {
  const replayed = receiptReplay(snapshot, 'start', sourceId);
  if (replayed) return { snapshot, wish: replayed, replayed: true };
  const wish = requireWish(snapshot, wishId);
  requireTransition(wish, 'active');
  const nextWish: WishItem = { ...wish, status: 'in-progress', startedAt: now, updatedAt: now };
  const next = addReceipt(
    replaceWishWithEvent(snapshot, nextWish, makeEvent('started', wish.id, now, { sourceId }), now),
    'start', sourceId, wish.id, now,
  );
  return { snapshot: next, wish: nextWish, replayed: false };
}

function deferWishMutation(snapshot: WishPoolSnapshot, wishId: string, sourceId: string, now: number) {
  const replayed = receiptReplay(snapshot, 'defer', sourceId);
  if (replayed) return { snapshot, wish: replayed, replayed: true };
  const wish = requireWish(snapshot, wishId);
  requireTransition(wish, 'active');
  if (wish.owner !== 'you') throw new WishPoolError('forbidden', 'Only a you-owned wish can be deferred by I.');
  const nextWish: WishItem = { ...wish, status: 'deferred', deferredAt: now, updatedAt: now };
  const next = addReceipt(
    replaceWishWithEvent(snapshot, nextWish, makeEvent('deferred', wish.id, now, { actor: 'I', sourceId }), now),
    'defer', sourceId, wish.id, now,
  );
  return { snapshot: next, wish: nextWish, replayed: false };
}

function releaseWishMutation(
  snapshot: WishPoolSnapshot,
  wishId: string,
  actor: WishOwner,
  sourceId: string,
  now: number,
) {
  const replayed = receiptReplay(snapshot, 'release', sourceId);
  if (replayed) return { snapshot, wish: replayed, replayed: true };
  const wish = requireWish(snapshot, wishId);
  if (wish.owner !== actor) throw new WishPoolError('forbidden', 'Only the wish owner can release it.');
  const allowed = actor === 'I'
    ? wish.status === 'active' || wish.status === 'in-progress'
    : wish.status === 'active' || wish.status === 'in-progress' || wish.status === 'deferred';
  if (!allowed) throw new WishPoolError('invalid-transition', `Wish cannot be released from ${wish.status}.`);
  const nextWish: WishItem = { ...wish, status: 'released', releasedAt: now, updatedAt: now };
  const next = addReceipt(
    replaceWishWithEvent(snapshot, nextWish, makeEvent('released', wish.id, now, { actor, sourceId }), now),
    'release', sourceId, wish.id, now,
  );
  return { snapshot: next, wish: nextWish, replayed: false };
}

function normalizeIAction(value: WishActionRequest): WishActionRequest {
  if (!isRecord(value) || 'owner' in value || 'status' in value) {
    throw new WishPoolError('invalid-action', 'Hidden wish actions cannot set owner or status.');
  }
  if (value.action === 'create') {
    const origin = value.origin === undefined ? 'chat' : value.origin;
    if (origin !== 'chat' && origin !== 'proactive') {
      throw new WishPoolError('invalid-origin', 'I wishes can only come from chat or proactive messages.');
    }
    return { action: 'create', content: normalizeWishContent(value.content), origin };
  }
  if (value.action === 'pull' || value.action === 'start' || value.action === 'defer' || value.action === 'release') {
    return { action: value.action, wishId: requireId(value.wishId, 'invalid-action') };
  }
  throw new WishPoolError('invalid-action', 'Unknown hidden wish action.');
}

export function getWishDrawWeight(wish: WishItem, now = Date.now()) {
  const ageDays = Math.max(0, now - wish.createdAt) / (24 * 60 * 60 * 1000);
  const idleDays = wish.lastPulledAt === undefined
    ? 30
    : Math.max(0, now - wish.lastPulledAt) / (24 * 60 * 60 * 1000);
  return Math.max(0.1, 1 + Math.min(3, idleDays / 7) + Math.min(1.5, ageDays / 30) - wish.pulledCount * 0.18);
}

function selectWeightedWish(candidates: WishItem[], now: number) {
  if (!candidates.length) return null;
  const weighted = candidates.map((wish) => ({ wish, weight: getWishDrawWeight(wish, now) }));
  let roll = Math.random() * weighted.reduce((sum, item) => sum + item.weight, 0);
  for (const item of weighted) {
    roll -= item.weight;
    if (roll <= 0) return item.wish;
  }
  return weighted[weighted.length - 1].wish;
}

// Chapter 3 data APIs only: no page, tool or chat caller is connected yet.
// All changes share the original key, write queue, sync bridge and restore epoch.
function withCollaboration(snapshot: WishPoolSnapshot, collaboration: WishCollaborationState, now: number): WishPoolSnapshot {
  return { ...snapshot, schemaVersion: 2, collaboration, updatedAt: now };
}

function saveDiscussion(snapshot: WishPoolSnapshot, discussion: WishDiscussion): WishPoolSnapshot {
  const state = snapshot.collaboration ?? emptyWishCollaboration();
  const exists = state.discussions.some((item) => item.id === discussion.id);
  return withCollaboration(snapshot, {
    ...state,
    discussions: exists
      ? state.discussions.map((item) => item.id === discussion.id ? discussion : item)
      : [...state.discussions, discussion],
  }, discussion.updatedAt);
}

function requireDiscussion(snapshot: WishPoolSnapshot, discussionId: string, expectedRevision: number) {
  const discussion = snapshot.collaboration?.discussions.find((item) => item.id === discussionId);
  if (!discussion) throw new WishPoolError('not-found', 'Wish discussion was not found.');
  if (discussion.closedAt !== undefined || discussion.revision !== expectedRevision) {
    throw new WishPoolError('stale-discussion', 'Wish discussion has changed or ended.');
  }
  return discussion;
}

function requireDiscussionPurpose(wish: WishItem, purpose: WishDiscussionPurpose) {
  if (!isWishDiscussionPurpose(purpose)) throw new WishPoolError('invalid-action', 'Unknown discussion purpose.');
  const allowed = purpose === 'cast_coin'
    ? wish.status === 'candidate'
    : NON_TERMINAL_STATUSES.has(wish.status);
  if (!allowed) throw new WishPoolError('invalid-transition', 'Wish does not allow this discussion.');
}

function discussionText(value: unknown, purpose: WishDiscussionPurpose) {
  if (purpose === 'cast_coin' || purpose === 'revise') return normalizeWishContent(value);
  if (typeof value !== 'string' || !value.trim()) throw new WishPoolError('invalid-content', 'Discussion text must not be empty.');
  return value.trim();
}

export function saveWishCandidate(input: {
  owner: WishOwner;
  content: string;
  origin: CreatableWishOrigin;
  actionId: string;
  sourceMessageId?: string;
}): Promise<WishItem> {
  // owner/actionId are supplied by the host, never copied from model arguments.
  const actionId = requireId(input.actionId);
  const content = normalizeWishContent(input.content);
  const origin = requireOrigin(input.origin);
  const sourceMessageId = input.sourceMessageId === undefined ? undefined : requireId(input.sourceMessageId);
  if (!OWNER_VALUES.has(input.owner)) throw new WishPoolError('forbidden', 'Invalid candidate owner.');
  return mutateWishPool((snapshot) => {
    const receipt = findReceipt(snapshot, 'propose', actionId);
    if (receipt) {
      const wish = requireWish(snapshot, receipt.wishId);
      if (wish.owner !== input.owner) throw new WishPoolError('forbidden', 'Candidate action belongs to another owner.');
      return { snapshot, value: wish };
    }
    const now = Date.now();
    const wish: WishItem = {
      id: makeId('wish', now), owner: input.owner, content, status: 'candidate', origin,
      sourceMessageId, pulledCount: 0, createdAt: now, updatedAt: now,
    };
    const next = withCollaboration({ ...snapshot, wishes: [...snapshot.wishes, wish] },
      snapshot.collaboration ?? emptyWishCollaboration(), now);
    return {
      snapshot: addReceipt(appendEvent(next, makeEvent('proposed', wish.id, now, { actor: wish.owner, sourceId: actionId }), now),
        'propose', actionId, wish.id, now),
      value: wish,
    };
  });
}

export function prepareWishDiscussion(input: {
  wishId: string;
  purpose: WishDiscussionPurpose;
  sourceId: string;
  conversationId: string;
  pendingText?: string;
}): Promise<WishDiscussion> {
  const sourceId = requireId(input.sourceId);
  const conversationId = requireId(input.conversationId);
  return mutateWishPool((snapshot) => {
    const discussions = snapshot.collaboration?.discussions ?? [];
    const replay = discussions.find((item) => item.sourceId === sourceId);
    if (replay) {
      if (replay.wishId !== input.wishId || replay.purpose !== input.purpose || replay.conversationId !== conversationId) {
        throw new WishPoolError('invalid-source', 'Discussion source was already used.');
      }
      return { snapshot, value: replay };
    }
    if (discussions.some((item) => item.closedAt === undefined)) {
      throw new WishPoolError('discussion-busy', 'Continue the current wish discussion first.');
    }
    const wish = requireWish(snapshot, input.wishId);
    requireDiscussionPurpose(wish, input.purpose);
    const now = Date.now();
    const discussion: WishDiscussion = {
      id: makeId('wish-discussion', now), wishId: wish.id, purpose: input.purpose, sourceId, conversationId,
      revision: 1, pendingText: discussionText(input.pendingText ?? wish.content, input.purpose),
      decision: 'talking', createdAt: now, updatedAt: now,
    };
    return { snapshot: saveDiscussion(snapshot, discussion), value: discussion };
  });
}

// Restart recovery reads this same persisted discussion; it is not a pause/switch action.
export async function loadCurrentWishDiscussion(): Promise<WishDiscussion | null> {
  const snapshot = await loadWishPoolSnapshot();
  return snapshot.collaboration?.discussions.find((item) => item.closedAt === undefined) ?? null;
}

// Call before another discussion request or local edit, even if its text is unchanged.
// A failed/late request can then never reuse the previous reply's consent.
export function reviseWishDiscussion(input: {
  discussionId: string;
  expectedRevision: number;
  purpose?: WishDiscussionPurpose;
  pendingText?: string;
}): Promise<WishDiscussion> {
  return mutateWishPool((snapshot) => {
    const current = requireDiscussion(snapshot, input.discussionId, input.expectedRevision);
    const purpose = input.purpose ?? current.purpose;
    requireDiscussionPurpose(requireWish(snapshot, current.wishId), purpose);
    const next: WishDiscussion = {
      ...current, purpose, pendingText: discussionText(input.pendingText ?? current.pendingText, purpose),
      lastDraftReply: input.pendingText !== undefined || input.purpose !== undefined
        ? undefined : current.reply ?? current.lastDraftReply,
      revision: current.revision + 1, decision: 'talking', reply: undefined, updatedAt: Date.now(),
    };
    return { snapshot: saveDiscussion(snapshot, next), value: next };
  });
}

export function applyWishDiscussionResult(input: {
  discussionId: string;
  expectedRevision: number;
  pendingText: string;
  decision: WishDiscussionDecision;
  savedReply: WishSavedReply;
}): Promise<WishDiscussion> {
  if (!isWishDiscussionDecision(input.decision)) throw new WishPoolError('invalid-action', 'Invalid discussion decision.');
  if (!isWishSavedReply(input.savedReply)) throw new WishPoolError('invalid-evidence', 'A saved I reply is required.');
  return mutateWishPool((snapshot) => {
    const previous = snapshot.collaboration?.discussions.find((item) => item.id === input.discussionId);
    if (previous?.reply?.messageId === input.savedReply.messageId
      && previous.reply.requestRevision === input.expectedRevision) {
      if (previous.pendingText !== discussionText(input.pendingText, previous.purpose)
        || previous.decision !== input.decision || previous.reply.persistedAt !== input.savedReply.persistedAt) {
        throw new WishPoolError('invalid-evidence', 'Saved reply cannot change on replay.');
      }
      return { snapshot, value: previous };
    }
    const current = requireDiscussion(snapshot, input.discussionId, input.expectedRevision);
    requireDiscussionPurpose(requireWish(snapshot, current.wishId), current.purpose);
    if (input.savedReply.persistedAt < current.updatedAt) throw new WishPoolError('invalid-evidence', 'Reply predates this discussion version.');
    const next: WishDiscussion = {
      ...current, pendingText: discussionText(input.pendingText, current.purpose), decision: input.decision,
      revision: current.revision + 1, reply: { ...input.savedReply, requestRevision: current.revision }, updatedAt: Date.now(),
    };
    delete next.lastDraftReply;
    return { snapshot: saveDiscussion(snapshot, next), value: next };
  });
}

// Host-only mouse click. Never expose this final commit as an executable model tool.
export function confirmWishDiscussion(input: {
  discussionId: string;
  expectedRevision: number;
  sourceId: string;
}): Promise<WishConfirmation> {
  const sourceId = requireId(input.sourceId);
  return mutateWishPool((snapshot) => {
    const state = snapshot.collaboration ?? emptyWishCollaboration();
    const replay = state.confirmations.find((item) => item.discussionId === input.discussionId
      && item.revision === input.expectedRevision);
    if (replay) return { snapshot, value: replay };
    const discussion = requireDiscussion(snapshot, input.discussionId, input.expectedRevision);
    if (!discussion.reply || discussion.decision === 'talking') {
      throw new WishPoolError('invalid-evidence', 'This version has no saved I agreement.');
    }
    const wish = requireWish(snapshot, discussion.wishId);
    requireDiscussionPurpose(wish, discussion.purpose);
    const now = Date.now();
    let nextWish = wish;
    if (discussion.purpose === 'cast_coin') {
      if (discussion.decision === 'yes' && wish.owner === 'I'
        && snapshot.wishes.filter((item) => item.owner === 'I'
          && (item.status === 'active' || item.status === 'in-progress')).length >= MAX_I_ACTIVE_WISHES) {
        throw new WishPoolError('capacity-reached', 'I already has 12 active wishes.');
      }
      nextWish = {
        ...wish, content: normalizeWishContent(discussion.pendingText),
        status: discussion.decision === 'yes' ? 'active' : 'not-adopted',
        ...(discussion.decision === 'yes' ? { castAt: now } : {}), updatedAt: now,
      };
    } else if (discussion.decision === 'yes' && discussion.purpose === 'revise') {
      nextWish = { ...wish, content: normalizeWishContent(discussion.pendingText), updatedAt: now };
    } else if (discussion.decision === 'yes' && discussion.purpose === 'complete') {
      nextWish = { ...wish, status: 'fulfilled', fulfilledAt: now, updatedAt: now,
        completionEvidence: { kind: 'you-confirmation', sourceId, occurredAt: now } };
    } else if (discussion.decision === 'yes' && discussion.purpose === 'release') {
      nextWish = { ...wish, status: 'released', releasedAt: now, updatedAt: now };
    }
    const confirmation: WishConfirmation = {
      id: makeId('wish-confirmation', now), discussionId: discussion.id, revision: discussion.revision,
      wishId: wish.id, wishOwner: wish.owner, wishContent: nextWish.content,
      purpose: discussion.purpose, decision: discussion.decision, pendingText: discussion.pendingText,
      reply: discussion.reply, confirmedBy: 'you', sourceId, confirmedAt: now,
    };
    const nextState: WishCollaborationState = {
      ...state,
      discussions: state.discussions.map((item) => item.id === discussion.id ? { ...item, closedAt: now, updatedAt: now } : item),
      confirmations: [...state.confirmations, confirmation],
      progressNotes: discussion.purpose === 'progress' && discussion.decision === 'yes'
        ? [...state.progressNotes, { id: makeId('wish-progress', now), wishId: wish.id, content: discussion.pendingText,
          recordedAt: now, replyMessageId: discussion.reply.messageId, confirmationId: confirmation.id }]
        : state.progressNotes,
    };
    const next = withCollaboration(replaceWish(snapshot, nextWish), nextState, now);
    return { snapshot: appendEvent(next, makeEvent('discussion-confirmed', wish.id, now, { actor: 'you', sourceId }), now), value: confirmation };
  });
}

export async function loadPendingWishConfirmations(): Promise<WishConfirmation[]> {
  const snapshot = await loadWishPoolSnapshot();
  return (snapshot.collaboration?.confirmations ?? []).filter((item) => !item.deliveredWithReply)
    .sort((left, right) => left.confirmedAt - right.confirmedAt);
}

// Only IDs actually included in that request; call after the ordinary I reply is saved.
export function markWishConfirmationsDelivered(ids: string[], savedReply: WishSavedReply): Promise<void> {
  if (!isWishSavedReply(savedReply)) throw new WishPoolError('invalid-evidence', 'A saved reply is required for delivery.');
  const included = new Set(ids.map((id) => requireId(id)));
  return mutateWishPool((snapshot) => {
    const state = snapshot.collaboration ?? emptyWishCollaboration();
    for (const id of included) {
      const item = state.confirmations.find((entry) => entry.id === id);
      if (!item) throw new WishPoolError('not-found', 'Confirmation was not found.');
      if (savedReply.persistedAt < item.confirmedAt) throw new WishPoolError('invalid-evidence', 'Reply predates confirmation.');
    }
    if (!state.confirmations.some((item) => included.has(item.id) && !item.deliveredWithReply)) return { snapshot, value: undefined };
    const confirmations = state.confirmations.map((item) => included.has(item.id) && !item.deliveredWithReply
      ? { ...item, deliveredWithReply: savedReply } : item);
    return { snapshot: withCollaboration(snapshot, { ...state, confirmations }, Date.now()), value: undefined };
  });
}

export function createYouWish(content: string, origin: CreatableWishOrigin = 'manual'): Promise<WishItem> {
  const normalizedContent = normalizeWishContent(content);
  const normalizedOrigin = requireOrigin(origin);
  return mutateWishPool((snapshot) => {
    const created = createWish(snapshot, 'you', normalizedContent, normalizedOrigin, Date.now());
    return { snapshot: created.snapshot, value: created.wish };
  });
}

export function commitIWishAction(action: WishActionRequest, sourceMessageId: string): Promise<WishActionResult> {
  const normalizedAction = normalizeIAction(action);
  const sourceId = requireId(sourceMessageId);
  return mutateWishPool<WishActionResult>((snapshot) => {
    const operation = normalizedAction.action;
    const replayed = receiptReplay(snapshot, operation, sourceId);
    if (replayed) return { snapshot, value: { action: operation, outcome: 'replayed', wish: replayed } };
    const now = Date.now();
    if (normalizedAction.action === 'create') {
      const created = createWish(snapshot, 'I', normalizedAction.content, normalizedAction.origin ?? 'chat', now, sourceId);
      const next = addReceipt(created.snapshot, 'create', sourceId, created.wish.id, now);
      return {
        snapshot: next,
        value: {
          action: normalizedAction.action,
          outcome: created.duplicate ? 'duplicate' : 'applied',
          wish: created.wish,
        },
      };
    }
    if (normalizedAction.action === 'pull') {
      const pulled = pullWish(snapshot, normalizedAction.wishId, 'I', now, sourceId);
      const next = addReceipt(pulled.snapshot, 'pull', sourceId, pulled.wish.id, now);
      return { snapshot: next, value: { action: 'pull', outcome: 'applied', wish: pulled.wish } };
    }
    if (normalizedAction.action === 'start') {
      const started = startWishMutation(snapshot, normalizedAction.wishId, sourceId, now);
      return { snapshot: started.snapshot, value: { action: 'start', outcome: 'applied', wish: started.wish } };
    }
    if (normalizedAction.action === 'defer') {
      const deferred = deferWishMutation(snapshot, normalizedAction.wishId, sourceId, now);
      return { snapshot: deferred.snapshot, value: { action: 'defer', outcome: 'applied', wish: deferred.wish } };
    }
    const released = releaseWishMutation(snapshot, normalizedAction.wishId, 'I', sourceId, now);
    return { snapshot: released.snapshot, value: { action: 'release', outcome: 'applied', wish: released.wish } };
  });
}
export function drawOppositeWish(drawer: WishOwner, now = Date.now(), wishId?: string, actionId?: string): Promise<WishItem | null> {
  if (!OWNER_VALUES.has(drawer)) throw new WishPoolError('forbidden', 'Unknown wish drawer.');
  const sourceId = actionId === undefined ? undefined : requireId(actionId);
  return mutateWishPool((snapshot) => {
    const replayed = sourceId === undefined ? null : receiptReplay(snapshot, 'pull', sourceId);
    if (replayed) {
      if (replayed.owner === drawer) throw new WishPoolError('forbidden', 'Pull action belongs to another drawer.');
      return { snapshot, value: replayed };
    }
    const selected = selectWeightedWish(
      snapshot.wishes.filter((wish) => (
        wish.owner !== drawer
        && wish.status === 'active'
        && (wishId === undefined || wish.id === wishId)
        && (wish.lastPulledAt === undefined || wish.lastPulledAt + REDRAW_COOLDOWN_MS <= now)
        && (wish.redrawEligibleAt === undefined || wish.redrawEligibleAt <= now)
      )),
      now,
    );
    if (!selected) return { snapshot, value: null };
    const pulled = pullWish(snapshot, selected.id, drawer, now, sourceId);
    return {
      snapshot: sourceId === undefined ? pulled.snapshot : addReceipt(pulled.snapshot, 'pull', sourceId, pulled.wish.id, now),
      value: pulled.wish,
    };
  });
}

export function startWish(wishId: string, sourceId: string): Promise<WishItem> {
  const id = requireId(wishId, 'not-found');
  const source = requireId(sourceId);
  return mutateWishPool((snapshot) => {
    const started = startWishMutation(snapshot, id, source, Date.now());
    return { snapshot: started.snapshot, value: started.wish };
  });
}

export function deferYouWish(wishId: string, sourceMessageId: string): Promise<WishItem> {
  const id = requireId(wishId, 'not-found');
  const source = requireId(sourceMessageId);
  return mutateWishPool((snapshot) => {
    const deferred = deferWishMutation(snapshot, id, source, Date.now());
    return { snapshot: deferred.snapshot, value: deferred.wish };
  });
}

export function reactivateYouWish(wishId: string): Promise<WishItem> {
  const id = requireId(wishId, 'not-found');
  return mutateWishPool((snapshot) => {
    const wish = requireWish(snapshot, id);
    if (wish.owner !== 'you') throw new WishPoolError('forbidden', 'Only a you-owned wish can be reactivated.');
    if (wish.status === 'active') return { snapshot, value: wish };
    requireTransition(wish, 'deferred');
    const now = Date.now();
    const nextWish: WishItem = { ...wish, status: 'active', deferredAt: undefined, updatedAt: now };
    const next = replaceWishWithEvent(snapshot, nextWish, makeEvent('reactivated', wish.id, now, { actor: 'you' }), now);
    return { snapshot: next, value: nextWish };
  });
}

export function fulfillWish(wishId: string, evidence: WishCompletionEvidence): Promise<WishItem> {
  const id = requireId(wishId, 'not-found');
  const normalizedEvidence = requireCompletionEvidence(evidence);
  return mutateWishPool((snapshot) => {
    const replayed = receiptReplay(snapshot, 'fulfill', normalizedEvidence.sourceId);
    if (replayed) return { snapshot, value: replayed };
    const wish = requireWish(snapshot, id);
    requireTransition(wish, 'in-progress');
    if (normalizedEvidence.occurredAt < (wish.startedAt ?? wish.createdAt)) {
      throw new WishPoolError('invalid-evidence', 'Wish completion evidence cannot predate the wish start.');
    }
    const now = normalizedEvidence.occurredAt;
    const nextWish: WishItem = {
      ...wish,
      status: 'fulfilled',
      fulfilledAt: now,
      completionEvidence: normalizedEvidence,
      updatedAt: now,
    };
    const next = addReceipt(
      replaceWishWithEvent(
        snapshot,
        nextWish,
        makeEvent('fulfilled', wish.id, now, { sourceId: normalizedEvidence.sourceId, evidence: normalizedEvidence }),
        now,
      ),
      'fulfill', normalizedEvidence.sourceId, wish.id, now,
    );
    return { snapshot: next, value: nextWish };
  });
}

export function releaseWish(wishId: string, actor: WishOwner, sourceId: string): Promise<WishItem> {
  const id = requireId(wishId, 'not-found');
  if (!OWNER_VALUES.has(actor)) throw new WishPoolError('forbidden', 'Unknown wish owner.');
  const source = requireId(sourceId);
  return mutateWishPool((snapshot) => {
    const released = releaseWishMutation(snapshot, id, actor, source, Date.now());
    return { snapshot: released.snapshot, value: released.wish };
  });
}

export function removeIWishByYou(wishId: string): Promise<WishRemovalDiscussion> {
  const id = requireId(wishId, 'not-found');
  return mutateWishPool((snapshot) => {
    const wish = requireWish(snapshot, id);
    const existing = snapshot.removalDiscussions.find((discussion) => discussion.wishId === id);
    if (wish.status === 'removed' && existing) return { snapshot, value: existing };
    if (wish.owner !== 'I') throw new WishPoolError('forbidden', 'Only an I-owned wish can be removed by you.');
    if (wish.status !== 'active' && wish.status !== 'in-progress') {
      throw new WishPoolError('invalid-transition', `Wish cannot be removed from ${wish.status}.`);
    }
    const now = Date.now();
    const nextWish: WishItem = {
      ...wish,
      status: 'removed',
      removedAt: now,
      removedBy: 'you',
      updatedAt: now,
    };
    const discussion: WishRemovalDiscussion = {
      id: makeId('wish-removal', now),
      wishId: wish.id,
      content: wish.content,
      removedAt: now,
      status: 'pending-question',
      createdAt: now,
      updatedAt: now,
    };
    const withWish = replaceWishWithEvent(
      snapshot,
      nextWish,
      makeEvent('removed', wish.id, now, { actor: 'you' }),
      now,
    );
    return {
      snapshot: {
        ...withWish,
        removalDiscussions: [...withWish.removalDiscussions, discussion],
        updatedAt: now,
      },
      value: discussion,
    };
  });
}

export function loadNextPendingWishRemovalDiscussion() {
  return loadWishPoolSnapshot().then((snapshot) => (
    snapshot.removalDiscussions
      .filter((discussion) => discussion.status !== 'discussed')
      .sort((left, right) => left.removedAt - right.removedAt)[0] ?? null
  ));
}

export function markWishRemovalQuestionPersisted(
  discussionId: string,
  questionMessageId: string,
  now = Date.now(),
): Promise<WishRemovalDiscussion> {
  const id = requireId(discussionId, 'not-found');
  const messageId = requireId(questionMessageId);
  return mutateWishPool((snapshot) => {
    const discussion = snapshot.removalDiscussions.find((item) => item.id === id);
    if (!discussion) throw new WishPoolError('not-found', 'Wish removal discussion was not found.');
    if (discussion.questionMessageId) return { snapshot, value: discussion };
    if (discussion.status !== 'pending-question') {
      throw new WishPoolError('invalid-transition', 'Removal question is not pending.');
    }
    const nextDiscussion: WishRemovalDiscussion = {
      ...discussion,
      status: 'question-persisted',
      questionMessageId: messageId,
      questionPersistedAt: now,
      updatedAt: now,
    };
    const next = appendEvent(
      {
        ...snapshot,
        removalDiscussions: snapshot.removalDiscussions.map((item) => item.id === id ? nextDiscussion : item),
      },
      makeEvent('removal-question-persisted', discussion.wishId, now, { actor: 'I', sourceId: messageId }),
      now,
    );
    return { snapshot: next, value: nextDiscussion };
  });
}

export function markWishRemovalDiscussed(
  discussionId: string,
  replyMessageId: string,
  now = Date.now(),
): Promise<WishRemovalDiscussion> {
  const id = requireId(discussionId, 'not-found');
  const messageId = requireId(replyMessageId);
  return mutateWishPool((snapshot) => {
    const discussion = snapshot.removalDiscussions.find((item) => item.id === id);
    if (!discussion) throw new WishPoolError('not-found', 'Wish removal discussion was not found.');
    if (discussion.status === 'discussed') return { snapshot, value: discussion };
    if (discussion.status !== 'question-persisted') {
      throw new WishPoolError('invalid-transition', 'Removal question must be persisted before discussion closes.');
    }
    const nextDiscussion: WishRemovalDiscussion = {
      ...discussion,
      status: 'discussed',
      discussionReplyMessageId: messageId,
      discussedAt: now,
      updatedAt: now,
    };
    const next = appendEvent(
      {
        ...snapshot,
        removalDiscussions: snapshot.removalDiscussions.map((item) => item.id === id ? nextDiscussion : item),
      },
      makeEvent('removal-discussed', discussion.wishId, now, { actor: 'I', sourceId: messageId }),
      now,
    );
    return { snapshot: next, value: nextDiscussion };
  });
}

function normalizeHandoff(value: unknown): WishChatHandoff | null {
  if (!isRecord(value)) return null;
  const wishId = storedId(value.wishId);
  if (!wishId || !OWNER_VALUES.has(value.owner as WishOwner) || !STATUS_VALUES.has(value.status as WishStatus)) return null;
  if (!isTimestamp(value.createdAt)) return null;
  let content: string;
  try {
    content = normalizeWishContent(value.content);
  } catch {
    return null;
  }
  return {
    wishId,
    owner: value.owner as WishOwner,
    content,
    status: value.status as WishStatus,
    createdAt: value.createdAt,
  };
}

export async function loadPendingWishChatHandoff(): Promise<WishChatHandoff | null> {
  const raw = await AsyncStorage.getItem(WISH_POOL_PENDING_CHAT_HANDOFF_KEY);
  if (!raw) return null;
  try {
    return normalizeHandoff(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function savePendingWishChatHandoff(wishId: string): Promise<WishChatHandoff> {
  const id = requireId(wishId, 'not-found');
  return mutateAuxiliaryStorage(async () => {
    const snapshot = await loadWishPoolSnapshot();
    const wish = requireWish(snapshot, id);
    if (!NON_TERMINAL_STATUSES.has(wish.status)) {
      throw new WishPoolError('invalid-transition', 'A terminal wish cannot be carried into chat.');
    }
    const handoff: WishChatHandoff = {
      wishId: wish.id,
      owner: wish.owner,
      content: wish.content,
      status: wish.status,
      createdAt: Date.now(),
    };
    await AsyncStorage.setItem(WISH_POOL_PENDING_CHAT_HANDOFF_KEY, JSON.stringify(handoff));
    return handoff;
  });
}

export function clearPendingWishChatHandoff(): Promise<void> {
  return mutateAuxiliaryStorage(async () => {
    await AsyncStorage.removeItem(WISH_POOL_PENDING_CHAT_HANDOFF_KEY);
  });
}

export function consumePendingWishChatHandoff(): Promise<WishChatHandoff | null> {
  return mutateAuxiliaryStorage(async () => {
    const handoff = await loadPendingWishChatHandoff();
    if (handoff) await AsyncStorage.removeItem(WISH_POOL_PENDING_CHAT_HANDOFF_KEY);
    return handoff;
  });
}
