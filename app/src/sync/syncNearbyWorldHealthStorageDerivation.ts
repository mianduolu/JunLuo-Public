import type { NearbyWorldActiveEvent } from '../nearby/nearbyWorldActiveEvents';
import type {
  NearbyWorldSettings,
  NearbyWorldStatus,
} from '../nearby/nearbyWorldStore';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import type { SyncPlatform } from './syncDeviceContract';
import {
  buildNearbyWorldHealthMutation,
  buildNearbyWorldHealthDeleteMutation,
  assertNearbyWorldOutingSegment,
  NEARBY_WORLD_LOCATION_FRESH_MS,
  NEARBY_WORLD_POI_FRESH_MS,
  NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS,
  NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS,
  NEARBY_WORLD_SETTINGS_FIELDS,
  type NearbyWorldLocationObservation,
  type NearbyWorldMovementEvent,
  type NearbyWorldSettingsField,
  type NearbyWorldSettingsFieldValue,
} from './syncNearbyWorldHealth';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export const NEARBY_WORLD_SYNC_SETTINGS_KEY =
  'junluo.nearbyWorld.settings.v1' as const;
export const NEARBY_WORLD_SYNC_STATUS_KEY =
  'junluo.nearbyWorld.status.v1' as const;
export const NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY =
  'junluo.nearbyWorld.activeEvents.v1' as const;
export const NEARBY_WORLD_REMOTE_OBSERVATIONS_KEY =
  'junluo.nearbyWorld.sharedObservations.v1' as const;
export const NEARBY_WORLD_REMOTE_EVENTS_KEY =
  'junluo.nearbyWorld.sharedMovementEvents.v1' as const;

export const NEARBY_WORLD_HEALTH_GLOBAL_KEYS = Object.freeze([
  NEARBY_WORLD_SYNC_SETTINGS_KEY,
  NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY,
] as const);

const FORMAL_LOCATION_SAMPLE_MS = 5 * 60 * 1000;
const FORMAL_LOCATION_DISTANCE_METERS = 50;

