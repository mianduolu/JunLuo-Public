import { canonicalizeContinuityMatterRecord } from '../ai/behavior/continuityMatterRecord';
import { getSyncEntityIdMaximumLength } from './syncProtocol';
import {
  BAIYUN_CONTINUITY_EVENT_KINDS,
  BAIYUN_CONTINUITY_EVENT_POLICIES,
  BAIYUN_CONTINUITY_EVENT_STAGES,
  BAIYUN_CONTINUITY_EVENT_STATUSES,
  BAIYUN_CONTINUITY_EVIDENCE_KINDS,
  canTransitionBaiyunContinuityEvent,
  type BaiyunContinuityEvent,
  type BaiyunContinuityEventKind,
  type BaiyunContinuityEventStage,
} from '../ai/behavior/continuityEvent';
import {
  isBaiyunActionIntentId,
  isBaiyunRetiredActionIntentId,
  isBaiyunStoredActionIntentId,
} from '../ai/behavior/actionIntent';

export const CONTINUITY_LEDGER_ADAPTER_ID = 'continuity.ledger' as const;
export const CONTINUITY_LEDGER_BOOTSTRAP_VERSION = 2 as const;

export const CONTINUITY_LEDGER_ENTITY_TYPES = [
  'continuity-event',
  'continuity-transition',
  'continuity-link',
  'continuity-candidate',
] as const;

const EVENT_KINDS = new Set<string>(BAIYUN_CONTINUITY_EVENT_KINDS);
const EVENT_STATUSES = new Set<string>(BAIYUN_CONTINUITY_EVENT_STATUSES);
const EVENT_STAGES = new Set<string>(
  Object.values(BAIYUN_CONTINUITY_EVENT_STAGES).flat(),
);
const EVIDENCE_KINDS = new Set<string>(BAIYUN_CONTINUITY_EVIDENCE_KINDS);
const TRANSITION_KINDS = new Set([
  'created',
  'merged',
  'transitioned',
  'evidence_recorded',
  'completed',
  'cancelled',
]);
const SOURCE_KINDS = new Set([
  'bedtime_care',
  'global_relationship',
  'real_care',
  'real_life',
  'real_tool_execution',
  'global_action_plan',
  'theater',
]);
const GLOBAL_SOURCE_KINDS = new Set([
  'global_relationship',
  'real_care',
  'real_life',
  'real_tool_execution',
  'global_action_plan',
]);
const LINK_RELATIONS = new Set([
  'source',
  'parent',
  'message',
  'tool',
  'device',
  'notification',
  'task',
  'memory',
  'current_state',
]);
const LAST_ATTEMPT_OUTCOMES = new Set(['succeeded', 'failed', 'blocked']);
const EVIDENCE_OUTCOMES = new Set(['succeeded', 'failed']);
const CANDIDATE_KINDS = new Set(['create_event', 'resolve_event']);
const CANDIDATE_STATES = new Set(['pending', 'accepted', 'dismissed', 'expired']);
const CANDIDATE_RESOLUTIONS = new Set(['progressed', 'completed', 'cancelled']);
const CANDIDATE_DETECTION_BASES = new Set(['local_explicit', 'semantic', 'combined']);

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
  const expectedSet = new Set(expected);
  const extra = Object.keys(record).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in record));
  if (extra.length || missing.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function assertString(value: unknown, label: string, maximumLength = 2048) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value;
}

