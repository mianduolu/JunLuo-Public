import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import canonicalize from 'canonicalize';
import {
  base64UrlToBytes,
  bytesToBase64Url,
} from './syncBase64Url';
import {
  assertBase64Url,
  assertPlainMutationV1,
  assertSealedChangeV1,
  SYNC_CIPHER_SUITE,
  SYNC_PROTOCOL_VERSION,
  type PlainMutationV1,
  type SealedChangeV1,
  type SyncCryptoPort,
} from './syncProtocol';

export {
  base64UrlToBytes,
  bytesToBase64Url,
};

const HKDF_SALT_V1 = utf8Bytes('junluo.sync.hkdf-sha256.v1');
const SIGNATURE_CONTEXT_V1 = 'junluo.sync.v1/sealed-change-signature';
const PAIRING_WRAP_INFO_V1 = utf8Bytes('junluo.sync.v1/pairing-wrap');

export const SYNC_CRYPTO_LIBRARY_VERSIONS_V1 = Object.freeze({
  canonicalize: '3.0.0',
  nobleCiphers: '2.2.0',
  nobleCurves: '2.2.0',
  nobleHashes: '2.2.0',
});

export const SYNC_VAULT_KEY_INFO_V1 = Object.freeze({
  changeEncryptionKey: 'junluo.sync.v1/change-encryption',
  objectEncryptionKey: 'junluo.sync.v1/object-encryption',
  objectIdKey: 'junluo.sync.v1/object-id',
  secretVaultKey: 'junluo.sync.v1/secret-vault',
  recoveryAuthorizationKey: 'junluo.sync.v1/recovery-authorization',
});

export type SyncVaultKeysV1 = {
  changeEncryptionKey: Uint8Array;
  objectEncryptionKey: Uint8Array;
  objectIdKey: Uint8Array;
  secretVaultKey: Uint8Array;
  recoveryAuthorizationKey: Uint8Array;
};

export type SyncRoutingHeaderV1 = Pick<
  SealedChangeV1,
  | 'protocolVersion'
  | 'vaultId'
  | 'sourceDeviceId'
  | 'sourceSequence'
  | 'mutationId'
  | 'requestId'
  | 'createdAt'
  | 'keyId'
  | 'cipherSuite'
>;

export type SyncCryptoPortConfigV1 = {
  vaultId: string;
  deviceId: string;
  keyId: string;
  vaultRootSecret: string;
  signingPrivateKey: string;
  randomBytes: (length: number) => Uint8Array | Promise<Uint8Array>;
  resolveSigningPublicKey: (
    sourceDeviceId: string,
    keyId: string,
  ) => string | Promise<string>;
};

function assertBytes(value: Uint8Array, expectedLength: number, label: string) {
  if (!(value instanceof Uint8Array) || value.byteLength !== expectedLength) {
    throw new Error(`${label} 必须正好是 ${expectedLength} bytes。`);
  }
}

function utf8Bytes(value: string) {
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

function utf8Text(value: Uint8Array) {
  return Buffer.from(value).toString('utf8');
}

export function bytesToHex(value: Uint8Array) {
  return Buffer.from(value).toString('hex');
}

export function hexToBytes(value: string, label = 'hex') {
  if (!/^(?:[0-9a-f]{2})+$/i.test(value)) {
    throw new Error(`${label} 必须是偶数长度十六进制。`);
  }
  return new Uint8Array(Buffer.from(value, 'hex'));
}

export function canonicalizeJsonV1(value: unknown) {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new Error('RFC 8785 规范化失败：输入不是可规范化 JSON。');
  }
  return result;
}

export function canonicalizeJsonBytesV1(value: unknown) {
  return utf8Bytes(canonicalizeJsonV1(value));
}

export function sha256BytesV1(message: Uint8Array) {
  return sha256(message);
}

export function hmacSha256V1(key: Uint8Array, message: Uint8Array) {
  return hmac(sha256, key, message);
}

export function equalBytesConstantTimeV1(left: Uint8Array, right: Uint8Array) {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}

export function deriveHkdfSha256V1(
  inputKeyMaterial: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
) {
  return hkdf(sha256, inputKeyMaterial, salt, info, length);
}

