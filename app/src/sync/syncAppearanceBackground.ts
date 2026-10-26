import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { bytesToBase64Url } from './syncBase64Url';

import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const APPEARANCE_BACKGROUND_ADAPTER_ID =
  'appearance.background' as const;
export const APPEARANCE_BACKGROUND_SCHEMA_VERSION = 1 as const;
export const APPEARANCE_BACKGROUND_RETENTION =
  'appearance-background-long-term' as const;

export const APPEARANCE_BACKGROUND_RECORD_KINDS = [
  'background-settings',
  'background-object',
] as const;
export type AppearanceBackgroundRecordKind =
  typeof APPEARANCE_BACKGROUND_RECORD_KINDS[number];

export const APPEARANCE_BACKGROUND_MODES = [
  'sky',
  'fixed',
  'image',
] as const;
export type AppearanceBackgroundMode =
  typeof APPEARANCE_BACKGROUND_MODES[number];

export const APPEARANCE_BACKGROUND_IMAGE_FITS = [
  'cover',
  'contain',
  'repeat',
] as const;
export type AppearanceBackgroundImageFit =
  typeof APPEARANCE_BACKGROUND_IMAGE_FITS[number];

export const APPEARANCE_BACKGROUND_TEXT_TONES = [
  'auto',
  'dark',
  'light',
] as const;
export type AppearanceBackgroundTextTone =
  typeof APPEARANCE_BACKGROUND_TEXT_TONES[number];

export const APPEARANCE_BACKGROUND_SKY_PERIODS = [
  'midnight',
  'dawn',
  'morning',
  'noon',
  'afternoon',
  'evening',
  'night',
] as const;
export type AppearanceBackgroundSkyPeriod =
  typeof APPEARANCE_BACKGROUND_SKY_PERIODS[number];

export type AppearanceBackgroundSettings = {
  settingsId: 'global';
  mode: AppearanceBackgroundMode;
  fixedPeriod: AppearanceBackgroundSkyPeriod;
  imageFit: AppearanceBackgroundImageFit;
  headerTextTone: AppearanceBackgroundTextTone;
  exposedLabelTextTone: AppearanceBackgroundTextTone;
  imageObjectId?: string;
};

export type AppearanceBackgroundObject = {
  slotId: 'custom';
  objectId: string;
  extension: string;
  plaintextBytes: number;
  chunkCount: number;
};

export type AppearanceBackgroundRecordValue =
  | AppearanceBackgroundSettings
  | AppearanceBackgroundObject;

