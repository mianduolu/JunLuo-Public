import type { ChatCoreMutationEnvelope } from './syncChatCore';
import { assertTheaterStoryRecord, isTheaterStoryRecordKind, THEATER_STORY_RECORD_KINDS, type TheaterStoryRecordKind } from './syncTheaterStoryRecord';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const THEATER_ISOLATED_ADAPTER_ID =
  'theater.isolated' as const;
export const THEATER_ISOLATED_SCHEMA_VERSION = 1 as const;
export const THEATER_ISOLATED_RETENTION_CLASS =
  'theater-isolated' as const;
export const THEATER_ISOLATED_ENTITY_TYPE =
  'theater-record' as const;

export type TheaterIsolatedRecordKind =
  | TheaterStoryRecordKind
  | 'persona'
  | 'conversation'
  | 'message'
  | 'legacy-context-note';

export type TheaterPersonaRecord = {
  id: string;
  name: string;
  persona: string;
  temperature: number;
  contextLimit: number;
  createdAt: number;
  updatedAt: number;
};

export type TheaterConversationRecord = {
  id: string;
  title: string;
  personaId: string | null;
  personaSnapshot: string;
  storyState: string;
  summaryInterval: number | null;
  lastSummarizedMessageCount: number;
  createdAt: number;
  updatedAt: number;
};

export type TheaterMessageRecord = {
  id: string;
  conversationId: string;
  role: 'I' | 'you';
  content: string;
  createdAt: number;
  updatedAt: number;
};

export type TheaterLegacyContextNoteRecord = {
  id: string;
  conversationId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
};

export type TheaterIsolatedRecord =
  | ({ id: string } & Record<string, JsonValue>)
  | TheaterPersonaRecord
  | TheaterConversationRecord
  | TheaterMessageRecord
  | TheaterLegacyContextNoteRecord;

export type TheaterIsolatedPayloadV1 =
  | {
      schemaVersion: 1 | 2;
      kind: TheaterIsolatedRecordKind;
      record: TheaterIsolatedRecord;
    }
  | {
      schemaVersion: 1 | 2;
      kind: TheaterIsolatedRecordKind;
      deletedAt: number;
    };

type UnknownRecord = Record<string, unknown>;

const RECORD_KINDS = new Set<TheaterIsolatedRecordKind>([
  ...THEATER_STORY_RECORD_KINDS,
  'persona',
  'conversation',
  'message',
  'legacy-context-note',
]);

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function assertExactKeys(
  record: UnknownRecord,
  keys: readonly string[],
  label: string,
) {
  const expected = new Set(keys);
  const extras = Object.keys(record).filter(
    (key) => !expected.has(key),
  );
  const missing = keys.filter((key) => !(key in record));
  if (extras.length || missing.length) {
    throw new Error(
      `${label} 字段无效`
      + `${extras.length ? `，多余：${extras.sort().join(', ')}` : ''}`
      + `${missing.length ? `，缺少：${missing.join(', ')}` : ''}。`,
    );
  }
}

function assertString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): asserts value is string {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > maximum
    || value.includes('\0')
  ) {
    throw new Error(`${label} 必须是有效且不超过 ${maximum} 字符的文本。`);
  }
}

function assertLocalId(value: unknown, label: string): asserts value is string {
  assertString(value, label, 200);
  if (/[\r\n]/u.test(value)) {
    throw new Error(`${label} 不能包含换行。`);
  }
}

function assertTimestamp(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    !Number.isSafeInteger(value)
    || (value as number) < minimum
    || (value as number) > maximum
  ) {
    throw new Error(`${label} 必须是 ${minimum}–${maximum} 的整数。`);
  }
}

function assertFiniteNumber(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): asserts value is number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < minimum
    || value > maximum
  ) {
    throw new Error(`${label} 必须是 ${minimum}–${maximum} 的有限数值。`);
  }
}

function assertNullableId(value: unknown, label: string) {
  if (value === null) return;
  assertLocalId(value, label);
}

function assertRecordIdentity(
  kind: TheaterIsolatedRecordKind,
  entityId: string,
  localId: string,
) {
  const expected = theaterIsolatedEntityId(kind, localId);
  if (entityId !== expected) {
    throw new Error(
      `theater.isolated ${kind} entity id 与 record id 不一致。`,
    );
  }
}

export function isTheaterIsolatedRecordKind(
  value: unknown,
): value is TheaterIsolatedRecordKind {
  return (
    typeof value === 'string'
    && RECORD_KINDS.has(value as TheaterIsolatedRecordKind)
  );
}

export function theaterIsolatedEntityId(
  kind: TheaterIsolatedRecordKind,
  localId: string,
) {
  if (isTheaterStoryRecordKind(kind)) {
    assertString(localId, `theater ${kind} local id`, 240);
    if (/[\r\n]/u.test(localId)) throw new Error('theater local id 不能包含换行。');
    return `${kind}:${localId}`;
  }
  assertLocalId(localId, `theater ${kind} local id`);
  const prefix = kind === 'persona'
    ? 'persona:'
    : kind === 'conversation'
      ? 'conversation:'
      : kind === 'message'
        ? 'message:'
        : 'context-note:';
  return `${prefix}${localId}`;
}

