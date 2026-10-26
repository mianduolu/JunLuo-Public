import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  AUTOMATIC_DATA_SYNC_POLICY_KEY,
  AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY,
  defaultAutomaticDataSyncPolicy,
  defaultAutomaticDataSyncRuntimeStatus,
  normalizeAutomaticDataSyncPolicy,
  normalizeAutomaticDataSyncRuntimeStatus,
  parseAutomaticDataSyncPolicy,
  parseAutomaticDataSyncRuntimeStatus,
  type AutomaticDataSyncPolicyV1,
  type AutomaticDataSyncRuntimeStatusV1,
} from './automaticDataSyncPolicyCore';

export * from './automaticDataSyncPolicyCore';

const listeners = new Set<(
  policy: AutomaticDataSyncPolicyV1,
  status: AutomaticDataSyncRuntimeStatusV1,
) => void>();

function publish(
  policy: AutomaticDataSyncPolicyV1,
  status: AutomaticDataSyncRuntimeStatusV1,
) {
  for (const listener of listeners) listener(policy, status);
}

export async function loadAutomaticDataSyncPolicy() {
  try {
    return parseAutomaticDataSyncPolicy(
      await AsyncStorage.getItem(AUTOMATIC_DATA_SYNC_POLICY_KEY),
    );
  } catch {
    return defaultAutomaticDataSyncPolicy;
  }
}

export async function loadAutomaticDataSyncRuntimeStatus() {
  try {
    return parseAutomaticDataSyncRuntimeStatus(
      await AsyncStorage.getItem(AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY),
    );
  } catch {
    return { ...defaultAutomaticDataSyncRuntimeStatus };
  }
}

export async function loadAutomaticDataSyncSnapshot() {
  const [policy, status] = await Promise.all([
    loadAutomaticDataSyncPolicy(),
    loadAutomaticDataSyncRuntimeStatus(),
  ]);
  return {
    policy,
    status: policy.enabled
      ? status.state === 'disabled'
        ? { ...status, state: 'idle' as const }
        : status
      : { ...defaultAutomaticDataSyncRuntimeStatus },
  };
}

export async function saveAutomaticDataSyncRuntimeStatus(
  status: AutomaticDataSyncRuntimeStatusV1,
) {
  const normalized = normalizeAutomaticDataSyncRuntimeStatus(status);
  await AsyncStorage.setItem(
    AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY,
    JSON.stringify(normalized),
  );
  publish(await loadAutomaticDataSyncPolicy(), normalized);
  return normalized;
}

export async function saveAutomaticDataSyncPolicy(
  policy: AutomaticDataSyncPolicyV1,
) {
  const normalized = normalizeAutomaticDataSyncPolicy(policy);
  const status: AutomaticDataSyncRuntimeStatusV1 = normalized.enabled
    ? { ...defaultAutomaticDataSyncRuntimeStatus, state: 'idle' }
    : { ...defaultAutomaticDataSyncRuntimeStatus };
  await AsyncStorage.multiSet([
    [AUTOMATIC_DATA_SYNC_POLICY_KEY, JSON.stringify(normalized)],
    [AUTOMATIC_DATA_SYNC_RUNTIME_STATUS_KEY, JSON.stringify(status)],
  ]);
  publish(normalized, status);
  return normalized;
}

export function resetAutomaticDataSyncPolicy() {
  return saveAutomaticDataSyncPolicy(defaultAutomaticDataSyncPolicy);
}

export function subscribeAutomaticDataSyncSnapshot(
  listener: (
    policy: AutomaticDataSyncPolicyV1,
    status: AutomaticDataSyncRuntimeStatusV1,
  ) => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
