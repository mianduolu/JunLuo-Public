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

export const TOGETHER_WALKED_LIFE_ADAPTER_ID =
  'together-walked.life' as const;
export const TOGETHER_WALKED_LIFE_SCHEMA_VERSION = 1 as const;
export const TOGETHER_WALKED_LIFE_RETENTION_CLASS =
  'relationship-history' as const;
export const TOGETHER_WALKED_DRAFT_ENTITY_ID = 'current' as const;

export type TogetherWalkedLifeEntityType =
  | 'entry'
  | 'journey'
  | 'draft'
  | 'image-object';
export type TogetherWalkedLifeRecordKind =
  TogetherWalkedLifeEntityType;
export type TogetherWalkedImageOwnerType = 'entry' | 'draft';

export type TogetherWalkedSharedLocation = {
  latitude?: number;
  longitude?: number;
  accuracy?: number;
  label?: string;
};

export type TogetherWalkedEntryRecord = {
  id: string;
  title: string;
  note: string;
  imageObjectId?: string;
  location?: TogetherWalkedSharedLocation;
  journeyId?: string;
  createdAt: number;
  updatedAt: number;
  memoryId?: string;
};

export type TogetherWalkedJourneyRecord = {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
};

export type TogetherWalkedDraftRecord = {
  id: typeof TOGETHER_WALKED_DRAFT_ENTITY_ID;
  title?: string;
  note?: string;
  occurredAtText?: string;
  imageObjectId?: string;
  location?: TogetherWalkedSharedLocation;
  journeyId?: string;
  manualPlace?: string;
  manualLatitude?: string;
  manualLongitude?: string;
  updatedAt: number;
};

export type TogetherWalkedImageObjectRecord = {
  ownerType: TogetherWalkedImageOwnerType;
  ownerId: string;
  objectId: string;
  extension: string;
  mediaType?: string;
  plaintextBytes: number;
  chunkCount: number;
  updatedAt: number;
};

export type TogetherWalkedLifeRecord =
  | TogetherWalkedEntryRecord
  | TogetherWalkedJourneyRecord
  | TogetherWalkedDraftRecord
  | TogetherWalkedImageObjectRecord;

type JsonRecord = Record<string, unknown>;

function expect(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): JsonRecord {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as JsonRecord;
}

function assertExactKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extras = Object.keys(value).filter(
    (key) => !allowed.has(key),
  );
  const missing = required.filter((key) => !(key in value));
  expect(
    !extras.length && !missing.length,
    `${label} 字段集合无效。`,
  );
}

function assertString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
  allowFormattingWhitespace = false,
) {
  const forbiddenControlCharacters = allowFormattingWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  expect(
    typeof value === 'string'
      && (allowEmpty || value.length > 0)
      && value.length <= maximum
      && !forbiddenControlCharacters.test(value),
    `${label} 无效。`,
  );
}

function assertOptionalString(
  value: unknown,
  label: string,
  maximum: number,
  allowFormattingWhitespace = false,
) {
  if (value !== undefined) {
    assertString(
      value,
      label,
      maximum,
      true,
      allowFormattingWhitespace,
    );
  }
}

