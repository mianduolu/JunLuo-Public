import {
  ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
  ACTIVITY_RECORD_RETENTION_CLASS,
  ACTIVITY_RAW_RETENTION_CLASS,
  activityObservationsPayload,
  assertActivityObservationsMutationV1,
  type ActivityObservationsEntityType,
  type ActivityObservationsPayloadV1,
  type ActivityObservationsRecordKind,
} from './syncActivityObservations';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type ActivityObservationsRevisionValue = {
  entityType: ActivityObservationsEntityType;
  entityId: string;
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type ActivityObservationsConflictKind =
  | 'append-identity'
  | 'delete-modify'
  | 'identity-divergence'
  | 'same-field'
  | 'state-transition';

export type ActivityObservationsMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming' | 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'merged';
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
      conflictKind: ActivityObservationsConflictKind;
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

function payloadKind(revision: ActivityObservationsRevisionValue) {
  return recordOf(
    revision.payload,
    'activity.observations revision payload',
  ).kind;
}

function mutationOf(
  revision: ActivityObservationsRevisionValue,
): PlainMutationV1 {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'activity',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: [...revision.parentRevisionIds],
      operation: revision.operation,
      schemaVersion: ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: payloadKind(revision) === 'activity-reading'
      ? ACTIVITY_RAW_RETENTION_CLASS
      : ACTIVITY_RECORD_RETENTION_CLASS,
  };
  assertActivityObservationsMutationV1(mutation);
  return mutation;
}

function payloadOf(revision: ActivityObservationsRevisionValue) {
  return activityObservationsPayload(mutationOf(revision));
}

function payloadRecord(payload: ActivityObservationsPayloadV1) {
  if (!('record' in payload)) {
    throw new Error('activity.observations tombstone 不含 record。');
  }
  return recordOf(payload.record, 'activity.observations record');
}

function mergedPayload(
  kind: ActivityObservationsRecordKind,
  record: JsonRecord,
): JsonValue {
  return {
    schemaVersion: ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
    kind,
    record,
  };
}

function mergedDecision(input: {
  current: ActivityObservationsRevisionValue;
  incoming: ActivityObservationsRevisionValue;
  payload: JsonValue;
  operation: SyncOperation;
}): ActivityObservationsMergeDecision {
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
  current: ActivityObservationsRevisionValue;
  incoming: ActivityObservationsRevisionValue;
  conflictKind: ActivityObservationsConflictKind;
  conflictingFields?: string[];
}): ActivityObservationsMergeDecision {
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

function changedFields(left: JsonRecord, right: JsonRecord) {
  return [...new Set([
    ...Object.keys(left),
    ...Object.keys(right),
  ])].filter((field) => !sameValue(left[field], right[field])).sort();
}

function immutableFieldsForKind(kind: ActivityObservationsRecordKind) {
  if (kind === 'activity-reading') {
    return Object.freeze([
      'id',
      'readingKind',
      'source',
      'title',
      'summary',
      'startedAt',
      'endedAt',
      'durationMs',
      'sensitivityLabel',
      'originDeviceId',
      'originPlatform',
      'sourceScope',
      'retentionUntil',
      'createdAt',
    ]);
  }
  if (kind === 'activity-day-summary') {
    return Object.freeze([
      'id',
      'dateKey',
      'originDeviceId',
      'originPlatform',
      'sourceScope',
    ]);
  }
  if (kind === 'activity-care-settings') return Object.freeze(['id']);
  if (kind === 'activity-care-rule') {
    return Object.freeze([
      'id',
      'ruleKind',
      'targetPlatform',
      'source',
    ]);
  }
  if (kind === 'activity-feedback') {
    return Object.freeze([
      'id',
      'feedbackKind',
      'targetPlatform',
      'source',
      'createdAt',
    ]);
  }
  if (kind === 'activity-focus-trigger') {
    return Object.freeze([
      'id',
      'ruleId',
      'ruleKind',
      'triggerKind',
      'reason',
      'eventStage',
      'appSource',
      'appTitle',
      'durationMs',
      'stage',
      'originDeviceId',
      'originPlatform',
      'sourceScope',
      'triggeredAt',
    ]);
  }
  return Object.freeze([
    'id',
    'ruleId',
    'dateKey',
    'originDeviceId',
    'originPlatform',
    'sourceScope',
  ]);
}

function assertNoIdentityChange(
  kind: ActivityObservationsRecordKind,
  current: JsonRecord,
  incoming: JsonRecord,
) {
  const changed = immutableFieldsForKind(kind).filter(
    (field) => !sameValue(current[field], incoming[field]),
  );
  if (changed.length) {
    throw new Error(
      `activity.observations 不可变字段不能修改：${changed.join(', ')}。`,
    );
  }
}

function assertNonRegressingNumber(
  current: JsonRecord,
  incoming: JsonRecord,
  field: string,
) {
  if (Number(incoming[field]) < Number(current[field])) {
    throw new Error(`activity.observations ${field} 不能倒退。`);
  }
}

function validateSequentialState(
  current: ActivityObservationsRevisionValue,
  incoming: ActivityObservationsRevisionValue,
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
    throw new Error('activity.observations sequential payload kind 不一致。');
  }
  const kind = currentPayload.kind;
  const currentRecord = payloadRecord(currentPayload);
  const incomingRecord = payloadRecord(incomingPayload);
  if (kind === 'activity-reading') {
    if (!sameValue(currentPayload, incomingPayload)) {
      throw new Error('activity reading 是 append-only，不能改写。');
    }
    return;
  }
  assertNoIdentityChange(kind, currentRecord, incomingRecord);
  if (kind === 'activity-day-summary') {
    assertNonRegressingNumber(currentRecord, incomingRecord, 'segments');
    assertNonRegressingNumber(
      currentRecord,
      incomingRecord,
      'totalDurationMs',
    );
  } else if (kind === 'activity-feedback') {
    const currentStatus = currentRecord.status;
    const incomingStatus = incomingRecord.status;
    if (
      currentStatus !== 'pending'
      && incomingStatus !== currentStatus
    ) {
      throw new Error('activity feedback 终态不能改写。');
    }
  } else if (kind === 'activity-focus-trigger') {
    if (
      currentRecord.outcome === 'message-sent'
      && incomingRecord.outcome !== 'message-sent'
    ) {
      throw new Error('activity focus trigger outcome 不能倒退。');
    }
  } else if (kind === 'activity-daily-usage') {
    assertNonRegressingNumber(
      currentRecord,
      incomingRecord,
      'durationMs',
    );
  }
  if ('updatedAt' in currentRecord && 'updatedAt' in incomingRecord) {
    assertNonRegressingNumber(currentRecord, incomingRecord, 'updatedAt');
  }
}

