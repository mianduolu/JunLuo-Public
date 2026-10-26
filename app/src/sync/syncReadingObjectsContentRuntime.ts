import RawAsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

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
  parseReadingObjectsLocalIndex,
  prepareReadingObjectsIndexForLibrary,
  READING_OBJECTS_INDEX_KEY,
  type ReadingObjectDiscoveredFile,
} from './syncReadingObjectsStorageDerivation';

const IMAGE_EXTENSIONS = new Set([
  'gif',
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
]);

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function readingBookDirectory(bookId: string) {
  expect(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bookId),
    'reading objects bookId 无效。',
  );
  expect(
    !!FileSystem.documentDirectory,
    '当前设备无法访问应用文件目录。',
  );
  return `${FileSystem.documentDirectory}reading/books/${bookId}/`;
}

function mediaTypeForExtension(extension: string) {
  const known: Readonly<Record<string, string>> = {
    gif: 'image/gif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    svg: 'image/svg+xml',
    webp: 'image/webp',
  };
  return known[extension];
}

async function isLocalFile(uri: string) {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

export async function discoverReadingExtractedImageFiles(
  bookId: string,
): Promise<ReadingObjectDiscoveredFile[]> {
  const directory = `${readingBookDirectory(bookId)}images/`;
  let names: string[];
  try {
    const info = await FileSystem.getInfoAsync(directory);
    if (!info.exists || !info.isDirectory) return [];
    names = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return [];
  }
  expect(names.length <= 20_000, '单本书的提取图片数量超过安全上限。');
  const files: ReadingObjectDiscoveredFile[] = [];
  for (const name of names.sort()) {
    if (
      name.length < 1
      || name.length > 160
      || /[\/\\\u0000-\u001f\u007f]/.test(name)
      || name === '.'
      || name === '..'
    ) {
      continue;
    }
    const match = name.match(/\.([a-z0-9]{1,16})$/i);
    const extension = match?.[1].toLowerCase();
    if (!extension || !IMAGE_EXTENSIONS.has(extension)) continue;
    const uri = `${directory}${name}`;
    if (!await isLocalFile(uri)) continue;
    files.push({
      role: 'extracted-image',
      slot: name,
      uri,
      extension,
      mediaType: mediaTypeForExtension(extension),
    });
  }
  return files;
}

export async function prepareReadingObjectsIndexForLibraryRuntime(input: {
  libraryRaw: string;
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  now: number;
}) {
  const storedPrevious = parseReadingObjectsLocalIndex(
    await RawAsyncStorage.getItem(READING_OBJECTS_INDEX_KEY),
  );
  const vaultKeys = deriveSyncVaultKeysV1(
    base64UrlToBytes(
      input.secrets.vaultRootSecret,
      'sync vaultRootSecret',
      32,
    ),
  );
  const previous = {
    ...storedPrevious,
    records: await Promise.all(storedPrevious.records.map(
      async (record) => {
        if (record.keyId !== input.identity.keyId) return record;
        const reusable = await ensureAndroidContentObjectUpload({
          objectId: record.objectId,
          keyId: input.identity.keyId,
          totalChunks: record.chunkCount,
          objectIdKey: vaultKeys.objectIdKey,
          now: input.now,
        });
        if (reusable) return record;
        const { keyId: _keyId, ...needsCapture } = record;
        return needsCapture;
      },
    )),
  };
  return prepareReadingObjectsIndexForLibrary({
    previous,
    libraryRaw: input.libraryRaw,
    keyId: input.identity.keyId,
    discoverExtractedImages: discoverReadingExtractedImageFiles,
    capture: async ({ file }) => {
      if (!await isLocalFile(file.uri)) return null;
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
    now: input.now,
  });
}
