import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  Directory,
  File,
} from 'expo-file-system';

import type {
  AndroidSyncObjectFileStore,
} from './syncAndroidObjectTransferCore';
import {
  scanSyncContentObject,
} from './syncContentObjectCapture';
import {
  sealManagedSyncObjectChunkNative,
} from './syncAndroidObjectNativeChunkSealer';
import {
  bytesToBase64Url,
  canonicalizeJsonV1,
} from './syncCrypto';
import {
  assertSyncObjectId,
  deleteSyncManagedObjectFile,
  getSyncObjectExpoDirectories,
  loadSyncObjectExpoManifest,
  saveSyncObjectExpoManifest,
  syncObjectExpoFilePort,
} from './syncObjectExpoFilePort';
import {
  assertSealedSyncObjectManifestV1,
  assertSyncObjectIdMatchesManifestV1,
  assertSyncObjectManifestPlaintextV1,
  SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
  type SyncObjectManifestPlaintextV1,
} from './syncObjectProtocol';

function sameBytes(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function downloadDirectory(objectId: string) {
  assertSyncObjectId(objectId);
  const { staging } = getSyncObjectExpoDirectories();
  const directory = new Directory(staging, `download-${objectId}`);
  directory.create({ idempotent: true, intermediates: true });
  return directory;
}

function chunkFile(
  manifest: SyncObjectManifestPlaintextV1,
  chunkIndex: number,
) {
  assertSyncObjectManifestPlaintextV1(manifest);
  const descriptor = manifest.chunks[chunkIndex];
  if (!descriptor) throw new Error('object chunkIndex 不在 manifest 范围内。');
  return {
    descriptor,
    file: new File(
      downloadDirectory(manifest.objectId),
      `chunk-${chunkIndex}.bin`,
    ),
  };
}

async function atomicWriteBytes(input: {
  directory: Directory;
  name: string;
  value: Uint8Array;
  replaceDifferent: boolean;
}) {
  const target = new File(input.directory, input.name);
  if (target.exists) {
    const current = await target.bytes();
    if (sameBytes(current, input.value)) return target;
    if (!input.replaceDifferent) {
      throw new Error('同一受管对象路径已经保存了不同内容。');
    }
    target.delete();
  }
  const partial = new File(input.directory, `${input.name}.partial`);
  if (partial.exists) partial.delete();
  const temporaryUri = partial.uri;
  try {
    partial.create({ intermediates: true, overwrite: false });
    partial.write(input.value);
    partial.move(target);
    if (!target.exists) throw new Error('受管对象原子落盘失败。');
    return target;
  } finally {
    const leftover = new File(temporaryUri);
    if (leftover.exists) leftover.delete();
  }
}

async function atomicWriteJson(input: {
  directory: Directory;
  name: string;
  value: unknown;
  replaceDifferent: boolean;
}) {
  return atomicWriteBytes({
    ...input,
    value: new Uint8Array(Buffer.from(
      canonicalizeJsonV1(input.value),
      'utf8',
    )),
  });
}

async function verifiedChunk(
  manifest: SyncObjectManifestPlaintextV1,
  chunkIndex: number,
) {
  const { descriptor, file } = chunkFile(manifest, chunkIndex);
  if (!file.exists || file.size !== descriptor.plaintextBytes) {
    return false;
  }
  const content = await file.bytes();
  return bytesToBase64Url(sha256(content))
    === descriptor.plaintextSha256;
}

async function loadOrScanManagedManifest(input: {
  objectId: string;
  objectIdKey: Uint8Array;
  managed: File;
}) {
  let manifest = await loadSyncObjectExpoManifest(input.objectId);
  if (!manifest) {
    const scanned = await scanSyncContentObject(
      input.managed.uri,
      input.objectIdKey,
      syncObjectExpoFilePort,
    );
    if (scanned.objectId !== input.objectId) {
      throw new Error('受管本机对象内容与 objectId 不一致。');
    }
    manifest = scanned.manifest;
    await saveSyncObjectExpoManifest(
      input.managed.uri,
      manifest,
    );
  }
  assertSyncObjectIdMatchesManifestV1(
    manifest,
    input.objectIdKey,
  );
  if (input.managed.size !== manifest.plaintextBytes) {
    throw new Error('受管本机对象长度与 manifest 不一致。');
  }
  return manifest;
}

export class AndroidSyncObjectExpoStore
implements AndroidSyncObjectFileStore {
  async managedObjectExists(objectId: string) {
    assertSyncObjectId(objectId);
    const { objects } = getSyncObjectExpoDirectories();
    return new File(objects, objectId).exists;
  }

  async verifiedObjectUri(
    objectId: string,
    objectIdKey: Uint8Array,
  ) {
    assertSyncObjectId(objectId);
    const { objects } = getSyncObjectExpoDirectories();
    const target = new File(objects, objectId);
    if (!target.exists) return null;
    try {
      await loadOrScanManagedManifest({
        objectId,
        objectIdKey,
        managed: target,
      });
      return target.uri;
    } catch {
      return null;
    }
  }

  async scanUpload(input: {
    objectId: string;
    localUri: string;
    objectIdKey: Uint8Array;
  }) {
    assertSyncObjectId(input.objectId);
    const { objects } = getSyncObjectExpoDirectories();
    const managed = new File(objects, input.objectId);
    if (!managed.exists || managed.uri !== input.localUri) {
      throw new Error('object upload 来源不在受管对象库。');
    }
    return loadOrScanManagedManifest({
      objectId: input.objectId,
      objectIdKey: input.objectIdKey,
      managed,
    });
  }

  async readUploadChunk(input: {
    localUri: string;
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
  }) {
    assertSyncObjectManifestPlaintextV1(input.manifest);
    const descriptor = input.manifest.chunks[input.chunkIndex];
    if (!descriptor) throw new Error('object upload chunkIndex 越界。');
    const { objects } = getSyncObjectExpoDirectories();
    const managed = new File(objects, input.manifest.objectId);
    if (!managed.exists || managed.uri !== input.localUri) {
      throw new Error('object upload chunk 来源不在受管对象库。');
    }
    if (descriptor.plaintextBytes === 0) return new Uint8Array();
    const handle = managed.open();
    try {
      handle.offset = input.chunkIndex
        * SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES;
      const content = handle.readBytes(descriptor.plaintextBytes);
      if (
        content.byteLength !== descriptor.plaintextBytes
        || bytesToBase64Url(sha256(content))
          !== descriptor.plaintextSha256
      ) {
        throw new Error('object upload chunk 与 manifest 不一致。');
      }
      return content;
    } finally {
      handle.close();
    }
  }

  async sealUploadChunk(input: {
    localUri: string;
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
    identity: {
      vaultId: string;
      sourceDeviceId: string;
      keyId: string;
      objectEncryptionKey: Uint8Array;
      signingPrivateKey: Uint8Array;
    };
  }) {
    return sealManagedSyncObjectChunkNative(input);
  }

  async prepareDownload(input: {
    sealedManifest: Parameters<
      AndroidSyncObjectFileStore['prepareDownload']
    >[0]['sealedManifest'];
    manifest: SyncObjectManifestPlaintextV1;
  }) {
    assertSealedSyncObjectManifestV1(input.sealedManifest);
    assertSyncObjectManifestPlaintextV1(input.manifest);
    if (
      input.sealedManifest.objectId !== input.manifest.objectId
      || input.sealedManifest.totalChunks
        !== input.manifest.chunks.length
    ) {
      throw new Error('object download manifest 路由不一致。');
    }
    const directory = downloadDirectory(input.manifest.objectId);
    await atomicWriteJson({
      directory,
      name: 'manifest.plain.json',
      value: input.manifest,
      replaceDifferent: false,
    });
    await atomicWriteJson({
      directory,
      name: 'manifest.sealed.json',
      value: input.sealedManifest,
      replaceDifferent: true,
    });
    return {
      stagingUri: directory.uri,
      completedChunks: await this.completedDownloadChunks(
        input.manifest,
      ),
    };
  }

  hasVerifiedDownloadChunk(
    manifest: SyncObjectManifestPlaintextV1,
    chunkIndex: number,
  ) {
    return verifiedChunk(manifest, chunkIndex);
  }

  async saveVerifiedDownloadChunk(input: {
    manifest: SyncObjectManifestPlaintextV1;
    chunkIndex: number;
    plaintext: Uint8Array;
  }) {
    const { descriptor } = chunkFile(
      input.manifest,
      input.chunkIndex,
    );
    if (
      input.plaintext.byteLength !== descriptor.plaintextBytes
      || bytesToBase64Url(sha256(input.plaintext))
        !== descriptor.plaintextSha256
    ) {
      throw new Error('object download chunk 与 manifest 不一致。');
    }
    await atomicWriteBytes({
      directory: downloadDirectory(input.manifest.objectId),
      name: `chunk-${input.chunkIndex}.bin`,
      value: input.plaintext,
      replaceDifferent: true,
    });
  }

  async completedDownloadChunks(
    manifest: SyncObjectManifestPlaintextV1,
  ) {
    assertSyncObjectManifestPlaintextV1(manifest);
    let completed = 0;
    for (const descriptor of manifest.chunks) {
      if (await verifiedChunk(manifest, descriptor.chunkIndex)) {
        completed += 1;
      }
    }
    return completed;
  }

  async assembleVerifiedObject(
    manifest: SyncObjectManifestPlaintextV1,
    objectIdKey: Uint8Array,
  ) {
    assertSyncObjectManifestPlaintextV1(manifest);
    assertSyncObjectIdMatchesManifestV1(manifest, objectIdKey);
    const directory = downloadDirectory(manifest.objectId);
    const partial = new File(directory, 'content.partial');
    if (partial.exists) partial.delete();
    const temporaryUri = partial.uri;
    let handle: ReturnType<File['open']> | null = null;
    try {
      partial.create({ overwrite: false, intermediates: true });
      handle = partial.open();
      for (const descriptor of manifest.chunks) {
        const { file } = chunkFile(
          manifest,
          descriptor.chunkIndex,
        );
        if (!await verifiedChunk(manifest, descriptor.chunkIndex)) {
          throw new Error(
            `object chunk ${descriptor.chunkIndex} 尚未验证。`,
          );
        }
        handle.writeBytes(await file.bytes());
      }
      handle.close();
      handle = null;
      const scanned = await scanSyncContentObject(
        partial.uri,
        objectIdKey,
        syncObjectExpoFilePort,
      );
      if (
        scanned.objectId !== manifest.objectId
        || canonicalizeJsonV1(scanned.manifest)
          !== canonicalizeJsonV1(manifest)
      ) {
        throw new Error('组装后的 object 与 manifest 不一致。');
      }
      const { objects } = getSyncObjectExpoDirectories();
      const target = new File(objects, manifest.objectId);
      if (target.exists) {
        if (await this.verifiedObjectUri(
          manifest.objectId,
          objectIdKey,
        )) {
          partial.delete();
          return target.uri;
        }
        await deleteSyncManagedObjectFile(manifest.objectId);
      }
      partial.move(target);
      await saveSyncObjectExpoManifest(target.uri, manifest);
      const verified = await this.verifiedObjectUri(
        manifest.objectId,
        objectIdKey,
      );
      if (!verified) {
        throw new Error('object 原子晋升后的摘要校验失败。');
      }
      return verified;
    } finally {
      if (handle) handle.close();
      const leftover = new File(temporaryUri);
      if (leftover.exists) leftover.delete();
    }
  }
}

export const syncAndroidObjectExpoStore =
  new AndroidSyncObjectExpoStore();
