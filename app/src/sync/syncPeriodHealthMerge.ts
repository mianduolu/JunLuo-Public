import {
  assertPeriodHealthMutationV1,
  isPeriodHealthEntityType,
  periodHealthPayload,
  PERIOD_HEALTH_RETENTION_CLASS,
  PERIOD_HEALTH_SCHEMA_VERSION,
  type PeriodHealthEntityType,
  type PeriodHealthPayloadV1,
  type PeriodHealthRecordKind,
} from './syncPeriodHealth';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type PeriodHealthRevisionValue = {
  entityType: PeriodHealthEntityType;
  entityId: string;
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type PeriodHealthConflictKind =
  | 'delete-modify'
  | 'identity-divergence'
  | 'same-field'
  | 'state-transition';

export type PeriodHealthMergeDecision =
  | {
      kind:
        | 'already-current'
        | 'apply-incoming'
        | 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'merged' | 'keep-current';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      requiresMergeRevision: true;
      mergeParentRevisionIds: string[];
    }
  | {
      kind: 'conflict';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      conflictKind: PeriodHealthConflictKind;
      conflictingFields: string[];
    };

type JsonRecord = Record<string, JsonValue>;

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function sameValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    left === null
    || right === null
    || typeof left !== typeof right
  ) {
    return false;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right)
      && left.length === right.length
      && left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as JsonRecord;
  const rightRecord = right as JsonRecord;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key, index) => (
        key === rightKeys[index]
        && sameValue(leftRecord[key], rightRecord[key])
      ),
    )
  );
}

function sortedHeads(...revisionIds: string[]) {
  return [...new Set(revisionIds)].sort();
}

function mutationOf(revision: PeriodHealthRevisionValue): PlainMutationV1 {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'period',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: [...revision.parentRevisionIds],
      operation: revision.operation,
      schemaVersion: PERIOD_HEALTH_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: PERIOD_HEALTH_RETENTION_CLASS,
  };
  assertPeriodHealthMutationV1(mutation);
  return mutation;
}

function payloadOf(revision: PeriodHealthRevisionValue) {
  return periodHealthPayload(mutationOf(revision));
}

function payloadRecord(payload: PeriodHealthPayloadV1) {
  if (!('record' in payload)) {
    throw new Error('period.health tombstone 不含 record。');
  }
  return recordOf(payload.record, 'period.health record');
}

function mergedPayload(
  kind: PeriodHealthRecordKind,
  record: JsonRecord,
): JsonValue {
  return {
    schemaVersion: PERIOD_HEALTH_SCHEMA_VERSION,
    kind,
    record,
  };
}

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter((field) => !sameValue(left[field], right[field])).sort();
}

