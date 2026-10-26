import { Buffer } from 'buffer';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';

import type {
  SecretPackageDefinitionV1,
  SecretPackageEntryKindV1,
} from './secretPackageRegistry';

export const SECRET_PACKAGE_FORMAT_V1 =
  'junluo-secret-package' as const;
export const SECRET_PACKAGE_VERSION_V1 = 1 as const;
export const SECRET_PACKAGE_MAX_FILE_BYTES_V1 = 8 * 1024 * 1024;
export const SECRET_PACKAGE_MAX_ENTRY_BYTES_V1 = 16 * 1024;
export const SECRET_PACKAGE_MAX_ENTRIES_V1 = 512;
export const SECRET_PACKAGE_PASSWORD_MIN_CHARACTERS_V1 = 10;
export const SECRET_PACKAGE_PASSWORD_MAX_CHARACTERS_V1 = 256;

export type SecretPackageEnvelopeV1 = {
  format: typeof SECRET_PACKAGE_FORMAT_V1;
  version: typeof SECRET_PACKAGE_VERSION_V1;
  kdf: {
    name: 'scrypt';
    salt: string;
    N: 32768;
    r: 8;
    p: 1;
    dkLen: 32;
  };
  cipher: {
    name: 'xchacha20-poly1305';
    nonce: string;
    ciphertext: string;
  };
};

export type SecretPackageEntryV1 = {
  secretId: string;
  kind: SecretPackageEntryKindV1;
  credentialType: string;
  serviceId: string;
  value: string;
};

export type SecretPackagePayloadV1 = {
  version: 1;
  createdAt: number;
  entries: SecretPackageEntryV1[];
};

export type SecretPackageProgressV1 = (progress: number) => void;

type DefinitionResolver = (
  secretId: string,
) => SecretPackageDefinitionV1 | undefined;

type SecretPackageHeaderV1 = Omit<SecretPackageEnvelopeV1, 'cipher'> & {
  cipher: Omit<SecretPackageEnvelopeV1['cipher'], 'ciphertext'>;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: true });

function utf8(value: string) {
  return textEncoder.encode(value);
}

function byteLength(value: string) {
  return utf8(value).byteLength;
}

function canonicalBytes(value: unknown) {
  // Every object passed here is rebuilt in an explicit field order after
  // strict validation. JSON.stringify therefore gives Android and Windows
  // the same authenticated bytes without relying on a runtime-only module.
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('秘密包内容无法规范编码。');
  return utf8(encoded);
}

function toBase64Url(value: Uint8Array) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function fromBase64Url(
  value: unknown,
  expectedBytes: number | null,
  label: string,
) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new Error(`${label} 不是规范 base64url。`);
  }
  const padding = (4 - (value.length % 4)) % 4;
  const bytes = new Uint8Array(Buffer.from(
    `${value.replace(/-/g, '+').replace(/_/g, '/')}${'='.repeat(padding)}`,
    'base64',
  ));
  if (
    toBase64Url(bytes) !== value
    || (expectedBytes !== null && bytes.byteLength !== expectedBytes)
  ) {
    bytes.fill(0);
    throw new Error(`${label} 长度或编码无效。`);
  }
  return bytes;
}

export function normalizeSecretPackagePasswordV1(password: string) {
  if (typeof password !== 'string') {
    throw new Error('秘密包口令无效。');
  }
  const normalized = password.normalize('NFC');
  const characterCount = Array.from(normalized).length;
  if (
    characterCount < SECRET_PACKAGE_PASSWORD_MIN_CHARACTERS_V1
    || characterCount > SECRET_PACKAGE_PASSWORD_MAX_CHARACTERS_V1
  ) {
    throw new Error('秘密包口令长度无效。');
  }
  return normalized;
}

function assertPlainObject(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('秘密包结构无效。');
  }
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error('秘密包包含未知字段。');
  }
}

