import * as Location from 'expo-location';

import { loadNearbyWorldSnapshot, type NearbyWorldStatus } from '../../nearby/nearbyWorldStore';
import {
  locationSummary,
  describePrecisionMode,
  describeGpsQuality,
  describeBackgroundProfile,
  describeStopReason,
  type CurrentLocationData,
} from '../locationResultSummary';
import { createToolSuccessResult } from '../toolResult';
import type { JunLuoToolCall, JunLuoToolDefinition, JunLuoToolPackage, JunLuoToolResult } from '../toolTypes';
import {
  readBooleanInput,
  readStringInput,
  validationFailed,
} from './builtinToolValidation';

type LocationAccuracyInput = 'balanced' | 'high';

type NearbyWorldStatusData = {
  backgroundActive?: boolean;
  enabled: boolean;
  hasAmapKey: boolean;
  home?: {
    label?: string;
    latitude: number;
    longitude: number;
  };
  status: NearbyWorldStatus;
};

const LOCATION_TIMEOUT_MS = 9000;

function readAccuracy(input: Record<string, unknown>): LocationAccuracyInput {
  const value = readStringInput(input, 'accuracy');
  return value === 'balanced' ? 'balanced' : 'high';
}

function toExpoAccuracy(accuracy: LocationAccuracyInput) {
  return accuracy === 'balanced' ? Location.Accuracy.Balanced : Location.Accuracy.High;
}

async function getCurrentPositionWithTimeout(accuracy: LocationAccuracyInput) {
  return Promise.race([
    Location.getCurrentPositionAsync({
      accuracy: toExpoAccuracy(accuracy),
      mayShowUserSettingsDialog: true,
    }),
    new Promise<Location.LocationObject>((_, reject) => {
      setTimeout(() => reject(new Error('location-timeout')), LOCATION_TIMEOUT_MS);
    }),
  ]);
}

function formatPlaceLabel(place?: Location.LocationGeocodedAddress) {
  if (!place) return undefined;
  return [place.city, place.district, place.street, place.name].filter(Boolean).join(' · ') || undefined;
}

async function reverseGeocode(latitude: number, longitude: number) {
  try {
    const places = await Location.reverseGeocodeAsync({ latitude, longitude });
    const first = places[0];
  return {
    address: [first?.street, first?.name].filter(Boolean).join(' ') || undefined,
    city: first?.city ?? undefined,
    district: first?.district ?? undefined,
    placeLabel: formatPlaceLabel(first),
  };
  } catch {
    return {};
  }
}

function buildCurrentLocationData(
  location: Location.LocationObject,
  source: CurrentLocationData['source'],
  place: Partial<CurrentLocationData>,
): CurrentLocationData {
  return {
    accuracy: location.coords.accuracy,
    altitude: location.coords.altitude,
    heading: location.coords.heading,
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    source,
    speed: location.coords.speed,
    timestamp: location.timestamp,
    ...place,
  };
}


async function executeGetCurrentPosition(call: JunLuoToolCall): Promise<JunLuoToolResult<CurrentLocationData>> {
  const permission = await Location.requestForegroundPermissionsAsync();
  if (!permission.granted) {
    return validationFailed(call, '没有前台定位权限', '没有获取到当前位置：定位权限未允许');
  }

  const accuracy = readAccuracy(call.input);
  const shouldReverseGeocode = readBooleanInput(call.input, 'reverseGeocode') ?? true;

  let location: Location.LocationObject | null = null;
  try {
    location = await getCurrentPositionWithTimeout(accuracy);
  } catch { /* A failed fresh fix must not silently become a cached position. */ }

  if (!location) {
    return validationFailed(call, '系统暂时没有返回可用定位', '没有获取到当前位置');
  }

  const place = shouldReverseGeocode
    ? await reverseGeocode(location.coords.latitude, location.coords.longitude)
    : {};
  const data = buildCurrentLocationData(location, 'current', place);
  return createToolSuccessResult(call, locationSummary(data), data);
}

