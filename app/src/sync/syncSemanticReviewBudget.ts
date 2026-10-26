import type {
  BaiyunSemanticReviewEntry,
  BaiyunSemanticReviewOutcome,
} from '../ai/behavior/actionBudget';
import { BAIYUN_SEMANTIC_SIGNAL_KINDS } from '../ai/behavior/actionSemantic';
import type { ChatCoreMutationEnvelope } from './syncChatCore';
import {
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const SEMANTIC_REVIEW_BUDGET_ADAPTER_ID =
  'usage.semantic-review-budget' as const;
export const SEMANTIC_REVIEW_BUDGET_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_REVIEW_BUDGET_RETENTION_CLASS =
  'semantic-review-budget-ledger' as const;
export const SEMANTIC_REVIEW_BUDGET_RECORD_KIND =
  'semantic-review-entry' as const;

export const SEMANTIC_REVIEW_OUTCOMES = Object.freeze([
  'request_started',
  'accepted',
  'insufficient_evidence',
  'invalid_response',
  'request_failed',
  'budget_blocked',
] as const satisfies readonly BaiyunSemanticReviewOutcome[]);

export const SEMANTIC_REVIEW_AMBIGUITY_REASONS = Object.freeze([
  'conflicting_candidates',
  'close_candidate_scores',
  'negation_scope',
  'double_negation',
  'hypothetical_or_conditional',
  'quotation_or_reported_speech',
  'ellipsis_or_reference',
  'possible_irony',
  'current_context_conflict',
  'open_event_conflict',
  'weak_sensitive_evidence',
  'unclear_boundary_target',
] as const);

export type SemanticReviewLedgerRecord = {
  localDate: string;
  remoteAccountId: string;
  entry: BaiyunSemanticReviewEntry;
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
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !(key in value));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
) {
  if (
    typeof value !== 'string'
    || (!allowEmpty && value.length < 1)
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 字符串长度无效。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertEnumArray(
  value: unknown,
  allowed: readonly string[],
  label: string,
  maximumCount: number,
) {
  if (!Array.isArray(value) || value.length > maximumCount) {
    throw new Error(`${label} 数组长度无效。`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      throw new Error(`${label} 包含未知值。`);
    }
  }
}

function assertConfidenceArray(value: unknown) {
  if (
    !Array.isArray(value)
    || value.length > BAIYUN_SEMANTIC_SIGNAL_KINDS.length
    || value.some((item) => (
      typeof item !== 'number'
      || !Number.isFinite(item)
      || item < 0
      || item > 1
    ))
  ) {
    throw new Error('semantic review confidences 无效。');
  }
}

export function assertSemanticReviewEntry(
  value: unknown,
): asserts value is BaiyunSemanticReviewEntry {
  const entry = recordOf(value, 'semantic review entry');
  assertJsonValue(entry);
  assertKeys(
    entry,
    [
      'id',
      'fingerprint',
      'currentMessageId',
      'attemptedAt',
      'ambiguityReasons',
      'outcome',
      'signalKinds',
      'confidences',
    ],
    [
      'connectionId',
      'connectionName',
      'model',
      'summary',
      'durationMs',
    ],
    'semantic review entry',
  );
  assertString(entry.id, 'semantic review entry id', 180);
  assertString(entry.fingerprint, 'semantic review fingerprint', 512);
  assertString(entry.currentMessageId, 'semantic review message id', 256);
  assertTimestamp(entry.attemptedAt, 'semantic review attemptedAt');
  assertEnumArray(
    entry.ambiguityReasons,
    SEMANTIC_REVIEW_AMBIGUITY_REASONS,
    'semantic review ambiguityReasons',
    SEMANTIC_REVIEW_AMBIGUITY_REASONS.length,
  );
  if (
    typeof entry.outcome !== 'string'
    || !SEMANTIC_REVIEW_OUTCOMES.includes(
      entry.outcome as BaiyunSemanticReviewOutcome,
    )
  ) {
    throw new Error('semantic review outcome 无效。');
  }
  assertEnumArray(
    entry.signalKinds,
    BAIYUN_SEMANTIC_SIGNAL_KINDS,
    'semantic review signalKinds',
    BAIYUN_SEMANTIC_SIGNAL_KINDS.length,
  );
  assertConfidenceArray(entry.confidences);
  if (
    (entry.signalKinds as unknown[]).length
    !== (entry.confidences as unknown[]).length
  ) {
    throw new Error('semantic review signalKinds/confidences 长度不一致。');
  }
  if (entry.connectionId !== undefined) {
    assertString(entry.connectionId, 'semantic review connectionId', 256);
  }
  if (entry.connectionName !== undefined) {
    assertString(entry.connectionName, 'semantic review connectionName', 512);
  }
  if (entry.model !== undefined) {
    assertString(entry.model, 'semantic review model', 512);
  }
  if (entry.summary !== undefined) {
    assertString(entry.summary, 'semantic review summary', 256);
  }
  if (
    entry.durationMs !== undefined
    && (
      !Number.isSafeInteger(entry.durationMs)
      || Number(entry.durationMs) < 0
    )
  ) {
    throw new Error('semantic review durationMs 无效。');
  }
}

export function semanticReviewBudgetEntityId(
  sourceDeviceId: string,
  entryId: string,
) {
  const id = `${sourceDeviceId}:${entryId}`;
  if (id.length > 256) {
    throw new Error('semantic review global entity id 超过 256 字符。');
  }
  return id;
}

export function assertSemanticReviewBudgetMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (
    value.entity.domain !== 'usage'
    || value.entity.type !== 'semantic-review-budget'
  ) {
    throw new Error('usage.semantic-review-budget mutation entity 无效。');
  }
  if (value.revision.schemaVersion !== SEMANTIC_REVIEW_BUDGET_SCHEMA_VERSION) {
    throw new Error('usage.semantic-review-budget schemaVersion 无效。');
  }
  if (value.revision.operation !== 'upsert') {
    throw new Error('usage.semantic-review-budget 只接受 append ledger upsert。');
  }
  if (value.sensitivity !== 'high') {
    throw new Error('usage.semantic-review-budget sensitivity 必须为 high。');
  }
  if (value.retentionClass !== SEMANTIC_REVIEW_BUDGET_RETENTION_CLASS) {
    throw new Error('usage.semantic-review-budget retentionClass 无效。');
  }
  if (value.objectRefs.length) {
    throw new Error('usage.semantic-review-budget 不接受对象引用。');
  }
  const payload = recordOf(
    value.payload,
    'usage.semantic-review-budget payload',
  );
  assertKeys(
    payload,
    ['schemaVersion', 'kind', 'localDate', 'remoteAccountId', 'entry'],
    [],
    'usage.semantic-review-budget payload',
  );
  if (payload.schemaVersion !== SEMANTIC_REVIEW_BUDGET_SCHEMA_VERSION) {
    throw new Error('usage.semantic-review-budget payload schemaVersion 无效。');
  }
  if (payload.kind !== SEMANTIC_REVIEW_BUDGET_RECORD_KIND) {
    throw new Error('usage.semantic-review-budget kind 无效。');
  }
  if (
    typeof payload.localDate !== 'string'
    || !/^\d{4}-\d{2}-\d{2}$/u.test(payload.localDate)
  ) {
    throw new Error('usage.semantic-review-budget localDate 无效。');
  }
  assertString(
    payload.remoteAccountId,
    'semantic review remoteAccountId',
    256,
  );
  assertSemanticReviewEntry(payload.entry);
  const entry = payload.entry as BaiyunSemanticReviewEntry;
  if (entry.connectionId !== payload.remoteAccountId) {
    throw new Error('semantic review connectionId 与 remoteAccountId 不一致。');
  }
  if (
    value.entity.id
    !== semanticReviewBudgetEntityId(value.sourceDeviceId, entry.id)
  ) {
    throw new Error('semantic review entity id 与来源设备／entry 不一致。');
  }
}

export function buildSemanticReviewBudgetMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  localDate: string;
  remoteAccountId: string;
  entry: BaiyunSemanticReviewEntry;
}) {
  const entityId = semanticReviewBudgetEntityId(
    input.envelope.sourceDeviceId,
    input.entry.id,
  );
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'usage',
      type: 'semantic-review-budget',
      id: entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: input.envelope.parentRevisionIds,
      operation: 'upsert',
      schemaVersion: SEMANTIC_REVIEW_BUDGET_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: {
      schemaVersion: SEMANTIC_REVIEW_BUDGET_SCHEMA_VERSION,
      kind: SEMANTIC_REVIEW_BUDGET_RECORD_KIND,
      localDate: input.localDate,
      remoteAccountId: input.remoteAccountId,
      entry: input.entry as unknown as JsonValue,
    },
    objectRefs: [],
    retentionClass: SEMANTIC_REVIEW_BUDGET_RETENTION_CLASS,
  };
  assertSemanticReviewBudgetMutationV1(mutation);
  return mutation;
}

export function semanticReviewLedgerRecordFromMutation(
  mutation: PlainMutationV1,
): SemanticReviewLedgerRecord {
  assertSemanticReviewBudgetMutationV1(mutation);
  const payload = mutation.payload as unknown as {
    localDate: string;
    remoteAccountId: string;
    entry: BaiyunSemanticReviewEntry;
  };
  return {
    localDate: payload.localDate,
    remoteAccountId: payload.remoteAccountId,
    entry: payload.entry,
  };
}