export function assertSecretPackageEntriesV1(
  entries: unknown,
  resolveDefinition: DefinitionResolver,
): asserts entries is SecretPackageEntryV1[] {
  if (
    !Array.isArray(entries)
    || entries.length < 1
    || entries.length > SECRET_PACKAGE_MAX_ENTRIES_V1
  ) {
    throw new Error('秘密包条目数量无效。');
  }
  const ids = new Set<string>();
  for (const item of entries) {
    assertPlainObject(item);
    assertExactKeys(item, [
      'secretId',
      'kind',
      'credentialType',
      'serviceId',
      'value',
    ]);
    if (
      typeof item.secretId !== 'string'
      || typeof item.credentialType !== 'string'
      || typeof item.serviceId !== 'string'
      || typeof item.value !== 'string'
      || item.value.length === 0
      || byteLength(item.value) > SECRET_PACKAGE_MAX_ENTRY_BYTES_V1
      || (item.kind !== 'service-credential'
        && item.kind !== 'exportable-session')
      || ids.has(item.secretId)
    ) {
      throw new Error('秘密包条目无效或重复。');
    }
    const definition = resolveDefinition(item.secretId);
    if (
      !definition
      || definition.kind !== item.kind
      || definition.credentialType !== item.credentialType
      || definition.serviceId !== item.serviceId
    ) {
      throw new Error('秘密包条目不在允许的服务白名单中。');
    }
    ids.add(item.secretId);
  }
}

function headerForEnvelope(
  envelope: SecretPackageEnvelopeV1,
): SecretPackageHeaderV1 {
  return {
    format: envelope.format,
    version: envelope.version,
    kdf: { ...envelope.kdf },
    cipher: {
      name: envelope.cipher.name,
      nonce: envelope.cipher.nonce,
    },
  };
}

function assertEnvelope(value: unknown): SecretPackageEnvelopeV1 {
  assertPlainObject(value);
  assertExactKeys(value, ['format', 'version', 'kdf', 'cipher']);
  assertPlainObject(value.kdf);
  assertPlainObject(value.cipher);
  assertExactKeys(value.kdf, ['name', 'salt', 'N', 'r', 'p', 'dkLen']);
  assertExactKeys(value.cipher, ['name', 'nonce', 'ciphertext']);
  if (
    value.format !== SECRET_PACKAGE_FORMAT_V1
    || value.version !== SECRET_PACKAGE_VERSION_V1
    || value.kdf.name !== 'scrypt'
    || value.kdf.N !== 32768
    || value.kdf.r !== 8
    || value.kdf.p !== 1
    || value.kdf.dkLen !== 32
    || value.cipher.name !== 'xchacha20-poly1305'
    || typeof value.kdf.salt !== 'string'
    || typeof value.cipher.nonce !== 'string'
    || typeof value.cipher.ciphertext !== 'string'
  ) {
    throw new Error('秘密包版本或固定加密参数无效。');
  }
  const salt = fromBase64Url(value.kdf.salt, 32, 'scrypt salt');
  const nonce = fromBase64Url(value.cipher.nonce, 24, 'XChaCha nonce');
  const ciphertext = fromBase64Url(
    value.cipher.ciphertext,
    null,
    '秘密包密文',
  );
  salt.fill(0);
  nonce.fill(0);
  ciphertext.fill(0);
  return value as SecretPackageEnvelopeV1;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  onProgress?: SecretPackageProgressV1,
) {
  const passwordBytes = utf8(normalizeSecretPackagePasswordV1(password));
  try {
    return await scryptAsync(passwordBytes, salt, {
      N: 32768,
      r: 8,
      p: 1,
      dkLen: 32,
      asyncTick: 8,
      maxmem: 64 * 1024 * 1024,
      onProgress,
    });
  } finally {
    passwordBytes.fill(0);
  }
}

