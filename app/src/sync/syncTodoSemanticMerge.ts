import {
  assertTodoSemanticMutationV1,
  preserveOwnHabitFields,
  todoSemanticPayload,
  type TodoSemanticPayloadV1,
  type TodoSemanticRecordKind,
} from './syncTodoSemantic';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type TodoSemanticRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type TodoSemanticConflictKind =
  | 'todo-delete-modify'
  | 'todo-record-divergence'
  | 'todo-state-divergence'
  | 'todo-progress-divergence'
  | 'todo-review-divergence'
  | 'todo-execution-divergence';

export type TodoSemanticMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'ignore-incoming'
    | 'merged'
    | 'conflict';
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
  resultingHeadRevisionIds: string[];
  conflictKind?: TodoSemanticConflictKind;
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

type MergeRecordResult =
  | { kind: 'merged'; record: Record<string, JsonValue> }
  | {
      kind: 'conflict';
      conflictKind: TodoSemanticConflictKind;
      conflictingFields: string[];
    };

function mutationOf(revision: TodoSemanticRevisionValue): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'todo',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: [...revision.parentRevisionIds],
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'todo-semantic',
  };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function recordPayload(payload: TodoSemanticPayloadV1) {
  if (!('record' in payload)) {
    throw new Error('todo.semantic 当前 revision 不是 record payload。');
  }
  return payload.record as Record<string, JsonValue>;
}

function mergedPayload(
  payload: TodoSemanticPayloadV1,
  record: Record<string, JsonValue>,
) {
  if (!('record' in payload)) {
    throw new Error('todo.semantic 无法为 delete payload 生成 record merge。');
  }
  return {
    schemaVersion: payload.schemaVersion,
    kind: payload.kind,
    record,
  } satisfies TodoSemanticPayloadV1;
}

function changedFields(
  left: Record<string, JsonValue>,
  right: Record<string, JsonValue>,
  ignored: readonly string[] = [],
) {
  const ignore = new Set(ignored);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((field) => !ignore.has(field))
    .filter((field) => !sameValue(left[field], right[field]))
    .sort();
}

function maximumNumber(left: JsonValue, right: JsonValue) {
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  return Math.max(left, right);
}

function maximumNullableNumber(left: JsonValue, right: JsonValue) {
  if (left === null) return right;
  if (right === null) return left;
  return maximumNumber(left, right);
}

function conflict(
  kind: TodoSemanticConflictKind,
  fields: string[],
): MergeRecordResult {
  return {
    kind: 'conflict',
    conflictKind: kind,
    conflictingFields: fields,
  };
}

function mergeUpdatedAt(
  record: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
) {
  if (
    typeof record.updatedAt === 'number'
    && typeof incoming.updatedAt === 'number'
  ) {
    record.updatedAt = Math.max(record.updatedAt, incoming.updatedAt);
  }
}

function mergeStrictRecord(input: {
  current: Record<string, JsonValue>;
  incoming: Record<string, JsonValue>;
  conflictKind?: TodoSemanticConflictKind;
}) : MergeRecordResult {
  const fields = changedFields(
    input.current,
    input.incoming,
    ['updatedAt'],
  );
  if (fields.length) {
    return conflict(
      input.conflictKind ?? 'todo-record-divergence',
      fields,
    );
  }
  const record = { ...input.current };
  mergeUpdatedAt(record, input.incoming);
  return { kind: 'merged', record };
}

const OPEN_TODO_STATUSES = new Set(['inbox', 'today', 'scheduled']);

function mergeTodoStatus(left: JsonValue, right: JsonValue) {
  if (left === right && typeof left === 'string') return left;
  if (typeof left !== 'string' || typeof right !== 'string') return null;
  const leftOpen = OPEN_TODO_STATUSES.has(left);
  const rightOpen = OPEN_TODO_STATUSES.has(right);
  if (leftOpen && !rightOpen) return right;
  if (rightOpen && !leftOpen) return left;
  return null;
}

