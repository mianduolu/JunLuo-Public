import { canonicalizeContinuityMatterRecord } from '../ai/behavior/continuityMatterRecord';
import { normalizePostConfirmationRecord } from './syncBaiyunPostConfirmations';
import { assertPostReviewActionIntentUnchanged } from './syncBaiyunPostReviews';
import {
  assertContinuityEventRecordSuccessor,
} from './syncContinuityLedger';
import {
  assertMemoryRecordPayload,
  getMemoryRecordEntitySpec,
  MEMORY_RECORDS_SCHEMA_VERSION,
  MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION,
  type MemoryRecordEntityType,
} from './syncMemoryRecords';
import type {
  JsonValue,
  SyncOperation,
} from './syncProtocol';

export type MemoryRecordRevisionValue = {
  revisionId: string;
  parentRevisionIds: string[];
  operation: SyncOperation;
  createdAt: number;
  payload: JsonValue;
};

export type MemoryRecordMergeDecision =
  | {
      kind: 'already-current';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'apply-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'ignore-incoming';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
    }
  | {
      kind: 'keep-current';
      payload: JsonValue;
      operation: SyncOperation;
      resultingHeadRevisionIds: string[];
      requiresMergeRevision: true;
      mergeParentRevisionIds: string[];
    }
  | {
      kind: 'merged';
      payload: JsonValue;
      operation: Extract<SyncOperation, 'upsert' | 'restore' | 'delete'>;
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
        | 'append-payload-mismatch'
        | 'delete-modify'
        | 'same-field'
        | 'terminal-state-mismatch';
      conflictingFields: string[];
      requiresMergeRevision?: true;
      mergeParentRevisionIds?: string[];
    };

function recordOf(value: unknown, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, JsonValue>;
}

function payloadRecord(value: JsonValue, entityType?: MemoryRecordEntityType) {
  const record = recordOf(recordOf(value, 'memory revision payload').record, 'memory revision record');
  if (entityType === 'memory') return {
    weekly_context_basis_json: null, understanding_subject: null, understanding_basis_json: null, chat_summary_correction_json: null,
    stats_semantics_version: 0, last_mentioned_at: null, ...record,
    ...([9, 10].includes(Number(recordOf(value, 'memory revision payload').schemaVersion))
      && record.stats_semantics_version === 1 ? {} : { stats_semantics_version: 0,
        activation_count: 0, last_active_at: 0, surface_count: 0, last_mentioned_at: null }),
  };
  if (entityType === 'current-state') return { known_at: null, source_refs_json: '[]', ...record };
  return 'required_behaviors_json' in record ? canonicalizeContinuityMatterRecord(record) : record;
}

const MEMORY_STATS_FIELDS = new Set([
  'activation_count', 'last_active_at', 'surface_count', 'stats_semantics_version', 'last_mentioned_at',
]);

/** Runtime aggregates are conservative maxima, never a merge of the old weighted counters. */
export function mergeMemoryStatsRecord(
  selected: Record<string, JsonValue>,
  records: readonly Record<string, JsonValue>[],
): Record<string, JsonValue> {
  const current = records.filter(record => record.stats_semantics_version === 1);
  const maximum = (field: string) => Math.max(0, ...current.map(record => Number(record[field] ?? 0)));
  const mentions = current.map(record => record.last_mentioned_at).filter((at): at is number => typeof at === 'number');
  return { ...selected, stats_semantics_version: 1, activation_count: maximum('activation_count'),
    last_active_at: maximum('last_active_at'), surface_count: maximum('surface_count'),
    last_mentioned_at: mentions.length ? Math.max(...mentions) : null };
}

