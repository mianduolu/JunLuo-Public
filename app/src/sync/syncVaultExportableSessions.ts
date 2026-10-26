import {
  findVaultExportableSessionBySecretId,
  VAULT_EXPORTABLE_SESSION_TYPES,
  type VaultExportableSessionType,
} from './syncVaultExportableSessionRegistry';
import {
  assertBase64Url,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const VAULT_EXPORTABLE_SESSIONS_ADAPTER_ID =
  'vault.exportable-sessions' as const;
export const VAULT_EXPORTABLE_SESSION_ENTITY_TYPE =
  'exportable-session' as const;
export const VAULT_EXPORTABLE_SESSION_MAX_SECRET_BYTES =
  16 * 1024;

export type WrappedVaultExportableSessionSecretV1 = {
  version: 1;
  keyId: string;
  contentKeyNonce: string;
  wrappedContentKey: string;
  secretNonce: string;
  secretCiphertext: string;
  valueTag: string;
};

export type VaultExportableSessionRecordV1 = {
  secretId: string;
  sessionType: VaultExportableSessionType;
  serviceId: string;
  portability: 'exportable';
  wrappedSecret: WrappedVaultExportableSessionSecretV1;
  updatedAt: number;
};

export type VaultExportableSessionUpsertPayloadV1 = {
  kind: 'exportable-session';
  session: VaultExportableSessionRecordV1;
};

export type VaultExportableSessionDeletePayloadV1 = {
  kind: 'exportable-session';
  secretId: string;
  sessionType: VaultExportableSessionType;
  deleteMode: 'vault-revoke';
  revokedAt: number;
};

export type VaultExportableSessionPayloadV1 =
  | VaultExportableSessionUpsertPayloadV1
  | VaultExportableSessionDeletePayloadV1;

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

function assertSessionType(
  value: unknown,
): asserts value is VaultExportableSessionType {
  if (
    typeof value !== 'string'
    || !VAULT_EXPORTABLE_SESSION_TYPES.includes(
      value as VaultExportableSessionType,
    )
  ) {
    throw new Error('exportable session type 不受支持。');
  }
}

export function assertWrappedVaultExportableSessionSecretV1(
  value: unknown,
): asserts value is WrappedVaultExportableSessionSecretV1 {
  const record = recordOf(value, 'exportable session wrapped secret');
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
    'exportable session wrapped secret',
  );
  if (record.version !== 1) {
    throw new Error('exportable session wrapped secret 版本不受支持。');
  }
  if (
    typeof record.keyId !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      record.keyId,
    )
  ) {
    throw new Error('exportable session keyId 必须是小写 UUID v4。');
  }
  assertBase64Url(
    record.contentKeyNonce,
    'exportable session contentKeyNonce',
    { exactBytes: 24 },
  );
  assertBase64Url(
    record.wrappedContentKey,
    'exportable session wrappedContentKey',
    { exactBytes: 48 },
  );
  assertBase64Url(
    record.secretNonce,
    'exportable session secretNonce',
    { exactBytes: 24 },
  );
  assertBase64Url(
    record.secretCiphertext,
    'exportable session secretCiphertext',
    { maximumBytes: VAULT_EXPORTABLE_SESSION_MAX_SECRET_BYTES + 16 },
  );
  assertBase64Url(
    record.valueTag,
    'exportable session valueTag',
    { exactBytes: 16 },
  );
}

export function assertVaultExportableSessionRecordV1(
  value: unknown,
): asserts value is VaultExportableSessionRecordV1 {
  const record = recordOf(value, 'exportable session record');
  assertExactKeys(
    record,
    [
      'secretId',
      'sessionType',
      'serviceId',
      'portability',
      'wrappedSecret',
      'updatedAt',
    ],
    'exportable session record',
  );
  if (typeof record.secretId !== 'string') {
    throw new Error('exportable session secretId 无效。');
  }
  assertSessionType(record.sessionType);
  const definition = findVaultExportableSessionBySecretId(record.secretId);
  if (
    !definition
    || definition.sessionType !== record.sessionType
    || definition.serviceId !== record.serviceId
  ) {
    throw new Error('exportable session 不在可导出白名单中。');
  }
  if (record.portability !== 'exportable') {
    throw new Error('设备绑定会话不得进入 exportable session。');
  }
  assertWrappedVaultExportableSessionSecretV1(record.wrappedSecret);
  assertTimestamp(record.updatedAt, 'exportable session updatedAt');
}

export function assertVaultExportableSessionMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'vault'
    || value.entity.type !== VAULT_EXPORTABLE_SESSION_ENTITY_TYPE
    || value.sensitivity !== 'highest'
    || !['upsert', 'restore', 'delete'].includes(
      value.revision.operation,
    )
  ) {
    throw new Error('mutation 不属于 vault.exportable-sessions。');
  }
  const payload = recordOf(
    value.payload,
    'vault.exportable-sessions payload',
  );
  if (payload.kind !== 'exportable-session') {
    throw new Error('vault.exportable-sessions kind 无效。');
  }
  if (value.revision.operation === 'delete') {
    assertExactKeys(
      payload,
      ['kind', 'secretId', 'sessionType', 'deleteMode', 'revokedAt'],
      'vault exportable session delete payload',
    );
    if (typeof payload.secretId !== 'string') {
      throw new Error('vault revoke secretId 无效。');
    }
    assertSessionType(payload.sessionType);
    const definition =
      findVaultExportableSessionBySecretId(payload.secretId);
    if (
      !definition
      || definition.sessionType !== payload.sessionType
      || value.entity.id !== payload.secretId
    ) {
      throw new Error('vault revoke 不属于可导出会话白名单。');
    }
    if (payload.deleteMode !== 'vault-revoke') {
      throw new Error('vault delete 必须使用 vault-revoke。');
    }
    assertTimestamp(payload.revokedAt, 'vault revokedAt');
    return;
  }
  assertExactKeys(
    payload,
    ['kind', 'session'],
    'vault exportable session upsert payload',
  );
  assertVaultExportableSessionRecordV1(payload.session);
  if (value.entity.id !== payload.session.secretId) {
    throw new Error('exportable session entity id 与 secretId 不一致。');
  }
}

export function vaultExportableSessionPayload(
  mutation: PlainMutationV1,
) {
  assertVaultExportableSessionMutationV1(mutation);
  return mutation.payload as JsonValue as VaultExportableSessionPayloadV1;
}
