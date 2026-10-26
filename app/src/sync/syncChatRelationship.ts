import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export const CHAT_RELATIONSHIP_SCHEMA_VERSION = 1 as const;
export const CHAT_RELATIONSHIP_RETENTION_CLASS = 'relationship-history' as const;

export type ChatRelationshipEntityType =
  | 'favorite'
  | 'expression-feedback'
  | 'preference'
  | 'notebook-entry'
  | 'sleep-state';

export type ChatRelationshipRecordKind =
  | 'favorite'
  | 'liked-style-reference'
  | 'user-correction'
  | 'chat-preferences'
  | 'keyword-task'
  | 'keyword-event'
  | 'keyword-insight'
  | 'keyword-settings'
  | 'notebook-entry'
  | 'notebook-settings'
  | 'sleep-state';

const ENTITY_TYPES = new Set<ChatRelationshipEntityType>([
  'favorite',
  'expression-feedback',
  'preference',
  'notebook-entry',
  'sleep-state',
]);

const RECORD_KINDS = new Set<ChatRelationshipRecordKind>([
  'favorite',
  'liked-style-reference',
  'user-correction',
  'chat-preferences',
  'keyword-task',
  'keyword-event',
  'keyword-insight',
  'keyword-settings',
  'notebook-entry',
  'notebook-settings',
  'sleep-state',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function assertPokeInteractionRecord(value: unknown, pending = false) {
  if (!isRecord(value)) throw new Error('poke interaction 必须是对象。');
  const required = ['id', 'pokedAt', 'sourceSessionId', 'anchorId', ...(pending ? ['targetSessionId'] : [])];
  const allowed = new Set([...required, 'wokeAt', 'sleepMessageIds', 'replyToMessageIds', ...(pending ? ['replyMessageIds'] : [])]);
  if (required.some(key => !(key in value)) || Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('poke interaction 字段无效。');
  }
  const string = (item: unknown) => typeof item === 'string' && item.trim().length > 0 && item.length <= 256;
  if (!string(value.id) || !string(value.anchorId)
    || (value.sourceSessionId !== null && !string(value.sourceSessionId))
    || (pending && value.targetSessionId !== null && !string(value.targetSessionId))) {
    throw new Error('poke interaction 引用无效。');
  }
  if (!Number.isSafeInteger(value.pokedAt) || Number(value.pokedAt) < 0
    || (value.wokeAt !== undefined && (!Number.isSafeInteger(value.wokeAt) || Number(value.wokeAt) < Number(value.pokedAt)))) {
    throw new Error('poke interaction 时间无效。');
  }
  for (const key of ['sleepMessageIds', 'replyToMessageIds', ...(pending ? ['replyMessageIds'] : [])]) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || !(value[key] as unknown[]).every(string)
      || new Set(value[key] as unknown[]).size !== (value[key] as unknown[]).length)) {
      throw new Error('poke interaction 消息引用无效。');
    }
  }
}

export function assertPendingPokeExperiences(value: unknown) {
  if (!Array.isArray(value)) throw new Error('poke experiences 必须是数组。');
  const ids = new Set();
  for (const item of value) {
    assertPokeInteractionRecord(item, true);
    if (ids.has(item.id)) throw new Error('poke experiences 编号重复。');
    ids.add(item.id);
  }
}

export function assertChatRelationshipMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (value.entity.domain !== 'chat' || !ENTITY_TYPES.has(value.entity.type as ChatRelationshipEntityType)) {
    throw new Error('chat.relationship-state mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== CHAT_RELATIONSHIP_SCHEMA_VERSION) {
    throw new Error('chat.relationship-state schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('chat.relationship-state sensitivity 必须为 high。');
  }
  if (value.retentionClass !== CHAT_RELATIONSHIP_RETENTION_CLASS) {
    throw new Error('chat.relationship-state retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('chat.relationship-state 不接受对象引用。');
  }
  if (!isRecord(value.payload) || value.payload.schemaVersion !== CHAT_RELATIONSHIP_SCHEMA_VERSION) {
    throw new Error('chat.relationship-state payload 无效。');
  }
  if (value.revision.operation === 'delete') {
    if (!Number.isSafeInteger(value.payload.deletedAt)) {
      throw new Error('chat.relationship-state 删除墓碑缺少 deletedAt。');
    }
    return;
  }
  if (
    !RECORD_KINDS.has(value.payload.kind as ChatRelationshipRecordKind)
    || !Object.prototype.hasOwnProperty.call(value.payload, 'value')
  ) {
    throw new Error('chat.relationship-state payload 缺少 kind/value。');
  }
  assertJsonValue(value.payload.value);
  if (value.payload.kind === 'sleep-state' && isRecord(value.payload.value) && 'pokeExperiences' in value.payload.value) {
    assertPendingPokeExperiences(value.payload.value.pokeExperiences);
  }
}

export function buildChatRelationshipRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ChatRelationshipEntityType;
  entityId: string;
  kind: ChatRelationshipRecordKind;
  value: JsonValue;
  operation: Exclude<SyncOperation, 'delete' | 'restore'>;
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'chat',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: CHAT_RELATIONSHIP_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: CHAT_RELATIONSHIP_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: CHAT_RELATIONSHIP_RETENTION_CLASS,
  };
  assertChatRelationshipMutationV1(mutation);
  return mutation;
}

export function buildChatRelationshipDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ChatRelationshipEntityType;
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
      domain: 'chat',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: 'delete',
      schemaVersion: CHAT_RELATIONSHIP_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: CHAT_RELATIONSHIP_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: CHAT_RELATIONSHIP_RETENTION_CLASS,
  };
  assertChatRelationshipMutationV1(mutation);
  return mutation;
}
