import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { bytesToBase64Url } from './syncBase64Url';

import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const APPEARANCE_FONTS_ADAPTER_ID =
  'appearance.fonts' as const;
export const APPEARANCE_FONTS_SCHEMA_VERSION = 1 as const;
export const APPEARANCE_FONTS_RETENTION =
  'appearance-font-long-term' as const;

export const APPEARANCE_FONT_RECORD_KINDS = [
  'font-choice',
  'font-object',
] as const;
export type AppearanceFontRecordKind =
  typeof APPEARANCE_FONT_RECORD_KINDS[number];

export const APPEARANCE_FONT_IDS = [
  'system',
  'xiaolai',
] as const;
export type AppearanceFontId =
  typeof APPEARANCE_FONT_IDS[number];

export const XIAOLAI_FONT_ASSET = Object.freeze({
  fontId: 'xiaolai' as const,
  familyName: 'Xiaolai' as const,
  assetVersion: '3.126' as const,
  extension: 'ttf' as const,
  licenseId: 'OFL-1.1' as const,
});

export type AppearanceFontChoice = {
  choiceId: 'global';
  fontId: AppearanceFontId;
  requiredObjectId?: string;
};

export type AppearanceFontObject = {
  fontId: 'xiaolai';
  familyName: 'Xiaolai';
  assetVersion: '3.126';
  extension: 'ttf';
  licenseId: 'OFL-1.1';
  objectId: string;
  plaintextBytes: number;
  chunkCount: number;
};

export type AppearanceFontRecordValue =
  | AppearanceFontChoice
  | AppearanceFontObject;

export type AppearanceFontMutationEnvelope = {
  mutationId: string;
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  revisionId: string;
  parentRevisionIds: string[];
  createdAt: number;
};

type UnknownRecord = Record<string, unknown>;

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string) {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as UnknownRecord;
}

function assertKeys(
  value: UnknownRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  expect(
    required.every((key) => key in value)
      && Object.keys(value).every((key) => allowed.has(key)),
    `${label} 字段集合无效。`,
  );
}

function assertObjectId(value: unknown, label: string) {
  expect(
    typeof value === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(value),
    `${label} 无效。`,
  );
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= minimum,
    `${label} 无效。`,
  );
}

function assertFontChoice(value: unknown) {
  const record = recordOf(value, 'appearance.fonts font-choice');
  assertKeys(
    record,
    ['choiceId', 'fontId'],
    ['requiredObjectId'],
    'appearance.fonts font-choice',
  );
  expect(record.choiceId === 'global', 'font-choice.choiceId 无效。');
  expect(
    (APPEARANCE_FONT_IDS as readonly unknown[]).includes(record.fontId),
    'font-choice.fontId 无效。',
  );
  if (record.fontId === 'system') {
    expect(
      record.requiredObjectId === undefined,
      'system 字体不能引用 font object。',
    );
    return;
  }
  assertObjectId(
    record.requiredObjectId,
    'font-choice.requiredObjectId',
  );
}

function assertFontObject(value: unknown) {
  const record = recordOf(value, 'appearance.fonts font-object');
  assertKeys(
    record,
    [
      'fontId',
      'familyName',
      'assetVersion',
      'extension',
      'licenseId',
      'objectId',
      'plaintextBytes',
      'chunkCount',
    ],
    [],
    'appearance.fonts font-object',
  );
  expect(
    record.fontId === XIAOLAI_FONT_ASSET.fontId
      && record.familyName === XIAOLAI_FONT_ASSET.familyName
      && record.assetVersion === XIAOLAI_FONT_ASSET.assetVersion
      && record.extension === XIAOLAI_FONT_ASSET.extension
      && record.licenseId === XIAOLAI_FONT_ASSET.licenseId,
    'font-object 资产身份无效。',
  );
  assertObjectId(record.objectId, 'font-object.objectId');
  assertSafeInteger(
    record.plaintextBytes,
    'font-object.plaintextBytes',
    1,
  );
  assertSafeInteger(record.chunkCount, 'font-object.chunkCount', 1);
}

export function assertAppearanceFontRecord(
  kind: AppearanceFontRecordKind,
  value: unknown,
): asserts value is AppearanceFontRecordValue {
  if (kind === 'font-choice') return assertFontChoice(value);
  assertFontObject(value);
}

export function appearanceFontLocalId(
  kind: AppearanceFontRecordKind,
  value: AppearanceFontRecordValue,
) {
  return kind === 'font-choice'
    ? (value as AppearanceFontChoice).choiceId
    : (value as AppearanceFontObject).fontId;
}

