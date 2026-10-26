import type { ChatCoreMutationEnvelope } from './syncChatCore';
import type { SyncPlatform } from './syncDeviceContract';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const NEARBY_WORLD_HEALTH_ADAPTER_ID =
  'nearby-world.health' as const;
export const NEARBY_WORLD_HEALTH_SCHEMA_VERSION = 1 as const;
export const NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS =
  3 * 24 * 60 * 60 * 1000;
export const NEARBY_WORLD_MOVEMENT_EVENT_RETENTION_MS =
  7 * 24 * 60 * 60 * 1000;
export const NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS =
  'nearby-location-precise-3d' as const;
export const NEARBY_WORLD_PREVIOUS_LOCATION_RETENTION_CLASS =
  'nearby-location-precise-30d' as const;
export const NEARBY_WORLD_LEGACY_LOCATION_RETENTION_CLASS =
  'nearby-location-raw-180d' as const;
export const NEARBY_WORLD_LOCATION_FRESH_MS =
  45 * 60 * 1000;
export const NEARBY_WORLD_POI_FRESH_MS =
  6 * 60 * 60 * 1000;

export const NEARBY_WORLD_SETTINGS_FIELDS = Object.freeze([
  'enabled',
  'backgroundEnabled',
  'autoTogetherEnabled',
  'home',
  'poiCategories',
  'quietHours',
] as const);

export type NearbyWorldSettingsField =
  typeof NEARBY_WORLD_SETTINGS_FIELDS[number];
export type NearbyWorldSettingsFieldValue =
  | boolean
  | null
  | string[]
  | {
      latitude: number;
      longitude: number;
      label?: string;
      setAt: number;
    }
  | {
      enabled: boolean;
      startHour: number;
      endHour: number;
    };

export type NearbyWorldRecordKind =
  | 'nearby-settings-field'
  | 'nearby-location-observation'
  | 'nearby-movement-event';

export type NearbyWorldHealthPayloadV1 =
  | {
      schemaVersion: typeof NEARBY_WORLD_HEALTH_SCHEMA_VERSION;
      kind: NearbyWorldRecordKind;
      value: JsonValue;
    }
  | {
      schemaVersion: typeof NEARBY_WORLD_HEALTH_SCHEMA_VERSION;
      kind:
        | 'nearby-location-observation'
        | 'nearby-movement-event';
      deletedAt: number;
    };

export type NearbyWorldLocationObservation = {
  id: string;
  sourceDeviceId: string;
  sourcePlatform: SyncPlatform;
  observedAt: number;
  retainedUntil: number;
  locationFreshUntil: number;
  poiFreshUntil?: number;
  presence: 'unknown' | 'at_home' | 'outside';
  latitude: number;
  longitude: number;
  accuracy?: number | null;
  placeLabel?: string;
  address?: string;
  city?: string;
  district?: string;
  township?: string;
  nearbyAoi?: string;
  nearbyPoi?: string;
  nearbyRoad?: string;
  distanceFromHome?: number;
  gpsQuality?: 'excellent' | 'good' | 'fair' | 'poor';
  motionState: 'still' | 'walking' | 'transit' | 'unknown';
  poiUpdatedAt?: number;
  pois: Array<{
    id: string;
    name: string;
    category: 'food' | 'scenery' | 'leisure' | 'shopping';
    address?: string;
    type?: string;
    distance?: number;
    updatedAt: number;
  }>;
};

export type NearbyWorldOutingSegment = {
  id: string;
  outingId: string;
  firstRecordedAt: number;
  occurredAt: number;
  kind: 'movement' | 'home-location' | 'home-report';
  evidenceVersion: string;
  nearbyReference?: string;
  chatSource?: { sessionId: string; messageId: string; createdAt: number; revision: string; quote: string };
};

export type NearbyWorldMovementEvent = {
  id: string;
  sourceDeviceId: string;
  sourcePlatform: SyncPlatform;
  observedAt: number;
  kind:
    | 'arrived-home'
    | 'left-home'
    | 'location-unstable'
    | 'transit'
    | 'walking'
    | 'outing-segment';
  outing?: NearbyWorldOutingSegment;
  placeLabel?: string;
  address?: string;
  nearbyReferences: string[];
  distanceFromHome?: number;
  gpsQuality?: 'excellent' | 'good' | 'fair' | 'poor';
  movementMode: 'off' | 'walking' | 'transit';
  accuracy?: number | null;
};

