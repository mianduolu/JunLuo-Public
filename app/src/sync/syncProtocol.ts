export const SYNC_PROTOCOL_VERSION = 1 as const;
export const SYNC_CIPHER_SUITE = 'JL1-XCHACHA20-POLY1305' as const;
export const MAX_SEALED_CHANGE_BYTES = 1024 * 1024;

export function getSyncEntityIdMaximumLength(domain: string, entityType: string) {
  return domain === 'memory' && entityType === 'continuity-link' ? 2048 : 256;
}

/** Historical transport only: never an active business adapter or action parser. */
export function isRetiredCurrentActionMutation(mutation: PlainMutationV1): boolean {
  if (mutation.entity.domain !== 'behavior' || mutation.entity.type !== 'current-action') return false;
  assertPlainMutationV1(mutation);
  if (mutation.entity.id !== 'current-action'
    || mutation.revision.schemaVersion !== 1
    || mutation.revision.operation !== 'upsert'
    || mutation.sensitivity !== 'high'
    || mutation.retentionClass !== 'relationship-current-action'
    || mutation.objectRefs.length !== 0) {
    throw new Error('退休行动记录的传输身份或版本无效。');
  }
  return true;
}


export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type SyncOperation = 'upsert' | 'delete' | 'restore' | 'append';
export type SyncSensitivity = 'private' | 'high' | 'highest';

export type PlainMutationV1 = {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  mutationId: string;
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
  entity: {
    domain: string;
    type: string;
    id: string;
  };
  revision: {
    id: string;
    parents: string[];
    operation: SyncOperation;
    schemaVersion: number;
  };
  sensitivity: SyncSensitivity;
  payload: JsonValue;
  objectRefs: string[];
  retentionClass: string;
};

export type SealedChangeV1 = {
  protocolVersion: typeof SYNC_PROTOCOL_VERSION;
  vaultId: string;
  sourceDeviceId: string;
  sourceSequence: number;
  mutationId: string;
  requestId: string;
  createdAt: number;
  keyId: string;
  cipherSuite: typeof SYNC_CIPHER_SUITE;
  nonce: string;
  ciphertext: string;
  signature: string;
};

export interface SyncCryptoPort {
  sealChange(mutation: PlainMutationV1, requestId: string): Promise<SealedChangeV1>;
  openChange(change: SealedChangeV1): Promise<PlainMutationV1>;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DOMAIN_TOKEN_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const OPERATIONS = new Set<SyncOperation>(['upsert', 'delete', 'restore', 'append']);
const SENSITIVITIES = new Set<SyncSensitivity>(['private', 'high', 'highest']);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string) {
  const allowedKeys = new Set(allowed);
  const extra = Object.keys(record).filter((key) => !allowedKeys.has(key));
  if (extra.length > 0) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = allowed.filter((key) => !(key in record));
  if (missing.length > 0) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertUuidV4(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`${label} 必须是 UUID v4。`);
  }
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} 必须是大于等于 ${minimum} 的安全整数。`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== 'string'
    || value.length < minimumLength
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 长度必须在 ${minimumLength}–${maximumLength} 之间。`);
  }
}

function assertDomainToken(value: unknown, label: string) {
  assertBoundedString(value, label, 1, 80);
  if (!DOMAIN_TOKEN_PATTERN.test(value)) {
    throw new Error(`${label} 只能包含小写字母、数字、点、下划线和短横线。`);
  }
}

function decodedBase64UrlLength(value: string) {
  const remainder = value.length % 4;
  if (remainder === 1) return -1;
  const padding = remainder === 0 ? 0 : 4 - remainder;
  return Math.floor(((value.length + padding) * 3) / 4) - padding;
}

export function assertBase64Url(
  value: unknown,
  label: string,
  options: { exactBytes?: number; maximumBytes?: number } = {},
): asserts value is string {
  if (typeof value !== 'string' || !BASE64URL_PATTERN.test(value)) {
    throw new Error(`${label} 必须是无填充 base64url。`);
  }
  const byteLength = decodedBase64UrlLength(value);
  if (byteLength < 0) {
    throw new Error(`${label} 的 base64url 长度无效。`);
  }
  if (options.exactBytes !== undefined && byteLength !== options.exactBytes) {
    throw new Error(`${label} 必须正好是 ${options.exactBytes} bytes。`);
  }
  if (options.maximumBytes !== undefined && byteLength > options.maximumBytes) {
    throw new Error(`${label} 超过 ${options.maximumBytes} bytes 上限。`);
  }
}

