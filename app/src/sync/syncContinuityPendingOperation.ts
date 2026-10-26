import {
  BAIYUN_CONTINUITY_EVENT_KINDS,
  BAIYUN_CONTINUITY_EVENT_STAGES,
  BAIYUN_CONTINUITY_EVIDENCE_KINDS,
  validateBaiyunContinuityEvent,
  type BaiyunContinuityEvent,
} from '../ai/behavior/continuityEvent';
import {
  assertJsonValue,
  type JsonValue,
} from './syncProtocol';

export const CONTINUITY_PENDING_OPERATION_ADAPTER_ID =
  'continuity.pending-operation' as const;
export const CONTINUITY_PENDING_OPERATION_ENTITY_TYPE =
  'pending-operation' as const;
export const CONTINUITY_PENDING_OPERATION_JOURNAL_VERSION = 1 as const;
export const CONTINUITY_PENDING_OPERATION_STORAGE_KEY =
  'junluo.baiyunBehavior.continuity.pendingOperation.v1' as const;

export const CONTINUITY_PENDING_OPERATION_JOURNAL_STATES = [
  'prepared',
  'applying',
  'committed',
] as const;

export type ContinuityPendingOperationJournalState =
  typeof CONTINUITY_PENDING_OPERATION_JOURNAL_STATES[number];

export type ContinuityPendingOperationJournalV1 = {
  journalVersion: typeof CONTINUITY_PENDING_OPERATION_JOURNAL_VERSION;
  adapterId: typeof CONTINUITY_PENDING_OPERATION_ADAPTER_ID;
  entityType: typeof CONTINUITY_PENDING_OPERATION_ENTITY_TYPE;
  operationId: string;
  state: ContinuityPendingOperationJournalState;
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  logicalMutation: JsonValue;
};

const OPERATION_TYPES = new Set([
  'care_matter',
  'create',
  'transition',
  'evidence',
  'cancel',
  'advance_due',
  'clear_acceptance',
]);
const EVENT_KINDS = new Set<string>(BAIYUN_CONTINUITY_EVENT_KINDS);
const EVENT_STAGES = new Set<string>(
  Object.values(BAIYUN_CONTINUITY_EVENT_STAGES).flat(),
);
const EVIDENCE_KINDS = new Set<string>(BAIYUN_CONTINUITY_EVIDENCE_KINDS);
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
const JOURNAL_STATES = new Set<string>(
  CONTINUITY_PENDING_OPERATION_JOURNAL_STATES,
);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
) {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    throw new Error(`${label} 字段集合无效。`);
  }
}

