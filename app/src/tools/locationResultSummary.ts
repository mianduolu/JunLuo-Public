import type { NearbyWorldStatus } from '../nearby/nearbyWorldStore';

export const NEARBY_WORLD_TOOL_MAX_AGE_MS = 45 * 60 * 1000;

export type CurrentLocationData = {
  accuracy?: number | null;
  address?: string;
  altitude?: number | null;
  backgroundProfile?: NearbyWorldStatus['backgroundProfile'];
  batteryWarning?: boolean;
  city?: string;
  district?: string;
  gpsQuality?: NearbyWorldStatus['gpsQuality'];
  locationAgeMs?: number;
  nearbyAoi?: string;
  nearbyPoi?: string;
  nearbyRoad?: string;
  township?: string;
  heading?: number | null;
  latitude: number;
  longitude: number;
  placeLabel?: string;
  precisionLastActiveAt?: number;
  precisionMode?: NearbyWorldStatus['precisionMode'];
  precisionStopReason?: NearbyWorldStatus['precisionStopReason'];
  source: 'current' | 'last_known' | 'nearby_world';
  speed?: number | null;
  timestamp: number;
};

export function locationSummary(data: CurrentLocationData) {
  const accuracy = typeof data.accuracy === 'number' && Number.isFinite(data.accuracy)
    ? `精度约 ${Math.round(data.accuracy)} 米`
    : '精度未知';
  const source = data.source === 'nearby_world' ? '附近世界定位缓存' : data.source === 'last_known' ? '上次可信定位' : '当前定位';
  const references = [
    data.nearbyAoi ? `附近区域：${data.nearbyAoi}` : '',
    data.nearbyPoi ? `附近参照点：${data.nearbyPoi}` : '',
    data.nearbyRoad ? `附近道路：${data.nearbyRoad}` : '',
  ].filter(Boolean);
  const details = [
    data.precisionMode ? `一起状态：${describePrecisionMode(data.precisionMode)}` : '',
    data.gpsQuality ? `定位质量：${describeGpsQuality(data.gpsQuality)}` : '',
    data.backgroundProfile ? `后台档位：${describeBackgroundProfile(data.backgroundProfile)}` : '',
    data.precisionStopReason ? `上次一起结束：${describeStopReason(data.precisionStopReason)}` : '',
    data.batteryWarning ? '电量有些低，后台努力可能更耗电' : '',
    data.precisionLastActiveAt ? `最近看见位置：${new Date(data.precisionLastActiveAt).toLocaleString()}` : '',
    typeof data.locationAgeMs === 'number' && data.locationAgeMs > NEARBY_WORLD_TOOL_MAX_AGE_MS
      ? '位置缓存可能过期，回答时要说明是上次看到的位置'
      : '',
    data.gpsQuality === 'poor' ? '定位质量不太可靠，回答时不要说得很确定' : '',
  ].filter(Boolean);
  return [
    `已获取${source}：${data.placeLabel || '地点摘要未知'}（${accuracy}）`,
    data.address ? `高德详细地址：${data.address}` : '',
    details.length ? details.join('；') : '',
    references.length ? `附近参照：${references.join('；')}。这些是周边参照，不等于小仓鼠正在这些地点里面。` : '',
    `坐标：${data.latitude.toFixed(6)}, ${data.longitude.toFixed(6)}`,
    '回答位置时优先说自然地名、地点摘要、详细地址、附近参照和精度感；坐标只作校验。附近地点没有评分、营业状态或推荐理由时，只能说“附近有/附近显示”。',
  ].filter(Boolean).join('；');
}

export function describePrecisionMode(value: string | null | undefined): string {
  if (value === 'walking') return '一起走';
  if (value === 'transit') return '交通工具上';
  return '未开启';
}

export function describeGpsQuality(value: string | null | undefined): string {
  if (value === 'excellent') return '很好';
  if (value === 'good') return '不错';
  if (value === 'fair') return '有些不稳';
  if (value === 'poor') return '不太可靠';
  return '未知';
}

export function describeBackgroundProfile(value: string | null | undefined): string {
  if (value === 'daily') return '日常低频';
  if (value === 'precision') return '后台努力';
  return '未开启';
}

export function describeStopReason(value: string | null | undefined): string {
  if (value === 'manual') return '手动结束';
  if (value === 'arrived_home') return '回到家附近';
  if (value === 'idle_timeout') return '长时间静止';
  if (value === 'permission_lost') return '权限失效';
  if (value === 'system_interrupted') return '系统打断';
  if (value === 'disabled') return '总开关关闭';
  return '没有记录';
}
