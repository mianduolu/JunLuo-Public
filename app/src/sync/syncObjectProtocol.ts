import { Buffer } from 'buffer';

import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  canonicalizeJsonV1,
  decryptXChaCha20Poly1305V1,
  deriveHkdfSha256V1,
  encryptXChaCha20Poly1305V1,
  equalBytesConstantTimeV1,
  hmacSha256V1,
  sha256BytesV1,
  signEd25519V1,
  verifyEd25519V1,
} from './syncCrypto';
import {
  assertBase64Url,
  SYNC_CIPHER_SUITE,
  SYNC_PROTOCOL_VERSION,
} from './syncProtocol';

export const SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES = 4 * 1024 * 1024;
export const SYNC_OBJECT_MAX_CHUNKS = 100_000;

const MANIFEST_ENCRYPTION_CONTEXT = 'junluo.sync.v1/object-manifest-encryption';
const CHUNK_ENCRYPTION_CONTEXT = 'junluo.sync.v1/object-chunk-encryption';
const MANIFEST_SIGNATURE_CONTEXT = 'junluo.sync.v1/object-manifest-signature';
const CHUNK_SIGNATURE_CONTEXT = 'junluo.sync.v1/object-chunk-signature';
const PART_KEY_INFO = new Uint8Array(Buffer.from('junluo.sync.v1/object-part-key', 'utf8'));
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SyncObjectChunkDescriptorV1 = {
  chunkIndex: number;
  plaintextBytes: number;
  plaintextSha256: string;
};

export type SyncObjectManifestPlaintextV1 = {
  protocolVersion: 1;
  objectId: string;
  plaintextBytes: number;
  plaintextSha256: string;
  chunkBytes: number;
  chunks: SyncObjectChunkDescriptorV1[];
};

export type SealedSyncObjectManifestV1 = {
  protocolVersion: 1;
  vaultId: string;
  sourceDeviceId: string;
  objectId: string;
  keyId: string;
  cipherSuite: typeof SYNC_CIPHER_SUITE;
  totalChunks: number;
  ciphertextBytes: number;
  nonce: string;
  ciphertext: string;
  signature: string;
};

export type SealedSyncObjectChunkV1 = {
  protocolVersion: 1;
  vaultId: string;
  sourceDeviceId: string;
  objectId: string;
  chunkIndex: number;
  keyId: string;
  nonce: string;
  ciphertext: string;
  ciphertextSha256: string;
  signature: string;
};

type SealIdentity = {
  vaultId: string;
  sourceDeviceId: string;
  keyId: string;
  objectEncryptionKey: Uint8Array;
  signingPrivateKey: Uint8Array;
};

type OpenIdentity = {
  objectEncryptionKey: Uint8Array;
  signingPublicKey: Uint8Array;
};

function fail(message: string): never {
  throw new Error(message);
}

