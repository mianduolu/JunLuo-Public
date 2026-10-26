import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  WISH_POOL_DISCUSSION_STATUSES,
  WISH_POOL_EVENT_TYPES,
  WISH_POOL_ORIGINS,
  WISH_POOL_OWNERS,
  WISH_POOL_PENDING_INTENT_ENTITY_ID,
  WISH_POOL_RECEIPT_OPERATIONS,
  WISH_POOL_STATUSES,
  WISH_POOL_EVIDENCE_KINDS,
  assertWishPoolLifeRecord,
  assertWishPoolLifeRecordVersion,
  buildWishPoolLifeDeleteMutation,
  buildWishPoolLifeRecordMutation,
  wishPoolActionReceiptEntityId,
  wishPoolEventEntityId,
  type WishPoolActionReceiptRecord,
  type WishPoolCompletionEvidenceRecord,
  type WishPoolDiscussionRecord,
  type WishPoolDiscussionStatus,
  type WishPoolEventRecord,
  type WishPoolEventType,
  type WishPoolLifeEntityType,
  type WishPoolLifeRecordKind,
  type WishPoolOrigin,
  type WishPoolOwner,
  type WishPoolPendingIntentRecord,
  type WishPoolReceiptOperation,
  type WishPoolStatus,
  type WishPoolWishRecord,
} from './syncWishPoolLife';
import {
  assertJsonValue,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';
import { readWishCollaboration, type WishCollaborationState } from '../wishPool/wishPoolDiscussionState';

export const WISH_POOL_LIFE_STORAGE_KEY =
  'junluo.wishPool.v1' as const;
export const WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY =
  'junluo.wishPool.pendingChatHandoff.v1' as const;
export const WISH_POOL_LIFE_GLOBAL_KEYS = Object.freeze([
  WISH_POOL_LIFE_STORAGE_KEY,
  WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY,
] as const);

export type WishPoolLifeStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type WishPoolLifeStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type WishPoolLifeEnvelopeFactory = (
  entity: {
    domain: 'wish-pool';
    type: WishPoolLifeEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type WishPoolLifeWishStorage =
  Omit<WishPoolWishRecord, 'pullBaseCount' | 'collaboration'> & {
    pulledCount: number;
  };

export type WishPoolLifeSnapshotStorage = {
  schemaVersion: 1 | 2;
  collaboration?: WishCollaborationState;
  wishes: WishPoolLifeWishStorage[];
  events: WishPoolEventRecord[];
  removalDiscussions: WishPoolDiscussionRecord[];
  actionReceipts: WishPoolActionReceiptRecord[];
  updatedAt: number;
};

const SNAPSHOT_FIELDS = new Set([
  'collaboration',
  'schemaVersion',
  'wishes',
  'events',
  'removalDiscussions',
  'actionReceipts',
  'updatedAt',
]);

const WISH_STORAGE_FIELDS = new Set([
  'castAt',
  'id',
  'owner',
  'content',
  'status',
  'origin',
  'sourceMessageId',
  'legacyBookshelfItemId',
  'legacyProjectId',
  'pulledCount',
  'lastPulledAt',
  'redrawEligibleAt',
  'startedAt',
  'deferredAt',
  'fulfilledAt',
  'releasedAt',
  'removedAt',
  'removedBy',
  'completionEvidence',
  'createdAt',
  'updatedAt',
]);
const EVENT_STORAGE_FIELDS = new Set([
  'id',
  'type',
  'wishId',
  'actor',
  'sourceId',
  'evidence',
  'occurredAt',
]);
const DISCUSSION_STORAGE_FIELDS = new Set([
  'id',
  'wishId',
  'content',
  'removedAt',
  'status',
  'questionMessageId',
  'questionPersistedAt',
  'discussionReplyMessageId',
  'discussedAt',
  'createdAt',
  'updatedAt',
]);
const ACTION_RECEIPT_STORAGE_FIELDS = new Set([
  'operation',
  'sourceId',
  'wishId',
  'occurredAt',
]);

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function parseJson(raw: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  assertJsonValue(parsed);
  return parsed;
}

function assertNoExtraFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
) {
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(
      `${label} 包含未允许字段：${extra.sort().join(', ')}。`,
    );
  }
}

function requiredString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 字符串长度无效。`);
  }
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  return value === undefined
    ? undefined
    : requiredString(value, label, maximumLength);
}

function requiredTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
  return Number(value);
}

function optionalTimestamp(value: unknown, label: string) {
  return value === undefined
    ? undefined
    : requiredTimestamp(value, label);
}

function requiredEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
) {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${label} 无效。`);
  }
  return value as T;
}

