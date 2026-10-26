import {
  assertToolsAuditMutationV1,
  toolsAuditMutationValue,
  toolsAuditRecordsEqual,
  toolsAuditRecordsEqualForKind,
  type ToolsAuditRecordKind,
  type ToolsAuditRecordValue,
} from './syncToolsAudit';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';
import { mergeOwnScheduleSaves } from '../schedule/ownScheduleSaveState';
import { mergeUserRoutineSaves } from '../schedule/userRoutineSaveState';
import {
  mergeMusicPlaybackObservations,
  musicPlaybackObservationsEqual,
} from '../music/musicPlaybackObservation';

export type ToolsAuditRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityType: string;
  entityId: string;
  payload: JsonValue;
};

export type ToolsAuditMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'merged';
  payload: JsonValue;
  operation: 'append' | 'upsert' | 'delete';
  resultingHeadRevisionIds: string[];
  conflictKind?: 'tools-audit-immutable-divergence'
    | 'tools-audit-state-divergence';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

const STATUS_RANK: Readonly<Record<string, number>> = {
  requested: 0,
  running: 1,
  permission_denied: 2,
  success: 2,
  error: 2,
  cancelled: 2,
};

function mutationOf(revision: ToolsAuditRevisionValue): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: '20000000-0000-4000-8000-000000000002',
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'tools',
      type: revision.entityType,
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'highest',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: revision.entityType === 'call-intent'
      ? 'tools-formal-action'
      : revision.entityType === 'call-result'
        ? 'tools-formal-result'
        : 'tools-audit-180d',
  };
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => (
      `${JSON.stringify(key)}:${canonicalJson(entry)}`
    ))
    .join(',')}}`;
}

function optionalFieldIsForward(
  current: unknown,
  incoming: unknown,
) {
  return current === undefined || current === incoming;
}

function permissionIsForward(
  current: ToolsAuditRecordValue['permissionDecision'],
  incoming: ToolsAuditRecordValue['permissionDecision'],
) {
  return current === 'not_checked' || current === incoming;
}

export function repairLegacyToolsAuditFallback(input: {
  kind: ToolsAuditRecordKind;
  current: ToolsAuditRecordValue;
  incoming: ToolsAuditRecordValue;
}) {
  const { current } = input;
  let incoming = input.incoming;
  if (stableCallContextEqualExceptCreatedAt(current, incoming)) {
    incoming = {
      ...incoming,
      createdAt: current.createdAt,
    };
  }
  const timestampRepaired = {
    ...incoming,
    createdAt: current.createdAt,
  };
  if (
    toolsAuditRecordsEqualForKind(
      input.kind,
      current,
      timestampRepaired,
    )
  ) {
    return timestampRepaired;
  }
  const looksLikeLegacyFallback = (
    current.callId === incoming.callId
    && current.toolId === incoming.toolId
    && current.packageId.length > 0
    && incoming.packageId === ''
    && incoming.source === 'manual'
    && incoming.sourceMessageId === undefined
    && Object.keys(incoming.inputPreview).length === 0
    && incoming.createdAt >= current.createdAt
    && !(
      current.executionId
      && incoming.executionId
      && current.executionId !== incoming.executionId
    )
  );
  if (!looksLikeLegacyFallback) return incoming;
  const repaired: ToolsAuditRecordValue = {
    ...incoming,
    packageId: current.packageId,
    source: current.source,
    inputPreview: structuredClone(current.inputPreview),
    createdAt: current.createdAt,
  };
  const executionId = current.executionId ?? incoming.executionId;
  if (executionId !== undefined) repaired.executionId = executionId;
  else delete repaired.executionId;
  if (current.sourceMessageId !== undefined) {
    repaired.sourceMessageId = current.sourceMessageId;
  } else {
    delete repaired.sourceMessageId;
  }
  if (input.kind !== 'call-intent') {
    repaired.permissionDecision =
      current.permissionDecision === 'not_checked'
        ? incoming.permissionDecision
        : current.permissionDecision;
    const permissionSource =
      current.permissionSource ?? incoming.permissionSource;
    if (permissionSource !== undefined) {
      repaired.permissionSource = permissionSource;
    } else delete repaired.permissionSource;
    const permissionGrantId =
      current.permissionGrantId ?? incoming.permissionGrantId;
    if (permissionGrantId !== undefined) {
      repaired.permissionGrantId = permissionGrantId;
    } else delete repaired.permissionGrantId;
    const permissionExpiresAt =
      current.permissionExpiresAt ?? incoming.permissionExpiresAt;
    if (permissionExpiresAt !== undefined) {
      repaired.permissionExpiresAt = permissionExpiresAt;
    } else delete repaired.permissionExpiresAt;
    const permissionSilent =
      current.permissionSilent ?? incoming.permissionSilent;
    if (permissionSilent !== undefined) {
      repaired.permissionSilent = permissionSilent;
    } else delete repaired.permissionSilent;
    const startedAt = current.startedAt ?? incoming.startedAt;
    if (startedAt !== undefined) repaired.startedAt = startedAt;
    else delete repaired.startedAt;
  }
  return repaired;
}

function stableCallContextEqualExceptCreatedAt(
  current: ToolsAuditRecordValue,
  incoming: ToolsAuditRecordValue,
) {
  return (
    current.callId === incoming.callId
    && current.toolId === incoming.toolId
    && current.packageId === incoming.packageId
    && current.source === incoming.source
    && current.sourceMessageId === incoming.sourceMessageId
    && canonicalJson(current.inputPreview)
      === canonicalJson(incoming.inputPreview)
  );
}

function stableCallContextEqual(
  current: ToolsAuditRecordValue,
  incoming: ToolsAuditRecordValue,
) {
  return current.createdAt === incoming.createdAt
    && stableCallContextEqualExceptCreatedAt(current, incoming);
}

export function isToolsAuditStateSuccessor(
  current: ToolsAuditRecordValue,
  incoming: ToolsAuditRecordValue,
) {
  if (!stableCallContextEqual(current, incoming)) return false;
  const currentRank = STATUS_RANK[current.status];
  const incomingRank = STATUS_RANK[incoming.status];
  if (incomingRank < currentRank) return false;
  if (
    currentRank === 2
    && incoming.status !== current.status
  ) {
    return false;
  }
  return (
    optionalFieldIsForward(
      current.executionId,
      incoming.executionId,
    )
    && permissionIsForward(
      current.permissionDecision,
      incoming.permissionDecision,
    )
    && optionalFieldIsForward(
      current.permissionSource,
      incoming.permissionSource,
    )
    && optionalFieldIsForward(
      current.permissionGrantId,
      incoming.permissionGrantId,
    )
    && optionalFieldIsForward(
      current.permissionExpiresAt,
      incoming.permissionExpiresAt,
    )
    && optionalFieldIsForward(
      current.permissionSilent,
      incoming.permissionSilent,
    )
    && optionalFieldIsForward(
      current.startedAt,
      incoming.startedAt,
    )
    && optionalFieldIsForward(
      current.finishedAt,
      incoming.finishedAt,
    )
    && optionalFieldIsForward(
      current.resultSummary,
      incoming.resultSummary,
    )
    && optionalFieldIsForward(
      current.errorMessage,
      incoming.errorMessage,
    )
  );
}

export function mergeToolsAuditProjection(input: {
  current: ToolsAuditRecordValue | null;
  incoming: ToolsAuditRecordValue;
}) {
  if (!input.current) return input.incoming;
  if (toolsAuditRecordsEqual(input.current, input.incoming)) {
    return input.current;
  }
  const selected = isToolsAuditStateSuccessor(input.current, input.incoming)
    ? input.incoming
    : isToolsAuditStateSuccessor(input.incoming, input.current) ? input.current : null;
  if (selected) {
    return { ...selected,
      ...(input.current.musicPlayback || input.incoming.musicPlayback
        ? { musicPlayback: mergeMusicPlaybackObservations(input.current.musicPlayback, input.incoming.musicPlayback) } : {}),
      ...(input.current.scheduleSave || input.incoming.scheduleSave
        ? { scheduleSave: mergeOwnScheduleSaves(input.current.scheduleSave, input.incoming.scheduleSave) } : {}),
      ...(input.current.routineSave || input.incoming.routineSave
        ? { routineSave: mergeUserRoutineSaves(input.current.routineSave, input.incoming.routineSave) } : {}) };
  }
  throw new Error('tools.audit 状态出现不可单调合并的分歧。');
}

function recordValue(revision: ToolsAuditRevisionValue) {
  return toolsAuditMutationValue(mutationOf(revision));
}

function decision(input: {
  revision: ToolsAuditRevisionValue;
  kind: ToolsAuditMergeDecision['kind'];
  heads: string[];
  payload?: JsonValue;
}): ToolsAuditMergeDecision {
  return {
    kind: input.kind,
    payload: input.payload ?? input.revision.payload,
    operation: input.revision.operation as 'append' | 'upsert' | 'delete',
    resultingHeadRevisionIds: input.heads,
  };
}

function concurrentMerged(input: {
  current: ToolsAuditRevisionValue;
  incoming: ToolsAuditRevisionValue;
  payload: JsonValue;
  operation: 'append' | 'upsert' | 'delete';
}): ToolsAuditMergeDecision {
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

function divergence(input: {
  current: ToolsAuditRevisionValue | null;
  incoming: ToolsAuditRevisionValue;
  kind: ToolsAuditRecordKind;
}): ToolsAuditMergeDecision {
  const current = input.current;
  if (!current) {
    throw new Error('tools.audit conflict 缺少当前 revision。');
  }
  return {
    kind: 'conflict',
    payload: current.payload,
    operation: current.operation as 'append' | 'upsert' | 'delete',
    resultingHeadRevisionIds: sortedHeads(
      current.revisionId,
      input.incoming.revisionId,
    ),
    conflictKind: input.kind === 'audit-event'
      ? 'tools-audit-state-divergence'
      : 'tools-audit-immutable-divergence',
    conflictingFields: input.kind === 'audit-event'
      ? ['status', 'permissionDecision', 'resultSummary']
      : ['value'],
  };
}

function resolveToolsAuditStateRevisions(input: {
  current: ToolsAuditRevisionValue | null;
  incoming: ToolsAuditRevisionValue;
}): ToolsAuditMergeDecision {
  assertToolsAuditMutationV1(mutationOf(input.incoming));
  if (input.current === null) {
    return decision({
      revision: input.incoming,
      kind: 'apply-incoming',
      heads: [input.incoming.revisionId],
    });
  }
  assertToolsAuditMutationV1(mutationOf(input.current));
  if (
    input.current.entityType !== input.incoming.entityType
    || input.current.entityId !== input.incoming.entityId
  ) {
    throw new Error('tools.audit 不能跨实体合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return decision({
      revision: input.current,
      kind: 'already-current',
      heads: [input.current.revisionId],
    });
  }
  const currentDelete = input.current.operation === 'delete';
  const incomingDelete = input.incoming.operation === 'delete';
  if (currentDelete || incomingDelete) {
    if (
      incomingDelete
      && input.incoming.parentRevisionIds.includes(
        input.current.revisionId,
      )
    ) {
      return decision({
        revision: input.incoming,
        kind: 'apply-incoming',
        heads: [input.incoming.revisionId],
      });
    }
    if (
      currentDelete
      && input.current.parentRevisionIds.includes(
        input.incoming.revisionId,
      )
    ) {
      return decision({
        revision: input.current,
        kind: 'ignore-incoming',
        heads: [input.current.revisionId],
      });
    }
    const heads = sortedHeads(
      input.current.revisionId,
      input.incoming.revisionId,
    );
    if (currentDelete && incomingDelete) {
      const currentPayload = input.current.payload as Record<string, unknown>;
      const incomingPayload = input.incoming.payload as Record<string, unknown>;
      return {
        kind: 'merged',
        payload: {
          schemaVersion: 1,
          kind: 'audit-event',
          deletedAt: Math.max(
            Number(currentPayload.deletedAt ?? 0),
            Number(incomingPayload.deletedAt ?? 0),
          ),
        },
        operation: 'delete',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: input.current.operation as 'append' | 'upsert' | 'delete',
      resultingHeadRevisionIds: heads,
      conflictKind: 'tools-audit-state-divergence',
      conflictingFields: ['value'],
    };
  }
  const current = recordValue(input.current);
  const incoming = recordValue(input.incoming);
  if (
    input.current.parentRevisionIds.includes(
      input.incoming.revisionId,
    )
  ) {
    const valid = current.kind === 'audit-event'
      ? (
          isToolsAuditStateSuccessor(
            incoming.value,
            current.value,
          )
          || toolsAuditRecordsEqualForKind(
            current.kind,
            current.value,
            incoming.value,
          )
        )
      : toolsAuditRecordsEqualForKind(
          current.kind,
          current.value,
          incoming.value,
        );
    if (!valid) {
      return divergence({ ...input, kind: current.kind });
    }
    return decision({
      revision: input.current,
      kind: 'ignore-incoming',
      heads: [input.current.revisionId],
    });
  }
  if (
    input.incoming.parentRevisionIds.includes(
      input.current.revisionId,
    )
  ) {
    const valid = incoming.kind === 'audit-event'
      ? (
          isToolsAuditStateSuccessor(
            current.value,
            incoming.value,
          )
          || toolsAuditRecordsEqualForKind(
            incoming.kind,
            current.value,
            incoming.value,
          )
        )
      : toolsAuditRecordsEqualForKind(
          incoming.kind,
          current.value,
          incoming.value,
        );
    if (!valid) {
      return divergence({ ...input, kind: incoming.kind });
    }
    if (
      incoming.kind === 'audit-event'
      && !isToolsAuditStateSuccessor(current.value, incoming.value)
      && !toolsAuditRecordsEqual(current.value, incoming.value)
    ) {
      return {
        kind: 'conflict',
        payload: input.current.payload,
        operation: 'upsert',
        resultingHeadRevisionIds: sortedHeads(
          input.current.revisionId,
          input.incoming.revisionId,
        ),
        conflictKind: 'tools-audit-state-divergence',
        conflictingFields: ['status'],
      };
    }
    return decision({
      revision: input.incoming,
      kind: 'apply-incoming',
      heads: [input.incoming.revisionId],
    });
  }
  if (current.kind !== incoming.kind) {
    throw new Error('tools.audit kind 合并边界无效。');
  }
  if (toolsAuditRecordsEqualForKind(
    current.kind,
    current.value,
    incoming.value,
  )) {
    return concurrentMerged({
      current: input.current,
      incoming: input.incoming,
      payload: input.current.payload,
      operation: input.current.operation as 'append' | 'upsert',
    });
  }
  if (current.kind === 'audit-event') {
    if (isToolsAuditStateSuccessor(current.value, incoming.value)) {
      return concurrentMerged({
        current: input.current,
        incoming: input.incoming,
        payload: input.incoming.payload,
        operation: 'upsert',
      });
    }
    if (isToolsAuditStateSuccessor(incoming.value, current.value)) {
      return concurrentMerged({
        current: input.current,
        incoming: input.incoming,
        payload: input.current.payload,
        operation: 'upsert',
      });
    }
  }
  return divergence({ ...input, kind: current.kind });
}

export function resolveToolsAuditRevisions(input: {
  current: ToolsAuditRevisionValue | null;
  incoming: ToolsAuditRevisionValue;
}): ToolsAuditMergeDecision {
  // Resolve the original immutable/status contract first. Observations cannot
  // turn an invalid tool result, signature identity or state regression valid.
  const resolved = resolveToolsAuditStateRevisions(input);
  if (!input.current || resolved.kind === 'conflict' || resolved.operation !== 'upsert'
    || input.current.operation === 'delete' || input.incoming.operation === 'delete') return resolved;
  const current = recordValue(input.current);
  const incoming = recordValue(input.incoming);
  if (current.kind !== 'audit-event' || incoming.kind !== 'audit-event'
    || (!current.value.musicPlayback && !incoming.value.musicPlayback && !current.value.scheduleSave && !incoming.value.scheduleSave
      && !current.value.routineSave && !incoming.value.routineSave)) return resolved;
  let musicPlayback;
  try {
    if (input.current.revisionId === input.incoming.revisionId
      && (!musicPlaybackObservationsEqual(current.value.musicPlayback, incoming.value.musicPlayback)
        || canonicalJson(current.value.scheduleSave) !== canonicalJson(incoming.value.scheduleSave)
        || canonicalJson(current.value.routineSave) !== canonicalJson(incoming.value.routineSave))) {
      return divergence({ ...input, kind: 'audit-event' });
    }
    musicPlayback = mergeMusicPlaybackObservations(current.value.musicPlayback, incoming.value.musicPlayback);
  } catch {
    return divergence({ ...input, kind: 'audit-event' });
  }
  const payload = resolved.payload as Record<string, JsonValue>;
  const value = payload.value as unknown as ToolsAuditRecordValue;
  let scheduleSave;
  let routineSave;
  try { routineSave = mergeUserRoutineSaves(current.value.routineSave, incoming.value.routineSave); }
  catch { return divergence({ ...input, kind: 'audit-event' }); }
  try { scheduleSave = mergeOwnScheduleSaves(current.value.scheduleSave, incoming.value.scheduleSave); }
  catch { return divergence({ ...input, kind: 'audit-event' }); }
  if (musicPlaybackObservationsEqual(value.musicPlayback, musicPlayback) && canonicalJson(value.scheduleSave) === canonicalJson(scheduleSave)
    && canonicalJson(value.routineSave) === canonicalJson(routineSave)) return resolved;
  return concurrentMerged({ current: input.current, incoming: input.incoming, operation: 'upsert',
    payload: { ...payload, value: { ...value, ...(musicPlayback.length ? { musicPlayback } : {}), ...(scheduleSave ? { scheduleSave } : {}),
      ...(routineSave ? { routineSave } : {}) } as unknown as JsonValue } });
}
