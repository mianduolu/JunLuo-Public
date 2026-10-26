import {
  expoSyncRandomBytesV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  AndroidSyncExecutionFenceSqlitePort,
  AndroidSyncExecutionFenceV2SqlitePort,
} from './syncExecutionFenceSqlitePort';
import {
  SyncExecutionIntentCoordinatorV1,
  SyncExecutionOnceControllerV1,
} from './syncExecutionOnceController';
import {
  SyncExecutionOnceCoordinatorV2,
} from './syncExecutionOnceV2Controller';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import {
  resolveSyncDeviceSigningPublicKeyAt,
  saveSyncDevicePublicIdentity,
} from './syncStore';

export async function createAndroidSyncExecutionOnceController(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  if (!enrollment) {
    throw new Error('尚未建立当前 Android 同步设备，无法领取执行租约。');
  }
  const relay = createAndroidSyncRelayClient(input);
  const controller = new SyncExecutionOnceControllerV1({
    enrollment,
    relay,
    fence: new AndroidSyncExecutionFenceSqlitePort(),
    randomUuid: expoSyncRandomUuidV1,
    randomBytes: expoSyncRandomBytesV1,
  });
  const resolveSigningPublicKey = async (intent: {
    vaultId: string;
    sourceDeviceId: string;
    keyId: string;
    createdAt: number;
  }) => {
    let publicKey = await resolveSyncDeviceSigningPublicKeyAt({
      vaultId: intent.vaultId,
      deviceId: intent.sourceDeviceId,
      keyId: intent.keyId,
      createdAt: intent.createdAt,
    });
    if (!publicKey) {
      const devices = await relay.listDevices(enrollment);
      for (const device of devices) {
        await saveSyncDevicePublicIdentity(device);
      }
      publicKey = await resolveSyncDeviceSigningPublicKeyAt({
        vaultId: intent.vaultId,
        deviceId: intent.sourceDeviceId,
        keyId: intent.keyId,
        createdAt: intent.createdAt,
      });
    }
    if (!publicKey) {
      throw new Error('执行意图来源设备未登记、尚未激活或已经撤销。');
    }
    return publicKey;
  };
  const legacyCoordinator = new SyncExecutionIntentCoordinatorV1({
    enrollment,
    relay,
    controller,
    resolveSigningPublicKey,
  });
  const coordinator = new SyncExecutionOnceCoordinatorV2({
    enrollment,
    relay,
    fence: new AndroidSyncExecutionFenceV2SqlitePort(),
    executeLegacy: (legacyInput) => legacyCoordinator.execute(legacyInput),
  });
  return { enrollment, controller: coordinator, coordinator };
}