export function mergeMemoryStatsPayload(payload: JsonValue, entityType: MemoryRecordEntityType, otherPayload?: JsonValue): JsonValue {
  const record = payloadRecord(payload, entityType);
  if (entityType === 'memory') {
    const other = otherPayload ? payloadRecord(otherPayload, entityType) : null;
    return { schemaVersion: MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION,
      record: mergeMemoryStatsRecord(record, other ? [record, other] : [record]) };
  }
  const postBody = (value: JsonValue) => {
    const body = recordOf(JSON.parse(String(payloadRecord(value).memory_json)), 'post memory');
    return [9, 10].includes(Number(recordOf(value, 'post payload').schemaVersion))
      ? { ...body, ...('chat_summary_correction_json' in body ? {} : { chat_summary_correction_json: null }) }
      : { ...body, ...('chat_summary_correction_json' in body ? {} : { chat_summary_correction_json: null }), stats_semantics_version: 0 };
  };
  const body = postBody(payload);
  const other = otherPayload ? postBody(otherPayload) : null;
  const otherPost = otherPayload ? payloadRecord(otherPayload) : null;
  const images = !('image_assets_json' in record) && otherPost && 'image_assets_json' in otherPost
    ? { image_group_json: otherPost.image_group_json, image_assets_json: otherPost.image_assets_json,
      image_description: otherPost.image_description } : {};
  return { schemaVersion: MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION, record: {
    image_group_json: null, image_assets_json: '[]', image_description: null, ...images, ...record,
    memory_json: JSON.stringify(mergeMemoryStatsRecord(body, other ? [body, other] : [body])),
  } };
}

function comparablePayload(payload: JsonValue, entityType: MemoryRecordEntityType): JsonValue {
  return entityType === 'post-confirmation' ? { ...recordOf(payload, 'post-confirmation payload'),
    record: normalizePostConfirmationRecord(payloadRecord(payload)) } : payload;
}

function compareJson(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => compareJson(value, right[index]));
  }
  if (typeof left !== 'object' || Array.isArray(right)) return false;
  const leftRecord = left as Record<string, JsonValue>;
  const rightRecord = right as Record<string, JsonValue>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => (
      key === rightKeys[index] && compareJson(leftRecord[key], rightRecord[key])
    ))
  );
}

export const sameMemoryRecordPayload = compareJson;

function uniqueSorted(values: readonly string[]) {
  return [...new Set(values)].sort();
}

function deterministicRevision(
  left: MemoryRecordRevisionValue,
  right: MemoryRecordRevisionValue,
) {
  return left.revisionId.localeCompare(right.revisionId) <= 0 ? left : right;
}

function assertRevision(
  entityType: MemoryRecordEntityType,
  revision: MemoryRecordRevisionValue,
) {
  if (!revision.revisionId || revision.revisionId.length > 80) {
    throw new Error('memory revisionId 无效。');
  }
  if (
    !Array.isArray(revision.parentRevisionIds)
    || revision.parentRevisionIds.length > 32
    || revision.parentRevisionIds.some((id) => !id || id.length > 80)
  ) {
    throw new Error('memory parentRevisionIds 无效。');
  }
  if (!Number.isSafeInteger(revision.createdAt) || revision.createdAt < 0) {
    throw new Error('memory revision createdAt 无效。');
  }
  assertMemoryRecordPayload(entityType, revision.operation, revision.payload);
}

function isTerminalState(
  entityType: MemoryRecordEntityType,
  revision: MemoryRecordRevisionValue,
) {
  if (revision.operation === 'delete') return true;
  if (entityType === 'post-review-action') return payloadRecord(revision.payload).state !== 'pending';
  const status = payloadRecord(revision.payload).status;
  if (entityType === 'post-review') return status === 'saved' || status === 'discarded' || status === 'suppressed';
  if (entityType === 'continuity-event') {
    return status === 'completed' || status === 'cancelled';
  }
  return status === 'resolved' || status === 'expired';
}

function stateStatus(revision: MemoryRecordRevisionValue) {
  if (revision.operation === 'delete') return 'deleted';
  const record = payloadRecord(revision.payload);
  const status = record.status ?? record.state;
  return typeof status === 'string' ? status : 'unknown';
}