function mergeThreeWayFields(input: {
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

function mergeMonotonicRecord(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  kind: 'activity-daily-usage' | 'activity-day-summary';
}) {
  assertNoIdentityChange(input.kind, input.current, input.incoming);
  if (input.kind === 'activity-daily-usage') {
    return {
      ...input.current,
      durationMs: Math.max(
        Number(input.current.durationMs),
        Number(input.incoming.durationMs),
      ),
      updatedAt: Math.max(
        Number(input.current.updatedAt),
        Number(input.incoming.updatedAt),
      ),
    };
  }
  const incomingWins = (
    Number(input.incoming.totalDurationMs)
      > Number(input.current.totalDurationMs)
    || (
      Number(input.incoming.totalDurationMs)
        === Number(input.current.totalDurationMs)
      && Number(input.incoming.updatedAt)
        > Number(input.current.updatedAt)
    )
  );
  const preferred = incomingWins ? input.incoming : input.current;
  return {
    ...preferred,
    segments: Math.max(
      Number(input.current.segments),
      Number(input.incoming.segments),
    ),
    totalDurationMs: Math.max(
      Number(input.current.totalDurationMs),
      Number(input.incoming.totalDurationMs),
    ),
    generatedAt: Math.max(
      Number(input.current.generatedAt),
      Number(input.incoming.generatedAt),
    ),
    updatedAt: Math.max(
      Number(input.current.updatedAt),
      Number(input.incoming.updatedAt),
    ),
  };
}

function concurrentRecordDecision(input: {
  current: ActivityObservationsRevisionValue;
  incoming: ActivityObservationsRevisionValue;
  base?: ActivityObservationsRevisionValue | null;
  kind: ActivityObservationsRecordKind;
  currentRecord: JsonRecord;
  incomingRecord: JsonRecord;
}) {
  const identityConflicts = immutableFieldsForKind(input.kind).filter(
    (field) => !sameValue(
      input.currentRecord[field],
      input.incomingRecord[field],
    ),
  );
  if (identityConflicts.length) {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: input.kind === 'activity-reading'
        ? 'append-identity'
        : 'identity-divergence',
      conflictingFields: identityConflicts,
    });
  }
  if (input.kind === 'activity-reading') {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'append-identity',
      conflictingFields: changedFields(
        input.currentRecord,
        input.incomingRecord,
      ),
    });
  }
  if (
    input.kind === 'activity-day-summary'
    || input.kind === 'activity-daily-usage'
  ) {
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: mergedPayload(
        input.kind,
        mergeMonotonicRecord({
          current: input.currentRecord,
          incoming: input.incomingRecord,
          kind: input.kind,
        }),
      ),
      operation: 'upsert',
    });
  }
  if (input.kind === 'activity-focus-trigger') {
    const outcomes = new Set([
      input.currentRecord.outcome,
      input.incomingRecord.outcome,
    ]);
    if (
      outcomes.size > 2
      || [...outcomes].some(
        (value) => value !== 'observed' && value !== 'message-sent',
      )
    ) {
      return conflictDecision({
        current: input.current,
        incoming: input.incoming,
        conflictKind: 'state-transition',
        conflictingFields: ['outcome'],
      });
    }
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: mergedPayload(input.kind, {
        ...input.currentRecord,
        outcome: outcomes.has('message-sent')
          ? 'message-sent'
          : 'observed',
        updatedAt: Math.max(
          Number(input.currentRecord.updatedAt),
          Number(input.incomingRecord.updatedAt),
        ),
      }),
      operation: 'upsert',
    });
  }
  if (input.kind === 'activity-feedback') {
    const currentStatus = input.currentRecord.status;
    const incomingStatus = input.incomingRecord.status;
    if (
      currentStatus !== incomingStatus
      && currentStatus !== 'pending'
      && incomingStatus !== 'pending'
    ) {
      return conflictDecision({
        current: input.current,
        incoming: input.incoming,
        conflictKind: 'state-transition',
        conflictingFields: ['status'],
      });
    }
    const chosen = currentStatus === 'pending'
      ? input.incomingRecord
      : input.currentRecord;
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: mergedPayload(input.kind, {
        ...chosen,
        updatedAt: Math.max(
          Number(input.currentRecord.updatedAt),
          Number(input.incomingRecord.updatedAt),
        ),
      }),
      operation: 'upsert',
    });
  }
  const basePayload = input.base && input.base.operation !== 'delete'
    ? payloadOf(input.base)
    : null;
  const baseRecord = (
    basePayload
    && 'record' in basePayload
    && basePayload.kind === input.kind
  )
    ? payloadRecord(basePayload)
    : null;
  const fields = input.kind === 'activity-care-settings'
    ? ['id', 'enabled', 'jealousyEnabled', 'rawRetentionDays']
    : [
        'id',
        'ruleKind',
        'targetPlatform',
        'source',
        'title',
        'thresholdMinutes',
        'returnWindowMinutes',
        'dailyLimitMinutes',
      ];
  const merged = mergeThreeWayFields({
    current: input.currentRecord,
    incoming: input.incomingRecord,
    base: baseRecord,
    fields,
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
    payload: mergedPayload(input.kind, {
      ...merged.record,
      updatedAt: Math.max(
        Number(input.currentRecord.updatedAt),
        Number(input.incomingRecord.updatedAt),
      ),
    }),
    operation: 'upsert',
  });
}

