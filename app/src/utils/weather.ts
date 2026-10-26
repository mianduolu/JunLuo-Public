import * as Location from 'expo-location';

import { loadNearbyWorldSnapshot } from '../nearby/nearbyWorldStore';
import {
  appearanceWeatherStorageBridge as AsyncStorage,
} from '../sync/syncAppearanceWeatherStorageBridge';
import type { WeatherKind, WeatherState } from '../types/weather';

type WttrResponse = {
  current_condition?: Array<{
    temp_C?: string | number;
    weatherCode?: string | number;
    precipMM?: string | number;
    cloudcover?: string | number;
    lang_zh?: Array<{ value?: string }>;
  }>;
};

type OpenMeteoResponse = {
  current?: {
    temperature_2m?: number;
    weather_code?: number;
    precipitation?: number;
    rain?: number;
    showers?: number;
    snowfall?: number;
    cloud_cover?: number;
  };
};

type WeatherObservation = {
  code: number;
  precipitation?: number;
  rain?: number;
  showers?: number;
  snowfall?: number;
  cloudCover?: number;
  label?: string;
};

type WeatherProviderState = WeatherState & {
  observation?: WeatherObservation;
};

export type WeatherCacheOptions = {
  runCacheCommit?: <T>(work: () => Promise<T> | T) => Promise<T>;
  onResolvedObservation?: (observation: WeatherResolvedObservation) => void;
  beforeRequest?: () => Promise<void>;
  strictCacheRead?: boolean;
};

export type WeatherResolvedObservation = {
  weather: WeatherState;
  sourceCode?: number;
};

const initialWeather: WeatherState = {
  kind: 'unknown',
  label: '天气读取中',
  isLoading: true,
};

const WEATHER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WEATHER_FALLBACK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const WEATHER_CACHE_KEY = 'junluo.weather.lastSuccessful';
const WEATHER_CACHE_SCHEMA_VERSION = 6;
const LEGACY_WEATHER_CACHE_KEYS = [
  'junluo.weather.lastSuccessful.v2',
  'junluo.weather.lastSuccessful.v3',
  'junluo.weather.lastSuccessful.v4',
];
const LOCATION_FALLBACK_MAX_AGE_MS = 5 * 60 * 1000;
const LOCATION_REQUIRED_ACCURACY_M = 10000;
const LOCATION_FALLBACK_ACCURACY_M = 2000;
const LOCATION_REQUEST_TIMEOUT_MS = 15000;
const NEARBY_WEATHER_LOCATION_MAX_AGE_MS = 30 * 60 * 1000;
const NEARBY_WEATHER_MAX_ACCURACY_M = 1000;
const TRACE_PRECIPITATION_MM = 0.1;
const VISIBLE_PRECIPITATION_MM = 0.5;
const STORMY_CLOUD_COVER = 88;
const SUNNY_CLOUD_COVER = 55;

let cachedWeather: { value: WeatherState; fetchedAt: number } | undefined;
let pendingWeatherRequest: Promise<WeatherState> | undefined;
let legacyWeatherCacheCleanupStarted = false;

export function getInitialWeather(): WeatherState {
  return initialWeather;
}

function runCacheCommit<T>(options: WeatherCacheOptions | undefined, work: () => Promise<T> | T) {
  return options?.runCacheCommit ? options.runCacheCommit(work) : Promise.resolve(work());
}

function isUsableWeatherCacheTime(fetchedAt: unknown, maxAgeMs: number): fetchedAt is number {
  const now = Date.now();
  return typeof fetchedAt === 'number' && Number.isFinite(fetchedAt)
    && fetchedAt > 0 && fetchedAt <= now && now - fetchedAt < maxAgeMs;
}