function concurrentDeleteDecision(input: {
  current: MemoryRecordRevisionValue;
  incoming: MemoryRecordRevisionValue;
  heads: string[];
}): MemoryRecordMergeDecision | null {
  const currentDeleted = input.current.operation === 'delete';
  const incomingDeleted = input.incoming.operation === 'delete';
  if (!currentDeleted && !incomingDeleted) return null;
  if (currentDeleted && incomingDeleted) {
    const selected = input.incoming.revisionId.localeCompare(input.current.revisionId) >= 0
      ? input.incoming
      : input.current;
    return {
      kind: selected === input.incoming ? 'apply-incoming' : 'keep-current',
      payload: selected.payload,
      operation: selected.operation,
      resultingHeadRevisionIds: input.heads,
      ...(selected === input.current ? {
        requiresMergeRevision: true as const,
        mergeParentRevisionIds: input.heads,
      } : {}),
    } as MemoryRecordMergeDecision;
  }
  const deleted = currentDeleted ? input.current : input.incoming;
  return {
    kind: 'conflict',
    payload: deleted.payload,
    operation: 'delete',
    resultingHeadRevisionIds: input.heads,
    conflictKind: 'delete-modify',
    conflictingFields: [],
  };
}

function mergeFields(input: {
  entityType: MemoryRecordEntityType;
  current: MemoryRecordRevisionValue;
  incoming: MemoryRecordRevisionValue;
  base?: MemoryRecordRevisionValue | null;
  heads: string[];
}): MemoryRecordMergeDecision {
  const currentRecord = payloadRecord(input.current.payload, input.entityType);
  const incomingRecord = payloadRecord(input.incoming.payload, input.entityType);
  const baseRecord = input.base && input.base.operation !== 'delete'
    ? payloadRecord(input.base.payload, input.entityType)
    : null;
  const fields = Object.keys(getMemoryRecordEntitySpec(input.entityType)?.fields ?? {});
  const merged: Record<string, JsonValue> = {};
  const conflictingFields: string[] = [];
  // A derived memory and its evidence describe one editable version. Concurrent
  // edits to different semantic fields must not assemble an unreviewed hybrid.
  const hasBasis = input.entityType === 'memory'
    && [currentRecord, incomingRecord, baseRecord].some(record => record
      && (record.source === 'weekly-context' || record.weekly_context_basis_json !== null
        || record.understanding_subject !== null || record.understanding_basis_json !== null
        || record.chat_summary_correction_json !== null));
  const independentFields = new Set([
    'id', 'created_at', 'updated_at', 'activation_count', 'last_active_at',
    'last_surfaced_at', 'surface_count', 'surface_suppressed_until', 'surface_muted_at',
    'stats_semantics_version', 'last_mentioned_at',
  ]);
  const versionFields = hasBasis ? fields.filter(field => !independentFields.has(field)) : [];
  const sameVersion = (left: Record<string, JsonValue>, right: Record<string, JsonValue>) => (
    versionFields.every(field => compareJson(left[field], right[field]))
  );
  if (versionFields.length) {
    const selected = sameVersion(currentRecord, incomingRecord)
      || (baseRecord && sameVersion(incomingRecord, baseRecord))
      ? currentRecord
      : baseRecord && sameVersion(currentRecord, baseRecord)
        ? incomingRecord
        : null;
    if (selected) {
      for (const field of versionFields) merged[field] = selected[field];
    } else {
      conflictingFields.push(...versionFields.filter(field => !compareJson(currentRecord[field], incomingRecord[field])));
    }
  }
  const groupedFields = new Set(versionFields);
  for (const field of fields) {
    if (groupedFields.has(field)) continue;
    if (input.entityType === 'memory' && MEMORY_STATS_FIELDS.has(field)) {
      merged[field] = mergeMemoryStatsRecord(currentRecord, [currentRecord, incomingRecord])[field];
      continue;
    }
    const currentValue = currentRecord[field];
    const incomingValue = incomingRecord[field];
    if (compareJson(currentValue, incomingValue)) {
      merged[field] = currentValue;
      continue;
    }
    if (baseRecord && compareJson(currentValue, baseRecord[field])) {
      merged[field] = incomingValue;
      continue;
    }
    if (baseRecord && compareJson(incomingValue, baseRecord[field])) {
      merged[field] = currentValue;
      continue;
    }
    conflictingFields.push(field);
    merged[field] = currentValue;
  }
  if (conflictingFields.length) {
    const preferred = deterministicRevision(input.current, input.incoming);
    return {
      kind: 'conflict',
      payload: preferred.payload,
      operation: preferred.operation,
      resultingHeadRevisionIds: input.heads,
      conflictKind: 'same-field',
      conflictingFields,
    };
  }
  const payload: JsonValue = {
    schemaVersion: getMemoryRecordEntitySpec(input.entityType)?.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION,
    record: merged,
  };
  assertMemoryRecordPayload(input.entityType, 'upsert', payload);
  return {
    kind: 'merged',
    payload,
    operation: 'upsert',
    resultingHeadRevisionIds: input.heads,
    requiresMergeRevision: true,
    mergeParentRevisionIds: input.heads,
  };
}

