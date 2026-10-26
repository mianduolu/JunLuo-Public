import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { mergeWishPoolWishRecords } from './syncWishPoolLifeMerge';
import type { PlainMutationV1, JsonValue } from './syncProtocol';
import { emptyWishCollaboration, readWishCollaboration } from '../wishPool/wishPoolDiscussionState';
import { runWishPoolLifeCaptureExclusive } from './syncWishPoolLifeCaptureQueue';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

import {
  WISH_POOL_PENDING_INTENT_ENTITY_ID,
  assertWishPoolLifeRecord,
  wishPoolActionReceiptEntityId,
  wishPoolEventEntityId,
  type WishPoolActionReceiptRecord,
  type WishPoolDiscussionRecord,
  type WishPoolEventRecord,
  type WishPoolPendingIntentRecord,
  type WishPoolWishRecord,
} from './syncWishPoolLife';
import type {
  WishPoolLifeBusinessPort,
} from './syncWishPoolLifeApply';
import {
  WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY,
  WISH_POOL_LIFE_STORAGE_KEY,
  emptyWishPoolLifeSnapshotStorage,
  parseWishPoolLifeSnapshotStorage,
  wishPoolSnapshotRecord,
  parseWishPoolPendingIntentStorage,
  serializeWishPoolLifeSnapshotStorage,
  serializeWishPoolPendingIntentStorage,
  type WishPoolLifeSnapshotStorage,
  type WishPoolLifeWishStorage,
} from './syncWishPoolLifeStorageDerivation';

const REDRAW_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
let wishPoolLifeApplyQueue = Promise.resolve();

function enqueueWishPoolLifeApply<T>(
  callback: () => Promise<T>,
  epoch = captureBackupRestoreDataEpoch(),
) {
  const current = wishPoolLifeApplyQueue
    .catch(() => undefined)
    .then(async () => {
      const result = await runBackupRestoreDataEpochCommit(epoch, () => runWishPoolLifeCaptureExclusive(() => {
        if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('Wish sync apply belongs to an old restore epoch.');
        return callback();
      }));
      if (!result.committed) throw new Error('Wish sync apply belongs to an old restore epoch.');
      return result.value;
    });
  wishPoolLifeApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function loadSnapshot() {
  const raw = await RawAsyncStorage.getItem(
    WISH_POOL_LIFE_STORAGE_KEY,
  );
  return raw
    ? parseWishPoolLifeSnapshotStorage(raw)
    : emptyWishPoolLifeSnapshotStorage();
}

function sortedSnapshot(
  snapshot: WishPoolLifeSnapshotStorage,
): WishPoolLifeSnapshotStorage {
  return {
    ...snapshot,
    wishes: [...snapshot.wishes].sort(
      (left, right) => (
        left.createdAt - right.createdAt
        || left.id.localeCompare(right.id)
      ),
    ),
    events: [...snapshot.events]
      .sort(
        (left, right) => (
          left.occurredAt - right.occurredAt
          || left.id.localeCompare(right.id)
        ),
      )
      .slice(-200),
    removalDiscussions: [...snapshot.removalDiscussions].sort(
      (left, right) => (
        left.removedAt - right.removedAt
        || left.id.localeCompare(right.id)
      ),
    ),
    actionReceipts: [...snapshot.actionReceipts].sort(
      (left, right) => (
        left.occurredAt - right.occurredAt
        || wishPoolActionReceiptEntityId(
          left.operation,
          left.sourceId,
        ).localeCompare(
          wishPoolActionReceiptEntityId(
            right.operation,
            right.sourceId,
          ),
        )
      ),
    ),
  };
}

async function saveSnapshot(
  snapshot: WishPoolLifeSnapshotStorage,
  updatedAt: number,
) {
  await RawAsyncStorage.setItem(
    WISH_POOL_LIFE_STORAGE_KEY,
    serializeWishPoolLifeSnapshotStorage(sortedSnapshot({
      ...snapshot,
      updatedAt: Math.max(snapshot.updatedAt, updatedAt),
    })),
  );
}

function pulledEventCounts(events: readonly WishPoolEventRecord[]) {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'pulled') continue;
    counts.set(event.wishId, (counts.get(event.wishId) ?? 0) + 1);
  }
  return counts;
}

