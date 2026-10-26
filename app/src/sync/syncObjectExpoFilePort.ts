import {
  Directory,
  File,
  Paths,
} from 'expo-file-system';

import {
  scanManagedSyncContentNative,
} from './syncAndroidObjectNativeScanner';
import type {
  SyncContentObjectFilePort,
} from './syncContentObjectCapture';
import {
  canonicalizeJsonV1,
} from './syncCrypto';
import {
  assertSyncObjectManifestPlaintextV1,
  type SyncObjectManifestPlaintextV1,
} from './syncObjectProtocol';
import {
  isStaleSyncObjectTemporaryEntry,
  isSyncObjectCaptureStagingName,
  isSyncObjectDownloadPartialFileName,
  syncObjectIdFromDownloadStagingName,
} from './syncObjectTemporaryRetentionPolicy';

const ROOT_FOLDER = 'junluo-sync-objects-v1';
const STAGING_FOLDER = 'staging';
const OBJECTS_FOLDER = 'objects';
const MANIFESTS_FOLDER = 'manifests';

export function getSyncObjectExpoDirectories() {
  const root = new Directory(Paths.document, ROOT_FOLDER);
  root.create({ idempotent: true, intermediates: true });
  const staging = new Directory(root, STAGING_FOLDER);
  staging.create({ idempotent: true, intermediates: true });
  const objects = new Directory(root, OBJECTS_FOLDER);
  objects.create({ idempotent: true, intermediates: true });
  const manifests = new Directory(root, MANIFESTS_FOLDER);
  manifests.create({ idempotent: true, intermediates: true });
  return { staging, objects, manifests };
}

function requireFileUri(uri: string, label: string) {
  if (!/^file:\/\//.test(uri)) {
    throw new Error(`${label} 必须是当前设备可复制的 file URI。`);
  }
}

export function assertSyncObjectId(objectId: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(objectId)) {
    throw new Error(
      'content-object objectId 格式无效。',
    );
  }
}

function uriLeafName(uri: string) {
  const trimmed = uri.replace(/\/+$/u, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function entryModificationTime(entry: File | Directory) {
  const value = entry.info().modificationTime;
  return typeof value === 'number' ? value : null;
}

export async function cleanupStaleSyncObjectExpoStaging(input: {
  now: number;
  isDownloadStagingProtected: (
    objectId: string,
    stagingUri: string,
  ) => Promise<boolean>;
}) {
  if (!Number.isSafeInteger(input.now) || input.now < 0) {
    throw new Error('content-object 临时清理时间无效。');
  }
  const { staging } = getSyncObjectExpoDirectories();
  let deletedFiles = 0;
  let deletedDirectories = 0;
  for (const entry of staging.list()) {
    const name = uriLeafName(entry.uri);
    if (entry instanceof File) {
      if (
        isSyncObjectCaptureStagingName(name)
        && isStaleSyncObjectTemporaryEntry(
          entryModificationTime(entry),
          input.now,
        )
      ) {
        entry.delete();
        deletedFiles += 1;
      }
      continue;
    }
    if (!(entry instanceof Directory)) continue;
    const objectId = syncObjectIdFromDownloadStagingName(name);
    if (!objectId) continue;
    const children = entry.list();
    const protectedByJob = await input.isDownloadStagingProtected(
      objectId,
      entry.uri,
    );
    const wholeDirectoryIsStale = isStaleSyncObjectTemporaryEntry(
      entryModificationTime(entry),
      input.now,
    ) && children.every((child) => (
      child instanceof File
      && isStaleSyncObjectTemporaryEntry(
        entryModificationTime(child),
        input.now,
      )
    ));
    if (!protectedByJob && wholeDirectoryIsStale) {
      entry.delete();
      deletedDirectories += 1;
      continue;
    }
    for (const child of children) {
      if (!(child instanceof File)) continue;
      if (
        isSyncObjectDownloadPartialFileName(
          uriLeafName(child.uri),
        )
        && isStaleSyncObjectTemporaryEntry(
          entryModificationTime(child),
          input.now,
        )
      ) {
        child.delete();
        deletedFiles += 1;
      }
    }
  }
  return { deletedFiles, deletedDirectories };
}

function assertObjectId(objectId: string) {
  assertSyncObjectId(objectId);
}

function manifestFiles(objectId: string) {
  assertSyncObjectId(objectId);
  const { manifests } = getSyncObjectExpoDirectories();
  return {
    target: new File(manifests, `${objectId}.json`),
    partial: new File(manifests, `${objectId}.json.partial`),
  };
}

export async function loadSyncObjectExpoManifest(
  objectId: string,
) {
  const { target } = manifestFiles(objectId);
  if (!target.exists) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await target.text());
  } catch {
    throw new Error('本机 content-object manifest 不是有效 JSON。');
  }
  assertSyncObjectManifestPlaintextV1(parsed);
  if (parsed.objectId !== objectId) {
    throw new Error('本机 content-object manifest 路由不一致。');
  }
  return parsed;
}