function resolveMemoryRecordRevisionsInternal(input: {
  entityType: MemoryRecordEntityType;
  current: MemoryRecordRevisionValue | null;
  incoming: MemoryRecordRevisionValue;
  base?: MemoryRecordRevisionValue | null;
}): MemoryRecordMergeDecision {
  const spec = getMemoryRecordEntitySpec(input.entityType);
  if (!spec) throw new Error('memory.records merge entityType 无效。');
  assertRevision(input.entityType, input.incoming);
  if (input.current === null) {
    return {
      kind: 'apply-incoming',
      payload: input.incoming.payload,
      operation: input.incoming.operation,
      resultingHeadRevisionIds: [input.incoming.revisionId],
    };
  }
  assertRevision(input.entityType, input.current);
  if (input.current.revisionId === input.incoming.revisionId) {
    return {
      kind: 'already-current',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (['post', 'post-comment'].includes(input.entityType) && input.current.operation !== 'delete'
    && input.incoming.operation !== 'delete'
    && payloadRecord(input.current.payload).author !== payloadRecord(input.incoming.payload).author) {
    throw new Error('post author 不可变。');
  }
  const reviewEntity = input.entityType === 'post-review' || input.entityType === 'post-review-action';
  if (reviewEntity) {
    const current = payloadRecord(input.current.payload), incoming = payloadRecord(input.incoming.payload);
    if (input.entityType === 'post-review-action') assertPostReviewActionIntentUnchanged(current, incoming);
    else if (['batch_id', 'item_key', 'review_id', 'owner_device_id', 'batch_source_hash', 'batch_created_at', 'created_at']
      .some(key => !compareJson(current[key], incoming[key]))) throw new Error('post review identity 不可变。');
  }
  if (input.current.parentRevisionIds.includes(input.incoming.revisionId)) {
    return {
      kind: 'ignore-incoming',
      payload: input.current.payload,
      operation: input.current.operation,
      resultingHeadRevisionIds: [input.current.revisionId],
    };
  }
  if (input.entityType === 'continuity-event'
    && input.current.operation !== 'delete' && input.incoming.operation !== 'delete'
    && recordOf(recordOf(input.current.payload, 'current payload').record, 'current event').schema_version === 2
    && recordOf(recordOf(input.incoming.payload, 'incoming payload').record, 'incoming event').schema_version === 1) {
    const heads = uniqueSorted([input.current.revisionId, input.incoming.revisionId]);
    return { kind: 'keep-current', payload: input.current.payload, operation: input.current.operation,
      resultingHeadRevisionIds: heads, requiresMergeRevision: true, mergeParentRevisionIds: heads };
  }
  if (input.incoming.parentRevisionIds.includes(input.current.revisionId)) {
    if (input.current.operation === 'delete' && input.incoming.operation !== 'delete'
      && ['continuity-event', 'continuity-transition', 'continuity-link', 'post', 'post-comment', 'post-tag'].includes(input.entityType)
      && !(input.entityType === 'continuity-link' && input.incoming.operation === 'restore')) {
      const heads = uniqueSorted([input.current.revisionId, input.incoming.revisionId]);
      return {
        kind: 'keep-current', payload: input.current.payload, operation: 'delete',
        resultingHeadRevisionIds: heads, requiresMergeRevision: true, mergeParentRevisionIds: heads,
      };
    }
    if (input.entityType === 'post-comment' && input.current.operation !== 'delete'
      && input.incoming.operation !== 'delete' && payloadRecord(input.current.payload).deleted === 1
      && payloadRecord(input.incoming.payload).deleted === 0) {
      const heads = uniqueSorted([input.current.revisionId, input.incoming.revisionId]);
      return { kind: 'keep-current', payload: input.current.payload, operation: input.current.operation,
        resultingHeadRevisionIds: heads, requiresMergeRevision: true, mergeParentRevisionIds: heads };
    }
    if (
      spec.mergeMode === 'append-set'
      && input.current.operation !== 'delete'
      && input.incoming.operation !== 'delete'
      && !compareJson(comparablePayload(input.current.payload, input.entityType), comparablePayload(input.incoming.payload, input.entityType))
    ) {
      const preferred = deterministicRevision(input.current, input.incoming);
      return {
        kind: 'conflict',
        payload: preferred.payload,
        operation: preferred.operation,
        resultingHeadRevisionIds: uniqueSorted([
          input.current.revisionId,
          input.incoming.revisionId,
        ]),
        conflictKind: 'append-payload-mismatch',
        conflictingFields: [],
      };
    }
    if (input.entityType === 'continuity-event' && input.current.operation !== 'delete' && input.incoming.operation !== 'delete') {
      assertContinuityEventRecordSuccessor(
        recordOf(recordOf(input.current.payload, 'current payload').record, 'current event'),
        recordOf(recordOf(input.incoming.payload, 'incoming payload').record, 'incoming event'),
      );
    }
    if (
      spec.mergeMode === 'state-machine'
      && isTerminalState(input.entityType, input.current)
      && !isTerminalState(input.entityType, input.incoming)
      && input.incoming.operation !== 'restore'
    ) {
      if (reviewEntity) return { kind: 'ignore-incoming', payload: input.current.payload,
        operation: input.current.operation, resultingHeadRevisionIds: uniqueSorted([input.current.revisionId, input.incoming.revisionId]) };
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: input.current.operation,
        resultingHeadRevisionIds: [input.incoming.revisionId],
        requiresMergeRevision: true,
        mergeParentRevisionIds: [
          input.current.revisionId,
          input.incoming.revisionId,
        ].sort(),
      };
    }
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
  if (reviewEntity) {
    // Never manufacture an owner's result on the other host. Keep signed heads
    // and select one complete business version, rather than mixing draft fields.
    const currentTerminal = isTerminalState(input.entityType, input.current);
    const incomingTerminal = isTerminalState(input.entityType, input.incoming);
    const canonical = (value: JsonValue): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
      : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
    const businessKey = (revision: MemoryRecordRevisionValue) => {
      const record = payloadRecord(revision.payload);
      return canonical({ ...record, candidate_json: typeof record.candidate_json === 'string'
        ? JSON.parse(record.candidate_json) as JsonValue : null });
    };
    const at = (revision: MemoryRecordRevisionValue) => Number(payloadRecord(revision.payload).updated_at ?? payloadRecord(revision.payload).resolved_at ?? 0);
    const selected = currentTerminal !== incomingTerminal ? currentTerminal ? input.current : input.incoming
      : at(input.current) > at(input.incoming) ? input.current : at(input.incoming) > at(input.current) ? input.incoming
        : input.entityType === 'post-review' && stateStatus(input.current) !== stateStatus(input.incoming)
          && [stateStatus(input.current), stateStatus(input.incoming)].includes('waiting')
          ? stateStatus(input.current) === 'waiting' ? input.current : input.incoming
        : businessKey(input.current) <= businessKey(input.incoming) ? input.current : input.incoming;
    if (currentTerminal && incomingTerminal && stateStatus(input.current) !== stateStatus(input.incoming)) {
      return { kind: 'conflict', payload: selected.payload, operation: selected.operation,
        resultingHeadRevisionIds: heads, conflictKind: 'terminal-state-mismatch', conflictingFields: ['status'] };
    }
    return { kind: selected === input.current ? 'ignore-incoming' : 'apply-incoming', payload: selected.payload,
      operation: selected.operation, resultingHeadRevisionIds: heads };
  }
  if (['post', 'post-comment', 'post-tag'].includes(input.entityType)) {
    const deleted = (revision: MemoryRecordRevisionValue) => revision.operation === 'delete'
      || input.entityType === 'post-comment' && payloadRecord(revision.payload).deleted === 1;
    const leftDeleted = deleted(input.current), rightDeleted = deleted(input.incoming);
    const at = (revision: MemoryRecordRevisionValue) => revision.operation === 'delete' ? revision.createdAt
      : input.entityType === 'post' ? Number(JSON.parse(String(payloadRecord(revision.payload).memory_json)).updated_at)
        : input.entityType === 'post-comment' ? Number(payloadRecord(revision.payload).updated_at)
          : Number(payloadRecord(revision.payload).updated_at ?? revision.createdAt);
    const alias = (revision: MemoryRecordRevisionValue) => input.entityType === 'post-tag'
      && revision.operation !== 'delete' && payloadRecord(revision.payload).merged_into_id != null;
    const version = (revision: MemoryRecordRevisionValue) => input.entityType === 'post-tag' && revision.operation !== 'delete'
      ? String(payloadRecord(revision.payload).version_id ?? revision.revisionId) : revision.revisionId;
    const selected = alias(input.current) !== alias(input.incoming) && !leftDeleted && !rightDeleted
      ? alias(input.current) ? input.current : input.incoming
      : leftDeleted !== rightDeleted ? leftDeleted ? input.incoming : input.current
      : at(input.current) > at(input.incoming) ? input.current
          : at(input.incoming) > at(input.current) ? input.incoming
            : version(input.current) < version(input.incoming) ? input.current
              : version(input.incoming) < version(input.current) ? input.incoming : deterministicRevision(input.current, input.incoming);
    const retained = { payload: selected.payload,
      operation: selected.operation, resultingHeadRevisionIds: heads,
      requiresMergeRevision: true as const, mergeParentRevisionIds: heads };
    if (selected === input.current || selected.operation === 'delete') return { ...retained, kind: 'keep-current' };
    return { ...retained, kind: 'merged', operation: 'upsert' };
  }
  const deleteDecision = concurrentDeleteDecision({
    current: input.current,
    incoming: input.incoming,
    heads,
  });
  if (deleteDecision) return deleteDecision;

  if (spec.mergeMode === 'append-set') {
    if (compareJson(comparablePayload(input.current.payload, input.entityType), comparablePayload(input.incoming.payload, input.entityType))) {
      return {
        kind: 'keep-current',
        payload: input.current.payload,
        operation: input.current.operation,
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      };
    }
    const preferred = deterministicRevision(input.current, input.incoming);
    return {
      kind: 'conflict',
      payload: preferred.payload,
      operation: preferred.operation,
      resultingHeadRevisionIds: heads,
      conflictKind: 'append-payload-mismatch',
      conflictingFields: [],
    };
  }

  if (input.entityType === 'current-state') {
    const fields = ['title', 'content', 'kind', 'status', 'known_at', 'source_refs_json',
      'source_type', 'source_memory_id', 'source_candidate_id', 'source_title', 'resolved_at', 'resolve_reason'];
    const current = payloadRecord(input.current.payload, input.entityType);
    const incoming = payloadRecord(input.incoming.payload, input.entityType);
    if (fields.some(field => !compareJson(current[field], incoming[field]))) {
      const currentTerminal = isTerminalState(input.entityType, input.current);
      const incomingTerminal = isTerminalState(input.entityType, input.incoming);
      const preferred = currentTerminal !== incomingTerminal
        ? currentTerminal ? input.current : input.incoming
        : deterministicRevision(input.current, input.incoming);
      return { kind: 'conflict', payload: preferred.payload, operation: preferred.operation,
        resultingHeadRevisionIds: heads, conflictKind: 'same-field', conflictingFields: fields };
    }
  }
  if (spec.mergeMode === 'state-machine') {
    const currentTerminal = isTerminalState(input.entityType, input.current);
    const incomingTerminal = isTerminalState(input.entityType, input.incoming);
    if (currentTerminal !== incomingTerminal) {
      const selected = currentTerminal ? input.current : input.incoming;
      return {
        kind: selected === input.current ? 'keep-current' : 'merged',
        payload: selected.payload,
        operation: selected.operation === 'delete' ? 'upsert' : selected.operation as 'upsert' | 'restore',
        resultingHeadRevisionIds: heads,
        requiresMergeRevision: true,
        mergeParentRevisionIds: heads,
      } as MemoryRecordMergeDecision;
    }
    if (
      currentTerminal
      && stateStatus(input.current) !== stateStatus(input.incoming)
    ) {
      const preferred = deterministicRevision(input.current, input.incoming);
      return {
        kind: 'conflict',
        payload: preferred.payload,
        operation: preferred.operation,
        resultingHeadRevisionIds: heads,
        conflictKind: 'terminal-state-mismatch',
        conflictingFields: ['status'],
      };
    }
  }
  return mergeFields({
    entityType: input.entityType,
    current: input.current,
    incoming: input.incoming,
    base: input.base,
    heads,
  });
}

function resolveMemoryRecordRevisionsWithStats(input: {
  entityType: MemoryRecordEntityType;
  current: MemoryRecordRevisionValue | null;
  incoming: MemoryRecordRevisionValue;
  base?: MemoryRecordRevisionValue | null;
}): MemoryRecordMergeDecision {
  // A statistics-only merge is not a new post edit. A deletion based on its
  // unchanged business snapshot must retain the old whole-post semantics.
  if (input.entityType === 'post' && input.current && input.base?.operation !== 'delete' && input.base
    && (input.current.operation === 'delete') !== (input.incoming.operation === 'delete')) {
    const surviving = input.current.operation === 'delete' ? input.incoming : input.current;
    const removed = input.current.operation === 'delete' ? input.current : input.incoming;
    const comparable = (revision: MemoryRecordRevisionValue) => {
      const row = { ...payloadRecord(revision.payload) };
      const body = { weekly_context_basis_json: null, understanding_subject: null, understanding_basis_json: null,
        ...JSON.parse(String(row.memory_json)) } as Record<string, JsonValue>;
      for (const field of [...MEMORY_STATS_FIELDS, 'updated_at']) delete body[field];
      row.memory_json = body;
      if (!('image_assets_json' in payloadRecord(input.base!.payload))) {
        delete row.image_group_json; delete row.image_assets_json; delete row.image_description;
      }
      return row;
    };
    if (compareJson(comparable(surviving), comparable(input.base))) {
      const parents = uniqueSorted([input.current.revisionId, input.incoming.revisionId]);
      return { kind: 'merged', operation: 'delete', payload: removed.payload,
        resultingHeadRevisionIds: parents, requiresMergeRevision: true, mergeParentRevisionIds: parents };
    }
  }
  let decision = resolveMemoryRecordRevisionsInternal(input);
  if (['memory', 'post'].includes(input.entityType) && input.current
    && input.current.operation !== 'delete' && input.incoming.operation !== 'delete'
    && recordOf(input.incoming.payload, 'incoming payload').schemaVersion !== MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION
    && memoryRecordCorrectionMarker(input.entityType, input.current.operation, input.current.payload)
    && decision.kind !== 'already-current' && decision.kind !== 'ignore-incoming') {
    // Legacy writers cannot express the correction marker. Keep its matching
    // business draft together, while the normal statistics merge still runs.
    const parents = uniqueSorted([input.current.revisionId, input.incoming.revisionId]);
    decision = { kind: 'keep-current', payload: input.current.payload, operation: input.current.operation,
      resultingHeadRevisionIds: parents, requiresMergeRevision: true, mergeParentRevisionIds: parents };
  }
  if (!['memory', 'post'].includes(input.entityType) || decision.operation === 'delete') return decision;
  const other = [input.current, input.incoming].filter((revision): revision is MemoryRecordRevisionValue =>
    !!revision && revision.operation !== 'delete');
  const imageSource = other.find(revision => 'image_assets_json' in payloadRecord(revision.payload));
  let payload = mergeMemoryStatsPayload(decision.payload, input.entityType, imageSource?.payload);
  for (const revision of other) payload = mergeMemoryStatsPayload(payload, input.entityType, revision.payload);
  if (compareJson(payload, decision.payload)) return decision;
  assertMemoryRecordPayload(input.entityType, decision.operation, payload);
  const parents = uniqueSorted(other.map(revision => revision.revisionId));
  if (decision.kind === 'conflict') return { ...decision, payload, requiresMergeRevision: true, mergeParentRevisionIds: parents };
  return { kind: 'merged', payload, operation: decision.operation as 'upsert' | 'restore',
    resultingHeadRevisionIds: parents, requiresMergeRevision: true, mergeParentRevisionIds: parents };
}

/** Marker carried by a selected business draft or its deletion, never a summary receipt. */
export function memoryRecordCorrectionMarker(
  entityType: MemoryRecordEntityType,
  operation: SyncOperation,
  payload: JsonValue,
): string | null {
  if (entityType !== 'memory' && entityType !== 'post') return null;
  const value = operation === 'delete'
    ? recordOf(payload, 'memory delete payload').chatSummaryCorrection
    : entityType === 'memory' ? payloadRecord(payload).chat_summary_correction_json
      : recordOf(JSON.parse(String(payloadRecord(payload).memory_json)), 'post memory').chat_summary_correction_json;
  return typeof value === 'string' ? value : null;
}

export function resolveMemoryRecordRevisions(input: {
  entityType: MemoryRecordEntityType;
  current: MemoryRecordRevisionValue | null;
  incoming: MemoryRecordRevisionValue;
  base?: MemoryRecordRevisionValue | null;
}): MemoryRecordMergeDecision {
  const decision = resolveMemoryRecordRevisionsWithStats(input);
  if (!['memory', 'post'].includes(input.entityType) || decision.operation !== 'delete') return decision;
  const marker = memoryRecordCorrectionMarker(input.entityType, decision.operation, decision.payload)
    ?? [input.current, input.incoming, input.base].map(revision => revision
      ? memoryRecordCorrectionMarker(input.entityType, revision.operation, revision.payload) : null)
      .find((value): value is string => value !== null) ?? null;
  if (marker === null) return decision;
  const payload: JsonValue = { ...recordOf(decision.payload, 'memory delete payload'),
    schemaVersion: MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION, chatSummaryCorrection: marker };
  if (compareJson(payload, decision.payload)) return decision;
  const parents = uniqueSorted([input.current?.revisionId, input.incoming.revisionId].filter((id): id is string => !!id));
  return { kind: 'merged', operation: 'delete', payload, resultingHeadRevisionIds: parents,
    requiresMergeRevision: true, mergeParentRevisionIds: parents };
}
