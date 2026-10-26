import type { NearbyWorldPoi, NearbyWorldPoiCategory } from './nearbyWorldStore';
import { isValidMapCoordinate, mapDistanceMeters, toAmapCoordinate, type AmapCoordinateSystem } from './amapCoordinates';

export type AmapService = 'regeo' | 'place' | 'geocode';
export type AmapFailureKind = 'network' | 'timeout' | 'rate_limit' | 'config' | 'quota' | 'unknown';
export class AmapServiceError extends Error {
  constructor(public readonly kind: AmapFailureKind, public readonly service: AmapService, public readonly infocode?: string) {
    super(`Amap ${service}: ${kind}${infocode ? ` (${infocode})` : ''}`);
    this.name = 'AmapServiceError';
  }
}

type AmapAddressComponent = {
  city?: string | string[];
  district?: string;
  township?: string;
};

type AmapRegeoResponse = {
  status?: string;
  info?: string;
  infocode?: string;
  regeocode?: {
    formatted_address?: string;
    addressComponent?: AmapAddressComponent;
    aois?: Array<{
      name?: string;
      distance?: string;
      type?: string;
    }>;
    pois?: Array<{
      id?: string;
      name?: string;
      address?: string | string[];
      distance?: string;
      type?: string;
    }>;
    roads?: Array<{
      name?: string;
      distance?: string;
      direction?: string;
    }>;
  };
};

type AmapPoiResponse = {
  status?: string;
  info?: string;
  infocode?: string;
  count?: string;
  pois?: Array<{
    id?: string;
    location?: string;
    name?: string;
    address?: string | string[];
    pname?: string;
    cityname?: string | string[];
    adname?: string;
    type?: string;
    distance?: string;
  }>;
};

type AmapGeocodeResponse = {
  status?: string;
  info?: string;
  infocode?: string;
  geocodes?: Array<{
    formatted_address?: string;
    province?: string;
    city?: string | string[];
    district?: string;
    township?: string;
    location?: string;
    level?: string;
  }>;
};

export type AmapNearbyPlace = {
  placeLabel?: string;
  address?: string;
  city?: string;
  district?: string;
  township?: string;
  nearbyAoi?: string;
  nearbyPoi?: string;
  nearbyRoad?: string;
};

export type AmapNearbySnapshot = {
  place: AmapNearbyPlace;
  pois: NearbyWorldPoi[];
};

export type AmapGeocodeCandidate = {
  address?: string;
  city?: string;
  district?: string;
  latitude: number;
  level?: string;
  longitude: number;
  placeLabel?: string;
  province?: string;
  source: 'geocode' | 'text';
  township?: string;
};

export type AmapPlaceTextCandidate = Omit<NearbyWorldPoi, 'category' | 'updatedAt'> & {
  city?: string;
  district?: string;
  latitude?: number;
  longitude?: number;
  province?: string;
};

export type AmapSearchCandidate = {
  id: string;
  name: string;
  address?: string;
  city?: string;
  district?: string;
  type?: string;
  latitude: number;
  longitude: number;
  distance: number;
};

