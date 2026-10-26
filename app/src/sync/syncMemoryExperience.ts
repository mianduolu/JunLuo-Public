import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const MEMORY_EXPERIENCE_SCHEMA_VERSION = 1 as const;
export const MEMORY_EXPERIENCE_RETENTION_CLASS = 'relationship-history' as const;
export const MEMORY_EXPERIENCE_ADAPTER_ID = 'memory.experience' as const;

export type MemoryExperienceEntityType =
  | 'dream'
  | 'interaction-fact';

export type MemoryExperienceRecordKind =
  | 'dream-state'
  | 'pending-dream'
  | 'action-suggestion-cooldown'
  | 'baiyun-heart-viewed'
  | 'post-reading'
  | 'post-notice-read';

type JsonRecord = { [key: string]: JsonValue };

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const expectedKeys = new Set(expected);
  const extra = Object.keys(value).filter((key) => !expectedKeys.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = expected.filter((key) => !(key in value));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || value.length > maximumLength
    || (!allowEmpty && !value)
  ) {
    throw new Error(`${label} 必须是长度不超过 ${maximumLength} 的字符串。`);
  }
}

function assertNullableString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value === null) return;
  assertString(value, label, maximumLength);
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertNullableTimestamp(value: unknown, label: string) {
  if (value === null) return;
  assertTimestamp(value, label);
}

function assertUnitNumber(value: unknown, label: string) {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(`${label} 必须是 0–1 的有限数字。`);
  }
}

