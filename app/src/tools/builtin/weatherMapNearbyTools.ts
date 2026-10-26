import * as Location from 'expo-location';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../../backup/backupRestoreCoordinator';

import { AmapServiceError, fetchAmapForwardGeocode, fetchAmapSearchPage, fetchAmapPlaceTextSearch, fetchAmapReverseGeocode, type AmapGeocodeCandidate, type AmapNearbyPlace, type AmapPlaceTextCandidate } from '../../nearby/amapNearbyProvider';
import { AmapQueryPausedError, getEffectiveAmapPause, runAmapQuery } from '../../nearby/amapQueryPolicy';
import { continueMapSearch, destinationReference, runMapSearch, type MapSearchHostContext, type MapSearchSpec } from '../mapSearchSession';
import { buildNearbyWorldContext } from '../../nearby/nearbyWorldContext';
import { isFreshLocation } from '../../nearby/nearbyLocationPolicy';
import {
  getNearbyWorldPoiCategoryLabel,
  loadNearbyWorldSnapshot,
} from '../../nearby/nearbyWorldStore';
import type { WeatherState } from '../../types/weather';
import { fetchAndStoreWeatherForCoordinates, fetchWeatherForCoordinates, loadStoredWeather, type WeatherResolvedObservation } from '../../utils/weather';
import { createToolError } from '../toolErrors';
import { createToolErrorResult, createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolExecutorContext, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import { readBooleanInput, readNumberInput, readOptionalStringInput, validationFailed } from './builtinToolValidation';

type WeatherCurrentData = {
  checkedAt: number;
  location?: Partial<ToolLocationData>;
  source: 'fresh' | 'stored';
  weather: WeatherState;
  displayLabel?: string;
};

type ForecastDay = {
  date: string;
  label?: string;
  precipitationProbability?: number;
  precipitationSum?: number;
  temperatureMax?: number;
  temperatureMin?: number;
  weatherCode?: number;
};

type WeatherForecastData = {
  days: ForecastDay[];
  location: ToolLocationData;
  source: 'open_meteo';
};

type ToolLocationData = {
  accuracy?: number | null;
  address?: string;
  city?: string;
  district?: string;
  latitude: number;
  longitude: number;
  placeLabel?: string;
  source: 'nearby_world' | 'current' | 'last_known' | 'explicit';
  timestamp?: number;
};

type ToolLocationResolution =
  | { kind: 'available'; location: ToolLocationData }
  | { kind: 'permission_denied' }
  | { kind: 'unavailable' };

type ReverseGeocodeData = ToolLocationData & {
  nearbyAoi?: string;
  nearbyPoi?: string;
  nearbyRoad?: string;
  provider: 'amap' | 'system';
  township?: string;
};

type NearbyContextData = Awaited<ReturnType<typeof buildNearbyWorldContext>>['status'] & {
  context: string;
  locationQuality?: string;
  nearbyPlaces: Array<{
    address?: string;
    categoryLabel: string;
    distance?: number;
    name: string;
  }>;
};

type LocationConsistencyData = {
  confidence: 'high' | 'medium' | 'low' | 'uncertain';
  conflictDistanceMeters?: number;
  current?: ToolLocationData;
  reasons: string[];
  status: 'consistent' | 'uncertain' | 'conflict';
  trusted?: ToolLocationData;
  weatherPlaceLabel?: string;
};

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const NEARBY_LOCATION_MAX_AGE_MS = 45 * 60 * 1000;
const NEARBY_LOCATION_MAX_ACCURACY_M = 1000;
const LOCATION_CONFLICT_DISTANCE_M = 2000;

const MAP_CONSENT_EVIDENCE: JunLuoToolDefinition['inputSchema'] = {
  type: 'object',
  description: '扩大搜索范围或重试额度受限的查询时，附上 you 本轮同意这次操作的消息序号 from，并在 quote 原样摘出对应片段。',
  properties: { from: { type: 'number' }, quote: { type: 'string' } },
  required: ['from', 'quote'], additionalProperties: false,
};

const READ_ALLOW = {
  permission: 'allow' as const,
  readOnly: true,
  riskLevel: 'read' as const,
};

async function executeGetCurrentWeather(
  call: JunLuoToolCall,
  context?: JunLuoToolExecutorContext,
): Promise<JunLuoToolResult<WeatherCurrentData>> {
  const epoch = context?.mapSearch ? context.mapSearch.dataEpoch : captureBackupRestoreDataEpoch();
  try {
    await assertWeatherSourceCurrent(context, epoch);
    const place = readOptionalStringInput(call.input, 'place');
    const resolution = place
      ? await resolveExplicitPlaceLocation(place, context, epoch).then(location => ({ kind: 'available' as const, location }))
      : await resolveWeatherToolLocation(context, epoch);
    if (resolution.kind !== 'available') return weatherLocationFailure(call, resolution.kind);
    const location = resolution.location;
    let displayLabel: string | undefined;
    const cacheOptions = {
      strictCacheRead: true,
      beforeRequest: async () => {
        await assertWeatherSourceCurrent(context, epoch);
        if (location.source !== 'explicit' && !isFreshLocation({ ...location, timestamp: location.timestamp! }, Date.now(), 1000)) {
          throw new Error('weather-location-stale');
        }
      },
      onResolvedObservation: (observation: WeatherResolvedObservation) => { displayLabel = weatherToolLabel(observation); },
      runCacheCommit: async <T>(work: () => Promise<T> | T) => {
        const commit = async () => { await assertWeatherSourceCurrent(context, epoch); return work(); };
        return context?.runBackupRestoreDataEpochCommit ? context.runBackupRestoreDataEpochCommit(commit) : commit();
      },
    };
    let weather: WeatherState;
    try {
      weather = place
        ? await fetchWeatherForCoordinates(location.latitude, location.longitude, location.placeLabel, cacheOptions)
        : await fetchAndStoreWeatherForCoordinates(location.latitude, location.longitude, location.placeLabel, cacheOptions);
    } catch (error) {
      // Only a provider failure permits old weather; a failed save/source check does not.
      if (place || readBooleanInput(call.input, 'allowStoredFallback') === false
        || !(error instanceof Error) || error.message !== 'weather-provider-unavailable') throw error;
      const stored = await loadStoredWeather(cacheOptions);
      await assertWeatherSourceCurrent(context, epoch);
      if (!stored || stored.error || !weatherPlaceMatchesLocation(stored.placeLabel, location.placeLabel)) throw error;
      return createToolSuccessResult(call, summarizeWeather(stored, 'stored'), {
        checkedAt: Date.now(), location, source: 'stored', weather: stored,
      });
    }
    await assertWeatherSourceCurrent(context, epoch);
    if (weather.error) throw new Error(weather.error);
    return createToolSuccessResult(call, summarizeWeather(weather, 'fresh'), {
      checkedAt: Date.now(), location, source: 'fresh', weather, displayLabel,
    });
  } catch (error) { return weatherQueryFailure(call, error); }
}

async function executeGetForecast(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<WeatherForecastData>> {
  const epoch = context?.mapSearch ? context.mapSearch.dataEpoch : captureBackupRestoreDataEpoch();
  try {
    await assertWeatherSourceCurrent(context, epoch);
    const days = clamp(Math.round(readNumberInput(call.input, 'days') ?? 2), 1, 7);
    const place = readOptionalStringInput(call.input, 'place');
    const resolution = place
      ? await resolveExplicitPlaceLocation(place, context, epoch).then((location): ToolLocationResolution => ({ kind: 'available', location }))
      : await resolveWeatherToolLocation(context, epoch);
    if (resolution.kind !== 'available') return weatherLocationFailure(call, resolution.kind);
    const location = resolution.location;
    const url = `${FORECAST_URL}?${new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
      forecast_days: String(days),
      timezone: 'auto',
    }).toString()}`;
    await assertWeatherSourceCurrent(context, epoch);
    if (location.source !== 'explicit' && !isFreshLocation({ ...location, timestamp: location.timestamp! }, Date.now(), 1000)) {
      return weatherLocationFailure(call, 'unavailable');
    }
    const response = await fetch(url);
    if (!response.ok) {
      return createToolErrorResult(call, createToolError('EXECUTION_FAILED', `天气预报请求失败：${response.status}`), '这次没有取得天气资料。');
    }
    const json = await response.json() as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_sum?: number[];
        precipitation_probability_max?: number[];
      };
    };
    const dates = Array.isArray(json.daily?.time) ? json.daily.time.slice(0, days) : [];
    const forecastDays = dates.map((date, index): ForecastDay => {
      const code = finiteNumber(json.daily?.weather_code?.[index]);
      return {
        date,
        label: code === undefined ? undefined : getOpenMeteoLabel(code),
        precipitationProbability: finiteNumber(json.daily?.precipitation_probability_max?.[index]),
        precipitationSum: finiteNumber(json.daily?.precipitation_sum?.[index]),
        temperatureMax: finiteNumber(json.daily?.temperature_2m_max?.[index]),
        temperatureMin: finiteNumber(json.daily?.temperature_2m_min?.[index]),
        weatherCode: code,
      };
    }).filter((day) => typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date));
    if (!forecastDays.length) {
      return createToolErrorResult(call, createToolError('EXECUTION_FAILED', '天气预报为空'), '这次没有取得天气资料。');
    }
    await assertWeatherSourceCurrent(context, epoch);
    return createToolSuccessResult(
      call,
      `已获取${location.placeLabel ? `${location.placeLabel} ` : ''}${forecastDays.length} 天天气预报：${forecastDays.map(formatForecastDay).join('；')}`,
      { days: forecastDays, location, source: 'open_meteo' },
    );
  } catch (error) { return weatherQueryFailure(call, error); }
}