export async function loadStoredWeather(options?: WeatherCacheOptions): Promise<WeatherState | undefined> {
  await clearLegacyWeatherCaches(options);

  if (!options?.strictCacheRead && cachedWeather && Date.now() - cachedWeather.fetchedAt < WEATHER_FALLBACK_MAX_AGE_MS) {
    cachedWeather = { ...cachedWeather, value: normalizeWeatherKind(cachedWeather.value) };
    return cachedWeather.value;
  }

  try {
    const stored = await AsyncStorage.getItem(WEATHER_CACHE_KEY);
    if (stored === null || stored === undefined) return undefined;

    const parsed = JSON.parse(stored) as { value?: WeatherState; fetchedAt?: number; schemaVersion?: number };
    if (parsed.schemaVersion !== WEATHER_CACHE_SCHEMA_VERSION) {
      await runCacheCommit(options, () => AsyncStorage.removeItem(WEATHER_CACHE_KEY));
      return undefined;
    }

    if (
      !parsed.value ||
      parsed.value.kind === 'unknown' ||
      typeof parsed.fetchedAt !== 'number' ||
      (options?.strictCacheRead ? !isUsableWeatherCacheTime(parsed.fetchedAt, WEATHER_FALLBACK_MAX_AGE_MS)
        : Date.now() - parsed.fetchedAt >= WEATHER_FALLBACK_MAX_AGE_MS)
    ) {
      await runCacheCommit(options, () => AsyncStorage.removeItem(WEATHER_CACHE_KEY));
      return undefined;
    }

    cachedWeather = { value: normalizeWeatherKind(parsed.value), fetchedAt: parsed.fetchedAt };
    return cachedWeather.value;
  } catch (error) {
    if (options?.strictCacheRead) throw error;
    return undefined;
  }
}

export async function fetchCurrentWeather(options?: WeatherCacheOptions): Promise<WeatherState> {
  await clearLegacyWeatherCaches(options);

  if (cachedWeather && Date.now() - cachedWeather.fetchedAt < WEATHER_REFRESH_INTERVAL_MS) {
    return cachedWeather.value;
  }

  if (pendingWeatherRequest) {
    return pendingWeatherRequest;
  }

  pendingWeatherRequest = requestCurrentWeather()
    .then((weather) => normalizeWeatherKind(stripWeatherProviderDetails(weather)))
    .finally(() => {
      pendingWeatherRequest = undefined;
    });

  const weather = await pendingWeatherRequest;
  if (!weather.error) {
    const nextCachedWeather = {
      value: weather,
      fetchedAt: Date.now(),
    };
    await runCacheCommit(options, async () => {
      await AsyncStorage.setItem(
        WEATHER_CACHE_KEY,
        JSON.stringify({ ...nextCachedWeather, schemaVersion: WEATHER_CACHE_SCHEMA_VERSION }),
      );
      cachedWeather = nextCachedWeather;
    });
  }
  return weather;
}

export async function fetchWeatherForCoordinates(
  latitude: number,
  longitude: number,
  placeLabel?: string,
  options?: WeatherCacheOptions,
): Promise<WeatherState> {
  const weather = await requestWeatherForLocation(latitude, longitude, placeLabel, options);
  const resolvedWeather = normalizeWeatherKind(stripWeatherProviderDetails(weather));
  options?.onResolvedObservation?.({
    weather: { ...resolvedWeather },
    sourceCode: weather.observation?.code,
  });
  return resolvedWeather;
}

export async function fetchAndStoreWeatherForCoordinates(
  latitude: number,
  longitude: number,
  placeLabel?: string,
  options?: WeatherCacheOptions,
): Promise<WeatherState> {
  const weather = await fetchWeatherForCoordinates(latitude, longitude, placeLabel, options);
  if (weather.error) return weather;
  const nextCachedWeather = {
    value: weather,
    fetchedAt: Date.now(),
  };
  await runCacheCommit(options, async () => {
    await AsyncStorage.setItem(
      WEATHER_CACHE_KEY,
      JSON.stringify({ ...nextCachedWeather, schemaVersion: WEATHER_CACHE_SCHEMA_VERSION }),
    );
    cachedWeather = nextCachedWeather;
  });
  return weather;
}

