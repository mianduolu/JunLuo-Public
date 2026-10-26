import {
  assertScheduleSemanticMutationV1,
  scheduleSemanticPayload,
  retainScheduleExecution,
  retainDayTemplateRecord,
  retainScheduleOccurrenceRound,
  type ScheduleSemanticPayloadV1,
  type ScheduleSemanticRecordKind,
} from './syncScheduleSemantic';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type ScheduleSemanticRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type ScheduleSemanticConflictKind =
  | 'schedule-delete-modify'
  | 'schedule-record-divergence'
  | 'schedule-state-divergence'
  | 'schedule-template-field-divergence'
  | 'schedule-pending-intent-divergence'
  | 'schedule-alarm-result-divergence';

export type ScheduleSemanticMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'ignore-incoming'
    | 'merged'
    | 'conflict';
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
  resultingHeadRevisionIds: string[];
  conflictKind?: ScheduleSemanticConflictKind;
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

type MergeRecordResult =
  | {
      kind: 'merged';
      record: Record<string, JsonValue>;
    }
  | {
      kind: 'conflict';
      conflictKind: ScheduleSemanticConflictKind;
      conflictingFields: string[];
    };

function mutationOf(revision: ScheduleSemanticRevisionValue): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'schedule',
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
    retentionClass: 'schedule-semantic',
  };
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function recordPayload(payload: ScheduleSemanticPayloadV1) {
  if (!('record' in payload)) {
    throw new Error('schedule.semantic 当前 revision 不是 record payload。');
  }
  return payload.record as Record<string, JsonValue>;
}

function mergedPayload(
  payload: ScheduleSemanticPayloadV1,
  record: Record<string, JsonValue>,
) {
  if (!('record' in payload)) {
    throw new Error('schedule.semantic 无法为 delete payload 生成 record merge。');
  }
  return {
    schemaVersion: payload.schemaVersion,
    kind: payload.kind,
    record,
  } satisfies ScheduleSemanticPayloadV1;
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

function mergeTerminalState(input: {
  left: string;
  right: string;
  pending: string;
  compatible?: ReadonlyMap<string, string>;
}) {
  if (input.left === input.right) return input.left;
  if (input.left === input.pending) return input.right;
  if (input.right === input.pending) return input.left;
  return input.compatible?.get(`${input.left}:${input.right}`)
    ?? input.compatible?.get(`${input.right}:${input.left}`)
    ?? null;
}

function maximumNullableNumber(left: JsonValue, right: JsonValue) {
  if (left === null) return right;
  if (right === null) return left;
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  return Math.max(left, right);
}

function mergeNullableEqual(left: JsonValue, right: JsonValue) {
  if (sameValue(left, right)) return { ok: true as const, value: left };
  if (left === null) return { ok: true as const, value: right };
  if (right === null) return { ok: true as const, value: left };
  return { ok: false as const };
}

function mergeScheduleStateRecord(input: {
  current: Record<string, JsonValue>;
  incoming: Record<string, JsonValue>;
  ignoredFields: readonly string[];
  pendingStatus: string;
  compatibleStatuses?: ReadonlyMap<string, string>;
  timestampFields?: readonly string[];
  completionRounds?: boolean;
}): MergeRecordResult {
  const definitionConflicts = changedFields(
    input.current,
    input.incoming,
    ['status', ...input.ignoredFields, ...(input.timestampFields ?? []), ...(input.completionRounds ? ['completionRound'] : [])],
  );
  if (definitionConflicts.length) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-record-divergence',
      conflictingFields: definitionConflicts,
    };
  }
  const currentRound = Number(input.current.completionRound ?? 0), incomingRound = Number(input.incoming.completionRound ?? 0);
  const higherRound = input.completionRounds && currentRound !== incomingRound
    ? currentRound > incomingRound ? input.current : input.incoming : null;
  const status = higherRound ? String(higherRound.status) : mergeTerminalState({
    left: String(input.current.status),
    right: String(input.incoming.status),
    pending: input.pendingStatus,
    compatible: input.compatibleStatuses,
  });
  if (!status) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-state-divergence',
      conflictingFields: ['status'],
    };
  }
  const record: Record<string, JsonValue> = { ...input.current, status };
  if (input.completionRounds && ('completionRound' in input.current || 'completionRound' in input.incoming)) record.completionRound = Math.max(currentRound, incomingRound);
  for (const field of input.timestampFields ?? []) {
    if (field === 'completedAt' && higherRound) { record.completedAt = higherRound.completedAt; continue; }
    const merged = maximumNullableNumber(
      input.current[field] ?? null,
      input.incoming[field] ?? null,
    );
    if (merged === null && input.current[field] !== null && input.incoming[field] !== null) {
      return {
        kind: 'conflict',
        conflictKind: 'schedule-record-divergence',
        conflictingFields: [field],
      };
    }
    record[field] = merged;
  }
  if ('updatedAt' in record) {
    const current = record.updatedAt;
    const incoming = input.incoming.updatedAt;
    if (typeof current === 'number' && typeof incoming === 'number') {
      record.updatedAt = Math.max(current, incoming);
    }
  }
  return { kind: 'merged', record };
}

