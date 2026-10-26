import type * as SQLite from 'expo-sqlite';

import { isBackupRestoreSyncGateActive } from '../backup/backupRestoreSyncGate';
import {
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  assertSyncUuidV4,
  sameSyncDeviceIdentityExceptDisplayNameV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  loadSyncDeviceSecrets,
  saveSyncDeviceSecrets,
} from './syncDeviceIdentity';
import { resetAutomaticDataSyncPolicy } from './automaticDataSyncPolicy';
import {
  openInitializedSyncDatabase,
} from './syncDatabaseOpen';
import {
  enqueueSyncDatabaseOperation,
} from './syncDatabaseOperationQueue';
import {
  saveSyncDevicePublicIdentity,
} from './syncStore';
import {
  NEW_WORLD_CURRENT_SECRET_KEY,
  loadNewWorldAndroidStagingSecret,
  saveNewWorldAndroidSecretSlot,
} from './syncNewWorldSecretsExpo';
import {
  createSyncWorldDescriptorV2,
  DEFAULT_SYNC_DATABASE_TARGET,
} from './syncWorld';

const CURRENT_SYNC_DEVICE_ID_KEY = 'junluo.sync.current-device-id.v1';

type SyncDeviceIdentityRow = {
  device_id: string;
  vault_id: string;
  key_id: string;
  platform: 'android' | 'windows';
  display_name: string;
  signing_public_key: string;
  exchange_public_key: string;
  state: 'pending' | 'active' | 'revoked';
  created_at: number;
  revoked_at: number | null;
};

let currentDeviceDatabasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

export async function getCurrentDeviceDatabase() {
  if (!currentDeviceDatabasePromise) {
    const openingDatabasePromise = openInitializedSyncDatabase(
      '同步数据库版本高于当前应用，无法读取本机设备身份。',
    );
    const retryableDatabasePromise = openingDatabasePromise.catch(
      (error) => {
        if (
          currentDeviceDatabasePromise
          === retryableDatabasePromise
        ) {
          currentDeviceDatabasePromise = undefined;
        }
        throw error;
      },
    );
    currentDeviceDatabasePromise = retryableDatabasePromise;
  }
  return currentDeviceDatabasePromise;
}

function publicIdentityFromRow(row: SyncDeviceIdentityRow): SyncDevicePublicIdentityV1 {
  const identity: SyncDevicePublicIdentityV1 = {
    version: 1,
    vaultId: row.vault_id,
    deviceId: row.device_id,
    keyId: row.key_id,
    platform: row.platform,
    displayName: row.display_name,
    signingPublicKey: row.signing_public_key,
    exchangePublicKey: row.exchange_public_key,
    state: row.state,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
  assertSyncDevicePublicIdentityV1(identity);
  return identity;
}

export function assertMatchingSyncDeviceIdentity(
  identity: SyncDevicePublicIdentityV1,
  secrets: SyncDeviceSecretsV1,
) {
  assertSyncDevicePublicIdentityV1(identity);
  assertSyncDeviceSecretsV1(secrets);
  if (
    identity.deviceId !== secrets.deviceId
    || identity.vaultId !== secrets.vaultId
    || identity.keyId !== secrets.keyId
  ) {
    throw new Error('同步设备公开身份与本机秘密不匹配。');
  }
}

export async function saveAndSelectCurrentSyncDevice(
  identity: SyncDevicePublicIdentityV1,
  secrets: SyncDeviceSecretsV1,
) {
  assertMatchingSyncDeviceIdentity(identity, secrets);
  if (identity.state !== 'active') {
    throw new Error('只有 active 设备可以成为当前同步设备。');
  }
  await saveSyncDevicePublicIdentity(identity);
  await saveSyncDeviceSecrets(secrets);
  await setSecretItem(CURRENT_SYNC_DEVICE_ID_KEY, identity.deviceId);
  if (DEFAULT_SYNC_DATABASE_TARGET === 'v2') {
    await saveNewWorldAndroidSecretSlot(
      NEW_WORLD_CURRENT_SECRET_KEY,
      Object.freeze({
        version: 1,
        world: createSyncWorldDescriptorV2({
          vaultId: identity.vaultId,
          keyId: identity.keyId,
        }),
        identity,
        secrets,
        createdAt: identity.createdAt,
      }),
    );
  }
  await resetAutomaticDataSyncPolicy();
}

export async function loadCurrentSyncDevice(input: {
  allowDuringBackupRestore?: boolean;
} = {}) {
  if (
    !input.allowDuringBackupRestore
    && await isBackupRestoreSyncGateActive()
  ) return null;
  if (DEFAULT_SYNC_DATABASE_TARGET === 'v2') {
    const staging = await loadNewWorldAndroidStagingSecret();
    if (!staging) return null;
    const database = await getCurrentDeviceDatabase();
    const row = await enqueueSyncDatabaseOperation(
      () => database.getFirstAsync<SyncDeviceIdentityRow>(
        `SELECT device_id, vault_id, key_id, platform, display_name,
                signing_public_key, exchange_public_key, state, created_at, revoked_at
         FROM sync_device_state WHERE device_id = ?`,
        staging.identity.deviceId,
      ),
    );
    if (!row) {
      throw new Error('新世界当前设备公开身份不存在，已停止业务捕获。');
    }
    const identity = publicIdentityFromRow(row);
    assertMatchingSyncDeviceIdentity(identity, staging.secrets);
    if (!sameSyncDeviceIdentityExceptDisplayNameV1(
      identity,
      staging.identity,
    )) {
      throw new Error('新世界当前设备公开身份与安全存储不一致。');
    }
    if (identity.state !== 'active' || identity.revokedAt !== null) {
      throw new Error('新世界当前设备已撤销，不能捕获业务变更。');
    }
    return { identity, secrets: staging.secrets };
  }
  const deviceId = await getSecretItem(CURRENT_SYNC_DEVICE_ID_KEY);
  if (deviceId === null) return null;
  assertSyncUuidV4(deviceId, 'current sync deviceId');
  const database = await getCurrentDeviceDatabase();
  const row = await enqueueSyncDatabaseOperation(
    () => database.getFirstAsync<SyncDeviceIdentityRow>(
      `SELECT device_id, vault_id, key_id, platform, display_name,
              signing_public_key, exchange_public_key, state, created_at, revoked_at
       FROM sync_device_state WHERE device_id = ?`,
      deviceId,
    ),
  );
  if (!row) throw new Error('当前同步设备公开身份不存在，已停止业务捕获。');
  const identity = publicIdentityFromRow(row);
  const secrets = await loadSyncDeviceSecrets(deviceId);
  if (!secrets) throw new Error('当前同步设备秘密不存在，需通过恢复卡重新授权。');
  assertMatchingSyncDeviceIdentity(identity, secrets);
  if (identity.state !== 'active' || identity.revokedAt !== null) {
    throw new Error('当前同步设备已撤销或尚未激活，不能捕获业务变更。');
  }
  return { identity, secrets };
}

export async function closeCurrentSyncDeviceDatabaseForTests() {
  if (!currentDeviceDatabasePromise) return;
  const database = await currentDeviceDatabasePromise;
  await database.closeAsync();
  currentDeviceDatabasePromise = undefined;
}
