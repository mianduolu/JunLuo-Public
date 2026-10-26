import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { JunLuoToolResult } from './toolTypes';
import { isWeatherMapNearbyAgentToolId } from './weatherMapNearbyAgentEvidence';

export const WEATHER_MODEL_FAILURE_SUMMARIES = new Set([
  '尚未获得位置权限。', '暂时没有可用的新定位。', '地点查询连接尚未配置。',
  '没有找到这个地点。', '这次没有取得天气资料。',
  // Reuse the already-reviewed map connection/quota states for place lookup.
  '本次地图查询未完成：网络连接失败。', '本次地图查询未完成：请求超时。',
  '本次地图查询未完成：请求过于频繁。', '地图查询额度已用完。',
  '自动地图查询已暂停，等待明确重试。', '本次地图查询未完成。',
]);

// Shorten only the model envelope; retain the original receipt for UI and audit.
export function mapSearchSummaryForModel(result: JunLuoToolResult, dataIncluded: boolean): string {
  if (!result.ok || !['map.search_nearby', 'map.search_destination', 'map.more_results'].includes(result.toolId)) {
    return result.summary;
  }
  const reminder = result.toolId === 'map.search_nearby'
    ? '这些只是附近候选，不代表评分、营业状态或推荐理由。'
    : '这些只是候选地点，不代表评分、营业状态或推荐理由。';
  const summary = result.summary.endsWith(reminder)
    ? result.summary.slice(0, -reminder.length) : result.summary;
  const candidates = asRecord(result.data)?.candidates;
  if (!dataIncluded || !Array.isArray(candidates) || !candidates.length) return summary;
  const prefix = summary.match(result.toolId === 'map.search_nearby'
    ? /^(附近显示 \d+ 个地点候选)：/u
    : /^(按高德解析为：[\s\S]*?；远方目的地显示 \d+ 个地点候选)：/u);
  return prefix ? `${prefix[1]}。` : summary;
}

export function projectWeatherMapNearbyResultForModel(
  invocation: Pick<JunLuoToolInvocation, 'toolId'>,
  fullResult: JunLuoToolResult,
): JunLuoToolResult {
  if (!isWeatherMapNearbyAgentToolId(invocation.toolId)) return fullResult;
  if (!fullResult.ok) return { ...fullResult, data: undefined,
    ...(invocation.toolId.startsWith('weather.') && fullResult.error?.code === 'EXECUTION_FAILED'
      && !WEATHER_MODEL_FAILURE_SUMMARIES.has(fullResult.summary)
      ? { summary: '这次没有取得天气资料。' } : {}),
  };
  const data = asRecord(fullResult.data);
  if (invocation.toolId.startsWith('weather.')) {
    return { ...fullResult, summary: '', data: data ? projectWeather(data) : undefined };
  }
  if (!data) return { ...fullResult, data: undefined };
  if (invocation.toolId.startsWith('map.')) {
    return { ...fullResult, data: projectMap(data) };
  }
  if (invocation.toolId === 'nearby.describe_place_context') return { ...fullResult, data: { context: data.context } };
  return { ...fullResult, data: projectNearby(data) };
}

function projectWeather(data: Record<string, unknown>) {
  const location = asRecord(data.location);
  const weather = asRecord(data.weather);
  const place = weather?.placeLabel ?? location?.placeLabel;
  const basis = location?.source === 'explicit' ? '指定地点'
    : location && ['current', 'nearby_world'].includes(String(location.source)) ? '手机定位' : undefined;
  const lines = [typeof place === 'string' && place ? `地点：${place}` : '', basis ? `位置依据：${basis}` : ''].filter(Boolean);
  if (weather) {
    const observedAt = weather.observedAt;
    lines.push(`天气获取时间：${typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt > 0
      && observedAt <= Date.now() && Number.isFinite(new Date(observedAt).getTime())
      ? new Date(observedAt).toLocaleString() : '未记录'}`);
    if (data.source === 'fresh' || data.source === 'stored') lines.push(`资料状态：${data.source === 'fresh' ? '本次查到' : '旧天气参考'}`);
    const label = data.displayLabel ?? weather.label;
    if (typeof label === 'string' && label) lines.push(`天气：${label}`);
    if (finite(weather.temperature)) lines.push(`气温：${weather.temperature} ℃`);
  }
  if (Array.isArray(data.days)) for (const item of data.days) {
    const day = asRecord(item);
    if (!day || typeof day.date !== 'string' || !day.date) continue;
    lines.push('', `日期：${day.date}`);
    if (typeof day.label === 'string' && day.label) lines.push(`预报天气：${day.label}`);
    if (finite(day.temperatureMin)) lines.push(`最低气温：${day.temperatureMin} ℃`);
    if (finite(day.temperatureMax)) lines.push(`最高气温：${day.temperatureMax} ℃`);
  }
  return lines.join('\n').trim();
}

function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

function projectMap(data: Record<string, unknown>) {
  const location = asRecord(data.location);
  const destination = asRecord(data.destination);
  const firstCandidate = Array.isArray(data.candidates)
    ? asRecord(data.candidates[0])
    : undefined;
  return compactRecord({
    candidates: projectPlaces(data.candidates),
    placeLabel: data.placeLabel ?? destination?.placeLabel ?? location?.placeLabel ?? firstCandidate?.placeLabel,
    address: data.address ?? destination?.address ?? location?.address ?? firstCandidate?.address,
    city: data.city ?? destination?.city ?? location?.city ?? firstCandidate?.city,
    district: data.district ?? destination?.district ?? location?.district ?? firstCandidate?.district,
    nearbyAoi: data.nearbyAoi,
    nearbyPoi: data.nearbyPoi,
    nearbyRoad: data.nearbyRoad,
    provider: data.provider,
    scope: data.scope,
  });
}

function projectNearby(data: Record<string, unknown>) {
  const trusted = asRecord(data.trusted);
  const current = asRecord(data.current);
  return compactRecord({
    available: data.available,
    stale: data.stale,
    presence: data.presence,
    placeLabel: data.placeLabel,
    address: data.address,
    locationQuality: data.locationQuality,
    lastUpdatedAt: data.lastUpdatedAt,
    nearbyReferences: data.nearbyReferences,
    nearbyPlaces: projectPlaces(data.nearbyPlaces),
    status: data.status,
    confidence: data.confidence,
    conflictDistanceMeters: data.conflictDistanceMeters,
    reasons: data.reasons,
    trustedPlaceLabel: trusted?.placeLabel,
    currentPlaceLabel: current?.placeLabel,
    weatherPlaceLabel: data.weatherPlaceLabel,
  });
}

function projectPlaces(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => {
    const place = asRecord(item);
    return place ? compactRecord({
      name: place.name,
      categoryLabel: place.categoryLabel,
      distance: place.distance,
      address: place.address,
      city: place.city,
      district: place.district,
    }) : undefined;
  }).filter((item): item is Record<string, unknown> => !!item);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactRecord(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