export async function fetchAmapSearchPage(input: {
  latitude: number; longitude: number; coordinateSystem: AmapCoordinateSystem;
  key: string; query: string; radiusKm: 3 | 5 | 10; page: number;
}): Promise<{ candidates: AmapSearchCandidate[]; rawCount: number; hasMore: boolean }> {
  if (!input.key.trim() || !input.query.trim() || !isValidMapCoordinate(input)
    || ![3, 5, 10].includes(input.radiusKm) || !Number.isInteger(input.page) || input.page < 1) {
    throw new AmapServiceError('config', 'place');
  }
  // Amap only exposes the first 200 results. Never spend a request past that boundary.
  if (input.page > 8) return { candidates: [], rawCount: 0, hasMore: false };
  const center = toAmapCoordinate(input, input.coordinateSystem);
  const url = buildAmapUrl('https://restapi.amap.com/v3/place/around', {
    key: input.key.trim(), keywords: input.query.trim(), location: `${center.longitude},${center.latitude}`,
    radius: String(input.radiusKm * 1000), offset: '25', page: String(input.page), extensions: 'base',
  });
  const json = await fetchJsonWithTimeout<AmapPoiResponse>(url);
  assertAmapSuccess(json, 'place');
  const raw = (json.pois ?? []).slice(0, 25);
  const seen = new Set<string>();
  const candidates: AmapSearchCandidate[] = [];
  for (const poi of raw) {
    const name = normalizeAmapText(poi.name);
    const point = parseAmapLocation(poi.location);
    if (!name || !point) continue;
    const distance = mapDistanceMeters(center, point);
    if (distance > input.radiusKm * 1000) continue;
    const address = normalizeAmapText(poi.address);
    const id = normalizeAmapText(poi.id) ?? `${name}|${address ?? ''}|${point.longitude},${point.latitude}`;
    if (seen.has(id)) continue;
    seen.add(id);
    candidates.push({ id, name, address, ...point, distance, city: normalizeAmapText(poi.cityname),
      district: normalizeAmapText(poi.adname), type: normalizeAmapText(poi.type) });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  const count = nonnegativeNumber(json.count);
  return { candidates, rawCount: raw.length,
    hasMore: raw.length === 25 && input.page < 8 && (count === undefined || input.page * 25 < count) };
}

const POI_TYPES: Record<NearbyWorldPoiCategory, string> = {
  food: '050000',
  leisure: '080000',
  scenery: '110000',
  shopping: '060000',
};

export function getAmapPoiTypes(categories: NearbyWorldPoiCategory[]) {
  const types = [...new Set(categories.map((category) => POI_TYPES[category]).filter(Boolean))];
  return types.length ? types.join('|') : undefined;
}

export async function fetchAmapNearbySnapshot(input: {
  key: string;
  latitude: number;
  longitude: number;
  categories: NearbyWorldPoiCategory[];
  now?: number;
  ambient?: boolean;
  coordinateSystem?: AmapCoordinateSystem;
}): Promise<AmapNearbySnapshot> {
  const key = input.key.trim();
  if (!key) {
    return { place: {}, pois: [] };
  }
  const now = input.now ?? Date.now();
  const center = input.coordinateSystem ? toAmapCoordinate(input, input.coordinateSystem) : input;
  const location = `${center.longitude},${center.latitude}`;
  if (input.ambient) {
    const json = await fetchAmapRegeo({ key, location });
    return { place: parseAmapRegeoPlace(json),
      pois: parseCategorizedPois(json.regeocode?.pois ?? [], input.categories, now, 8, 'regeo') };
  }
  const [place, pois] = await Promise.all([
    fetchAmapReverseGeocode({ key, location }),
    fetchAmapNearbyPois({ ...input, key, now, mixed: true }),
  ]);
  return { place, pois };
}

export async function fetchAmapNearbyPois(input: {
  key: string;
  latitude: number;
  longitude: number;
  categories: NearbyWorldPoiCategory[];
  now?: number;
  mixed?: boolean;
  keywords?: string;
  coordinateSystem?: AmapCoordinateSystem;
}): Promise<NearbyWorldPoi[]> {
  const key = input.key.trim();
  if (!key) return [];
  const now = input.now ?? Date.now();
  const center = input.coordinateSystem ? toAmapCoordinate(input, input.coordinateSystem) : input;
  const location = `${center.longitude},${center.latitude}`;
  const keywords = input.keywords?.trim();
  if (input.mixed && input.categories.length > 1) {
    const url = buildAmapUrl('https://restapi.amap.com/v3/place/around', {
      key, location, types: getAmapPoiTypes(input.categories)!, radius: '1200', offset: '16', page: '1', extensions: 'base',
      ...(keywords ? { keywords } : {}),
    });
    const json = await fetchJsonWithTimeout<AmapPoiResponse>(url);
    assertAmapSuccess(json, 'place');
    return parseCategorizedPois(json.pois ?? [], input.categories, now, 16, 'around');
  }
  const poiGroups = await Promise.all(input.categories.slice(0, 4).map(async (category) => {
    const pois = await fetchAmapPois({ key, location, category, keywords });
    return pois.map((poi) => ({ ...poi, category, updatedAt: now }));
  }));
  return poiGroups.flat().slice(0, 16);
}

function parseCategorizedPois(
  items: NonNullable<AmapPoiResponse['pois']>, categories: NearbyWorldPoiCategory[], now: number, limit: number, prefix: string,
): NearbyWorldPoi[] {
  const categoriesByType: Record<string, NearbyWorldPoiCategory> = {
    '餐饮服务': 'food', '体育休闲服务': 'leisure', '风景名胜': 'scenery', '购物服务': 'shopping',
  };
  const seen = new Set<string>();
  const pois: NearbyWorldPoi[] = [];
  for (const poi of items) {
    const name = normalizeAmapText(poi.name);
    const type = normalizeAmapText(poi.type);
    const category = categoriesByType[type?.split(';')[0] ?? ''];
    if (!name || !category || !categories.includes(category)) continue;
    const address = normalizeAmapText(poi.address);
    const id = normalizeAmapText(poi.id) ?? `${prefix}-${name}-${address ?? ''}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const distance = nonnegativeNumber(poi.distance);
    pois.push({ id, name, address, type, category, updatedAt: now,
      distance: Number.isFinite(distance) ? distance : undefined });
    if (pois.length === limit) break;
  }
  return pois;
}

export async function fetchAmapReverseGeocode(input: { key: string; location: string; coordinateSystem?: AmapCoordinateSystem }): Promise<AmapNearbyPlace> {
  if (!input.coordinateSystem) return parseAmapRegeoPlace(await fetchAmapRegeo(input));
  const parsed = parseAmapLocation(input.location);
  if (!parsed) throw new AmapServiceError('config', 'regeo');
  const center = toAmapCoordinate(parsed, input.coordinateSystem);
  return parseAmapRegeoPlace(await fetchAmapRegeo({ key: input.key, location: `${center.longitude},${center.latitude}` }));
}

async function fetchAmapRegeo(input: { key: string; location: string }): Promise<AmapRegeoResponse> {
  const url = buildAmapUrl('https://restapi.amap.com/v3/geocode/regeo', {
    key: input.key,
    location: input.location,
    extensions: 'all',
    radius: '300',
    roadlevel: '0',
  });
  const json = await fetchJsonWithTimeout<AmapRegeoResponse>(url);
  assertAmapSuccess(json, 'regeo');
  return json;
}

function parseAmapRegeoPlace(json: AmapRegeoResponse): AmapNearbyPlace {
  const component = json.regeocode?.addressComponent;
  const city = normalizeAmapText(component?.city);
  const district = normalizeAmapText(component?.district);
  const township = normalizeAmapText(component?.township);
  const address = normalizeAmapText(json.regeocode?.formatted_address);
  const nearbyAoi = pickNearestNamed(json.regeocode?.aois);
  const nearbyPoi = pickNearestNamed(json.regeocode?.pois);
  const nearbyRoad = pickNearestNamed(json.regeocode?.roads);
  const placeLabel = [city, district || township].filter(Boolean).join(' · ') || address;
  return { placeLabel, address, city, district, township, nearbyAoi, nearbyPoi, nearbyRoad };
}

export async function fetchAmapForwardGeocode(input: {
  address: string;
  city?: string;
  key: string;
  strictCity?: boolean;
}): Promise<AmapGeocodeCandidate[]> {
  const address = input.address.trim();
  const key = input.key.trim();
  if (key.length === 0 || address.length === 0) return [];
  const params: Record<string, string> = { address, key };
  if (input.city?.trim()) params.city = input.city.trim();
  const url = buildAmapUrl('https://restapi.amap.com/v3/geocode/geo', params);
  const json = await fetchJsonWithTimeout<AmapGeocodeResponse>(url);
  assertAmapSuccess(json, 'geocode');
  if (json.status === '1') {
    return (json.geocodes ?? [])
      .map<AmapGeocodeCandidate | null>((item) => {
        const parsed = parseAmapLocation(item.location);
        if (parsed === null) return null;
        const city = normalizeAmapText(item.city);
        const district = normalizeAmapText(item.district);
        const township = normalizeAmapText(item.township);
        const addressText = normalizeAmapText(item.formatted_address);
        const province = normalizeAmapText(item.province);
        const placeLabel = [city || province, district || township].filter(Boolean).join(' · ') || addressText || address;
        return { address: addressText, city, district, latitude: parsed.latitude, level: normalizeAmapText(item.level), longitude: parsed.longitude, placeLabel, province, source: 'geocode', township };
      })
      .filter((item): item is AmapGeocodeCandidate => item !== null)
      .filter((item) => !input.strictCity || amapCityMatches(input.city, item.city));
  }
  return [];
}

export async function fetchAmapPlaceTextSearch(input: {
  city?: string;
  key: string;
  keywords: string;
  limit?: number;
  types?: string;
  strictCity?: boolean;
}): Promise<AmapPlaceTextCandidate[]> {
  const key = input.key.trim();
  const keywords = input.keywords.trim();
  if (key.length === 0 || keywords.length === 0) return [];
  const params: Record<string, string> = { citylimit: input.strictCity ? 'true' : 'false', extensions: 'base', key, keywords, offset: String(Math.max(1, Math.min(25, Math.round(input.limit ?? 10)))), page: '1' };
  if (input.city?.trim()) params.city = input.city.trim();
  if (input.types?.trim()) params.types = input.types.trim();
  const url = buildAmapUrl('https://restapi.amap.com/v3/place/text', params);
  const json = await fetchJsonWithTimeout<AmapPoiResponse>(url);
  assertAmapSuccess(json, 'place');
  if (json.status === '1') {
    return (json.pois ?? [])
      .map<AmapPlaceTextCandidate | null>((poi, index) => {
        const name = normalizeAmapText(poi.name);
        if (name === undefined) return null;
        const parsed = parseAmapLocation(poi.location);
        const distance = nonnegativeNumber(poi.distance);
        return { address: normalizeAmapText(poi.address), city: normalizeAmapText(poi.cityname), district: normalizeAmapText(poi.adname), id: poi.id || 'text-' + index + '-' + name, latitude: parsed?.latitude, longitude: parsed?.longitude, name, province: normalizeAmapText(poi.pname), type: normalizeAmapText(poi.type), distance: Number.isFinite(distance) ? distance : undefined };
      })
      .filter((item): item is AmapPlaceTextCandidate => item !== null)
      .filter((item) => !input.strictCity || amapCityMatches(input.city, item.city));
  }
  return [];
}

async function fetchAmapPois(input: {
  key: string;
  location: string;
  category: NearbyWorldPoiCategory;
  keywords?: string;
}): Promise<Omit<NearbyWorldPoi, 'category' | 'updatedAt'>[]> {
  const url = buildAmapUrl('https://restapi.amap.com/v3/place/around', {
    key: input.key,
    location: input.location,
    types: POI_TYPES[input.category],
    ...(input.keywords ? { keywords: input.keywords } : {}),
    radius: '1200',
    offset: '4',
    page: '1',
    extensions: 'base',
  });
  const json = await fetchJsonWithTimeout<AmapPoiResponse>(url);
  assertAmapSuccess(json, 'place');
  return (json.pois ?? [])
    .map<Omit<NearbyWorldPoi, 'category' | 'updatedAt'> | null>((poi, index) => {
      const name = normalizeAmapText(poi.name);
      if (!name) return null;
      const distance = nonnegativeNumber(poi.distance);
      return {
        id: poi.id || `${input.category}-${index}-${name}`,
        name,
        address: normalizeAmapText(poi.address),
        type: normalizeAmapText(poi.type),
        distance: Number.isFinite(distance) ? distance : undefined,
      };
    })
    .filter((item): item is Omit<NearbyWorldPoi, 'category' | 'updatedAt'> => item !== null);
}

function buildAmapUrl(base: string, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return `${base}?${search.toString()}`;
}

async function fetchJsonWithTimeout<T>(url: string, timeoutMs = 8000): Promise<T> {
  const service: AmapService = url.includes('/geocode/regeo') ? 'regeo' : url.includes('/geocode/geo') ? 'geocode' : 'place';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new AmapServiceError(response.status === 429 ? 'rate_limit'
        : response.status === 401 || response.status === 403 ? 'config' : 'network', service);
    }
    try {
      return (await response.json()) as T;
    } catch (error) {
      if (controller.signal.aborted) throw new AmapServiceError('timeout', service);
      throw new AmapServiceError(error instanceof SyntaxError ? 'unknown' : 'network', service);
    }
  } catch (error) {
    if (error instanceof AmapServiceError) throw error;
    throw new AmapServiceError(controller.signal.aborted || (error instanceof Error && error.name === 'AbortError') ? 'timeout' : 'network', service);
  } finally {
    clearTimeout(timer);
  }
}

function assertAmapSuccess(json: { status?: string; infocode?: string; info?: string }, service: AmapService): void {
  if (json?.status === '1') return;
  const code = String(json?.infocode ?? '');
  const info = json?.info ?? '';
  const quota = ['10003', '10010', '10044', '10045', '40000'];
  const rate = ['10004', '10014', '10015', '10019', '10020', '10021', '10029'];
  const config = ['10001', '10002', '10005', '10006', '10007', '10008', '10009', '10011', '10012', '10013', '10026', '10041', '20000', '20001', '20002', '20011', '40002'];
  // Some legacy responses omit infocode. Only exact documented names classify them.
  const kind: AmapFailureKind = quota.includes(code)
    || ['DAILY_QUERY_OVER_LIMIT', 'IP_QUERY_OVER_LIMIT', 'USER_DAILY_QUERY_OVER_LIMIT', 'USER_ABROAD_DAILY_QUERY_OVER_LIMIT', 'QUOTA_PLAN_RUN_OUT'].includes(info) ? 'quota'
    : rate.includes(code) || ['ACCESS_TOO_FREQUENT', 'QPS_HAS_EXCEEDED_THE_LIMIT', 'CQPS_HAS_EXCEEDED_THE_LIMIT', 'CKQPS_HAS_EXCEEDED_THE_LIMIT', 'CUQPS_HAS_EXCEEDED_THE_LIMIT'].includes(info) ? 'rate_limit'
    : config.includes(code) || ['INVALID_USER_KEY', 'SERVICE_NOT_AVAILABLE', 'INSUFFICIENT_PRIVILEGES', 'USER_KEY_RECYCLED'].includes(info) ? 'config' : 'unknown';
  throw new AmapServiceError(kind, service, code || undefined);
}

export function amapCityMatches(expected?: string, actual?: string): boolean {
  const normalize = (value?: string) => value?.trim().replace(/\s+/g, '').replace(/市$/, '');
  const wanted = normalize(expected);
  return Boolean(wanted && wanted === normalize(actual));
}

function nonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function normalizeAmapText(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return value.map(String).find((item) => item.trim())?.trim();
  }
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseAmapLocation(value: unknown): { latitude: number; longitude: number } | null {
  if (typeof value !== 'string') return null;
  const [longitudeText, latitudeText] = value.split(',');
  if (!longitudeText?.trim() || !latitudeText?.trim() || value.split(',').length !== 2) return null;
  const longitude = Number(longitudeText);
  const latitude = Number(latitudeText);
  if (isValidMapCoordinate({ latitude, longitude })) {
    return { latitude, longitude };
  }
  return null;
}

function pickNearestNamed(items?: Array<{ name?: string; distance?: string }>): string | undefined {
  const sorted = (items ?? [])
    .map((item) => {
      const name = normalizeAmapText(item.name);
      const distance = nonnegativeNumber(item.distance);
      if (!name) return null;
      return { name, distance: distance ?? Number.POSITIVE_INFINITY };
    })
    .filter((item): item is { name: string; distance: number } => item !== null)
    .sort((left, right) => left.distance - right.distance);
  return sorted[0]?.name;
}