function wishStorageRecord(
  record: WishPoolWishRecord,
  retainedPulledEvents: number,
): WishPoolLifeWishStorage {
  const {
    pullBaseCount,
    collaboration: _collaboration,
    ...stored
  } = record;
  return {
    ...stored,
    pulledCount: pullBaseCount + retainedPulledEvents,
  };
}

function replaceById<T extends { id: string }>(
  values: T[],
  value: T,
) {
  const index = values.findIndex((item) => item.id === value.id);
  if (index < 0) values.push(value);
  else values[index] = value;
}

function reconcilePulledEventDelta(
  snapshot: WishPoolLifeSnapshotStorage,
  before: readonly WishPoolEventRecord[],
) {
  const previous = pulledEventCounts(before);
  const next = pulledEventCounts(snapshot.events);
  snapshot.wishes = snapshot.wishes.map((wish) => {
    const delta = (
      (next.get(wish.id) ?? 0)
      - (previous.get(wish.id) ?? 0)
    );
    if (!delta) return wish;
    return {
      ...wish,
      pulledCount: Math.max(0, wish.pulledCount + delta),
    };
  });
}

async function upsertWish(
  input: Parameters<WishPoolLifeBusinessPort['upsertRecord']>[0],
) {
  assertWishPoolLifeRecord(input.kind, input.entityId, input.value);
  let record = input.value as WishPoolWishRecord;
  const snapshot = await loadSnapshot();
  const previous = wishPoolSnapshotRecord(snapshot, record.id);
  if (previous && (previous.collaboration || record.collaboration)) {
    record = mergeWishPoolWishRecords(previous, record, false);
  }
  const retainedPulledEvents = snapshot.events.filter(
    (event) => (
      event.type === 'pulled'
      && event.wishId === input.entityId
    ),
  ).length;
  replaceById(
    snapshot.wishes,
    wishStorageRecord(record, retainedPulledEvents),
  );
  if (record.collaboration) {
    const state = snapshot.collaboration ?? emptyWishCollaboration();
    snapshot.collaboration = readWishCollaboration({
      discussions: [...state.discussions.filter((item) => item.wishId !== record.id), ...record.collaboration.discussions],
      progressNotes: [...state.progressNotes.filter((item) => item.wishId !== record.id), ...record.collaboration.progressNotes],
      confirmations: [...state.confirmations.filter((item) => item.wishId !== record.id), ...record.collaboration.confirmations],
    }, snapshot.wishes);
    snapshot.schemaVersion = 2;
  } else if (record.status === 'candidate' || record.status === 'not-adopted' || record.castAt !== undefined) {
    snapshot.schemaVersion = 2;
    snapshot.collaboration ??= emptyWishCollaboration();
  }
  await saveSnapshot(snapshot, input.revision.createdAt);
}

async function upsertDiscussion(
  input: Parameters<WishPoolLifeBusinessPort['upsertRecord']>[0],
) {
  assertWishPoolLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as WishPoolDiscussionRecord;
  const snapshot = await loadSnapshot();
  const parentWish = snapshot.wishes.find(
    (wish) => wish.id === record.wishId,
  );
  if (!parentWish) {
    throw new Error(
      `wish-pool discussion ${record.id} 缺少先行 wish。`,
    );
  }
  if (
    parentWish.status !== 'removed'
    || parentWish.removedAt !== record.removedAt
    || parentWish.content !== record.content
  ) {
    throw new Error(
      `wish-pool discussion ${record.id} 与 removed wish 不一致。`,
    );
  }
  replaceById(snapshot.removalDiscussions, record);
  await saveSnapshot(snapshot, input.revision.createdAt);
}

async function upsertEvent(
  input: Parameters<WishPoolLifeBusinessPort['upsertRecord']>[0],
) {
  assertWishPoolLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as WishPoolEventRecord;
  const snapshot = await loadSnapshot();
  if (!snapshot.wishes.some((wish) => wish.id === record.wishId)) {
    throw new Error(`wish-pool event ${record.id} 缺少先行 wish。`);
  }
  const before = [...snapshot.events];
  replaceById(snapshot.events, record);
  snapshot.events = sortedSnapshot(snapshot).events;
  reconcilePulledEventDelta(snapshot, before);
  if (record.type === 'pulled') {
    snapshot.wishes = snapshot.wishes.map((wish) => (
      wish.id === record.wishId
        ? {
            ...wish,
            lastPulledAt: Math.max(
              wish.lastPulledAt ?? 0,
              record.occurredAt,
            ),
            redrawEligibleAt: Math.max(
              wish.redrawEligibleAt ?? 0,
              record.occurredAt + REDRAW_COOLDOWN_MS,
            ),
          }
        : wish
    ));
  }
  await saveSnapshot(snapshot, input.revision.createdAt);
}

