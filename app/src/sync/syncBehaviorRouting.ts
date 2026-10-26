import {
  DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
} from '../ai/behavior/actionBudget';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const BEHAVIOR_ROUTING_ADAPTER_ID =
  'behavior.routing' as const;
export const BEHAVIOR_ROUTING_SCHEMA_VERSION = 1 as const;
export const BEHAVIOR_ROUTING_RETENTION_CLASS =
  'behavior-routing-setting' as const;
export const BEHAVIOR_ROUTING_RECORD_KIND =
  'logical-route-field' as const;
export const BEHAVIOR_ROUTING_TOMBSTONE_KIND =
  'logical-route-tombstone' as const;

export const BEHAVIOR_ROUTING_FIELDS = Object.freeze([
  'primaryConnectionId',
  'remoteFallbackConnectionId',
  'remoteSemanticReviewEnabled',
  'remoteSemanticReviewDailyLimit',
  'privateSummaryEnabled',
] as const);

export type BehaviorRoutingField =
  typeof BEHAVIOR_ROUTING_FIELDS[number];
export type BehaviorRoutingFieldValue =
  | string
  | number
  | boolean
  | null;
export type BehaviorRoutingProjection = {
  primaryConnectionId: string | null;
  remoteFallbackConnectionId: string | null;
  remoteSemanticReviewEnabled: boolean;
  remoteSemanticReviewDailyLimit: number;
  privateSummaryEnabled: boolean;
};

function recordOf(value: unknown, label: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
) {
  const allowed = new Set(required);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

export function isBehaviorRoutingField(
  value: unknown,
): value is BehaviorRoutingField {
  return typeof value === 'string'
    && BEHAVIOR_ROUTING_FIELDS.includes(value as BehaviorRoutingField);
}

function connectionId(value: unknown, label: string) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > 256) {
    throw new Error(`${label} 必须是至多 256 字符的逻辑连接 ID。`);
  }
  return value;
}

function reviewLimit(value: unknown) {
  if (value === -1) return -1;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT;
  }
  return Math.max(0, Math.round(value));
}

export function defaultBehaviorRoutingProjection():
BehaviorRoutingProjection {
  return {
    primaryConnectionId: null,
    remoteFallbackConnectionId: null,
    remoteSemanticReviewEnabled: false,
    remoteSemanticReviewDailyLimit:
      DEFAULT_BAIYUN_REMOTE_REVIEW_DAILY_LIMIT,
    privateSummaryEnabled: false,
  };
}

export function defaultBehaviorRoutingFieldValue(
  field: BehaviorRoutingField,
): BehaviorRoutingFieldValue {
  return defaultBehaviorRoutingProjection()[field];
}

export function projectBehaviorRoutingStorageValue(
  value: unknown,
): BehaviorRoutingProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultBehaviorRoutingProjection();
  }
  const candidate = value as Record<string, unknown>;
  return {
    primaryConnectionId: connectionId(
      candidate.primaryConnectionId,
      'primaryConnectionId',
    ),
    remoteFallbackConnectionId: connectionId(
      candidate.remoteFallbackConnectionId,
      'remoteFallbackConnectionId',
    ),
    remoteSemanticReviewEnabled:
      candidate.remoteSemanticReviewEnabled === true,
    remoteSemanticReviewDailyLimit:
      reviewLimit(candidate.remoteSemanticReviewDailyLimit),
    privateSummaryEnabled: candidate.privateSummaryEnabled === true,
  };
}

export function parseBehaviorRoutingStorageProjection(raw: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('behavior routing storage 不是有效 JSON。');
  }
  return projectBehaviorRoutingStorageValue(parsed);
}

export function assertBehaviorRoutingFieldValue(
  field: BehaviorRoutingField,
  value: unknown,
): asserts value is BehaviorRoutingFieldValue {
  if (
    field === 'primaryConnectionId'
    || field === 'remoteFallbackConnectionId'
  ) {
    if (
      value !== null
      && (typeof value !== 'string' || value.length > 256)
    ) {
      throw new Error(`${field} mutation value 无效。`);
    }
    return;
  }
  if (
    field === 'remoteSemanticReviewEnabled'
    || field === 'privateSummaryEnabled'
  ) {
    if (typeof value !== 'boolean') {
      throw new Error(`${field} mutation value 必须是 boolean。`);
    }
    return;
  }
  if (
    !Number.isSafeInteger(value)
    || (Number(value) < 0 && value !== -1)
  ) {
    throw new Error('remoteSemanticReviewDailyLimit mutation value 无效。');
  }
}

export function assertBehaviorRoutingMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'behavior'
    || value.entity.type !== 'logical-route'
    || !isBehaviorRoutingField(value.entity.id)
  ) {
    throw new Error('behavior.routing mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== BEHAVIOR_ROUTING_SCHEMA_VERSION) {
    throw new Error('behavior.routing schemaVersion 无效。');
  }
  if (
    value.revision.operation !== 'upsert'
    && value.revision.operation !== 'delete'
  ) {
    throw new Error('behavior.routing operation 无效。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('behavior.routing sensitivity 必须为 high。');
  }
  if (value.retentionClass !== BEHAVIOR_ROUTING_RETENTION_CLASS) {
    throw new Error('behavior.routing retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('behavior.routing 不接受对象引用。');
  }
  const payload = recordOf(value.payload, 'behavior.routing payload');
  if (value.revision.operation === 'delete') {
    assertKeys(
      payload,
      ['schemaVersion', 'kind', 'field'],
      'behavior.routing tombstone',
    );
    if (payload.kind !== BEHAVIOR_ROUTING_TOMBSTONE_KIND) {
      throw new Error('behavior.routing tombstone kind 无效。');
    }
  } else {
    assertKeys(
      payload,
      ['schemaVersion', 'kind', 'field', 'value'],
      'behavior.routing field payload',
    );
    if (payload.kind !== BEHAVIOR_ROUTING_RECORD_KIND) {
      throw new Error('behavior.routing record kind 无效。');
    }
    assertBehaviorRoutingFieldValue(value.entity.id, payload.value);
  }
  if (payload.schemaVersion !== BEHAVIOR_ROUTING_SCHEMA_VERSION) {
    throw new Error('behavior.routing payload schemaVersion 无效。');
  }
  if (payload.field !== value.entity.id) {
    throw new Error('behavior.routing payload field 与 entity id 不一致。');
  }
  assertJsonValue(payload);
}

export function buildBehaviorRoutingMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  field: BehaviorRoutingField;
  operation: 'upsert' | 'delete';
  value?: BehaviorRoutingFieldValue;
}) {
  if (input.operation === 'upsert') {
    assertBehaviorRoutingFieldValue(input.field, input.value);
  }
  const payload: JsonValue = input.operation === 'delete'
    ? {
        schemaVersion: BEHAVIOR_ROUTING_SCHEMA_VERSION,
        kind: BEHAVIOR_ROUTING_TOMBSTONE_KIND,
        field: input.field,
      }
    : {
        schemaVersion: BEHAVIOR_ROUTING_SCHEMA_VERSION,
        kind: BEHAVIOR_ROUTING_RECORD_KIND,
        field: input.field,
        value: input.value as BehaviorRoutingFieldValue,
      };
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'behavior',
      type: 'logical-route',
      id: input.field,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: input.operation,
      schemaVersion: BEHAVIOR_ROUTING_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload,
    objectRefs: [],
    retentionClass: BEHAVIOR_ROUTING_RETENTION_CLASS,
  };
  assertBehaviorRoutingMutationV1(mutation);
  return mutation;
}
