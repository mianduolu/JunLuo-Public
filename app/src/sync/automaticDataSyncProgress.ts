import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  EMPTY_AUTOMATIC_DATA_SYNC_QUEUES,
  type AutomaticDataSyncProgressV1,
} from './automaticDataSyncProgressCore';

const LAST_ROUND_KEY = 'junluo.sync.automaticDataSyncLastRound.v1';
const listeners = new Set<(value: AutomaticDataSyncProgressV1) => void>();

let current: AutomaticDataSyncProgressV1 = {
  phase: 'idle',
  tier: 'gentle',
  queues: { ...EMPTY_AUTOMATIC_DATA_SYNC_QUEUES },
  lastRound: null,
  updatedAt: 0,
};
let loaded = false;

function publish() {
  const snapshot = structuredClone(current);
  for (const listener of listeners) listener(snapshot);
}

export async function loadAutomaticDataSyncProgress() {
  if (!loaded) {
    loaded = true;
    try {
      const raw = await AsyncStorage.getItem(LAST_ROUND_KEY);
      const value = raw ? JSON.parse(raw) as {
        lastRound?: AutomaticDataSyncProgressV1['lastRound'];
        updatedAt?: number;
      } : null;
      if (value?.lastRound && Number.isSafeInteger(value.updatedAt)) {
        current = {
          ...current,
          lastRound: value.lastRound,
          updatedAt: Number(value.updatedAt),
        };
      }
    } catch {
      // 进度损坏不能阻断真实同步。
    }
  }
  return structuredClone(current);
}

export async function updateAutomaticDataSyncProgress(
  next: AutomaticDataSyncProgressV1,
  persistLastRound = false,
) {
  current = structuredClone(next);
  publish();
  if (persistLastRound) {
    try {
      await AsyncStorage.setItem(LAST_ROUND_KEY, JSON.stringify({
        lastRound: next.lastRound,
        updatedAt: next.updatedAt,
      }));
    } catch {
      // UI 摘要落盘失败不能阻断真实同步。
    }
  }
  return structuredClone(current);
}

export function subscribeAutomaticDataSyncProgress(
  listener: (value: AutomaticDataSyncProgressV1) => void,
) {
  listeners.add(listener);
  void loadAutomaticDataSyncProgress().then(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function pauseAutomaticDataSyncProgress() {
  const snapshot = await loadAutomaticDataSyncProgress();
  const hasWork = snapshot.queues.pendingOutgoing > 0
    || snapshot.queues.waitingAtRelay > 0
    || snapshot.queues.receivedAwaitingApply > 0
    || snapshot.queues.objectJobs > 0;
  if (!hasWork) return;
  await updateAutomaticDataSyncProgress({
    ...snapshot,
    phase: 'paused',
    updatedAt: Date.now(),
  });
}