function mergeCooldown(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  if (
    current.category !== incoming.category
    || typeof current.until !== 'number'
    || typeof incoming.until !== 'number'
  ) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-record-divergence',
      conflictingFields: ['category', 'until'],
    };
  }
  return {
    kind: 'merged',
    record: {
      category: current.category,
      until: Math.max(current.until, incoming.until),
    },
  };
}

function mergeScheduleRequest(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  if (current.request !== incoming.request) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-pending-intent-divergence',
      conflictingFields: ['request'],
    };
  }
  const status = current.status === 'consumed' || incoming.status === 'consumed'
    ? 'consumed'
    : 'pending';
  const updatedAt = (
    typeof current.updatedAt === 'number'
    && typeof incoming.updatedAt === 'number'
  )
    ? Math.max(current.updatedAt, incoming.updatedAt)
    : current.updatedAt;
  return {
    kind: 'merged',
    record: {
      request: current.request,
      status,
      updatedAt,
    },
  };
}

function mergeChatReminderMetadata(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): { value: JsonValue | undefined; conflicts: string[] } {
  if (!left && !right) return { value: undefined, conflicts: [] };
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) || Array.isArray(right)) {
    return { value: undefined, conflicts: ['chatReminder'] };
  }
  const receiptFields = ['revision', 'prepareClaim', 'preparedBody', 'chatDelivery', 'notificationEvidence', 'musicEvidence', 'terminalReason', 'musicControl'];
  const conflicts = changedFields(left, right, receiptFields).map(key => `chatReminder.${key}`);
  const value: Record<string, JsonValue> = { ...left };
  for (const field of receiptFields.slice(1)) {
    if (!(field in left)) { if (field in right) value[field] = right[field]; continue; }
    if (!(field in right)) continue;
    if (JSON.stringify(left[field]) !== JSON.stringify(right[field])) conflicts.push(`chatReminder.${field}`);
  }
  value.revision = Math.max(Number(left.revision), Number(right.revision)) + 1;
  return { value, conflicts };
}

function mergeAlarm(
  current: Record<string, JsonValue>,
  incoming: Record<string, JsonValue>,
): MergeRecordResult {
  const receiptFields = [
    'chatReminder',
    ...(current.chatReminder && incoming.chatReminder ? ['message'] : []),
    'status',
    'musicPlayStatus',
    'musicPlayAttemptedAt',
    'musicPlayResultSummary',
    'musicPlayErrorMessage',
    'strongAlarmRingStatus',
    'strongAlarmTriggeredAt',
    'strongAlarmNotificationShown',
    'updatedAt',
    'cancelledAt',
  ];
  const definitionConflicts = changedFields(
    current,
    incoming,
    receiptFields,
  );
  const chatReminder = mergeChatReminderMetadata(current.chatReminder, incoming.chatReminder);
  definitionConflicts.push(...chatReminder.conflicts);
  if (definitionConflicts.length) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-record-divergence',
      conflictingFields: definitionConflicts,
    };
  }
  const status = mergeTerminalState({
    left: String(current.status),
    right: String(incoming.status),
    pending: 'pending',
  });
  if (!status) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-state-divergence',
      conflictingFields: ['status'],
    };
  }
  const musicPlayStatus = mergeTerminalState({
    left: String(current.musicPlayStatus ?? 'pending'),
    right: String(incoming.musicPlayStatus ?? 'pending'),
    pending: 'pending',
  });
  if (!musicPlayStatus) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-alarm-result-divergence',
      conflictingFields: ['musicPlayStatus'],
    };
  }
  const strongAlarmRingStatus = mergeTerminalState({
    left: String(current.strongAlarmRingStatus ?? 'pending'),
    right: String(incoming.strongAlarmRingStatus ?? 'pending'),
    pending: 'pending',
    compatible: new Map([
      ['started:stopped', 'stopped'],
    ]),
  });
  if (!strongAlarmRingStatus) {
    return {
      kind: 'conflict',
      conflictKind: 'schedule-alarm-result-divergence',
      conflictingFields: ['strongAlarmRingStatus'],
    };
  }
  const textReceiptFields = [
    'musicPlayResultSummary',
    'musicPlayErrorMessage',
  ] as const;
  const mergedText: Partial<Record<typeof textReceiptFields[number], JsonValue>> = {};
  for (const field of textReceiptFields) {
    const result = mergeNullableEqual(current[field], incoming[field]);
    if (!result.ok) {
      return {
        kind: 'conflict',
        conflictKind: 'schedule-alarm-result-divergence',
        conflictingFields: [field],
      };
    }
    mergedText[field] = result.value;
  }
  return {
    kind: 'merged',
    record: {
      ...current,
      status,
      ...(chatReminder.value ? { chatReminder: chatReminder.value, message: incoming.message || current.message } : {}),
      musicPlayStatus: current.musicPlayStatus === null
        && incoming.musicPlayStatus === null
        ? null
        : musicPlayStatus,
      strongAlarmRingStatus: current.strongAlarmRingStatus === null
        && incoming.strongAlarmRingStatus === null
        ? null
        : strongAlarmRingStatus,
      musicPlayAttemptedAt: maximumNullableNumber(
        current.musicPlayAttemptedAt,
        incoming.musicPlayAttemptedAt,
      ),
      strongAlarmTriggeredAt: maximumNullableNumber(
        current.strongAlarmTriggeredAt,
        incoming.strongAlarmTriggeredAt,
      ),
      strongAlarmNotificationShown:
        current.strongAlarmNotificationShown === true
        || incoming.strongAlarmNotificationShown === true
          ? true
          : current.strongAlarmNotificationShown
            ?? incoming.strongAlarmNotificationShown,
      cancelledAt: maximumNullableNumber(
        current.cancelledAt,
        incoming.cancelledAt,
      ),
      updatedAt: (
        typeof current.updatedAt === 'number'
        && typeof incoming.updatedAt === 'number'
      )
        ? Math.max(current.updatedAt, incoming.updatedAt)
        : current.updatedAt,
      ...mergedText,
    },
  };
}