function assertTimestamp(value: unknown, label: string) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${label} 必须是非负 Unix 毫秒整数。`,
  );
}

function assertObjectId(value: unknown, label: string) {
  expect(
    typeof value === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(value),
    `${label} 必须是 32 bytes 无填充 base64url 对象 ID。`,
  );
}

function assertLocalEntityId(value: unknown, label: string) {
  assertString(value, label, 200);
  expect(
    typeof value === 'string'
      && value !== '.'
      && value !== '..'
      && !/[\/\\]/.test(value),
    `${label} 不能包含路径。`,
  );
}

function assertLocation(value: unknown, label: string) {
  if (value === undefined) return;
  const location = recordOf(value, label);
  assertExactKeys(
    location,
    [],
    ['latitude', 'longitude', 'accuracy', 'label'],
    label,
  );
  const hasLatitude = location.latitude !== undefined;
  const hasLongitude = location.longitude !== undefined;
  expect(
    hasLatitude === hasLongitude,
    `${label} 经纬度必须成对出现。`,
  );
  if (hasLatitude) {
    expect(
      typeof location.latitude === 'number'
        && Number.isFinite(location.latitude)
        && location.latitude >= -90
        && location.latitude <= 90,
      `${label}.latitude 无效。`,
    );
    expect(
      typeof location.longitude === 'number'
        && Number.isFinite(location.longitude)
        && location.longitude >= -180
        && location.longitude <= 180,
      `${label}.longitude 无效。`,
    );
    expect(
      location.latitude !== 0 || location.longitude !== 0,
      `${label} 不能使用 0,0 伪坐标。`,
    );
  }
  if (location.accuracy !== undefined) {
    expect(
      typeof location.accuracy === 'number'
        && Number.isFinite(location.accuracy)
        && location.accuracy >= 0
        && location.accuracy <= 1_000_000,
      `${label}.accuracy 无效。`,
    );
  }
  assertOptionalString(location.label, `${label}.label`, 300);
  expect(
    hasLatitude
      || (
        typeof location.label === 'string'
        && location.label.length > 0
      ),
    `${label} 至少需要地点名或坐标。`,
  );
}

function assertEntryRecord(
  entityId: string,
  value: JsonRecord,
) {
  assertExactKeys(
    value,
    ['id', 'title', 'note', 'createdAt', 'updatedAt'],
    [
      'imageObjectId',
      'location',
      'journeyId',
      'memoryId',
    ],
    'together-walked entry',
  );
  assertLocalEntityId(value.id, 'entry id');
  expect(value.id === entityId, 'entry id 与 entity id 不一致。');
  assertString(value.title, 'entry title', 300);
  assertString(value.note, 'entry note', 20_000, true, true);
  if (value.imageObjectId !== undefined) {
    assertObjectId(value.imageObjectId, 'entry imageObjectId');
  }
  assertLocation(value.location, 'entry location');
  if (value.journeyId !== undefined) {
    assertLocalEntityId(value.journeyId, 'entry journeyId');
  }
  if (value.memoryId !== undefined) {
    assertLocalEntityId(value.memoryId, 'entry memoryId');
  }
  assertTimestamp(value.createdAt, 'entry createdAt');
  assertTimestamp(value.updatedAt, 'entry updatedAt');
}

function assertJourneyRecord(
  entityId: string,
  value: JsonRecord,
) {
  assertExactKeys(
    value,
    ['id', 'title', 'description', 'createdAt', 'updatedAt'],
    [],
    'together-walked journey',
  );
  assertLocalEntityId(value.id, 'journey id');
  expect(value.id === entityId, 'journey id 与 entity id 不一致。');
  assertString(value.title, 'journey title', 300);
  assertString(
    value.description,
    'journey description',
    20_000,
    true,
    true,
  );
  assertTimestamp(value.createdAt, 'journey createdAt');
  assertTimestamp(value.updatedAt, 'journey updatedAt');
  expect(
    Number(value.updatedAt) >= Number(value.createdAt),
    'journey updatedAt 不能早于 createdAt。',
  );
}

function assertDraftRecord(
  entityId: string,
  value: JsonRecord,
) {
  assertExactKeys(
    value,
    ['id', 'updatedAt'],
    [
      'title',
      'note',
      'occurredAtText',
      'imageObjectId',
      'location',
      'journeyId',
      'manualPlace',
      'manualLatitude',
      'manualLongitude',
    ],
    'together-walked draft',
  );
  expect(
    entityId === TOGETHER_WALKED_DRAFT_ENTITY_ID
      && value.id === TOGETHER_WALKED_DRAFT_ENTITY_ID,
    'together-walked draft entity id 无效。',
  );
  assertOptionalString(value.title, 'draft title', 300);
  assertOptionalString(value.note, 'draft note', 20_000, true);
  assertOptionalString(
    value.occurredAtText,
    'draft occurredAtText',
    100,
  );
  if (value.imageObjectId !== undefined) {
    assertObjectId(value.imageObjectId, 'draft imageObjectId');
  }
  assertLocation(value.location, 'draft location');
  if (value.journeyId !== undefined) {
    assertLocalEntityId(value.journeyId, 'draft journeyId');
  }
  assertOptionalString(value.manualPlace, 'draft manualPlace', 300);
  assertOptionalString(
    value.manualLatitude,
    'draft manualLatitude',
    100,
  );
  assertOptionalString(
    value.manualLongitude,
    'draft manualLongitude',
    100,
  );
  assertTimestamp(value.updatedAt, 'draft updatedAt');
}

function assertImageObjectRecord(
  entityId: string,
  value: JsonRecord,
) {
  assertExactKeys(
    value,
    [
      'ownerType',
      'ownerId',
      'objectId',
      'extension',
      'plaintextBytes',
      'chunkCount',
      'updatedAt',
    ],
    ['mediaType'],
    'together-walked image object',
  );
  expect(
    value.ownerType === 'entry' || value.ownerType === 'draft',
    'together-walked image ownerType 无效。',
  );
  assertLocalEntityId(value.ownerId, 'image ownerId');
  if (value.ownerType === 'draft') {
    expect(
      value.ownerId === TOGETHER_WALKED_DRAFT_ENTITY_ID,
      'draft image ownerId 无效。',
    );
  }
  assertObjectId(value.objectId, 'image objectId');
  expect(
    typeof value.extension === 'string'
      && /^[a-z0-9]{1,16}$/.test(value.extension),
    'image extension 无效。',
  );
  if (value.mediaType !== undefined) {
    assertString(value.mediaType, 'image mediaType', 128);
  }
  expect(
    Number.isSafeInteger(value.plaintextBytes)
      && Number(value.plaintextBytes) >= 0,
    'image plaintextBytes 无效。',
  );
  expect(
    Number.isSafeInteger(value.chunkCount)
      && Number(value.chunkCount) >= 1
      && Number(value.chunkCount) <= 100_000,
    'image chunkCount 无效。',
  );
  assertTimestamp(value.updatedAt, 'image updatedAt');
  expect(
    togetherWalkedImageEntityId({
      ownerType: value.ownerType as TogetherWalkedImageOwnerType,
      ownerId: value.ownerId as string,
    }) === entityId,
    'image object 内容与 entity id 不一致。',
  );
}

function assertEntityType(
  value: unknown,
): asserts value is TogetherWalkedLifeEntityType {
  expect(
    value === 'entry'
      || value === 'journey'
      || value === 'draft'
      || value === 'image-object',
    'together-walked.life entity type 无效。',
  );
}

export function togetherWalkedImageEntityId(input: {
  ownerType: TogetherWalkedImageOwnerType;
  ownerId: string;
}) {
  expect(
    input.ownerType === 'entry' || input.ownerType === 'draft',
    'together-walked image ownerType 无效。',
  );
  assertLocalEntityId(input.ownerId, 'together-walked image ownerId');
  if (input.ownerType === 'draft') {
    expect(
      input.ownerId === TOGETHER_WALKED_DRAFT_ENTITY_ID,
      'draft image ownerId 无效。',
    );
  }
  return Buffer.from(sha256(
    new TextEncoder().encode(
      `junluo:together-walked-image:v1:${input.ownerType}:${input.ownerId}`,
    ),
  )).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function assertTogetherWalkedLifeRecord(
  kind: TogetherWalkedLifeRecordKind,
  entityId: string,
  value: unknown,
): asserts value is TogetherWalkedLifeRecord {
  const record = recordOf(value, `together-walked.life ${kind}`);
  assertJsonValue(record);
  if (kind === 'entry') {
    assertEntryRecord(entityId, record);
    return;
  }
  if (kind === 'journey') {
    assertJourneyRecord(entityId, record);
    return;
  }
  if (kind === 'draft') {
    assertDraftRecord(entityId, record);
    return;
  }
  assertImageObjectRecord(entityId, record);
}

function assertEntityId(
  entityType: TogetherWalkedLifeEntityType,
  entityId: string,
) {
  if (entityType === 'image-object') {
    assertObjectId(entityId, 'together-walked image entity id');
    return;
  }
  if (entityType === 'draft') {
    expect(
      entityId === TOGETHER_WALKED_DRAFT_ENTITY_ID,
      'together-walked draft entity id 无效。',
    );
    return;
  }
  assertLocalEntityId(
    entityId,
    `together-walked ${entityType} entity id`,
  );
}

export function assertTogetherWalkedLifeMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'together-walked',
    'together-walked.life domain 无效。',
  );
  assertEntityType(value.entity.type);
  assertEntityId(value.entity.type, value.entity.id);
  expect(
    value.revision.schemaVersion
      === TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
    'together-walked.life schemaVersion 无效。',
  );
  expect(
    value.sensitivity === 'high',
    'together-walked.life sensitivity 必须为 high。',
  );
  expect(
    value.retentionClass
      === TOGETHER_WALKED_LIFE_RETENTION_CLASS,
    'together-walked.life retentionClass 无效。',
  );
  const payload = recordOf(
    value.payload,
    'together-walked.life payload',
  );
  if (value.revision.operation === 'delete') {
    assertExactKeys(
      payload,
      ['schemaVersion', 'deletedAt'],
      [],
      'together-walked.life delete',
    );
    expect(
      payload.schemaVersion
        === TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
      'together-walked.life delete schemaVersion 无效。',
    );
    assertTimestamp(payload.deletedAt, 'together-walked deletedAt');
    expect(
      value.objectRefs.length === 0,
      'together-walked 墓碑不能引用内容对象。',
    );
    return;
  }
  expect(
    value.revision.operation === 'upsert'
      || value.revision.operation === 'restore',
    'together-walked.life 只允许 upsert、restore 或 delete。',
  );
  assertExactKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'together-walked.life record',
  );
  expect(
    payload.schemaVersion
      === TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
    'together-walked.life record schemaVersion 无效。',
  );
  expect(
    payload.kind === value.entity.type,
    'together-walked.life kind 与 entity type 不一致。',
  );
  const kind = payload.kind as TogetherWalkedLifeRecordKind;
  assertTogetherWalkedLifeRecord(
    kind,
    value.entity.id,
    payload.value,
  );
  const record = payload.value as unknown as {
    objectId?: string;
    imageObjectId?: string;
  };
  const objectId = kind === 'image-object'
    ? record.objectId
    : kind === 'entry' || kind === 'draft'
      ? record.imageObjectId
      : undefined;
  expect(
    objectId
      ? (
          value.objectRefs.length === 1
          && value.objectRefs[0] === objectId
        )
      : value.objectRefs.length === 0,
    'together-walked.life objectRefs 与记录不一致。',
  );
}

export function buildTogetherWalkedLifeRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: TogetherWalkedLifeEntityType;
  entityId: string;
  value: TogetherWalkedLifeRecord;
  operation?: 'upsert' | 'restore';
}) {
  const objectId = input.entityType === 'image-object'
    ? (input.value as TogetherWalkedImageObjectRecord).objectId
    : input.entityType === 'entry'
      ? (input.value as TogetherWalkedEntryRecord).imageObjectId
      : input.entityType === 'draft'
        ? (input.value as TogetherWalkedDraftRecord).imageObjectId
        : undefined;
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'together-walked',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
      kind: input.entityType,
      value: input.value as unknown as JsonValue,
    },
    objectRefs: objectId ? [objectId] : [],
    retentionClass: TOGETHER_WALKED_LIFE_RETENTION_CLASS,
  };
  assertTogetherWalkedLifeMutationV1(mutation);
  return mutation;
}

export function buildTogetherWalkedLifeDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: TogetherWalkedLifeEntityType;
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
      domain: 'together-walked',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: TOGETHER_WALKED_LIFE_SCHEMA_VERSION,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: TOGETHER_WALKED_LIFE_RETENTION_CLASS,
  };
  assertTogetherWalkedLifeMutationV1(mutation);
  return mutation;
}