async function clearLegacyWeatherCaches(options?: WeatherCacheOptions) {
  if (legacyWeatherCacheCleanupStarted) return;
  legacyWeatherCacheCleanupStarted = true;
  try {
    await runCacheCommit(options, () => AsyncStorage.multiRemove(LEGACY_WEATHER_CACHE_KEYS));
  } catch (error) {
    legacyWeatherCacheCleanupStarted = false;
    if (options?.strictCacheRead) throw error;
  }
}

function stripWeatherProviderDetails(weather: WeatherState): WeatherState {
  const { observation: _observation, ...publicWeather } = weather as WeatherProviderState;
  return publicWeather;
}

async function requestCurrentWeather(): Promise<WeatherState> {
  const nearbyLocation = await loadNearbyWeatherLocation();
  if (nearbyLocation) {
    return requestWeatherForLocation(nearbyLocation.latitude, nearbyLocation.longitude, nearbyLocation.placeLabel);
  }

  const permission = await Location.requestForegroundPermissionsAsync();

  if (permission.status !== 'granted') {
    return {
      kind: 'unknown',
      label: '天气未开启',
      isLoading: false,
      error: 'location-denied',
    };
  }

  const location = await getUsableLocation();
  const { latitude, longitude } = location.coords;
  const placeLabel = await fetchPlaceLabel(latitude, longitude);

  return requestWeatherForLocation(latitude, longitude, placeLabel);
}

async function requestWeatherForLocation(
  latitude: number,
  longitude: number,
  placeLabel?: string,
  options?: WeatherCacheOptions,
): Promise<WeatherProviderState> {
  await options?.beforeRequest?.();
  let openMeteoWeather: WeatherProviderState | undefined;
  try {
    openMeteoWeather = await fetchOpenMeteoWeather(latitude, longitude, placeLabel);
  } catch {
    // Keep provider failures separate from host cancellation and commit checks.
  }
  if (openMeteoWeather && !['cloudy', 'rain', 'hail'].includes(openMeteoWeather.kind)) {
    return openMeteoWeather;
  }
  await options?.beforeRequest?.();
  const wttrWeather = await fetchWttrWeather(latitude, longitude, placeLabel).catch(() => undefined);
  if (openMeteoWeather) return reconcilePrecipitationWeather(openMeteoWeather, wttrWeather);
  if (wttrWeather) return wttrWeather;
  throw new Error('weather-provider-unavailable');
}

async function loadNearbyWeatherLocation() {
  try {
    const { settings, status } = await loadNearbyWorldSnapshot();
    if (!settings.enabled || !settings.amapKey.trim() || !status.placeLabel) return null;
    if (!Number.isFinite(status.latitude) || !Number.isFinite(status.longitude)) return null;
    if (!status.updatedAt || Date.now() - status.updatedAt > NEARBY_WEATHER_LOCATION_MAX_AGE_MS) return null;
    if (typeof status.accuracy === 'number' && status.accuracy > NEARBY_WEATHER_MAX_ACCURACY_M) return null;

    return {
      latitude: status.latitude!,
      longitude: status.longitude!,
      placeLabel: status.placeLabel,
    };
  } catch {
    return null;
  }
}

async function getUsableLocation() {
  try {
    const currentLocation = await getCurrentLocationWithTimeout();
    if (isLocationAccurateEnough(currentLocation, LOCATION_REQUIRED_ACCURACY_M)) {
      return currentLocation;
    }
  } catch {
    // Fall through to the strict last-known fallback below.
  }

  const fallbackLocation = await Location.getLastKnownPositionAsync({
    maxAge: LOCATION_FALLBACK_MAX_AGE_MS,
    requiredAccuracy: LOCATION_FALLBACK_ACCURACY_M,
  });

  if (fallbackLocation && isLocationAccurateEnough(fallbackLocation, LOCATION_FALLBACK_ACCURACY_M)) {
    return fallbackLocation;
  }

  throw new Error('location-unavailable');
}

async function fetchPlaceLabel(latitude: number, longitude: number) {
  try {
    const places = await Location.reverseGeocodeAsync({ latitude, longitude });
    const place = places[0];

    return formatPlaceLabel(place);
  } catch {
    return undefined;
  }
}