export function theaterIsolatedKindFromEntityId(
  entityId: string,
): TheaterIsolatedRecordKind {
  assertString(entityId, 'theater entity id', 256);
  for (const kind of THEATER_STORY_RECORD_KINDS) if (entityId.startsWith(`${kind}:`)) return kind;
  if (entityId.startsWith('persona:')) return 'persona';
  if (entityId.startsWith('conversation:')) return 'conversation';
  if (entityId.startsWith('message:')) return 'message';
  if (entityId.startsWith('context-note:')) {
    return 'legacy-context-note';
  }
  throw new Error('theater.isolated entity id 前缀无效。');
}

export function theaterIsolatedLocalId(
  kind: TheaterIsolatedRecordKind,
  entityId: string,
) {
  if (theaterIsolatedKindFromEntityId(entityId) !== kind) {
    throw new Error('theater.isolated kind 与 entity id 不一致。');
  }
  const separator = entityId.indexOf(':');
  const localId = entityId.slice(separator + 1);
  if (isTheaterStoryRecordKind(kind)) assertString(localId, `theater ${kind} local id`, 240);
  else assertLocalId(localId, `theater ${kind} local id`);
  return localId;
}

export function assertTheaterIsolatedRecord(
  kind: TheaterIsolatedRecordKind,
  entityId: string,
  value: unknown,
): asserts value is TheaterIsolatedRecord {
  if (isTheaterStoryRecordKind(kind)) { assertTheaterStoryRecord(kind, entityId, value); return; }
  const record = recordOf(value, `theater ${kind} record`);
  if (kind === 'persona') {
    assertExactKeys(record, [
      'id',
      'name',
      'persona',
      'temperature',
      'contextLimit',
      'createdAt',
      'updatedAt',
    ], 'theater persona');
    assertLocalId(record.id, 'theater persona id');
    assertRecordIdentity(kind, entityId, record.id);
    assertString(record.name, 'theater persona name', 500);
    assertString(record.persona, 'theater persona text', 200_000, true);
    assertFiniteNumber(record.temperature, 'theater temperature', 0, 2);
    assertInteger(record.contextLimit, 'theater contextLimit', 4, 80);
    assertTimestamp(record.createdAt, 'theater persona createdAt');
    assertTimestamp(record.updatedAt, 'theater persona updatedAt');
    return;
  }
  if (kind === 'conversation') {
    assertExactKeys(record, [
      'id',
      'title',
      'personaId',
      'personaSnapshot',
      'storyState',
      'summaryInterval',
      'lastSummarizedMessageCount',
      'createdAt',
      'updatedAt',
    ], 'theater conversation');
    assertLocalId(record.id, 'theater conversation id');
    assertRecordIdentity(kind, entityId, record.id);
    assertString(record.title, 'theater conversation title', 500);
    assertNullableId(record.personaId, 'theater conversation personaId');
    assertString(
      record.personaSnapshot,
      'theater conversation personaSnapshot',
      200_000,
      true,
    );
    assertString(
      record.storyState,
      'theater conversation storyState',
      200_000,
      true,
    );
    if (record.summaryInterval !== null) {
      assertInteger(
        record.summaryInterval,
        'theater conversation summaryInterval',
        3,
        200,
      );
    }
    assertInteger(
      record.lastSummarizedMessageCount,
      'theater conversation lastSummarizedMessageCount',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    assertTimestamp(record.createdAt, 'theater conversation createdAt');
    assertTimestamp(record.updatedAt, 'theater conversation updatedAt');
    return;
  }
  if (kind === 'message') {
    assertExactKeys(record, [
      'id',
      'conversationId',
      'role',
      'content',
      'createdAt',
      'updatedAt',
    ], 'theater message');
    assertLocalId(record.id, 'theater message id');
    assertRecordIdentity(kind, entityId, record.id);
    assertLocalId(record.conversationId, 'theater message conversationId');
    if (record.role !== 'I' && record.role !== 'you') {
      throw new Error('theater shared message role 必须是 I / you。');
    }
    assertString(record.content, 'theater message content', 200_000, true);
    assertTimestamp(record.createdAt, 'theater message createdAt');
    assertTimestamp(record.updatedAt, 'theater message updatedAt');
    return;
  }
  assertExactKeys(record, [
    'id',
    'conversationId',
    'content',
    'createdAt',
    'updatedAt',
  ], 'theater legacy context note');
  assertLocalId(record.id, 'theater context note id');
  assertRecordIdentity(kind, entityId, record.id);
  assertLocalId(record.conversationId, 'theater context note conversationId');
  assertString(
    record.content,
    'theater context note content',
    200_000,
    true,
  );
  assertTimestamp(record.createdAt, 'theater context note createdAt');
  assertTimestamp(record.updatedAt, 'theater context note updatedAt');
}

export function assertTheaterIsolatedPayload(
  entityId: string,
  operation: string,
  value: unknown,
): asserts value is TheaterIsolatedPayloadV1 {
  const payload = recordOf(value, 'theater.isolated payload');
  if (
    payload.schemaVersion !== (isTheaterStoryRecordKind(payload.kind) ? 2 : 1)
    || !isTheaterIsolatedRecordKind(payload.kind)
  ) {
    throw new Error('theater.isolated payload 版本或 kind 无效。');
  }
  const expectedKind = theaterIsolatedKindFromEntityId(entityId);
  if (payload.kind !== expectedKind) {
    throw new Error('theater.isolated payload kind 与 entity id 不一致。');
  }
  if (operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      'theater delete payload',
    );
    assertTimestamp(payload.deletedAt, 'theater deletedAt');
    return;
  }
  if (operation !== 'upsert' && operation !== 'restore') {
    throw new Error(
      'theater.isolated 只允许 upsert、restore 或 delete。',
    );
  }
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'record'],
    'theater record payload',
  );
  assertTheaterIsolatedRecord(payload.kind, entityId, payload.record);
}

