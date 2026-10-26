import { Buffer } from 'buffer';

import {
  assertVaultSharedSecretRecordV1,
  assertWrappedVaultSharedSecretV1,
  VAULT_SHARED_SECRETS_ADAPTER_ID,
  VAULT_SHARED_SECRET_MAX_BYTES,
  type VaultSharedSecretRecordV1,
} from './syncVaultSharedSecrets';
import type {
  VaultSharedSecretDefinition,
} from './syncVaultSharedSecretRegistry';
import type { SyncDeviceSecretsV1 } from './syncDeviceContract';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  decryptXChaCha20Poly1305V1,
  deriveSyncVaultKeysV1,
  encryptXChaCha20Poly1305V1,
  hmacSha256V1,
} from './syncCrypto';

const CONTENT_KEY_CONTEXT =
  'junluo.sync.v1/vault-shared-secret-content-key';
const SECRET_CONTEXT =
  'junluo.sync.v1/vault-shared-secret-value';
const VALUE_TAG_CONTEXT =
  'junluo.sync.v1/vault-shared-secret-value-tag';

export type VaultSharedSecretRandomBytes = (
  length: number,
) => Uint8Array | Promise<Uint8Array>;

function utf8Bytes(value: string) {
  return new Uint8Array(Buffer.from(value, 'utf8'));
}

function utf8Text(value: Uint8Array) {
  return Buffer.from(value).toString('utf8');
}

function assertSecretValue(value: string) {
  const length = Buffer.byteLength(value, 'utf8');
  if (!value || length > VAULT_SHARED_SECRET_MAX_BYTES) {
    throw new Error(
      `shared secret 必须是 1–${VAULT_SHARED_SECRET_MAX_BYTES} bytes。`,
    );
  }
}

