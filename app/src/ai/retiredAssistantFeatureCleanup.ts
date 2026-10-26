import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  isAssistantLifeDayStorageKey,
  RETIRED_ASSISTANT_FEATURE_STORAGE_KEYS,
  sanitizeRetiredAssistantStorage,
  stripRetiredLifeProjectFields,
} from './retiredAssistantFeatureData';

export type RetiredAssistantBusinessCleanupReport = {
  removedRetiredKeyCount: number;
  sanitizedLifeDayCount: number;
  droppedLifeDayCount: number;
};

let purgePromise: Promise<RetiredAssistantBusinessCleanupReport> | undefined;

async function performPurge(): Promise<RetiredAssistantBusinessCleanupReport> {
  const { cancelRetiredPeriodNotifications } = await import('../period/periodStore');
  await cancelRetiredPeriodNotifications();
  const periodKey = 'junluo.period.reminderSettings.v1';
  const rawPeriodSettings = await RawAsyncStorage.getItem(periodKey);
  if (rawPeriodSettings) {
    const cleaned = sanitizeRetiredAssistantStorage({ [periodKey]: rawPeriodSettings }).storage[periodKey];
    if (cleaned !== rawPeriodSettings) await RawAsyncStorage.setItem(periodKey, cleaned);
  }
  const allKeys = await RawAsyncStorage.getAllKeys();
  const retiredKeySet = new Set<string>(RETIRED_ASSISTANT_FEATURE_STORAGE_KEYS);
  const presentRetiredKeys = allKeys.filter((key) => retiredKeySet.has(key));
  const dayKeys = allKeys.filter(isAssistantLifeDayStorageKey);
  const dayRows = dayKeys.length
    ? await RawAsyncStorage.multiGet(dayKeys)
    : [];
  const sanitizedRows: [string, string][] = [];
  const droppedDayKeys: string[] = [];

  for (const [key, raw] of dayRows) {
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        droppedDayKeys.push(key);
        continue;
      }
      const stripped = stripRetiredLifeProjectFields(parsed);
      if (stripped.changed) {
        sanitizedRows.push([key, JSON.stringify(stripped.value)]);
      }
    } catch {
      droppedDayKeys.push(key);
    }
  }

  const keysToRemove = [
    ...RETIRED_ASSISTANT_FEATURE_STORAGE_KEYS,
    ...droppedDayKeys,
  ];
  if (keysToRemove.length) await RawAsyncStorage.multiRemove(keysToRemove);
  if (sanitizedRows.length) await RawAsyncStorage.multiSet(sanitizedRows);

  return {
    removedRetiredKeyCount: presentRetiredKeys.length,
    sanitizedLifeDayCount: sanitizedRows.length,
    droppedLifeDayCount: droppedDayKeys.length,
  };
}

export function purgeRetiredAssistantBusinessData() {
  if (!purgePromise) {
    purgePromise = performPurge().finally(() => {
      purgePromise = undefined;
    });
  }
  return purgePromise;
}