async function executeReverseGeocode(call: JunLuoToolCall, context?: JunLuoToolExecutorContext): Promise<JunLuoToolResult<ReverseGeocodeData>> {
  const location = readExplicitLocation(call);
  if (!location) {
    return validationFailed(call, '没有可用经纬度，无法反查地址', '暂时没有拿到可反查的位置');
  }
  const { settings } = await loadNearbyWorldSnapshot();
  if (settings.amapKey.trim()) {
    let place: AmapNearbyPlace;
    try {
      place = await runAmapQuery({ service: 'regeo', dataEpoch: context?.mapSearch?.dataEpoch }, () => fetchAmapReverseGeocode({
        key: settings.amapKey,
        location: `${location.longitude},${location.latitude}`,
      }));
    } catch (error) { return mapQueryFailure<ReverseGeocodeData>(call, error); }
    const data: ReverseGeocodeData = {
      ...location,
      ...place,
      provider: 'amap',
      placeLabel: place.placeLabel || location.placeLabel,
    };
    return createToolSuccessResult(call, summarizeReverseGeocode(data), data);
  }

  const systemPlace = await reverseGeocodeWithSystem(location.latitude, location.longitude);
  const data: ReverseGeocodeData = {
    ...location,
    ...systemPlace,
    provider: 'system',
    placeLabel: systemPlace.placeLabel || location.placeLabel,
  };
  return createToolSuccessResult(call, summarizeReverseGeocode(data), data);
}

async function executeSearchNearby(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  return executeMapSearch(call, context, 'nearby');
}