async function randomBytesExact(
  source: VaultSharedSecretRandomBytes,
  length: number,
  label: string,
) {
  const value = await source(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} 必须由 CSPRNG 返回正好 ${length} bytes。`);
  }
  return value;
}

function associatedData(input: {
  context: string;
  definition: VaultSharedSecretDefinition;
  keyId: string;
}) {
  return canonicalizeJsonBytesV1({
    context: input.context,
    version: 1,
    adapterId: VAULT_SHARED_SECRETS_ADAPTER_ID,
    secretId: input.definition.secretId,
    credentialType: input.definition.credentialType,
    serviceId: input.definition.serviceId,
    keyId: input.keyId,
  });
}

function clearVaultKeys(
  keys: ReturnType<typeof deriveSyncVaultKeysV1>,
) {
  Object.values(keys).forEach((key) => key.fill(0));
}

export async function wrapVaultSharedSecretV1(input: {
  definition: VaultSharedSecretDefinition;
  secretValue: string;
  deviceSecrets: SyncDeviceSecretsV1;
  randomBytes: VaultSharedSecretRandomBytes;
  updatedAt: number;
}): Promise<VaultSharedSecretRecordV1> {
  assertSecretValue(input.secretValue);
  const vaultRootSecret = base64UrlToBytes(
    input.deviceSecrets.vaultRootSecret,
    'vaultRootSecret',
    32,
  );
  const keys = deriveSyncVaultKeysV1(vaultRootSecret);
  const contentKey = await randomBytesExact(
    input.randomBytes,
    32,
    'shared secret content key',
  );
  const contentKeyNonce = await randomBytesExact(
    input.randomBytes,
    24,
    'shared secret content key nonce',
  );
  const secretNonce = await randomBytesExact(
    input.randomBytes,
    24,
    'shared secret nonce',
  );
  const plaintext = utf8Bytes(input.secretValue);
  try {
    const wrappedContentKey = encryptXChaCha20Poly1305V1(
      contentKey,
      keys.secretVaultKey,
      contentKeyNonce,
      associatedData({
        context: CONTENT_KEY_CONTEXT,
        definition: input.definition,
        keyId: input.deviceSecrets.keyId,
      }),
    );
    const secretCiphertext = encryptXChaCha20Poly1305V1(
      plaintext,
      contentKey,
      secretNonce,
      associatedData({
        context: SECRET_CONTEXT,
        definition: input.definition,
        keyId: input.deviceSecrets.keyId,
      }),
    );
    const valueTag = hmacSha256V1(
      keys.secretVaultKey,
      canonicalizeJsonBytesV1({
        context: VALUE_TAG_CONTEXT,
        version: 1,
        secretId: input.definition.secretId,
        credentialType: input.definition.credentialType,
        secretValue: input.secretValue,
      }),
    ).slice(0, 16);
    const record: VaultSharedSecretRecordV1 = {
      secretId: input.definition.secretId,
      credentialType: input.definition.credentialType,
      serviceId: input.definition.serviceId,
      portability: 'shared',
      wrappedSecret: {
        version: 1,
        keyId: input.deviceSecrets.keyId,
        contentKeyNonce: bytesToBase64Url(contentKeyNonce),
        wrappedContentKey: bytesToBase64Url(wrappedContentKey),
        secretNonce: bytesToBase64Url(secretNonce),
        secretCiphertext: bytesToBase64Url(secretCiphertext),
        valueTag: bytesToBase64Url(valueTag),
      },
      updatedAt: input.updatedAt,
    };
    assertVaultSharedSecretRecordV1(record);
    return record;
  } finally {
    plaintext.fill(0);
    contentKey.fill(0);
    vaultRootSecret.fill(0);
    clearVaultKeys(keys);
  }
}

export function unwrapVaultSharedSecretV1(input: {
  record: VaultSharedSecretRecordV1;
  definition: VaultSharedSecretDefinition;
  deviceSecrets: SyncDeviceSecretsV1;
}) {
  assertVaultSharedSecretRecordV1(input.record);
  assertWrappedVaultSharedSecretV1(input.record.wrappedSecret);
  if (
    input.record.secretId !== input.definition.secretId
    || input.record.credentialType !== input.definition.credentialType
    || input.record.serviceId !== input.definition.serviceId
  ) {
    throw new Error('shared secret record 与本机 typed registry 不一致。');
  }
  if (input.record.wrappedSecret.keyId !== input.deviceSecrets.keyId) {
    throw new Error('shared secret 等待正确 vault key 后再解密。');
  }
  const vaultRootSecret = base64UrlToBytes(
    input.deviceSecrets.vaultRootSecret,
    'vaultRootSecret',
    32,
  );
  const keys = deriveSyncVaultKeysV1(vaultRootSecret);
  let contentKey: Uint8Array | null = null;
  let plaintext: Uint8Array | null = null;
  try {
    contentKey = decryptXChaCha20Poly1305V1(
      base64UrlToBytes(
        input.record.wrappedSecret.wrappedContentKey,
        'wrappedContentKey',
        48,
      ),
      keys.secretVaultKey,
      base64UrlToBytes(
        input.record.wrappedSecret.contentKeyNonce,
        'contentKeyNonce',
        24,
      ),
      associatedData({
        context: CONTENT_KEY_CONTEXT,
        definition: input.definition,
        keyId: input.record.wrappedSecret.keyId,
      }),
    );
    if (contentKey.byteLength !== 32) {
      throw new Error('shared secret content key 长度无效。');
    }
    plaintext = decryptXChaCha20Poly1305V1(
      base64UrlToBytes(
        input.record.wrappedSecret.secretCiphertext,
        'secretCiphertext',
      ),
      contentKey,
      base64UrlToBytes(
        input.record.wrappedSecret.secretNonce,
        'secretNonce',
        24,
      ),
      associatedData({
        context: SECRET_CONTEXT,
        definition: input.definition,
        keyId: input.record.wrappedSecret.keyId,
      }),
    );
    const secretValue = utf8Text(plaintext);
    assertSecretValue(secretValue);
    const expectedTag = hmacSha256V1(
      keys.secretVaultKey,
      canonicalizeJsonBytesV1({
        context: VALUE_TAG_CONTEXT,
        version: 1,
        secretId: input.definition.secretId,
        credentialType: input.definition.credentialType,
        secretValue,
      }),
    ).slice(0, 16);
    const actualTag = base64UrlToBytes(
      input.record.wrappedSecret.valueTag,
      'valueTag',
      16,
    );
    let difference = 0;
    for (let index = 0; index < expectedTag.length; index += 1) {
      difference |= expectedTag[index] ^ actualTag[index];
    }
    if (difference !== 0) {
      throw new Error('shared secret value tag 校验失败。');
    }
    return secretValue;
  } finally {
    plaintext?.fill(0);
    contentKey?.fill(0);
    vaultRootSecret.fill(0);
    clearVaultKeys(keys);
  }
}
