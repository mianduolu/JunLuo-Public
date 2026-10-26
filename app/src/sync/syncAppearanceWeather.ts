import { sha256 } from '@noble/hashes/sha2.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

import { bytesToBase64Url } from './syncBase64Url';

import type { WeatherKind, WeatherObservationSource } from '../types/weather';
import {
  WEATHER_ANIMATION_STYLE_DEFINITION,
} from '../weather/weatherAnimationStyle';
import {
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const APPEARANCE_WEATHER_ADAPTER_ID =
  'appearance.weather' as const;
export const APPEARANCE_WEATHER_SCHEMA_VERSION = 1 as const;
export const APPEARANCE_WEATHER_PREFERENCE_RETENTION =
  'appearance-weather-preference-long-term' as const;
export const APPEARANCE_WEATHER_OBSERVATION_RETENTION =
  'appearance-weather-observation-short-lived' as const;
export const APPEARANCE_WEATHER_OBSERVATION_RETENTION_MS =
  2 * 60 * 60 * 1000;

export const APPEARANCE_WEATHER_RECORD_KINDS = [
  'weather-animation-policy',
  'weather-style',
  'weather-observation',
] as const;
export type AppearanceWeatherRecordKind =
  typeof APPEARANCE_WEATHER_RECORD_KINDS[number];

export const APPEARANCE_WEATHER_KINDS = [
  'clear',
  'cloudy',
  'rain',
  'thunderstorm',
  'snow',
  'hail',
  'fog',
  'dust',
] as const satisfies readonly Exclude<
  WeatherKind,
  'unknown'
>[];

export const APPEARANCE_WEATHER_OBSERVATION_SOURCES = [
  'open-meteo',
  'wttr',
  'legacy-normalized',
] as const satisfies readonly WeatherObservationSource[];

export type AppearanceWeatherAnimationPolicy = {
  policyId: 'global';
  enabled: boolean;
};

export type AppearanceWeatherStyle = {
  styleId: 'junluo-procedural-weather';
  definition: JsonValue;
};

export type AppearanceWeatherObservation = {
  observationId: string;
  kind: Exclude<WeatherKind, 'unknown'>;
  label: string;
  placeLabel?: string;
  temperature?: number;
  source: WeatherObservationSource;
  observedAt: number;
  fetchedAt: number;
  expiresAt: number;
};

export type AppearanceWeatherRecordValue =
  | AppearanceWeatherAnimationPolicy
  | AppearanceWeatherStyle
  | AppearanceWeatherObservation;

export type AppearanceWeatherMutationEnvelope = {
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) =>
      `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(',')}}`;
}

