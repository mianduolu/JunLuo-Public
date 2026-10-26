import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import { nearbyWorldHealthStorageBridge as AsyncStorage } from
  '../sync/syncNearbyWorldHealthStorageBridge';
import {
  VAULT_SHARED_SECRET_AMAP_KEY,
} from '../sync/syncVaultSharedSecretRegistry';
import {
  deleteVaultSharedSecret,
  setVaultSharedSecret,
} from '../sync/syncVaultSharedSecretsStorageBridge';

export type NearbyWorldPoiCategory = 'food' | 'scenery' | 'leisure' | 'shopping';
export type NearbyWorldPresence = 'unknown' | 'at_home' | 'outside';
export type NearbyWorldPermissionStatus = 'unknown' | 'foreground' | 'background' | 'denied' | 'unavailable';
export type NearbyWorldPrecisionMode = 'off' | 'walking' | 'transit';
export type NearbyWorldMotionState = 'still' | 'walking' | 'transit' | 'unknown';
export type NearbyWorldStopReason =
  | 'manual'
  | 'arrived_home'
  | 'idle_timeout'
  | 'permission_lost'
  | 'system_interrupted'
  | 'disabled';
export type NearbyWorldGpsQuality = 'excellent' | 'good' | 'fair' | 'poor';
export type NearbyWorldBackgroundProfile = 'daily' | 'precision';
export type NearbyWorldAutoPromptKind = 'walk' | 'transit';
export type NearbyWorldAutoTogetherReason = 'walking_detected' | 'transit_detected';
export type NearbyWorldBatteryState = 'unknown' | 'unplugged' | 'charging' | 'full';

export type NearbyWorldHome = {
  latitude: number;
  longitude: number;
  label?: string;
  setAt: number;
};

export type NearbyWorldSettings = {
  enabled: boolean;
  backgroundEnabled: boolean;
  autoTogetherEnabled: boolean;
  amapKey: string;
  home?: NearbyWorldHome;
  poiCategories: NearbyWorldPoiCategory[];
  quietHours: {
    enabled: boolean;
    startHour: number;
    endHour: number;
  };
};

export type NearbyWorldPoi = {
  id: string;
  name: string;
  category: NearbyWorldPoiCategory;
  address?: string;
  type?: string;
  distance?: number;
  updatedAt: number;
};

export type NearbyWorldStatus = {
  presence: NearbyWorldPresence;
  /** System fixes are stored unchanged; old caches without provenance remain historical. */
  coordinateSystem?: 'wgs84';
  nearHome?: boolean;
  presenceReport?: {
    state: '在家' | '在外' | '不确定';
    quote: string;
    sourceText: string;
    messageId: string;
    sessionId: string;
    sentAt: number;
  };
  addressUpdatedAt?: number;
  addressCenter?: { latitude: number; longitude: number };
  poiCenter?: { latitude: number; longitude: number };
  mapAttempt?: { at: number; latitude: number; longitude: number; accuracy: number };
  mapQuotaPause?: { service: 'regeo' | 'place' | 'geocode'; at: number };
  latitude?: number;
  longitude?: number;
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
  updatedAt?: number;
  poiCache: NearbyWorldPoi[];
  poiUpdatedAt?: number;
  permissionStatus: NearbyWorldPermissionStatus;
  backgroundActive?: boolean;
  backgroundProfile?: NearbyWorldBackgroundProfile;
  precisionMode: NearbyWorldPrecisionMode;
  precisionStartedAt?: number;
  precisionLastActiveAt?: number;
  precisionExpiresAt?: number;
  precisionStopReason?: NearbyWorldStopReason | null;
  precisionArrivedHomeSince?: number;
  motionState: NearbyWorldMotionState;
  lastMotionDetectedAt?: number;
  lastAutoPromptAt?: number;
  autoPromptKind?: NearbyWorldAutoPromptKind | null;
  autoTogetherPausedUntil?: number;
  autoTogetherStartedAt?: number;
  autoTogetherReason?: NearbyWorldAutoTogetherReason | null;
  gpsQuality?: NearbyWorldGpsQuality;
  batteryLevel?: number;
  batteryState?: NearbyWorldBatteryState;
  batteryCheckedAt?: number;
  batteryWarning?: boolean;
  lastError?: string;
};

export type NearbyWorldSnapshot = {
  settings: NearbyWorldSettings;
  status: NearbyWorldStatus;
};

export const NEARBY_WORLD_SETTINGS_KEY = 'junluo.nearbyWorld.settings.v1';
export const NEARBY_WORLD_STATUS_KEY = 'junluo.nearbyWorld.status.v1';

export const NEARBY_WORLD_POI_CATEGORIES: Array<{ key: NearbyWorldPoiCategory; label: string }> = [
  { key: 'food', label: '吃点什么' },
  { key: 'leisure', label: '走走停停' },
  { key: 'scenery', label: '看看风景' },
  { key: 'shopping', label: '买点东西' },
];