function exactRecord(value: unknown, keys: readonly string[], label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} 必须是对象。`);
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (
    Object.keys(record).some((key) => !allowed.has(key))
    || keys.some((key) => !(key in record))
  ) {
    fail(`${label} 字段不符合 v1 合同。`);
  }
  return record;
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_V4.test(value)) {
    fail(`${label} 必须是小写 UUID v4。`);
  }
  return value;
}

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(`${label} 必须是大于等于 ${minimum} 的安全整数。`);
  }
  return value as number;
}

function encoded(
  value: unknown,
  label: string,
  options: { exactBytes?: number; minimumBytes?: number; maximumBytes?: number },
) {
  if (typeof value !== 'string') fail(`${label} 必须是字符串。`);
  assertBase64Url(value, label, {
    exactBytes: options.exactBytes,
    maximumBytes: options.maximumBytes,
  });
  const bytes = base64UrlToBytes(value, label, options.exactBytes);
  if (options.minimumBytes !== undefined && bytes.byteLength < options.minimumBytes) {
    fail(`${label} 少于 ${options.minimumBytes} bytes。`);
  }
  return value;
}

function bytes(value: Uint8Array, expected: number, label: string) {
  if (!(value instanceof Uint8Array) || value.byteLength !== expected) {
    fail(`${label} 必须正好是 ${expected} bytes。`);
  }
}

function ciphertextBytes(manifest: SyncObjectManifestPlaintextV1) {
  return manifest.chunks.reduce((sum, chunk) => sum + chunk.plaintextBytes + 16, 0);
}

export function computeSyncObjectIdV1(
  objectIdKey: Uint8Array,
  plaintextSha256: Uint8Array,
) {
  bytes(objectIdKey, 32, 'objectIdKey');
  bytes(plaintextSha256, 32, 'plaintextSha256');
  return bytesToBase64Url(hmacSha256V1(objectIdKey, plaintextSha256));
}

export function assertSyncObjectManifestPlaintextV1(
  value: unknown,
): asserts value is SyncObjectManifestPlaintextV1 {
  const record = exactRecord(
    value,
    [
      'protocolVersion',
      'objectId',
      'plaintextBytes',
      'plaintextSha256',
      'chunkBytes',
      'chunks',
    ],
    'object manifest plaintext',
  );
  if (record.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    fail('object manifest 协议版本不受支持。');
  }
  encoded(record.objectId, 'object manifest objectId', { exactBytes: 32 });
  const totalBytes = safeInteger(record.plaintextBytes, 'object manifest plaintextBytes');
  encoded(record.plaintextSha256, 'object manifest plaintextSha256', { exactBytes: 32 });
  if (record.chunkBytes !== SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES) {
    fail('object manifest chunkBytes 必须固定为 4 MiB。');
  }
  if (!Array.isArray(record.chunks)) fail('object manifest chunks 必须是数组。');
  const chunks = record.chunks;
  if (chunks.length < 1 || chunks.length > SYNC_OBJECT_MAX_CHUNKS) {
    fail('object manifest chunks 数量无效。');
  }
  let accumulated = 0;
  chunks.forEach((valueAtIndex, index) => {
    const chunk = exactRecord(
      valueAtIndex,
      ['chunkIndex', 'plaintextBytes', 'plaintextSha256'],
      `object manifest chunks[${index}]`,
    );
    if (chunk.chunkIndex !== index) fail(`object manifest chunks[${index}] 下标不连续。`);
    const length = safeInteger(
      chunk.plaintextBytes,
      `object manifest chunks[${index}].plaintextBytes`,
    );
    if (length > SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES) {
      fail(`object manifest chunks[${index}] 超过 4 MiB。`);
    }
    if (totalBytes === 0) {
      if (chunks.length !== 1 || length !== 0) fail('空对象必须恰好包含一个空 chunk。');
    } else {
      if (length === 0) fail(`object manifest chunks[${index}] 不能为空。`);
      if (index < chunks.length - 1 && length !== SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES) {
        fail(`object manifest chunks[${index}] 非末块必须正好 4 MiB。`);
      }
    }
    encoded(
      chunk.plaintextSha256,
      `object manifest chunks[${index}].plaintextSha256`,
      { exactBytes: 32 },
    );
    accumulated += length;
  });
  if (accumulated !== totalBytes) fail('object manifest 分块总长度不一致。');
}

export function assertSealedSyncObjectManifestV1(
  value: unknown,
): asserts value is SealedSyncObjectManifestV1 {
  const record = exactRecord(
    value,
    [
      'protocolVersion',
      'vaultId',
      'sourceDeviceId',
      'objectId',
      'keyId',
      'cipherSuite',
      'totalChunks',
      'ciphertextBytes',
      'nonce',
      'ciphertext',
      'signature',
    ],
    'sealed object manifest',
  );
  if (record.protocolVersion !== SYNC_PROTOCOL_VERSION) fail('sealed object manifest 版本无效。');
  uuid(record.vaultId, 'sealed object manifest vaultId');
  uuid(record.sourceDeviceId, 'sealed object manifest sourceDeviceId');
  encoded(record.objectId, 'sealed object manifest objectId', { exactBytes: 32 });
  uuid(record.keyId, 'sealed object manifest keyId');
  if (record.cipherSuite !== SYNC_CIPHER_SUITE) fail('sealed object manifest cipherSuite 无效。');
  const totalChunks = safeInteger(record.totalChunks, 'sealed object manifest totalChunks', 1);
  if (totalChunks > SYNC_OBJECT_MAX_CHUNKS) fail('sealed object manifest totalChunks 超出上限。');
  safeInteger(record.ciphertextBytes, 'sealed object manifest ciphertextBytes', 1);
  encoded(record.nonce, 'sealed object manifest nonce', { exactBytes: 24 });
  encoded(record.ciphertext, 'sealed object manifest ciphertext', {
    minimumBytes: 17,
    maximumBytes: 64 * 1024,
  });
  encoded(record.signature, 'sealed object manifest signature', { exactBytes: 64 });
}

export function assertSealedSyncObjectChunkV1(
  value: unknown,
): asserts value is SealedSyncObjectChunkV1 {
  const record = exactRecord(
    value,
    [
      'protocolVersion',
      'vaultId',
      'sourceDeviceId',
      'objectId',
      'chunkIndex',
      'keyId',
      'nonce',
      'ciphertext',
      'ciphertextSha256',
      'signature',
    ],
    'sealed object chunk',
  );
  if (record.protocolVersion !== SYNC_PROTOCOL_VERSION) fail('sealed object chunk 版本无效。');
  uuid(record.vaultId, 'sealed object chunk vaultId');
  uuid(record.sourceDeviceId, 'sealed object chunk sourceDeviceId');
  encoded(record.objectId, 'sealed object chunk objectId', { exactBytes: 32 });
  const chunkIndex = safeInteger(record.chunkIndex, 'sealed object chunk chunkIndex');
  if (chunkIndex >= SYNC_OBJECT_MAX_CHUNKS) fail('sealed object chunk chunkIndex 超出上限。');
  uuid(record.keyId, 'sealed object chunk keyId');
  encoded(record.nonce, 'sealed object chunk nonce', { exactBytes: 24 });
  encoded(record.ciphertext, 'sealed object chunk ciphertext', {
    minimumBytes: 16,
    maximumBytes: SYNC_OBJECT_PLAINTEXT_CHUNK_BYTES + 16,
  });
  encoded(record.ciphertextSha256, 'sealed object chunk ciphertextSha256', { exactBytes: 32 });
  encoded(record.signature, 'sealed object chunk signature', { exactBytes: 64 });
}

function route(input: {
  vaultId: string;
  objectId: string;
  keyId: string;
  part: 'manifest' | 'chunk';
  chunkIndex?: number;
}) {
  return {
    context: 'junluo.sync.v1/object-part-routing',
    protocolVersion: SYNC_PROTOCOL_VERSION,
    vaultId: input.vaultId,
    objectId: input.objectId,
    keyId: input.keyId,
    part: input.part,
    ...(input.part === 'chunk' ? { chunkIndex: input.chunkIndex } : {}),
  };
}

function partKeyAndNonce(
  objectEncryptionKey: Uint8Array,
  routing: ReturnType<typeof route>,
) {
  bytes(objectEncryptionKey, 32, 'objectEncryptionKey');
  const key = deriveHkdfSha256V1(
    objectEncryptionKey,
    sha256BytesV1(canonicalizeJsonBytesV1(routing)),
    PART_KEY_INFO,
    32,
  );
  return {
    key,
    nonce: hmacSha256V1(
      key,
      canonicalizeJsonBytesV1({
        context: 'junluo.sync.v1/object-part-nonce',
        routing,
      }),
    ).slice(0, 24),
  };
}

function manifestAad(input: {
  vaultId: string;
  objectId: string;
  keyId: string;
  totalChunks: number;
  ciphertextBytes: number;
}) {
  return canonicalizeJsonBytesV1({
    context: MANIFEST_ENCRYPTION_CONTEXT,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    cipherSuite: SYNC_CIPHER_SUITE,
    ...input,
  });
}

function chunkAad(input: {
  vaultId: string;
  objectId: string;
  chunkIndex: number;
  keyId: string;
}) {
  return canonicalizeJsonBytesV1({
    context: CHUNK_ENCRYPTION_CONTEXT,
    protocolVersion: SYNC_PROTOCOL_VERSION,
    ...input,
  });
}

function signManifest(
  manifest: Omit<SealedSyncObjectManifestV1, 'signature'>,
  privateKey: Uint8Array,
) {
  return bytesToBase64Url(signEd25519V1(
    canonicalizeJsonBytesV1({ context: MANIFEST_SIGNATURE_CONTEXT, manifest }),
    privateKey,
  ));
}

function signChunk(
  chunk: Omit<SealedSyncObjectChunkV1, 'signature'>,
  privateKey: Uint8Array,
) {
  return bytesToBase64Url(signEd25519V1(
    canonicalizeJsonBytesV1({ context: CHUNK_SIGNATURE_CONTEXT, chunk }),
    privateKey,
  ));
}

export function sealSyncObjectManifestV1(
  manifest: SyncObjectManifestPlaintextV1,
  identity: SealIdentity,
) {
  assertSyncObjectManifestPlaintextV1(manifest);
  uuid(identity.vaultId, 'object seal vaultId');
  uuid(identity.sourceDeviceId, 'object seal sourceDeviceId');
  uuid(identity.keyId, 'object seal keyId');
  bytes(identity.signingPrivateKey, 32, 'object seal signingPrivateKey');
  const plaintext = new Uint8Array(Buffer.from(canonicalizeJsonV1(manifest), 'utf8'));
  if (plaintext.byteLength > 48 * 1024) fail('object manifest plaintext 超过 48 KiB。');
  const totalEncryptedBytes = ciphertextBytes(manifest);
  const routing = route({
    vaultId: identity.vaultId,
    objectId: manifest.objectId,
    keyId: identity.keyId,
    part: 'manifest',
  });
  const { key, nonce } = partKeyAndNonce(identity.objectEncryptionKey, routing);
  const encrypted = encryptXChaCha20Poly1305V1(
    plaintext,
    key,
    nonce,
    manifestAad({
      vaultId: identity.vaultId,
      objectId: manifest.objectId,
      keyId: identity.keyId,
      totalChunks: manifest.chunks.length,
      ciphertextBytes: totalEncryptedBytes,
    }),
  );
  const unsigned: Omit<SealedSyncObjectManifestV1, 'signature'> = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    vaultId: identity.vaultId,
    sourceDeviceId: identity.sourceDeviceId,
    objectId: manifest.objectId,
    keyId: identity.keyId,
    cipherSuite: SYNC_CIPHER_SUITE,
    totalChunks: manifest.chunks.length,
    ciphertextBytes: totalEncryptedBytes,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(encrypted),
  };
  const sealed: SealedSyncObjectManifestV1 = {
    ...unsigned,
    signature: signManifest(unsigned, identity.signingPrivateKey),
  };
  assertSealedSyncObjectManifestV1(sealed);
  return sealed;
}

export function openSyncObjectManifestV1(
  sealed: SealedSyncObjectManifestV1,
  identity: OpenIdentity,
) {
  assertSealedSyncObjectManifestV1(sealed);
  bytes(identity.signingPublicKey, 32, 'object manifest signingPublicKey');
  const { signature, ...unsigned } = sealed;
  if (!verifyEd25519V1(
    base64UrlToBytes(signature, 'object manifest signature', 64),
    canonicalizeJsonBytesV1({ context: MANIFEST_SIGNATURE_CONTEXT, manifest: unsigned }),
    identity.signingPublicKey,
  )) {
    fail('object manifest 签名验证失败。');
  }
  const routing = route({
    vaultId: sealed.vaultId,
    objectId: sealed.objectId,
    keyId: sealed.keyId,
    part: 'manifest',
  });
  const { key, nonce } = partKeyAndNonce(identity.objectEncryptionKey, routing);
  if (!equalBytesConstantTimeV1(
    nonce,
    base64UrlToBytes(sealed.nonce, 'object manifest nonce', 24),
  )) {
    fail('object manifest nonce 与确定性合同不一致。');
  }
  const plaintext = decryptXChaCha20Poly1305V1(
    base64UrlToBytes(sealed.ciphertext, 'object manifest ciphertext'),
    key,
    nonce,
    manifestAad({
      vaultId: sealed.vaultId,
      objectId: sealed.objectId,
      keyId: sealed.keyId,
      totalChunks: sealed.totalChunks,
      ciphertextBytes: sealed.ciphertextBytes,
    }),
  );
  const text = Buffer.from(plaintext).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('object manifest plaintext 不是有效 JSON。');
  }
  assertSyncObjectManifestPlaintextV1(parsed);
  if (canonicalizeJsonV1(parsed) !== text) fail('object manifest plaintext 不是 RFC 8785 正规 JSON。');
  if (parsed.objectId !== sealed.objectId) fail('object manifest objectId 与路由不一致。');
  if (parsed.chunks.length !== sealed.totalChunks) fail('object manifest totalChunks 与路由不一致。');
  if (ciphertextBytes(parsed) !== sealed.ciphertextBytes) {
    fail('object manifest ciphertextBytes 与明文描述不一致。');
  }
  return parsed;
}

export function sealSyncObjectChunkV1(input: {
  manifest: SyncObjectManifestPlaintextV1;
  chunkIndex: number;
  plaintext: Uint8Array;
  identity: SealIdentity;
}) {
  assertSyncObjectManifestPlaintextV1(input.manifest);
  const descriptor = input.manifest.chunks[input.chunkIndex];
  if (!descriptor) fail('object chunkIndex 不在 manifest 范围内。');
  if (input.plaintext.byteLength !== descriptor.plaintextBytes) {
    fail('object chunk plaintextBytes 与 manifest 不一致。');
  }
  if (bytesToBase64Url(sha256BytesV1(input.plaintext)) !== descriptor.plaintextSha256) {
    fail('object chunk plaintextSha256 与 manifest 不一致。');
  }
  uuid(input.identity.vaultId, 'object chunk vaultId');
  uuid(input.identity.sourceDeviceId, 'object chunk sourceDeviceId');
  uuid(input.identity.keyId, 'object chunk keyId');
  bytes(input.identity.signingPrivateKey, 32, 'object chunk signingPrivateKey');
  const routing = route({
    vaultId: input.identity.vaultId,
    objectId: input.manifest.objectId,
    keyId: input.identity.keyId,
    part: 'chunk',
    chunkIndex: input.chunkIndex,
  });
  const { key, nonce } = partKeyAndNonce(input.identity.objectEncryptionKey, routing);
  const encrypted = encryptXChaCha20Poly1305V1(
    input.plaintext,
    key,
    nonce,
    chunkAad({
      vaultId: input.identity.vaultId,
      objectId: input.manifest.objectId,
      chunkIndex: input.chunkIndex,
      keyId: input.identity.keyId,
    }),
  );
  const unsigned: Omit<SealedSyncObjectChunkV1, 'signature'> = {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    vaultId: input.identity.vaultId,
    sourceDeviceId: input.identity.sourceDeviceId,
    objectId: input.manifest.objectId,
    chunkIndex: input.chunkIndex,
    keyId: input.identity.keyId,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(encrypted),
    ciphertextSha256: bytesToBase64Url(sha256BytesV1(encrypted)),
  };
  const sealed: SealedSyncObjectChunkV1 = {
    ...unsigned,
    signature: signChunk(unsigned, input.identity.signingPrivateKey),
  };
  assertSealedSyncObjectChunkV1(sealed);
  return sealed;
}

export function openSyncObjectChunkV1(input: {
  manifest: SyncObjectManifestPlaintextV1;
  sealed: SealedSyncObjectChunkV1;
  identity: OpenIdentity;
}) {
  assertSyncObjectManifestPlaintextV1(input.manifest);
  assertSealedSyncObjectChunkV1(input.sealed);
  bytes(input.identity.signingPublicKey, 32, 'object chunk signingPublicKey');
  if (input.sealed.objectId !== input.manifest.objectId) {
    fail('object chunk objectId 与 manifest 不一致。');
  }
  const descriptor = input.manifest.chunks[input.sealed.chunkIndex];
  if (!descriptor) fail('object chunkIndex 不在 manifest 范围内。');
  const { signature, ...unsigned } = input.sealed;
  if (!verifyEd25519V1(
    base64UrlToBytes(signature, 'object chunk signature', 64),
    canonicalizeJsonBytesV1({ context: CHUNK_SIGNATURE_CONTEXT, chunk: unsigned }),
    input.identity.signingPublicKey,
  )) {
    fail('object chunk 签名验证失败。');
  }
  const encrypted = base64UrlToBytes(input.sealed.ciphertext, 'object chunk ciphertext');
  if (bytesToBase64Url(sha256BytesV1(encrypted)) !== input.sealed.ciphertextSha256) {
    fail('object chunk ciphertextSha256 不一致。');
  }
  const routing = route({
    vaultId: input.sealed.vaultId,
    objectId: input.sealed.objectId,
    keyId: input.sealed.keyId,
    part: 'chunk',
    chunkIndex: input.sealed.chunkIndex,
  });
  const { key, nonce } = partKeyAndNonce(input.identity.objectEncryptionKey, routing);
  if (!equalBytesConstantTimeV1(
    nonce,
    base64UrlToBytes(input.sealed.nonce, 'object chunk nonce', 24),
  )) {
    fail('object chunk nonce 与确定性合同不一致。');
  }
  const plaintext = decryptXChaCha20Poly1305V1(
    encrypted,
    key,
    nonce,
    chunkAad({
      vaultId: input.sealed.vaultId,
      objectId: input.sealed.objectId,
      chunkIndex: input.sealed.chunkIndex,
      keyId: input.sealed.keyId,
    }),
  );
  if (plaintext.byteLength !== descriptor.plaintextBytes) {
    fail('object chunk 解密长度与 manifest 不一致。');
  }
  if (bytesToBase64Url(sha256BytesV1(plaintext)) !== descriptor.plaintextSha256) {
    fail('object chunk 解密 SHA-256 与 manifest 不一致。');
  }
  return plaintext;
}

export function assertSyncObjectIdMatchesManifestV1(
  manifest: SyncObjectManifestPlaintextV1,
  objectIdKey: Uint8Array,
) {
  assertSyncObjectManifestPlaintextV1(manifest);
  const expected = computeSyncObjectIdV1(
    objectIdKey,
    base64UrlToBytes(manifest.plaintextSha256, 'object plaintextSha256', 32),
  );
  if (expected !== manifest.objectId) fail('objectId 与 keyed plaintext SHA-256 不一致。');
}
