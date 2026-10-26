import AsyncStorage from '@react-native-async-storage/async-storage';

import { COLMI_LAST_DEVICE_STORAGE_KEY } from './colmi/colmiBleConstants';

export type BodySignalRuntimeSettings = {
  autoMeasureAfterReconnect: boolean;
  autoReconnectEnabled: boolean;
};

const BODY_SIGNAL_RUNTIME_SETTINGS_KEY = 'junluo.bodySignal.runtime.settings';

const MAC_ADDRESS_PATTERN =
  /^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/iu;
export const DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS: BodySignalRuntimeSettings = {
  autoMeasureAfterReconnect: true,
  autoReconnectEnabled: true,
};

function normalizePreferredDeviceAlias(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return (
    normalized
    && normalized.length <= 120
    && !MAC_ADDRESS_PATTERN.test(normalized)
  )
    ? normalized
    : null;
}

async function loadLegacyPreferredDeviceAlias() {
  const raw = await AsyncStorage.getItem(
    COLMI_LAST_DEVICE_STORAGE_KEY,
  ).catch(() => null);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as {
      displayName?: unknown;
    };
    return normalizePreferredDeviceAlias(parsed.displayName);
  } catch {
    return null;
  }
}

async function loadLegacyBodySignalRuntimeSettings(): Promise<BodySignalRuntimeSettings> {
  const raw = await AsyncStorage.getItem(BODY_SIGNAL_RUNTIME_SETTINGS_KEY).catch(() => null);
  if (!raw) return DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS;

  try {
    const parsed = JSON.parse(raw) as Partial<BodySignalRuntimeSettings>;
    return {
      autoMeasureAfterReconnect: typeof parsed.autoMeasureAfterReconnect === 'boolean'
        ? parsed.autoMeasureAfterReconnect
        : DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS.autoMeasureAfterReconnect,
      autoReconnectEnabled: typeof parsed.autoReconnectEnabled === 'boolean'
        ? parsed.autoReconnectEnabled
        : DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS.autoReconnectEnabled,
    };
  } catch {
    return DEFAULT_BODY_SIGNAL_RUNTIME_SETTINGS;
  }
}

export async function ensureBodySignalCollectionPolicyRecord() {
  const { BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS } =
    await import('../sync/syncBodySignalHealth');
  const {
    loadBodySignalCollectionPolicyRecord,
    saveBodySignalCollectionPolicyRecord,
  } = await import('./bodySignalStore');
  const shared = await loadBodySignalCollectionPolicyRecord();
  if (shared) {
    if (shared.rawRetentionDays <= BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS) {
      return shared;
    }
    const updated = {
      autoMeasureAfterReconnect: shared.autoMeasureAfterReconnect,
      autoReconnectEnabled: shared.autoReconnectEnabled,
      preferredDeviceAlias: shared.preferredDeviceAlias,
      rawRetentionDays: BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
      updatedAt: Date.now(),
    };
    await saveBodySignalCollectionPolicyRecord(updated);
    return { id: 'global' as const, ...updated };
  }
  const [legacy, preferredDeviceAlias] = await Promise.all([
    loadLegacyBodySignalRuntimeSettings(),
    loadLegacyPreferredDeviceAlias(),
  ]);
  const record = {
    autoMeasureAfterReconnect: legacy.autoMeasureAfterReconnect,
    autoReconnectEnabled: legacy.autoReconnectEnabled,
    preferredDeviceAlias,
    rawRetentionDays: BODY_SIGNAL_DEFAULT_RAW_RETENTION_DAYS,
    updatedAt: Date.now(),
  };
  await saveBodySignalCollectionPolicyRecord(record);
  return { id: 'global' as const, ...record };
}

export async function loadBodySignalRuntimeSettings():
Promise<BodySignalRuntimeSettings> {
  return loadLegacyBodySignalRuntimeSettings();
}

export async function mirrorBodySignalRuntimeSettings(
  settings: BodySignalRuntimeSettings,
) {
  const normalized: BodySignalRuntimeSettings = {
    autoMeasureAfterReconnect:
      settings.autoMeasureAfterReconnect === true,
    autoReconnectEnabled:
      settings.autoReconnectEnabled === true,
  };
  await AsyncStorage.setItem(
    BODY_SIGNAL_RUNTIME_SETTINGS_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

export async function saveBodySignalRuntimeSettings(settings: BodySignalRuntimeSettings): Promise<void> {
  const normalized = await mirrorBodySignalRuntimeSettings(settings);
  const shared = await ensureBodySignalCollectionPolicyRecord();
  const { saveBodySignalCollectionPolicyRecord } =
    await import('./bodySignalStore');
  await saveBodySignalCollectionPolicyRecord({
    autoMeasureAfterReconnect:
      normalized.autoMeasureAfterReconnect,
    autoReconnectEnabled: normalized.autoReconnectEnabled,
    preferredDeviceAlias: shared.preferredDeviceAlias,
    rawRetentionDays: shared.rawRetentionDays,
    updatedAt: Date.now(),
  });
}
