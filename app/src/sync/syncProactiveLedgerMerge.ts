import {
  assertProactiveLedgerMutationV1,
  assertProactiveLedgerRecord,
  proactiveLedgerEntityTypeForKind,
  proactiveLedgerRetentionForKind,
  PROACTIVE_LEDGER_SCHEMA_VERSION,
  type ProactiveAgentTaskRecord,
  type ProactiveLedgerEntityType,
  type ProactiveLedgerRecordKind,
  type ProactiveSocialDraftRecord,
  type ProactiveShareResponseExchangeRecord,
  type ProactiveWebVoyageLogRecord,
} from './syncProactiveLedger';
import type {
  JsonValue,
  PlainMutationV1,
  SyncOperation,
} from './syncProtocol';

export type ProactiveLedgerRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type ProactiveLedgerMergeDecision =
  | {
      kind: 'already-current' | 'apply-incoming' | 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'keep-current' | 'merged';
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
      conflictKind:
        | 'append-identity-divergence'
        | 'immutable-identity-divergence'
        | 'terminal-state-divergence';
      conflictingFields: string[];
    };

type JsonRecord = { [key: string]: JsonValue };

function recordOf(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as JsonRecord;
}

function payloadRecord(revision: ProactiveLedgerRevisionValue) {
  return recordOf(revision.payload, 'proactive.ledger revision payload');
}

function payloadKind(revision: ProactiveLedgerRevisionValue) {
  const kind = payloadRecord(revision).kind;
  if (typeof kind !== 'string') {
    throw new Error('proactive.ledger revision 缺少 kind。');
  }
  return kind as ProactiveLedgerRecordKind;
}

function payloadValue(revision: ProactiveLedgerRevisionValue) {
  return recordOf(
    payloadRecord(revision).value,
    'proactive.ledger revision value',
  );
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function equalJson(left: JsonValue, right: JsonValue) {
  return canonicalJson(left) === canonicalJson(right);
}

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function assertRevision(
  entityType: ProactiveLedgerEntityType,
  entityId: string,
  revision: ProactiveLedgerRevisionValue,
) {
  const kind = payloadKind(revision);
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: '10000000-0000-4000-8000-000000000001',
    vaultId: '20000000-0000-4000-8000-000000000002',
    sourceDeviceId: '30000000-0000-4000-8000-000000000003',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'proactive',
      type: entityType,
      id: entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: PROACTIVE_LEDGER_SCHEMA_VERSION,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: proactiveLedgerRetentionForKind(kind),
  };
  assertProactiveLedgerMutationV1(mutation);
}

function recordPayload(
  kind: ProactiveLedgerRecordKind,
  entityId: string,
  value: JsonRecord,
) {
  assertProactiveLedgerRecord(kind, entityId, value);
  return {
    schemaVersion: PROACTIVE_LEDGER_SCHEMA_VERSION,
    kind,
    value,
  } satisfies JsonValue;
}

function fieldsDiffer(
  left: JsonRecord,
  right: JsonRecord,
  fields: readonly string[],
) {
  return fields.filter((field) => (
    canonicalJson(left[field] ?? null)
    !== canonicalJson(right[field] ?? null)
  ));
}

