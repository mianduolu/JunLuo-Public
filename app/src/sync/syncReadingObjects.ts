import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const READING_OBJECTS_ADAPTER_ID = 'reading.objects' as const;
export const READING_OBJECTS_SCHEMA_VERSION = 1 as const;
export const READING_OBJECTS_RETENTION_CLASS = 'reading-object' as const;

export type ReadingObjectEntityType =
  | 'book-object'
  | 'cover-object'
  | 'extracted-image-object';
export type ReadingObjectRole = 'source' | 'cover' | 'extracted-image';
export type ReadingObjectRecordKind = 'object-link';

export type ReadingObjectRecord = {
  bookId: string;
  role: ReadingObjectRole;
  slot?: string;
  objectId: string;
  extension: string;
  mediaType?: string;
  plaintextBytes: number;
  chunkCount: number;
  updatedAt: number;
};

const ROLE_ENTITY_TYPE: Readonly<
  Record<ReadingObjectRole, ReadingObjectEntityType>
> = {
  source: 'book-object',
  cover: 'cover-object',
  'extracted-image': 'extracted-image-object',
};

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  expect(!extras.length, `${label} 包含未允许字段：${extras.sort().join(', ')}。`);
  const missing = required.filter((key) => !(key in value));
  expect(!missing.length, `${label} 缺少字段：${missing.join(', ')}。`);
}

function assertBookId(value: unknown, label: string): asserts value is string {
  expect(
    typeof value === 'string'
      && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value),
    `${label} 无效。`,
  );
}

function assertRole(
  value: unknown,
  label: string,
): asserts value is ReadingObjectRole {
  expect(
    value === 'source' || value === 'cover' || value === 'extracted-image',
    `${label} 无效。`,
  );
}

function assertEntityType(
  value: unknown,
): asserts value is ReadingObjectEntityType {
  expect(
    value === 'book-object'
      || value === 'cover-object'
      || value === 'extracted-image-object',
    'reading.objects entity type 无效。',
  );
}

function assertObjectId(value: unknown, label: string): asserts value is string {
  expect(
    typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value),
    `${label} 必须是 32 bytes 无填充 base64url 对象 ID。`,
  );
}