function assertNullableString(
  value: unknown,
  label: string,
  maximumLength = 2048,
) {
  if (value === null) return null;
  return assertString(value, label, maximumLength);
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
) {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} 必须是安全整数。`);
  }
  return value as number;
}

function assertNullableTimestamp(value: unknown, label: string) {
  if (value === null) return null;
  return assertSafeInteger(value, label);
}

function parseJson(value: unknown, label: string) {
  const serialized = assertString(value, label, 64 * 1024);
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function assertStringArray(value: unknown, label: string) {
  if (
    !Array.isArray(value)
    || value.length > 128
    || value.some((entry) => (
      typeof entry !== 'string'
      || entry.length < 1
      || entry.length > 256
    ))
  ) {
    throw new Error(`${label} 必须是受限字符串数组。`);
  }
  if (new Set(value).size !== value.length) {
    throw new Error(`${label} 不能包含重复项。`);
  }
  return value as string[];
}

function assertEvidenceKindArray(value: unknown, label: string) {
  const entries = assertStringArray(value, label);
  if (entries.some((entry) => !EVIDENCE_KINDS.has(entry))) {
    throw new Error(`${label} 包含未知 evidence kind。`);
  }
  return entries;
}

function assertResumeCondition(value: unknown, label: string) {
  const condition = recordOf(value, label);
  const kind = assertString(condition.kind, `${label}.kind`, 80);
  if (kind === 'at_time') {
    assertExactKeys(condition, ['kind', 'dueAt'], label);
    assertSafeInteger(condition.dueAt, `${label}.dueAt`);
    return;
  }
  if (kind === 'after_duration') {
    assertExactKeys(condition, ['kind', 'dueAt', 'durationMs'], label);
    assertSafeInteger(condition.dueAt, `${label}.dueAt`);
    assertSafeInteger(condition.durationMs, `${label}.durationMs`, 1);
    return;
  }
  if (kind === 'after_you_response') {
    const keys = condition.sourceEventId === undefined
      ? ['kind']
      : ['kind', 'sourceEventId'];
    assertExactKeys(condition, keys, label);
    if (condition.sourceEventId !== undefined) {
      assertString(condition.sourceEventId, `${label}.sourceEventId`, 256);
    }
    return;
  }
  if (kind === 'after_observed_change') {
    assertExactKeys(condition, ['kind', 'observationCode'], label);
    assertString(condition.observationCode, `${label}.observationCode`, 256);
    return;
  }
  if (kind === 'after_permission_restored') {
    assertExactKeys(condition, ['kind', 'permissionCode'], label);
    assertString(condition.permissionCode, `${label}.permissionCode`, 256);
    return;
  }
  if (kind === 'manual_resume') {
    assertExactKeys(condition, ['kind'], label);
    return;
  }
  throw new Error(`${label}.kind 无效。`);
}

function assertGlobalBasis(value: unknown, label: string) {
  const basis = recordOf(value, label);
  assertExactKeys(basis, ['kind', 'sourceId'], label);
  const kind = assertString(basis.kind, `${label}.kind`, 80);
  if (!GLOBAL_SOURCE_KINDS.has(kind)) {
    throw new Error(`${label}.kind 无效。`);
  }
  assertString(basis.sourceId, `${label}.sourceId`, 512);
}

export function assertContinuityEventRecord(
  value: Record<string, unknown>,
) {
  const kind = assertString(value.kind, 'continuity event kind', 80);
  if (!EVENT_KINDS.has(kind)) throw new Error('continuity event kind 无效。');
  const typedKind = kind as BaiyunContinuityEventKind;
  const status = assertString(value.status, 'continuity event status', 40);
  if (!EVENT_STATUSES.has(status)) {
    throw new Error('continuity event status 无效。');
  }
  const stage = assertString(value.stage, 'continuity event stage', 80);
  if (!(BAIYUN_CONTINUITY_EVENT_STAGES[typedKind] as readonly string[]).includes(stage)) {
    throw new Error('continuity event stage 与 kind 不匹配。');
  }
  const subject = assertString(value.subject, 'continuity event subject', 8);
  if (subject !== 'I' && subject !== 'you') {
    throw new Error('continuity event subject 必须是 I / you。');
  }
  const returningSubject = assertNullableString(
    value.returning_subject,
    'continuity event returning_subject',
    8,
  );
  if (
    returningSubject !== null
    && returningSubject !== 'I'
    && returningSubject !== 'you'
  ) {
    throw new Error('continuity event returning_subject 必须是 I / you。');
  }
  const primaryIntent = assertNullableString(
    value.primary_intent,
    'continuity event primary_intent',
    80,
  );
  const activeIntentMatches = isBaiyunActionIntentId(primaryIntent)
    && (
      BAIYUN_CONTINUITY_EVENT_POLICIES[typedKind].allowedIntents as readonly string[]
    ).includes(primaryIntent);
  const retiredIntentMatches = isBaiyunRetiredActionIntentId(primaryIntent)
    && (
      typedKind === 'closeness_request'
      || typedKind === 'care_process'
      || typedKind === 'cross_day_life'
    );
  if (value.schema_version === 1 && !activeIntentMatches && !retiredIntentMatches) {
    throw new Error('continuity event primary_intent 与 kind 不匹配。');
  }
  assertString(value.id, 'continuity event id', 256);
  assertNullableString(value.parent_event_id, 'continuity event parent_event_id', 256);
  assertString(value.idempotency_key, 'continuity event idempotency_key', 512);
  assertNullableString(value.coalescing_key, 'continuity event coalescing_key', 512);
  if (value.focus_excerpt !== undefined) {
    assertNullableString(value.focus_excerpt, 'continuity event focus_excerpt', 60);
  }
  const sourceKind = assertString(value.source_kind, 'continuity event source_kind', 80);
  if (!SOURCE_KINDS.has(sourceKind)) {
    throw new Error('continuity event source_kind 无效。');
  }
  assertString(value.source_id, 'continuity event source_id', 512);
  if (sourceKind === 'theater') {
    if (value.source_global_basis_json === null) {
      throw new Error('theater continuity event 必须有 global basis。');
    }
    assertGlobalBasis(
      parseJson(
        value.source_global_basis_json,
        'continuity event source_global_basis_json',
      ),
      'continuity event global basis',
    );
  } else if (value.source_global_basis_json !== null) {
    throw new Error('非 theater continuity event 不得携带 global basis。');
  }
  assertSafeInteger(value.occurred_at, 'continuity event occurred_at');
  const localDate = assertString(
    value.occurred_local_date,
    'continuity event occurred_local_date',
    10,
  );
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error('continuity event occurred_local_date 无效。');
  }
  if (
    !Number.isSafeInteger(value.timezone_offset_minutes)
    || Math.abs(value.timezone_offset_minutes as number) > 24 * 60
  ) {
    throw new Error('continuity event timezone_offset_minutes 无效。');
  }
  assertNullableTimestamp(value.next_action_at, 'continuity event next_action_at');
  if (value.resume_condition_json !== null) {
    assertResumeCondition(
      parseJson(value.resume_condition_json, 'continuity event resume_condition_json'),
      'continuity event resume condition',
    );
  }
  if (value.schema_version === 1) assertStringArray(
    parseJson(value.required_behaviors_json, 'continuity event required_behaviors_json'),
    'continuity event required behaviors',
  );
  const completionRule = recordOf(
    parseJson(value.completion_rule_json, 'continuity event completion_rule_json'),
    'continuity event completion rule',
  );
  assertExactKeys(completionRule, ['allOf', 'anyOf'], 'continuity event completion rule');
  assertEvidenceKindArray(completionRule.allOf, 'continuity event completion allOf');
  assertEvidenceKindArray(completionRule.anyOf, 'continuity event completion anyOf');
  assertStringArray(
    parseJson(
      value.permission_requirements_json,
      'continuity event permission_requirements_json',
    ),
    'continuity event permission requirements',
  );
  assertSafeInteger(value.attempt_count, 'continuity event attempt_count');
  assertNullableTimestamp(value.last_attempt_at, 'continuity event last_attempt_at');
  const lastOutcome = assertNullableString(
    value.last_attempt_outcome,
    'continuity event last_attempt_outcome',
    40,
  );
  if (lastOutcome !== null && !LAST_ATTEMPT_OUTCOMES.has(lastOutcome)) {
    throw new Error('continuity event last_attempt_outcome 无效。');
  }
  assertNullableString(value.pause_reason_code, 'continuity event pause_reason_code', 256);
  assertNullableString(value.cancelled_reason, 'continuity event cancelled_reason', 256);
  assertSafeInteger(value.created_at, 'continuity event created_at');
  assertSafeInteger(value.updated_at, 'continuity event updated_at');
  const completedAt = assertNullableTimestamp(
    value.completed_at,
    'continuity event completed_at',
  );
  const cancelledAt = assertNullableTimestamp(
    value.cancelled_at,
    'continuity event cancelled_at',
  );
  if (status === 'completed' && completedAt === null) {
    throw new Error('completed continuity event 缺少 completed_at。');
  }
  if (status === 'cancelled' && cancelledAt === null) {
    throw new Error('cancelled continuity event 缺少 cancelled_at。');
  }
  assertSafeInteger(value.revision, 'continuity event revision', 1);
  if (value.schema_version !== 1 && value.schema_version !== 2 && value.schema_version !== 3) {
    throw new Error('continuity event schema_version 无效。');
  }
  if (value.schema_version === 3) {
    if (value.kind !== 'care_process' || value.source_kind !== 'real_care' || value.subject !== 'you'
      || !['open', 'waiting'].includes(value.status as string)
      || value.primary_intent !== null || value.required_behaviors_json !== null
      || value.item_name !== null || value.progress !== null || value.duration_ms !== null
      || value.care_time_sources_json !== null || value.next_action_at !== null) {
      throw new Error('continuity schema 3 只接受有原话依据的聊天牵挂。');
    }
  }
  const heartCare = value.schema_version === 2 && value.kind === 'care_process'
    && value.subject === 'you' && value.source_kind === 'real_care'
    && value.id === `body-care:${value.source_id}`
    && typeof value.coalescing_key === 'string' && value.coalescing_key.startsWith('heart-care:');
  if (value.schema_version === 3 || heartCare && value.care_evidence_json != null) {
    const evidence = recordOf(parseJson(value.care_evidence_json, 'continuity care evidence'), 'continuity care evidence');
    assertExactKeys(evidence, evidence.latest === undefined ? ['origin'] : ['origin', 'latest'], 'continuity care evidence');
    for (const raw of Object.values(evidence)) {
      const source = recordOf(raw, 'continuity care quote');
      assertExactKeys(source, ['sessionId', 'messageId', 'sentAt', 'quote'], 'continuity care quote');
      assertString(source.sessionId, 'continuity care sessionId', 512);
      assertString(source.messageId, 'continuity care messageId', 512);
      assertSafeInteger(source.sentAt, 'continuity care sentAt');
      if (!assertString(source.quote, 'continuity care quote', 64 * 1024).trim()) {
        throw new Error('continuity care quote 不能为空白。');
      }
    }
    const origin = evidence.origin as Record<string, unknown>;
    if (value.schema_version === 3 && (value.source_id !== origin.messageId || value.occurred_at !== origin.sentAt)) {
      throw new Error('continuity care origin 与来源不一致。');
    }
  } else if (value.care_evidence_json != null) {
    throw new Error('旧版 continuity event 不接受聊天牵挂原话。');
  }
  if (value.schema_version === 2) {
    if (value.primary_intent !== null || value.required_behaviors_json !== null) throw new Error('continuity schema 2 不接受旧行动标签。');
    assertNullableString(value.item_name, 'continuity item_name', 120);
    const progress = assertNullableString(value.progress, 'continuity progress', 32);
    if (progress === '准备休息') {
      if (value.source_kind !== 'bedtime_care' || value.subject !== 'you' || value.kind !== 'care_process'
        || value.status !== 'cancelled' || value.cancelled_reason !== 'you_preparing_rest') throw new Error('continuity rest progress 无效。');
    } else if (progress !== null && !['未开始', '进行中', '稍后再做', '暂停', '完成', '停止'].includes(progress)) throw new Error('continuity progress 无效。');
    assertNullableTimestamp(value.duration_ms, 'continuity duration_ms');
    if (value.care_time_sources_json !== null) {
      const sources = recordOf(parseJson(value.care_time_sources_json, 'continuity care_time_sources_json'), 'continuity time sources');
      if (Object.keys(sources).some((key) => key !== 'duration' && key !== 'contact')) throw new Error('continuity time source 无效。');
      for (const source of Object.values(sources)) {
        const evidence = recordOf(source, 'continuity time source');
        assertExactKeys(evidence, ['messageId', 'occurredAt'], 'continuity time source');
        assertString(evidence.messageId, 'continuity time source messageId', 512);
        assertSafeInteger(evidence.occurredAt, 'continuity time source occurredAt');
      }
    }
  }
  if (typedKind === 'return_commitment' && value.schema_version === 1) {
    if (
      value.parent_event_id === null
      && sourceKind !== 'global_action_plan'
    ) {
      throw new Error('return commitment 缺少 parent 或 action plan source。');
    }
    if (returningSubject === null || value.resume_condition_json === null) {
      throw new Error('return commitment 缺少 returning subject 或 resume condition。');
    }
  }
}

export function assertContinuityTransitionRecord(
  value: Record<string, unknown>,
) {
  assertString(value.id, 'continuity transition id', 256);
  assertString(value.operation_id, 'continuity transition operation_id', 512);
  assertString(value.event_id, 'continuity transition event_id', 256);
  const kind = assertString(
    value.transition_kind,
    'continuity transition kind',
    80,
  );
  if (!TRANSITION_KINDS.has(kind)) {
    throw new Error('continuity transition kind 无效。');
  }
  for (const field of ['from_status', 'to_status'] as const) {
    const status = assertNullableString(value[field], `continuity transition ${field}`, 40);
    if (status !== null && !EVENT_STATUSES.has(status)) {
      throw new Error(`continuity transition ${field} 无效。`);
    }
  }
  for (const field of ['from_stage', 'to_stage'] as const) {
    const stage = assertNullableString(value[field], `continuity transition ${field}`, 80);
    if (stage !== null && !EVENT_STAGES.has(stage)) {
      throw new Error(`continuity transition ${field} 无效。`);
    }
  }
  assertNullableString(value.reason_code, 'continuity transition reason_code', 256);
  const evidenceValues = [
    value.evidence_id,
    value.evidence_kind,
    value.evidence_source_id,
    value.evidence_outcome,
  ];
  const hasEvidence = evidenceValues.every((entry) => entry !== null);
  const hasPartialEvidence = evidenceValues.some((entry) => entry !== null);
  if (hasPartialEvidence && !hasEvidence) {
    throw new Error('continuity transition evidence 必须完整或全部为空。');
  }
  if (hasEvidence) {
    assertString(value.evidence_id, 'continuity transition evidence_id', 256);
    const evidenceKind = assertString(
      value.evidence_kind,
      'continuity transition evidence_kind',
      80,
    );
    if (!EVIDENCE_KINDS.has(evidenceKind)) {
      throw new Error('continuity transition evidence_kind 无效。');
    }
    assertString(
      value.evidence_source_id,
      'continuity transition evidence_source_id',
      512,
    );
    const outcome = assertString(
      value.evidence_outcome,
      'continuity transition evidence_outcome',
      40,
    );
    if (!EVIDENCE_OUTCOMES.has(outcome)) {
      throw new Error('continuity transition evidence_outcome 无效。');
    }
  }
  if (
    (kind === 'evidence_recorded' || kind === 'completed')
    && !hasEvidence
  ) {
    throw new Error('evidence/completed transition 缺少 evidence。');
  }
  assertSafeInteger(value.occurred_at, 'continuity transition occurred_at');
}

export function assertContinuityLinkRecord(
  value: Record<string, unknown>,
) {
  const eventId = assertString(value.event_id, 'continuity link event_id', 256);
  const relation = assertString(value.relation, 'continuity link relation', 80);
  if (!LINK_RELATIONS.has(relation)) {
    throw new Error('continuity link relation 无效。');
  }
  const targetKind = assertString(value.target_kind, 'continuity link target_kind', 160);
  const targetId = assertString(value.target_id, 'continuity link target_id', 512);
  const entityId = JSON.stringify([
    eventId,
    relation,
    targetKind,
    targetId,
  ]);
  if (entityId.length > getSyncEntityIdMaximumLength('memory', 'continuity-link')) {
    throw new Error('continuity link 复合实体 ID 超过同步协议上限。');
  }
  assertSafeInteger(value.created_at, 'continuity link created_at');
}

export function assertContinuityCandidateRecord(
  value: Record<string, unknown>,
) {
  assertString(value.id, 'continuity candidate id', 256);
  assertString(value.candidate_key, 'continuity candidate key', 512);
  const kind = assertString(value.candidate_kind, 'continuity candidate kind', 80);
  if (!CANDIDATE_KINDS.has(kind)) {
    throw new Error('continuity candidate kind 无效。');
  }
  const state = assertString(value.state, 'continuity candidate state', 80);
  if (!CANDIDATE_STATES.has(state)) {
    throw new Error('continuity candidate state 无效。');
  }
  const eventKind = assertNullableString(value.event_kind, 'continuity candidate event_kind', 80);
  if (eventKind !== null && !EVENT_KINDS.has(eventKind)) {
    throw new Error('continuity candidate event_kind 无效。');
  }
  const primaryIntent = assertNullableString(
    value.primary_intent,
    'continuity candidate primary_intent',
    80,
  );
  if (primaryIntent !== null && !isBaiyunStoredActionIntentId(primaryIntent)) {
    throw new Error('continuity candidate primary_intent 无效。');
  }
  const targetEventId = assertNullableString(
    value.target_event_id,
    'continuity candidate target_event_id',
    256,
  );
  const resolution = assertNullableString(
    value.proposed_resolution,
    'continuity candidate proposed_resolution',
    80,
  );
  if (resolution !== null && !CANDIDATE_RESOLUTIONS.has(resolution)) {
    throw new Error('continuity candidate proposed_resolution 无效。');
  }
  if (
    (kind === 'create_event' && (!eventKind || !primaryIntent || targetEventId || resolution))
    || (kind === 'resolve_event' && (!targetEventId || !resolution || eventKind || primaryIntent))
  ) {
    throw new Error('continuity candidate 类型与目标字段不匹配。');
  }
  assertString(value.session_id, 'continuity candidate session_id', 256);
  assertString(value.message_id, 'continuity candidate message_id', 256);
  const basis = assertString(value.detection_basis, 'continuity candidate detection_basis', 80);
  if (!CANDIDATE_DETECTION_BASES.has(basis)) {
    throw new Error('continuity candidate detection_basis 无效。');
  }
  if (
    typeof value.confidence !== 'number'
    || !Number.isFinite(value.confidence)
    || value.confidence < 0
    || value.confidence > 1
  ) {
    throw new Error('continuity candidate confidence 无效。');
  }
  assertStringArray(
    parseJson(value.reason_codes_json, 'continuity candidate reason_codes_json'),
    'continuity candidate reason_codes_json',
  );
  assertNullableString(value.coalescing_key, 'continuity candidate coalescing_key', 512);
  assertNullableString(value.result_event_id, 'continuity candidate result_event_id', 256);
  assertSafeInteger(value.occurred_at, 'continuity candidate occurred_at');
  assertSafeInteger(value.expires_at, 'continuity candidate expires_at');
  assertNullableTimestamp(value.resolved_at, 'continuity candidate resolved_at');
  assertSafeInteger(value.created_at, 'continuity candidate created_at');
  assertSafeInteger(value.updated_at, 'continuity candidate updated_at');
  assertSafeInteger(value.revision, 'continuity candidate revision', 1);
  assertSafeInteger(value.schema_version, 'continuity candidate schema_version', 1);
  if (
    (state === 'pending' && value.resolved_at !== null)
    || (state !== 'pending' && value.resolved_at === null)
  ) {
    throw new Error('continuity candidate state 与 resolved_at 不匹配。');
  }
}

const IMMUTABLE_EVENT_FIELDS = [
  'id',
  'kind',
  'subject',
  'returning_subject',
  'primary_intent',
  'parent_event_id',
  'idempotency_key',
  'coalescing_key',
  'focus_excerpt',
  'source_kind',
  'source_id',
  'source_global_basis_json',
  'occurred_at',
  'occurred_local_date',
  'timezone_offset_minutes',
  'completion_rule_json',
  'created_at',
  'schema_version',
] as const;

function assertAppendOnlyJsonStringArray(
  current: unknown,
  incoming: unknown,
  label: string,
) {
  const currentItems = assertStringArray(parseJson(current, label), label);
  const incomingItems = assertStringArray(parseJson(incoming, label), label);
  const incomingSet = new Set(incomingItems);
  if (currentItems.some((item) => !incomingSet.has(item))) {
    throw new Error(`${label} 不能删除既有项。`);
  }
}

export function assertContinuityEventRecordSuccessor(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  assertContinuityEventRecord(current);
  assertContinuityEventRecord(incoming);
  const legacyRules = current.schema_version === 1 && incoming.schema_version === 1
    ? [current.completion_rule_json, incoming.completion_rule_json] : null;
  current = canonicalizeContinuityMatterRecord(current);
  incoming = canonicalizeContinuityMatterRecord(incoming);
  if (current.care_evidence_json != null) {
    if (incoming.care_evidence_json == null) throw new Error('continuity care 最初依据不能被清空。');
    const currentOrigin = recordOf(parseJson(current.care_evidence_json, 'current care evidence'), 'current care evidence').origin;
    const incomingOrigin = recordOf(parseJson(incoming.care_evidence_json, 'incoming care evidence'), 'incoming care evidence').origin;
    for (const field of ['sessionId', 'messageId', 'sentAt', 'quote']) {
      if (recordOf(currentOrigin, 'current care origin')[field] !== recordOf(incomingOrigin, 'incoming care origin')[field]) {
        throw new Error('continuity care 最初依据不能被覆盖。');
      }
    }
  }
  for (const field of IMMUTABLE_EVENT_FIELDS) {
    const currentValue = field === 'completion_rule_json' && legacyRules ? legacyRules[0] : field === 'focus_excerpt' ? current[field] ?? null : current[field];
    const incomingValue = field === 'completion_rule_json' && legacyRules ? legacyRules[1] : field === 'focus_excerpt' ? incoming[field] ?? null : incoming[field];
    if (currentValue !== incomingValue) {
      throw new Error(`continuity event 不可变字段被修改：${field}。`);
    }
  }
  const currentRevision = assertSafeInteger(
    current.revision,
    'current continuity revision',
    1,
  );
  const incomingRevision = assertSafeInteger(
    incoming.revision,
    'incoming continuity revision',
    1,
  );
  if (incomingRevision !== currentRevision + 1) {
    throw new Error('continuity event 业务 revision 必须逐次递增。');
  }
  if ((incoming.updated_at as number) < (current.updated_at as number)) {
    throw new Error('continuity event updated_at 不能倒退。');
  }
  if (current.status === 'completed' || current.status === 'cancelled') {
    throw new Error('continuity event 终态不能产生后继 revision。');
  }
  if (incoming.stage !== current.stage) {
    const currentEvent = {
      kind: current.kind,
      status: current.status,
      stage: current.stage,
    } as BaiyunContinuityEvent;
    if (!canTransitionBaiyunContinuityEvent(
      currentEvent,
      incoming.stage as BaiyunContinuityEventStage,
    )) {
      throw new Error('continuity event stage 迁移不合法。');
    }
  }
  if (incoming.schema_version === 1) assertAppendOnlyJsonStringArray(
    current.required_behaviors_json,
    incoming.required_behaviors_json,
    'continuity event required behaviors',
  );
  assertAppendOnlyJsonStringArray(
    current.permission_requirements_json,
    incoming.permission_requirements_json,
    'continuity event permission requirements',
  );
  if ((incoming.attempt_count as number) < (current.attempt_count as number)) {
    throw new Error('continuity event attempt_count 不能倒退。');
  }
}