function assertString(
  value: unknown,
  label: string,
  maximumLength = 512,
) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 必须是非空字符串。`);
  }
  return value;
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

function assertOptionalSafeInteger(value: unknown, label: string) {
  if (value !== undefined) assertSafeInteger(value, label);
}

function assertOptionalString(value: unknown, label: string) {
  if (value !== undefined) assertString(value, label);
}

function assertEvent(value: unknown) {
  const event = recordOf(value, 'pending continuity create event');
  assertJsonValue(event, 'pending continuity create event');
  assertString(event.id, 'pending continuity event id', 256);
  const kind = assertString(event.kind, 'pending continuity event kind', 80);
  if (!EVENT_KINDS.has(kind)) {
    throw new Error('pending continuity event kind 无效。');
  }
  assertSafeInteger(event.createdAt, 'pending continuity event createdAt');
  assertSafeInteger(event.updatedAt, 'pending continuity event updatedAt');
  assertSafeInteger(event.revision, 'pending continuity event revision', 1);
  if (event.schemaVersion !== 1 && event.schemaVersion !== 2) {
    throw new Error('pending continuity event schemaVersion 无效。');
  }
  validateBaiyunContinuityEvent(event as unknown as BaiyunContinuityEvent);
  return event;
}

function assertLinks(value: unknown, eventId: string) {
  if (!Array.isArray(value) || value.length > 256) {
    throw new Error('pending continuity links 必须是受限数组。');
  }
  for (const entry of value) {
    const link = recordOf(entry, 'pending continuity link');
    assertExactKeys(
      link,
      ['eventId', 'relation', 'targetKind', 'targetId', 'createdAt'],
      [],
      'pending continuity link',
    );
    if (assertString(link.eventId, 'pending continuity link eventId', 256) !== eventId) {
      throw new Error('pending continuity link eventId 与 create event 不一致。');
    }
    const relation = assertString(
      link.relation,
      'pending continuity link relation',
      80,
    );
    if (!LINK_RELATIONS.has(relation)) {
      throw new Error('pending continuity link relation 无效。');
    }
    assertString(link.targetKind, 'pending continuity link targetKind', 160);
    assertString(link.targetId, 'pending continuity link targetId', 512);
    assertSafeInteger(link.createdAt, 'pending continuity link createdAt');
  }
}

function assertResumeCondition(value: unknown) {
  if (value === undefined) return;
  assertJsonValue(value, 'pending continuity resume condition');
  const condition = recordOf(value, 'pending continuity resume condition');
  assertString(condition.kind, 'pending continuity resume condition kind', 80);
}

function assertEvidence(value: unknown) {
  const evidence = recordOf(value, 'pending continuity evidence');
  assertExactKeys(
    evidence,
    ['id', 'kind', 'sourceId', 'occurredAt', 'outcome'],
    [],
    'pending continuity evidence',
  );
  assertString(evidence.id, 'pending continuity evidence id', 256);
  const kind = assertString(
    evidence.kind,
    'pending continuity evidence kind',
    80,
  );
  if (!EVIDENCE_KINDS.has(kind)) {
    throw new Error('pending continuity evidence kind 无效。');
  }
  assertString(evidence.sourceId, 'pending continuity evidence sourceId', 512);
  assertSafeInteger(
    evidence.occurredAt,
    'pending continuity evidence occurredAt',
  );
  if (evidence.outcome !== 'succeeded' && evidence.outcome !== 'failed') {
    throw new Error('pending continuity evidence outcome 无效。');
  }
}

export function assertContinuityPendingOperationLogicalMutation(
  value: unknown,
): asserts value is JsonValue {
  assertJsonValue(value, 'continuity pending logical mutation');
  const operation = recordOf(value, 'continuity pending logical mutation');
  if (operation.version !== 1) {
    throw new Error('continuity pending logical mutation version 无效。');
  }
  const type = assertString(
    operation.type,
    'continuity pending logical mutation type',
    40,
  );
  if (!OPERATION_TYPES.has(type)) {
    throw new Error('continuity pending logical mutation type 无效。');
  }
  assertString(
    operation.operationId,
    'continuity pending logical mutation operationId',
    512,
  );

  if (type === 'care_matter') {
    assertExactKeys(operation, ['version', 'type', 'formatVersion', 'operationId', 'sessionId', 'update', 'occurredAt', 'allowNew'], [], 'continuity care matter operation');
    if (operation.formatVersion !== 3 || typeof operation.allowNew !== 'boolean') throw new Error('care_matter_invalid_format');
    assertString(operation.sessionId, 'care matter sessionId');
    assertSafeInteger(operation.occurredAt, 'care matter occurredAt');
    const update = recordOf(operation.update, 'care matter update');
    assertExactKeys(update, ['sourceMessageId', 'occurredAt', 'quote', 'state'], ['eventId', 'expectedRevision'], 'care matter update');
    assertString(update.sourceMessageId, 'care matter sourceMessageId');
    assertSafeInteger(update.occurredAt, 'care matter source occurredAt');
    if (typeof update.quote !== 'string' || !update.quote.trim()) throw new Error('care_matter_invalid_quote');
    if (update.state !== '继续' && update.state !== '结束') throw new Error('care_matter_invalid_state');
    assertOptionalString(update.eventId, 'care matter eventId');
    assertOptionalSafeInteger(update.expectedRevision, 'care matter revision');
    return;
  }
  if (type === 'create') {
    assertExactKeys(
      operation,
      ['version', 'type', 'operationId', 'event', 'links'],
      [],
      'continuity create operation',
    );
    const event = assertEvent(operation.event);
    assertLinks(operation.links, event.id as string);
    return;
  }
  if (type === 'transition') {
    assertExactKeys(
      operation,
      [
        'version',
        'type',
        'operationId',
        'eventId',
        'expectedRevision',
        'nextStage',
        'reasonCode',
        'occurredAt',
      ],
      ['nextStatus', 'nextActionAt', 'resumeCondition'],
      'continuity transition operation',
    );
    assertString(operation.eventId, 'continuity transition eventId', 256);
    assertSafeInteger(
      operation.expectedRevision,
      'continuity transition expectedRevision',
      1,
    );
    const nextStage = assertString(
      operation.nextStage,
      'continuity transition nextStage',
      80,
    );
    if (!EVENT_STAGES.has(nextStage)) {
      throw new Error('continuity transition nextStage 无效。');
    }
    if (
      operation.nextStatus !== undefined
      && operation.nextStatus !== 'open'
      && operation.nextStatus !== 'waiting'
    ) {
      throw new Error('continuity transition nextStatus 无效。');
    }
    assertString(operation.reasonCode, 'continuity transition reasonCode', 256);
    assertSafeInteger(operation.occurredAt, 'continuity transition occurredAt');
    assertOptionalSafeInteger(
      operation.nextActionAt,
      'continuity transition nextActionAt',
    );
    assertResumeCondition(operation.resumeCondition);
    return;
  }
  if (type === 'evidence') {
    assertExactKeys(
      operation,
      [
        'version',
        'type',
        'operationId',
        'eventId',
        'expectedRevision',
        'evidence',
      ],
      ['nextStage', 'nextStatus', 'reasonCode', 'nextActionAt'],
      'continuity evidence operation',
    );
    assertString(operation.eventId, 'continuity evidence eventId', 256);
    assertSafeInteger(
      operation.expectedRevision,
      'continuity evidence expectedRevision',
      1,
    );
    assertEvidence(operation.evidence);
    if (operation.nextStage !== undefined) {
      const nextStage = assertString(
        operation.nextStage,
        'continuity evidence nextStage',
        80,
      );
      if (!EVENT_STAGES.has(nextStage)) {
        throw new Error('continuity evidence nextStage 无效。');
      }
    }
    if (
      operation.nextStatus !== undefined
      && operation.nextStatus !== 'open'
      && operation.nextStatus !== 'waiting'
    ) {
      throw new Error('continuity evidence nextStatus 无效。');
    }
    assertOptionalString(operation.reasonCode, 'continuity evidence reasonCode');
    assertOptionalSafeInteger(
      operation.nextActionAt,
      'continuity evidence nextActionAt',
    );
    return;
  }
  if (type === 'cancel') {
    assertExactKeys(
      operation,
      [
        'version',
        'type',
        'operationId',
        'eventId',
        'expectedRevision',
        'reasonCode',
        'occurredAt',
      ],
      [],
      'continuity cancel operation',
    );
    assertString(operation.eventId, 'continuity cancel eventId', 256);
    assertSafeInteger(
      operation.expectedRevision,
      'continuity cancel expectedRevision',
      1,
    );
    assertString(operation.reasonCode, 'continuity cancel reasonCode', 256);
    assertSafeInteger(operation.occurredAt, 'continuity cancel occurredAt');
    return;
  }
  if (type === 'advance_due') {
    assertExactKeys(
      operation,
      ['version', 'type', 'operationId', 'now'],
      [],
      'continuity advance_due operation',
    );
    assertSafeInteger(operation.now, 'continuity advance_due now');
    return;
  }
  assertExactKeys(
    operation,
    ['version', 'type', 'operationId', 'occurredAt'],
    [],
    'continuity clear_acceptance operation',
  );
  assertSafeInteger(
    operation.occurredAt,
    'continuity clear_acceptance occurredAt',
  );
}

export function normalizeContinuityPendingLogicalMutation(
  value: unknown,
): JsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error('continuity pending logical mutation 无法序列化。');
  }
  const normalized = JSON.parse(serialized) as unknown;
  assertContinuityPendingOperationLogicalMutation(normalized);
  return normalized;
}

export function assertContinuityPendingOperationJournalV1(
  value: unknown,
): asserts value is ContinuityPendingOperationJournalV1 {
  const journal = recordOf(value, 'continuity pending operation journal');
  assertExactKeys(
    journal,
    [
      'journalVersion',
      'adapterId',
      'entityType',
      'operationId',
      'state',
      'attemptCount',
      'createdAt',
      'updatedAt',
      'logicalMutation',
    ],
    [],
    'continuity pending operation journal',
  );
  if (
    journal.journalVersion !== CONTINUITY_PENDING_OPERATION_JOURNAL_VERSION
    || journal.adapterId !== CONTINUITY_PENDING_OPERATION_ADAPTER_ID
    || journal.entityType !== CONTINUITY_PENDING_OPERATION_ENTITY_TYPE
  ) {
    throw new Error('continuity pending operation journal identity 无效。');
  }
  const operationId = assertString(
    journal.operationId,
    'continuity pending operation journal operationId',
    512,
  );
  const state = assertString(
    journal.state,
    'continuity pending operation journal state',
    40,
  );
  if (!JOURNAL_STATES.has(state)) {
    throw new Error('continuity pending operation journal state 无效。');
  }
  assertSafeInteger(
    journal.attemptCount,
    'continuity pending operation journal attemptCount',
  );
  const createdAt = assertSafeInteger(
    journal.createdAt,
    'continuity pending operation journal createdAt',
  );
  const updatedAt = assertSafeInteger(
    journal.updatedAt,
    'continuity pending operation journal updatedAt',
  );
  if (updatedAt < createdAt) {
    throw new Error('continuity pending operation journal updatedAt 倒退。');
  }
  assertContinuityPendingOperationLogicalMutation(journal.logicalMutation);
  const logicalOperation = journal.logicalMutation as Record<string, JsonValue>;
  if (logicalOperation.operationId !== operationId) {
    throw new Error('continuity pending journal 与 logical mutation operationId 不一致。');
  }
}

export function buildContinuityPendingOperationJournal(input: {
  logicalMutation: unknown;
  createdAt: number;
}): ContinuityPendingOperationJournalV1 {
  const logicalMutation = normalizeContinuityPendingLogicalMutation(
    input.logicalMutation,
  );
  const operationId = (
    logicalMutation as Record<string, JsonValue>
  ).operationId as string;
  const journal: ContinuityPendingOperationJournalV1 = {
    journalVersion: CONTINUITY_PENDING_OPERATION_JOURNAL_VERSION,
    adapterId: CONTINUITY_PENDING_OPERATION_ADAPTER_ID,
    entityType: CONTINUITY_PENDING_OPERATION_ENTITY_TYPE,
    operationId,
    state: 'prepared',
    attemptCount: 0,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    logicalMutation,
  };
  assertContinuityPendingOperationJournalV1(journal);
  return journal;
}

function assertSameJournalIdentity(
  current: ContinuityPendingOperationJournalV1,
  incoming: ContinuityPendingOperationJournalV1,
) {
  if (
    current.operationId !== incoming.operationId
    || current.createdAt !== incoming.createdAt
    || JSON.stringify(current.logicalMutation)
      !== JSON.stringify(incoming.logicalMutation)
  ) {
    throw new Error('continuity pending operation journal identity 被修改。');
  }
}

export function assertContinuityPendingOperationJournalSuccessor(
  current: ContinuityPendingOperationJournalV1,
  incoming: ContinuityPendingOperationJournalV1,
) {
  assertContinuityPendingOperationJournalV1(current);
  assertContinuityPendingOperationJournalV1(incoming);
  assertSameJournalIdentity(current, incoming);
  const allowed = (
    current.state === 'prepared' && incoming.state === 'applying'
  ) || (
    current.state === 'applying'
    && (incoming.state === 'applying' || incoming.state === 'committed')
  );
  if (!allowed) {
    throw new Error('continuity pending operation journal 状态迁移无效。');
  }
  const expectedAttempts = incoming.state === 'applying'
    ? current.attemptCount + 1
    : current.attemptCount;
  if (incoming.attemptCount !== expectedAttempts) {
    throw new Error('continuity pending operation journal attemptCount 无效。');
  }
  if (incoming.updatedAt < current.updatedAt) {
    throw new Error('continuity pending operation journal updatedAt 倒退。');
  }
}

export function beginContinuityPendingOperationAttempt(
  current: ContinuityPendingOperationJournalV1,
  updatedAt: number,
) {
  if (current.state === 'committed') {
    throw new Error('已提交 continuity pending operation 不能再次执行。');
  }
  const incoming: ContinuityPendingOperationJournalV1 = {
    ...current,
    state: 'applying',
    attemptCount: current.attemptCount + 1,
    updatedAt,
  };
  assertContinuityPendingOperationJournalSuccessor(current, incoming);
  return incoming;
}

export function markContinuityPendingOperationCommitted(
  current: ContinuityPendingOperationJournalV1,
  updatedAt: number,
) {
  if (current.state !== 'applying') {
    throw new Error('continuity pending operation 只能从 applying 提交。');
  }
  const incoming: ContinuityPendingOperationJournalV1 = {
    ...current,
    state: 'committed',
    updatedAt,
  };
  assertContinuityPendingOperationJournalSuccessor(current, incoming);
  return incoming;
}

export function parseContinuityPendingOperationJournal(
  serialized: string,
) {
  const parsed = JSON.parse(serialized) as unknown;
  assertContinuityPendingOperationJournalV1(parsed);
  return parsed;
}

export function serializeContinuityPendingOperationJournal(
  journal: ContinuityPendingOperationJournalV1,
) {
  assertContinuityPendingOperationJournalV1(journal);
  return JSON.stringify(journal);
}