async function executeGeocodePlace(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  const query = readOptionalStringInput(call.input, 'place') ?? readOptionalStringInput(call.input, 'query') ?? readOptionalStringInput(call.input, 'address') ?? '';
  const city = readOptionalStringInput(call.input, 'city');
  const limit = clamp(Math.round(readNumberInput(call.input, 'limit') ?? 5), 1, 8);
  if (query.trim().length === 0) {
    return validationFailed(call, '缺少要解析的目的地', '缺少要解析的目的地，不能查询远方地点');
  }
  const { settings } = await loadNearbyWorldSnapshot();
  if (settings.amapKey.trim().length === 0) {
    return createToolErrorResult(call, createToolError('EXECUTION_FAILED', '没有配置高德 Key，无法解析目的地'), '暂时没有解析目的地：没有配置高德 Key');
  }
  let candidates: AmapGeocodeCandidate[];
  try {
    candidates = await runAmapQuery({ service: 'geocode', dataEpoch: context?.mapSearch?.dataEpoch }, () => fetchAmapForwardGeocode({ address: query, city, key: settings.amapKey }));
    if (!candidates.length) {
      const places = await runAmapQuery({ service: 'place', dataEpoch: context?.mapSearch?.dataEpoch }, () => fetchAmapPlaceTextSearch({ city, key: settings.amapKey, keywords: query, limit }));
      candidates = places.map(textPlaceToDestination).filter((candidate): candidate is AmapGeocodeCandidate => !!candidate);
    }
    candidates = candidates.filter((candidate) => explicitPlaceMatchesCandidate(query, candidate)).slice(0, limit);
  } catch (error) { return mapQueryFailure(call, error); }
  if (candidates.length === 0) {
    return createToolErrorResult(call, createToolError('EXECUTION_FAILED', '高德没有查到这个目的地'), '高德没有查到这个目的地：' + query + '。不会改用当前位置硬凑。');
  }
  return createToolSuccessResult(call, '高德查到 ' + candidates.length + ' 个目的地候选：' + candidates.map(formatDestinationCandidate).join('；') + '。远方目的地查询不会使用小仓鼠当前位置。', { candidates, provider: 'amap', query });
}

async function executeSearchDestination(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  return executeMapSearch(call, context, 'destination');
}

async function executeMapSearch(call: JunLuoToolCall, context: JunLuoToolExecutorContext | undefined, kind: MapSearchSpec['kind']) {
  const query = (kind === 'nearby' ? readOptionalStringInput(call.input, 'query')
    : readOptionalStringInput(call.input, 'topic') ?? readOptionalStringInput(call.input, 'keyword'))?.trim();
  const destination = readOptionalStringInput(call.input, 'destination') ?? readOptionalStringInput(call.input, 'place');
  const city = readOptionalStringInput(call.input, 'city')?.trim();
  const radiusKm = readNumberInput(call.input, 'radiusKm') ?? 3;
  if (!query || ![3, 5, 10].includes(radiusKm) || (kind === 'destination' && (!destination?.trim() || !city))) {
    return validationFailed(call, 'map-search-input-required', '本次地图查询未完成。');
  }
  const evidence = call.input.evidence as MapSearchSpec['evidence'];
  const search: MapSearchSpec = { kind, query, destination: destination?.trim(), city: normalizeCity(city), radiusKm: radiusKm as 3 | 5 | 10, evidence };
  const dataEpoch = captureBackupRestoreDataEpoch();
  const host: MapSearchHostContext = context?.mapSearch ?? {
    conversationId: `manual-map:${call.callId}`, requestId: call.callId, dataEpoch,
    sourceMessageIds: [], isSourceCurrent: async () => canCommitBackupRestoreDataEpoch(dataEpoch),
    authorize: async () => ({ allowed: radiusKm === 3 }),
  };
  try {
    if (!await host.isSourceCurrent()) return createToolErrorResult(call, createToolError('STALE_DATA_EPOCH', 'map-search-source-stale'), '上次搜索已失效，需要重新搜索。');
    const authorization = await host.authorize(search);
    if (!authorization.allowed) return createToolErrorResult(call, createToolError('TOOL_INPUT_REQUIRED', 'map-search-range-confirmation-required'), '本次地图查询未完成。');
    const { settings, status } = await loadNearbyWorldSnapshot();
    if (!settings.amapKey.trim()) return mapQueryFailure(call, new AmapServiceError('config', 'place'));
    const queryOptions = { explicitRetry: authorization.explicitRetry, dataEpoch: host.dataEpoch };
    const pause = getEffectiveAmapPause(status, host.dataEpoch);
    return await runMapSearch({
      call, host, search, onError: mapQueryFailure,
      resolveSearch: async (cachedCandidates, isCurrent, previousDestination, lookup) => {
        if (kind === 'destination' && pause?.service === 'regeo' && authorization.explicitRetry) {
          // Retry the failed automatic lookup at its recorded query center, not
          // the phone's current position or a guessed destination coordinate.
          const attempt = status.mapAttempt;
          if (!attempt || !Number.isFinite(attempt.at) || attempt.at <= 0 || attempt.at > pause.at
            || !isValidLatitude(attempt.latitude) || !isValidLongitude(attempt.longitude)) {
            if (status.mapQuotaPause?.at !== pause.at || status.mapQuotaPause.service !== pause.service) {
              throw new Error('MAP_QUOTA_PAUSE_SAVE_FAILED');
            }
            throw new AmapQueryPausedError();
          }
          await runAmapQuery({ ...queryOptions, service: 'regeo' }, async () => {
            if (!await isCurrent() || !(await host.authorize(search)).allowed) throw new Error('map-search-source-stale');
            return fetchAmapReverseGeocode({ key: settings.amapKey,
              location: `${attempt.longitude},${attempt.latitude}`, coordinateSystem: 'wgs84' });
          });
        }
        if (kind === 'nearby') {
          const permission = await Location.requestForegroundPermissionsAsync();
          if (!permission.granted) throw new MapLocationError('permission');
          const location = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High, mayShowUserSettingsDialog: true }).catch(() => null);
          const now = Date.now();
          if (!location || !isValidLatitude(location.coords.latitude) || !isValidLongitude(location.coords.longitude)
            || !Number.isFinite(location.timestamp) || location.timestamp <= 0 || location.timestamp > now || now - location.timestamp > 5 * 60 * 1000
            || typeof location.coords.accuracy !== 'number' || !Number.isFinite(location.coords.accuracy)
            || location.coords.accuracy < 0 || location.coords.accuracy > 100) throw new MapLocationError('quality');
          if (pause?.service === 'regeo' && authorization.explicitRetry) {
            await runAmapQuery({ ...queryOptions, service: 'regeo' }, async () => {
              if (!await isCurrent() || !(await host.authorize(search)).allowed) throw new Error('map-search-source-stale');
              return fetchAmapReverseGeocode({ key: settings.amapKey,
                location: `${location.coords.longitude},${location.coords.latitude}`, coordinateSystem: 'wgs84' });
            });
          }
          return { center: { latitude: location.coords.latitude, longitude: location.coords.longitude, coordinateSystem: 'wgs84',
            accuracy: location.coords.accuracy, timestamp: location.timestamp, source: 'current' } };
        }
        const selected = cachedCandidates?.filter((candidate) => [destinationReference(candidate), candidate.address, candidate.placeLabel].includes(destination?.trim()));
        let candidates: AmapGeocodeCandidate[];
        if (previousDestination) candidates = [previousDestination];
        else if (selected?.length === 1) candidates = selected;
        else if (selected && selected.length > 1) return { destinationCandidates: selected };
        else {
          candidates = lookup?.retryText || (authorization.explicitRetry && pause?.service === 'place')
            ? [] : await runAmapQuery({ ...queryOptions, service: 'geocode' }, async () => {
            if (!await isCurrent() || !(await host.authorize(search)).allowed) throw new Error('map-search-source-stale');
            return fetchAmapForwardGeocode({ key: settings.amapKey, address: destination!, city, strictCity: true });
          });
          if (!candidates.length) {
            lookup?.markGeocodeEmpty();
            const places = await runAmapQuery({ ...queryOptions, service: 'place' }, async () => {
              if (!await isCurrent() || !(await host.authorize(search)).allowed) throw new Error('map-search-source-stale');
              return fetchAmapPlaceTextSearch({ key: settings.amapKey, keywords: destination!, city, strictCity: true, limit: 25 });
            });
            candidates = places.map(textPlaceToDestination).filter((candidate): candidate is AmapGeocodeCandidate => !!candidate);
          }
        }
        candidates = candidates.filter((candidate) => normalizeCity(candidate.city) === normalizeCity(city));
        candidates = candidates.filter((candidate, index) => candidates.findIndex((other) => destinationReference(other) === destinationReference(candidate)
          && other.latitude === candidate.latitude && other.longitude === candidate.longitude) === index);
        if (candidates.length !== 1) return { destinationCandidates: candidates };
        const resolved = candidates[0];
        return { destination: resolved, center: { latitude: resolved.latitude, longitude: resolved.longitude, coordinateSystem: 'gcj02' } };
      },
      fetchPage: async (center, page, currentHost) => {
        const pageAuthorization = await currentHost.authorize({ ...search,
          evidence: currentHost.requestId === host.requestId ? search.evidence : undefined }, page > 1);
        if (!pageAuthorization.allowed) throw new Error('map-search-source-authorization-required');
        return runAmapQuery({ explicitRetry: pageAuthorization.explicitRetry, dataEpoch: currentHost.dataEpoch, service: 'place' }, async () => {
          if (!await currentHost.isSourceCurrent()) throw new Error('map-search-source-stale');
          return fetchAmapSearchPage({ ...center, key: settings.amapKey, query, radiusKm: search.radiusKm, page });
        });
      },
    });
  } catch (error) { return mapQueryFailure(call, error); }
}