async function executeGetNearbyWorldStatus(call: JunLuoToolCall): Promise<JunLuoToolResult<NearbyWorldStatusData>> {
  const snapshot = await loadNearbyWorldSnapshot();
  const data: NearbyWorldStatusData = {
    backgroundActive: snapshot.status.backgroundActive,
    enabled: snapshot.settings.enabled,
    hasAmapKey: Boolean(snapshot.settings.amapKey.trim()),
    home: snapshot.settings.home
      ? {
          label: snapshot.settings.home.label,
          latitude: snapshot.settings.home.latitude,
          longitude: snapshot.settings.home.longitude,
        }
      : undefined,
    status: snapshot.status,
  };
  const hasCoordinate = typeof snapshot.status.latitude === 'number' && typeof snapshot.status.longitude === 'number';
  const references = [
    snapshot.status.nearbyAoi ? `附近区域：${snapshot.status.nearbyAoi}` : '',
    snapshot.status.nearbyPoi ? `附近参照点：${snapshot.status.nearbyPoi}` : '',
    snapshot.status.nearbyRoad ? `附近道路：${snapshot.status.nearbyRoad}` : '',
  ].filter(Boolean);
  const summary = hasCoordinate
    ? [
        `已读取附近世界定位缓存：${snapshot.status.placeLabel || '地点摘要未知'}${formatAccuracy(snapshot.status.accuracy)}`,
        snapshot.status.address ? `高德详细地址：${snapshot.status.address}` : '',
        `一起状态：${describePrecisionMode(snapshot.status.precisionMode)}`,
        `定位质量：${describeGpsQuality(snapshot.status.gpsQuality)}`,
        `后台档位：${describeBackgroundProfile(snapshot.status.backgroundProfile)}`,
        snapshot.status.precisionStopReason ? `上次一起结束：${describeStopReason(snapshot.status.precisionStopReason)}` : '',
        snapshot.status.batteryWarning ? '电量有些低，后台努力可能更耗电' : '',
        snapshot.status.precisionLastActiveAt ? `最近看见位置：${new Date(snapshot.status.precisionLastActiveAt).toLocaleString()}` : '',
        references.length ? `附近参照：${references.join('；')}` : '',
        `坐标：${snapshot.status.latitude!.toFixed(6)}, ${snapshot.status.longitude!.toFixed(6)}`,
      ].filter(Boolean).join('；')
    : '已读取附近世界状态：当前没有定位坐标缓存';
  return createToolSuccessResult(call, summary, data);
}

function formatAccuracy(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  return `，精度约 ${Math.round(value)} 米`;
}

export const locationGetCurrentPositionTool: JunLuoToolDefinition<Record<string, unknown>, CurrentLocationData> = {
  id: 'location.get_current_position',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'location',
  name: '获取当前位置',
  description: '请求一次手机前台定位，返回经纬度、精度、定位来源和可读地址。用于回答“我在哪里/定位一下”。',
  inputSchema: {
    type: 'object',
    properties: {
      accuracy: { type: 'string', enum: ['high', 'balanced'], description: '定位精度，默认 high' },
      reverseGeocode: { type: 'boolean', description: '是否尝试把坐标反查成地址，默认 true' },
    },
  },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: true,
  executor: executeGetCurrentPosition,
};

export const locationGetNearbyWorldStatusTool: JunLuoToolDefinition<Record<string, unknown>, NearbyWorldStatusData> = {
  id: 'location.get_nearby_world_status',
  chatExposure: 'candidate',
  proactiveEligible: true,
  packageId: 'location',
  name: '读取附近世界定位状态',
  description: '读取附近世界当前缓存的定位、权限和地点状态，用于排查定位漂移或缓存偏差。',
  inputSchema: { type: 'object' },
  permission: 'ask',
  riskLevel: 'device_control',
  readOnly: true,
  executor: executeGetNearbyWorldStatus,
};

export const locationToolPackage: JunLuoToolPackage = {
  id: 'location',
  name: '定位与位置',
  description: '读取当前手机定位和附近世界定位缓存，帮助白云基于真实坐标回答位置问题。',
  category: 'location',
  tools: [
    locationGetCurrentPositionTool,
    locationGetNearbyWorldStatusTool,
  ],
  defaultEnabled: true,
  riskLevel: 'device_control',
  source: 'builtin',
};