export function resolveActivityObservationsRevisions(input: {
  current: ActivityObservationsRevisionValue | null;
  incoming: ActivityObservationsRevisionValue;
  base?: ActivityObservationsRevisionValue | null;
}): ActivityObservationsMergeDecision {
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
    throw new Error('activity.observations 不能跨实体合并 revision。');
  }
  if (input.base) {
    mutationOf(input.base);
    if (
      input.base.entityType !== input.current.entityType
      || input.base.entityId !== input.current.entityId
    ) {
      throw new Error('activity.observations merge base 不属于同一实体。');
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
    input.current.parentRevisionIds.includes(input.incoming.revisionId)
  ) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (
    input.incoming.parentRevisionIds.includes(input.current.revisionId)
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
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: {
        schemaVersion: ACTIVITY_OBSERVATIONS_SCHEMA_VERSION,
        kind: currentPayload.kind,
        deletedAt: Math.max(
          'deletedAt' in currentPayload ? currentPayload.deletedAt : 0,
          'deletedAt' in incomingPayload ? incomingPayload.deletedAt : 0,
        ),
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
  return concurrentRecordDecision({
    current: input.current,
    incoming: input.incoming,
    base: input.base,
    kind: currentPayload.kind,
    currentRecord: payloadRecord(currentPayload),
    incomingRecord: payloadRecord(incomingPayload),
  });
}