function assertSafeTimestamp(value: unknown, label: string) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${label} 无效。`,
  );
}

function assertText(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  expect(
    typeof value === 'string'
      && value.trim().length > 0
      && value.length <= maximumLength,
    `${label} 无效。`,
  );
}

function assertAnimationPolicy(value: unknown) {
  const record = recordOf(value, 'weather-animation-policy');
  assertKeys(
    record,
    ['policyId', 'enabled'],
    [],
    'weather-animation-policy',
  );
  expect(
    record.policyId === 'global'
      && typeof record.enabled === 'boolean',
    'weather-animation-policy 值无效。',
  );
}

function assertWeatherStyle(value: unknown) {
  const record = recordOf(value, 'weather-style');
  assertKeys(
    record,
    ['styleId', 'definition'],
    [],
    'weather-style',
  );
  expect(
    record.styleId === WEATHER_ANIMATION_STYLE_DEFINITION.styleId,
    'weather-style.styleId 无效。',
  );
  expect(
    canonicalJson(record.definition)
      === canonicalJson(WEATHER_ANIMATION_STYLE_DEFINITION),
    'weather-style.definition 与当前完整效果定义不一致。',
  );
}

function assertWeatherObservation(value: unknown) {
  const record = recordOf(value, 'weather-observation');
  assertKeys(
    record,
    [
      'observationId',
      'kind',
      'label',
      'source',
      'observedAt',
      'fetchedAt',
      'expiresAt',
    ],
    ['placeLabel', 'temperature'],
    'weather-observation',
  );
  expect(
    typeof record.observationId === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(record.observationId),
    'weather-observation.observationId 无效。',
  );
  expect(
    (APPEARANCE_WEATHER_KINDS as readonly unknown[])
      .includes(record.kind),
    'weather-observation.kind 无效。',
  );
  assertText(record.label, 'weather-observation.label', 120);
  if (record.placeLabel !== undefined) {
    assertText(
      record.placeLabel,
      'weather-observation.placeLabel',
      160,
    );
  }
  if (record.temperature !== undefined) {
    expect(
      typeof record.temperature === 'number'
        && Number.isFinite(record.temperature)
        && record.temperature >= -100
        && record.temperature <= 100,
      'weather-observation.temperature 无效。',
    );
  }
  expect(
    (
      APPEARANCE_WEATHER_OBSERVATION_SOURCES as readonly unknown[]
    ).includes(record.source),
    'weather-observation.source 无效。',
  );
  assertSafeTimestamp(
    record.observedAt,
    'weather-observation.observedAt',
  );
  assertSafeTimestamp(
    record.fetchedAt,
    'weather-observation.fetchedAt',
  );
  assertSafeTimestamp(
    record.expiresAt,
    'weather-observation.expiresAt',
  );
  expect(
    Number(record.fetchedAt) >= Number(record.observedAt)
      && Number(record.expiresAt)
        === Number(record.fetchedAt)
          + APPEARANCE_WEATHER_OBSERVATION_RETENTION_MS,
    'weather-observation 时间顺序无效。',
  );
  const expectedId = appearanceWeatherObservationId({
    source: record.source as WeatherObservationSource,
    observedAt: Number(record.observedAt),
    kind: record.kind as Exclude<WeatherKind, 'unknown'>,
    ...(
      typeof record.placeLabel === 'string'
        ? { placeLabel: record.placeLabel }
        : {}
    ),
  });
  expect(
    record.observationId === expectedId,
    'weather-observation.observationId 与正式观察身份不一致。',
  );
}

export function assertAppearanceWeatherRecord(
  kind: AppearanceWeatherRecordKind,
  value: unknown,
): asserts value is AppearanceWeatherRecordValue {
  if (kind === 'weather-animation-policy') {
    return assertAnimationPolicy(value);
  }
  if (kind === 'weather-style') return assertWeatherStyle(value);
  assertWeatherObservation(value);
}

export function appearanceWeatherEntityId(
  kind: AppearanceWeatherRecordKind,
  localId: string,
) {
  return bytesToBase64Url(sha256(utf8ToBytes(
    `${APPEARANCE_WEATHER_ADAPTER_ID}\u0000${kind}\u0000${localId}`,
  )));
}

export function appearanceWeatherObservationId(input: {
  source: WeatherObservationSource;
  observedAt: number;
  kind: Exclude<WeatherKind, 'unknown'>;
  placeLabel?: string;
}) {
  return bytesToBase64Url(sha256(utf8ToBytes([
    input.source,
    String(input.observedAt),
    input.kind,
    input.placeLabel ?? '',
  ].join('\u0000'))));
}

function retentionForKind(kind: AppearanceWeatherRecordKind) {
  return kind === 'weather-observation'
    ? APPEARANCE_WEATHER_OBSERVATION_RETENTION
    : APPEARANCE_WEATHER_PREFERENCE_RETENTION;
}

export function assertAppearanceWeatherMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  expect(
    value.entity.domain === 'appearance'
      && (
        APPEARANCE_WEATHER_RECORD_KINDS as readonly string[]
      ).includes(value.entity.type),
    'appearance.weather mutation entity 无效。',
  );
  const kind = value.entity.type as AppearanceWeatherRecordKind;
  expect(
    value.revision.schemaVersion
      === APPEARANCE_WEATHER_SCHEMA_VERSION
      && value.sensitivity === 'private'
      && value.retentionClass === retentionForKind(kind),
    'appearance.weather mutation schema/sensitivity/retention 无效。',
  );
  expect(
    value.objectRefs.length === 0,
    'appearance.weather 当前程序化效果不得伪造文件对象引用。',
  );
  const payload = recordOf(value.payload, 'appearance.weather payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['kind', 'deletedAt'],
      [],
      'appearance.weather delete payload',
    );
    expect(payload.kind === kind, 'appearance.weather delete kind 错配。');
    assertSafeTimestamp(payload.deletedAt, 'deletedAt');
    return;
  }
  assertKeys(
    payload,
    ['kind', 'value'],
    [],
    'appearance.weather upsert payload',
  );
  expect(payload.kind === kind, 'appearance.weather payload kind 错配。');
  assertAppearanceWeatherRecord(kind, payload.value);
  const localId = kind === 'weather-animation-policy'
    ? 'global'
    : kind === 'weather-style'
      ? WEATHER_ANIMATION_STYLE_DEFINITION.styleId
      : (payload.value as AppearanceWeatherObservation).observationId;
  expect(
    value.entity.id === appearanceWeatherEntityId(kind, localId),
    'appearance.weather entity id 与记录不一致。',
  );
}

export function appearanceWeatherMutationValue(
  mutation: PlainMutationV1,
) {
  assertAppearanceWeatherMutationV1(mutation);
  const payload = mutation.payload as UnknownRecord;
  return {
    kind: payload.kind as AppearanceWeatherRecordKind,
    value: payload.value as AppearanceWeatherRecordValue | undefined,
    deletedAt: payload.deletedAt as number | undefined,
  };
}

export function buildAppearanceWeatherUpsertMutation(input: {
  envelope: AppearanceWeatherMutationEnvelope;
  kind: AppearanceWeatherRecordKind;
  value: AppearanceWeatherRecordValue;
}) {
  assertAppearanceWeatherRecord(input.kind, input.value);
  const localId = input.kind === 'weather-animation-policy'
    ? 'global'
    : input.kind === 'weather-style'
      ? WEATHER_ANIMATION_STYLE_DEFINITION.styleId
      : (input.value as AppearanceWeatherObservation).observationId;
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
      id: appearanceWeatherEntityId(input.kind, localId),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: 'upsert',
      schemaVersion: APPEARANCE_WEATHER_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: retentionForKind(input.kind),
  };
  assertAppearanceWeatherMutationV1(mutation);
  return mutation;
}

export function buildAppearanceWeatherDeleteMutation(input: {
  envelope: AppearanceWeatherMutationEnvelope;
  kind: AppearanceWeatherRecordKind;
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
      id: appearanceWeatherEntityId(input.kind, input.localId),
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: 'delete',
      schemaVersion: APPEARANCE_WEATHER_SCHEMA_VERSION,
    },
    sensitivity: 'private',
    payload: {
      kind: input.kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass: retentionForKind(input.kind),
  };
  assertAppearanceWeatherMutationV1(mutation);
  return mutation;
}
