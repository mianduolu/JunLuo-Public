import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  expoSyncRandomBytesV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import {
  AndroidPairingInvitationController,
  AndroidPairingInvitationStore,
} from './syncPairingInvitationController';
import { createAndroidSyncRelayClient } from './syncRelayClientExpo';

export function createAndroidPairingInvitationController(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const secureStore = {
    get: getSecretItem,
    set: setSecretItem,
    delete: deleteSecretItem,
  };
  return new AndroidPairingInvitationController(
    new AndroidPairingInvitationStore(secureStore),
    createAndroidSyncRelayClient(input),
    {
      randomBytes: expoSyncRandomBytesV1,
      randomUuid: expoSyncRandomUuidV1,
      loadActiveDevice: loadCurrentSyncDevice,
    },
  );
}
