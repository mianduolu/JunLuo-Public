import {
  assertBodySignalHealthMutationV1,
  bodySignalHealthPayload,
  BODY_SIGNAL_DERIVED_RETENTION_CLASS,
  BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
  BODY_SIGNAL_RAW_RETENTION_CLASS,
  type BodySignalHealthEntityType,
  type BodySignalHealthPayloadV1,
  type BodySignalHealthRecordKind,
} from './syncBodySignalHealth';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type BodySignalHealthRevisionValue = {
  entityType: BodySignalHealthEntityType;
  entityId: string;
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type BodySignalHealthConflictKind =
  | 'append-identity'
  | 'delete-modify'
  | 'identity-divergence'
  | 'same-field'
  | 'state-transition';

export type BodySignalHealthMergeDecision =
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
      conflictKind: BodySignalHealthConflictKind;
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

function payloadKind(revision: BodySignalHealthRevisionValue) {
  const payload = recordOf(
    revision.payload,
    'body-signal.health revision payload',
  );
  return payload.kind;
}

function mutationOf(
  revision: BodySignalHealthRevisionValue,
): PlainMutationV1 {
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'body-signal',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: [...revision.parentRevisionIds],
      operation: revision.operation,
      schemaVersion: BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: payloadKind(revision) === 'body-signal-reading'
      ? BODY_SIGNAL_RAW_RETENTION_CLASS
      : BODY_SIGNAL_DERIVED_RETENTION_CLASS,
  };
  assertBodySignalHealthMutationV1(mutation);
  return mutation;
}

function payloadOf(revision: BodySignalHealthRevisionValue) {
  return bodySignalHealthPayload(mutationOf(revision));
}

function payloadRecord(payload: BodySignalHealthPayloadV1) {
  if (!('record' in payload)) {
    throw new Error('body-signal.health tombstone 不含 record。');
  }
  return recordOf(payload.record, 'body-signal.health record');
}

function mergedPayload(
  kind: BodySignalHealthRecordKind,
  record: JsonRecord,
): JsonValue {
  return {
    schemaVersion: BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
    kind,
    record,
  };
}

function mergedDecision(input: {
  current: BodySignalHealthRevisionValue;
  incoming: BodySignalHealthRevisionValue;
  payload: JsonValue;
  operation: SyncOperation;
}): BodySignalHealthMergeDecision {
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
  current: BodySignalHealthRevisionValue;
  incoming: BodySignalHealthRevisionValue;
  conflictKind: BodySignalHealthConflictKind;
  conflictingFields?: string[];
}): BodySignalHealthMergeDecision {
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

function immutableFieldsForKind(kind: BodySignalHealthRecordKind) {
  if (kind === 'body-signal-reading') {
    return Object.freeze([
      'id',
      'kind',
      'value',
      'unit',
      'measuredAt',
      'receivedAt',
      'originDeviceId',
      'originPlatform',
      'sourceProvider',
      'sourceDeviceAlias',
      'confidence',
      'clockConfidence',
      'samplingMethod',
      'retentionUntil',
      'createdAt',
    ]);
  }
  if (kind === 'body-signal-care-summary') {
    return Object.freeze([
      'id',
      'dateKey',
      'kind',
      'originDeviceId',
      'originPlatform',
      'sourceScope',
    ]);
  }
  return Object.freeze(['id']);
}

function assertSequentialSummary(
  current: JsonRecord,
  incoming: JsonRecord,
) {
  const regressions: string[] = [];
  if (Number(incoming.sampleCount) < Number(current.sampleCount)) {
    regressions.push('sampleCount');
  }
  if (
    Number(incoming.firstMeasuredAt)
    > Number(current.firstMeasuredAt)
  ) {
    regressions.push('firstMeasuredAt');
  }
  if (
    Number(incoming.lastMeasuredAt)
    < Number(current.lastMeasuredAt)
  ) {
    regressions.push('lastMeasuredAt');
  }
  if (Number(incoming.minimum) > Number(current.minimum)) {
    regressions.push('minimum');
  }
  if (Number(incoming.maximum) < Number(current.maximum)) {
    regressions.push('maximum');
  }
  if (Number(incoming.updatedAt) < Number(current.updatedAt)) {
    regressions.push('updatedAt');
  }
  if (regressions.length) {
    throw new Error(
      `body signal care summary 不能倒退：${regressions.join(', ')}。`,
    );
  }
}

function validateSequentialState(
  current: BodySignalHealthRevisionValue,
  incoming: BodySignalHealthRevisionValue,
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
    throw new Error('body-signal.health sequential payload kind 不一致。');
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
      `body-signal.health 不可变字段不能修改：`
      + `${identityConflicts.join(', ')}。`,
    );
  }
  if (currentPayload.kind === 'body-signal-reading') {
    if (!sameValue(currentPayload, incomingPayload)) {
      throw new Error('body signal reading 是 append-only，不能改写。');
    }
    return;
  }
  if (currentPayload.kind === 'body-signal-care-summary') {
    assertSequentialSummary(currentRecord, incomingRecord);
  }
}

function mergeCollectionPolicy(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  base: JsonRecord | null;
}) {
  const fields = [
    'id',
    'autoMeasureAfterReconnect',
    'autoReconnectEnabled',
    'preferredDeviceAlias',
    'rawRetentionDays',
  ] as const;
  const record: JsonRecord = {};
  const conflicts: string[] = [];
  for (const field of fields) {
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

export function resolveBodySignalHealthRevisions(input: {
  current: BodySignalHealthRevisionValue | null;
  incoming: BodySignalHealthRevisionValue;
  base?: BodySignalHealthRevisionValue | null;
}): BodySignalHealthMergeDecision {
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
    throw new Error('body-signal.health 不能跨实体合并 revision。');
  }
  if (input.base) {
    mutationOf(input.base);
    if (
      input.base.entityType !== input.current.entityType
      || input.base.entityId !== input.current.entityId
    ) {
      throw new Error('body-signal.health merge base 不属于同一实体。');
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
    return mergedDecision({
      current: input.current,
      incoming: input.incoming,
      payload: {
        schemaVersion: BODY_SIGNAL_HEALTH_SCHEMA_VERSION,
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
      conflictKind: kind === 'body-signal-reading'
        ? 'append-identity'
        : 'identity-divergence',
      conflictingFields: identityConflicts,
    });
  }
  if (kind === 'body-signal-reading') {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'append-identity',
      conflictingFields: changedFields(currentRecord, incomingRecord),
    });
  }
  if (kind === 'body-signal-care-summary') {
    return conflictDecision({
      current: input.current,
      incoming: input.incoming,
      conflictKind: 'same-field',
      conflictingFields: changedFields(currentRecord, incomingRecord),
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
  const merged = mergeCollectionPolicy({
    current: currentRecord,
    incoming: incomingRecord,
    base: baseRecord,
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