async function getCurrentLocationWithTimeout() {
  return Promise.race([
    Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    }),
    new Promise<Location.LocationObject>((_, reject) => {
      setTimeout(() => reject(new Error('location-timeout')), LOCATION_REQUEST_TIMEOUT_MS);
    }),
  ]);
}

function isLocationAccurateEnough(location: Location.LocationObject, maxAccuracyMeters: number) {
  const accuracy = location.coords.accuracy;
  return typeof accuracy !== 'number' || accuracy <= maxAccuracyMeters;
}

function formatPlaceLabel(place?: Location.LocationGeocodedAddress) {
  if (!place) return undefined;

  const primaryCity = place.city ?? place.subregion ?? place.region;
  if (primaryCity && place.district && place.district !== primaryCity) {
    return `${primaryCity} · ${place.district}`;
  }

  return place.district ?? primaryCity ?? undefined;
}

async function fetchOpenMeteoWeather(latitude: number, longitude: number, placeLabel?: string): Promise<WeatherProviderState> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}&current=temperature_2m,weather_code,precipitation,rain,showers,snowfall,cloud_cover&timezone=auto`;
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`open-meteo-http-${response.status}`);
  }

  const data = (await response.json()) as OpenMeteoResponse;
  const weatherCode = readFiniteNumber(data.current?.weather_code);
  const temperature = readFiniteNumber(data.current?.temperature_2m);

  if (weatherCode === undefined) {
    throw new Error('open-meteo-missing-weather-code');
  }

  const observation = buildOpenMeteoObservation(data, weatherCode);
  const kind = mapOpenMeteoObservation(observation);

  return {
    kind,
    label: getOpenMeteoLabel(weatherCode, kind),
    placeLabel,
    temperature: temperature === undefined ? undefined : Math.round(temperature),
    isLoading: false,
    source: 'open-meteo',
    observedAt: Date.now(),
    observation,
  };
}

async function fetchWttrWeather(latitude: number, longitude: number, placeLabel?: string): Promise<WeatherProviderState> {
  const url = `https://wttr.in/${latitude},${longitude}?format=j1&lang=zh`;
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    throw new Error(`weather-http-${response.status}`);
  }

  const data = (await response.json()) as WttrResponse;
  const current = data.current_condition?.[0];
  const weatherCode = parseOptionalNumber(current?.weatherCode);
  const temperature = parseOptionalNumber(current?.temp_C);
  if (weatherCode === undefined) throw new Error('weather-missing-weather-code');
  const label = current?.lang_zh?.[0]?.value?.trim() || getWeatherKindLabel(weatherCode);
  const observation: WeatherObservation = {
    code: weatherCode,
    precipitation: parseOptionalNumber(current?.precipMM),
    cloudCover: parseOptionalNumber(current?.cloudcover),
    label,
  };
  const kind = mapWttrObservation(observation);

  return {
    kind,
    label,
    placeLabel,
    temperature,
    isLoading: false,
    source: 'wttr',
    observedAt: Date.now(),
    observation,
  };
}

async function fetchWithTimeout(url: string) {
  return Promise.race([
    fetch(url),
    new Promise<Response>((_, reject) => {
      setTimeout(() => reject(new Error('weather-timeout')), 7000);
    }),
  ]);
}

function mapWeatherCode(code: number): WeatherKind {
  if ([113].includes(code)) return 'clear';
  if ([116, 119, 122, 143, 248, 260].includes(code)) return code === 143 || code === 248 || code === 260 ? 'fog' : 'cloudy';
  if ([200, 386, 389].includes(code)) return 'thunderstorm';
  if ([350].includes(code)) return 'hail';
  if ([176, 263, 266, 281, 284, 293, 296, 299, 302, 305, 308, 311, 314, 317, 320, 353, 356, 359, 362, 365, 374, 377, 392, 395].includes(code)) {
    return 'rain';
  }
  if ([179, 182, 185, 227, 230, 323, 326, 329, 332, 335, 338, 350, 368, 371].includes(code)) return 'snow';
  return 'unknown';
}

