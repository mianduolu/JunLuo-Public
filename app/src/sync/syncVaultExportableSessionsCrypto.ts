import { Buffer } from 'buffer';

import {
  assertVaultExportableSessionRecordV1,
  assertWrappedVaultExportableSessionSecretV1,
  VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
  VAULT_EXPORTABLE_SESSION_MAX_SECRET_BYTES,
  type VaultExportableSessionRecordV1,
} from './syncVaultExportableSessions';
import type {
  VaultExportableSessionDefinition,
} from './syncVaultExportableSessionRegistry';
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
  'junluo.sync.v1/vault-exportable-session-content-key';
const SECRET_CONTEXT =
  'junluo.sync.v1/vault-exportable-session-secret';
const VALUE_TAG_CONTEXT =
  'junluo.sync.v1/vault-exportable-session-value-tag';

export type VaultExportableSessionRandomBytes = (
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
  if (!value || length > VAULT_EXPORTABLE_SESSION_MAX_SECRET_BYTES) {
    throw new Error(
      `exportable session secret 必须是 1–${VAULT_EXPORTABLE_SESSION_MAX_SECRET_BYTES} bytes。`,
    );
  }
}

async function randomBytesExact(
  source: VaultExportableSessionRandomBytes,
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
  definition: VaultExportableSessionDefinition;
  keyId: string;
}) {
  return canonicalizeJsonBytesV1({
    context: input.context,
    version: 1,
    adapterId: VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID,
    secretId: input.definition.secretId,
    sessionType: input.definition.sessionType,
    serviceId: input.definition.serviceId,
    keyId: input.keyId,
  });
}

function clearVaultKeys(
  keys: ReturnType<typeof deriveSyncVaultKeysV1>,
) {
  Object.values(keys).forEach((key) => key.fill(0));
}

export async function wrapVaultExportableSessionSecretV1(input: {
  definition: VaultExportableSessionDefinition;
  secretValue: string;
  deviceSecrets: SyncDeviceSecretsV1;
  randomBytes: VaultExportableSessionRandomBytes;
  updatedAt: number;
}): Promise<VaultExportableSessionRecordV1> {
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
    'exportable session content key',
  );
  const contentKeyNonce = await randomBytesExact(
    input.randomBytes,
    24,
    'exportable session content key nonce',
  );
  const secretNonce = await randomBytesExact(
    input.randomBytes,
    24,
    'exportable session secret nonce',
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
        sessionType: input.definition.sessionType,
        secretValue: input.secretValue,
      }),
    ).slice(0, 16);
    const record: VaultExportableSessionRecordV1 = {
      secretId: input.definition.secretId,
      sessionType: input.definition.sessionType,
      serviceId: input.definition.serviceId,
      portability: 'exportable',
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
    assertVaultExportableSessionRecordV1(record);
    return record;
  } finally {
    plaintext.fill(0);
    contentKey.fill(0);
    vaultRootSecret.fill(0);
    clearVaultKeys(keys);
  }
}

export function unwrapVaultExportableSessionSecretV1(input: {
  record: VaultExportableSessionRecordV1;
  definition: VaultExportableSessionDefinition;
  deviceSecrets: SyncDeviceSecretsV1;
}) {
  assertVaultExportableSessionRecordV1(input.record);
  assertWrappedVaultExportableSessionSecretV1(
    input.record.wrappedSecret,
  );
  if (
    input.record.secretId !== input.definition.secretId
    || input.record.sessionType !== input.definition.sessionType
    || input.record.serviceId !== input.definition.serviceId
  ) {
    throw new Error('exportable session record 与本机 typed registry 不一致。');
  }
  if (input.record.wrappedSecret.keyId !== input.deviceSecrets.keyId) {
    throw new Error('exportable session 等待正确 vault key 后再解密。');
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
      throw new Error('exportable session content key 长度无效。');
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
        sessionType: input.definition.sessionType,
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
      throw new Error('exportable session value tag 校验失败。');
    }
    return secretValue;
  } finally {
    plaintext?.fill(0);
    contentKey?.fill(0);
    vaultRootSecret.fill(0);
    clearVaultKeys(keys);
  }
}
