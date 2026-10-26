import * as FileSystem from 'expo-file-system/legacy';

import {
  parseAppearanceBackgroundSettings,
  serializeAppearanceBackgroundLocalIndex,
  type AppearanceBackgroundLocalIndex,
} from './syncAppearanceBackgroundStorageDerivation';
import {
  captureSyncContentObject,
} from './syncContentObjectCapture';
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
  scheduleSyncObjectUpload,
} from './syncObjectJobStore';
import {
  syncObjectExpoFilePort,
} from './syncObjectExpoFilePort';

function extensionFromUri(uri: string) {
  const match = uri.match(
    /\.([a-zA-Z0-9]{1,8})(?:[?#].*)?$/,
  );
  return match ? match[1]!.toLowerCase() : 'jpg';
}

async function existingLocalFile(uri: string | undefined) {
  if (!uri || !/^file:\/\//.test(uri)) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

export async function prepareAppearanceBackgroundIndexRuntime(input: {
  settingsRaw: string | null;
  previous: AppearanceBackgroundLocalIndex;
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  now: number;
}) {
  const settings = parseAppearanceBackgroundSettings(
    input.settingsRaw,
  );
  if (!settings.imageUri) {
    if (
      settings.mode === 'image'
      && input.previous.selectedObjectId
    ) {
      return {
        index: input.previous,
        raw: serializeAppearanceBackgroundLocalIndex(
          input.previous,
        ),
      };
    }
    const index: AppearanceBackgroundLocalIndex = {
      version: 1,
      objects: [],
    };
    return {
      index,
      raw: serializeAppearanceBackgroundLocalIndex(index),
    };
  }
  const existing = input.previous.objects.find(
    (record) => record.localUri === settings.imageUri,
  );
  if (existing && await existingLocalFile(existing.localUri)) {
    const index: AppearanceBackgroundLocalIndex = {
      version: 1,
      selectedObjectId: existing.objectId,
      objects: [existing],
    };
    return {
      index,
      raw: serializeAppearanceBackgroundLocalIndex(index),
    };
  }

  const vaultKeys = deriveSyncVaultKeysV1(
    base64UrlToBytes(
      input.secrets.vaultRootSecret,
      'sync vaultRootSecret',
      32,
    ),
  );
  const captured = await captureSyncContentObject({
    sourceUri: settings.imageUri,
    stagingToken: expoSyncRandomUuidV1(),
    keyId: input.identity.keyId,
    objectIdKey: vaultKeys.objectIdKey,
    files: syncObjectExpoFilePort,
    jobs: {
      scheduleUpload: scheduleSyncObjectUpload,
    },
    now: input.now,
  });
  const object = {
    slotId: 'custom' as const,
    objectId: captured.objectId,
    extension: extensionFromUri(settings.imageUri),
    plaintextBytes: captured.manifest.plaintextBytes,
    chunkCount: captured.manifest.chunks.length,
    localUri: settings.imageUri,
    updatedAt: existing?.objectId === captured.objectId
      ? existing.updatedAt
      : input.now,
  };
  const index: AppearanceBackgroundLocalIndex = {
    version: 1,
    selectedObjectId: object.objectId,
    objects: [object],
  };
  return {
    index,
    raw: serializeAppearanceBackgroundLocalIndex(index),
  };
}
