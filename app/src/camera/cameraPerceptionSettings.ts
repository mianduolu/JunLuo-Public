import { cameraPreferencesStorageBridge as AsyncStorage } from
  '../sync/syncCameraPreferencesStorageBridge';

export const CAMERA_PERCEPTION_SETTINGS_SCHEMA_VERSION = 4 as const;
export const CAMERA_PERCEPTION_SETTINGS_KEY = 'junluo.cameraPerception.settings.v1';
export const CAMERA_INTERVAL_STEP_MINUTES = 5;
export const CAMERA_INTERVAL_MIN_MINUTES = 5;
export const CAMERA_INTERVAL_MAX_MINUTES = 1440;
export const CAMERA_QUIET_TIME_STEP_MINUTES = 30;

export type CameraPerceptionSettings = {
  schemaVersion: typeof CAMERA_PERCEPTION_SETTINGS_SCHEMA_VERSION;
  minimumIntervalMinutes: number;
  chatMinimumIntervalEnabled: boolean;
  maximumIntervalMinutes: number;
  quietHours: {
    enabled: boolean;
    startMinuteOfDay: number;
    endMinuteOfDay: number;
  };
  preferredAndroidFacing: 'front' | 'back';
};

const DEFAULT_CAMERA_PERCEPTION_SETTINGS: CameraPerceptionSettings = {
  schemaVersion: CAMERA_PERCEPTION_SETTINGS_SCHEMA_VERSION,
  minimumIntervalMinutes: 30,
  chatMinimumIntervalEnabled: true,
  maximumIntervalMinutes: 120,
  quietHours: {
    enabled: false,
    startMinuteOfDay: 0,
    endMinuteOfDay: 9 * 60,
  },
  preferredAndroidFacing: 'front',
};

export function getDefaultCameraPerceptionSettings(): CameraPerceptionSettings {
  return {
    ...DEFAULT_CAMERA_PERCEPTION_SETTINGS,
    quietHours: { ...DEFAULT_CAMERA_PERCEPTION_SETTINGS.quietHours },
  };
}

function normalizeIntervalMinutes(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const stepped = Math.round(value / CAMERA_INTERVAL_STEP_MINUTES) * CAMERA_INTERVAL_STEP_MINUTES;
  return Math.max(CAMERA_INTERVAL_MIN_MINUTES, Math.min(CAMERA_INTERVAL_MAX_MINUTES, stepped));
}

function normalizeMinuteOfDay(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value >= 24 * 60) {
    return fallback;
  }
  const stepped = Math.round(value / CAMERA_QUIET_TIME_STEP_MINUTES) * CAMERA_QUIET_TIME_STEP_MINUTES;
  return stepped === 24 * 60 ? 0 : stepped;
}

export function normalizeCameraPerceptionSettings(
  input: unknown,
): CameraPerceptionSettings {
  const defaults = getDefaultCameraPerceptionSettings();
  if (!input || typeof input !== 'object' || Array.isArray(input)) return defaults;
  const current = input as Partial<Omit<CameraPerceptionSettings, 'schemaVersion'>> & {
    schemaVersion?: number;
  };
  if (![1, 2, 3, CAMERA_PERCEPTION_SETTINGS_SCHEMA_VERSION].includes(current.schemaVersion ?? 0)) return defaults;

  const minimumIntervalMinutes = normalizeIntervalMinutes(
    current.minimumIntervalMinutes,
    defaults.minimumIntervalMinutes,
  );
  const maximumIntervalMinutes = normalizeIntervalMinutes(
    current.maximumIntervalMinutes,
    defaults.maximumIntervalMinutes,
  );
  const quietEnabled = current.quietHours?.enabled === true;
  let startMinuteOfDay = normalizeMinuteOfDay(
    current.quietHours?.startMinuteOfDay,
    defaults.quietHours.startMinuteOfDay,
  );
  let endMinuteOfDay = normalizeMinuteOfDay(
    current.quietHours?.endMinuteOfDay,
    defaults.quietHours.endMinuteOfDay,
  );

  if (quietEnabled && startMinuteOfDay === endMinuteOfDay) return defaults;

  return {
    schemaVersion: CAMERA_PERCEPTION_SETTINGS_SCHEMA_VERSION,
    minimumIntervalMinutes,
    chatMinimumIntervalEnabled: current.schemaVersion === CAMERA_PERCEPTION_SETTINGS_SCHEMA_VERSION
      ? current.chatMinimumIntervalEnabled !== false : true,
    maximumIntervalMinutes,
    quietHours: {
      enabled: quietEnabled,
      startMinuteOfDay,
      endMinuteOfDay,
    },
    preferredAndroidFacing: current.preferredAndroidFacing === 'back' ? 'back' : 'front',
  };
}

export async function loadCameraPerceptionSettings(options: { strict?: boolean } = {}): Promise<CameraPerceptionSettings> {
  try {
    const raw = await AsyncStorage.getItem(CAMERA_PERCEPTION_SETTINGS_KEY);
    if (!raw) return getDefaultCameraPerceptionSettings();
    const parsed = JSON.parse(raw) as { schemaVersion?: number };
    const normalized = normalizeCameraPerceptionSettings(parsed);
    if (parsed.schemaVersion === 1 || parsed.schemaVersion === 2 || parsed.schemaVersion === 3) {
      await AsyncStorage.setItem(CAMERA_PERCEPTION_SETTINGS_KEY, JSON.stringify(normalized))
        .catch((error) => console.warn('[CameraPerception] Failed to persist settings migration', error));
    }
    return normalized;
  } catch (error) {
    if (options.strict) throw error;
    console.warn('[CameraPerception] Failed to load settings', error);
    return getDefaultCameraPerceptionSettings();
  }
}

export async function saveCameraPerceptionSettings(
  settings: CameraPerceptionSettings,
): Promise<CameraPerceptionSettings> {
  const normalized = normalizeCameraPerceptionSettings(settings);
  await AsyncStorage.setItem(CAMERA_PERCEPTION_SETTINGS_KEY, JSON.stringify(normalized));
  return normalized;
}
