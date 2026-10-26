import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const PERSONA_EXPRESSION_OBJECTS_ADAPTER_ID =
  'persona.expression-objects' as const;
export const PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION = 1 as const;
export const PERSONA_EXPRESSION_OBJECTS_RETENTION_CLASS =
  'relationship-history' as const;

export const PERSONA_EXPRESSION_MOOD_IDS = [
  'happy',
  'angry',
  'speechless',
  'confused',
  'surprised',
  'sad',
  'like',
  'tired',
  'sleepy',
] as const;

export type PersonaExpressionMoodId =
  typeof PERSONA_EXPRESSION_MOOD_IDS[number];
export type PersonaExpressionFieldName = 'emojiText' | 'kaomojiText';
export type PersonaExpressionObjectsEntityType = 'expression' | 'sticker';
export type PersonaExpressionObjectsRecordKind =
  | 'expression-field'
  | 'sticker-metadata';

export type PersonaExpressionFieldRecord = {
  moodId: PersonaExpressionMoodId;
  field: PersonaExpressionFieldName;
  text: string;
};

export type PersonaStickerMetadataRecord = {
  id: string;
  moodId: PersonaExpressionMoodId;
  name: string;
  objectId: string;
  createdAt: number;
  mimeType?: string;
  width?: number;
  height?: number;
  size?: number;
  meaning?: string;
};

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = required.filter((key) => !(key in value));
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
    || (!allowEmpty && value.length < 1)
    || value.length > maximumLength
  ) {
    throw new Error(
      `${label} 必须是 ${allowEmpty ? 0 : 1}–${maximumLength} 字符的字符串。`,
    );
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOptionalPositiveNumber(value: unknown, label: string) {
  if (
    value !== undefined
    && (
      typeof value !== 'number'
      || !Number.isFinite(value)
      || value <= 0
    )
  ) {
    throw new Error(`${label} 必须是正数。`);
  }
}

function assertMoodId(
  value: unknown,
  label: string,
): asserts value is PersonaExpressionMoodId {
  if (
    typeof value !== 'string'
    || !PERSONA_EXPRESSION_MOOD_IDS.includes(
      value as PersonaExpressionMoodId,
    )
  ) {
    throw new Error(`${label} 不是登记的表情分类。`);
  }
}

function assertObjectId(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw new Error(`${label} 必须是 32 bytes 无填充 base64url 对象 ID。`);
  }
}

