import { Asset } from 'expo-asset';
import * as FileSystem from 'expo-file-system/legacy';

import { customFontSources } from '../fonts/fontCatalog';
import {
  XIAOLAI_FONT_ASSET,
} from './syncAppearanceFonts';
import {
  parseAppearanceFontChoice,
  serializeAppearanceFontLocalIndex,
  type AppearanceFontLocalIndex,
} from './syncAppearanceFontsStorageDerivation';
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

async function existingLocalFile(uri: string | undefined) {
  if (!uri || !/^file:\/\//.test(uri)) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

async function bundledXiaolaiUri() {
  const asset = Asset.fromModule(customFontSources.Xiaolai);
  await asset.downloadAsync();
  if (!asset.localUri || !/^file:\/\//.test(asset.localUri)) {
    throw new Error('小赖字体资产尚未取得可复制的本机 file URI。');
  }
  return asset.localUri;
}

export async function prepareAppearanceFontIndexRuntime(input: {
  choiceRaw: string | null;
  previous: AppearanceFontLocalIndex;
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  now: number;
}) {
  const choice = parseAppearanceFontChoice(input.choiceRaw);
  if (choice !== 'xiaolai') {
    return {
      index: input.previous,
      raw: serializeAppearanceFontLocalIndex(input.previous),
    };
  }
  const existing = input.previous.records.find(
    (record) =>
      record.fontId === XIAOLAI_FONT_ASSET.fontId
      && record.assetVersion === XIAOLAI_FONT_ASSET.assetVersion,
  );
  if (existing && await existingLocalFile(existing.localUri)) {
    return {
      index: input.previous,
      raw: serializeAppearanceFontLocalIndex(input.previous),
    };
  }

  const sourceUri = await bundledXiaolaiUri();
  const vaultKeys = deriveSyncVaultKeysV1(
    base64UrlToBytes(
      input.secrets.vaultRootSecret,
      'sync vaultRootSecret',
      32,
    ),
  );
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
  const next: AppearanceFontLocalIndex = {
    version: 1,
    records: [{
      ...XIAOLAI_FONT_ASSET,
      objectId: captured.objectId,
      plaintextBytes: captured.manifest.plaintextBytes,
      chunkCount: captured.manifest.chunks.length,
      localUri: captured.localUri,
      updatedAt: existing?.objectId === captured.objectId
        ? existing.updatedAt
        : input.now,
    }],
  };
  return {
    index: next,
    raw: serializeAppearanceFontLocalIndex(next),
  };
}