function parseEvidence(
  value: unknown,
  label: string,
): WishPoolCompletionEvidenceRecord | undefined {
  if (value === undefined) return undefined;
  const candidate = recordOf(value, label);
  assertNoExtraFields(
    candidate,
    new Set(['kind', 'sourceId', 'occurredAt']),
    label,
  );
  return {
    kind: requiredEnum(
      candidate.kind,
      WISH_POOL_EVIDENCE_KINDS,
      `${label}.kind`,
    ),
    sourceId: requiredString(
      candidate.sourceId,
      `${label}.sourceId`,
      200,
    ),
    occurredAt: requiredTimestamp(
      candidate.occurredAt,
      `${label}.occurredAt`,
    ),
  };
}

function parseWish(value: unknown, index: number): WishPoolLifeWishStorage {
  const label = `wishPool.wishes[${index}]`;
  const candidate = recordOf(value, label);
  assertNoExtraFields(candidate, WISH_STORAGE_FIELDS, label);
  const record: WishPoolLifeWishStorage = {
    id: requiredString(candidate.id, `${label}.id`, 200),
    owner: requiredEnum(
      candidate.owner,
      WISH_POOL_OWNERS,
      `${label}.owner`,
    ),
    content: requiredString(
      candidate.content,
      `${label}.content`,
      640,
    ),
    status: requiredEnum(
      candidate.status,
      WISH_POOL_STATUSES,
      `${label}.status`,
    ),
    origin: requiredEnum(
      candidate.origin,
      WISH_POOL_ORIGINS,
      `${label}.origin`,
    ),
    pulledCount: Number(candidate.pulledCount),
    createdAt: requiredTimestamp(
      candidate.createdAt,
      `${label}.createdAt`,
    ),
    updatedAt: requiredTimestamp(
      candidate.updatedAt,
      `${label}.updatedAt`,
    ),
  };
  const optionalIds = [
    'sourceMessageId',
    'legacyBookshelfItemId',
    'legacyProjectId',
  ] as const;
  for (const field of optionalIds) {
    const item = optionalString(
      candidate[field],
      `${label}.${field}`,
      200,
    );
    if (item !== undefined) record[field] = item;
  }
  if (
    typeof candidate.pulledCount !== 'number'
    || !Number.isSafeInteger(record.pulledCount)
    || record.pulledCount < 0
  ) {
    throw new Error(`${label}.pulledCount 无效。`);
  }
  const timestampFields = [
    'castAt',
    'lastPulledAt',
    'redrawEligibleAt',
    'startedAt',
    'deferredAt',
    'fulfilledAt',
    'releasedAt',
    'removedAt',
  ] as const;
  for (const field of timestampFields) {
    const item = optionalTimestamp(
      candidate[field],
      `${label}.${field}`,
    );
    if (item !== undefined) record[field] = item;
  }
  if (candidate.removedBy !== undefined) {
    record.removedBy = requiredEnum(
      candidate.removedBy,
      WISH_POOL_OWNERS,
      `${label}.removedBy`,
    );
  }
  const evidence = parseEvidence(
    candidate.completionEvidence,
    `${label}.completionEvidence`,
  );
  if (evidence) record.completionEvidence = evidence;
  if (Array.from(record.content).length > 160) {
    throw new Error(`${label}.content 超出 160 个字符。`);
  }
  return record;
}

