import { refreshNearbyWorldIfAllowed } from './nearbyWorldService';
import { isFreshNearbyStatus } from './nearbyLocationPolicy';
import { withValidPresenceReport } from './nearbyPresence';
import {
  getNearbyWorldPoiCategoryLabel,
  loadNearbyWorldSnapshot,
  type NearbyWorldPoi,
  type NearbyWorldPresence,
  type NearbyWorldStatus,
} from './nearbyWorldStore';

export type NearbyWorldContextIntent = 'auto' | 'explicit' | 'proactive';

export type NearbyWorldContextResult = {
  context: string;
  status: {
    enabled: boolean;
    available: boolean;
    stale: boolean;
    presence: NearbyWorldPresence;
    poiCount: number;
    hasAmapKey: boolean;
    accuracy?: number | null;
    address?: string;
    backgroundProfile?: string;
    gpsQuality?: string;
    batteryWarning?: boolean;
    lastUpdatedAt?: number;
    nearbyReferences: string[];
    placeLabel?: string;
    precisionLastActiveAt?: number;
    precisionMode: string;
    precisionStopReason?: string | null;
  };
  debug: {
    enabled: boolean;
    available: boolean;
    backgroundProfile?: string;
    gpsQuality?: string;
    batteryWarning?: boolean;
    stale: boolean;
    poiCount: number;
    hasAmapKey: boolean;
    permissionStatus: string;
    precisionMode: string;
    precisionStopReason?: string | null;
  };
};

const POI_STALE_MS = 6 * 60 * 60 * 1000;

export async function buildNearbyWorldContext(options?: {
  intent?: NearbyWorldContextIntent;
  allowStale?: boolean;
  allowRefresh?: boolean;
  readOnly?: boolean;
}): Promise<NearbyWorldContextResult> {
  if (options?.allowRefresh && !options.readOnly) {
    await refreshNearbyWorldIfAllowed({ explicit: options.intent === 'explicit' });
  }
  const snapshot = await loadNearbyWorldSnapshot(options?.readOnly);
  const settings = snapshot.settings;
  const status = await withValidPresenceReport(snapshot.status);
  const now = Date.now();
  const locationStale = !isFreshNearbyStatus(status, now);
  const poiStale = !status.poiUpdatedAt || now - status.poiUpdatedAt > POI_STALE_MS;
  const stale = locationStale || poiStale;
  const available = Boolean(status.updatedAt || status.presenceReport);
  const nearbyReferences = buildNearbyReferences(status);
  const resultBase = {
    enabled: settings.enabled,
    available,
    stale,
    presence: status.presence,
    poiCount: status.poiCache.length,
    hasAmapKey: Boolean(settings.amapKey.trim()),
    accuracy: status.accuracy,
    address: status.address,
    backgroundProfile: status.backgroundProfile,
    batteryWarning: status.batteryWarning,
    gpsQuality: status.gpsQuality,
    lastUpdatedAt: status.updatedAt,
    nearbyReferences,
    placeLabel: status.placeLabel,
    precisionLastActiveAt: status.precisionLastActiveAt,
    precisionMode: status.precisionMode,
    precisionStopReason: status.precisionStopReason,
  };
  if (!available) {
    return {
      context: '',
      status: resultBase,
      debug: {
        enabled: settings.enabled,
        available,
        stale,
        poiCount: status.poiCache.length,
        hasAmapKey: Boolean(settings.amapKey.trim()),
        backgroundProfile: status.backgroundProfile,
        batteryWarning: status.batteryWarning,
        gpsQuality: status.gpsQuality,
        permissionStatus: status.permissionStatus,
        precisionMode: status.precisionMode,
        precisionStopReason: status.precisionStopReason,
      },
    };
  }

  const lines: string[] = ['【you 的位置与附近】', '',
    'I 结合近期对话，以及以下资料的来源、时间和精度，理解 you 的位置。', ''];
  if (status.presenceReport) {
    const report = status.presenceReport;
    lines.push(`you 最近说明：${new Date(report.sentAt).toLocaleString()}，${report.state}；原话：${report.quote}`);
  }
  if (status.updatedAt && Number.isFinite(status.updatedAt)) {
    const accuracy = typeof status.accuracy === 'number' && Number.isFinite(status.accuracy) && status.accuracy >= 0
      ? `，精度约 ${Math.round(status.accuracy)} 米` : '';
    lines.push(`手机定位：${new Date(status.updatedAt).toLocaleString()}，${locationStale ? '上次定位' : '新近定位'}${accuracy}`);
  }
  if (status.distanceFromHome != null && Number.isFinite(status.distanceFromHome)) {
    lines.push(`定位点离家：约 ${formatDistance(status.distanceFromHome)}，直线距离`);
  }
  const placeParts = [status.placeLabel, status.address].filter((value): value is string => Boolean(value));
  const place = placeParts.filter((value, index) => !placeParts.some((other, otherIndex) =>
    otherIndex !== index && (other.length > value.length || otherIndex < index) && other.includes(value))).join('；');
  if (place && status.addressUpdatedAt && status.addressCenter) {
    lines.push(`上次查到的位置参照：${new Date(status.addressUpdatedAt).toLocaleString()}，${place}`);
  }
  const pois = selectPois(status.poiCache, { includeStale: true });
  if (status.poiUpdatedAt && status.poiCenter && pois.length) {
    lines.push(`上次查到的附近地点：${new Date(status.poiUpdatedAt).toLocaleString()}，${pois.map(formatPoi).join('；')}`);
  }
  if (status.precisionMode !== 'off') {
    lines.push(`一起状态：${describePrecisionMode(status.precisionMode)}`);
  }
  return {
    context: lines.join('\n'),
    status: resultBase,
    debug: {
      enabled: settings.enabled,
      available: true,
      stale,
      poiCount: pois.length,
      hasAmapKey: Boolean(settings.amapKey.trim()),
      backgroundProfile: status.backgroundProfile,
      batteryWarning: status.batteryWarning,
      gpsQuality: status.gpsQuality,
      permissionStatus: status.permissionStatus,
      precisionMode: status.precisionMode,
      precisionStopReason: status.precisionStopReason,
    },
  };
}

function describePrecisionMode(value: string): string {
  if (value === 'walking') return '一起走';
  if (value === 'transit') return '交通工具上';
  return '未开启';
}

function buildNearbyReferences(status: NearbyWorldStatus): string[] {
  return [
    status.nearbyAoi ? `附近区域：${status.nearbyAoi}` : '',
    status.nearbyPoi ? `附近参照点：${status.nearbyPoi}` : '',
    status.nearbyRoad ? `附近道路：${status.nearbyRoad}` : '',
  ].filter(Boolean);
}

function selectPois(pois: NearbyWorldPoi[], options: { includeStale: boolean }): NearbyWorldPoi[] {
  if (!options.includeStale) return [];
  const seen = new Set<string>();
  return pois
    .filter((poi) => {
      const key = poi.id || `${poi.name}:${poi.address ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 8);
}

function formatPoi(poi: NearbyWorldPoi): string {
  const distance = poi.distance != null ? `，约${formatDistance(poi.distance)}` : '';
  return `${getNearbyWorldPoiCategoryLabel(poi.category)}：${poi.name}${distance}`;
}

function formatDistance(distance: number): string {
  if (distance >= 1000) return `${(distance / 1000).toFixed(distance >= 3000 ? 0 : 1)}公里`;
  return `${Math.max(10, Math.round(distance / 10) * 10)}米`;
}