const DEFAULT_SETTINGS: NearbyWorldSettings = {
  enabled: true,
  backgroundEnabled: false,
  autoTogetherEnabled: true,
  amapKey: '',
  poiCategories: ['food', 'leisure', 'scenery', 'shopping'],
  quietHours: {
    enabled: true,
    startHour: 23,
    endHour: 8,
  },
};

const DEFAULT_STATUS: NearbyWorldStatus = {
  presence: 'unknown',
  poiCache: [],
  permissionStatus: 'unknown',
  precisionMode: 'off',
  motionState: 'unknown',
};

export function getNearbyWorldDefaultSettings(): NearbyWorldSettings {
  return { ...DEFAULT_SETTINGS, poiCategories: [...DEFAULT_SETTINGS.poiCategories], quietHours: { ...DEFAULT_SETTINGS.quietHours } };
}

export function getNearbyWorldDefaultStatus(): NearbyWorldStatus {
  return { ...DEFAULT_STATUS, poiCache: [] };
}

export function getNearbyWorldPoiCategoryLabel(category: NearbyWorldPoiCategory): string {
  return NEARBY_WORLD_POI_CATEGORIES.find((item) => item.key === category)?.label ?? '附近地点';
}

export function normalizeNearbyWorldSettings(input: Partial<NearbyWorldSettings> | null | undefined): NearbyWorldSettings {
  const categories = Array.isArray(input?.poiCategories)
    ? input.poiCategories.filter((item): item is NearbyWorldPoiCategory =>
        ['food', 'scenery', 'leisure', 'shopping'].includes(String(item)),
      )
    : DEFAULT_SETTINGS.poiCategories;
  const quietHours = input?.quietHours ?? DEFAULT_SETTINGS.quietHours;
  const home = input?.home;
  return {
    enabled: input?.enabled === undefined ? DEFAULT_SETTINGS.enabled : Boolean(input.enabled),
    backgroundEnabled: Boolean(input?.backgroundEnabled),
    autoTogetherEnabled: input?.autoTogetherEnabled === false ? false : true,
    amapKey: typeof input?.amapKey === 'string' ? input.amapKey.trim() : '',
    home:
      home && Number.isFinite(home.latitude) && Number.isFinite(home.longitude)
        ? {
            latitude: home.latitude,
            longitude: home.longitude,
            label: typeof home.label === 'string' ? home.label.trim() : undefined,
            setAt: Number.isFinite(home.setAt) ? home.setAt : 0,
          }
        : undefined,
    poiCategories: categories.length > 0 ? categories : DEFAULT_SETTINGS.poiCategories,
    quietHours: {
      enabled: Boolean(quietHours.enabled),
      startHour: clampHour(quietHours.startHour),
      endHour: clampHour(quietHours.endHour),
    },
  };
}

function parseStoredNearbyWorldSettings(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function legacyAmapKey(settings: Record<string, unknown> | null) {
  return typeof settings?.amapKey === 'string'
    ? settings.amapKey.trim()
    : '';
}

async function removeLegacyAmapKey(
  settings: Record<string, unknown>,
  writer: { setItem(key: string, value: string): Promise<void> },
) {
  if (!Object.prototype.hasOwnProperty.call(settings, 'amapKey')) return;
  const { amapKey: _removedAmapKey, ...withoutAmapKey } = settings;
  await writer.setItem(
    NEARBY_WORLD_SETTINGS_KEY,
    JSON.stringify(withoutAmapKey),
  );
}

export async function migrateLegacyNearbyWorldAmapKeyForVaultBootstrap() {
  const raw = await RawAsyncStorage.getItem(NEARBY_WORLD_SETTINGS_KEY);
  const parsed = parseStoredNearbyWorldSettings(raw);
  const legacyKey = legacyAmapKey(parsed);
  const secureKey = await getSecretItem(VAULT_SHARED_SECRET_AMAP_KEY);
  if (!secureKey && legacyKey) {
    await setSecretItem(VAULT_SHARED_SECRET_AMAP_KEY, legacyKey);
  }
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'amapKey')) {
    await removeLegacyAmapKey(parsed, RawAsyncStorage);
  }
  return secureKey || legacyKey;
}