export function appearanceFontEntityId(
  kind: AppearanceFontRecordKind,
  localId: string,
) {
  return bytesToBase64Url(sha256(utf8ToBytes(
    `${APPEARANCE_FONTS_ADAPTER_ID}\u0000${kind}\u0000${localId}`,
  )));
}

function objectRefsForRecord(
  kind: AppearanceFontRecordKind,
  value: AppearanceFontRecordValue,
) {
  if (kind === 'font-object') {
    return [(value as AppearanceFontObject).objectId];
  }
  const objectId =
    (value as AppearanceFontChoice).requiredObjectId;
  return objectId ? [objectId] : [];
}

export function assertAppearanceFontMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'appearance'
      && (APPEARANCE_FONT_RECORD_KINDS as readonly string[])
        .includes(value.entity.type),
    'appearance.fonts mutation entity 无效。',
  );
  expect(
    value.revision.schemaVersion === APPEARANCE_FONTS_SCHEMA_VERSION
      && value.sensitivity === 'private'
      && value.retentionClass === APPEARANCE_FONTS_RETENTION,
    'appearance.fonts protocol metadata 无效。',
  );
  const kind = value.entity.type as AppearanceFontRecordKind;
  const payload = recordOf(value.payload, 'appearance.fonts payload');
  assertKeys(
    payload,
    value.revision.operation === 'delete'
      ? ['schemaVersion', 'kind', 'deletedAt']
      : ['schemaVersion', 'kind', 'value'],
    [],
    'appearance.fonts payload',
  );
  expect(
    payload.schemaVersion === APPEARANCE_FONTS_SCHEMA_VERSION
      && payload.kind === kind,
    'appearance.fonts payload metadata 无效。',
  );
  if (value.revision.operation === 'delete') {
    assertSafeInteger(
      payload.deletedAt,
      'appearance.fonts deletedAt',
      0,
    );
    expect(
      value.objectRefs.length === 0,
      'appearance.fonts tombstone 不能保留对象引用。',
    );
    return;
  }
  expect(
    value.revision.operation === 'upsert'
      || value.revision.operation === 'restore',
    'appearance.fonts 只允许 upsert、restore 或 delete。',
  );
  assertAppearanceFontRecord(kind, payload.value);
  const record = payload.value as AppearanceFontRecordValue;
  expect(
    value.entity.id === appearanceFontEntityId(
      kind,
      appearanceFontLocalId(kind, record),
    ),
    'appearance.fonts entity id 与记录不一致。',
  );
  expect(
    JSON.stringify(value.objectRefs)
      === JSON.stringify(objectRefsForRecord(kind, record)),
    'appearance.fonts objectRefs 与记录不一致。',
  );
}

export function appearanceFontMutationValue(
  mutation: PlainMutationV1,
) {
  assertAppearanceFontMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  return {
    kind: payload.kind as AppearanceFontRecordKind,
    value: payload.value as AppearanceFontRecordValue | undefined,
    deletedAt: payload.deletedAt as number | undefined,
  };
}

export function buildAppearanceFontUpsertMutation(input: {
  envelope: AppearanceFontMutationEnvelope;
  kind: AppearanceFontRecordKind;
  value: AppearanceFontRecordValue;
}) {
  assertAppearanceFontRecord(input.kind, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'appearance',
      type: input.kind,
      id: appearanceFontEntityId(
        input.kind,
        appearanceFontLocalId(input.kind, input.value),
      ),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'upsert',
      schemaVersion: APPEARANCE_FONTS_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      schemaVersion: APPEARANCE_FONTS_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value as JsonValue,
    },
    objectRefs: objectRefsForRecord(input.kind, input.value),
    retentionClass: APPEARANCE_FONTS_RETENTION,
  };
  assertAppearanceFontMutationV1(mutation);
  return mutation;
}

export function buildAppearanceFontDeleteMutation(input: {
  envelope: AppearanceFontMutationEnvelope;
  kind: AppearanceFontRecordKind;
  localId: string;
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
      domain: 'appearance',
      type: input.kind,
      id: appearanceFontEntityId(input.kind, input.localId),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: APPEARANCE_FONTS_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      schemaVersion: APPEARANCE_FONTS_SCHEMA_VERSION,
      kind: input.kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: APPEARANCE_FONTS_RETENTION,
  };
  assertAppearanceFontMutationV1(mutation);
  return mutation;
}