function parseEvent(
  value: unknown,
  index: number,
): WishPoolEventRecord {
  const label = `wishPool.events[${index}]`;
  const candidate = recordOf(value, label);
  assertNoExtraFields(candidate, EVENT_STORAGE_FIELDS, label);
  const record: WishPoolEventRecord = {
    id: requiredString(candidate.id, `${label}.id`, 200),
    type: requiredEnum(
      candidate.type,
      WISH_POOL_EVENT_TYPES,
      `${label}.type`,
    ),
    wishId: requiredString(
      candidate.wishId,
      `${label}.wishId`,
      200,
    ),
    occurredAt: requiredTimestamp(
      candidate.occurredAt,
      `${label}.occurredAt`,
    ),
  };
  if (candidate.actor !== undefined) {
    record.actor = requiredEnum(
      candidate.actor,
      WISH_POOL_OWNERS,
      `${label}.actor`,
    );
  }
  const sourceId = optionalString(
    candidate.sourceId,
    `${label}.sourceId`,
    200,
  );
  if (sourceId !== undefined) record.sourceId = sourceId;
  const evidence = parseEvidence(
    candidate.evidence,
    `${label}.evidence`,
  );
  if (evidence) record.evidence = evidence;
  assertWishPoolLifeRecord(
    'event',
    wishPoolEventEntityId(record.id),
    record,
  );
  return record;
}

function parseDiscussion(
  value: unknown,
  index: number,
): WishPoolDiscussionRecord {
  const label = `wishPool.removalDiscussions[${index}]`;
  const candidate = recordOf(value, label);
  assertNoExtraFields(candidate, DISCUSSION_STORAGE_FIELDS, label);
  const record: WishPoolDiscussionRecord = {
    id: requiredString(candidate.id, `${label}.id`, 200),
    wishId: requiredString(
      candidate.wishId,
      `${label}.wishId`,
      200,
    ),
    content: requiredString(
      candidate.content,
      `${label}.content`,
      640,
    ),
    removedAt: requiredTimestamp(
      candidate.removedAt,
      `${label}.removedAt`,
    ),
    status: requiredEnum(
      candidate.status,
      WISH_POOL_DISCUSSION_STATUSES,
      `${label}.status`,
    ),
    createdAt: requiredTimestamp(
      candidate.createdAt,
      `${label}.createdAt`,
    ),
    updatedAt: requiredTimestamp(
      candidate.updatedAt,
      `${label}.updatedAt`,
    ),
  };
  for (const field of [
    'questionMessageId',
    'discussionReplyMessageId',
  ] as const) {
    const item = optionalString(
      candidate[field],
      `${label}.${field}`,
      200,
    );
    if (item !== undefined) record[field] = item;
  }
  for (const field of [
    'questionPersistedAt',
    'discussedAt',
  ] as const) {
    const item = optionalTimestamp(
      candidate[field],
      `${label}.${field}`,
    );
    if (item !== undefined) record[field] = item;
  }
  if (Array.from(record.content).length > 160) {
    throw new Error(`${label}.content 超出 160 个字符。`);
  }
  assertWishPoolLifeRecord('discussion', record.id, record);
  return record;
}

function parseActionReceipt(
  value: unknown,
  index: number,
): WishPoolActionReceiptRecord {
  const label = `wishPool.actionReceipts[${index}]`;
  const candidate = recordOf(value, label);
  assertNoExtraFields(candidate, ACTION_RECEIPT_STORAGE_FIELDS, label);
  const record: WishPoolActionReceiptRecord = {
    operation: requiredEnum(
      candidate.operation,
      WISH_POOL_RECEIPT_OPERATIONS,
      `${label}.operation`,
    ),
    sourceId: requiredString(
      candidate.sourceId,
      `${label}.sourceId`,
      200,
    ),
    wishId: requiredString(
      candidate.wishId,
      `${label}.wishId`,
      200,
    ),
    occurredAt: requiredTimestamp(
      candidate.occurredAt,
      `${label}.occurredAt`,
    ),
  };
  assertWishPoolLifeRecord(
    'action-receipt',
    wishPoolActionReceiptEntityId(
      record.operation,
      record.sourceId,
    ),
    record,
  );
  return record;
}

