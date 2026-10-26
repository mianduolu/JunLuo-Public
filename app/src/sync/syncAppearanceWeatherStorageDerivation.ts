import type { WeatherState } from '../types/weather';
import {
  WEATHER_ANIMATION_STYLE_DEFINITION,
} from '../weather/weatherAnimationStyle';
import {
  appearanceWeatherEntityId,
  appearanceWeatherObservationId,
  buildAppearanceWeatherDeleteMutation,
  buildAppearanceWeatherUpsertMutation,
  APPEARANCE_WEATHER_OBSERVATION_RETENTION_MS,
  type AppearanceWeatherAnimationPolicy,
  type AppearanceWeatherMutationEnvelope,
  type AppearanceWeatherObservation,
  type AppearanceWeatherRecordKind,
  type AppearanceWeatherRecordValue,
  type AppearanceWeatherStyle,
} from './syncAppearanceWeather';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export const APPEARANCE_WEATHER_ANIMATION_KEY =
  'junluo.weatherAnimationEnabled' as const;
export const APPEARANCE_WEATHER_OBSERVATION_KEY =
  'junluo.weather.lastSuccessful' as const;
export const APPEARANCE_WEATHER_STYLE_KEY =
  'junluo.weather.style.v1' as const;
export const APPEARANCE_WEATHER_CACHE_SCHEMA_VERSION = 6 as const;
export const APPEARANCE_WEATHER_OBSERVATION_MAX_AGE_MS =
  APPEARANCE_WEATHER_OBSERVATION_RETENTION_MS;

export type AppearanceWeatherStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type AppearanceWeatherProjection = {
  kind: AppearanceWeatherRecordKind;
  localId: string;
  entityId: string;
  value: AppearanceWeatherRecordValue;
};

export type AppearanceWeatherEnvelopeFactory = (
  entity: {
    domain: 'appearance';
    type: AppearanceWeatherRecordKind;
    id: string;
  },
) => Promise<AppearanceWeatherMutationEnvelope>;

type StoredWeatherCache = {
  schemaVersion?: unknown;
  fetchedAt?: unknown;
  value?: unknown;
};

function safeTimestamp(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function nonEmptyText(value: unknown, maximumLength: number) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximumLength
    ? value
    : undefined;
}

function portableStyleDefinition() {
  return JSON.parse(
    JSON.stringify(WEATHER_ANIMATION_STYLE_DEFINITION),
  ) as JsonValue;
}

export function parseAppearanceWeatherAnimationEnabled(
  raw: string | null,
) {
  return raw !== 'false';
}

export function serializeAppearanceWeatherAnimationEnabled(
  enabled: boolean,
) {
  return String(enabled);
}

export function parseAppearanceWeatherObservation(
  raw: string | null,
): AppearanceWeatherObservation | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return undefined;
  }
  const cache = parsed as StoredWeatherCache;
  if (
    cache.schemaVersion !== APPEARANCE_WEATHER_CACHE_SCHEMA_VERSION
    || !cache.value
    || typeof cache.value !== 'object'
    || Array.isArray(cache.value)
  ) {
    return undefined;
  }
  const fetchedAt = safeTimestamp(cache.fetchedAt);
  if (fetchedAt === undefined) return undefined;
  const weather = cache.value as Partial<WeatherState>;
  const supportedKinds = [
    'clear',
    'cloudy',
    'rain',
    'thunderstorm',
    'snow',
    'hail',
    'fog',
    'dust',
  ] as const;
  if (
    !supportedKinds.includes(
      weather.kind as typeof supportedKinds[number],
    )
    || weather.error
  ) {
    return undefined;
  }
  const label = nonEmptyText(weather.label, 120);
  if (!label) return undefined;
  const placeLabel = nonEmptyText(weather.placeLabel, 160);
  const temperature = (
    typeof weather.temperature === 'number'
    && Number.isFinite(weather.temperature)
    && weather.temperature >= -100
    && weather.temperature <= 100
  )
    ? weather.temperature
    : undefined;
  const source = (
    weather.source === 'open-meteo'
    || weather.source === 'wttr'
    || weather.source === 'legacy-normalized'
  )
    ? weather.source
    : 'legacy-normalized';
  const observedAt =
    safeTimestamp(weather.observedAt) ?? fetchedAt;
  if (observedAt > fetchedAt) return undefined;
  const kind = weather.kind as AppearanceWeatherObservation['kind'];
  const observationId = appearanceWeatherObservationId({
    source,
    observedAt,
    kind,
    ...(placeLabel ? { placeLabel } : {}),
  });
  return {
    observationId,
    kind,
    label,
    ...(placeLabel ? { placeLabel } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    source,
    observedAt,
    fetchedAt,
    expiresAt:
      fetchedAt + APPEARANCE_WEATHER_OBSERVATION_MAX_AGE_MS,
  };
}