function mergeRecordByKind(input: {
  kind: ScheduleSemanticRecordKind;
  current: Record<string, JsonValue>;
  incoming: Record<string, JsonValue>;
}): MergeRecordResult {
  if (input.kind === 'goal-suggestion-cooldown') {
    return mergeCooldown(input.current, input.incoming);
  }
  if (input.kind === 'schedule-request') {
    return mergeScheduleRequest(input.current, input.incoming);
  }
  if (input.kind === 'day-template-field') {
    if (Boolean(input.current.operationId) !== Boolean(input.incoming.operationId)) {
      return { kind: 'merged', record: input.current.operationId ? input.current : input.incoming };
    }
    return {
      kind: 'conflict',
      conflictKind: 'schedule-template-field-divergence',
      conflictingFields: ['value'],
    };
  }
  if (input.kind === 'alarm') {
    return mergeAlarm(input.current, input.incoming);
  }
  if (input.kind === 'schedule-item') {
    const current = { ...input.current };
    const incoming = { ...input.incoming };
    for (const field of ['owner', 'readingId', 'execution', 'startReminderEnabled', 'endMode', 'durationMinutes', 'habitCompletionKey']) {
      if (!(field in current) && field in incoming) current[field] = incoming[field];
      if (!(field in incoming) && field in current) incoming[field] = current[field];
    }
    const retained = retainScheduleExecution(current.execution, incoming.execution);
    if (retained !== undefined && ('execution' in current || 'execution' in incoming)) {
      incoming.execution = retained;
      current.execution = retainScheduleExecution(incoming.execution, current.execution);
    }
    return mergeScheduleStateRecord({
      current,
      incoming,
      ignoredFields: ['updatedAt'],
      pendingStatus: 'pending',
    });
  }
  if (input.kind === 'schedule-occurrence') {
    return mergeScheduleStateRecord({
      current: input.current,
      incoming: input.incoming,
      ignoredFields: ['completedAt'],
      pendingStatus: 'pending',
      timestampFields: ['completedAt'],
      completionRounds: true,
    });
  }
  if (input.kind === 'day-template-instance') {
    const current = retainDayTemplateRecord(input.kind, input.incoming, input.current);
    const incoming = retainDayTemplateRecord(input.kind, input.current, input.incoming);
    return mergeScheduleStateRecord({
      current,
      incoming,
      ignoredFields: ['completedAt', 'updatedAt'],
      pendingStatus: 'pending',
      timestampFields: ['completedAt'],
    });
  }
  if (input.kind === 'schedule-occurrence-delivery') {
    return mergeScheduleStateRecord({
      current: input.current,
      incoming: input.incoming,
      ignoredFields: ['deliveredAt'],
      pendingStatus: 'pending',
      compatibleStatuses: new Map([
        ['delivered:completed', 'completed'],
      ]),
      timestampFields: ['deliveredAt'],
    });
  }
  const merged = mergeScheduleStateRecord({
    current: input.current,
    incoming: input.incoming,
    ignoredFields: ['deliveredAt', 'respondedAt', 'updatedAt', 'reminderBody'],
    pendingStatus: 'pending',
    compatibleStatuses: new Map([
      ['delivered:responded', 'responded'],
    ]),
    timestampFields: ['deliveredAt', 'respondedAt'],
  });
  if (merged.kind !== 'merged') return merged;
  const currentBody = input.current.reminderBody ?? null;
  const incomingBody = input.incoming.reminderBody ?? null;
  const newer = Number(input.current.updatedAt) > Number(input.incoming.updatedAt)
    ? input.current : input.incoming;
  // A cleanup after the delivery window must not be undone by an older receipt.
  const cleared = [input.current, input.incoming].some((record) => (
    record.reminderBody === null
    && Number(record.updatedAt) > Number(record.scheduledAt) + 30_000
  ));
  merged.record.reminderBody = cleared || merged.record.status === 'cancelled'
    ? null
    : currentBody && incomingBody
      ? Number(input.current.updatedAt) === Number(input.incoming.updatedAt)
        ? [currentBody, incomingBody].sort((left, right) => (
          JSON.stringify(left).localeCompare(JSON.stringify(right))
        ))[0]
        : newer.reminderBody ?? null
      : currentBody ?? incomingBody;
  return merged;
}