async function executeMoreMapResults(call: JunLuoToolCall, context?: JunLuoToolExecutorContext) {
  try { return await continueMapSearch(call, context?.mapSearch); }
  catch (error) { return mapQueryFailure(call, error); }
}

class MapLocationError extends Error {
  constructor(readonly reason: 'permission' | 'quality') { super(reason); }
}

function normalizeCity(value: string | undefined) { return value?.trim().replace(/市$/u, '').toLocaleLowerCase(); }

function mapQueryFailure<T = unknown>(call: JunLuoToolCall, error: unknown): JunLuoToolResult<T> {
  let summary = '本次地图查询未完成。';
  if (error instanceof MapLocationError) summary = error.reason === 'permission' ? '尚未获得位置权限。' : '暂时没有足够准确的新定位。';
  else if (error instanceof AmapQueryPausedError) summary = '自动地图查询已暂停，等待明确重试。';
  else if (error instanceof AmapServiceError) summary = {
    network: '本次地图查询未完成：网络连接失败。', timeout: '本次地图查询未完成：请求超时。',
    rate_limit: '本次地图查询未完成：请求过于频繁。', config: '本次地图查询未完成：地图服务配置需要检查。',
    quota: '地图查询额度已用完。', unknown: '本次地图查询未完成。',
  }[error.kind];
  return createToolErrorResult<T>(call, createToolError(error instanceof MapLocationError && error.reason === 'permission' ? 'PERMISSION_DENIED' : 'EXECUTION_FAILED',
    error instanceof Error ? error.message : 'map-query-failed'), summary);
}

async function executeDescribeNearbyContext(call: JunLuoToolCall): Promise<JunLuoToolResult<NearbyContextData>> {
  const allowRefresh = readBooleanInput(call.input, 'allowRefresh') ?? true;
  const allowStale = readBooleanInput(call.input, 'allowStale') ?? true;
  const context = await buildNearbyWorldContext({ allowRefresh, allowStale, intent: 'explicit' });
  const snapshot = await loadNearbyWorldSnapshot();
  const data: NearbyContextData = {
    ...context.status,
    context: context.context,
    locationQuality: context.status.gpsQuality,
    nearbyPlaces: snapshot.status.poiCache.slice(0, 8).map((place) => ({
      address: place.address,
      categoryLabel: getNearbyWorldPoiCategoryLabel(place.category),
      distance: place.distance,
      name: place.name,
    })),
  };
  if (!context.context.trim()) {
    if (context.debug.permissionStatus === 'denied') {
      return createToolErrorResult(
        call,
        createToolError('PERMISSION_DENIED', 'location-denied'),
        '暂时没有可用附近世界摘要',
      );
    }
    return createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', context.status.enabled ? '附近世界暂时没有可用缓存' : '附近世界前台感知未拿到可用位置'),
      '暂时没有可用附近世界摘要',
    );
  }
  const uncertainty = context.status.stale ? '；缓存可能过期，回答时要说“上次看到/附近显示”' : '';
  return createToolSuccessResult(call, `已读取附近世界摘要${uncertainty}`, data);
}