export function assertTheaterIsolatedMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'theater'
    || value.entity.type !== THEATER_ISOLATED_ENTITY_TYPE
  ) {
    throw new Error('theater.isolated mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== (isTheaterStoryRecordKind((value.payload as Record<string, unknown>)?.kind) ? 2 : 1)
  ) {
    throw new Error('theater.isolated schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
    && value.revision.operation !== 'delete'
  ) {
    throw new Error('theater.isolated operation 无效。');
  }
  if (
    value.sensitivity !== 'high'
    || value.retentionClass !== THEATER_ISOLATED_RETENTION_CLASS
  ) {
    throw new Error('theater.isolated 高敏留存合同无效。');
  }
  if (value.objectRefs.length !== 0) {
    throw new Error('theater.isolated 不接受对象引用。');
  }
  assertTheaterIsolatedPayload(
    value.entity.id,
    value.revision.operation,
    value.payload,
  );
}

export function theaterIsolatedPayload(mutation: PlainMutationV1) {
  assertTheaterIsolatedMutationV1(mutation);
  return mutation.payload as TheaterIsolatedPayloadV1;
}

// After ordinary signature/decryption verification, identify only exact newly supported fields.
export function isSupportedTheaterForkBoundaryMutation(value: unknown): boolean {
  try {
    assertTheaterIsolatedMutationV1(value);
    const payload = value.payload as Record<string, unknown>;
    const record = payload.record as Record<string, unknown> | undefined;
    return value.revision.operation === 'upsert' && value.revision.schemaVersion === 2
      && !!record && ((payload.kind === 'branch' && Object.prototype.hasOwnProperty.call(record, 'forkBoundary'))
        || (payload.kind === 'checkpoint' && Object.prototype.hasOwnProperty.call(record, 'needsReview'))
        || (payload.kind === 'text-version' && Object.prototype.hasOwnProperty.call(record, 'coCreation')));
  } catch { return false; }
}

export function buildTheaterIsolatedMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityId: string;
  operation: 'upsert' | 'restore' | 'delete';
  payload: TheaterIsolatedPayloadV1;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'theater',
      type: THEATER_ISOLATED_ENTITY_TYPE,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: input.payload.schemaVersion,
    },
    sensitivity: 'high',
    payload: input.payload,
    objectRefs: [],
    retentionClass: THEATER_ISOLATED_RETENTION_CLASS,
  };
  assertTheaterIsolatedMutationV1(mutation);
  return mutation;
}

export function theaterIsolatedRecordPayload(input: {
  kind: TheaterIsolatedRecordKind;
  entityId: string;
  record: JsonValue & Record<string, JsonValue>;
}): TheaterIsolatedPayloadV1 {
  assertTheaterIsolatedRecord(
    input.kind,
    input.entityId,
    input.record,
  );
  assertJsonValue(input.record);
  return {
    schemaVersion: isTheaterStoryRecordKind(input.kind) ? 2 : 1,
    kind: input.kind,
    record: input.record as TheaterIsolatedRecord,
  };
}

export function theaterIsolatedDeletePayload(input: {
  kind: TheaterIsolatedRecordKind;
  entityId: string;
  deletedAt: number;
}): TheaterIsolatedPayloadV1 {
  if (theaterIsolatedKindFromEntityId(input.entityId) !== input.kind) {
    throw new Error('theater delete kind 与 entity id 不一致。');
  }
  assertTimestamp(input.deletedAt, 'theater deletedAt');
  return {
    schemaVersion: isTheaterStoryRecordKind(input.kind) ? 2 : 1,
    kind: input.kind,
    deletedAt: input.deletedAt,
  };
}
