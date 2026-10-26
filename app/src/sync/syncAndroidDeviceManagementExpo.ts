import {
  AndroidDeviceManagementController,
} from './syncAndroidDeviceManagement';
import {
  enqueueAndroidExplicitSyncOperation,
} from './syncAndroidExplicitOperationQueue';
import {
  createAndroidSyncRelayClient,
  loadCurrentSyncRelayEnrollment,
} from './syncRelayClientExpo';
import { saveSyncDevicePublicIdentity } from './syncStore';
import {
  updateNewWorldAndroidCurrentIdentity,
} from './syncNewWorldSecretsExpo';

export function createAndroidDeviceManagementController(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const controller = new AndroidDeviceManagementController(
    createAndroidSyncRelayClient(input),
    loadCurrentSyncRelayEnrollment,
    Date.now,
    async (identity) => {
      await saveSyncDevicePublicIdentity(identity);
      await updateNewWorldAndroidCurrentIdentity(identity);
    },
  );
  return {
    refreshDirectory: () => enqueueAndroidExplicitSyncOperation(
      () => controller.refreshDirectory(),
    ),
    revokePeerDevice: (deviceId: string) => (
      enqueueAndroidExplicitSyncOperation(
        () => controller.revokePeerDevice(deviceId),
      )
    ),
    renameCurrentDevice: (displayName: string) => (
      enqueueAndroidExplicitSyncOperation(
        () => controller.renameCurrentDevice(displayName),
      )
    ),
  };
}
