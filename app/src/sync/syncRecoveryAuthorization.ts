import {
  base64UrlToBytes,
  bytesToBase64Url,
  deriveSyncVaultKeysV1,
  signingPublicKeyFromPrivateV1,
} from './syncCrypto';
import {
  assertSyncDeviceSecretsV1,
  assertSyncUuidV4,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';

export type SyncVaultPublicRegistrationV1 = {
  version: 1;
  vaultId: string;
  keyId: string;
  recoveryAuthorizationPublicKey: string;
  createdAt: number;
};

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const keys = Object.keys(record);
  if (
    keys.some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error(`${label} 字段不符合 v1 合同。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

export function assertSyncVaultPublicRegistrationV1(
  value: unknown,
): asserts value is SyncVaultPublicRegistrationV1 {
  const record = recordOf(value, 'vault 公开登记');
  assertExactKeys(
    record,
    [
      'version',
      'vaultId',
      'keyId',
      'recoveryAuthorizationPublicKey',
      'createdAt',
    ],
    'vault 公开登记',
  );
  if (record.version !== 1) throw new Error('vault 公开登记版本不受支持。');
  assertSyncUuidV4(record.vaultId, 'vaultId');
  assertSyncUuidV4(record.keyId, 'keyId');
  base64UrlToBytes(
    record.recoveryAuthorizationPublicKey as string,
    'recoveryAuthorizationPublicKey',
    32,
  );
  assertTimestamp(record.createdAt, 'createdAt');
}

export function createSyncVaultPublicRegistrationV1(
  secrets: SyncDeviceSecretsV1,
  createdAt: number,
) {
  assertSyncDeviceSecretsV1(secrets);
  assertTimestamp(createdAt, 'createdAt');
  const { recoveryAuthorizationKey } = deriveSyncVaultKeysV1(
    base64UrlToBytes(secrets.vaultRootSecret, 'vaultRootSecret', 32),
  );
  const registration: SyncVaultPublicRegistrationV1 = {
    version: 1,
    vaultId: secrets.vaultId,
    keyId: secrets.keyId,
    recoveryAuthorizationPublicKey: bytesToBase64Url(
      signingPublicKeyFromPrivateV1(recoveryAuthorizationKey),
    ),
    createdAt,
  };
  assertSyncVaultPublicRegistrationV1(registration);
  return registration;
}
