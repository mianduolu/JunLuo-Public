import { loadCurrentSyncDevice } from './syncCurrentDevice';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import {
  SyncRelayClient,
  type SyncRelayActiveEnrollmentV1,
} from './syncRelayClient';

export function createAndroidSyncRelayClient(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  return new SyncRelayClient({
    ...input,
    randomUuid: expoSyncRandomUuidV1,
  });
}

export async function loadCurrentSyncRelayEnrollment(): Promise<
  SyncRelayActiveEnrollmentV1 | null
> {
  const current = await loadCurrentSyncDevice();
  if (!current) return null;
  return {
    publicIdentity: current.identity,
    secrets: current.secrets,
  };
}
