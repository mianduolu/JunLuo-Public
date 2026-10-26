import {
  base64UrlToBytes,
  deriveSyncVaultKeysV1,
} from './syncCrypto';
import {
  expoSyncRandomUuidV1,
} from './syncCryptoExpo';
import type {
  SyncDevicePublicIdentityV1,
  SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  captureSyncContentObject,
} from './syncContentObjectCapture';
import {
  preparePersonaExpressionObjectsStorageChanges,
} from './syncPersonaExpressionObjectsContent';
import type {
  PersonaExpressionObjectsStorageChange,
} from './syncPersonaExpressionObjectsStorageDerivation';
import {
  scheduleSyncObjectUpload,
} from './syncObjectJobStore';
import {
  syncObjectExpoFilePort,
} from './syncObjectExpoFilePort';

export async function preparePersonaExpressionObjectsStorageChangesRuntime(
  input: {
    changes: readonly PersonaExpressionObjectsStorageChange[];
    identity: SyncDevicePublicIdentityV1;
    secrets: SyncDeviceSecretsV1;
    now: number;
  },
) {
  const vaultKeys = deriveSyncVaultKeysV1(
    base64UrlToBytes(
      input.secrets.vaultRootSecret,
      'sync vaultRootSecret',
      32,
    ),
  );
  return preparePersonaExpressionObjectsStorageChanges({
    changes: input.changes,
    captureStickerObject: async ({ sourceUri }) => {
      const captured = await captureSyncContentObject({
        sourceUri,
        stagingToken: expoSyncRandomUuidV1(),
        keyId: input.identity.keyId,
        objectIdKey: vaultKeys.objectIdKey,
        files: syncObjectExpoFilePort,
        jobs: {
          scheduleUpload: scheduleSyncObjectUpload,
        },
        now: input.now,
      });
      return captured.objectId;
    },
  });
}