async function upsertActionReceipt(
  input: Parameters<WishPoolLifeBusinessPort['upsertRecord']>[0],
) {
  assertWishPoolLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as WishPoolActionReceiptRecord;
  const snapshot = await loadSnapshot();
  if (!snapshot.wishes.some((wish) => wish.id === record.wishId)) {
    throw new Error(
      `wish-pool action receipt ${input.entityId} 缺少先行 wish。`,
    );
  }
  const index = snapshot.actionReceipts.findIndex(
    (receipt) => wishPoolActionReceiptEntityId(
      receipt.operation,
      receipt.sourceId,
    ) === input.entityId,
  );
  if (index < 0) snapshot.actionReceipts.push(record);
  else snapshot.actionReceipts[index] = record;
  await saveSnapshot(snapshot, input.revision.createdAt);
}

async function upsertPendingIntent(
  input: Parameters<WishPoolLifeBusinessPort['upsertRecord']>[0],
) {
  assertWishPoolLifeRecord(input.kind, input.entityId, input.value);
  const record = input.value as WishPoolPendingIntentRecord;
  const snapshot = await loadSnapshot();
  if (!snapshot.wishes.some((wish) => wish.id === record.wishId)) {
    throw new Error(
      `wish-pool pending intent 缺少先行 wish ${record.wishId}。`,
    );
  }
  await RawAsyncStorage.setItem(
    WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY,
    serializeWishPoolPendingIntentStorage(
      record,
    ),
  );
}

async function upsertRecord(
  input: Parameters<WishPoolLifeBusinessPort['upsertRecord']>[0],
) {
  if (input.entityType === 'wish' && input.kind === 'wish') {
    await upsertWish(input);
    return;
  }
  if (
    input.entityType === 'discussion'
    && input.kind === 'discussion'
  ) {
    await upsertDiscussion(input);
    return;
  }
  if (input.entityType === 'receipt' && input.kind === 'event') {
    await upsertEvent(input);
    return;
  }
  if (
    input.entityType === 'receipt'
    && input.kind === 'action-receipt'
  ) {
    await upsertActionReceipt(input);
    return;
  }
  if (
    input.entityType === 'pending-intent'
    && input.kind === 'pending-intent'
  ) {
    await upsertPendingIntent(input);
    return;
  }
  throw new Error('wish-pool.life apply entity/kind 不匹配。');
}

function tombstoneReceipt(
  snapshot: WishPoolLifeSnapshotStorage,
  entityId: string,
) {
  if (entityId.startsWith('event:')) {
    const before = [...snapshot.events];
    snapshot.events = snapshot.events.filter(
      (event) => wishPoolEventEntityId(event.id) !== entityId,
    );
    reconcilePulledEventDelta(snapshot, before);
    return;
  }
  snapshot.actionReceipts = snapshot.actionReceipts.filter(
    (receipt) => wishPoolActionReceiptEntityId(
      receipt.operation,
      receipt.sourceId,
    ) !== entityId,
  );
}

async function tombstone(
  input: Parameters<WishPoolLifeBusinessPort['tombstone']>[0],
) {
  if (input.entityType === 'pending-intent') {
    if (input.entityId !== WISH_POOL_PENDING_INTENT_ENTITY_ID) {
      throw new Error('wish-pool pending-intent tombstone id 无效。');
    }
    await RawAsyncStorage.removeItem(
      WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY,
    );
    return;
  }
  let removePendingIntent = false;
  const snapshot = await loadSnapshot();
  if (input.entityType === 'wish') {
    // No new physical delete route: an old peer cannot erase newly retained joint history.
    if (snapshot.collaboration && snapshot.wishes.some((item) => item.id === input.entityId)) {
      throw new Error('Cannot tombstone a wish with retained collaboration history.');
    }
    const pendingRaw = await RawAsyncStorage.getItem(
      WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY,
    );
    removePendingIntent = Boolean(
      pendingRaw
      && parseWishPoolPendingIntentStorage(pendingRaw).wishId
        === input.entityId,
    );
  }

  if (input.entityType === 'wish') {
    snapshot.wishes = snapshot.wishes.filter(
      (wish) => wish.id !== input.entityId,
    );
    snapshot.events = snapshot.events.filter(
      (event) => event.wishId !== input.entityId,
    );
    snapshot.removalDiscussions =
      snapshot.removalDiscussions.filter(
        (discussion) => discussion.wishId !== input.entityId,
      );
    snapshot.actionReceipts = snapshot.actionReceipts.filter(
      (receipt) => receipt.wishId !== input.entityId,
    );
  } else if (input.entityType === 'discussion') {
    snapshot.removalDiscussions =
      snapshot.removalDiscussions.filter(
        (discussion) => discussion.id !== input.entityId,
      );
  } else {
    tombstoneReceipt(snapshot, input.entityId);
  }
  await saveSnapshot(snapshot, input.deletedAt);
  if (removePendingIntent) {
    await RawAsyncStorage.removeItem(
      WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY,
    );
  }
}

