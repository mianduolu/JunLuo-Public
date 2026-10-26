import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  emptyLifePeriodicSyncCheckpoint,
  normalizeLifePeriodicSyncCheckpoint,
  type LifePeriodicSyncCheckpointV1,
} from './lifePeriodicSyncCheckpointCore';

export * from './lifePeriodicSyncCheckpointCore';

export const LIFE_PERIODIC_SYNC_CHECKPOINT_KEY =
  'junluo.life.periodicSyncCheckpoint.v1' as const;

export async function loadLifePeriodicSyncCheckpoint() {
  try {
    const raw = await AsyncStorage.getItem(LIFE_PERIODIC_SYNC_CHECKPOINT_KEY);
    return raw
      ? normalizeLifePeriodicSyncCheckpoint(JSON.parse(raw) as unknown)
      : emptyLifePeriodicSyncCheckpoint();
  } catch {
    return emptyLifePeriodicSyncCheckpoint();
  }
}

export async function saveLifePeriodicSyncCheckpoint(
  checkpoint: LifePeriodicSyncCheckpointV1,
) {
  const normalized = normalizeLifePeriodicSyncCheckpoint(checkpoint);
  await AsyncStorage.setItem(
    LIFE_PERIODIC_SYNC_CHECKPOINT_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}