export function assertJsonValue(value: unknown, label = 'JSON', seen = new Set<object>()): asserts value is JsonValue {
  if (
    value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value))
  ) {
    return;
  }
  if (!value || typeof value !== 'object') {
    throw new Error(`${label} 不是可持久化 JSON。`);
  }
  if (seen.has(value)) {
    throw new Error(`${label} 包含循环引用。`);
  }
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${label}[${index}]`, seen));
  } else {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        throw new Error(`${label}.${key} 不能是 undefined。`);
      }
      assertJsonValue(entry, `${label}.${key}`, seen);
    }
  }
  seen.delete(value);
}

export function assertPlainMutationV1(value: unknown): asserts value is PlainMutationV1 {
  const mutation = recordOf(value, 'PlainMutationV1');
  assertExactKeys(
    mutation,
    [
      'protocolVersion',
      'mutationId',
      'vaultId',
      'sourceDeviceId',
      'sourceSequence',
      'createdAt',
      'entity',
      'revision',
      'sensitivity',
      'payload',
      'objectRefs',
      'retentionClass',
    ],
    'PlainMutationV1',
  );
  if (mutation.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new Error('PlainMutationV1 协议版本不受支持。');
  }
  assertUuidV4(mutation.mutationId, 'mutationId');
  assertUuidV4(mutation.vaultId, 'vaultId');
  assertUuidV4(mutation.sourceDeviceId, 'sourceDeviceId');
  assertSafeInteger(mutation.sourceSequence, 'sourceSequence', 1);
  assertSafeInteger(mutation.createdAt, 'createdAt');

  const entity = recordOf(mutation.entity, 'entity');
  assertExactKeys(entity, ['domain', 'type', 'id'], 'entity');
  assertDomainToken(entity.domain, 'entity.domain');
  assertDomainToken(entity.type, 'entity.type');
  assertBoundedString(entity.id, 'entity.id', 1,
    getSyncEntityIdMaximumLength(entity.domain as string, entity.type as string));

  const revision = recordOf(mutation.revision, 'revision');
  assertExactKeys(revision, ['id', 'parents', 'operation', 'schemaVersion'], 'revision');
  assertUuidV4(revision.id, 'revision.id');
  if (!Array.isArray(revision.parents) || revision.parents.length > 32) {
    throw new Error('revision.parents 必须是最多 32 项的数组。');
  }
  revision.parents.forEach((parent, index) => assertUuidV4(parent, `revision.parents[${index}]`));
  if (new Set(revision.parents).size !== revision.parents.length) {
    throw new Error('revision.parents 不能重复。');
  }
  if (typeof revision.operation !== 'string' || !OPERATIONS.has(revision.operation as SyncOperation)) {
    throw new Error('revision.operation 不受支持。');
  }
  assertSafeInteger(revision.schemaVersion, 'revision.schemaVersion', 1);

  if (typeof mutation.sensitivity !== 'string' || !SENSITIVITIES.has(mutation.sensitivity as SyncSensitivity)) {
    throw new Error('sensitivity 不受支持。');
  }
  assertJsonValue(mutation.payload, 'payload');
  if (!Array.isArray(mutation.objectRefs) || mutation.objectRefs.length > 256) {
    throw new Error('objectRefs 必须是最多 256 项的数组。');
  }
  mutation.objectRefs.forEach((objectId, index) => {
    assertBoundedString(objectId, `objectRefs[${index}]`, 16, 160);
    if (!BASE64URL_PATTERN.test(objectId)) {
      throw new Error(`objectRefs[${index}] 必须是无填充 base64url 对象 ID。`);
    }
  });
  if (new Set(mutation.objectRefs).size !== mutation.objectRefs.length) {
    throw new Error('objectRefs 不能重复。');
  }
  assertDomainToken(mutation.retentionClass, 'retentionClass');
}

export function assertSealedChangeV1(value: unknown): asserts value is SealedChangeV1 {
  const change = recordOf(value, 'SealedChangeV1');
  assertExactKeys(
    change,
    [
      'protocolVersion',
      'vaultId',
      'sourceDeviceId',
      'sourceSequence',
      'mutationId',
      'requestId',
      'createdAt',
      'keyId',
      'cipherSuite',
      'nonce',
      'ciphertext',
      'signature',
    ],
    'SealedChangeV1',
  );
  if (change.protocolVersion !== SYNC_PROTOCOL_VERSION) {
    throw new Error('SealedChangeV1 协议版本不受支持。');
  }
  assertUuidV4(change.vaultId, 'vaultId');
  assertUuidV4(change.sourceDeviceId, 'sourceDeviceId');
  assertSafeInteger(change.sourceSequence, 'sourceSequence', 1);
  assertUuidV4(change.mutationId, 'mutationId');
  assertUuidV4(change.requestId, 'requestId');
  assertSafeInteger(change.createdAt, 'createdAt');
  assertUuidV4(change.keyId, 'keyId');
  if (change.cipherSuite !== SYNC_CIPHER_SUITE) {
    throw new Error('cipherSuite 不受支持。');
  }
  assertBase64Url(change.nonce, 'nonce', { exactBytes: 24 });
  assertBase64Url(change.ciphertext, 'ciphertext', { maximumBytes: MAX_SEALED_CHANGE_BYTES });
  assertBase64Url(change.signature, 'signature', { exactBytes: 64 });
}

export function parsePlainMutationV1(raw: string) {
  const parsed: unknown = JSON.parse(raw);
  assertPlainMutationV1(parsed);
  return parsed;
}

export function parseSealedChangeV1(raw: string) {
  const parsed: unknown = JSON.parse(raw);
  assertSealedChangeV1(parsed);
  return parsed;
}

export function assertSubjectiveRole(value: unknown): asserts value is 'I' | 'you' {
  if (value !== 'I' && value !== 'you') {
    throw new Error('进入君落意识链路的消息角色只能是 I 或 you。');
  }
}

export function computeSyncRetryAt(
  attemptCount: number,
  now: number,
  jitterFraction = 0,
) {
  assertSafeInteger(attemptCount, 'attemptCount', 1);
  assertSafeInteger(now, 'now');
  if (!Number.isFinite(jitterFraction) || jitterFraction < 0 || jitterFraction > 1) {
    throw new Error('jitterFraction 必须在 0–1 之间。');
  }
  const baseDelay = Math.min(30 * 60_000, 2 ** Math.min(attemptCount - 1, 10) * 2_000);
  const jitter = Math.floor(baseDelay * 0.2 * jitterFraction);
  return now + baseDelay + jitter;
}