export async function saveSyncObjectExpoManifest(
  localUri: string,
  manifest: SyncObjectManifestPlaintextV1,
) {
  assertSyncObjectManifestPlaintextV1(manifest);
  const { objects } = getSyncObjectExpoDirectories();
  const managed = new File(objects, manifest.objectId);
  if (!managed.exists || managed.uri !== localUri) {
    throw new Error('content-object manifest 只能绑定受管本机文件。');
  }
  const serialized = canonicalizeJsonV1(manifest);
  const { target, partial } = manifestFiles(manifest.objectId);
  if (target.exists) {
    if (await target.text() === serialized) return;
    throw new Error('同一 objectId 已保存不同的本机 manifest。');
  }
  if (partial.exists) partial.delete();
  const temporaryUri = partial.uri;
  try {
    partial.create({ intermediates: true, overwrite: false });
    partial.write(serialized);
    partial.move(target);
    if (!target.exists) {
      throw new Error('content-object manifest 原子落盘失败。');
    }
  } finally {
    // File.move changes the handle's URI to the committed file.
    const leftover = new File(temporaryUri);
    if (leftover.exists) leftover.delete();
  }
}

export const syncObjectExpoFilePort: SyncContentObjectFilePort = {
  stageCopy: async (sourceUri, stagingToken) => {
    requireFileUri(sourceUri, '聊天附件');
    const source = new File(sourceUri);
    if (!source.exists) throw new Error('聊天附件文件不存在，不能进入同步对象库。');
    const { staging } = getSyncObjectExpoDirectories();
    const target = new File(staging, stagingToken);
    if (target.exists) {
      throw new Error('content-object stagingToken 已存在，拒绝覆盖暂存文件。');
    }
    source.copy(target);
    if (!target.exists) throw new Error('聊天附件暂存复制失败。');
    return target.uri;
  },

  readChunks: async function* (uri, maximumChunkBytes) {
    requireFileUri(uri, 'content-object 读取地址');
    if (
      !Number.isSafeInteger(maximumChunkBytes)
      || maximumChunkBytes < 1
      || maximumChunkBytes > 4 * 1024 * 1024
    ) {
      throw new Error('content-object maximumChunkBytes 无效。');
    }
    const file = new File(uri);
    if (!file.exists) throw new Error('content-object 文件不存在。');
    const handle = file.open();
    try {
      let remaining = handle.size;
      if (remaining === null) throw new Error('content-object 文件句柄已关闭。');
      while (remaining > 0) {
        const requested = Math.min(remaining, maximumChunkBytes);
        const chunk = handle.readBytes(requested);
        if (chunk.byteLength < 1 || chunk.byteLength > requested) {
          throw new Error('content-object 分段读取长度无效。');
        }
        remaining -= chunk.byteLength;
        yield chunk;
      }
    } finally {
      handle.close();
    }
  },

  scanContent: scanManagedSyncContentNative,

  promote: async (stagingUri, objectId) => {
    requireFileUri(stagingUri, 'content-object 暂存地址');
    assertSyncObjectId(objectId);
    const staged = new File(stagingUri);
    if (!staged.exists) throw new Error('content-object 暂存文件不存在。');
    const { objects } = getSyncObjectExpoDirectories();
    const target = new File(objects, objectId);
    if (target.exists) {
      staged.delete();
      return target.uri;
    }
    try {
      staged.move(target);
    } catch (error) {
      if (!target.exists) throw error;
      if (staged.exists) staged.delete();
    }
    return target.uri;
  },

  saveManifest: saveSyncObjectExpoManifest,

  discard: async (uri) => {
    requireFileUri(uri, 'content-object 清理地址');
    const file = new File(uri);
    if (file.exists) file.delete();
  },
};

export async function deleteSyncManagedObjectFile(
  objectId: string,
) {
  assertObjectId(objectId);
  const { objects } = getSyncObjectExpoDirectories();
  const target = new File(objects, objectId);
  const existed = target.exists;
  if (existed) target.delete();
  const manifest = manifestFiles(objectId);
  if (manifest.target.exists) manifest.target.delete();
  if (manifest.partial.exists) manifest.partial.delete();
  return existed;
}
