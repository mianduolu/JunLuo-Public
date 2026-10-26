import {
  deleteSecretItem,
  getSecretItem,
  setSecretItem,
} from '../storage/secretStore';
import {
  expoSyncRandomBytesV1,
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import { canonicalizeJsonV1 } from './syncCrypto';
import {
  AndroidPairingInvitationController,
  AndroidPairingInvitationStore,
} from './syncPairingInvitationController';
import {
  NewWorldRelayProvisioningController,
  NewWorldRelayProvisioningStore,
  newWorldRelayProvisioningSnapshot,
} from './syncNewWorldRelayProvisioning';
import {
  createExpoSyncWorldBaselineStore,
} from './syncNewWorldBaselineExpoStore';
import {
  loadNewWorldAndroidStagingSecret,
} from './syncNewWorldSecretsExpo';
import { SYNC_WORLD_V2_DATABASE_NAME } from './syncWorld';
import { createAndroidSyncRelayClient } from './syncRelayClientExpo';

const NEW_WORLD_PAIRING_INVITATION_KEY =
  'junluo.sync.v2.android-pairing-invitation.v1';
const NEW_WORLD_RELAY_PROVISIONING_KEY =
  'junluo.sync.v2.relay-provisioning.v1';

const secureStore = {
  get: getSecretItem,
  set: setSecretItem,
  delete: deleteSecretItem,
};

function provisioningStore() {
  return new NewWorldRelayProvisioningStore(
    secureStore,
    NEW_WORLD_RELAY_PROVISIONING_KEY,
  );
}

export async function archiveNewWorldRelayLocalStateForEmergencyRebuild(
  sessionId: string,
) {
  const slots = [
    NEW_WORLD_RELAY_PROVISIONING_KEY,
    NEW_WORLD_PAIRING_INVITATION_KEY,
  ] as const;
  for (const currentKey of slots) {
    const rollbackKey = `${currentKey}.pre-rebuild.${sessionId}`;
    const current = await getSecretItem(currentKey);
    if (current !== null && await getSecretItem(rollbackKey) === null) {
      await setSecretItem(rollbackKey, current);
    }
    if (current !== null) await deleteSecretItem(currentKey);
  }
}

export async function deleteArchivedNewWorldRelayLocalState(sessionId: string) {
  for (const currentKey of [NEW_WORLD_RELAY_PROVISIONING_KEY, NEW_WORLD_PAIRING_INVITATION_KEY]) {
    await deleteSecretItem(`${currentKey}.pre-rebuild.${sessionId}`);
  }
}

export async function loadAndroidNewWorldRelaySnapshot() {
  return newWorldRelayProvisioningSnapshot(
    await loadNewWorldAndroidStagingSecret(),
    await provisioningStore().load(),
  );
}

export function createAndroidNewWorldRelayProvisioningController(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  return new NewWorldRelayProvisioningController(
    provisioningStore(),
    createAndroidSyncRelayClient(input),
    {
      loadStaging: loadNewWorldAndroidStagingSecret,
      assertLocalBaselineComplete: async () => {
        const checkpoint = await createExpoSyncWorldBaselineStore()
          .loadCheckpoint();
        if (checkpoint?.state !== 'complete') {
          throw new Error('new-world current baseline is not complete');
        }
      },
      randomUuid: expoSyncRandomUuidV1,
    },
  );
}

export function createAndroidNewWorldPairingInvitationController(input: {
  baseUrl: string;
  timeoutMs?: number;
}) {
  const controller = new AndroidPairingInvitationController(
    new AndroidPairingInvitationStore(
      secureStore,
      NEW_WORLD_PAIRING_INVITATION_KEY,
    ),
    createAndroidSyncRelayClient(input),
    {
      randomBytes: expoSyncRandomBytesV1,
      randomUuid: expoSyncRandomUuidV1,
      loadActiveDevice: async () => {
        const [staging, provisioning] = await Promise.all([
          loadNewWorldAndroidStagingSecret(),
          provisioningStore().load(),
        ]);
        const snapshot = newWorldRelayProvisioningSnapshot(
          staging,
          provisioning,
        );
        if (!staging || snapshot.state !== 'provisioned') {
          throw new Error('new-world relay space is not provisioned');
        }
        return {
          identity: staging.identity,
          secrets: staging.secrets,
        };
      },
    },
  );
  const snapshot = async () => {
    const value = await controller.snapshot();
    if (!value) return null;
    return {
      ...value,
      qrPayload: canonicalizeJsonV1({
        worldVersion: 2,
        databaseName: SYNC_WORLD_V2_DATABASE_NAME,
        offer: JSON.parse(value.qrPayload) as unknown,
      }),
    };
  };
  return {
    snapshot,
    prepareInvitation: () => controller.prepareInvitation(),
    publishInvitation: () => controller.publishInvitation(),
    refreshInvitation: () => controller.refreshInvitation(),
    prepareApproval: (code: string) => controller.prepareApproval(code),
    submitApproval: () => controller.submitApproval(),
    clearExpiredInvitation: () => controller.clearExpiredInvitation(),
  };
}
