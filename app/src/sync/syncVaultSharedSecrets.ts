import {
  findVaultSharedSecretBySecretId,
  VAULT_SHARED_SECRET_CREDENTIAL_TYPES,
  type VaultSharedSecretCredentialType,
} from './syncVaultSharedSecretRegistry';
import {
  assertBase64Url,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const VAULT_SHARED_SECRETS_ADAPTER_ID =
  'vault.shared-secrets' as const;
export const VAULT_SHARED_SECRET_ENTITY_TYPE =
  'service-secret' as const;
export const VAULT_SHARED_SECRET_MAX_BYTES = 16 * 1024;

export const VAULT_ROOT_SECRET_TRANSFER_PATHS = Object.freeze([
  'confirmed-pairing-package',
] as const);

export type WrappedVaultSharedSecretV1 = {
  version: 1;
  keyId: string;
  contentKeyNonce: string;
  wrappedContentKey: string;
  secretNonce: string;
  secretCiphertext: string;
  valueTag: string;
};

export type VaultSharedSecretRecordV1 = {
  secretId: string;
  credentialType: VaultSharedSecretCredentialType;
  serviceId: string;
  portability: 'shared';
  wrappedSecret: WrappedVaultSharedSecretV1;
  updatedAt: number;
};

export type VaultSharedSecretUpsertPayloadV1 = {
  kind: 'service-secret';
  secret: VaultSharedSecretRecordV1;
};

export type VaultSharedSecretDeletePayloadV1 = {
  kind: 'service-secret';
  secretId: string;
  credentialType: VaultSharedSecretCredentialType;
  deleteMode: 'vault-revoke';
  revokedAt: number;
};

export type VaultSharedSecretPayloadV1 =
  | VaultSharedSecretUpsertPayloadV1
  | VaultSharedSecretDeletePayloadV1;

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
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

function assertTimestamp(
  value: unknown,
  label: string,
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertCredentialType(
  value: unknown,
): asserts value is VaultSharedSecretCredentialType {
  if (
    typeof value !== 'string'
    || !VAULT_SHARED_SECRET_CREDENTIAL_TYPES.includes(
      value as VaultSharedSecretCredentialType,
    )
  ) {
    throw new Error('shared secret credential type 不受支持。');
  }
}

export function assertWrappedVaultSharedSecretV1(
  value: unknown,
): asserts value is WrappedVaultSharedSecretV1 {
  const record = recordOf(value, 'shared secret wrapped value');
  assertExactKeys(
    record,
    [
      'version',
      'keyId',
      'contentKeyNonce',
      'wrappedContentKey',
      'secretNonce',
      'secretCiphertext',
      'valueTag',
    ],
    'shared secret wrapped value',
  );
  if (record.version !== 1) {
    throw new Error('shared secret wrapped value 版本不受支持。');
  }
  if (
    typeof record.keyId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.keyId,
    )
  ) {
    throw new Error('shared secret keyId 必须是小写 UUID v4。');
  }
  assertBase64Url(record.contentKeyNonce, 'shared secret contentKeyNonce', {
    exactBytes: 24,
  });
  assertBase64Url(record.wrappedContentKey, 'shared secret wrappedContentKey', {
    exactBytes: 48,
  });
  assertBase64Url(record.secretNonce, 'shared secret secretNonce', {
    exactBytes: 24,
  });
  assertBase64Url(record.secretCiphertext, 'shared secret ciphertext', {
    maximumBytes: VAULT_SHARED_SECRET_MAX_BYTES + 16,
  });
  assertBase64Url(record.valueTag, 'shared secret valueTag', {
    exactBytes: 16,
  });
}

export function assertVaultSharedSecretRecordV1(
  value: unknown,
): asserts value is VaultSharedSecretRecordV1 {
  const record = recordOf(value, 'shared secret record');
  assertExactKeys(
    record,
    [
      'secretId',
      'credentialType',
      'serviceId',
      'portability',
      'wrappedSecret',
      'updatedAt',
    ],
    'shared secret record',
  );
  if (typeof record.secretId !== 'string') {
    throw new Error('shared secret secretId 无效。');
  }
  assertCredentialType(record.credentialType);
  const definition = findVaultSharedSecretBySecretId(record.secretId);
  if (
    !definition
    || definition.credentialType !== record.credentialType
    || definition.serviceId !== record.serviceId
  ) {
    throw new Error('shared secret 不在 typed registry 中。');
  }
  if (record.portability !== 'shared') {
    throw new Error('设备私有秘密不得进入 shared secret vault。');
  }
  assertWrappedVaultSharedSecretV1(record.wrappedSecret);
  assertTimestamp(record.updatedAt, 'shared secret updatedAt');
}

export function assertVaultSharedSecretMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'vault'
    || value.entity.type !== VAULT_SHARED_SECRET_ENTITY_TYPE
    || value.sensitivity !== 'highest'
    || !['upsert', 'restore', 'delete'].includes(value.revision.operation)
  ) {
    throw new Error('mutation 不属于 vault.shared-secrets。');
  }
  const payload = recordOf(value.payload, 'vault.shared-secrets payload');
  if (payload.kind !== 'service-secret') {
    throw new Error('vault.shared-secrets kind 无效。');
  }
  if (value.revision.operation === 'delete') {
    assertExactKeys(
      payload,
      ['kind', 'secretId', 'credentialType', 'deleteMode', 'revokedAt'],
      'shared secret delete payload',
    );
    if (typeof payload.secretId !== 'string') {
      throw new Error('shared secret revoke secretId 无效。');
    }
    assertCredentialType(payload.credentialType);
    const definition = findVaultSharedSecretBySecretId(payload.secretId);
    if (
      !definition
      || definition.credentialType !== payload.credentialType
      || value.entity.id !== payload.secretId
    ) {
      throw new Error('shared secret revoke 不在 typed registry 中。');
    }
    if (payload.deleteMode !== 'vault-revoke') {
      throw new Error('shared secret delete 必须使用 vault-revoke。');
    }
    assertTimestamp(payload.revokedAt, 'shared secret revokedAt');
    return;
  }
  assertExactKeys(payload, ['kind', 'secret'], 'shared secret upsert payload');
  assertVaultSharedSecretRecordV1(payload.secret);
  if (value.entity.id !== payload.secret.secretId) {
    throw new Error('shared secret entity id 与 secretId 不一致。');
  }
}

export function vaultSharedSecretPayload(
  mutation: PlainMutationV1,
) {
  assertVaultSharedSecretMutationV1(mutation);
  return mutation.payload as JsonValue as VaultSharedSecretPayloadV1;
}