function assertDateKey(value: unknown, label: string) {
  if (value === null) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} 必须是 YYYY-MM-DD 或 null。`);
  }
}

function assertDreamState(value: Record<string, unknown>) {
  assertExactKeys(
    value,
    ['lastAttemptDateKey', 'lastBackfillDateKey'],
    'dream-state',
  );
  assertDateKey(value.lastAttemptDateKey, 'dream-state.lastAttemptDateKey');
  assertDateKey(value.lastBackfillDateKey, 'dream-state.lastBackfillDateKey');
}

function assertPendingDream(value: Record<string, unknown>, entityId: string) {
  assertExactKeys(
    value,
    [
      'arousal',
      'content',
      'createdAt',
      'id',
      'memoryId',
      'recallCues',
      'surfacedAt',
      'valence',
    ],
    'pending-dream',
  );
  if (value.id !== entityId) {
    throw new Error('pending-dream id 必须与 entityId 一致。');
  }
  assertString(value.id, 'pending-dream.id', 160);
  assertString(value.content, 'pending-dream.content', 240);
  assertTimestamp(value.createdAt, 'pending-dream.createdAt');
  assertNullableString(value.memoryId, 'pending-dream.memoryId', 160);
  assertNullableTimestamp(value.surfacedAt, 'pending-dream.surfacedAt');
  assertUnitNumber(value.arousal, 'pending-dream.arousal');
  assertUnitNumber(value.valence, 'pending-dream.valence');
  if (
    !Array.isArray(value.recallCues)
    || value.recallCues.length > 5
    || value.recallCues.some(
      (cue) => typeof cue !== 'string' || !cue || cue.length > 18,
    )
  ) {
    throw new Error('pending-dream.recallCues 必须是最多 5 个短字符串。');
  }
}

function assertActionCooldown(value: Record<string, unknown>, entityId: string) {
  assertExactKeys(value, ['memoryId', 'at'], 'action-suggestion-cooldown');
  assertString(value.memoryId, 'action-suggestion-cooldown.memoryId', 220);
  if (entityId !== `action-suggestion:${value.memoryId}`) {
    throw new Error('action-suggestion-cooldown entityId 与 memoryId 不一致。');
  }
  assertTimestamp(value.at, 'action-suggestion-cooldown.at');
}

function assertHeartViewed(value: Record<string, unknown>, entityId: string) {
  assertExactKeys(value, ['memoryId', 'viewedAt'], 'baiyun-heart-viewed');
  if (entityId !== 'baiyun-heart-viewed') {
    throw new Error('baiyun-heart-viewed 必须使用 singleton entityId。');
  }
  assertString(value.memoryId, 'baiyun-heart-viewed.memoryId', 160);
  assertTimestamp(value.viewedAt, 'baiyun-heart-viewed.viewedAt');
}

export type PostReadingRefV1 = { source: string | null; revision: string; image?: string };
export type PostReadingRoundV1 = { source: string; postId: string; at: number; refs: PostReadingRefV1[]; added: PostReadingRefV1[] };
export type PostReadingStateV1 = { activatedAt: number; rounds: PostReadingRoundV1[] };
export type PostReadingSyncValueV1 = { activatedAt: number; rounds: (PostReadingRoundV1 & { baseline: boolean })[] };
export type PostNoticeReadSyncValueV1 = { since: number; seen: string[] };

function postRefKey(ref: PostReadingRefV1) {
  return JSON.stringify([ref.source, ref.revision, ref.image ?? null]);
}
function postRoundKey(round: PostReadingRoundV1) {
  return JSON.stringify([round.postId, round.source, round.refs.map(postRefKey).sort()]);
}
function assertPostReadingRef(value: unknown) {
  const ref = recordOf(value, 'post-reading ref');
  assertExactKeys(ref, ref.image === undefined ? ['source', 'revision'] : ['source', 'revision', 'image'], 'post-reading ref');
  if (ref.source !== null) assertString(ref.source, 'post-reading ref.source', 2048);
  assertString(ref.revision, 'post-reading ref.revision', 160);
  if (ref.image !== undefined) assertString(ref.image, 'post-reading ref.image', 160);
}
export function assertPostReadingSyncValueV1(value: unknown): asserts value is PostReadingSyncValueV1 {
  const state = recordOf(value, 'post-reading');
  assertExactKeys(state, ['activatedAt', 'rounds'], 'post-reading');
  assertTimestamp(state.activatedAt, 'post-reading activatedAt');
  if (!Array.isArray(state.rounds)) throw new Error('post-reading rounds 必须是数组。');
  for (const value of state.rounds) {
    const round = recordOf(value, 'post-reading round');
    assertExactKeys(round, ['source', 'postId', 'at', 'refs', 'added', 'baseline'], 'post-reading round');
    assertString(round.source, 'post-reading source', 2048);
    assertString(round.postId, 'post-reading postId', 256);
    assertTimestamp(round.at, 'post-reading at');
    if (typeof round.baseline !== 'boolean' || !Array.isArray(round.refs) || !Array.isArray(round.added)) throw new Error('post-reading round 字段无效。');
    round.refs.forEach(assertPostReadingRef); round.added.forEach(assertPostReadingRef);
    const refs = new Set((round.refs as PostReadingRefV1[]).map(postRefKey));
    if ((round.added as PostReadingRefV1[]).some(ref => !refs.has(postRefKey(ref)))) throw new Error('post-reading added 必须来自实际 refs。');
  }
}
export function projectPostReadingSyncValueV1(value: unknown): PostReadingSyncValueV1 | null {
  if (value === undefined || value === null) return null;
  const state = recordOf(value, 'post-reading state');
  if (!Array.isArray(state.rounds)) throw new Error('post-reading state rounds 无效。');
  const result = { activatedAt: state.activatedAt, rounds: state.rounds.map(value => {
    const round = recordOf(value, 'post-reading state round');
    return { source: round.source, postId: round.postId, at: round.at, refs: round.refs, added: round.added,
      baseline: Number(round.at) <= Number(state.activatedAt) };
  }) };
  assertPostReadingSyncValueV1(result); return result;
}
export function materializePostReadingSyncValueV1(value: PostReadingSyncValueV1): PostReadingStateV1 {
  assertPostReadingSyncValueV1(value);
  return { activatedAt: value.activatedAt, rounds: value.rounds.map(({ baseline, ...round }) => ({
    ...round, at: baseline ? Math.max(0, value.activatedAt - 1) : round.at,
    refs: round.refs.map(ref => ({ ...ref })), added: round.added.map(ref => ({ ...ref })),
  })) };
}
export function mergePostReadingSyncValuesV1(left: PostReadingSyncValueV1 | null, right: PostReadingSyncValueV1): PostReadingSyncValueV1 {
  assertPostReadingSyncValueV1(right); if (left) assertPostReadingSyncValueV1(left);
  const activatedAt = left ? Math.min(left.activatedAt, right.activatedAt) : right.activatedAt;
  const rounds = new Map<string, PostReadingSyncValueV1['rounds'][number]>();
  for (const round of [...(left?.rounds ?? []), ...right.rounds]) {
    const key = postRoundKey(round), previous = rounds.get(key);
    // A real receipt outranks transitional inference. Keep one entire original
    // receipt; refs/added are evidence and are never expanded by the merger.
    if (!previous || previous.baseline && !round.baseline
      || previous.baseline === round.baseline && (round.at < previous.at
        || round.at === previous.at && JSON.stringify(round).localeCompare(JSON.stringify(previous)) < 0)) rounds.set(key, round);
  }
  return { activatedAt, rounds: [...rounds.values()].sort((a, b) => a.at - b.at || postRoundKey(a).localeCompare(postRoundKey(b))) };
}
export function assertPostNoticeReadSyncValueV1(value: unknown): asserts value is PostNoticeReadSyncValueV1 {
  const state = recordOf(value, 'post-notice-read');
  assertExactKeys(state, ['since', 'seen'], 'post-notice-read'); assertTimestamp(state.since, 'post-notice-read since');
  if (!Array.isArray(state.seen)) throw new Error('post-notice-read seen 必须是数组。');
  for (const key of state.seen) {
    if (typeof key !== 'string') throw new Error('post-notice-read key 无效。');
    let parts: unknown; try { parts = JSON.parse(key); } catch { throw new Error('post-notice-read key 无效。'); }
    if (!Array.isArray(parts) || parts.length !== 2 || JSON.stringify(parts) !== key) throw new Error('post-notice-read key 无效。');
    assertString(parts[0], 'post-notice-read postId', 256);
    if (parts[1] !== null) assertString(parts[1], 'post-notice-read commentSource', 2048);
  }
}
export function mergePostNoticeReadSyncValuesV1(left: PostNoticeReadSyncValueV1 | null, right: PostNoticeReadSyncValueV1): PostNoticeReadSyncValueV1 {
  assertPostNoticeReadSyncValueV1(right); if (left) assertPostNoticeReadSyncValueV1(left);
  return { since: left ? Math.min(left.since, right.since) : right.since, seen: [...new Set([...(left?.seen ?? []), ...right.seen])].sort() };
}

function assertPostReading(value: Record<string, unknown>, entityId: string) {
  if (entityId !== 'post-reading') throw new Error('post-reading 必须使用 singleton entityId。');
  assertPostReadingSyncValueV1(value);
}
function assertPostNoticeRead(value: Record<string, unknown>, entityId: string) {
  if (entityId !== 'post-notice-read') throw new Error('post-notice-read 必须使用 singleton entityId。');
  assertPostNoticeReadSyncValueV1(value);
}

function assertKindMatchesEntity(
  entityType: string,
  kind: MemoryExperienceRecordKind,
) {
  if (
    (entityType === 'dream'
      && (kind === 'dream-state' || kind === 'pending-dream'))
    || (
      entityType === 'interaction-fact'
      && (
        kind === 'action-suggestion-cooldown'
        || kind === 'baiyun-heart-viewed'
        || kind === 'post-reading'
        || kind === 'post-notice-read'
      )
    )
  ) return;
  throw new Error('memory.experience kind 与 entity type 不匹配。');
}

export function assertMemoryExperienceRecord(
  kind: MemoryExperienceRecordKind,
  entityId: string,
  value: unknown,
): asserts value is JsonRecord {
  const record = recordOf(value, `memory.experience ${kind}`);
  switch (kind) {
    case 'dream-state':
      assertDreamState(record);
      break;
    case 'pending-dream':
      assertPendingDream(record, entityId);
      break;
    case 'action-suggestion-cooldown':
      assertActionCooldown(record, entityId);
      break;
    case 'baiyun-heart-viewed':
      assertHeartViewed(record, entityId);
      break;
    case 'post-reading':
      assertPostReading(record, entityId);
      break;
    case 'post-notice-read':
      assertPostNoticeRead(record, entityId);
      break;
  }
  assertJsonValue(record);
}

export function assertMemoryExperienceMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'memory'
    || (value.entity.type !== 'dream' && value.entity.type !== 'interaction-fact')
  ) {
    throw new Error('memory.experience mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== MEMORY_EXPERIENCE_SCHEMA_VERSION) {
    throw new Error('memory.experience schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('memory.experience sensitivity 必须为 high。');
  }
  if (value.retentionClass !== MEMORY_EXPERIENCE_RETENTION_CLASS) {
    throw new Error('memory.experience retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('memory.experience 不接受对象引用。');
  }
  const payload = recordOf(value.payload, 'memory.experience payload');
  if (value.revision.operation === 'delete') {
    assertExactKeys(payload, ['schemaVersion', 'deletedAt'], 'memory.experience delete');
    if (payload.schemaVersion !== MEMORY_EXPERIENCE_SCHEMA_VERSION) {
      throw new Error('memory.experience delete schemaVersion 无效。');
    }
    assertTimestamp(payload.deletedAt, 'memory.experience deletedAt');
    return;
  }
  if (value.revision.operation !== 'upsert' && value.revision.operation !== 'restore') {
    throw new Error('memory.experience 只允许 upsert、restore 或 delete。');
  }
  assertExactKeys(payload, ['schemaVersion', 'kind', 'value'], 'memory.experience record');
  if (payload.schemaVersion !== MEMORY_EXPERIENCE_SCHEMA_VERSION) {
    throw new Error('memory.experience payload schemaVersion 无效。');
  }
  const kind = payload.kind as MemoryExperienceRecordKind;
  if (
    kind !== 'dream-state'
    && kind !== 'pending-dream'
    && kind !== 'action-suggestion-cooldown'
    && kind !== 'baiyun-heart-viewed'
    && kind !== 'post-reading'
    && kind !== 'post-notice-read'
  ) {
    throw new Error('memory.experience record kind 无效。');
  }
  assertKindMatchesEntity(value.entity.type, kind);
  assertMemoryExperienceRecord(kind, value.entity.id, payload.value);
}

export function buildMemoryExperienceRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: MemoryExperienceEntityType;
  entityId: string;
  kind: MemoryExperienceRecordKind;
  value: JsonValue;
  operation?: 'upsert' | 'restore';
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'memory',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation ?? 'upsert',
      schemaVersion: MEMORY_EXPERIENCE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: MEMORY_EXPERIENCE_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: MEMORY_EXPERIENCE_RETENTION_CLASS,
  };
  assertMemoryExperienceMutationV1(mutation);
  return mutation;
}

export function buildMemoryExperienceDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: MemoryExperienceEntityType;
  entityId: string;
  deletedAt: number;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'memory',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: 'delete',
      schemaVersion: MEMORY_EXPERIENCE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: MEMORY_EXPERIENCE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: MEMORY_EXPERIENCE_RETENTION_CLASS,
  };
  assertMemoryExperienceMutationV1(mutation);
  return mutation;
}
