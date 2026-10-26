import RawAsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';

import {
  base64UrlToBytes,
  deriveSyncVaultKeysV1,
} from './syncCrypto';
import { captureSyncContentObject } from './syncContentObjectCapture';
import { expoSyncRandomUuidV1 } from './syncCryptoExpo';
import type {
  SyncDevicePublicIdentityV1,
  SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  ensureAndroidContentObjectUpload,
} from './syncAndroidContentObjectUpload';
import { scheduleSyncObjectUpload } from './syncObjectJobStore';
import { syncObjectExpoFilePort } from './syncObjectExpoFilePort';
import {
  parseToolsWorkspaceFileIndex,
  projectToolsWorkspaceFileRecords,
  serializeToolsWorkspaceFileIndex,
  TOOLS_WORKSPACE_FILE_INDEX_KEY,
  type ToolsWorkspaceFileLocalIndex,
} from './syncToolsWorkspaceStorageDerivation';

async function isLocalFile(uri: string) {
  if (!/^file:\/\//.test(uri)) return false;
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info.exists && !info.isDirectory;
  } catch {
    return false;
  }
}

function localUriByCacheId(raw: string | null) {
  if (!raw) return new Map<string, string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return new Map<string, string>();
  }
  if (!Array.isArray(parsed)) return new Map<string, string>();
  const result = new Map<string, string>();
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as { cacheId?: unknown; uri?: unknown };
    if (
      typeof record.cacheId === 'string'
      && typeof record.uri === 'string'
      && /^file:\/\//.test(record.uri)
    ) {
      result.set(record.cacheId, record.uri);
    }
  }
  return result;
}

export async function prepareToolsWorkspaceFileIndexRuntime(input: {
  filesRaw: string | null;
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  now: number;
}) {
  const storedPrevious = parseToolsWorkspaceFileIndex(
    await RawAsyncStorage.getItem(TOOLS_WORKSPACE_FILE_INDEX_KEY),
  );
  const vaultKeys = deriveSyncVaultKeysV1(
    base64UrlToBytes(
      input.secrets.vaultRootSecret,
      'sync vaultRootSecret',
      32,
    ),
  );
  const previous: ToolsWorkspaceFileLocalIndex = {
    ...storedPrevious,
    records: await Promise.all(storedPrevious.records.map(
      async (record) => {
        if (
          record.keyId !== input.identity.keyId
          || !record.object
        ) {
          return record;
        }
        const reusable = await ensureAndroidContentObjectUpload({
          objectId: record.object.objectId,
          keyId: input.identity.keyId,
          totalChunks: record.object.chunkCount,
          objectIdKey: vaultKeys.objectIdKey,
          now: input.now,
        });
        if (reusable) return record;
        const { keyId: _keyId, ...needsCapture } = record;
        return needsCapture;
      },
    )),
  };
  const metadata = projectToolsWorkspaceFileRecords(input.filesRaw);
  const uris = localUriByCacheId(input.filesRaw);
  const previousById = new Map(
    previous.records.map((record) => [record.cacheId, record]),
  );
  const records: ToolsWorkspaceFileLocalIndex['records'] = [];
  for (const fileRecord of metadata) {
    const uri = uris.get(fileRecord.cacheId);
    const existing = previousById.get(fileRecord.cacheId);
    if (
      uri
      && existing?.localUri === uri
      && existing.object
      && existing.keyId === input.identity.keyId
      && await isLocalFile(uri)
    ) {
      records.push({
        cacheId: fileRecord.cacheId,
        metadata: fileRecord,
        object: existing.object,
        keyId: input.identity.keyId,
        localUri: uri,
      });
      continue;
    }
    if (!uri || !await isLocalFile(uri)) {
      if (existing?.object) {
        records.push({
          cacheId: fileRecord.cacheId,
          metadata: fileRecord,
          object: existing.object,
          ...(existing.keyId ? { keyId: existing.keyId } : {}),
          ...(existing.localUri ? { localUri: existing.localUri } : {}),
        });
        continue;
      }
      records.push({
        cacheId: fileRecord.cacheId,
        metadata: fileRecord,
      });
      continue;
    }
    const captured = await captureSyncContentObject({
      sourceUri: uri,
      stagingToken: expoSyncRandomUuidV1(),
      keyId: input.identity.keyId,
      objectIdKey: vaultKeys.objectIdKey,
      files: syncObjectExpoFilePort,
      jobs: { scheduleUpload: scheduleSyncObjectUpload },
      now: input.now,
    });
    const existingObject = existing?.object;
    records.push({
      cacheId: fileRecord.cacheId,
      metadata: fileRecord,
      object: {
        cacheId: fileRecord.cacheId,
        objectId: captured.objectId,
        plaintextBytes: captured.manifest.plaintextBytes,
        chunkCount: captured.manifest.chunks.length,
        updatedAt: existingObject?.objectId === captured.objectId
          ? existingObject.updatedAt
          : input.now,
      },
      keyId: input.identity.keyId,
      localUri: uri,
    });
  }
  const next: ToolsWorkspaceFileLocalIndex = {
    version: 1,
    records,
    updatedAt: input.now,
  };
  return {
    index: next,
    raw: serializeToolsWorkspaceFileIndex(next),
  };
}