function assertTimestamp(value: unknown, label: string) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${label} 必须是非负 Unix 毫秒整数。`,
  );
}

function assertSlot(value: unknown, label: string): asserts value is string {
  expect(
    typeof value === 'string'
      && value.length >= 1
      && value.length <= 160
      && !/[\/\\\u0000-\u001f\u007f]/.test(value)
      && value !== '.'
      && value !== '..',
    `${label} 必须是安全的单层文件槽位。`,
  );
}

function assertExtension(value: unknown, label: string): asserts value is string {
  expect(
    typeof value === 'string' && /^[a-z0-9]{1,16}$/.test(value),
    `${label} 必须是 1–16 位小写字母数字扩展名。`,
  );
}

function assertEntityId(value: unknown) {
  expect(
    typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value),
    'reading.objects entity id 无效。',
  );
}

export function readingObjectEntityTypeForRole(
  role: ReadingObjectRole,
): ReadingObjectEntityType {
  return ROLE_ENTITY_TYPE[role];
}

export function readingObjectEntityId(input: {
  bookId: string;
  role: ReadingObjectRole;
  slot?: string;
}) {
  assertBookId(input.bookId, 'reading object bookId');
  assertRole(input.role, 'reading object role');
  if (input.role === 'extracted-image') {
    assertSlot(input.slot, 'reading extracted image slot');
  } else {
    expect(input.slot === undefined, 'source/cover reading object 不能带 slot。');
  }
  return Buffer.from(sha256(
    new TextEncoder().encode(
      `junluo:reading-object:v1:${input.bookId}:${input.role}:${input.slot ?? ''}`,
    ),
  )).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function assertReadingObjectRecord(
  entityType: ReadingObjectEntityType,
  entityId: string,
  value: unknown,
): asserts value is ReadingObjectRecord {
  assertEntityType(entityType);
  assertEntityId(entityId);
  const record = recordOf(value, 'reading.objects record');
  assertJsonValue(record);
  assertExactKeys(
    record,
    [
      'bookId',
      'role',
      'objectId',
      'extension',
      'plaintextBytes',
      'chunkCount',
      'updatedAt',
    ],
    ['slot', 'mediaType'],
    'reading.objects record',
  );
  assertBookId(record.bookId, 'reading object bookId');
  assertRole(record.role, 'reading object role');
  assertObjectId(record.objectId, 'reading object objectId');
  assertExtension(record.extension, 'reading object extension');
  if (record.mediaType !== undefined) {
    expect(
      typeof record.mediaType === 'string'
        && record.mediaType.length >= 1
        && record.mediaType.length <= 128
        && !/[\u0000-\u001f\u007f]/.test(record.mediaType),
      'reading object mediaType 无效。',
    );
  }
  expect(
    Number.isSafeInteger(record.plaintextBytes)
      && Number(record.plaintextBytes) >= 0,
    'reading object plaintextBytes 无效。',
  );
  expect(
    Number.isSafeInteger(record.chunkCount)
      && Number(record.chunkCount) >= 1
      && Number(record.chunkCount) <= 100_000,
    'reading object chunkCount 无效。',
  );
  assertTimestamp(record.updatedAt, 'reading object updatedAt');
  if (record.role === 'extracted-image') {
    assertSlot(record.slot, 'reading extracted image slot');
  } else {
    expect(record.slot === undefined, 'source/cover reading object 不能带 slot。');
  }
  const recordSlot = typeof record.slot === 'string'
    ? record.slot
    : undefined;
  expect(
    readingObjectEntityTypeForRole(record.role) === entityType,
    'reading object role 与 entity type 不一致。',
  );
  expect(
    readingObjectEntityId({
      bookId: record.bookId,
      role: record.role,
      ...(recordSlot ? { slot: recordSlot } : {}),
    }) === entityId,
    'reading object 内容与 entity id 不一致。',
  );
}

export function assertReadingObjectsMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(value.entity.domain === 'reading', 'reading.objects domain 无效。');
  assertEntityType(value.entity.type);
  assertEntityId(value.entity.id);
  expect(
    value.revision.schemaVersion === READING_OBJECTS_SCHEMA_VERSION,
    'reading.objects schemaVersion 无效。',
  );
  expect(value.sensitivity === 'high', 'reading.objects sensitivity 必须为 high。');
  expect(
    value.retentionClass === READING_OBJECTS_RETENTION_CLASS,
    'reading.objects retentionClass 无效。',
  );
  const payload = recordOf(value.payload, 'reading.objects payload');
  if (value.revision.operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'reading.objects delete',
    );
    expect(
      payload.schemaVersion === READING_OBJECTS_SCHEMA_VERSION,
      'reading.objects delete schemaVersion 无效。',
    );
    assertTimestamp(payload.deletedAt, 'reading.objects deletedAt');
    expect(!value.objectRefs.length, 'reading.objects 墓碑不能继续引用对象。');
    return;
  }
  expect(
    value.revision.operation === 'upsert'
      || value.revision.operation === 'restore',
    'reading.objects 只允许 upsert、restore 或 delete。',
  );
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'reading.objects record payload',
  );
  expect(
    payload.schemaVersion === READING_OBJECTS_SCHEMA_VERSION
      && payload.kind === 'object-link',
    'reading.objects record payload 无效。',
  );
  assertReadingObjectRecord(
    value.entity.type as ReadingObjectEntityType,
    value.entity.id,
    payload.value,
  );
  const record = payload.value as ReadingObjectRecord;
  expect(
    value.objectRefs.length === 1 && value.objectRefs[0] === record.objectId,
    'reading.objects mutation 必须且只能引用自身 objectId。',
  );
}

export function buildReadingObjectRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ReadingObjectEntityType;
  entityId: string;
  value: ReadingObjectRecord;
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
      domain: 'reading',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: READING_OBJECTS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: READING_OBJECTS_SCHEMA_VERSION,
      kind: 'object-link',
      value: input.value as unknown as JsonValue,
    },
    objectRefs: [input.value.objectId],
    retentionClass: READING_OBJECTS_RETENTION_CLASS,
  };
  assertReadingObjectsMutationV1(mutation);
  return mutation;
}

export function buildReadingObjectDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: ReadingObjectEntityType;
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
      domain: 'reading',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: READING_OBJECTS_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: READING_OBJECTS_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: READING_OBJECTS_RETENTION_CLASS,
  };
  assertReadingObjectsMutationV1(mutation);
  return mutation;
}