async function executeVerifyLocationConsistency(call: JunLuoToolCall): Promise<JunLuoToolResult<LocationConsistencyData>> {
  const checkCurrent = readBooleanInput(call.input, 'checkCurrent') ?? true;
  const trusted = await resolveNearbyWorldLocation();
  const currentResolution = checkCurrent
    ? await resolveCurrentOrLastKnownLocationResolution()
    : { kind: 'unavailable' as const };
  if (checkCurrent && currentResolution.kind === 'permission_denied') {
    return createToolErrorResult(
      call,
      createToolError('PERMISSION_DENIED', 'location-denied'),
      '暂时无法判断定位是否漂移',
    );
  }
  const current = currentResolution.kind === 'available' ? currentResolution.location : null;
  const storedWeather = await loadStoredWeather().catch(() => undefined);
  const reasons: string[] = [];
  let status: LocationConsistencyData['status'] = 'uncertain';
  let confidence: LocationConsistencyData['confidence'] = 'uncertain';
  let conflictDistanceMeters: number | undefined;

  if (current?.source === 'last_known') {
    reasons.push('本次使用的是上次定位，不能据此确认当前位置。');
  }
  if (current && !hasComparableLocationQuality(current)) {
    reasons.push('本次定位的时间或精度不足，暂时无法可靠比较。');
  }
  if (trusted && !hasComparableLocationQuality(trusted)) {
    reasons.push('附近世界缓存的时间或精度不足，暂时无法可靠比较。');
  }
  if (trusted && current) {
    if (reasons.length === 0) {
      conflictDistanceMeters = distanceMeters(trusted, current);
      if (conflictDistanceMeters > LOCATION_CONFLICT_DISTANCE_M) {
        status = 'conflict';
        confidence = 'low';
        reasons.push(`当前定位与附近世界缓存相差约 ${formatDistance(conflictDistanceMeters)}`);
      } else {
        status = 'consistent';
        confidence = 'high';
        reasons.push(`当前定位与附近世界缓存距离约 ${formatDistance(conflictDistanceMeters)}`);
      }
    }
  } else if (trusted || current) {
    reasons.push(trusted ? '只有附近世界缓存可用' : '只有当前/上次定位可用');
  } else {
    reasons.push('没有可比较的定位来源');
  }
  if (storedWeather?.placeLabel && trusted?.placeLabel && !trusted.placeLabel.includes(storedWeather.placeLabel) && !storedWeather.placeLabel.includes(trusted.placeLabel)) {
    status = 'uncertain';
    confidence = confidence === 'high' ? 'medium' : confidence;
    reasons.push(`天气缓存位置显示为 ${storedWeather.placeLabel}，需要谨慎对照`);
  }

  const data: LocationConsistencyData = {
    confidence,
    conflictDistanceMeters,
    current: current ?? undefined,
    reasons,
    status,
    trusted: trusted ?? undefined,
    weatherPlaceLabel: storedWeather?.placeLabel,
  };

  if (!trusted && !current) {
    return createToolErrorResult(call, createToolError('EXECUTION_FAILED', '没有可比较的定位来源'), '暂时无法判断定位是否漂移');
  }
  return createToolSuccessResult(call, summarizeConsistency(data), data);
}

function hasComparableLocationQuality(location: ToolLocationData) {
  const now = Date.now();
  return typeof location.timestamp === 'number' && Number.isFinite(location.timestamp)
    && location.timestamp > 0 && location.timestamp <= now
    && now - location.timestamp <= NEARBY_LOCATION_MAX_AGE_MS
    && typeof location.accuracy === 'number' && Number.isFinite(location.accuracy)
    && location.accuracy >= 0 && location.accuracy <= NEARBY_LOCATION_MAX_ACCURACY_M;
}

async function assertWeatherSourceCurrent(context: JunLuoToolExecutorContext | undefined, epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch) || context?.mapSearch && !await context.mapSearch.isSourceCurrent()) {
    throw new Error('STALE_DATA_EPOCH');
  }
}

function weatherLocationFailure(call: JunLuoToolCall, kind: 'unavailable' | 'permission_denied') {
  return createToolErrorResult<never>(call,
    createToolError(kind === 'permission_denied' ? 'PERMISSION_DENIED' : 'EXECUTION_FAILED', kind === 'permission_denied' ? 'location-denied' : 'location-unavailable'),
    kind === 'permission_denied' ? '尚未获得位置权限。' : '暂时没有可用的新定位。');
}

function weatherQueryFailure(call: JunLuoToolCall, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'weather-location-stale') return weatherLocationFailure(call, 'unavailable');
  if (error instanceof AmapQueryPausedError || message === 'MAP_QUOTA_PAUSE_SAVE_FAILED'
    || error instanceof AmapServiceError && error.kind !== 'config') return mapQueryFailure<never>(call, error);
  const summary = error instanceof AmapServiceError && error.kind === 'config' ? '地点查询连接尚未配置。'
    : message === 'weather-place-not-found' ? '没有找到这个地点。' : '这次没有取得天气资料。';
  return createToolErrorResult<never>(call, createToolError(message === 'STALE_DATA_EPOCH' ? 'STALE_DATA_EPOCH' : 'EXECUTION_FAILED', message), summary);
}

function weatherToolLabel(observation: WeatherResolvedObservation) {
  const { weather, sourceCode } = observation;
  return weather.source === 'open-meteo' && weather.kind === 'rain'
    ? simpleRainLabel(sourceCode) ?? weather.label : weather.label;
}

function simpleRainLabel(code?: number) {
  return code === 61 ? '小雨' : code === 63 ? '中雨' : code === 65 ? '大雨'
    : code !== undefined && [80, 81, 82].includes(code) ? '阵雨' : undefined;
}