export function serializeAppearanceWeatherObservation(
  observation: AppearanceWeatherObservation,
) {
  return JSON.stringify({
    schemaVersion: APPEARANCE_WEATHER_CACHE_SCHEMA_VERSION,
    fetchedAt: observation.fetchedAt,
    value: {
      kind: observation.kind,
      label: observation.label,
      ...(observation.placeLabel
        ? { placeLabel: observation.placeLabel }
        : {}),
      ...(observation.temperature !== undefined
        ? { temperature: observation.temperature }
        : {}),
      source: observation.source,
      observedAt: observation.observedAt,
      isLoading: false,
    },
  });
}

function projection(
  kind: AppearanceWeatherRecordKind,
  localId: string,
  value: AppearanceWeatherRecordValue,
): AppearanceWeatherProjection {
  return {
    kind,
    localId,
    entityId: appearanceWeatherEntityId(kind, localId),
    value,
  };
}

export function projectAppearanceWeather(input: {
  animationRaw: string | null;
  observationRaw: string | null;
  now: number;
}) {
  const policy: AppearanceWeatherAnimationPolicy = {
    policyId: 'global',
    enabled: parseAppearanceWeatherAnimationEnabled(
      input.animationRaw,
    ),
  };
  const style: AppearanceWeatherStyle = {
    styleId: 'junluo-procedural-weather',
    definition: portableStyleDefinition(),
  };
  const result: AppearanceWeatherProjection[] = [
    projection('weather-animation-policy', 'global', policy),
    projection(
      'weather-style',
      WEATHER_ANIMATION_STYLE_DEFINITION.styleId,
      style,
    ),
  ];
  const observation = parseAppearanceWeatherObservation(
    input.observationRaw,
  );
  if (observation && observation.expiresAt > input.now) {
    result.push(projection(
      'weather-observation',
      observation.observationId,
      observation,
    ));
  }
  return result;
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

function projectionKey(value: AppearanceWeatherProjection) {
  return `${value.kind}\u0000${value.entityId}`;
}

export async function deriveAppearanceWeatherMutations(input: {
  previous: readonly AppearanceWeatherProjection[];
  next: readonly AppearanceWeatherProjection[];
  capturedAt: number;
  envelopeFactory: AppearanceWeatherEnvelopeFactory;
}) {
  const previous = new Map(
    input.previous.map((record) => [projectionKey(record), record]),
  );
  const next = new Map(
    input.next.map((record) => [projectionKey(record), record]),
  );
  const keys = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const key of keys) {
    const before = previous.get(key);
    const after = next.get(key);
    if (
      before
      && after
      && canonicalJson(before.value) === canonicalJson(after.value)
    ) {
      continue;
    }
    if (
      before?.kind === 'weather-observation'
      && !after
    ) {
      continue;
    }
    const identity = after ?? before;
    if (!identity) continue;
    const envelope = await input.envelopeFactory({
      domain: 'appearance',
      type: identity.kind,
      id: identity.entityId,
    });
    if (after) {
      mutations.push(buildAppearanceWeatherUpsertMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: after.kind,
        value: after.value,
      }));
    } else {
      mutations.push(buildAppearanceWeatherDeleteMutation({
        envelope: { ...envelope, createdAt: input.capturedAt },
        kind: before!.kind,
        localId: before!.localId,
        deletedAt: input.capturedAt,
      }));
    }
  }
  return mutations;
}

export function appearanceWeatherStorageOverrides(
  changes: readonly AppearanceWeatherStorageChange[],
) {
  let animationRaw: string | null | undefined;
  let observationRaw: string | null | undefined;
  for (const change of changes) {
    if (change.key === APPEARANCE_WEATHER_ANIMATION_KEY) {
      animationRaw = change.kind === 'set' ? change.value : null;
    }
    if (change.key === APPEARANCE_WEATHER_OBSERVATION_KEY) {
      observationRaw = change.kind === 'set' ? change.value : null;
    }
  }
  return { animationRaw, observationRaw };
}
