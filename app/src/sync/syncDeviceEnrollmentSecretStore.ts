import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import { saveAndSelectCurrentSyncDevice } from './syncCurrentDevice';
import {
  AndroidDeviceEnrollmentWorkflow,
  AndroidPendingDeviceEnrollmentStore,
} from './syncDeviceEnrollment';
import {
  expoSyncRandomBytesV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';

export function createAndroidDeviceEnrollmentWorkflow() {
  const store = new AndroidPendingDeviceEnrollmentStore({
    get: getSecretItem,
    set: setSecretItem,
    delete: deleteSecretItem,
  });
  return new AndroidDeviceEnrollmentWorkflow(store, {
    randomBytes: expoSyncRandomBytesV1,
    randomUuid: expoSyncRandomUuidV1,
    commitActiveDevice: saveAndSelectCurrentSyncDevice,
  });
}
