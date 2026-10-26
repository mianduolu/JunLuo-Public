import {
  assertSyncUuidV4,
} from './syncDeviceContract';

export const LEGACY_SYNC_DATABASE_NAME = 'junluo-sync.db' as const;
export const SYNC_WORLD_V2_DATABASE_NAME = 'junluo-sync-v2.db' as const;
export const DEFAULT_SYNC_DATABASE_TARGET = 'v2' as const;
export const SYNC_WORLD_V2_BASELINE_SOURCE =
  'android-current-business-state' as const;

export type SyncDatabaseTarget = 'legacy' | 'v2';
export type SyncDatabaseName =
  | typeof LEGACY_SYNC_DATABASE_NAME
  | typeof SYNC_WORLD_V2_DATABASE_NAME;
export type SyncDatabaseFileName = SyncDatabaseName | string;

const SYNC_DATABASE_FILE_NAME =
  /^junluo-sync(?:-v2(?:-(?:rebuild|pre-rebuild)-[0-9a-f-]{36})?)?\.db$/u;

export function assertSyncDatabaseFileName(
  value: string,
): asserts value is SyncDatabaseFileName {
  if (
    !SYNC_DATABASE_FILE_NAME.test(value)
    || value.includes('..')
    || value.includes('/')
    || value.includes('\\')
  ) {
    throw new Error('sync database file name is invalid');
  }
}

export type SyncWorldDescriptorV2 = {
  worldVersion: 2;
  vaultId: string;
  keyId: string;
  databaseName: typeof SYNC_WORLD_V2_DATABASE_NAME;
  baselineSource: typeof SYNC_WORLD_V2_BASELINE_SOURCE;
};

export function selectSyncDatabaseName(
  target: SyncDatabaseTarget = DEFAULT_SYNC_DATABASE_TARGET,
): SyncDatabaseName {
  return target === 'v2'
    ? SYNC_WORLD_V2_DATABASE_NAME
    : LEGACY_SYNC_DATABASE_NAME;
}

export function assertSyncWorldDescriptorV2(
  value: unknown,
): asserts value is SyncWorldDescriptorV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('sync world descriptor must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'worldVersion',
    'vaultId',
    'keyId',
    'databaseName',
    'baselineSource',
  ];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('sync world descriptor fields do not match v2');
  }
  if (record.worldVersion !== 2) {
    throw new Error('sync world descriptor version is not supported');
  }
  assertSyncUuidV4(record.vaultId, 'sync world vaultId');
  assertSyncUuidV4(record.keyId, 'sync world keyId');
  if (record.databaseName !== SYNC_WORLD_V2_DATABASE_NAME) {
    throw new Error('sync world v2 must use its independent database');
  }
  if (record.baselineSource !== SYNC_WORLD_V2_BASELINE_SOURCE) {
    throw new Error('sync world v2 must start from Android current state');
  }
}

export function createSyncWorldDescriptorV2(input: {
  vaultId: string;
  keyId: string;
}): SyncWorldDescriptorV2 {
  const descriptor: SyncWorldDescriptorV2 = {
    worldVersion: 2,
    vaultId: input.vaultId,
    keyId: input.keyId,
    databaseName: SYNC_WORLD_V2_DATABASE_NAME,
    baselineSource: SYNC_WORLD_V2_BASELINE_SOURCE,
  };
  assertSyncWorldDescriptorV2(descriptor);
  return descriptor;
}