function assertStickerId(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > 128
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} 必须是 1–128 字符的稳定 ID。`);
  }
}

export function expressionFieldEntityId(
  moodId: PersonaExpressionMoodId,
  field: PersonaExpressionFieldName,
) {
  return `${moodId}:${field}`;
}

export function parseExpressionFieldEntityId(entityId: string) {
  const separator = entityId.indexOf(':');
  if (separator < 1 || separator !== entityId.lastIndexOf(':')) {
    throw new Error('expression entity id 格式无效。');
  }
  const moodId = entityId.slice(0, separator);
  const field = entityId.slice(separator + 1);
  assertMoodId(moodId, 'expression moodId');
  if (field !== 'emojiText' && field !== 'kaomojiText') {
    throw new Error('expression field 无效。');
  }
  return {
    moodId,
    field,
  } as const;
}

function assertExpressionFieldRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['moodId', 'field', 'text'],
    [],
    'expression field',
  );
  assertMoodId(value.moodId, 'expression field moodId');
  if (value.field !== 'emojiText' && value.field !== 'kaomojiText') {
    throw new Error('expression field 名称无效。');
  }
  assertString(value.text, 'expression field text', 1200, true);
  if (
    expressionFieldEntityId(value.moodId, value.field) !== entityId
  ) {
    throw new Error('expression field 内容与 entity id 不一致。');
  }
}

function assertStickerMetadataRecord(
  entityId: string,
  value: Record<string, unknown>,
) {
  assertKeys(
    value,
    ['id', 'moodId', 'name', 'objectId', 'createdAt'],
    ['mimeType', 'width', 'height', 'size', 'meaning'],
    'sticker metadata',
  );
  assertStickerId(value.id, 'sticker id');
  if (value.id !== entityId) {
    throw new Error('sticker metadata id 与 entity id 不一致。');
  }
  assertMoodId(value.moodId, 'sticker moodId');
  assertString(value.name, 'sticker name', 48);
  assertObjectId(value.objectId, 'sticker objectId');
  assertTimestamp(value.createdAt, 'sticker createdAt');
  if (value.mimeType !== undefined) {
    assertString(value.mimeType, 'sticker mimeType', 128);
  }
  if (value.meaning !== undefined) {
    assertString(value.meaning, 'sticker meaning', 120, true);
  }
  assertOptionalPositiveNumber(value.width, 'sticker width');
  assertOptionalPositiveNumber(value.height, 'sticker height');
  assertOptionalPositiveNumber(value.size, 'sticker size');
}

export function assertPersonaExpressionObjectsRecord(
  kind: PersonaExpressionObjectsRecordKind,
  entityId: string,
  value: unknown,
) {
  const record = recordOf(
    value,
    `persona.expression-objects ${kind}`,
  );
  assertJsonValue(record);
  if (kind === 'expression-field') {
    assertExpressionFieldRecord(entityId, record);
    return;
  }
  if (kind === 'sticker-metadata') {
    assertStickerMetadataRecord(entityId, record);
    return;
  }
  throw new Error('persona.expression-objects record kind 无效。');
}

function assertEntity(
  entityType: string,
  entityId: string,
  kind?: PersonaExpressionObjectsRecordKind,
) {
  if (entityType === 'expression') {
    parseExpressionFieldEntityId(entityId);
    if (kind !== undefined && kind !== 'expression-field') {
      throw new Error('expression entity 只能保存 expression-field。');
    }
    return;
  }
  if (entityType === 'sticker') {
    assertStickerId(entityId, 'sticker entity id');
    if (kind !== undefined && kind !== 'sticker-metadata') {
      throw new Error('sticker entity 只能保存 sticker-metadata。');
    }
    return;
  }
  throw new Error('persona.expression-objects mutation entity 无效。');
}

export function assertPersonaExpressionObjectsMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (value.entity.domain !== 'persona') {
    throw new Error('persona.expression-objects domain 无效。');
  }
  assertEntity(value.entity.type, value.entity.id);
  if (
    value.revision.schemaVersion
    !== PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION
  ) {
    throw new Error('persona.expression-objects schemaVersion 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('persona.expression-objects sensitivity 必须为 high。');
  }
  if (
    value.retentionClass
    !== PERSONA_EXPRESSION_OBJECTS_RETENTION_CLASS
  ) {
    throw new Error('persona.expression-objects retentionClass 无效。');
  }
  const payload = recordOf(
    value.payload,
    'persona.expression-objects payload',
  );
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'persona.expression-objects delete',
    );
    if (
      payload.schemaVersion
      !== PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION
    ) {
      throw new Error('persona.expression-objects delete schemaVersion 无效。');
    }
    assertTimestamp(
      payload.deletedAt,
      'persona.expression-objects deletedAt',
    );
    if (value.objectRefs.length) {
      throw new Error('persona.expression-objects 墓碑不能继续引用对象。');
    }
    return;
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'restore'
  ) {
    throw new Error(
      'persona.expression-objects 只允许 upsert、restore 或 delete。',
    );
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'persona.expression-objects record',
  );
  if (
    payload.schemaVersion
    !== PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION
  ) {
    throw new Error('persona.expression-objects payload schemaVersion 无效。');
  }
  const kind = payload.kind as PersonaExpressionObjectsRecordKind;
  if (kind !== 'expression-field' && kind !== 'sticker-metadata') {
    throw new Error('persona.expression-objects record kind 无效。');
  }
  assertEntity(value.entity.type, value.entity.id, kind);
  assertPersonaExpressionObjectsRecord(kind, value.entity.id, payload.value);
  if (kind === 'expression-field') {
    if (value.objectRefs.length) {
      throw new Error('expression field 不能引用文件对象。');
    }
    return;
  }
  const sticker = payload.value as PersonaStickerMetadataRecord;
  if (
    value.objectRefs.length !== 1
    || value.objectRefs[0] !== sticker.objectId
  ) {
    throw new Error('sticker mutation 必须且只能引用自身 objectId。');
  }
}

export function buildPersonaExpressionObjectsRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: PersonaExpressionObjectsEntityType;
  entityId: string;
  kind: PersonaExpressionObjectsRecordKind;
  value: JsonValue;
  operation?: 'upsert' | 'restore';
}) {
  const objectRefs = input.kind === 'sticker-metadata'
    ? [(input.value as PersonaStickerMetadataRecord).objectId]
    : [];
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'persona',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs,
    retentionClass: PERSONA_EXPRESSION_OBJECTS_RETENTION_CLASS,
  };
  assertPersonaExpressionObjectsMutationV1(mutation);
  return mutation;
}

export function buildPersonaExpressionObjectsDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: PersonaExpressionObjectsEntityType;
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
      domain: 'persona',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: PERSONA_EXPRESSION_OBJECTS_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: PERSONA_EXPRESSION_OBJECTS_RETENTION_CLASS,
  };
  assertPersonaExpressionObjectsMutationV1(mutation);
  return mutation;
}