export async function encryptSecretPackageV1(input: {
  entries: SecretPackageEntryV1[];
  password: string;
  randomBytes: (length: number) => Uint8Array | Promise<Uint8Array>;
  resolveDefinition: DefinitionResolver;
  now?: () => number;
  onProgress?: SecretPackageProgressV1;
}) {
  assertSecretPackageEntriesV1(input.entries, input.resolveDefinition);
  const createdAt = (input.now ?? Date.now)();
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
    throw new Error('秘密包创建时间无效。');
  }
  const salt = await input.randomBytes(32);
  const nonce = await input.randomBytes(24);
  if (salt.byteLength !== 32 || nonce.byteLength !== 24) {
    salt.fill(0);
    nonce.fill(0);
    throw new Error('秘密包随机数来源返回了错误长度。');
  }
  const envelope: SecretPackageEnvelopeV1 = {
    format: SECRET_PACKAGE_FORMAT_V1,
    version: SECRET_PACKAGE_VERSION_V1,
    kdf: {
      name: 'scrypt',
      salt: toBase64Url(salt),
      N: 32768,
      r: 8,
      p: 1,
      dkLen: 32,
    },
    cipher: {
      name: 'xchacha20-poly1305',
      nonce: toBase64Url(nonce),
      ciphertext: '',
    },
  };
  const plaintext = canonicalBytes({
    version: 1,
    createdAt,
    entries: input.entries,
  } satisfies SecretPackagePayloadV1);
  let key: Uint8Array | undefined;
  let ciphertext: Uint8Array | undefined;
  try {
    key = await deriveKey(input.password, salt, input.onProgress);
    ciphertext = xchacha20poly1305(
      key,
      nonce,
      canonicalBytes(headerForEnvelope(envelope)),
    ).encrypt(plaintext);
    envelope.cipher.ciphertext = toBase64Url(ciphertext);
    const serialized = JSON.stringify(envelope);
    if (
      serialized === undefined
      || byteLength(serialized) > SECRET_PACKAGE_MAX_FILE_BYTES_V1
    ) {
      throw new Error('秘密包超过允许的文件大小。');
    }
    return serialized;
  } finally {
    plaintext.fill(0);
    key?.fill(0);
    ciphertext?.fill(0);
    salt.fill(0);
    nonce.fill(0);
  }
}

export async function decryptSecretPackageV1(input: {
  serialized: string;
  password: string;
  resolveDefinition: DefinitionResolver;
  onProgress?: SecretPackageProgressV1;
}) {
  if (
    typeof input.serialized !== 'string'
    || byteLength(input.serialized) > SECRET_PACKAGE_MAX_FILE_BYTES_V1
  ) {
    throw new Error('秘密包文件大小无效。');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.serialized) as unknown;
  } catch {
    throw new Error('秘密包不是有效 JSON。');
  }
  const envelope = assertEnvelope(parsed);
  const salt = fromBase64Url(envelope.kdf.salt, 32, 'scrypt salt');
  const nonce = fromBase64Url(envelope.cipher.nonce, 24, 'XChaCha nonce');
  const ciphertext = fromBase64Url(
    envelope.cipher.ciphertext,
    null,
    '秘密包密文',
  );
  let key: Uint8Array | undefined;
  let plaintext: Uint8Array | undefined;
  try {
    key = await deriveKey(input.password, salt, input.onProgress);
    plaintext = xchacha20poly1305(
      key,
      nonce,
      canonicalBytes(headerForEnvelope(envelope)),
    ).decrypt(ciphertext);
    const payload = JSON.parse(textDecoder.decode(plaintext)) as unknown;
    assertPlainObject(payload);
    assertExactKeys(payload, ['version', 'createdAt', 'entries']);
    if (
      payload.version !== 1
      || !Number.isSafeInteger(payload.createdAt)
      || (payload.createdAt as number) < 0
    ) {
      throw new Error('秘密包明文版本无效。');
    }
    assertSecretPackageEntriesV1(
      payload.entries,
      input.resolveDefinition,
    );
    const createdAt = payload.createdAt as number;
    return {
      version: 1,
      createdAt,
      entries: payload.entries,
    } satisfies SecretPackagePayloadV1;
  } catch {
    throw new Error('秘密包无法打开或校验失败。');
  } finally {
    key?.fill(0);
    plaintext?.fill(0);
    salt.fill(0);
    nonce.fill(0);
    ciphertext.fill(0);
  }
}

export function secretPackageFileNameV1(now = new Date()) {
  const pad = (value: number) => value.toString().padStart(2, '0');
  return `君落秘密包-${now.getFullYear()}${pad(now.getMonth() + 1)}`
    + `${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
    + '.jlsecret';
}