export const wishPoolLifeAsyncStorageBusinessPort:
WishPoolLifeBusinessPort = {
  upsertRecord: (input) => enqueueWishPoolLifeApply(
    () => upsertRecord(input),
  ),
  tombstone: (input) => enqueueWishPoolLifeApply(
    () => tombstone(input),
  ),
};

// Called after the original incoming mutation has reached the existing revision ledger.
// Capture a real local merge revision before materializing; retry reads that same head.
export function reconcileWishPoolLifeHeads(input: {
  wishId: string;
  dataEpoch?: ReturnType<typeof captureBackupRestoreDataEpoch>;
  loadHeads: () => Promise<PlainMutationV1[]>;
  loadParents?: () => Promise<PlainMutationV1[]>;
  captureMerge: (record: WishPoolWishRecord, parents: string[]) => Promise<PlainMutationV1>;
}) {
  return enqueueWishPoolLifeApply(async () => {
    const heads = await input.loadHeads();
    const parents = await input.loadParents?.() ?? [];
    const local = wishPoolSnapshotRecord(await loadSnapshot(), input.wishId);
    const records = heads.filter((head) => head.revision.operation !== 'delete')
      .map((head) => (head.payload as { value: unknown }).value as WishPoolWishRecord);
    const parentRecords = parents.filter((parent) => parent.revision.operation !== 'delete')
      .map((parent) => (parent.payload as { value: unknown }).value as WishPoolWishRecord);
    if (!local?.collaboration && ![...records, ...parentRecords].some((record) => record.collaboration)) return false;
    if (!heads.length || heads.some((head) => head.revision.operation === 'delete')) {
      throw new Error('Cannot delete retained wish collaboration history.');
    }
    let merged = records[0];
    for (const record of records.slice(1)) merged = mergeWishPoolWishRecords(merged, record, true);
    for (const parent of parentRecords) merged = mergeWishPoolWishRecords(parent, merged, false);
    if (local) merged = mergeWishPoolWishRecords(local, merged, false);
    // Check the global one-current-discussion rule before publishing a merged revision.
    const snapshot = await loadSnapshot();
    const state = snapshot.collaboration ?? emptyWishCollaboration();
    readWishCollaboration({
      discussions: [...state.discussions.filter((item) => item.wishId !== input.wishId), ...(merged.collaboration?.discussions ?? [])],
      confirmations: [...state.confirmations.filter((item) => item.wishId !== input.wishId), ...(merged.collaboration?.confirmations ?? [])],
      progressNotes: [...state.progressNotes.filter((item) => item.wishId !== input.wishId), ...(merged.collaboration?.progressNotes ?? [])],
    }, [...snapshot.wishes.filter((item) => item.id !== input.wishId), merged]);
    const stable = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    const selected = heads.length === 1 && stable(merged) === stable(records[0])
      ? heads[0] : await input.captureMerge(merged, heads.map((head) => head.revision.id));
    await upsertWish({ entityType: 'wish', entityId: input.wishId, kind: 'wish',
      value: (selected.payload as { value: JsonValue }).value,
      revision: { revisionId: selected.revision.id, parentRevisionIds: selected.revision.parents,
        sourceDeviceId: selected.sourceDeviceId, sourceSequence: selected.sourceSequence, createdAt: selected.createdAt } });
    return true;
  }, input.dataEpoch);
}
