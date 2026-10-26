import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import {
  loadCurrentSyncDevice,
  saveAndSelectCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  expoSyncRandomBytesV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  AndroidDeviceEnrollmentWorkflow,
  AndroidPendingDeviceEnrollmentStore,
} from './syncDeviceEnrollment';
import {
  AndroidDeviceEnrollmentRelayCoordinator,
} from './syncDeviceEnrollmentRelayCoordinator';
import {
  AndroidEnrollmentRelayReceiptStore,
} from './syncDeviceEnrollmentRelayReceipt';
import { createAndroidSyncRelayClient } from './syncRelayClientExpo';

export function createAndroidDeviceEnrollmentRelayCoordinator(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const secureStore = {
    get: getSecretItem,
    set: setSecretItem,
    delete: deleteSecretItem,
  };
  const enrollmentStore =
    new AndroidPendingDeviceEnrollmentStore(secureStore);
  const receiptStore =
    new AndroidEnrollmentRelayReceiptStore(secureStore);
  const workflow = new AndroidDeviceEnrollmentWorkflow(
    enrollmentStore,
    {
      randomBytes: expoSyncRandomBytesV1,
      randomUuid: expoSyncRandomUuidV1,
      commitActiveDevice: saveAndSelectCurrentSyncDevice,
    },
  );
  return new AndroidDeviceEnrollmentRelayCoordinator(
    enrollmentStore,
    receiptStore,
    workflow,
    createAndroidSyncRelayClient(input),
    loadCurrentSyncDevice,
  );
}