async function resolveWeatherToolLocation(context: JunLuoToolExecutorContext | undefined, epoch: number | null): Promise<ToolLocationResolution> {
  const { status } = await loadNearbyWorldSnapshot(true);
  await assertWeatherSourceCurrent(context, epoch);
  const saved: ToolLocationData = { latitude: status.latitude!, longitude: status.longitude!, accuracy: status.accuracy,
    timestamp: status.updatedAt, source: 'nearby_world' };
  if (status.coordinateSystem === 'wgs84' && isFreshLocation({ ...saved, timestamp: saved.timestamp! }, Date.now(), 1000)) {
    if (!(await Location.getForegroundPermissionsAsync()).granted) return { kind: 'permission_denied' };
    await assertWeatherSourceCurrent(context, epoch);
    const addressMatches = status.addressCenter?.latitude === saved.latitude && status.addressCenter?.longitude === saved.longitude
      && typeof status.addressUpdatedAt === 'number' && Number.isFinite(status.addressUpdatedAt)
      && status.addressUpdatedAt <= Date.now() && status.addressUpdatedAt >= status.updatedAt!;
    const place = addressMatches
      ? { address: status.address, city: status.city, district: status.district, placeLabel: status.placeLabel }
      : await reverseGeocodeWithSystem(saved.latitude, saved.longitude).catch(() => ({}));
    return { kind: 'available', location: { ...saved, ...place } };
  }
  if (!(await Location.requestForegroundPermissionsAsync()).granted) return { kind: 'permission_denied' };
  await assertWeatherSourceCurrent(context, epoch);
  const point = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced, mayShowUserSettingsDialog: true }).catch(() => null);
  await assertWeatherSourceCurrent(context, epoch);
  if (!point || !isFreshLocation({ ...point.coords, timestamp: point.timestamp }, Date.now(), 1000)) return { kind: 'unavailable' };
  const place = await reverseGeocodeWithSystem(point.coords.latitude, point.coords.longitude).catch(() => ({}));
  return { kind: 'available', location: { latitude: point.coords.latitude, longitude: point.coords.longitude,
    accuracy: point.coords.accuracy, timestamp: point.timestamp, source: 'current', ...place } };
}

async function resolveNearbyWorldLocation(): Promise<ToolLocationData | null> {
  const { settings, status } = await loadNearbyWorldSnapshot();
  if (!settings.enabled) return null;
  if (typeof status.latitude !== 'number' || typeof status.longitude !== 'number') return null;
  if (!status.updatedAt) return null;
  return {
    accuracy: status.accuracy,
    address: status.address,
    city: status.city,
    district: status.district,
    latitude: status.latitude,
    longitude: status.longitude,
    placeLabel: status.placeLabel || [status.city, status.district].filter(Boolean).join(' · ') || undefined,
    source: 'nearby_world',
    timestamp: status.updatedAt,
  };
}

async function resolveCurrentOrLastKnownLocationResolution(allowLastKnown = true): Promise<ToolLocationResolution> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) return { kind: 'permission_denied' };
  let location: Location.LocationObject | null = null;
  let source: ToolLocationData['source'] = 'current';
  try {
    location = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
      mayShowUserSettingsDialog: true,
    });
  } catch {
    if (!allowLastKnown) return { kind: 'unavailable' };
    location = await Location.getLastKnownPositionAsync({
      maxAge: 15 * 60 * 1000,
      requiredAccuracy: 5000,
    });
    source = 'last_known';
  }
  if (!location) return { kind: 'unavailable' };
  const place = await reverseGeocodeWithSystem(location.coords.latitude, location.coords.longitude).catch(() => ({}));
  return {
    kind: 'available',
    location: {
      accuracy: location.coords.accuracy,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      source,
      timestamp: location.timestamp,
      ...place,
    },
  };
}

async function resolveExplicitPlaceLocation(place: string, context?: JunLuoToolExecutorContext, epoch = captureBackupRestoreDataEpoch()): Promise<ToolLocationData> {
  const { settings } = await loadNearbyWorldSnapshot(true);
  if (!settings.amapKey.trim()) throw new AmapServiceError('config', 'geocode');
  const candidate = (await resolveAmapDestinationCandidates(
    settings.amapKey,
    place,
    undefined,
    3,
    context,
    epoch,
  )).find((item) => explicitPlaceMatchesCandidate(place, item));
  if (!candidate) throw new Error('weather-place-not-found');
  return {
    address: candidate.address,
    city: candidate.city,
    district: candidate.district,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    placeLabel: candidate.placeLabel || candidate.address || place,
    source: 'explicit',
  };
}

function explicitPlaceMatchesCandidate(place: string, candidate: AmapGeocodeCandidate) {
  const expected = normalizePlaceForComparison(place);
  const actual = normalizePlaceForComparison([
    candidate.placeLabel,
    candidate.address,
    candidate.city,
    candidate.district,
    candidate.province,
  ].filter(Boolean).join(''));
  return expected.length >= 2 && actual.length >= 2
    && (actual.includes(expected) || expected.includes(actual));
}

function weatherPlaceMatchesLocation(
  cachedPlaceLabel: string | undefined,
  currentPlaceLabel: string | undefined,
) {
  if (!cachedPlaceLabel || !currentPlaceLabel) return false;
  const cached = normalizePlaceForComparison(cachedPlaceLabel);
  const current = normalizePlaceForComparison(currentPlaceLabel);
  return cached.length >= 2 && current.length >= 2
    && (cached.includes(current) || current.includes(cached));
}

function normalizePlaceForComparison(value: string) {
  return value
    .toLocaleLowerCase('zh-CN')
    .replace(/[\s·，,。省市区县镇乡街道]+/gu, '');
}

function readExplicitLocation(call: JunLuoToolCall): ToolLocationData | null {
  const latitude = readNumberInput(call.input, 'latitude');
  const longitude = readNumberInput(call.input, 'longitude');
  if (latitude == null && longitude == null) return null;
  if (!isValidLatitude(latitude) || !isValidLongitude(longitude)) return null;
  return { latitude, longitude, source: 'explicit' };
}

async function reverseGeocodeWithSystem(latitude: number, longitude: number): Promise<Partial<ToolLocationData>> {
  const places = await Location.reverseGeocodeAsync({ latitude, longitude });
  const first = places[0];
  return {
    address: [first?.street, first?.name].filter(Boolean).join(' ') || undefined,
    city: first?.city ?? undefined,
    district: first?.district ?? undefined,
    placeLabel: [first?.city, first?.district, first?.street, first?.name].filter(Boolean).join(' · ') || undefined,
  };
}

function summarizeWeather(weather: WeatherState, source: WeatherCurrentData['source']) {
  const location = weather.placeLabel ? `${weather.placeLabel} ` : '';
  const temperature = weather.temperature == null ? '' : `，${weather.temperature}°C`;
  const sourceText = source === 'stored' ? '缓存天气' : '当前天气';
  return `已获取${location}${sourceText}：${weather.label}${temperature}`;
}