function mergedDecision(input: {
  current: ScheduleSemanticRevisionValue;
  incoming: ScheduleSemanticRevisionValue;
  payload: JsonValue;
  operation: PlainMutationV1['revision']['operation'];
}): ScheduleSemanticMergeDecision {
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
  current: ScheduleSemanticRevisionValue;
  incoming: ScheduleSemanticRevisionValue;
  conflictKind: ScheduleSemanticConflictKind;
  conflictingFields?: string[];
}): ScheduleSemanticMergeDecision {
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

export function resolveScheduleSemanticRevisions(input: {
  current: ScheduleSemanticRevisionValue | null;
  incoming: ScheduleSemanticRevisionValue;
}): ScheduleSemanticMergeDecision {
  assertScheduleSemanticMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertScheduleSemanticMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('schedule.semantic 不能跨实体合并 revision。');
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
    const current = scheduleSemanticPayload(mutationOf(input.current));
    const incoming = scheduleSemanticPayload(mutationOf(input.incoming));
    let payload = input.incoming.payload;
    if (current.kind === 'schedule-occurrence' && incoming.kind === 'schedule-occurrence'
      && 'record' in current && 'record' in incoming) {
      const record = retainScheduleOccurrenceRound(current.record, incoming.record);
      if (!sameValue(record, incoming.record)) return mergedDecision({ ...input, current: input.current,
        payload: { schemaVersion: 1, kind: incoming.kind, record }, operation: input.incoming.operation });
    }
    if (current.kind === 'day-template-instance' && input.current.operation === 'delete'
      && input.incoming.operation !== 'delete' && input.incoming.operation !== 'restore') {
      return conflictDecision({ ...input, current: input.current, conflictKind: 'schedule-delete-modify' });
    }
    if (current.kind === incoming.kind && (current.kind === 'day-template-instance' || current.kind === 'day-template-field')
      && 'record' in current && 'record' in incoming) {
      payload = { schemaVersion: 1, kind: incoming.kind,
        record: retainDayTemplateRecord(incoming.kind, current.record, incoming.record) };
    }
    if (current.kind === 'schedule-item' && incoming.kind === 'schedule-item'
      && 'record' in current && 'record' in incoming) {
      const record: Record<string, JsonValue> = { ...recordPayload(incoming) };
      for (const field of ['owner', 'readingId', 'execution', 'startReminderEnabled', 'endMode', 'durationMinutes', 'habitCompletionKey']) {
        if (!(field in record) && field in current.record) record[field] = current.record[field];
      }
      if ('execution' in current.record || 'execution' in record)
        record.execution = retainScheduleExecution(current.record.execution, record.execution);
      if (!('owner' in incoming.record) && current.record.status !== 'pending') record.status = current.record.status;
      payload = { schemaVersion: 1, kind: 'schedule-item', record };
    }
    return {
      kind: 'apply-incoming',
      payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const currentPayload = scheduleSemanticPayload(mutationOf(input.current));
  const incomingPayload = scheduleSemanticPayload(mutationOf(input.incoming));
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
        ...input,
        current: input.current,
        conflictKind: 'schedule-record-divergence',
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
      ...input,
      current: input.current,
      conflictKind: 'schedule-delete-modify',
    });
  }
  if (
    !('record' in currentPayload)
    || !('record' in incomingPayload)
    || currentPayload.kind !== incomingPayload.kind
  ) {
    return conflictDecision({
      ...input,
      current: input.current,
      conflictKind: 'schedule-record-divergence',
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
      ...input,
      current: input.current,
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