function uniqueById<T>(
  values: readonly T[],
  identity: (value: T) => string,
  label: string,
) {
  const ids = new Set<string>();
  for (const value of values) {
    const id = identity(value);
    if (ids.has(id)) throw new Error(`${label} 包含重复 id：${id}。`);
    ids.add(id);
  }
}

export function emptyWishPoolLifeSnapshotStorage():
WishPoolLifeSnapshotStorage {
  return {
    schemaVersion: 1,
    wishes: [],
    events: [],
    removalDiscussions: [],
    actionReceipts: [],
    updatedAt: 0,
  };
}

export function parseWishPoolLifeSnapshotStorage(
  raw: string,
  label = 'wish-pool.life snapshot',
): WishPoolLifeSnapshotStorage {
  const candidate = recordOf(parseJson(raw, label), label);
  assertNoExtraFields(candidate, SNAPSHOT_FIELDS, label);
  if (candidate.schemaVersion !== 1 && candidate.schemaVersion !== 2) {
    throw new Error(`${label}.schemaVersion 无效。`);
  }
  for (const field of [
    'wishes',
    'events',
    'removalDiscussions',
    'actionReceipts',
  ]) {
    if (!Array.isArray(candidate[field])) {
      throw new Error(`${label}.${field} 必须是数组。`);
    }
  }
  if ((candidate.wishes as unknown[]).length > 10000) {
    throw new Error(`${label}.wishes 超出上限。`);
  }
  if ((candidate.events as unknown[]).length > 200) {
    throw new Error(`${label}.events 超出上限。`);
  }
  if (
    (candidate.removalDiscussions as unknown[]).length > 10000
    || (candidate.actionReceipts as unknown[]).length > 50000
  ) {
    throw new Error(`${label} 讨论或回执超出上限。`);
  }
  const wishes = (candidate.wishes as unknown[]).map(parseWish);
  const events = (candidate.events as unknown[]).map(parseEvent);
  const removalDiscussions = (
    candidate.removalDiscussions as unknown[]
  ).map(parseDiscussion);
  const actionReceipts = (
    candidate.actionReceipts as unknown[]
  ).map(parseActionReceipt);
  const collaboration = candidate.schemaVersion === 2 ? readWishCollaboration(candidate.collaboration, wishes) : undefined;
  if (candidate.schemaVersion === 1 && candidate.collaboration !== undefined) throw new Error('v1 snapshot cannot contain collaboration.');
  for (const wish of wishes) assertWishPoolLifeRecordVersion('wish', wish, candidate.schemaVersion);
  for (const event of events) assertWishPoolLifeRecordVersion('event', event, candidate.schemaVersion);
  for (const receipt of actionReceipts) assertWishPoolLifeRecordVersion('action-receipt', receipt, candidate.schemaVersion);
  uniqueById(wishes, (wish) => wish.id, `${label}.wishes`);
  uniqueById(events, (event) => event.id, `${label}.events`);
  uniqueById(
    removalDiscussions,
    (discussion) => discussion.id,
    `${label}.removalDiscussions`,
  );
  uniqueById(
    actionReceipts,
    (receipt) => wishPoolActionReceiptEntityId(
      receipt.operation,
      receipt.sourceId,
    ),
    `${label}.actionReceipts`,
  );
  return {
    schemaVersion: candidate.schemaVersion,
    ...(collaboration ? { collaboration } : {}),
    wishes,
    events,
    removalDiscussions,
    actionReceipts,
    updatedAt: requiredTimestamp(
      candidate.updatedAt,
      `${label}.updatedAt`,
    ),
  };
}