export async function loadNearbyWorldSettings(readOnly = false): Promise<NearbyWorldSettings> {
  try {
    const [raw, storedSecureKey] = await Promise.all([
      AsyncStorage.getItem(NEARBY_WORLD_SETTINGS_KEY),
      getSecretItem(VAULT_SHARED_SECRET_AMAP_KEY, readOnly),
    ]);
    if (!raw) {
      return {
        ...getNearbyWorldDefaultSettings(),
        amapKey: storedSecureKey?.trim() ?? '',
      };
    }
    const parsed = parseStoredNearbyWorldSettings(raw);
    if (!parsed) throw new Error('附近世界设置损坏，未恢复默认开关。');
    const legacyKey = legacyAmapKey(parsed);
    let secureKey = storedSecureKey?.trim() ?? '';
    if (!readOnly && !secureKey && legacyKey) {
      await setVaultSharedSecret(VAULT_SHARED_SECRET_AMAP_KEY, legacyKey);
      secureKey = legacyKey;
    }
    if (!readOnly && Object.prototype.hasOwnProperty.call(parsed, 'amapKey')) {
      await removeLegacyAmapKey(parsed, AsyncStorage);
    }
    return normalizeNearbyWorldSettings({
      ...parsed,
      amapKey: secureKey || legacyKey,
    } as Partial<NearbyWorldSettings>);
  } catch (error) {
    console.warn('[NearbyWorld] Failed to load settings', error);
    throw error;
  }
}

export async function saveNearbyWorldSettings(next: NearbyWorldSettings): Promise<NearbyWorldSettings> {
  const normalized = normalizeNearbyWorldSettings(next);
  if (normalized.amapKey) {
    await setVaultSharedSecret(
      VAULT_SHARED_SECRET_AMAP_KEY,
      normalized.amapKey,
    );
  } else {
    await deleteVaultSharedSecret(VAULT_SHARED_SECRET_AMAP_KEY);
  }
  const { amapKey: _removedAmapKey, ...persistedSettings } = normalized;
  await AsyncStorage.setItem(
    NEARBY_WORLD_SETTINGS_KEY,
    JSON.stringify(persistedSettings),
  );
  return normalized;
}

export async function loadNearbyWorldStatus(): Promise<NearbyWorldStatus> {
  try {
    const raw = await AsyncStorage.getItem(NEARBY_WORLD_STATUS_KEY);
    if (!raw) return getNearbyWorldDefaultStatus();
    const parsed = JSON.parse(raw) as Partial<NearbyWorldStatus>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('附近世界状态损坏，未覆盖已有资料。');
    }
    return normalizeNearbyWorldStatus(parsed);
  } catch (error) {
    console.warn('[NearbyWorld] Failed to load status', error);
    throw error;
  }
}