type JsonRecord = Record<string, unknown>;
const SETTINGS_FIELDS = new Set<string>(NEARBY_WORLD_SETTINGS_FIELDS);
const POI_CATEGORIES = new Set([
  'food',
  'scenery',
  'leisure',
  'shopping',
]);

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function assertKeys(
  value: JsonRecord,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extras = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extras.length || missing.length) {
    throw new Error(`${label} 字段集合无效。`);
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
    throw new Error(`${label} 字符串长度无效。`);
  }
}

function assertOptionalString(
  value: unknown,
  label: string,
  maximumLength: number,
) {
  if (value !== undefined) {
    assertString(value, label, maximumLength, true);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOptionalTimestamp(value: unknown, label: string) {
  if (value !== undefined) assertTimestamp(value, label);
}

function assertFinite(value: unknown, label: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} 必须是有限数字。`);
  }
}

function assertOptionalFinite(value: unknown, label: string) {
  if (value !== undefined && value !== null) assertFinite(value, label);
}

function assertEnum(
  value: unknown,
  allowed: readonly string[],
  label: string,
) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    throw new Error(`${label} 无效。`);
  }
}

function assertSource(
  value: JsonRecord,
  sourceDeviceId: string,
) {
  if (value.sourceDeviceId !== sourceDeviceId) {
    throw new Error('nearby-world 来源设备与 mutation 不一致。');
  }
  assertEnum(value.sourcePlatform, ['android', 'windows'], 'sourcePlatform');
}

export function isNearbyWorldSettingsField(
  value: unknown,
): value is NearbyWorldSettingsField {
  return typeof value === 'string' && SETTINGS_FIELDS.has(value);
}

export function assertNearbyWorldSettingsFieldValue(
  field: NearbyWorldSettingsField,
  value: unknown,
): asserts value is NearbyWorldSettingsFieldValue {
  if (
    field === 'enabled'
    || field === 'backgroundEnabled'
    || field === 'autoTogetherEnabled'
  ) {
    if (typeof value !== 'boolean') {
      throw new Error(`${field} 必须是 boolean。`);
    }
    return;
  }
  if (field === 'home') {
    if (value === null) return;
    const home = recordOf(value, 'nearby home');
    assertKeys(home, ['latitude', 'longitude', 'setAt'], ['label'], 'nearby home');
    assertFinite(home.latitude, 'home.latitude');
    assertFinite(home.longitude, 'home.longitude');
    assertTimestamp(home.setAt, 'home.setAt');
    assertOptionalString(home.label, 'home.label', 160);
    return;
  }
  if (field === 'poiCategories') {
    if (
      !Array.isArray(value)
      || value.length < 1
      || value.length > 4
      || value.some((entry) => (
        typeof entry !== 'string' || !POI_CATEGORIES.has(entry)
      ))
      || new Set(value).size !== value.length
    ) {
      throw new Error('poiCategories 无效。');
    }
    return;
  }
  const quietHours = recordOf(value, 'nearby quietHours');
  assertKeys(
    quietHours,
    ['enabled', 'startHour', 'endHour'],
    [],
    'nearby quietHours',
  );
  if (typeof quietHours.enabled !== 'boolean') {
    throw new Error('quietHours.enabled 必须是 boolean。');
  }
  for (const key of ['startHour', 'endHour'] as const) {
    if (
      !Number.isInteger(quietHours[key])
      || Number(quietHours[key]) < 0
      || Number(quietHours[key]) > 23
    ) {
      throw new Error(`quietHours.${key} 无效。`);
    }
  }
}

export function assertNearbyWorldLocationObservation(
  value: unknown,
  entityId: string,
  sourceDeviceId: string,
): asserts value is NearbyWorldLocationObservation {
  const record = recordOf(value, 'nearby location observation');
  assertKeys(
    record,
    [
      'id',
      'sourceDeviceId',
      'sourcePlatform',
      'observedAt',
      'retainedUntil',
      'locationFreshUntil',
      'presence',
      'latitude',
      'longitude',
      'motionState',
      'pois',
    ],
    [
      'poiFreshUntil',
      'accuracy',
      'placeLabel',
      'address',
      'city',
      'district',
      'township',
      'nearbyAoi',
      'nearbyPoi',
      'nearbyRoad',
      'distanceFromHome',
      'gpsQuality',
      'poiUpdatedAt',
    ],
    'nearby location observation',
  );
  assertString(record.id, 'location observation id', 256);
  if (record.id !== entityId) {
    throw new Error('location observation id 与 entity id 不一致。');
  }
  assertSource(record, sourceDeviceId);
  assertTimestamp(record.observedAt, 'observedAt');
  assertTimestamp(record.retainedUntil, 'retainedUntil');
  assertTimestamp(record.locationFreshUntil, 'locationFreshUntil');
  assertOptionalTimestamp(record.poiFreshUntil, 'poiFreshUntil');
  if (Number(record.retainedUntil) <= Number(record.observedAt)) {
    throw new Error('retainedUntil 必须晚于 observedAt。');
  }
  assertEnum(record.presence, ['unknown', 'at_home', 'outside'], 'presence');
  assertFinite(record.latitude, 'latitude');
  assertFinite(record.longitude, 'longitude');
  assertOptionalFinite(record.accuracy, 'accuracy');
  for (const key of [
    'placeLabel',
    'city',
    'district',
    'township',
    'nearbyAoi',
    'nearbyPoi',
    'nearbyRoad',
  ] as const) {
    assertOptionalString(record[key], key, 160);
  }
  assertOptionalString(record.address, 'address', 320);
  assertOptionalFinite(record.distanceFromHome, 'distanceFromHome');
  if (record.gpsQuality !== undefined) {
    assertEnum(record.gpsQuality, ['excellent', 'good', 'fair', 'poor'], 'gpsQuality');
  }
  assertEnum(record.motionState, ['still', 'walking', 'transit', 'unknown'], 'motionState');
  assertOptionalTimestamp(record.poiUpdatedAt, 'poiUpdatedAt');
  if (!Array.isArray(record.pois) || record.pois.length > 40) {
    throw new Error('pois 数组无效。');
  }
  record.pois.forEach((entry, index) => {
    const poi = recordOf(entry, `pois[${index}]`);
    assertKeys(
      poi,
      ['id', 'name', 'category', 'updatedAt'],
      ['address', 'type', 'distance'],
      `pois[${index}]`,
    );
    assertString(poi.id, `pois[${index}].id`, 160);
    assertString(poi.name, `pois[${index}].name`, 160);
    assertEnum(poi.category, [...POI_CATEGORIES], `pois[${index}].category`);
    assertTimestamp(poi.updatedAt, `pois[${index}].updatedAt`);
    assertOptionalString(poi.address, `pois[${index}].address`, 320);
    assertOptionalString(poi.type, `pois[${index}].type`, 160);
    assertOptionalFinite(poi.distance, `pois[${index}].distance`);
  });
}

export function normalizeNearbyWorldLocationRetention(
  value: NearbyWorldLocationObservation,
): NearbyWorldLocationObservation {
  const retainedUntil = Math.min(
    value.retainedUntil,
    value.observedAt + NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS,
  );
  return retainedUntil === value.retainedUntil
    ? value
    : { ...value, retainedUntil };
}

export function assertNearbyWorldOutingSegment(value: unknown): asserts value is NearbyWorldOutingSegment {
  const segment = recordOf(value, 'outing segment');
  assertKeys(segment, ['id', 'outingId', 'firstRecordedAt', 'occurredAt', 'kind', 'evidenceVersion'],
    ['nearbyReference', 'chatSource'], 'outing segment');
  for (const key of ['id', 'outingId', 'evidenceVersion']) assertString(segment[key], key, 512);
  for (const key of ['firstRecordedAt', 'occurredAt']) assertTimestamp(segment[key], key);
  if (Number(segment.firstRecordedAt) > Number(segment.occurredAt)) throw new Error('outing time order');
  assertEnum(segment.kind, ['movement', 'home-location', 'home-report'], 'outing kind');
  // These are already saved source strings, not the legacy queue's compact labels.
  // Transport must preserve their complete text; the first-paper capacity gate decides inclusion.
  if (segment.nearbyReference !== undefined) assertString(segment.nearbyReference, 'outing nearby reference', Number.MAX_SAFE_INTEGER);
  if (segment.kind === 'home-report') {
    const source = recordOf(segment.chatSource, 'outing chat source');
    assertKeys(source, ['sessionId', 'messageId', 'createdAt', 'revision', 'quote'], [], 'outing chat source');
    for (const key of ['sessionId', 'messageId', 'revision']) assertString(source[key], key, 512);
    assertString(source.quote, 'outing quote', Number.MAX_SAFE_INTEGER);
    assertTimestamp(source.createdAt, 'outing source time');
    if (source.createdAt !== segment.occurredAt) throw new Error('outing chat time mismatch');
  } else if (segment.chatSource !== undefined) throw new Error('outing non-chat source');
}

export function assertNearbyWorldMovementEvent(
  value: unknown,
  entityId: string,
  sourceDeviceId: string,
): asserts value is NearbyWorldMovementEvent {
  const record = recordOf(value, 'nearby movement event');
  assertKeys(
    record,
    [
      'id',
      'sourceDeviceId',
      'sourcePlatform',
      'observedAt',
      'kind',
      'nearbyReferences',
      'movementMode',
    ],
    [
      'placeLabel',
      'address',
      'distanceFromHome',
      'gpsQuality',
      'accuracy',
      'outing',
    ],
    'nearby movement event',
  );
  assertString(record.id, 'movement event id', 256);
  if (record.id !== entityId) {
    throw new Error('movement event id 与 entity id 不一致。');
  }
  assertSource(record, sourceDeviceId);
  assertTimestamp(record.observedAt, 'movement observedAt');
  assertEnum(
    record.kind,
    ['arrived-home', 'left-home', 'location-unstable', 'transit', 'walking', 'outing-segment'],
    'movement kind',
  );
  assertOptionalString(record.placeLabel, 'movement placeLabel', 160);
  assertOptionalString(record.address, 'movement address', 320);
  if (
    !Array.isArray(record.nearbyReferences)
    || record.nearbyReferences.length > 4
  ) {
    throw new Error('movement nearbyReferences 无效。');
  }
  record.nearbyReferences.forEach((entry, index) => {
    assertString(entry, `movement nearbyReferences[${index}]`, 160);
  });
  assertOptionalFinite(record.distanceFromHome, 'movement distanceFromHome');
  if (record.gpsQuality !== undefined) {
    assertEnum(record.gpsQuality, ['excellent', 'good', 'fair', 'poor'], 'movement gpsQuality');
  }
  assertEnum(record.movementMode, ['off', 'walking', 'transit'], 'movementMode');
  assertOptionalFinite(record.accuracy, 'movement accuracy');
  if (record.kind === 'outing-segment') {
    assertNearbyWorldOutingSegment(record.outing);
    if (record.outing.id !== record.id || record.outing.occurredAt !== record.observedAt
      || record.movementMode !== 'off' || (record.nearbyReferences as unknown[]).length !== 0
      || ['address', 'placeLabel', 'distanceFromHome', 'gpsQuality', 'accuracy'].some(key => key in record)) {
      throw new Error('outing envelope mismatch');
    }
  } else if (record.outing !== undefined) throw new Error('legacy movement cannot claim outing');
}

export function assertNearbyWorldHealthMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'nearby-world'
    || !['settings', 'location-observation', 'movement-event'].includes(
      value.entity.type,
    )
  ) {
    throw new Error('nearby-world.health mutation entity 无效。');
  }
  if (
    value.revision.schemaVersion !== NEARBY_WORLD_HEALTH_SCHEMA_VERSION
    || value.sensitivity !== 'highest'
    || value.objectRefs.length
  ) {
    throw new Error('nearby-world.health protocol metadata 无效。');
  }
  const payload = recordOf(value.payload, 'nearby-world.health payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'kind', 'deletedAt'],
      [],
      'nearby-world.health tombstone',
    );
    const validLocation =
      payload.kind === 'nearby-location-observation'
      && value.entity.type === 'location-observation'
      && value.retentionClass
        === NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS;
    const validMovement =
      payload.kind === 'nearby-movement-event'
      && value.entity.type === 'movement-event'
      && value.retentionClass === 'nearby-movement-history';
    if (
      payload.schemaVersion !== NEARBY_WORLD_HEALTH_SCHEMA_VERSION
      || (!validLocation && !validMovement)
    ) {
      throw new Error('nearby-world tombstone metadata 无效。');
    }
    assertTimestamp(payload.deletedAt, 'nearby-world deletedAt');
    assertJsonValue(payload);
    return;
  }
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'value'],
    [],
    'nearby-world.health payload',
  );
  if (payload.schemaVersion !== NEARBY_WORLD_HEALTH_SCHEMA_VERSION) {
    throw new Error('nearby-world.health payload schemaVersion 无效。');
  }
  if (payload.kind === 'nearby-settings-field') {
    if (
      value.entity.type !== 'settings'
      || !isNearbyWorldSettingsField(value.entity.id)
      || !['upsert', 'restore'].includes(value.revision.operation)
      || value.retentionClass !== 'nearby-settings'
    ) {
      throw new Error('nearby settings mutation metadata 无效。');
    }
    const setting = recordOf(payload.value, 'nearby settings value');
    assertKeys(setting, ['field', 'value'], [], 'nearby settings value');
    if (
      setting.field !== value.entity.id
      || !isNearbyWorldSettingsField(setting.field)
    ) {
      throw new Error('nearby settings field identity 无效。');
    }
    assertNearbyWorldSettingsFieldValue(setting.field, setting.value);
  } else if (payload.kind === 'nearby-location-observation') {
    const isCurrentRetentionClass =
      value.retentionClass === NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS;
    if (
      value.entity.type !== 'location-observation'
      || value.revision.operation !== 'append'
      || (
        !isCurrentRetentionClass
        && value.retentionClass !== NEARBY_WORLD_PREVIOUS_LOCATION_RETENTION_CLASS
        && value.retentionClass !== NEARBY_WORLD_LEGACY_LOCATION_RETENTION_CLASS
      )
    ) {
      throw new Error('nearby location mutation metadata 无效。');
    }
    assertNearbyWorldLocationObservation(
      payload.value,
      value.entity.id,
      value.sourceDeviceId,
    );
    if (
      isCurrentRetentionClass
      && payload.value.retainedUntil - payload.value.observedAt
        > NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS
    ) {
      throw new Error('精确位置留存期不得超过 3 天。');
    }
  } else if (payload.kind === 'nearby-movement-event') {
    if (
      value.entity.type !== 'movement-event'
      || value.revision.operation !== 'append'
      || value.retentionClass !== 'nearby-movement-history'
    ) {
      throw new Error('nearby movement mutation metadata 无效。');
    }
    assertNearbyWorldMovementEvent(
      payload.value,
      value.entity.id,
      value.sourceDeviceId,
    );
  } else {
    throw new Error('nearby-world.health record kind 无效。');
  }
  assertJsonValue(payload);
}

export function buildNearbyWorldHealthMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: 'settings' | 'location-observation' | 'movement-event';
  entityId: string;
  kind: NearbyWorldRecordKind;
  value: JsonValue;
  operation: 'append' | 'upsert' | 'restore';
  retentionClass:
    | 'nearby-settings'
    | typeof NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS
    | 'nearby-movement-history';
}) {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'nearby-world',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation,
      schemaVersion: NEARBY_WORLD_HEALTH_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: NEARBY_WORLD_HEALTH_SCHEMA_VERSION,
      kind: input.kind,
      value: input.value,
    },
    objectRefs: [],
    retentionClass: input.retentionClass,
  };
  assertNearbyWorldHealthMutationV1(mutation);
  return mutation;
}

export function buildNearbyWorldHealthDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityId: string;
  deletedAt: number;
  kind?: 'nearby-location-observation' | 'nearby-movement-event';
}) {
  const kind = input.kind ?? 'nearby-location-observation';
  const entityType = kind === 'nearby-location-observation'
    ? 'location-observation'
    : 'movement-event';
  const retentionClass = kind === 'nearby-location-observation'
    ? NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS
    : 'nearby-movement-history';
  assertString(input.entityId, 'nearby-world entityId', 256);
  assertTimestamp(input.deletedAt, 'nearby-world deletedAt');
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'nearby-world',
      type: entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'delete',
      schemaVersion: NEARBY_WORLD_HEALTH_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: {
      schemaVersion: NEARBY_WORLD_HEALTH_SCHEMA_VERSION,
      kind,
      deletedAt: input.deletedAt,
    },
    objectRefs: [],
    retentionClass,
  };
  assertNearbyWorldHealthMutationV1(mutation);
  return mutation;
}