function mergeTodoItem(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const monotonic = [
    'status',
    'trackedMinutes',
    'postponeCount',
    'reminderStage',
    'lastRemindedAt',
    'completedAt',
    'updatedAt',
    'completionRound',
  ];
  const fields = changedFields(current, incoming, monotonic);
  if (fields.length) return conflict('todo-record-divergence', fields);
  const currentRound = Number(current.completionRound ?? 0), incomingRound = Number(incoming.completionRound ?? 0);
  const higherRound = currentRound === incomingRound ? null : currentRound > incomingRound ? current : incoming;
  const status = higherRound ? higherRound.status : mergeTodoStatus(current.status, incoming.status);
  if (!status) return conflict('todo-state-divergence', ['status']);
  const record: Record<string, JsonValue> = {
    ...current,
    status,
  };
  if ('completionRound' in current || 'completionRound' in incoming) record.completionRound = Math.max(currentRound, incomingRound);
  for (const field of ['trackedMinutes', 'postponeCount', 'reminderStage']) {
    const value = maximumNumber(current[field], incoming[field]);
    if (value === null) return conflict('todo-record-divergence', [field]);
    record[field] = value;
  }
  for (const field of ['lastRemindedAt', 'completedAt']) {
    if (field === 'completedAt' && higherRound) { record.completedAt = higherRound.completedAt; continue; }
    const value = maximumNullableNumber(current[field], incoming[field]);
    if (value === null && current[field] !== null && incoming[field] !== null) {
      return conflict('todo-record-divergence', [field]);
    }
    record[field] = value;
  }
  mergeUpdatedAt(record, incoming);
  return { kind: 'merged', record };
}

function mergeInhibitLog(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const fields = changedFields(current, incoming, [
    'acknowledgedAt',
    'outcome',
    'updatedAt',
  ]);
  if (fields.length) return conflict('todo-record-divergence', fields);
  const left = String(current.outcome);
  const right = String(incoming.outcome);
  const outcome = left === right
    ? left
    : left === 'unrecorded'
      ? right
      : right === 'unrecorded'
        ? left
        : null;
  if (!outcome) return conflict('todo-state-divergence', ['outcome']);
  const acknowledgedAt = maximumNullableNumber(
    current.acknowledgedAt,
    incoming.acknowledgedAt,
  );
  if (
    acknowledgedAt === null
    && current.acknowledgedAt !== null
    && incoming.acknowledgedAt !== null
  ) {
    return conflict('todo-record-divergence', ['acknowledgedAt']);
  }
  const record = { ...current, outcome, acknowledgedAt };
  mergeUpdatedAt(record, incoming);
  return { kind: 'merged', record };
}

function mergeHabit(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const original = current;
  current = preserveOwnHabitFields('habit', incoming, current);
  incoming = preserveOwnHabitFields('habit', original, incoming);
  const fields = changedFields(current, incoming, [
    'streak',
    'bestStreak',
    'status',
    'updatedAt',
  ]);
  if (fields.length) return conflict('todo-record-divergence', fields);
  const status = current.status === 'archived'
    || incoming.status === 'archived'
    ? 'archived'
    : 'active';
  const streak = maximumNumber(current.streak, incoming.streak);
  const bestStreak = maximumNumber(current.bestStreak, incoming.bestStreak);
  if (streak === null || bestStreak === null) {
    return conflict('todo-progress-divergence', ['streak', 'bestStreak']);
  }
  const record = { ...current, status, streak, bestStreak };
  mergeUpdatedAt(record, incoming);
  return { kind: 'merged', record };
}

function mergeHabitLog(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const original = current;
  current = preserveOwnHabitFields('habit-log', incoming, current);
  incoming = preserveOwnHabitFields('habit-log', original, incoming);
  const fields = changedFields(current, incoming, [
    'completed',
    'completedCount',
    'note',
    'completedAt',
    'updatedAt',
  ]);
  if (fields.length) return conflict('todo-record-divergence', fields);
  const completedCount = maximumNumber(
    current.completedCount,
    incoming.completedCount,
  );
  if (completedCount === null) {
    return conflict('todo-progress-divergence', ['completedCount']);
  }
  const note = current.note === incoming.note
    ? current.note
    : current.note === ''
      ? incoming.note
      : incoming.note === ''
        ? current.note
        : null;
  if (note === null) return conflict('todo-progress-divergence', ['note']);
  const completedAt = maximumNullableNumber(
    current.completedAt,
    incoming.completedAt,
  );
  if (
    completedAt === null
    && current.completedAt !== null
    && incoming.completedAt !== null
  ) {
    return conflict('todo-progress-divergence', ['completedAt']);
  }
  const record = {
    ...current,
    completed: current.completed === true || incoming.completed === true,
    completedCount,
    note,
    completedAt,
  };
  mergeUpdatedAt(record, incoming);
  return { kind: 'merged', record };
}

