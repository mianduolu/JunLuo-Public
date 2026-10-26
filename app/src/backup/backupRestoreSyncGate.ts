import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertBackupRestoreSyncGateV1,
  backupRestoreSyncGateSnapshot,
  parseBackupRestoreSyncGate,
  type BackupRestoreSyncGateSnapshot,
  type BackupRestoreSyncGateV1,
} from './backupRestoreSyncGateCore';

const STORAGE_KEY = '@junluo/backup/restore-sync-gate:v1';

const listeners = new Set<(snapshot: BackupRestoreSyncGateSnapshot) => void>();
let writeQueue: Promise<void> = Promise.resolve();

async function publish(gate?: BackupRestoreSyncGateV1 | null) {
  const snapshot = backupRestoreSyncGateSnapshot(
    gate === undefined ? await loadBackupRestoreSyncGate() : gate,
  );
  for (const listener of listeners) listener(snapshot);
}

export async function loadBackupRestoreSyncGate() {
  await writeQueue;
  return parseBackupRestoreSyncGate(await AsyncStorage.getItem(STORAGE_KEY));
}

async function saveGate(gate: BackupRestoreSyncGateV1) {
  assertBackupRestoreSyncGateV1(gate);
  const operation = writeQueue.then(() => AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(gate),
  ));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  await publish(gate);
}

export async function beginBackupRestoreSyncGate(snapshotId: string) {
  const gate: BackupRestoreSyncGateV1 = Object.freeze({
    version: 1,
    state: 'restoring',
    snapshotId,
    updatedAt: Date.now(),
  });
  await saveGate(gate);
  return gate;
}

export async function markBackupRestoreSyncRebuildRequired(snapshotId: string) {
  const current = await loadBackupRestoreSyncGate();
  if (!current || current.snapshotId !== snapshotId || current.state !== 'restoring') {
    throw new Error('备份恢复同步暂停状态与当前恢复不一致。');
  }
  const gate: BackupRestoreSyncGateV1 = Object.freeze({
    ...current,
    state: 'rebuild-required',
    updatedAt: Date.now(),
  });
  await saveGate(gate);
  return gate;
}

export async function clearBackupRestoreSyncGate(snapshotId?: string) {
  const current = await loadBackupRestoreSyncGate();
  if (!current) return;
  if (snapshotId && current.snapshotId !== snapshotId) {
    throw new Error('不能清除另一轮备份恢复的同步暂停状态。');
  }
  const operation = writeQueue.then(() => AsyncStorage.removeItem(STORAGE_KEY));
  writeQueue = operation.then(() => undefined, () => undefined);
  await operation;
  await publish(null);
}

export async function loadBackupRestoreSyncGateSnapshot() {
  return backupRestoreSyncGateSnapshot(await loadBackupRestoreSyncGate());
}

export function subscribeBackupRestoreSyncGate(
  listener: (snapshot: BackupRestoreSyncGateSnapshot) => void,
) {
  listeners.add(listener);
  void loadBackupRestoreSyncGateSnapshot().then(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function assertBackupRestoreAllowsOrdinarySync() {
  const gate = await loadBackupRestoreSyncGate();
  if (gate?.state === 'restoring') {
    throw new Error('备份恢复尚未完成，普通同步已暂停。');
  }
  if (gate?.state === 'rebuild-required') {
    throw new Error('恢复后的资料需要重新建立同步。');
  }
}

export async function isBackupRestoreSyncGateActive() {
  try {
    return (await loadBackupRestoreSyncGate()) !== null;
  } catch {
    // A damaged gate must never let an old sync identity resume capture.
    return true;
  }
}
