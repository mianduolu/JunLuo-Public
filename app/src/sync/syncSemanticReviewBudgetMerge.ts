import type { BaiyunSemanticReviewEntry } from '../ai/behavior/actionBudget';
import {
  assertSemanticReviewBudgetMutationV1,
  semanticReviewLedgerRecordFromMutation,
} from './syncSemanticReviewBudget';
import type { JsonValue, PlainMutationV1 } from './syncProtocol';

export type SemanticReviewBudgetRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: PlainMutationV1['revision']['operation'];
  createdAt: number;
  entityId: string;
  payload: JsonValue;
};

export type SemanticReviewBudgetMergeDecision = {
  kind:
    | 'already-current'
    | 'apply-incoming'
    | 'conflict'
    | 'ignore-incoming'
    | 'keep-current'
    | 'merged';
  payload: JsonValue;
  operation: 'upsert';
  resultingHeadRevisionIds: string[];
  conflictKind?: 'semantic-review-entry-divergence';
  conflictingFields?: string[];
  requiresMergeRevision?: boolean;
  mergeParentRevisionIds?: string[];
};

function mutationOf(
  revision: SemanticReviewBudgetRevisionValue,
): PlainMutationV1 {
  return {
    protocolVersion: 1,
    mutationId: '40000000-0000-4000-8000-000000000001',
    vaultId: '10000000-0000-4000-8000-000000000001',
    sourceDeviceId: revision.entityId.slice(0, 36),
    sourceSequence: 1,
    createdAt: revision.createdAt,
    entity: {
      domain: 'usage',
      type: 'semantic-review-budget',
      id: revision.entityId,
    },
    revision: {
      id: revision.revisionId,
      parents: revision.parentRevisionIds,
      operation: revision.operation,
      schemaVersion: 1,
    },
    sensitivity: 'high',
    payload: revision.payload,
    objectRefs: [],
    retentionClass: 'semantic-review-budget-ledger',
  };
}

function assertRevision(revision: SemanticReviewBudgetRevisionValue) {
  assertSemanticReviewBudgetMutationV1(mutationOf(revision));
}

function record(revision: SemanticReviewBudgetRevisionValue) {
  return semanticReviewLedgerRecordFromMutation(mutationOf(revision));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sortedHeads(...ids: string[]) {
  return [...new Set(ids)].sort();
}

function terminal(entry: BaiyunSemanticReviewEntry) {
  return entry.outcome !== 'request_started';
}

const IMMUTABLE_FIELDS = [
  'id',
  'fingerprint',
  'currentMessageId',
  'attemptedAt',
  'ambiguityReasons',
  'connectionId',
  'connectionName',
  'model',
  'summary',
] as const;

function divergentFields(
  left: ReturnType<typeof record>,
  right: ReturnType<typeof record>,
) {
  const fields: string[] = [];
  if (left.localDate !== right.localDate) fields.push('localDate');
  if (left.remoteAccountId !== right.remoteAccountId) {
    fields.push('remoteAccountId');
  }
  for (const field of IMMUTABLE_FIELDS) {
    if (stableJson(left.entry[field]) !== stableJson(right.entry[field])) {
      fields.push(`entry.${field}`);
    }
  }
  if (
    terminal(left.entry)
    && terminal(right.entry)
    && (
      left.entry.outcome !== right.entry.outcome
      || stableJson(left.entry.signalKinds)
        !== stableJson(right.entry.signalKinds)
      || stableJson(left.entry.confidences)
        !== stableJson(right.entry.confidences)
      || left.entry.durationMs !== right.entry.durationMs
    )
  ) {
    fields.push('entry.outcome');
  }
  return fields;
}

function preferredTerminal(
  left: SemanticReviewBudgetRevisionValue,
  right: SemanticReviewBudgetRevisionValue,
) {
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (terminal(leftRecord.entry) && !terminal(rightRecord.entry)) return left;
  if (!terminal(leftRecord.entry) && terminal(rightRecord.entry)) return right;
  return left;
}

export function resolveSemanticReviewBudgetRevisions(input: {
  current: SemanticReviewBudgetRevisionValue | null;
  incoming: SemanticReviewBudgetRevisionValue;
}): SemanticReviewBudgetMergeDecision {
  assertRevision(input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.current);
  if (input.current.entityId !== input.incoming.entityId) {
    throw new Error('semantic review budget 不能跨 entry 合并 revision。');
  }
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  const currentRecord = record(input.current);
  const incomingRecord = record(input.incoming);
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    const divergence = divergentFields(currentRecord, incomingRecord);
    if (divergence.length) {
      return {
        kind: 'conflict',
        payload: input.current.payload,
        operation: 'upsert',
        resultingHeadRevisionIds: sortedHeads(
          input.current.revisionId,
          input.incoming.revisionId,
        ),
        conflictKind: 'semantic-review-entry-divergence',
        conflictingFields: divergence,
      };
    }
    if (terminal(currentRecord.entry) && !terminal(incomingRecord.entry)) {
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: 'upsert',
        resultingHeadRevisionIds: sortedHeads(
          input.current.revisionId,
          input.incoming.revisionId,
        ),
        requiresMergeRevision: true,
        mergeParentRevisionIds: sortedHeads(
          input.current.revisionId,
          input.incoming.revisionId,
        ),
      };
    }
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  const heads = sortedHeads(
    input.current.revisionId,
    input.incoming.revisionId,
  );
  if (stableJson(input.current.payload) === stableJson(input.incoming.payload)) {
    return {
      kind: 'merged',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: heads,
      requiresMergeRevision: true,
      mergeParentRevisionIds: heads,
    };
  }
  const divergence = divergentFields(currentRecord, incomingRecord);
  if (divergence.length) {
    return {
      kind: 'conflict',
      payload: input.current.payload,
      operation: 'upsert',
      resultingHeadRevisionIds: heads,
      conflictKind: 'semantic-review-entry-divergence',
      conflictingFields: divergence,
    };
  }
  const preferred = preferredTerminal(input.current, input.incoming);
  return {
    kind: 'merged',
    payload: preferred.payload,
    operation: 'upsert',
    resultingHeadRevisionIds: heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: heads,
  };
}
