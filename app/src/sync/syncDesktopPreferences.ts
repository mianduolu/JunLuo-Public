import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const DESKTOP_PREFERENCES_ADAPTER_ID =
  'desktop.preferences' as const;
export const DESKTOP_PREFERENCES_SCHEMA_VERSION = 1 as const;
export const DESKTOP_PREFERENCES_RETENTION_CLASS =
  'desktop-preferences-long-term' as const;

export const DESKTOP_PREFERENCE_RECORD_KINDS = [
  'window-policy',
  'tray-policy',
  'autostart-policy',
  'focus-companion-policy',
] as const;

export type DesktopPreferenceRecordKind =
  typeof DESKTOP_PREFERENCE_RECORD_KINDS[number];

export const DESKTOP_PREFERENCE_FIELDS = {
  'window-policy': [
    'sizeClass',
    'launchMode',
    'rememberPlacement',
  ],
  'tray-policy': [
    'enabled',
    'closeBehavior',
    'launchHidden',
  ],
  'autostart-policy': [
    'enabled',
    'launchMode',
  ],
  'focus-companion-policy': [
    'idleMinutes',
    'defaultLeaveMinutes',
    'growthDelaySeconds',
    'growthFillSeconds',
  ],
} as const;

export type DesktopPreferenceField =
  typeof DESKTOP_PREFERENCE_FIELDS[
    DesktopPreferenceRecordKind
  ][number];

export type DesktopPreferenceFieldValue =
  | boolean
  | number
  | 'compact'
  | 'comfortable'
  | 'spacious'
  | 'restore'
  | 'normal'
  | 'maximized'
  | 'hide-to-tray'
  | 'quit'
  | 'tray';

export type DesktopPreferenceRecord = {
  kind: DesktopPreferenceRecordKind;
  field: DesktopPreferenceField;
  value: DesktopPreferenceFieldValue;
};

export type DesktopPreferencesMutationEnvelope = {
  mutationId: string;
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  revisionId: string;
  parentRevisionIds: string[];
  createdAt: number;
};

type UnknownRecord = Record<string, unknown>;

function expect(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): UnknownRecord {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as UnknownRecord;
}

function assertKeys(
  value: UnknownRecord,
  required: readonly string[],
  label: string,
) {
  const allowed = new Set(required);
  expect(
    required.every((key) => key in value)
      && Object.keys(value).every((key) => allowed.has(key)),
    `${label} 字段集合无效。`,
  );
}

export function isDesktopPreferenceKind(
  value: unknown,
): value is DesktopPreferenceRecordKind {
  return typeof value === 'string'
    && (
      DESKTOP_PREFERENCE_RECORD_KINDS as readonly string[]
    ).includes(value);
}

export function isDesktopPreferenceField(
  kind: DesktopPreferenceRecordKind,
  value: unknown,
): value is DesktopPreferenceField {
  return typeof value === 'string'
    && (
      DESKTOP_PREFERENCE_FIELDS[kind] as readonly string[]
    ).includes(value);
}

function assertIntegerPreference(
  value: unknown,
  label: string,
) {
  expect(
    Number.isInteger(value)
      && Number(value) >= 1
      && Number(value) <= 999,
    `${label} 无效。`,
  );
}

export function assertDesktopPreferenceRecord(
  value: unknown,
): asserts value is DesktopPreferenceRecord {
  const record = recordOf(value, 'desktop preference');
  assertKeys(
    record,
    ['kind', 'field', 'value'],
    'desktop preference',
  );
  expect(
    isDesktopPreferenceKind(record.kind),
    'desktop preference.kind 无效。',
  );
  const kind = record.kind;
  expect(
    isDesktopPreferenceField(kind, record.field),
    'desktop preference.field 无效。',
  );
  const field = record.field;
  const preference = record.value;

  if (kind === 'window-policy') {
    if (field === 'sizeClass') {
      expect(
        ['compact', 'comfortable', 'spacious']
          .includes(String(preference)),
        'desktop window sizeClass 无效。',
      );
      return;
    }
    if (field === 'launchMode') {
      expect(
        ['restore', 'normal', 'maximized']
          .includes(String(preference)),
        'desktop window launchMode 无效。',
      );
      return;
    }
    expect(
      typeof preference === 'boolean',
      'desktop window rememberPlacement 无效。',
    );
    return;
  }

  if (kind === 'tray-policy') {
    if (field === 'closeBehavior') {
      expect(
        preference === 'hide-to-tray' || preference === 'quit',
        'desktop tray closeBehavior 无效。',
      );
      return;
    }
    expect(
      typeof preference === 'boolean',
      `desktop tray ${field} 无效。`,
    );
    return;
  }

  if (kind === 'autostart-policy') {
    if (field === 'launchMode') {
      expect(
        preference === 'normal' || preference === 'tray',
        'desktop autostart launchMode 无效。',
      );
      return;
    }
    expect(
      typeof preference === 'boolean',
      'desktop autostart enabled 无效。',
    );
    return;
  }

  assertIntegerPreference(
    preference,
    `desktop focus companion ${field}`,
  );
}

export function assertDesktopPreferencesMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'desktop'
      && isDesktopPreferenceKind(value.entity.type)
      && isDesktopPreferenceField(
        value.entity.type as DesktopPreferenceRecordKind,
        value.entity.id,
      ),
    'desktop.preferences mutation entity 无效。',
  );
  expect(
    value.revision.schemaVersion
      === DESKTOP_PREFERENCES_SCHEMA_VERSION
      && ['upsert', 'restore'].includes(
        value.revision.operation,
      )
      && value.sensitivity === 'private'
      && value.objectRefs.length === 0
      && value.retentionClass
        === DESKTOP_PREFERENCES_RETENTION_CLASS,
    'desktop.preferences protocol metadata 无效。',
  );
  const payload = recordOf(
    value.payload,
    'desktop.preferences payload',
  );
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    'desktop.preferences payload',
  );
  expect(
    payload.schemaVersion === DESKTOP_PREFERENCES_SCHEMA_VERSION
      && payload.kind === 'desktop-preference-field',
    'desktop.preferences payload metadata 无效。',
  );
  assertDesktopPreferenceRecord(payload.value);
  const record = payload.value as DesktopPreferenceRecord;
  expect(
    record.kind === value.entity.type
      && record.field === value.entity.id,
    'desktop.preferences field identity 无效。',
  );
  assertJsonValue(payload);
}

export function desktopPreferenceMutationValue(
  mutation: PlainMutationV1,
) {
  assertDesktopPreferencesMutationV1(mutation);
  return (
    mutation.payload as UnknownRecord
  ).value as DesktopPreferenceRecord;
}

export function buildDesktopPreferenceMutation(input: {
  envelope: DesktopPreferencesMutationEnvelope;
  record: DesktopPreferenceRecord;
  operation?: 'upsert' | 'restore';
}) {
  assertDesktopPreferenceRecord(input.record);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'desktop',
      type: input.record.kind,
      id: input.record.field,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation ?? 'upsert',
      schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      schemaVersion: DESKTOP_PREFERENCES_SCHEMA_VERSION,
      kind: 'desktop-preference-field',
      value: input.record as unknown as JsonValue,
    },
    objectRefs: [],
    retentionClass: DESKTOP_PREFERENCES_RETENTION_CLASS,
  };
  assertDesktopPreferencesMutationV1(mutation);
  return mutation;
}