function mergeGoalStatus(left: JsonValue, right: JsonValue) {
  if (left === right && typeof left === 'string') return left;
  if (left === 'active' && typeof right === 'string') return right;
  if (right === 'active' && typeof left === 'string') return left;
  return null;
}

function mergeGoal(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const fields = changedFields(current, incoming, [
    'status',
    'progress',
    'lastDirectionCheckAt',
    'updatedAt',
  ]);
  if (fields.length) return conflict('todo-record-divergence', fields);
  const status = mergeGoalStatus(current.status, incoming.status);
  if (!status) return conflict('todo-state-divergence', ['status']);
  const progress = maximumNumber(current.progress, incoming.progress);
  const lastDirectionCheckAt = maximumNullableNumber(
    current.lastDirectionCheckAt,
    incoming.lastDirectionCheckAt,
  );
  if (progress === null) {
    return conflict('todo-progress-divergence', ['progress']);
  }
  if (
    lastDirectionCheckAt === null
    && current.lastDirectionCheckAt !== null
    && incoming.lastDirectionCheckAt !== null
  ) {
    return conflict('todo-record-divergence', ['lastDirectionCheckAt']);
  }
  const record = {
    ...current,
    status,
    progress,
    lastDirectionCheckAt,
  };
  mergeUpdatedAt(record, incoming);
  return { kind: 'merged', record };
}

const TIME_CREDIT_OPEN = new Set(['pending', 'proposed']);

function mergeTimeCredit(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const fields = changedFields(current, incoming, [
    'suggestedMinutes',
    'reason',
    'status',
    'updatedAt',
  ]);
  if (fields.length) return conflict('todo-record-divergence', fields);
  const left = String(current.status);
  const right = String(incoming.status);
  let status: string | null = left === right ? left : null;
  if (!status && left === 'pending' && right === 'proposed') status = right;
  if (!status && right === 'pending' && left === 'proposed') status = left;
  if (!status && TIME_CREDIT_OPEN.has(left) && !TIME_CREDIT_OPEN.has(right)) {
    status = right;
  }
  if (!status && TIME_CREDIT_OPEN.has(right) && !TIME_CREDIT_OPEN.has(left)) {
    status = left;
  }
  if (!status) return conflict('todo-state-divergence', ['status']);
  const suggestedMinutes = current.suggestedMinutes === incoming.suggestedMinutes
    ? current.suggestedMinutes
    : current.suggestedMinutes === null
      ? incoming.suggestedMinutes
      : incoming.suggestedMinutes === null
        ? current.suggestedMinutes
        : null;
  if (suggestedMinutes === null && current.suggestedMinutes !== null) {
    return conflict('todo-progress-divergence', ['suggestedMinutes']);
  }
  const reason = current.reason === incoming.reason
    ? current.reason
    : current.reason === ''
      ? incoming.reason
      : incoming.reason === ''
        ? current.reason
        : null;
  if (reason === null) return conflict('todo-progress-divergence', ['reason']);
  const record = { ...current, status, suggestedMinutes, reason };
  mergeUpdatedAt(record, incoming);
  return { kind: 'merged', record };
}

function mergeNudge(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const fields = changedFields(current, incoming, ['deliveredAt']);
  if (fields.length) return conflict('todo-execution-divergence', fields);
  const deliveredAt = maximumNullableNumber(
    current.deliveredAt,
    incoming.deliveredAt,
  );
  if (
    deliveredAt === null
    && current.deliveredAt !== null
    && incoming.deliveredAt !== null
  ) {
    return conflict('todo-execution-divergence', ['deliveredAt']);
  }
  return {
    kind: 'merged',
    record: { ...current, deliveredAt },
  };
}

