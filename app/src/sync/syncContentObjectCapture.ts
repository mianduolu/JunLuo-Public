import { sha256 } from '@noble/hashes/sha2.js';

import {
  base64UrlToBytes,
  bytesToBase64Url,
} from './syncCrypto';
import {
  assertSyncObjectManifestPlaintextV1,
  computeSyncObjectIdV1,
  SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
  type SyncObjectChunkDescriptorV1,
  type SyncObjectManifestPlaintextV1,
} from './syncObjectProtocol';

export interface SyncContentObjectFilePort {
  stageCopy(sourceUri: string, stagingToken: string): Promise<string>;
  scanContent?(
    uri: string,
    maximumChunkBytes: number,
  ): Promise<{
    plaintextBytes: number;
    plaintextSha256: string;
    chunks: SyncObjectChunkDescriptorV1[];
  }>;
  readChunks(
    uri: string,
    maximumChunkBytes: number,
  ): AsyncIterable<Uint8Array>;
  promote(stagingUri: string, objectId: string): Promise<string>;
  saveManifest(
    localUri: string,
    manifest: SyncObjectManifestPlaintextV1,
  ): Promise<void>;
  discard(uri: string): Promise<void>;
}

export interface SyncContentObjectJobPort {
  scheduleUpload(input: {
    objectId: string;
    keyId: string;
    totalChunks: number;
    localUri: string;
    now: number;
  }): Promise<void>;
}

export type SyncContentObjectScanResult = {
  objectId: string;
  manifest: SyncObjectManifestPlaintextV1;
};

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export async function scanSyncContentObject(
  uri: string,
  objectIdKey: Uint8Array,
  files: SyncContentObjectFilePort,
): Promise<SyncContentObjectScanResult> {
  if (files.scanContent) {
    const scanned = await files.scanContent(
      uri,
      SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
    );
    const objectId = computeSyncObjectIdV1(
      objectIdKey,
      base64UrlToBytes(
        scanned.plaintextSha256,
        'content-object plaintextSha256',
        32,
      ),
    );
    const manifest: SyncObjectManifestPlaintextV1 = {
      protocolVersion: 1,
      objectId,
      plaintextBytes: scanned.plaintextBytes,
      plaintextSha256: scanned.plaintextSha256,
      chunkBytes: SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
      chunks: scanned.chunks,
    };
    assertSyncObjectManifestPlaintextV1(manifest);
    return { objectId, manifest };
  }
  const whole = sha256.create();
  const chunks: SyncObjectChunkDescriptorV1[] = [];
  let plaintextBytes = 0;
  for await (const chunk of files.readChunks(
    uri,
    SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
  )) {
    expect(chunk instanceof Uint8Array, 'content-object 文件端口必须返回 Uint8Array。');
    expect(chunk.byteLength > 0, 'content-object 文件端口不能在 EOF 前返回空 chunk。');
    expect(
      chunk.byteLength <= SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
      'content-object 文件端口返回了超过 4 MiB 的 chunk。',
    );
    whole.update(chunk);
    chunks.push({
      chunkIndex: chunks.length,
      plaintextBytes: chunk.byteLength,
      plaintextSha256: bytesToBase64Url(sha256(chunk)),
    });
    plaintextBytes += chunk.byteLength;
  }
  if (!chunks.length) {
    chunks.push({
      chunkIndex: 0,
      plaintextBytes: 0,
      plaintextSha256: bytesToBase64Url(sha256(new Uint8Array())),
    });
  }
  const plaintextSha256 = whole.digest();
  const objectId = computeSyncObjectIdV1(objectIdKey, plaintextSha256);
  const manifest: SyncObjectManifestPlaintextV1 = {
    protocolVersion: 1,
    objectId,
    plaintextBytes,
    plaintextSha256: bytesToBase64Url(plaintextSha256),
    chunkBytes: SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES,
    chunks,
  };
  assertSyncObjectManifestPlaintextV1(manifest);
  return { objectId, manifest };
}

function sameManifest(
  left: SyncObjectManifestPlaintextV1,
  right: SyncObjectManifestPlaintextV1,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function captureSyncContentObject(input: {
  sourceUri: string;
  stagingToken: string;
  keyId: string;
  objectIdKey: Uint8Array;
  files: SyncContentObjectFilePort;
  jobs: SyncContentObjectJobPort;
  now: number;
}) {
  expect(!!input.sourceUri, 'content-object sourceUri 不能为空。');
  expect(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.stagingToken,
    ),
    'content-object stagingToken 必须是小写 UUID v4。',
  );
  expect(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      input.keyId,
    ),
    'content-object keyId 必须是小写 UUID v4。',
  );
  expect(
    Number.isSafeInteger(input.now) && input.now >= 0,
    'content-object now 必须是非负 Unix 毫秒整数。',
  );

  let stagingUri: string | null = await input.files.stageCopy(
    input.sourceUri,
    input.stagingToken,
  );
  try {
    const scanned = await scanSyncContentObject(
      stagingUri,
      input.objectIdKey,
      input.files,
    );
    const localUri = await input.files.promote(stagingUri, scanned.objectId);
    stagingUri = null;
    const verified = await scanSyncContentObject(
      localUri,
      input.objectIdKey,
      input.files,
    );
    expect(
      verified.objectId === scanned.objectId
        && sameManifest(verified.manifest, scanned.manifest),
      'content-object 原子落盘后的字节与暂存副本不一致。',
    );
    await input.files.saveManifest(localUri, verified.manifest);
    await input.jobs.scheduleUpload({
      objectId: scanned.objectId,
      keyId: input.keyId,
      totalChunks: scanned.manifest.chunks.length,
      localUri,
      now: input.now,
    });
    return {
      objectId: scanned.objectId,
      localUri,
      manifest: scanned.manifest,
    };
  } finally {
    if (stagingUri) await input.files.discard(stagingUri);
  }
}