export type AppearanceBackgroundMutationEnvelope = {
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

function assertBackgroundSettings(value: unknown) {
  const record = recordOf(
    value,
    'appearance.background background-settings',
  );
  assertKeys(
    record,
    [
      'settingsId',
      'mode',
      'fixedPeriod',
      'imageFit',
      'headerTextTone',
      'exposedLabelTextTone',
    ],
    ['imageObjectId'],
    'appearance.background background-settings',
  );
  expect(
    record.settingsId === 'global',
    'background-settings.settingsId 无效。',
  );
  expect(
    (APPEARANCE_BACKGROUND_MODES as readonly unknown[])
      .includes(record.mode),
    'background-settings.mode 无效。',
  );
  expect(
    (APPEARANCE_BACKGROUND_SKY_PERIODS as readonly unknown[])
      .includes(record.fixedPeriod),
    'background-settings.fixedPeriod 无效。',
  );
  expect(
    (APPEARANCE_BACKGROUND_IMAGE_FITS as readonly unknown[])
      .includes(record.imageFit),
    'background-settings.imageFit 无效。',
  );
  expect(
    (APPEARANCE_BACKGROUND_TEXT_TONES as readonly unknown[])
      .includes(record.headerTextTone)
      && (APPEARANCE_BACKGROUND_TEXT_TONES as readonly unknown[])
        .includes(record.exposedLabelTextTone),
    'background-settings 文字色调无效。',
  );
  if (record.imageObjectId !== undefined) {
    assertObjectId(
      record.imageObjectId,
      'background-settings.imageObjectId',
    );
  }
  if (record.mode === 'image') {
    assertObjectId(
      record.imageObjectId,
      'image mode imageObjectId',
    );
  }
}

function assertBackgroundObject(value: unknown) {
  const record = recordOf(
    value,
    'appearance.background background-object',
  );
  assertKeys(
    record,
    [
      'slotId',
      'objectId',
      'extension',
      'plaintextBytes',
      'chunkCount',
    ],
    [],
    'appearance.background background-object',
  );
  expect(
    record.slotId === 'custom',
    'background-object.slotId 无效。',
  );
  assertObjectId(record.objectId, 'background-object.objectId');
  expect(
    typeof record.extension === 'string'
      && /^[a-z0-9]{1,8}$/.test(record.extension),
    'background-object.extension 无效。',
  );
  assertSafeInteger(
    record.plaintextBytes,
    'background-object.plaintextBytes',
    1,
  );
  assertSafeInteger(
    record.chunkCount,
    'background-object.chunkCount',
    1,
  );
}

export function assertAppearanceBackgroundRecord(
  kind: AppearanceBackgroundRecordKind,
  value: unknown,
): asserts value is AppearanceBackgroundRecordValue {
  if (kind === 'background-settings') {
    return assertBackgroundSettings(value);
  }
  assertBackgroundObject(value);
}

export function appearanceBackgroundLocalId(
  kind: AppearanceBackgroundRecordKind,
) {
  return kind === 'background-settings' ? 'global' : 'custom';
}

export function appearanceBackgroundEntityId(
  kind: AppearanceBackgroundRecordKind,
  localId = appearanceBackgroundLocalId(kind),
) {
  return bytesToBase64Url(sha256(utf8ToBytes(
    `${APPEARANCE_BACKGROUND_ADAPTER_ID}\u0000${kind}\u0000${localId}`,
  )));
}

function objectRefsForRecord(
  kind: AppearanceBackgroundRecordKind,
  value: AppearanceBackgroundRecordValue,
) {
  if (kind === 'background-object') {
    return [(value as AppearanceBackgroundObject).objectId];
  }
  const objectId =
    (value as AppearanceBackgroundSettings).imageObjectId;
  return objectId ? [objectId] : [];
}

export function assertAppearanceBackgroundMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'appearance'
      && (
        APPEARANCE_BACKGROUND_RECORD_KINDS as readonly string[]
      ).includes(value.entity.type),
    'appearance.background mutation entity 无效。',
  );
  expect(
    value.revision.schemaVersion
      === APPEARANCE_BACKGROUND_SCHEMA_VERSION
      && value.sensitivity === 'private'
      && value.retentionClass === APPEARANCE_BACKGROUND_RETENTION,
    'appearance.background protocol metadata 无效。',
  );
  const kind =
    value.entity.type as AppearanceBackgroundRecordKind;
  const payload = recordOf(
    value.payload,
    'appearance.background payload',
  );
  assertKeys(
    payload,
    value.revision.operation === 'delete'
      ? ['schemaVersion', 'kind', 'deletedAt']
      : ['schemaVersion', 'kind', 'value'],
    [],
    'appearance.background payload',
  );
  expect(
    payload.schemaVersion === APPEARANCE_BACKGROUND_SCHEMA_VERSION
      && payload.kind === kind,
    'appearance.background payload metadata 无效。',
  );
  if (value.revision.operation === 'delete') {
    assertSafeInteger(
      payload.deletedAt,
      'appearance.background deletedAt',
      0,
    );
    expect(
      value.objectRefs.length === 0,
      'appearance.background tombstone 不能保留对象引用。',
    );
    return;
  }
  expect(
    value.revision.operation === 'upsert'
      || value.revision.operation === 'restore',
    'appearance.background 只允许 upsert、restore 或 delete。',
  );
  assertAppearanceBackgroundRecord(kind, payload.value);
  expect(
    value.entity.id === appearanceBackgroundEntityId(kind),
    'appearance.background entity id 与记录不一致。',
  );
  expect(
    JSON.stringify(value.objectRefs)
      === JSON.stringify(objectRefsForRecord(
        kind,
        payload.value as AppearanceBackgroundRecordValue,
      )),
    'appearance.background objectRefs 与记录不一致。',
  );
}

export function appearanceBackgroundMutationValue(
  mutation: PlainMutationV1,
) {
  assertAppearanceBackgroundMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  return {
    kind: payload.kind as AppearanceBackgroundRecordKind,
    value: payload.value as
      AppearanceBackgroundRecordValue | undefined,
    deletedAt: payload.deletedAt as number | undefined,
  };
}

export function buildAppearanceBackgroundUpsertMutation(input: {
  envelope: AppearanceBackgroundMutationEnvelope;
  kind: AppearanceBackgroundRecordKind;
  value: AppearanceBackgroundRecordValue;
}) {
  assertAppearanceBackgroundRecord(input.kind, input.value);
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
      id: appearanceBackgroundEntityId(input.kind),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'upsert',
      schemaVersion: APPEARANCE_BACKGROUND_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      schemaVersion: APPEARANCE_BACKGROUND_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value as JsonValue,
    },
    objectRefs: objectRefsForRecord(input.kind, input.value),
    retentionClass: APPEARANCE_BACKGROUND_RETENTION,
  };
  assertAppearanceBackgroundMutationV1(mutation);
  return mutation;
}

export function buildAppearanceBackgroundDeleteMutation(input: {
  envelope: AppearanceBackgroundMutationEnvelope;
  kind: AppearanceBackgroundRecordKind;
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
      id: appearanceBackgroundEntityId(input.kind),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: APPEARANCE_BACKGROUND_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      schemaVersion: APPEARANCE_BACKGROUND_SCHEMA_VERSION,
      kind: input.kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: APPEARANCE_BACKGROUND_RETENTION,
  };
  assertAppearanceBackgroundMutationV1(mutation);
  return mutation;
}
