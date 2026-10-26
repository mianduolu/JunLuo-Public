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
  ensureAndroidContentObjectUpload,
} from './syncAndroidContentObjectUpload';
import {
  captureSyncContentObject,
} from './syncContentObjectCapture';
import {
  scheduleSyncObjectUpload,
} from './syncObjectJobStore';
import {
  syncObjectExpoFilePort,
} from './syncObjectExpoFilePort';
import {
  prepareTogetherWalkedLifeLocalIndex,
  type TogetherWalkedLifeLocalIndex,
  type TogetherWalkedLifeRawSnapshot,
} from './syncTogetherWalkedLifeStorageDerivation';

export async function prepareTogetherWalkedLifeLocalIndexRuntime(
  input: {
    raw: TogetherWalkedLifeRawSnapshot;
    previous: TogetherWalkedLifeLocalIndex;
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
  const previous = {
    ...input.previous,
    objects: await Promise.all(input.previous.objects.map(
      async (object) => {
        if (object.keyId !== input.identity.keyId) return object;
        const reusable = await ensureAndroidContentObjectUpload({
          objectId: object.objectId,
          keyId: input.identity.keyId,
          totalChunks: object.chunkCount,
          objectIdKey: vaultKeys.objectIdKey,
          now: input.now,
        });
        if (reusable) return object;
        const { keyId: _keyId, ...needsCapture } = object;
        return needsCapture;
      },
    )),
  };
  return prepareTogetherWalkedLifeLocalIndex({
    raw: input.raw,
    previous,
    keyId: input.identity.keyId,
    capture: {
      async capture(file) {
        const captured = await captureSyncContentObject({
          sourceUri: file.uri,
          stagingToken: expoSyncRandomUuidV1(),
          keyId: input.identity.keyId,
          objectIdKey: vaultKeys.objectIdKey,
          files: syncObjectExpoFilePort,
          jobs: {
            scheduleUpload: scheduleSyncObjectUpload,
          },
          now: input.now,
        });
        return {
          objectId: captured.objectId,
          plaintextBytes: captured.manifest.plaintextBytes,
          chunkCount: captured.manifest.chunks.length,
        };
      },
    },
    now: input.now,
  });
}