export type NearbyWorldStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type NearbyWorldStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type NearbyWorldEnvelopeFactory = (
  entity: {
    domain: 'nearby-world';
    type: 'settings' | 'location-observation' | 'movement-event';
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

type ProjectedRecord = {
  entityType: 'settings' | 'location-observation' | 'movement-event';
  entityId: string;
  kind:
    | 'nearby-settings-field'
    | 'nearby-location-observation'
    | 'nearby-movement-event';
  value: JsonValue;
  operation: 'append' | 'upsert';
  retentionClass:
    | 'nearby-settings'
    | typeof NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS
    | 'nearby-movement-history';
};

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function parseJson(raw: string, label: string) {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function jsonValue<T>(value: T): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function timestamp(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function text(value: unknown, maximumLength: number) {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact ? compact.slice(0, maximumLength) : undefined;
}

function platform(value: SyncPlatform) {
  return value;
}

function normalizeSettings(raw: string) {
  const input = recordOf(parseJson(raw, 'nearby settings'), 'nearby settings');
  const quiet = input.quietHours && typeof input.quietHours === 'object'
    && !Array.isArray(input.quietHours)
    ? input.quietHours as Record<string, unknown>
    : {};
  const categories = Array.isArray(input.poiCategories)
    ? [...new Set(input.poiCategories.filter(
        (entry): entry is string => (
          entry === 'food'
          || entry === 'scenery'
          || entry === 'leisure'
          || entry === 'shopping'
        ),
      ))]
    : ['food', 'scenery', 'leisure', 'shopping'];
  const homeInput = input.home && typeof input.home === 'object'
    && !Array.isArray(input.home)
    ? input.home as Record<string, unknown>
    : null;
  const home = homeInput
    && finite(homeInput.latitude) !== undefined
    && finite(homeInput.longitude) !== undefined
    ? {
        latitude: finite(homeInput.latitude)!,
        longitude: finite(homeInput.longitude)!,
        ...(text(homeInput.label, 160)
          ? { label: text(homeInput.label, 160) }
          : {}),
        setAt: timestamp(homeInput.setAt) ?? 0,
      }
    : null;
  return {
    enabled: input.enabled !== false,
    backgroundEnabled: input.backgroundEnabled === true,
    autoTogetherEnabled: input.autoTogetherEnabled !== false,
    home,
    poiCategories: categories.length
      ? categories
      : ['food', 'scenery', 'leisure', 'shopping'],
    quietHours: {
      enabled: quiet.enabled !== false,
      startHour: Number.isInteger(quiet.startHour)
        ? Math.max(0, Math.min(23, Number(quiet.startHour)))
        : 23,
      endHour: Number.isInteger(quiet.endHour)
        ? Math.max(0, Math.min(23, Number(quiet.endHour)))
        : 8,
    },
  } satisfies Record<NearbyWorldSettingsField, NearbyWorldSettingsFieldValue>;
}

function projectSettings(raw: string): ProjectedRecord[] {
  const settings = normalizeSettings(raw);
  return NEARBY_WORLD_SETTINGS_FIELDS.map((field) => ({
    entityType: 'settings' as const,
    entityId: field,
    kind: 'nearby-settings-field' as const,
    value: jsonValue({
      field,
      value: settings[field],
    }),
    operation: 'upsert' as const,
    retentionClass: 'nearby-settings' as const,
  }));
}

function normalizePoi(value: unknown) {
  const input = recordOf(value, 'nearby poi');
  const id = text(input.id, 160);
  const name = text(input.name, 160);
  const category = input.category;
  const updatedAt = timestamp(input.updatedAt);
  if (
    !id
    || !name
    || !['food', 'scenery', 'leisure', 'shopping'].includes(
      String(category),
    )
    || updatedAt === undefined
  ) {
    throw new Error('nearby poi identity 无效。');
  }
  return {
    id,
    name,
    category: category as 'food' | 'scenery' | 'leisure' | 'shopping',
    ...(text(input.address, 320) ? { address: text(input.address, 320) } : {}),
    ...(text(input.type, 160) ? { type: text(input.type, 160) } : {}),
    ...(finite(input.distance) !== undefined
      ? { distance: finite(input.distance) }
      : {}),
    updatedAt,
  };
}

function projectLocation(
  raw: string,
  sourceDeviceId: string,
  sourcePlatform: SyncPlatform,
): ProjectedRecord[] {
  const status = recordOf(parseJson(raw, 'nearby status'), 'nearby status');
  const observedAt = timestamp(status.updatedAt);
  const latitude = finite(status.latitude);
  const longitude = finite(status.longitude);
  if (
    observedAt === undefined
    || latitude === undefined
    || longitude === undefined
  ) {
    return [];
  }
  const poiUpdatedAt = timestamp(status.poiUpdatedAt);
  const entityId = `nearby-location:${sourceDeviceId}:${observedAt}`;
  const value: NearbyWorldLocationObservation = {
    id: entityId,
    sourceDeviceId,
    sourcePlatform: platform(sourcePlatform),
    observedAt,
    retainedUntil:
      observedAt + NEARBY_WORLD_PRECISE_LOCATION_RETENTION_MS,
    locationFreshUntil: observedAt + NEARBY_WORLD_LOCATION_FRESH_MS,
    ...(poiUpdatedAt !== undefined
      ? {
          poiUpdatedAt,
          poiFreshUntil: poiUpdatedAt + NEARBY_WORLD_POI_FRESH_MS,
        }
      : {}),
    presence: status.presence === 'at_home' || status.presence === 'outside'
      ? status.presence
      : 'unknown',
    latitude,
    longitude,
    ...(status.accuracy === null
      ? { accuracy: null }
      : finite(status.accuracy) !== undefined
        ? { accuracy: finite(status.accuracy) }
        : {}),
    ...(text(status.placeLabel, 160)
      ? { placeLabel: text(status.placeLabel, 160) }
      : {}),
    ...(text(status.address, 320)
      ? { address: text(status.address, 320) }
      : {}),
    ...(text(status.city, 160) ? { city: text(status.city, 160) } : {}),
    ...(text(status.district, 160)
      ? { district: text(status.district, 160) }
      : {}),
    ...(text(status.township, 160)
      ? { township: text(status.township, 160) }
      : {}),
    ...(text(status.nearbyAoi, 160)
      ? { nearbyAoi: text(status.nearbyAoi, 160) }
      : {}),
    ...(text(status.nearbyPoi, 160)
      ? { nearbyPoi: text(status.nearbyPoi, 160) }
      : {}),
    ...(text(status.nearbyRoad, 160)
      ? { nearbyRoad: text(status.nearbyRoad, 160) }
      : {}),
    ...(finite(status.distanceFromHome) !== undefined
      ? { distanceFromHome: finite(status.distanceFromHome) }
      : {}),
    ...(status.gpsQuality === 'excellent'
      || status.gpsQuality === 'good'
      || status.gpsQuality === 'fair'
      || status.gpsQuality === 'poor'
      ? { gpsQuality: status.gpsQuality }
      : {}),
    motionState: status.motionState === 'still'
      || status.motionState === 'walking'
      || status.motionState === 'transit'
      ? status.motionState
      : 'unknown',
    pois: Array.isArray(status.poiCache)
      ? status.poiCache.slice(0, 40).map(normalizePoi)
      : [],
  };
  return [{
    entityType: 'location-observation',
    entityId,
    kind: 'nearby-location-observation',
    value: jsonValue(value),
    operation: 'append',
    retentionClass: NEARBY_WORLD_PRECISE_LOCATION_RETENTION_CLASS,
  }];
}

function normalizeEvent(
  value: unknown,
  sourceDeviceId: string,
  sourcePlatform: SyncPlatform,
): NearbyWorldMovementEvent {
  const input = recordOf(value, 'nearby active event');
  const id = text(input.id, 256);
  const observedAt = timestamp(input.at);
  if (!id || observedAt === undefined) {
    throw new Error('nearby active event identity 无效。');
  }
  if (
    input.kind !== 'arrived-home'
    && input.kind !== 'left-home'
    && input.kind !== 'location-unstable'
    && input.kind !== 'transit'
    && input.kind !== 'walking'
  ) {
    throw new Error('nearby active event kind 无效。');
  }
  return {
    id,
    sourceDeviceId,
    sourcePlatform: platform(sourcePlatform),
    observedAt,
    kind: input.kind,
    ...(text(input.placeLabel, 160)
      ? { placeLabel: text(input.placeLabel, 160) }
      : {}),
    ...(text(input.address, 320)
      ? { address: text(input.address, 320) }
      : {}),
    nearbyReferences: Array.isArray(input.nearbyReferences)
      ? input.nearbyReferences
          .map((entry) => text(entry, 160))
          .filter((entry): entry is string => !!entry)
          .slice(0, 4)
      : [],
    ...(finite(input.distanceFromHome) !== undefined
      ? { distanceFromHome: finite(input.distanceFromHome) }
      : {}),
    ...(input.gpsQuality === 'excellent'
      || input.gpsQuality === 'good'
      || input.gpsQuality === 'fair'
      || input.gpsQuality === 'poor'
      ? { gpsQuality: input.gpsQuality }
      : {}),
    movementMode: input.precisionMode === 'walking'
      || input.precisionMode === 'transit'
      ? input.precisionMode
      : 'off',
    ...(input.accuracy === null
      ? { accuracy: null }
      : finite(input.accuracy) !== undefined
        ? { accuracy: finite(input.accuracy) }
        : {}),
  };
}

function activeEventState(raw: string) {
  const state = recordOf(
    parseJson(raw, 'nearby active event state'),
    'nearby active event state',
  );
  const lastByKind = state.lastByKind
    && typeof state.lastByKind === 'object'
    && !Array.isArray(state.lastByKind)
    ? state.lastByKind as Record<string, unknown>
    : {};
  return {
    lastByKind,
    queue: Array.isArray(state.queue) ? state.queue : [],
    outing: state.outing,
  };
}

function distanceMeters(
  leftLatitude: number,
  leftLongitude: number,
  rightLatitude: number,
  rightLongitude: number,
) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const latitudeDelta = radians(rightLatitude - leftLatitude);
  const longitudeDelta = radians(rightLongitude - leftLongitude);
  const left = radians(leftLatitude);
  const right = radians(rightLatitude);
  const haversine = Math.sin(latitudeDelta / 2) ** 2
    + Math.cos(left)
    * Math.cos(right)
    * Math.sin(longitudeDelta / 2) ** 2;
  return 2 * 6371000 * Math.atan2(
    Math.sqrt(haversine),
    Math.sqrt(1 - haversine),
  );
}

function formalLocationChanged(previousRaw: string, nextRaw: string) {
  const previous = recordOf(
    parseJson(previousRaw, 'previous nearby status'),
    'previous nearby status',
  );
  const next = recordOf(
    parseJson(nextRaw, 'next nearby status'),
    'next nearby status',
  );
  const previousAt = timestamp(previous.updatedAt);
  const nextAt = timestamp(next.updatedAt);
  const previousLatitude = finite(previous.latitude);
  const previousLongitude = finite(previous.longitude);
  const nextLatitude = finite(next.latitude);
  const nextLongitude = finite(next.longitude);
  if (
    previousAt === undefined
    || nextAt === undefined
    || previousLatitude === undefined
    || previousLongitude === undefined
    || nextLatitude === undefined
    || nextLongitude === undefined
  ) {
    return true;
  }
  if (nextAt - previousAt >= FORMAL_LOCATION_SAMPLE_MS) return true;
  if (
    previous.presence !== next.presence
    || previous.motionState !== next.motionState
    || previous.gpsQuality !== next.gpsQuality
    || previous.poiUpdatedAt !== next.poiUpdatedAt
  ) {
    return true;
  }
  if (
    distanceMeters(
      previousLatitude,
      previousLongitude,
      nextLatitude,
      nextLongitude,
    ) >= FORMAL_LOCATION_DISTANCE_METERS
  ) {
    return true;
  }
  const semanticFields = [
    'placeLabel', 'address', 'city', 'district', 'township',
    'nearbyAoi', 'nearbyPoi', 'nearbyRoad', 'poiCache',
  ] as const;
  return semanticFields.some((field) => (
    JSON.stringify(previous[field] ?? null)
    !== JSON.stringify(next[field] ?? null)
  ));
}

function projectEvents(
  raw: string,
  sourceDeviceId: string,
  sourcePlatform: SyncPlatform,
): ProjectedRecord[] {
  const state = activeEventState(raw);
  const events = state.queue.map((entry) => normalizeEvent(entry, sourceDeviceId, sourcePlatform));
  if (state.outing !== undefined) {
    const outing = recordOf(state.outing, 'outing state');
    if (!Array.isArray(outing.segments)) throw new Error('outing segments missing');
    for (const segment of outing.segments) {
      assertNearbyWorldOutingSegment(segment);
      events.push({ id: segment.id, sourceDeviceId, sourcePlatform, observedAt: segment.occurredAt,
        kind: 'outing-segment', movementMode: 'off', nearbyReferences: [], outing: segment });
    }
  }
  return events.map((value) => {
    return {
      entityType: 'movement-event' as const,
      entityId: value.id,
      kind: 'nearby-movement-event' as const,
      value: jsonValue(value),
      operation: 'append' as const,
      retentionClass: 'nearby-movement-history' as const,
    };
  });
}

function project(
  key: string,
  raw: string,
  sourceDeviceId: string,
  sourcePlatform: SyncPlatform,
) {
  if (key === NEARBY_WORLD_SYNC_SETTINGS_KEY) {
    return projectSettings(raw);
  }
  if (key === NEARBY_WORLD_SYNC_STATUS_KEY) {
    return projectLocation(raw, sourceDeviceId, sourcePlatform);
  }
  if (key === NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY) {
    return projectEvents(raw, sourceDeviceId, sourcePlatform);
  }
  return [];
}

function recordKey(record: ProjectedRecord) {
  return `${record.kind}\u0000${record.entityId}`;
}

export function isNearbyWorldHealthGlobalStorageKey(
  key: string,
): key is typeof NEARBY_WORLD_HEALTH_GLOBAL_KEYS[number] {
  return (NEARBY_WORLD_HEALTH_GLOBAL_KEYS as readonly string[]).includes(key);
}

export async function deriveNearbyWorldHealthMutationsForStorageChanges(
  input: {
    changes: readonly NearbyWorldStorageChange[];
    reader: NearbyWorldStorageReadPort;
    sourceDeviceId: string;
    sourcePlatform: SyncPlatform;
    capturedAt: number;
    envelopeFactory: NearbyWorldEnvelopeFactory;
  },
): Promise<PlainMutationV1[]> {
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (!isNearbyWorldHealthGlobalStorageKey(change.key)) continue;
    if (change.kind === 'remove') continue;
    const previousRaw = await input.reader.getItem(change.key);
    const previous = previousRaw
      ? project(
          change.key,
          previousRaw,
          input.sourceDeviceId,
          input.sourcePlatform,
        )
      : [];
    const previousByKey = new Map(
      previous.map((record) => [recordKey(record), record]),
    );
    const next = project(
      change.key,
      change.value,
      input.sourceDeviceId,
      input.sourcePlatform,
    );
    // Only an explicit new-format segment list can remove history. An old writer
    // omitting outing does not mean that the already captured evidence was deleted.
    if (change.key === NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY && activeEventState(change.value).outing !== undefined) {
      for (const record of previous) {
        const event = record.value as unknown as NearbyWorldMovementEvent;
        if (event.kind !== 'outing-segment' || next.some(item => recordKey(item) === recordKey(record))) continue;
        const envelope = await input.envelopeFactory({ domain: 'nearby-world', type: 'movement-event', id: record.entityId });
        mutations.push(buildNearbyWorldHealthDeleteMutation({ envelope, entityId: record.entityId,
          kind: 'nearby-movement-event', deletedAt: input.capturedAt }));
      }
    }
    for (const record of next) {
      if (
        record.kind === 'nearby-location-observation'
        && (
          record.value as unknown as NearbyWorldLocationObservation
        ).retainedUntil <= input.capturedAt
      ) {
        continue;
      }
      const before = previousByKey.get(recordKey(record));
      if (
        before
        && canonicalJson(before.value) === canonicalJson(record.value)
      ) {
        continue;
      }
      if (
        change.key === NEARBY_WORLD_SYNC_ACTIVE_EVENTS_KEY
        && before === undefined
        && previousRaw
      ) {
        const previousState = activeEventState(previousRaw);
        const event = record.value as unknown as NearbyWorldMovementEvent;
        if (previousState.lastByKind[event.kind] === event.observedAt) {
          continue;
        }
      }
      const envelope = await input.envelopeFactory({
        domain: 'nearby-world',
        type: record.entityType,
        id: record.entityId,
      });
      mutations.push(buildNearbyWorldHealthMutation({
        envelope: {
          ...envelope,
          createdAt: input.capturedAt,
        },
        ...record,
      }));
    }
  }
  return mutations;
}

export type {
  NearbyWorldActiveEvent,
  NearbyWorldSettings,
  NearbyWorldStatus,
};