export function deriveSyncVaultKeysV1(vaultRootSecret: Uint8Array): SyncVaultKeysV1 {
  assertBytes(vaultRootSecret, 32, 'vaultRootSecret');
  const derive = (info: string) => deriveHkdfSha256V1(
    vaultRootSecret,
    HKDF_SALT_V1,
    utf8Bytes(info),
    32,
  );
  return {
    changeEncryptionKey: derive(SYNC_VAULT_KEY_INFO_V1.changeEncryptionKey),
    objectEncryptionKey: derive(SYNC_VAULT_KEY_INFO_V1.objectEncryptionKey),
    objectIdKey: derive(SYNC_VAULT_KEY_INFO_V1.objectIdKey),
    secretVaultKey: derive(SYNC_VAULT_KEY_INFO_V1.secretVaultKey),
    recoveryAuthorizationKey: derive(
      SYNC_VAULT_KEY_INFO_V1.recoveryAuthorizationKey,
    ),
  };
}

export function encryptXChaCha20Poly1305V1(
  plaintext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array,
) {
  assertBytes(key, 32, 'XChaCha20-Poly1305 key');
  assertBytes(nonce, 24, 'XChaCha20-Poly1305 nonce');
  return xchacha20poly1305(key, nonce, associatedData).encrypt(plaintext);
}

export function decryptXChaCha20Poly1305V1(
  ciphertext: Uint8Array,
  key: Uint8Array,
  nonce: Uint8Array,
  associatedData: Uint8Array,
) {
  assertBytes(key, 32, 'XChaCha20-Poly1305 key');
  assertBytes(nonce, 24, 'XChaCha20-Poly1305 nonce');
  return xchacha20poly1305(key, nonce, associatedData).decrypt(ciphertext);
}

export function signingPublicKeyFromPrivateV1(signingPrivateKey: Uint8Array) {
  assertBytes(signingPrivateKey, 32, 'Ed25519 private key seed');
  return ed25519.getPublicKey(signingPrivateKey);
}

export function signEd25519V1(message: Uint8Array, signingPrivateKey: Uint8Array) {
  assertBytes(signingPrivateKey, 32, 'Ed25519 private key seed');
  return ed25519.sign(message, signingPrivateKey);
}

export function verifyEd25519V1(
  signature: Uint8Array,
  message: Uint8Array,
  signingPublicKey: Uint8Array,
) {
  assertBytes(signature, 64, 'Ed25519 signature');
  assertBytes(signingPublicKey, 32, 'Ed25519 public key');
  return ed25519.verify(signature, message, signingPublicKey, { zip215: false });
}

export function exchangePublicKeyFromPrivateV1(exchangePrivateKey: Uint8Array) {
  assertBytes(exchangePrivateKey, 32, 'X25519 private key');
  return x25519.getPublicKey(exchangePrivateKey);
}

export function deriveX25519SharedSecretV1(
  exchangePrivateKey: Uint8Array,
  peerExchangePublicKey: Uint8Array,
) {
  assertBytes(exchangePrivateKey, 32, 'X25519 private key');
  assertBytes(peerExchangePublicKey, 32, 'X25519 peer public key');
  return x25519.getSharedSecret(exchangePrivateKey, peerExchangePublicKey);
}

export function derivePairingWrapKeyV1(
  exchangePrivateKey: Uint8Array,
  peerExchangePublicKey: Uint8Array,
  canonicalPairingTranscript: Uint8Array,
) {
  if (canonicalPairingTranscript.byteLength === 0) {
    throw new Error('配对 transcript 不能为空。');
  }
  const sharedSecret = deriveX25519SharedSecretV1(
    exchangePrivateKey,
    peerExchangePublicKey,
  );
  return deriveHkdfSha256V1(
    sharedSecret,
    sha256(canonicalPairingTranscript),
    PAIRING_WRAP_INFO_V1,
    32,
  );
}

export function routingHeaderFromMutationV1(
  mutation: PlainMutationV1,
  requestId: string,
  keyId: string,
): SyncRoutingHeaderV1 {
  return {
    protocolVersion: SYNC_PROTOCOL_VERSION,
    vaultId: mutation.vaultId,
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    mutationId: mutation.mutationId,
    requestId,
    createdAt: mutation.createdAt,
    keyId,
    cipherSuite: SYNC_CIPHER_SUITE,
  };
}