export async function saveNearbyWorldStatus(next: NearbyWorldStatus): Promise<NearbyWorldStatus> {
  const normalized = normalizeNearbyWorldStatus(next);
  await AsyncStorage.setItem(NEARBY_WORLD_STATUS_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function loadNearbyWorldSnapshot(readOnly = false): Promise<NearbyWorldSnapshot> {
  const [settings, status] = await Promise.all([loadNearbyWorldSettings(readOnly), loadNearbyWorldStatus()]);
  return { settings, status };
}

export function normalizeNearbyWorldStatus(input: Partial<NearbyWorldStatus> | null | undefined): NearbyWorldStatus {
  const next = input ?? {};
  return {
    ...getNearbyWorldDefaultStatus(),
    ...next,
    poiCache: Array.isArray(next.poiCache) ? next.poiCache : [],
    permissionStatus: normalizePermission(next.permissionStatus),
    presence: normalizePresence(next.presence),
    precisionMode: normalizePrecisionMode(next.precisionMode),
    precisionStopReason: normalizeStopReason(next.precisionStopReason),
    motionState: normalizeMotionState(next.motionState),
    autoPromptKind: normalizeAutoPromptKind(next.autoPromptKind),
    autoTogetherReason: normalizeAutoTogetherReason(next.autoTogetherReason),
    gpsQuality: normalizeGpsQuality(next.gpsQuality),
    backgroundProfile: normalizeBackgroundProfile(next.backgroundProfile),
    batteryLevel: normalizeBatteryLevel(next.batteryLevel),
    batteryState: normalizeBatteryState(next.batteryState),
    batteryCheckedAt: normalizeFiniteNumber(next.batteryCheckedAt),
    batteryWarning: typeof next.batteryWarning === 'boolean' ? next.batteryWarning : undefined,
  };
}

export async function startNearbyWorldPrecisionMode(
  mode: Exclude<NearbyWorldPrecisionMode, 'off'>,
  metadata: {
    startedAt?: number;
    lastActiveAt?: number;
    expiresAt?: number;
    motionState?: NearbyWorldMotionState;
    autoTogetherReason?: NearbyWorldAutoTogetherReason | null;
  } = {},
): Promise<NearbyWorldStatus> {
  const previous = await loadNearbyWorldStatus();
  const startedAt = Number.isFinite(metadata.startedAt) ? metadata.startedAt : Date.now();
  const activeAt = Number.isFinite(metadata.lastActiveAt) ? metadata.lastActiveAt : startedAt;
  const motionState = normalizeMotionState(metadata.motionState);
  const hasAutoReason = Object.prototype.hasOwnProperty.call(metadata, 'autoTogetherReason');
  return saveNearbyWorldStatus({
    ...previous,
    precisionMode: mode,
    precisionStartedAt: startedAt,
    precisionLastActiveAt: activeAt,
    precisionExpiresAt: Number.isFinite(metadata.expiresAt) ? metadata.expiresAt : undefined,
    precisionStopReason: null,
    precisionArrivedHomeSince: undefined,
    motionState: motionState === 'unknown' ? mode : motionState,
    lastMotionDetectedAt: activeAt,
    autoTogetherStartedAt: metadata.autoTogetherReason ? startedAt : previous.autoTogetherStartedAt,
    autoTogetherReason: hasAutoReason
      ? normalizeAutoTogetherReason(metadata.autoTogetherReason)
      : normalizeAutoTogetherReason(previous.autoTogetherReason),
  });
}

export async function stopNearbyWorldPrecisionMode(reason: NearbyWorldStopReason): Promise<NearbyWorldStatus> {
  const previous = await loadNearbyWorldStatus();
  return saveNearbyWorldStatus({
    ...previous,
    precisionMode: 'off',
    precisionExpiresAt: undefined,
    precisionStopReason: normalizeStopReason(reason) ?? 'system_interrupted',
    precisionArrivedHomeSince: undefined,
    motionState: 'unknown',
  });
}

export async function markNearbyWorldPrecisionActive(patch: Partial<NearbyWorldStatus> = {}): Promise<NearbyWorldStatus> {
  const previous = await loadNearbyWorldStatus();
  const activeAt = Number.isFinite(patch.precisionLastActiveAt) ? patch.precisionLastActiveAt : Date.now();
  return saveNearbyWorldStatus({
    ...previous,
    ...patch,
    precisionLastActiveAt: activeAt,
    lastMotionDetectedAt: Number.isFinite(patch.lastMotionDetectedAt) ? patch.lastMotionDetectedAt : activeAt,
  });
}

export async function pauseNearbyWorldAutoTogether(until: number): Promise<NearbyWorldStatus> {
  const previous = await loadNearbyWorldStatus();
  return saveNearbyWorldStatus({
    ...previous,
    autoTogetherPausedUntil: Number.isFinite(until) ? until : undefined,
  });
}

function clampHour(value: unknown): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(0, Math.min(23, Math.round(numeric)));
}

function normalizePresence(value: unknown): NearbyWorldPresence {
  return value === 'at_home' || value === 'outside' ? value : 'unknown';
}

function normalizePermission(value: unknown): NearbyWorldPermissionStatus {
  if (value === 'foreground' || value === 'background' || value === 'denied' || value === 'unavailable') {
    return value;
  }
  return 'unknown';
}

function normalizePrecisionMode(value: unknown): NearbyWorldPrecisionMode {
  if (value === 'walking' || value === 'transit') return value;
  return 'off';
}

function normalizeMotionState(value: unknown): NearbyWorldMotionState {
  if (value === 'still' || value === 'walking' || value === 'transit') return value;
  return 'unknown';
}

function normalizeStopReason(value: unknown): NearbyWorldStopReason | null | undefined {
  if (value === null) return null;
  if (
    value === 'manual' ||
    value === 'arrived_home' ||
    value === 'idle_timeout' ||
    value === 'permission_lost' ||
    value === 'system_interrupted' ||
    value === 'disabled'
  ) {
    return value;
  }
  return undefined;
}

function normalizeGpsQuality(value: unknown): NearbyWorldGpsQuality | undefined {
  if (value === 'excellent' || value === 'good' || value === 'fair' || value === 'poor') return value;
  return undefined;
}

function normalizeBackgroundProfile(value: unknown): NearbyWorldBackgroundProfile | undefined {
  if (value === 'daily' || value === 'precision') return value;
  return undefined;
}

function normalizeBatteryState(value: unknown): NearbyWorldBatteryState | undefined {
  if (value === 'unknown' || value === 'unplugged' || value === 'charging' || value === 'full') return value;
  return undefined;
}

function normalizeBatteryLevel(value: unknown): number | undefined {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Math.max(0, Math.min(1, numeric));
}

function normalizeFiniteNumber(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function normalizeAutoPromptKind(value: unknown): NearbyWorldAutoPromptKind | null | undefined {
  if (value === null) return null;
  if (value === 'walk' || value === 'transit') return value;
  return undefined;
}

function normalizeAutoTogetherReason(value: unknown): NearbyWorldAutoTogetherReason | null | undefined {
  if (value === null) return null;
  if (value === 'walking_detected' || value === 'transit_detected') return value;
  return undefined;
}
