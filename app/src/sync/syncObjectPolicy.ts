export const SYNC_OBJECT_AUTOMATIC_ALL_NETWORKS_BYTES = 8 * 1024 * 1024;
export const SYNC_OBJECT_AUTOMATIC_WIFI_BYTES = 100 * 1024 * 1024;
export const SYNC_OBJECT_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type SyncObjectNetworkClass = 'offline' | 'cellular' | 'wifi';

export function decideSyncObjectDownload(input: {
  ciphertextBytes: number;
  network: SyncObjectNetworkClass;
  requestedByUser: boolean;
}) {
  if (!Number.isSafeInteger(input.ciphertextBytes) || input.ciphertextBytes < 1) {
    throw new Error('对象密文字节数必须是正安全整数。');
  }
  if (input.network === 'offline') return 'wait-network' as const;
  if (input.requestedByUser) return 'download' as const;
  if (input.ciphertextBytes <= SYNC_OBJECT_AUTOMATIC_ALL_NETWORKS_BYTES) {
    return 'download' as const;
  }
  if (
    input.ciphertextBytes <= SYNC_OBJECT_AUTOMATIC_WIFI_BYTES
    && input.network === 'wifi'
  ) {
    return 'download' as const;
  }
  return 'require-user' as const;
}

export function canEvictLocalSyncObject(input: {
  pinned: boolean;
  remoteVerified: boolean;
  liveReferenceCount: number;
  unreferencedAt: number | null;
  now: number;
}) {
  if (
    !Number.isSafeInteger(input.liveReferenceCount)
    || input.liveReferenceCount < 0
    || !Number.isSafeInteger(input.now)
    || input.now < 0
    || (
      input.unreferencedAt !== null
      && (!Number.isSafeInteger(input.unreferencedAt) || input.unreferencedAt < 0)
    )
  ) {
    throw new Error('对象留存判断输入无效。');
  }
  if (input.pinned || !input.remoteVerified || input.liveReferenceCount > 0) {
    return false;
  }
  return input.unreferencedAt !== null
    && input.now - input.unreferencedAt >= SYNC_OBJECT_TRASH_RETENTION_MS;
}