function mergedDecision(input: {
  current: PeriodHealthRevisionValue;
  incoming: PeriodHealthRevisionValue;
  payload: JsonValue;
  operation: SyncOperation;
  keepCurrent?: boolean;
}): PeriodHealthMergeDecision {
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  return {
    kind: input.keepCurrent ? 'keep-current' : 'merged',
    payload: input.payload,
    operation: input.operation,
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

function conflictDecision(input: {
  current: PeriodHealthRevisionValue;
  incoming: PeriodHealthRevisionValue;
  conflictKind: PeriodHealthConflictKind;
  conflictingFields?: string[];
}): PeriodHealthMergeDecision {
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

function mergeFields(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  base: JsonRecord | null;
  fields: readonly string[];
}) {
  const record: JsonRecord = {};
  const conflicts: string[] = [];
  for (const field of input.fields) {
    const currentValue = input.current[field];
    const incomingValue = input.incoming[field];
    if (sameValue(currentValue, incomingValue)) {
      record[field] = currentValue;
    } else if (
      input.base
      && sameValue(currentValue, input.base[field])
    ) {
      record[field] = incomingValue;
    } else if (
      input.base
      && sameValue(incomingValue, input.base[field])
    ) {
      record[field] = currentValue;
    } else {
      conflicts.push(field);
      record[field] = currentValue;
    }
  }
  return { record, conflicts };
}

function mergeEntry(
  current: JsonRecord,
  incoming: JsonRecord,
) {
  const identityConflicts = changedFields(
    {
      id: current.id,
      createdAt: current.createdAt,
    },
    {
      id: incoming.id,
      createdAt: incoming.createdAt,
    },
  );
  if (identityConflicts.length) {
    return {
      kind: 'conflict' as const,
      conflictKind: 'identity-divergence' as const,
      conflictingFields: identityConflicts,
    };
  }
  const currentEnd = current.endAt;
  const incomingEnd = incoming.endAt;
  let endAt: JsonValue;
  if (sameValue(currentEnd, incomingEnd)) {
    endAt = currentEnd;
  } else if (currentEnd === null) {
    endAt = incomingEnd;
  } else if (incomingEnd === null) {
    endAt = currentEnd;
  } else {
    return {
      kind: 'conflict' as const,
      conflictKind: 'state-transition' as const,
      conflictingFields: ['endAt'],
    };
  }
  if (
    typeof current.startAt !== 'number'
    || typeof incoming.startAt !== 'number'
    || typeof current.updatedAt !== 'number'
    || typeof incoming.updatedAt !== 'number'
  ) {
    throw new Error('period entry 数值字段无效。');
  }
  return {
    kind: 'merged' as const,
    record: {
      id: current.id,
      startAt: Math.min(current.startAt, incoming.startAt),
      endAt,
      createdAt: current.createdAt,
      updatedAt: Math.max(current.updatedAt, incoming.updatedAt),
    },
  };
}

function mergeCompanionDelivery(
  current: JsonRecord,
  incoming: JsonRecord,
) {
  const identityFields = [
    'id',
    'eventKey',
    'periodId',
    'dateKey',
    'kind',
    'createdAt',
  ] as const;
  const identityConflicts = identityFields.filter(
    (field) => !sameValue(current[field], incoming[field]),
  );
  if (identityConflicts.length) {
    return {
      kind: 'conflict' as const,
      conflictKind: 'identity-divergence' as const,
      conflictingFields: [...identityConflicts],
    };
  }
  const currentStatus = String(current.status);
  const incomingStatus = String(incoming.status);
  let selected: JsonRecord;
  if (currentStatus === incomingStatus) {
    const contentConflicts = ['messageIds', 'error'].filter(
      (field) => !sameValue(current[field], incoming[field]),
    );
    if (contentConflicts.length) {
      return {
        kind: 'conflict' as const,
        conflictKind: 'same-field' as const,
        conflictingFields: contentConflicts,
      };
    }
    selected = current;
  } else if (currentStatus === 'pending') {
    selected = incoming;
  } else if (incomingStatus === 'pending') {
    selected = current;
  } else {
    return {
      kind: 'conflict' as const,
      conflictKind: 'state-transition' as const,
      conflictingFields: ['status'],
    };
  }
  return {
    kind: 'merged' as const,
    record: {
      ...selected,
      updatedAt: Math.max(
        Number(current.updatedAt),
        Number(incoming.updatedAt),
      ),
    },
  };
}

function fieldsForKind(kind: PeriodHealthRecordKind) {
  if (kind === 'period-daily-log') {
    return [
      'id',
      'dateKey',
      'periodId',
      'bodyState',
      'flow',
      'painLevel',
      'symptoms',
      'note',
      'createdAt',
    ] as const;
  }
  if (kind === 'period-reminder-settings') {
    return [
      'id',
      'careEnabled',
      'careFrequency',
      'mutedDateKey',
    ] as const;
  }
  return [
    'id',
    'eventKey',
    'kind',
    'scheduledAt',
    'title',
    'body',
    'generatedByAi',
    'createdAt',
  ] as const;
}

function immutableFieldsForKind(
  kind: PeriodHealthRecordKind,
): readonly string[] {
  if (kind === 'period-entry') {
    return ['id', 'createdAt'];
  }
  if (kind === 'period-daily-log') {
    return ['id', 'dateKey', 'createdAt'];
  }
  if (kind === 'period-companion-delivery') {
    return [
      'id',
      'eventKey',
      'periodId',
      'dateKey',
      'kind',
      'createdAt',
    ];
  }
  if (kind === 'period-reminder-settings') return ['id'];
  return ['id', 'eventKey', 'createdAt'];
}

function validateSequentialState(
  current: PeriodHealthRevisionValue,
  incoming: PeriodHealthRevisionValue,
) {
  if (current.operation === 'delete' || incoming.operation === 'delete') {
    return;
  }
  const currentPayload = payloadOf(current);
  const incomingPayload = payloadOf(incoming);
  if (
    !('record' in currentPayload)
    || !('record' in incomingPayload)
    || currentPayload.kind !== incomingPayload.kind
  ) {
    throw new Error('period.health sequential payload kind 不一致。');
  }
  const currentRecord = payloadRecord(currentPayload);
  const incomingRecord = payloadRecord(incomingPayload);
  const identityConflicts = immutableFieldsForKind(
    currentPayload.kind,
  ).filter(
    (field) => !sameValue(currentRecord[field], incomingRecord[field]),
  );
  if (identityConflicts.length) {
    throw new Error(
      `period.health 不可变身份字段不能修改：${identityConflicts.join(', ')}。`,
    );
  }
  if (currentPayload.kind === 'period-entry') {
    if (
      currentRecord.endAt !== null
      && incomingRecord.endAt === null
    ) {
      throw new Error('period entry end state 不能倒退。');
    }
  }
  if (currentPayload.kind === 'period-companion-delivery') {
    const currentStatus = String(currentRecord.status);
    const incomingStatus = String(incomingRecord.status);
    if (
      currentStatus !== incomingStatus
      && currentStatus !== 'pending'
    ) {
      throw new Error('period companion terminal state 不能改变。');
    }
  }
}

export function resolvePeriodHealthRevisions(input: {
  current: PeriodHealthRevisionValue | null;
  incoming: PeriodHealthRevisionValue;
  base?: PeriodHealthRevisionValue | null;
}): PeriodHealthMergeDecision {
  input = {
    ...input,
    incoming: { ...input.incoming, payload: payloadOf(input.incoming) as JsonValue },
    current: input.current ? { ...input.current, payload: payloadOf(input.current) as JsonValue } : null,
    base: input.base ? { ...input.base, payload: payloadOf(input.base) as JsonValue } : input.base,
  };
  if (!isPeriodHealthEntityType(input.incoming.entityType)) {
    throw new Error('period.health merge entity type 无效。');
  }
  mutationOf(input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  mutationOf(input.current);
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('period.health 不能跨实体合并 revision。');
  }
  if (input.base) {
    mutationOf(input.base);
    if (
      input.base.entityType !== input.current.entityType
      || input.base.entityId !== input.current.entityId
    ) {
      throw new Error('period.health merge base 不属于同一实体。');
    }
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.current.parentRevisionIds.includes(
      input.incoming.revisionId,
    )
  ) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.incoming.parentRevisionIds.includes(
      input.current.revisionId,
    )
  ) {
    validateSequentialState(input.current, input.incoming);
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }

  const currentPayload = payloadOf(input.current);
  const incomingPayload = payloadOf(input.incoming);
  if (sameValue(currentPayload, incomingPayload)) {
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: input.current.payload,
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
        conflictKind: 'identity-divergence',
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
        schemaVersion: PERIOD_HEALTH_SCHEMA_VERSION,
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
      conflictKind: 'delete-modify',
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
      conflictKind: 'identity-divergence',
      conflictingFields: ['kind'],
    });
  }
  const kind = currentPayload.kind;
  const currentRecord = payloadRecord(currentPayload);
  const incomingRecord = payloadRecord(incomingPayload);
  const identityConflicts = immutableFieldsForKind(kind).filter(
    (field) => !sameValue(currentRecord[field], incomingRecord[field]),
  );
  if (identityConflicts.length) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'identity-divergence',
      conflictingFields: identityConflicts,
    });
  }
  if (kind === 'period-entry') {
    const merged = mergeEntry(currentRecord, incomingRecord);
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
      payload: mergedPayload(kind, merged.record),
      operation: 'upsert',
    });
  }
  if (kind === 'period-companion-delivery') {
    const merged = mergeCompanionDelivery(currentRecord, incomingRecord);
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
      payload: mergedPayload(kind, merged.record),
      operation: 'upsert',
    });
  }
  const basePayload = input.base && input.base.operation !== 'delete'
    ? payloadOf(input.base)
    : null;
  const baseRecord = (
    basePayload
    && 'record' in basePayload
    && basePayload.kind === kind
  )
    ? payloadRecord(basePayload)
    : null;
  const merged = mergeFields({
    current: currentRecord,
    incoming: incomingRecord,
    base: baseRecord,
    fields: fieldsForKind(kind),
  });
  if (merged.conflicts.length) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'same-field',
      conflictingFields: merged.conflicts,
    });
  }
  return mergedDecision({
    current: input.current,
    incoming: input.incoming,
    payload: mergedPayload(kind, {
      ...merged.record,
      updatedAt: Math.max(
        Number(currentRecord.updatedAt),
        Number(incomingRecord.updatedAt),
      ),
    }),
    operation: 'upsert',
  });
}