function numberAt(value: JsonValue | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function taskTerminal(status: JsonValue | undefined) {
  return status === 'delivered'
    || status === 'cancelled'
    || status === 'expired';
}

function draftTerminal(status: JsonValue | undefined) {
  return status === 'approved' || status === 'discarded';
}

function shareResponseTerminal(status: JsonValue | undefined) {
  return status === 'engaged' || status === 'declined' || status === 'unanswered';
}

function laterRecord(
  current: JsonRecord,
  incoming: JsonRecord,
  currentRevisionId: string,
  incomingRevisionId: string,
  timestampField: string,
) {
  const currentAt = numberAt(current[timestampField]);
  const incomingAt = numberAt(incoming[timestampField]);
  if (currentAt !== incomingAt) {
    return currentAt > incomingAt ? current : incoming;
  }
  return currentRevisionId.localeCompare(incomingRevisionId) >= 0
    ? current
    : incoming;
}

function selectAgentTask(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const immutable = fieldsDiffer(
    input.current,
    input.incoming,
    [
      'id',
      'title',
      'message',
      'triggerAt',
      'sourceMessageId',
      'createdAt',
    ],
  );
  if (immutable.length) {
    return {
      conflictKind: 'immutable-identity-divergence' as const,
      conflictingFields: immutable,
    };
  }
  const currentTerminal = taskTerminal(input.current.status);
  const incomingTerminal = taskTerminal(input.incoming.status);
  if (
    currentTerminal
    && incomingTerminal
    && input.current.status !== input.incoming.status
  ) {
    return {
      conflictKind: 'terminal-state-divergence' as const,
      conflictingFields: ['status'],
    };
  }
  if (currentTerminal !== incomingTerminal) {
    return {
      value: currentTerminal ? input.current : input.incoming,
    };
  }
  return {
    value: laterRecord(
      input.current,
      input.incoming,
      input.currentRevisionId,
      input.incomingRevisionId,
      'updatedAt',
    ),
  };
}

function selectSocialDraft(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const immutable = fieldsDiffer(
    input.current,
    input.incoming,
    ['id', 'createdAt', 'kind', 'platform', 'reason'],
  );
  if (immutable.length) {
    return {
      conflictKind: 'immutable-identity-divergence' as const,
      conflictingFields: immutable,
    };
  }
  const currentTerminal = draftTerminal(input.current.status);
  const incomingTerminal = draftTerminal(input.incoming.status);
  if (
    currentTerminal
    && incomingTerminal
    && input.current.status !== input.incoming.status
  ) {
    return {
      conflictKind: 'terminal-state-divergence' as const,
      conflictingFields: ['status'],
    };
  }
  if (currentTerminal !== incomingTerminal) {
    return {
      value: currentTerminal ? input.current : input.incoming,
    };
  }
  return {
    value: laterRecord(
      input.current,
      input.incoming,
      input.currentRevisionId,
      input.incomingRevisionId,
      'updatedAt',
    ),
  };
}

function selectShareResponseExchange(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const immutable = fieldsDiffer(
    input.current,
    input.incoming,
    [
      'id',
      'sessionId',
      'origin',
      'invitationKind',
      'sourceMessageIds',
      'responseDriveKeys',
      'excerpt',
      'createdAt',
    ],
  );
  if (immutable.length) {
    return {
      conflictKind: 'immutable-identity-divergence' as const,
      conflictingFields: immutable,
    };
  }
  const currentTerminal = shareResponseTerminal(input.current.state);
  const incomingTerminal = shareResponseTerminal(input.incoming.state);
  if (
    currentTerminal
    && incomingTerminal
    && input.current.state !== input.incoming.state
  ) {
    return {
      conflictKind: 'terminal-state-divergence' as const,
      conflictingFields: ['state'],
    };
  }
  if (currentTerminal !== incomingTerminal) {
    return { value: currentTerminal ? input.current : input.incoming };
  }
  return {
    value: laterRecord(
      input.current,
      input.incoming,
      input.currentRevisionId,
      input.incomingRevisionId,
      'resolvedAt',
    ),
  };
}

function webShareRank(value: JsonValue | undefined) {
  if (value === 'delivered') return 3;
  if (value === 'failed') return 2;
  if (value === 'pending') return 1;
  return 0;
}

function selectWebVoyageLog(input: {
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  const immutable = fieldsDiffer(
    input.current,
    input.incoming,
    [
      'id',
      'at',
      'query',
      'summary',
      'title',
      'url',
      'sourceType',
      'readingStatus',
    ],
  );
  if (immutable.length) {
    return {
      conflictKind: 'immutable-identity-divergence' as const,
      conflictingFields: immutable,
    };
  }
  const currentRank = webShareRank(input.current.shareStatus);
  const incomingRank = webShareRank(input.incoming.shareStatus);
  // A stale projection must never give a consumed/cancelled share another model request.
  const preserveAttempt = (value: JsonRecord) => {
    const result = { ...value };
    for (const key of ['shareAttemptedAt', 'shareCancelledAt', 'shareChatHandoffAt']) {
      const times = [input.current[key], input.incoming[key]].filter((time): time is number => typeof time === 'number');
      if (times.length) result[key] = Math.min(...times);
    }
    return equalJson(result, value) ? value : result;
  };
  if (currentRank !== incomingRank) {
    return {
      value: preserveAttempt(currentRank > incomingRank
        ? input.current
        : input.incoming),
    };
  }
  return {
    value: preserveAttempt(laterRecord(
      input.current,
      input.incoming,
      input.currentRevisionId,
      input.incomingRevisionId,
      'sharedAt',
    )),
  };
}

function selectStatefulRecord(input: {
  kind: ProactiveLedgerRecordKind;
  current: JsonRecord;
  incoming: JsonRecord;
  currentRevisionId: string;
  incomingRevisionId: string;
}) {
  if (input.kind === 'agent-task') {
    return selectAgentTask(input);
  }
  if (input.kind === 'social-draft') {
    return selectSocialDraft(input);
  }
  if (input.kind === 'web-voyage-log') {
    return selectWebVoyageLog(input);
  }
  if (input.kind === 'share-response-exchange') {
    return selectShareResponseExchange(input);
  }
  throw new Error(`proactive.ledger ${input.kind} 不是状态机记录。`);
}

function mergeStateful(input: {
  entityId: string;
  kind: ProactiveLedgerRecordKind;
  current: ProactiveLedgerRevisionValue;
  incoming: ProactiveLedgerRevisionValue;
  heads: string[];
}): ProactiveLedgerMergeDecision {
  const selection = selectStatefulRecord({
    kind: input.kind,
    current: payloadValue(input.current),
    incoming: payloadValue(input.incoming),
    currentRevisionId: input.current.revisionId,
    incomingRevisionId: input.incoming.revisionId,
  });
  if ('conflictKind' in selection) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: input.heads,
      conflictKind: selection.conflictKind!,
      conflictingFields: selection.conflictingFields!,
    };
  }
  return {
    kind: selection.value === payloadValue(input.current)
      ? 'keep-current'
      : 'merged',
    payload: recordPayload(
      input.kind,
      input.entityId,
      selection.value,
    ),
    operation: 'upsert',
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

function directSuccessorDecision(input: {
  entityId: string;
  kind: ProactiveLedgerRecordKind;
  current: ProactiveLedgerRevisionValue;
  incoming: ProactiveLedgerRevisionValue;
}): ProactiveLedgerMergeDecision {
  if (input.current.operation === 'append') {
    if (equalJson(input.current.payload, input.incoming.payload)) {
      return {
        kind: 'apply-incoming',
        payload: input.incoming.payload,
        operation: input.incoming.operation,
        resultingHeadRevisionIds: [input.incoming.revisionId],
      };
    }
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: uniqueSorted([
        input.current.revisionId,
        input.incoming.revisionId,
      ]),
      conflictKind: 'append-identity-divergence',
      conflictingFields: [],
    };
  }
  const selection = selectStatefulRecord({
    kind: input.kind,
    current: payloadValue(input.current),
    incoming: payloadValue(input.incoming),
    currentRevisionId: input.current.revisionId,
    incomingRevisionId: input.incoming.revisionId,
  });
  if ('conflictKind' in selection) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: uniqueSorted([
        input.current.revisionId,
        input.incoming.revisionId,
      ]),
      conflictKind: selection.conflictKind!,
      conflictingFields: selection.conflictingFields!,
    };
  }
  if (selection.value === payloadValue(input.incoming)) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const heads = uniqueSorted([
    input.current.revisionId,
    input.incoming.revisionId,
  ]);
  if (input.kind === 'web-voyage-log' && !equalJson(selection.value, payloadValue(input.current))) {
    return {
      kind: 'merged',
      payload: recordPayload(input.kind, input.entityId, selection.value),
      operation: 'upsert',
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  return {
    kind: 'keep-current',
    payload: input.current.payload,
    operation: input.current.operation,
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}

export function resolveProactiveLedgerRevisions(input: {
  entityType: ProactiveLedgerEntityType;
  entityId: string;
  current: ProactiveLedgerRevisionValue | null;
  incoming: ProactiveLedgerRevisionValue;
}): ProactiveLedgerMergeDecision {
  assertRevision(input.entityType, input.entityId, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityType, input.entityId, input.current);
  const currentKind = payloadKind(input.current);
  const incomingKind = payloadKind(input.incoming);
  if (
    currentKind !== incomingKind
    || proactiveLedgerEntityTypeForKind(currentKind) !== input.entityType
  ) {
    throw new Error('proactive.ledger revision kind 不一致。');
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
    return directSuccessorDecision({
      entityId: input.entityId,
      kind: currentKind,
      current: input.current,
      incoming: input.incoming,
    });
  }
  const heads = uniqueSorted([
    input.current.revisionId,
    input.incoming.revisionId,
  ]);
  if (input.current.operation === 'append') {
    if (equalJson(input.current.payload, input.incoming.payload)) {
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: input.current.operation,
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: heads,
      conflictKind: 'append-identity-divergence',
      conflictingFields: [],
    };
  }
  return mergeStateful({
    entityId: input.entityId,
    kind: currentKind,
    current: input.current,
    incoming: input.incoming,
    heads,
  });
}

export type ProactiveLedgerTypedStateRecords = {
  agentTask: ProactiveAgentTaskRecord;
  shareResponseExchange: ProactiveShareResponseExchangeRecord;
  socialDraft: ProactiveSocialDraftRecord;
  webVoyageLog: ProactiveWebVoyageLogRecord;
};