export function routingHeaderFromSealedChangeV1(
  change: SealedChangeV1,
): SyncRoutingHeaderV1 {
  return {
    protocolVersion: change.protocolVersion,
    vaultId: change.vaultId,
    sourceDeviceId: change.sourceDeviceId,
    sourceSequence: change.sourceSequence,
    mutationId: change.mutationId,
    requestId: change.requestId,
    createdAt: change.createdAt,
    keyId: change.keyId,
    cipherSuite: change.cipherSuite,
  };
}

export function sealedChangeSignatureInputV1(
  header: SyncRoutingHeaderV1,
  nonce: string,
  ciphertext: string,
) {
  return canonicalizeJsonBytesV1({
    context: SIGNATURE_CONTEXT_V1,
    header,
    nonce,
    ciphertext,
  });
}

function assertMutationMatchesHeader(
  mutation: PlainMutationV1,
  header: SyncRoutingHeaderV1,
) {
  if (
    mutation.protocolVersion !== header.protocolVersion
    || mutation.vaultId !== header.vaultId
    || mutation.sourceDeviceId !== header.sourceDeviceId
    || mutation.sourceSequence !== header.sourceSequence
    || mutation.mutationId !== header.mutationId
    || mutation.createdAt !== header.createdAt
  ) {
    throw new Error('解密后的 mutation 与已认证路由头不一致。');
  }
}

export function createSyncCryptoPortV1(
  config: SyncCryptoPortConfigV1,
): SyncCryptoPort {
  const vaultRootSecret = base64UrlToBytes(
    config.vaultRootSecret,
    'vaultRootSecret',
    32,
  );
  const signingPrivateKey = base64UrlToBytes(
    config.signingPrivateKey,
    'signingPrivateKey',
    32,
  );
  const { changeEncryptionKey } = deriveSyncVaultKeysV1(vaultRootSecret);

  return {
    async sealChange(mutation, requestId) {
      assertPlainMutationV1(mutation);
      if (
        mutation.vaultId !== config.vaultId
        || mutation.sourceDeviceId !== config.deviceId
      ) {
        throw new Error('本地 mutation 不属于当前 vault/device，拒绝签名。');
      }
      const header = routingHeaderFromMutationV1(mutation, requestId, config.keyId);
      const nonceBytes = await config.randomBytes(24);
      assertBytes(nonceBytes, 24, 'CSPRNG nonce');
      const nonce = bytesToBase64Url(nonceBytes);
      const ciphertext = bytesToBase64Url(encryptXChaCha20Poly1305V1(
        canonicalizeJsonBytesV1(mutation),
        changeEncryptionKey,
        nonceBytes,
        canonicalizeJsonBytesV1(header),
      ));
      const signature = bytesToBase64Url(signEd25519V1(
        sealedChangeSignatureInputV1(header, nonce, ciphertext),
        signingPrivateKey,
      ));
      const sealedChange: SealedChangeV1 = {
        ...header,
        nonce,
        ciphertext,
        signature,
      };
      assertSealedChangeV1(sealedChange);
      return sealedChange;
    },

    async openChange(change) {
      assertSealedChangeV1(change);
      if (change.vaultId !== config.vaultId || change.keyId !== config.keyId) {
        throw new Error('密文不属于当前 vault/key，等待正确密钥后再处理。');
      }
      const header = routingHeaderFromSealedChangeV1(change);
      const signingPublicKey = base64UrlToBytes(
        await config.resolveSigningPublicKey(change.sourceDeviceId, change.keyId),
        'signingPublicKey',
        32,
      );
      const signatureValid = verifyEd25519V1(
        base64UrlToBytes(change.signature, 'signature', 64),
        sealedChangeSignatureInputV1(header, change.nonce, change.ciphertext),
        signingPublicKey,
      );
      if (!signatureValid) {
        throw new Error('密文签名验证失败，已停止解密。');
      }
      const plaintext = decryptXChaCha20Poly1305V1(
        base64UrlToBytes(change.ciphertext, 'ciphertext'),
        changeEncryptionKey,
        base64UrlToBytes(change.nonce, 'nonce', 24),
        canonicalizeJsonBytesV1(header),
      );
      let mutation: unknown;
      try {
        mutation = JSON.parse(utf8Text(plaintext));
      } catch {
        throw new Error('解密后的 mutation 不是有效 JSON。');
      }
      assertPlainMutationV1(mutation);
      assertMutationMatchesHeader(mutation, header);
      return mutation;
    },
  };
}