function normalizeWeatherKind(weather: WeatherState): WeatherState {
  let normalized = weather;

  if (weather.kind === 'rain' && /雷雨|雷阵雨|thunderstorm|thundery/i.test(weather.label)) {
    normalized = { ...weather, kind: 'thunderstorm' };
  }

  if (normalized.kind === 'rain' && /冰雹|雹|hail/i.test(normalized.label)) {
    normalized = { ...normalized, kind: 'hail' };
  }

  if (normalized.kind === 'hail' && !/冰雹|雹|hail/i.test(normalized.label)) {
    normalized = { ...normalized, kind: 'rain', label: normalized.label.includes('雷') ? '雷雨' : '雨' };
  }

  if (normalized.kind === 'clear' && /多云|阴/.test(normalized.label)) {
    normalized = { ...normalized, kind: 'cloudy' };
  }

  if (!/[\u3400-\u9fff]/u.test(normalized.label)) {
    normalized = { ...normalized, label: getWeatherLabelForKind(normalized.kind) };
  }

  return normalized;
}

function reconcilePrecipitationWeather(primary: WeatherProviderState, fallback?: WeatherProviderState): WeatherState {
  if (
    primary.kind === 'cloudy'
    && fallback
    && ['rain', 'thunderstorm', 'hail'].includes(fallback.kind)
  ) {
    return {
      ...fallback,
      placeLabel: primary.placeLabel ?? fallback.placeLabel,
      temperature: primary.temperature ?? fallback.temperature,
    };
  }

  if (primary.kind === 'hail') {
    if (fallback?.kind === 'hail' || /冰雹|雹|hail/i.test(fallback?.label ?? '')) {
      return primary;
    }

    return {
      ...primary,
      kind: 'rain',
      label: primary.label.includes('雷') ? '雷雨' : '雨',
    };
  }

  if (primary.kind !== 'rain') return primary;

  if (isSunnyRainContradiction(primary.observation)) {
    return {
      ...primary,
      kind: getDrySkyKind(primary.observation),
      label: getDrySkyLabel(primary.observation),
    };
  }

  if (fallback && fallback.kind !== 'rain' && fallback.kind !== 'hail' && isWeakRainObservation(primary.observation)) {
    return {
      ...fallback,
      temperature: primary.temperature ?? fallback.temperature,
    };
  }

  if (isWeakRainObservation(primary.observation) && (!fallback || isWeakRainObservation(fallback.observation))) {
    return {
      ...primary,
      kind: getDrySkyKind(primary.observation),
      label: getDrySkyLabel(primary.observation),
    };
  }

  return primary;
}

function buildOpenMeteoObservation(data: OpenMeteoResponse, weatherCode: number): WeatherObservation {
  const current = data.current;

  return {
    code: weatherCode,
    precipitation: readFiniteNumber(current?.precipitation),
    rain: readFiniteNumber(current?.rain),
    showers: readFiniteNumber(current?.showers),
    snowfall: readFiniteNumber(current?.snowfall),
    cloudCover: readFiniteNumber(current?.cloud_cover),
  };
}

function mapOpenMeteoObservation(observation: WeatherObservation): WeatherKind {
  const codeKind = mapOpenMeteoCode(observation.code);

  if (
    hasVisiblePrecipitation(observation)
    && (codeKind === 'clear' || codeKind === 'cloudy' || codeKind === 'unknown')
  ) {
    return 'rain';
  }

  if (codeKind === 'rain' && !hasVisiblePrecipitation(observation)) {
    return getDrySkyKind(observation);
  }

  if (codeKind === 'snow' && !hasMeaningfulSnowfall(observation)) {
    return getDrySkyKind(observation);
  }

  return codeKind;
}