function summarizeReverseGeocode(data: ReverseGeocodeData) {
  const references = [
    data.nearbyAoi ? `附近区域：${data.nearbyAoi}` : '',
    data.nearbyPoi ? `附近参照点：${data.nearbyPoi}` : '',
    data.nearbyRoad ? `附近道路：${data.nearbyRoad}` : '',
  ].filter(Boolean);
  return [
    `已反查位置：${data.placeLabel || data.address || '地点摘要未知'}${formatAccuracy(data.accuracy)}`,
    data.address ? `详细地址：${data.address}` : '',
    references.length ? `附近参照：${references.join('；')}。这些是附近参照，不等于小仓鼠正在这些地点里面。` : '',
    `来源：${data.provider === 'amap' ? '高德' : '系统反查'}`,
  ].filter(Boolean).join('；');
}

function summarizeConsistency(data: LocationConsistencyData) {
  const prefix = data.status === 'consistent'
    ? '定位来源看起来基本一致'
    : data.status === 'conflict'
      ? '定位来源不一致，位置可能漂了'
      : '定位状态不确定';
  return `${prefix}：${data.reasons.join('；')}。回答时必须保留不确定性、来源、精度和时间边界。`;
}

function formatForecastDay(day: ForecastDay) {
  const temp = day.temperatureMin == null || day.temperatureMax == null
    ? ''
    : ` ${Math.round(day.temperatureMin)}-${Math.round(day.temperatureMax)}°C`;
  const rain = day.precipitationProbability == null ? '' : `，降雨概率 ${Math.round(day.precipitationProbability)}%`;
  return `${day.date} ${day.label}${temp}${rain}`;
}

function getOpenMeteoLabel(code?: number) {
  if (code == null) return '未知天气';
  if (code === 0) return '晴';
  if ([1, 2, 3].includes(code)) return '多云';
  if ([45, 48].includes(code)) return '雾';
  const rain = simpleRainLabel(code);
  if (rain) return rain;
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(code)) return '有雨';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return '有雪';
  return '天气有变化';
}

async function resolveAmapDestinationCandidates(key: string, query: string, city: string | undefined, limit: number,
  context?: JunLuoToolExecutorContext, epoch = captureBackupRestoreDataEpoch()) {
  await assertWeatherSourceCurrent(context, epoch);
  const geocodes = await runAmapQuery({ service: 'geocode', dataEpoch: epoch }, async () => {
    await assertWeatherSourceCurrent(context, epoch);
    return fetchAmapForwardGeocode({ address: query, city, key });
  });
  if (geocodes.length) return geocodes.slice(0, limit);
  const textPlaces = await runAmapQuery({ service: 'place', dataEpoch: epoch }, async () => {
    await assertWeatherSourceCurrent(context, epoch);
    return fetchAmapPlaceTextSearch({ city, key, keywords: query, limit });
  });
  return textPlaces.map(textPlaceToDestination).filter(Boolean).slice(0, limit) as AmapGeocodeCandidate[];
}

function textPlaceToDestination(place: AmapPlaceTextCandidate): AmapGeocodeCandidate | null {
  if (typeof place.latitude === 'number') {
    if (typeof place.longitude === 'number') {
      return {
        address: place.address,
        city: place.city,
        district: place.district,
        latitude: place.latitude,
        longitude: place.longitude,
        placeLabel: [place.city || place.province, place.district, place.name].filter(Boolean).join(' · '),
        province: place.province,
        source: 'text' as const,
      };
    }
  }
  return null;
}

function formatDestinationCandidate(candidate: AmapGeocodeCandidate) {
  return candidate.placeLabel || candidate.address || [candidate.city || candidate.province, candidate.district].filter(Boolean).join(' · ') || String(candidate.longitude) + ',' + String(candidate.latitude);
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}

function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}

function distanceMeters(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const earthRadius = 6371000;
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const deltaLat = toRadians(b.latitude - a.latitude);
  const deltaLon = toRadians(b.longitude - a.longitude);
  const h = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * earthRadius * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function toRadians(value: number) {
  return value * Math.PI / 180;
}

function formatDistance(distance: number) {
  if (distance >= 1000) return `${(distance / 1000).toFixed(distance >= 3000 ? 0 : 1)}公里`;
  return `${Math.max(10, Math.round(distance / 10) * 10)}米`;
}

function formatAccuracy(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `，精度约 ${Math.round(value)} 米`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export const weatherGetCurrentTool: JunLuoToolDefinition<Record<string, unknown>, WeatherCurrentData> = {
  id: 'weather.get_current',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'weather',
  name: '读取当前天气',
  description: '查询指定城市或地点的当前天气。不填地点时，查询 you 所在地的天气。',
  inputSchema: {
    type: 'object',
    properties: {
      place: { type: 'string', description: '想查天气的城市或地点。' },
    },
  },
  ...READ_ALLOW,
  backupRestoreSafeOutsideLease: true,
  agentEpochMode: 'bounded_local_commits',
  executor: executeGetCurrentWeather,
};

export const weatherGetForecastTool: JunLuoToolDefinition<Record<string, unknown>, WeatherForecastData> = {
  id: 'weather.get_forecast',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'weather',
  name: '读取天气预报',
  description: '查询指定城市或地点的天气预报，最多七天。不填地点时，查询 you 所在地的预报。',
  inputSchema: {
    type: 'object',
    properties: {
      days: { type: 'number', enum: [1, 2, 3, 4, 5, 6, 7], description: '从查询地点的今天开始查几天，填写 1 到 7；默认查今天和明天。' },
      place: { type: 'string', description: '想查天气的城市或地点。' },
    },
  },
  ...READ_ALLOW,
  agentEpochMode: 'read_only_outside_lease',
  backupRestoreSafeOutsideLease: true,
  executor: executeGetForecast,
};

export const mapReverseGeocodeTool: JunLuoToolDefinition<Record<string, unknown>, ReverseGeocodeData> = {
  id: 'map.reverse_geocode',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'map',
  name: '反查位置地址',
  description: '把明确提供的经纬度反查为地址、城市区县和附近参照。',
  inputSchema: {
    type: 'object',
    properties: {
      latitude: { type: 'number', description: '要反查的纬度。' },
      longitude: { type: 'number', description: '要反查的经度。' },
    },
    required: ['latitude', 'longitude'],
  },
  ...READ_ALLOW,
  readOnly: false,
  riskLevel: 'external_network',
  agentEpochMode: 'bounded_local_commits',
  backupRestoreSafeOutsideLease: true,
  executor: executeReverseGeocode,
};

export const mapGeocodePlaceTool: JunLuoToolDefinition = {
  id: 'map.geocode_place',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'map',
  name: '解析目的地',
  description: '把远方地名解析成高德地点候选和坐标；查不到时明确失败，不回退到当前位置。',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string' },
      limit: { type: 'number' },
      place: { type: 'string' },
    },
  },
  ...READ_ALLOW,
  readOnly: false,
  riskLevel: 'external_network',
  agentEpochMode: 'bounded_local_commits',
  backupRestoreSafeOutsideLease: true,
  executor: executeGeocodePlace,
};