export function serializeWishPoolLifeSnapshotStorage(
  snapshot: WishPoolLifeSnapshotStorage,
) {
  return JSON.stringify(snapshot);
}

export function parseWishPoolPendingIntentStorage(
  raw: string,
  label = 'wish-pool.life pending intent',
): WishPoolPendingIntentRecord {
  const candidate = recordOf(parseJson(raw, label), label);
  assertNoExtraFields(
    candidate,
    new Set([
      'wishId',
      'owner',
      'content',
      'status',
      'createdAt',
    ]),
    label,
  );
  const record: WishPoolPendingIntentRecord = {
    wishId: requiredString(candidate.wishId, `${label}.wishId`, 200),
    owner: requiredEnum(
      candidate.owner,
      WISH_POOL_OWNERS,
      `${label}.owner`,
    ),
    content: requiredString(
      candidate.content,
      `${label}.content`,
      640,
    ),
    status: requiredEnum(
      candidate.status,
      WISH_POOL_STATUSES,
      `${label}.status`,
    ),
    createdAt: requiredTimestamp(
      candidate.createdAt,
      `${label}.createdAt`,
    ),
  };
  if (Array.from(record.content).length > 160) {
    throw new Error(`${label}.content 超出 160 个字符。`);
  }
  assertWishPoolLifeRecord(
    'pending-intent',
    WISH_POOL_PENDING_INTENT_ENTITY_ID,
    record,
  );
  return record;
}

export function serializeWishPoolPendingIntentStorage(
  intent: WishPoolPendingIntentRecord,
) {
  return JSON.stringify(intent);
}

type DerivedRecord = {
  kind: WishPoolLifeRecordKind;
  value: JsonValue;
};

type RecordMaps = Record<
  WishPoolLifeEntityType,
  Map<string, DerivedRecord>
>;

function emptyRecordMaps(): RecordMaps {
  return {
    wish: new Map(),
    discussion: new Map(),
    receipt: new Map(),
    'pending-intent': new Map(),
  };
}

export function wishPoolSnapshotRecord(snapshot: WishPoolLifeSnapshotStorage, wishId: string): WishPoolWishRecord | undefined {
  const wish = snapshot.wishes.find((item) => item.id === wishId);
  if (!wish) return undefined;
  const shared = sharedWishRecord(wish, snapshot.events.filter((item) => item.type === 'pulled' && item.wishId === wishId).length);
  if (snapshot.collaboration) shared.collaboration = {
    discussions: snapshot.collaboration.discussions.filter((item) => item.wishId === wishId),
    progressNotes: snapshot.collaboration.progressNotes.filter((item) => item.wishId === wishId),
    confirmations: snapshot.collaboration.confirmations.filter((item) => item.wishId === wishId),
  };
  return shared;
}

function sharedWishRecord(
  wish: WishPoolLifeWishStorage,
  pulledEventCount: number,
): WishPoolWishRecord {
  const {
    pulledCount,
    ...shared
  } = wish;
  return {
    ...shared,
    pullBaseCount: Math.max(0, pulledCount - pulledEventCount),
  };
}