function mergeRecordByKind(input: {
  kind: TodoSemanticRecordKind;
  current: Record<string, JsonValue>;
  incoming: Record<string, JsonValue>;
}): MergeRecordResult {
  if (input.kind === 'todo-item') {
    return mergeTodoItem(preserveOwnHabitFields('todo-item', input.incoming, input.current),
      preserveOwnHabitFields('todo-item', input.current, input.incoming));
  }
  if (input.kind === 'todo-inhibit-log') {
    return mergeInhibitLog(input.current, input.incoming);
  }
  if (input.kind === 'habit') {
    return mergeHabit(input.current, input.incoming);
  }
  if (input.kind === 'habit-log') {
    return mergeHabitLog(input.current, input.incoming);
  }
  if (input.kind === 'goal') {
    return mergeGoal(input.current, input.incoming);
  }
  if (input.kind === 'goal-time-credit-request') {
    return mergeTimeCredit(input.current, input.incoming);
  }
  if (input.kind === 'task-execution-nudge') {
    return mergeNudge(input.current, input.incoming);
  }
  if (input.kind === 'day-review' || input.kind === 'week-review') {
    return mergeStrictRecord({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'todo-review-divergence',
    });
  }
  if (input.kind === 'task-execution-session') {
    return mergeStrictRecord({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'todo-execution-divergence',
    });
  }
  if (input.kind === 'goal-progress-event') {
    return mergeStrictRecord({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'todo-progress-divergence',
    });
  }
  return mergeStrictRecord({
    current: input.current,
    incoming: input.incoming,
  });
}

function mergedDecision(input: {
  current: TodoSemanticRevisionValue;
  incoming: TodoSemanticRevisionValue;
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
}): TodoSemanticMergeDecision {
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  return {
    kind: 'merged',
    payload: input.payload,
    operation: input.operation,
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

function conflictDecision(input: {
  current: TodoSemanticRevisionValue;
  incoming: TodoSemanticRevisionValue;
  conflictKind: TodoSemanticConflictKind;
  conflictingFields?: string[];
}): TodoSemanticMergeDecision {
  return {
    kind: 'conflict',
    payload: input.current.payload,
    operation: input.current.operation,
    resultingHeadRevisionIds: sortedHeads(
      input.current.revisionId,
      input.incoming.revisionId,
    ),
    conflictKind: input.conflictKind,
    conflictingFields: input.conflictingFields ?? [],
  };
}

export function resolveTodoSemanticRevisions(input: {
  current: TodoSemanticRevisionValue | null;
  incoming: TodoSemanticRevisionValue;
}): TodoSemanticMergeDecision {
  assertTodoSemanticMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertTodoSemanticMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('todo.semantic 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    const currentPayload = todoSemanticPayload(mutationOf(input.current));
    const incomingPayload = todoSemanticPayload(mutationOf(input.incoming));
    if ('record' in currentPayload && 'record' in incomingPayload && currentPayload.kind === incomingPayload.kind) {
      const record = preserveOwnHabitFields(incomingPayload.kind, currentPayload.record, incomingPayload.record);
      if (!sameValue(record, incomingPayload.record)) return mergedDecision({
        current: input.current, incoming: input.incoming,
        payload: mergedPayload(incomingPayload, record), operation: input.incoming.operation,
      });
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const currentPayload = todoSemanticPayload(mutationOf(input.current));
  const incomingPayload = todoSemanticPayload(mutationOf(input.incoming));
  if (sameValue(currentPayload, incomingPayload)) {
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: currentPayload as JsonValue,
      operation: input.current.operation,
    });
  }
  if (
    input.current.operation === 'delete'
    && input.incoming.operation === 'delete'
  ) {
    if (currentPayload.kind !== incomingPayload.kind) {
      return conflictDecision({
        current: input.current,
        incoming: input.incoming,
        conflictKind: 'todo-record-divergence',
        conflictingFields: ['kind'],
      });
    }
    const deletedAt = Math.max(
      'deletedAt' in currentPayload ? currentPayload.deletedAt : 0,
      'deletedAt' in incomingPayload ? incomingPayload.deletedAt : 0,
    );
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: {
        schemaVersion: 1,
        kind: currentPayload.kind,
        deletedAt,
      },
      operation: 'delete',
    });
  }
  if (
    input.current.operation === 'delete'
    || input.incoming.operation === 'delete'
  ) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'todo-delete-modify',
    });
  }
  if (
    !('record' in currentPayload)
    || !('record' in incomingPayload)
    || currentPayload.kind !== incomingPayload.kind
  ) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'todo-record-divergence',
      conflictingFields: ['kind'],
    });
  }
  const merged = mergeRecordByKind({
    kind: currentPayload.kind,
    current: recordPayload(currentPayload),
    incoming: recordPayload(incomingPayload),
  });
  if (merged.kind === 'conflict') {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: merged.conflictKind,
      conflictingFields: merged.conflictingFields,
    });
  }
  return mergedDecision({
    current: input.current,
    incoming: input.incoming,
    payload: mergedPayload(currentPayload, merged.record),
    operation: 'upsert',
  });
}
