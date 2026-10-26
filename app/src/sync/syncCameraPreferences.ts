import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const CAMERA_PREFERENCES_ADAPTER_ID =
  'camera.preferences' as const;
export const CAMERA_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const CAMERA_PREFERENCES_RETENTION_CLASS =
  'camera-perception-policy' as const;

export const CAMERA_PREFERENCE_FIELDS = Object.freeze([
  'intervalWindow',
  'quietHours',
  'preferredFacing',
  'sessionAuthorization',
  'rawFrameRetention',
] as const);

export type CameraPreferenceField =
  typeof CAMERA_PREFERENCE_FIELDS[number];

export type CameraPreferenceFieldValue =
  | {
      minimumIntervalMinutes: number;
      maximumIntervalMinutes: number;
    }
  | {
      enabled: boolean;
      startMinuteOfDay: number;
      endMinuteOfDay: number;
    }
  | 'front'
  | 'back'
  | 'per-device-explicit-session'
  | {
      autonomous: 'delete-after-analysis';
      manual: 'explicit-save-only';
    };

type UnknownRecord = Record<string, unknown>;
const CAMERA_PREFERENCE_FIELD_SET = new Set<string>(
  CAMERA_PREFERENCE_FIELDS,
);

function recordOf(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as UnknownRecord;
}

function assertKeys(
  value: UnknownRecord,
  required: readonly string[],
  label: string,
) {
  const allowed = new Set(required);
  const missing = required.filter((key) => !(key in value));
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || extras.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function assertIntegerRange(
  value: unknown,
  minimum: number,
  maximum: number,
  step: number,
  label: string,
) {
  if (
    !Number.isInteger(value)
    || Number(value) < minimum
    || Number(value) > maximum
    || Number(value) % step !== 0
  ) {
    throw new Error(`${label} 无效。`);
  }
}

export function isCameraPreferenceField(
  value: unknown,
): value is CameraPreferenceField {
  return typeof value === 'string'
    && CAMERA_PREFERENCE_FIELD_SET.has(value);
}

export function assertCameraPreferenceFieldValue(
  field: CameraPreferenceField,
  value: unknown,
): asserts value is CameraPreferenceFieldValue {
  if (field === 'intervalWindow') {
    const interval = recordOf(value, 'camera intervalWindow');
    assertKeys(
      interval,
      ['minimumIntervalMinutes', 'maximumIntervalMinutes'],
      'camera intervalWindow',
    );
    assertIntegerRange(
      interval.minimumIntervalMinutes,
      5,
      1440,
      5,
      'minimumIntervalMinutes',
    );
    assertIntegerRange(
      interval.maximumIntervalMinutes,
      5,
      1440,
      5,
      'maximumIntervalMinutes',
    );
    if (
      Number(interval.minimumIntervalMinutes)
      > Number(interval.maximumIntervalMinutes)
    ) {
      throw new Error('camera intervalWindow 不能反向。');
    }
    return;
  }
  if (field === 'quietHours') {
    const quiet = recordOf(value, 'camera quietHours');
    assertKeys(
      quiet,
      ['enabled', 'startMinuteOfDay', 'endMinuteOfDay'],
      'camera quietHours',
    );
    if (typeof quiet.enabled !== 'boolean') {
      throw new Error('camera quietHours.enabled 必须是 boolean。');
    }
    assertIntegerRange(
      quiet.startMinuteOfDay,
      0,
      1439,
      30,
      'quietHours.startMinuteOfDay',
    );
    assertIntegerRange(
      quiet.endMinuteOfDay,
      0,
      1439,
      30,
      'quietHours.endMinuteOfDay',
    );
    if (
      quiet.enabled
      && quiet.startMinuteOfDay === quiet.endMinuteOfDay
    ) {
      throw new Error('启用的 camera quietHours 不能首尾相同。');
    }
    return;
  }
  if (field === 'preferredFacing') {
    if (value !== 'front' && value !== 'back') {
      throw new Error('camera preferredFacing 无效。');
    }
    return;
  }
  if (field === 'sessionAuthorization') {
    if (value !== 'per-device-explicit-session') {
      throw new Error('camera sessionAuthorization 无效。');
    }
    return;
  }
  const retention = recordOf(value, 'camera rawFrameRetention');
  assertKeys(
    retention,
    ['autonomous', 'manual'],
    'camera rawFrameRetention',
  );
  if (
    retention.autonomous !== 'delete-after-analysis'
    || retention.manual !== 'explicit-save-only'
  ) {
    throw new Error('camera rawFrameRetention 无效。');
  }
}

export function cameraPreferenceMutationValue(
  mutation: PlainMutationV1,
) {
  assertCameraPreferencesMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  const record = payload.value as UnknownRecord;
  return {
    field: record.field as CameraPreferenceField,
    value: record.value as CameraPreferenceFieldValue,
  };
}

export function assertCameraPreferencesMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'camera'
    || value.entity.type !== 'perception-policy'
    || !isCameraPreferenceField(value.entity.id)
  ) {
    throw new Error('camera.preferences mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion
      !== CAMERA_PREFERENCES_SCHEMA_VERSION
    || !['upsert', 'restore'].includes(value.revision.operation)
    || value.sensitivity !== 'highest'
    || value.objectRefs.length !== 0
    || value.retentionClass
      !== CAMERA_PREFERENCES_RETENTION_CLASS
  ) {
    throw new Error('camera.preferences protocol metadata 无效。');
  }
  const payload = recordOf(
    value.payload,
    'camera.preferences payload',
  );
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    'camera.preferences payload',
  );
  if (
    payload.schemaVersion !== CAMERA_PREFERENCES_SCHEMA_VERSION
    || payload.kind !== 'camera-perception-policy-field'
  ) {
    throw new Error('camera.preferences payload metadata 无效。');
  }
  const record = recordOf(
    payload.value,
    'camera.preferences value',
  );
  assertKeys(
    record,
    ['field', 'value'],
    'camera.preferences value',
  );
  if (
    record.field !== value.entity.id
    || !isCameraPreferenceField(record.field)
  ) {
    throw new Error('camera.preferences field identity 无效。');
  }
  assertCameraPreferenceFieldValue(record.field, record.value);
  assertJsonValue(payload);
}

export function buildCameraPreferenceMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  field: CameraPreferenceField;
  value: CameraPreferenceFieldValue;
  operation?: 'upsert' | 'restore';
}) {
  assertCameraPreferenceFieldValue(input.field, input.value);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'camera',
      type: 'perception-policy',
      id: input.field,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: CAMERA_PREFERENCES_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: CAMERA_PREFERENCES_SCHEMA_VERSION,
      kind: 'camera-perception-policy-field',
      value: {
        field: input.field,
        value: input.value as JsonValue,
      },
    },
    objectRefs: [],
    retentionClass: CAMERA_PREFERENCES_RETENTION_CLASS,
  };
  assertCameraPreferencesMutationV1(mutation);
  return mutation;
}