export const mapSearchDestinationTool: JunLuoToolDefinition = {
  id: 'map.search_destination',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'map',
  name: '查询目的地地点候选',
  description: '在指定目的地周围搜索地点，每次返回至多五个候选。',
  inputSchema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: '目的地所在城市；对话里尚未明确时，先向 you 询问。' },
      destination: { type: 'string', description: '作为搜索中心的地名或地址。' },
      topic: { type: 'string', description: '想查的地点名称或关键词。' },
      evidence: MAP_CONSENT_EVIDENCE,
      radiusKm: { type: 'number', enum: [3, 5, 10], description: '搜索半径，单位公里，默认 3；使用 5 或 10 公里范围前，先与 you 确认。' },
    },
    required: ['destination', 'city', 'topic'],
  },
  ...READ_ALLOW,
  readOnly: false,
  riskLevel: 'external_network',
  agentEpochMode: 'bounded_local_commits',
  backupRestoreSafeOutsideLease: true,
  executor: executeSearchDestination,
};

export const mapSearchNearbyTool: JunLuoToolDefinition = {
  id: 'map.search_nearby',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'map',
  name: '查询附近地点候选',
  description: '基于当前前台位置搜索附近地点，每次返回至多五个候选。',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '想查的地点名称或关键词。' },
      evidence: MAP_CONSENT_EVIDENCE,
      radiusKm: { type: 'number', enum: [3, 5, 10], description: '搜索半径，单位公里，默认 3；使用 5 或 10 公里范围前，先与 you 确认。' },
    },
    required: ['query'],
  },
  ...READ_ALLOW,
  readOnly: false,
  riskLevel: 'external_network',
  agentEpochMode: 'bounded_local_commits',
  backupRestoreSafeOutsideLease: true,
  executor: executeSearchNearby,
};

export const mapMoreResultsTool: JunLuoToolDefinition = {
  id: 'map.more_results', packageId: 'map', name: '查看更多地点候选',
  chatExposure: 'candidate', proactiveEligible: false,
  description: '沿用刚才的搜索条件，再列出最多五个还没展示过的地点。',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  ...READ_ALLOW,
  readOnly: false,
  riskLevel: 'external_network',
  agentEpochMode: 'bounded_local_commits', backupRestoreSafeOutsideLease: true,
  executor: executeMoreMapResults,
};

export const nearbyDescribePlaceContextTool: JunLuoToolDefinition<Record<string, unknown>, NearbyContextData> = {
  id: 'nearby.describe_place_context',
  chatExposure: 'candidate',
  proactiveEligible: false,
  packageId: 'nearby',
  name: '描述附近世界摘要',
  description: '读取附近世界缓存和前台刷新结果，生成可给白云使用的附近环境摘要。',
  inputSchema: {
    type: 'object',
    properties: {
      allowRefresh: { type: 'boolean', description: '是否允许前台轻量刷新，默认 true' },
      allowStale: { type: 'boolean', description: '是否允许输出过期缓存，默认 true' },
    },
  },
  ...READ_ALLOW,
  readOnly: false,
  riskLevel: 'external_network',
  agentEpochMode: 'bounded_local_commits',
  backupRestoreSafeOutsideLease: true,
  executor: executeDescribeNearbyContext,
};

export const nearbyVerifyLocationConsistencyTool: JunLuoToolDefinition<Record<string, unknown>, LocationConsistencyData> = {
  id: 'nearby.verify_location_consistency',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'nearby',
  name: '校验定位一致性',
  description: '比较当前定位、附近世界缓存和天气位置，发现过期、漂移或多来源冲突时返回不确定。',
  inputSchema: {
    type: 'object',
    properties: {
      checkCurrent: { type: 'boolean', description: '是否读取一次当前前台定位参与比较，默认 true' },
    },
  },
  ...READ_ALLOW,
  agentEpochMode: 'read_only_outside_lease',
  backupRestoreSafeOutsideLease: true,
  executor: executeVerifyLocationConsistency,
};

export const weatherToolPackage: JunLuoToolPackage = {
  id: 'weather',
  name: '天气',
  description: '读取当前天气和轻量天气预报，供白云基于真实回执谈天气。',
  category: 'weather',
  tools: [weatherGetCurrentTool, weatherGetForecastTool],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};

export const mapToolPackage: JunLuoToolPackage = {
  id: 'map',
  name: '地图',
  description: '反查地址和查询附近地点候选，只读展示来源、距离和不确定边界。',
  category: 'map',
  tools: [mapReverseGeocodeTool, mapGeocodePlaceTool, mapSearchNearbyTool, mapSearchDestinationTool, mapMoreResultsTool],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};

export const nearbyToolPackage: JunLuoToolPackage = {
  id: 'nearby',
  name: '附近世界',
  description: '读取附近世界摘要并校验定位一致性，让白云能谨慎地陪你看见周围。',
  category: 'nearby',
  tools: [nearbyDescribePlaceContextTool, nearbyVerifyLocationConsistencyTool],
  defaultEnabled: true,
  riskLevel: 'read',
  source: 'builtin',
};