function mapWttrObservation(observation: WeatherObservation): WeatherKind {
  const codeKind = mapWeatherCode(observation.code);

  if (
    hasVisiblePrecipitation(observation)
    && (codeKind === 'clear' || codeKind === 'cloudy' || codeKind === 'unknown')
  ) {
    return 'rain';
  }

  if (isWttrDrizzleCode(observation.code) && !hasVisiblePrecipitation(observation)) {
    return getDrySkyKind(observation);
  }

  if (codeKind === 'rain' && !hasVisiblePrecipitation(observation)) {
    if (isStormySky(observation) && /雨|雷|阵雨|drizzle|rain|shower|thunder/i.test(observation.label ?? '')) {
      return 'rain';
    }

    return getDrySkyKind(observation);
  }

  return codeKind;
}

function hasMeaningfulPrecipitation(observation: WeatherObservation) {
  return [observation.precipitation, observation.rain, observation.showers].some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= TRACE_PRECIPITATION_MM,
  );
}

function hasVisiblePrecipitation(observation: WeatherObservation) {
  return [observation.precipitation, observation.rain, observation.showers].some(
    (value) => typeof value === 'number' && Number.isFinite(value) && value >= VISIBLE_PRECIPITATION_MM,
  );
}

function isWeakRainObservation(observation?: WeatherObservation) {
  if (!observation) return false;
  if (hasVisiblePrecipitation(observation)) return false;
  return observation.cloudCover === undefined || observation.cloudCover < STORMY_CLOUD_COVER;
}

function isSunnyRainContradiction(observation?: WeatherObservation) {
  if (!observation) return false;
  if (hasVisiblePrecipitation(observation)) return false;
  return observation.cloudCover === undefined || observation.cloudCover <= SUNNY_CLOUD_COVER;
}

function isStormySky(observation: WeatherObservation) {
  return observation.cloudCover !== undefined && observation.cloudCover >= STORMY_CLOUD_COVER;
}

function getDrySkyKind(observation?: WeatherObservation): WeatherKind {
  return observation?.cloudCover !== undefined && observation.cloudCover >= 45 ? 'cloudy' : 'clear';
}

function getDrySkyLabel(observation?: WeatherObservation) {
  return getDrySkyKind(observation) === 'cloudy' ? '多云' : '晴';
}

function hasMeaningfulSnowfall(observation: WeatherObservation) {
  return typeof observation.snowfall === 'number' && Number.isFinite(observation.snowfall) && observation.snowfall >= 0.1;
}

function isWttrDrizzleCode(code: number) {
  return [263, 266, 281, 284].includes(code);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim()) return readFiniteNumber(Number(value));
  return readFiniteNumber(value);
}

function mapOpenMeteoCode(code: number): WeatherKind {
  if (code === 0) return 'clear';
  if ([1, 2, 3].includes(code)) return 'cloudy';
  if ([45, 48].includes(code)) return 'fog';
  if ([96, 99].includes(code)) return 'hail';
  if (code === 95) return 'thunderstorm';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  return 'unknown';
}

function getOpenMeteoLabel(code: number, kind = mapOpenMeteoCode(code)) {
  if (kind === 'clear') return '晴';
  if (kind === 'cloudy') {
    if (code === 1) return '晴间多云';
    if (code === 2) return '局部多云';
    return code === 3 ? '阴' : '多云';
  }
  if (code === 0) return '晴';
  if (code === 1) return '晴间多云';
  if (code === 2) return '局部多云';
  if (code === 3) return '阴';
  if ([45, 48].includes(code)) return '雾';
  if ([51, 53, 55, 56, 57].includes(code)) return '毛毛雨';
  if ([61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return '雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '雪';
  if (code === 95) return '雷雨';
  if ([96, 99].includes(code)) return '雷雨冰雹';
  return '天气未知';
}

function getWeatherKindLabel(code: number) {
  return getWeatherLabelForKind(mapWeatherCode(code));
}

function getWeatherLabelForKind(kind: WeatherKind) {
  const labels: Record<WeatherKind, string> = {
    clear: '晴',
    cloudy: '多云',
    rain: '雨',
    snow: '雪',
    thunderstorm: '雷阵雨',
    hail: '冰雹',
    fog: '雾',
    dust: '沙尘',
    unknown: '天气未知',
  };

  return labels[kind];
}
