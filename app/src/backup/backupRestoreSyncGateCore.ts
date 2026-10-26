export type BackupRestoreSyncGateV1 = Readonly<{
  version: 1;
  state: 'restoring' | 'rebuild-required';
  snapshotId: string;
  updatedAt: number;
}>;

export type BackupRestoreSyncGateSnapshot = Readonly<{
  state: 'idle' | BackupRestoreSyncGateV1['state'];
  rebuildRequired: boolean;
}>;

const SNAPSHOT_ID = /^JunLuo-pre-import-[A-Za-z0-9._-]+\.zip$/u;

export function assertBackupRestoreSyncGateV1(
  value: unknown,
): asserts value is BackupRestoreSyncGateV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('备份恢复同步暂停状态已损坏。');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4
    || record.version !== 1
    || !['restoring', 'rebuild-required'].includes(String(record.state))
    || typeof record.snapshotId !== 'string'
    || !SNAPSHOT_ID.test(record.snapshotId)
    || !Number.isSafeInteger(record.updatedAt)
    || Number(record.updatedAt) < 0
  ) {
    throw new Error('备份恢复同步暂停状态已损坏。');
  }
}

export function parseBackupRestoreSyncGate(raw: string | null) {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('备份恢复同步暂停状态不是有效 JSON。');
  }
  assertBackupRestoreSyncGateV1(parsed);
  return parsed;
}

export function backupRestoreSyncGateSnapshot(
  gate: BackupRestoreSyncGateV1 | null,
): BackupRestoreSyncGateSnapshot {
  return Object.freeze({
    state: gate?.state ?? 'idle',
    rebuildRequired: gate?.state === 'rebuild-required',
  });
}