function recordsFromRaw(key: string, raw: string | null) {
  const records = emptyRecordMaps();
  if (raw === null) return records;
  if (key === WISH_POOL_LIFE_STORAGE_KEY) {
    const snapshot = parseWishPoolLifeSnapshotStorage(raw);
    const pulledEventCounts = new Map<string, number>();
    for (const event of snapshot.events) {
      if (event.type !== 'pulled') continue;
      pulledEventCounts.set(
        event.wishId,
        (pulledEventCounts.get(event.wishId) ?? 0) + 1,
      );
    }
    for (const wish of snapshot.wishes) {
      const shared = sharedWishRecord(
        wish,
        pulledEventCounts.get(wish.id) ?? 0,
      );
      if (snapshot.collaboration) {
        shared.collaboration = {
          discussions: snapshot.collaboration.discussions.filter((item) => item.wishId === wish.id),
          progressNotes: snapshot.collaboration.progressNotes.filter((item) => item.wishId === wish.id),
          confirmations: snapshot.collaboration.confirmations.filter((item) => item.wishId === wish.id),
        };
      }
      records.wish.set(wish.id, {
        kind: 'wish',
        value: shared as unknown as JsonValue,
      });
    }
    for (const discussion of snapshot.removalDiscussions) {
      records.discussion.set(discussion.id, {
        kind: 'discussion',
        value: discussion as unknown as JsonValue,
      });
    }
    for (const event of snapshot.events) {
      records.receipt.set(wishPoolEventEntityId(event.id), {
        kind: 'event',
        value: event as unknown as JsonValue,
      });
    }
    for (const receipt of snapshot.actionReceipts) {
      records.receipt.set(
        wishPoolActionReceiptEntityId(
          receipt.operation,
          receipt.sourceId,
        ),
        {
          kind: 'action-receipt',
          value: receipt as unknown as JsonValue,
        },
      );
    }
    return records;
  }
  if (key === WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY) {
    records['pending-intent'].set(
      WISH_POOL_PENDING_INTENT_ENTITY_ID,
      {
        kind: 'pending-intent',
        value: (
          parseWishPoolPendingIntentStorage(raw) as unknown as JsonValue
        ),
      },
    );
  }
  return records;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

const ENTITY_ORDER: readonly WishPoolLifeEntityType[] = [
  'wish',
  'discussion',
  'receipt',
  'pending-intent',
];

export function isWishPoolLifeGlobalStorageKey(key: string) {
  return (
    key === WISH_POOL_LIFE_STORAGE_KEY
    || key === WISH_POOL_LIFE_PENDING_CHAT_HANDOFF_KEY
  );
}

export async function deriveWishPoolLifeMutationsForStorageChanges(
  input: {
    changes: readonly WishPoolLifeStorageChange[];
    reader: WishPoolLifeStorageReadPort;
    capturedAt: number;
    envelopeFactory: WishPoolLifeEnvelopeFactory;
  },
) {
  requiredTimestamp(input.capturedAt, 'wish-pool.life capture time');
  const seenKeys = new Set<string>();
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (seenKeys.has(change.key)) {
      throw new Error(
        `wish-pool.life 同批重复变更 key：${change.key}。`,
      );
    }
    seenKeys.add(change.key);
    if (!isWishPoolLifeGlobalStorageKey(change.key)) continue;
    const previous = recordsFromRaw(
      change.key,
      await input.reader.getItem(change.key),
    );
    const next = recordsFromRaw(
      change.key,
      change.kind === 'set' ? change.value : null,
    );
    for (const entityType of ENTITY_ORDER) {
      const beforeMap = previous[entityType];
      const afterMap = next[entityType];
      const entityIds = [...new Set([
        ...beforeMap.keys(),
        ...afterMap.keys(),
      ])].sort();
      for (const entityId of entityIds) {
        const before = beforeMap.get(entityId);
        const after = afterMap.get(entityId);
        if (sameJson(before, after)) continue;
        const envelope = await input.envelopeFactory({
          domain: 'wish-pool',
          type: entityType,
          id: entityId,
        });
        if (!after) {
          mutations.push(buildWishPoolLifeDeleteMutation({
            envelope,
            entityType,
            entityId,
            deletedAt: input.capturedAt,
          }));
          continue;
        }
        assertWishPoolLifeRecord(
          after.kind,
          entityId,
          after.value,
        );
        mutations.push(buildWishPoolLifeRecordMutation({
          envelope,
          entityType,
          entityId,
          kind: after.kind,
          value: after.value,
        }));
      }
    }
  }
  return mutations;
}
