import { normalizeMemoryChatSummaryCorrection } from '../chat/chatSummaryCorrection';
import { isRetiredContinuityCard } from '../ai/behavior/continuityMatterRecord';
import { assertPostConfirmationRecord } from './syncBaiyunPostConfirmations';
import { assertPostReviewRecord, assertPostReviewActionRecord, POST_REVIEW_RECORDS_SCHEMA_VERSION } from './syncBaiyunPostReviews';
import {
  assertContinuityCandidateRecord,
  assertContinuityEventRecord,
  assertContinuityLinkRecord,
  assertContinuityTransitionRecord,
} from './syncContinuityLedger';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertBase64Url,
  assertJsonValue,
  assertPlainMutationV1,
  type JsonValue,
  type PlainMutationV1,
  type SyncOperation,
} from './syncProtocol';

export const MEMORY_RECORDS_SCHEMA_VERSION = 5 as const;
export const POST_IMAGE_RECORDS_SCHEMA_VERSION = 6 as const;
export const POST_TAG_RECORDS_SCHEMA_VERSION = 7 as const;
export const MEMORY_STATS_RECORDS_SCHEMA_VERSION = 9 as const;
export const MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION = 10 as const;
export const MEMORY_RECORDS_RETENTION_CLASS = 'relationship-history' as const;

export type MemoryRecordEntityType =
  | 'memory'
  | 'comment'
  | 'post'
  | 'post-comment'
  | 'post-tag'
  | 'post-confirmation'
  | 'post-review'
  | 'post-review-action'
  | 'source-reference'
  | 'edge'
  | 'recall-feedback'
  | 'timeline-thread'
  | 'timeline-member'
  | 'topic-override'
  | 'current-state'
  | 'style-memory'
  | 'lifecycle-event'
  | 'merge-recovery'
  | 'continuity-event'
  | 'continuity-transition'
  | 'continuity-link'
  | 'continuity-candidate';

export type MemoryRecordMergeMode =
  | 'append-set'
  | 'field-revision'
  | 'state-machine';

export type MemoryRecordFieldKind =
  | 'string'
  | 'number'
  | 'nullable-string'
  | 'nullable-number';

export type MemoryRecordCaptureAction = 'insert' | 'update' | 'delete';

export type MemoryRecordEntitySpec = {
  entityType: MemoryRecordEntityType;
  tableName: string;
  snapshotTableName?: string;
  schemaVersion?: 6 | 7 | 8 | 9 | 10;
  idColumns: readonly string[];
  fields: Readonly<Record<string, MemoryRecordFieldKind>>;
  insertOperation: Extract<SyncOperation, 'upsert' | 'append'>;
  mergeMode: MemoryRecordMergeMode;
  captureActions?: readonly MemoryRecordCaptureAction[];
  bootstrapAdapterId?: 'memory.records' | 'continuity.ledger';
  allowRestore?: boolean;
  validateRecord?: (record: Record<string, unknown>) => void;
};

export const DEFAULT_MEMORY_RECORD_CAPTURE_ACTIONS =
  ['insert', 'update', 'delete'] as const;

function assertCurrentStateRecord(record: Record<string, unknown>) {
  if (!['active', 'resolved', 'expired'].includes(String(record.status))) throw new Error('current-state status 无效。');
  let refs: unknown;
  try { refs = JSON.parse(String(record.source_refs_json)); } catch { throw new Error('current-state sources 无效。'); }
  if (!Array.isArray(refs) || refs.some(ref => !ref || typeof ref.sessionId !== 'string' || !ref.sessionId
    || typeof ref.messageId !== 'string' || !ref.messageId || !['I', 'you'].includes(ref.role)
    || !['direct', 'derived'].includes(ref.relation) || !Number.isSafeInteger(ref.messageCreatedAt)
    || ref.messageCreatedAt < 0 || (ref.excerpt !== undefined && typeof ref.excerpt !== 'string'))) {
    throw new Error('current-state sources 无效。');
  }
  if (record.known_at !== null && (!Number.isSafeInteger(record.known_at) || (record.known_at as number) < 0
    || !refs.some(ref => ref.messageCreatedAt === record.known_at))) throw new Error('current-state known_at 缺少依据。');
}

export function assertMemoryChatSummaryCorrectionJson(value: unknown) {
  if (value === null) return;
  try {
    if (typeof value !== 'string' || !normalizeMemoryChatSummaryCorrection(JSON.parse(value))) throw new Error('invalid');
  } catch { throw new Error('memory.records chat_summary_correction_json 无效。'); }
}

const memoryFields = {
  id: 'string',
  title: 'string',
  content: 'string',
  domain: 'string',
  tags_json: 'string',
  recall_cues_json: 'string',
  importance: 'number',
  valence: 'number',
  arousal: 'number',
  pinned: 'number',
  anchor: 'number',
  anchor_kind: 'nullable-string',
  type: 'string',
  tier: 'string',
  semantic_type: 'string',
  stability: 'number',
  resolved: 'number',
  digested: 'number',
  activation_count: 'number',
  last_active_at: 'number',
  confidence: 'nullable-number',
  model_valence: 'nullable-number',
  protected: 'number',
  archived_at: 'nullable-number',
  archive_reason: 'nullable-string',
  atomic_kind: 'string',
  event_at: 'nullable-number',
  event_start_at: 'nullable-number',
  event_end_at: 'nullable-number',
  event_time_precision: 'string',
  event_time_basis: 'string',
  event_time_source_message_id: 'nullable-string',
  event_time_expression: 'nullable-string',
  extraction_basis: 'string',
  source: 'nullable-string',
  period: 'nullable-string',
  date: 'nullable-string',
  source_type: 'string',
  source_start_at: 'nullable-number',
  source_end_at: 'nullable-number',
  confirmation_level: 'string',
  source_trace_mode: 'string',
  remembered_reason: 'nullable-string',
  weekly_context_basis_json: 'nullable-string',
  understanding_subject: 'nullable-string',
  understanding_basis_json: 'nullable-string',
  last_surfaced_at: 'nullable-number',
  surface_suppressed_until: 'nullable-number',
  surface_muted_at: 'nullable-number',
  surface_count: 'number',
  stats_semantics_version: 'number',
  last_mentioned_at: 'nullable-number',
  chat_summary_correction_json: 'nullable-string',
  created_at: 'number',
  updated_at: 'number',
} as const satisfies Readonly<Record<string, MemoryRecordFieldKind>>;

const MEMORY_LIFECYCLE_EVENT_TYPES = new Set([
  'baseline', 'created', 'confirmed', 'edited', 'state_changed', 'source_rebound',
  'corrected', 'organized', 'merged_into', 'absorbed_merge', 'archived', 'restored',
  'merge_undone',
]);
const MEMORY_LIFECYCLE_ACTORS = new Set(['automatic', 'manual', 'maintenance', 'migration']);

function parseJsonForMemoryRecord(value: unknown, label: string) {
  try {
    return JSON.parse(String(value)) as unknown;
  } catch {
    throw new Error(`${label} 必须是有效 JSON。`);
  }
}

function assertMemoryLifecycleRecord(record: Record<string, unknown>) {
  if (!MEMORY_LIFECYCLE_EVENT_TYPES.has(String(record.event_type))) {
    throw new Error('memory.records lifecycle-event.event_type 无效。');
  }
  if (!MEMORY_LIFECYCLE_ACTORS.has(String(record.actor))) {
    throw new Error('memory.records lifecycle-event.actor 无效。');
  }
  const changedFields = parseJsonForMemoryRecord(record.changed_fields_json, 'changed_fields_json');
  if (!Array.isArray(changedFields) || changedFields.some((field) => typeof field !== 'string')) {
    throw new Error('memory.records lifecycle-event.changed_fields_json 必须是字符串数组。');
  }
  if (changedFields.length > 40 || changedFields.some((field) => !/^[A-Za-z][A-Za-z0-9]{0,79}$/.test(field))) {
    throw new Error('memory.records lifecycle-event.changed_fields_json 包含无效字段名。');
  }
  for (const key of ['previous_resolved', 'next_resolved'] as const) {
    if (record[key] !== null && record[key] !== 0 && record[key] !== 1) {
      throw new Error(`memory.records lifecycle-event.${key} 必须为 0、1 或 null。`);
    }
  }
}

function assertMemoryMergeRecoveryRecord(record: Record<string, unknown>) {
  if (record.mode !== 'merge' && record.mode !== 'update') {
    throw new Error('memory.records merge-recovery.mode 无效。');
  }
  if (record.legacy !== 0 && record.legacy !== 1) {
    throw new Error('memory.records merge-recovery.legacy 必须为 0 或 1。');
  }
  if (
    record.source_previous_resolved !== null
    && record.source_previous_resolved !== 0
    && record.source_previous_resolved !== 1
  ) {
    throw new Error('memory.records merge-recovery.source_previous_resolved 必须为 0、1 或 null。');
  }
  const introduced = parseJsonForMemoryRecord(
    record.introduced_source_refs_json,
    'introduced_source_refs_json',
  );
  if (!Array.isArray(introduced) || introduced.some((key) => typeof key !== 'string')) {
    throw new Error('memory.records merge-recovery.introduced_source_refs_json 必须是字符串数组。');
  }
  if (
    introduced.length > 80
    || introduced.some((key) => {
      const [sessionId, messageId, relation, extra] = String(key).split('\u0000');
      return !sessionId || !messageId || relation !== 'derived' || extra !== undefined || key.length > 260;
    })
  ) {
    throw new Error('memory.records merge-recovery.introduced_source_refs_json 包含无效引用键。');
  }
  if (record.target_before_json !== null) {
    const before = parseJsonForMemoryRecord(record.target_before_json, 'target_before_json');
    if (!before || typeof before !== 'object' || Array.isArray(before)) {
      throw new Error('memory.records merge-recovery.target_before_json 必须是对象。');
    }
    const beforeRecord = before as Record<string, unknown>;
    const commonKeys = [
      'confirmationLevel', 'confidence', 'importance', 'recallCues', 'stability', 'tags',
    ];
    const updateKeys = ['atomicKind', 'content', 'domain', 'eventAt', 'eventTime', 'title'];
    const allowedKeys = new Set(record.mode === 'update' ? [...commonKeys, ...updateKeys] : commonKeys);
    const extraKeys = Object.keys(beforeRecord).filter((key) => !allowedKeys.has(key));
    if (extraKeys.length) {
      throw new Error(`memory.records merge-recovery.target_before_json 包含未允许字段：${extraKeys.join(', ')}。`);
    }
    for (const key of ['confirmationLevel', 'importance', 'recallCues', 'stability', 'tags']) {
      if (!(key in beforeRecord)) {
        throw new Error(`memory.records merge-recovery.target_before_json 缺少字段：${key}。`);
      }
    }
    if (
      !['automatic', 'reviewed', 'manual'].includes(String(beforeRecord.confirmationLevel))
      || typeof beforeRecord.importance !== 'number'
      || typeof beforeRecord.stability !== 'number'
      || !Array.isArray(beforeRecord.recallCues)
      || beforeRecord.recallCues.some((value) => typeof value !== 'string')
      || !Array.isArray(beforeRecord.tags)
      || beforeRecord.tags.some((value) => typeof value !== 'string')
    ) {
      throw new Error('memory.records merge-recovery.target_before_json 字段类型无效。');
    }
  }
}

const POST_RECORD_ENTITY_SPECS:
readonly MemoryRecordEntitySpec[] = [
  {
    entityType: 'post', tableName: 'baiyun_post_metadata', snapshotTableName: 'memory_sync_posts',
    idColumns: ['post_id'], schemaVersion: MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION,
    fields: { post_id: 'string', author: 'string', title: 'nullable-string', tag_ids_json: 'string',
      content_version: 'number', memory_json: 'string', image_group_json: 'nullable-string',
      image_assets_json: 'string', image_description: 'nullable-string' },
    insertOperation: 'upsert', mergeMode: 'field-revision', captureActions: ['update', 'delete'], bootstrapAdapterId: 'memory.records',
    allowRestore: true,
    validateRecord(record) {
      if (!['I', 'you'].includes(String(record.author))) throw new Error('post author 无效。');
      const ids = parseJsonForMemoryRecord(record.tag_ids_json, 'post tags');
      if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)
        || new Set(ids).size !== ids.length) throw new Error('post tags 无效。');
      if (!Number.isSafeInteger(record.content_version) || Number(record.content_version) < 0) throw new Error('post version 无效。');
      const body = recordOf(parseJsonForMemoryRecord(record.memory_json, 'post body'), 'post body');
      assertMemoryRecordPayload('memory', 'upsert', {
        schemaVersion: 'chat_summary_correction_json' in body ? MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION
          : 'stats_semantics_version' in body ? MEMORY_STATS_RECORDS_SCHEMA_VERSION : MEMORY_RECORDS_SCHEMA_VERSION,
        record: body,
      });
      if (body.id !== record.post_id) throw new Error('post body ID 不一致。');
      assertBaiyunPostImageRecord(record);
    },
  },
  {
    entityType: 'post-comment', tableName: 'baiyun_post_comment_metadata', snapshotTableName: 'memory_sync_post_comments',
    idColumns: ['post_id', 'source'], schemaVersion: POST_IMAGE_RECORDS_SCHEMA_VERSION,
    fields: { post_id: 'string', source: 'string', current_id: 'nullable-string', author: 'string',
      created_at: 'number', updated_at: 'number', deleted: 'number', comment_json: 'nullable-string',
      image_group_json: 'nullable-string', image_assets_json: 'string', image_description: 'nullable-string' },
    insertOperation: 'upsert', mergeMode: 'field-revision', allowRestore: true, bootstrapAdapterId: 'memory.records',
    validateRecord(record) {
      if (!record.post_id || !record.source || !['I', 'you'].includes(String(record.author))) throw new Error('post comment identity 无效。');
      if (![0, 1].includes(Number(record.deleted)) || !Number.isSafeInteger(record.created_at)
        || !Number.isSafeInteger(record.updated_at) || Number(record.created_at) < 0
        || Number(record.updated_at) < Number(record.created_at)) throw new Error('post comment version 无效。');
      if (record.deleted === 1) {
        if (record.current_id !== null || record.comment_json !== null) throw new Error('deleted post comment body 无效。');
        assertBaiyunPostImageRecord(record);
        if (record.image_group_json !== null) throw new Error('deleted post comment images 无效。');
        return;
      }
      const body = recordOf(parseJsonForMemoryRecord(record.comment_json, 'post comment body'), 'post comment body');
      assertMemoryRecordPayload('comment', 'append', { schemaVersion: MEMORY_RECORDS_SCHEMA_VERSION, record: body });
      if (body.id !== record.current_id || body.memory_id !== record.post_id || body.author !== record.author
        || (body.source ?? `baiyun-post-comment:${body.id}`) !== record.source
        || body.created_at !== record.created_at) throw new Error('post comment body identity 不一致。');
      assertBaiyunPostImageRecord(record);
    },
  },
  {
    entityType: 'post-tag', tableName: 'baiyun_post_tags', idColumns: ['id'], schemaVersion: POST_TAG_RECORDS_SCHEMA_VERSION,
    fields: { id: 'string', name: 'string', scope: 'string', merged_into_id: 'nullable-string',
      merged_at: 'nullable-number', updated_at: 'number', version_id: 'string' },
    insertOperation: 'upsert', mergeMode: 'field-revision', allowRestore: true, bootstrapAdapterId: 'memory.records',
    validateRecord(record) {
      if (!record.id || !record.name || !['I', 'you', 'both'].includes(String(record.scope))) throw new Error('post tag 无效。');
      if (!Number.isSafeInteger(record.updated_at) || Number(record.updated_at) < 0
        || typeof record.version_id !== 'string' || !record.version_id.trim()) throw new Error('post tag business version 无效。');
      if ((record.merged_into_id === null) !== (record.merged_at === null)
        || record.merged_into_id !== null && (typeof record.merged_into_id !== 'string' || !record.merged_into_id.trim()
          || record.merged_into_id === record.id || !Number.isSafeInteger(record.merged_at) || Number(record.merged_at) < 0)) {
        throw new Error('post tag merge destination 无效。');
      }
    },
  },
  {
    entityType: 'post-confirmation', tableName: 'baiyun_post_confirmations', idColumns: ['batch_id', 'item_key'],
    fields: { batch_id: 'string', item_key: 'string', memory_id: 'nullable-string', current_state_id: 'nullable-string',
      confirmed_at: 'number', refs_json: 'string', bindings_json: 'string' },
    insertOperation: 'append', mergeMode: 'append-set', captureActions: ['insert', 'delete'],
    bootstrapAdapterId: 'memory.records', validateRecord: assertPostConfirmationRecord,
  },
  {
    entityType: 'post-review', tableName: 'memory_ingestion_items', snapshotTableName: 'memory_sync_post_reviews',
    idColumns: ['batch_id', 'item_key'], schemaVersion: POST_REVIEW_RECORDS_SCHEMA_VERSION,
    fields: { batch_id: 'string', item_key: 'string', review_id: 'string', owner_device_id: 'string',
      batch_source_hash: 'string', batch_created_at: 'number', status: 'string', memory_id: 'nullable-string',
      candidate_json: 'nullable-string', created_at: 'number', updated_at: 'number', resolved_at: 'nullable-number' },
    insertOperation: 'upsert', mergeMode: 'state-machine', captureActions: ['insert', 'update'], allowRestore: false,
    bootstrapAdapterId: 'memory.records', validateRecord: assertPostReviewRecord,
  },
  {
    entityType: 'post-review-action', tableName: 'baiyun_post_review_actions', idColumns: ['id'],
    schemaVersion: POST_REVIEW_RECORDS_SCHEMA_VERSION,
    fields: { id: 'string', review_id: 'string', owner_device_id: 'string', action: 'string', expected_editable_hash: 'string',
      candidate_json: 'string', target_hash: 'nullable-string', state: 'string', error: 'nullable-string',
      created_at: 'number', resolved_at: 'nullable-number' },
    insertOperation: 'upsert', mergeMode: 'state-machine', captureActions: ['insert', 'update'], allowRestore: false,
    bootstrapAdapterId: 'memory.records', validateRecord: assertPostReviewActionRecord,
  },
];

export const MEMORY_RECORD_ENTITY_SPECS: readonly MemoryRecordEntitySpec[] = [
  {
    entityType: 'memory',
    tableName: 'memories',
    schemaVersion: MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION,
    idColumns: ['id'],
    fields: memoryFields,
    insertOperation: 'upsert',
    mergeMode: 'field-revision',
    validateRecord(record) {
      assertMemoryChatSummaryCorrectionJson(record.chat_summary_correction_json);
      if (record.stats_semantics_version !== 0 && record.stats_semantics_version !== 1) {
        throw new Error('memory.records memory.stats_semantics_version 无效。');
      }
      if (record.stats_semantics_version === 1 && (
        !Number.isSafeInteger(record.activation_count) || Number(record.activation_count) < 0
        || !Number.isSafeInteger(record.surface_count) || Number(record.surface_count) < 0
        || !Number.isSafeInteger(record.last_active_at) || Number(record.last_active_at) < 0
        || record.last_mentioned_at !== null && (!Number.isSafeInteger(record.last_mentioned_at) || Number(record.last_mentioned_at) < 0)
      )) throw new Error('memory.records memory 参考统计无效。');
      if (record.understanding_subject !== null
        && record.understanding_subject !== 'I'
        && record.understanding_subject !== 'you') {
        throw new Error('memory.records memory.understanding_subject 无效。');
      }
    },
  },
  {
    entityType: 'comment',
    tableName: 'memory_comments',
    idColumns: ['id'],
    fields: {
      id: 'string',
      memory_id: 'string',
      content: 'string',
      source_type: 'string',
      kind: 'string',
      author: 'string',
      valence: 'nullable-number',
      arousal: 'nullable-number',
      source: 'nullable-string',
      created_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
  },
  {
    entityType: 'source-reference',
    tableName: 'memory_source_refs',
    idColumns: ['memory_id', 'session_id', 'message_id', 'relation'],
    fields: {
      memory_id: 'string',
      session_id: 'string',
      message_id: 'string',
      role: 'string',
      message_created_at: 'number',
      relation: 'string',
      excerpt: 'nullable-string',
      created_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
  },
  {
    entityType: 'edge',
    tableName: 'memory_edges',
    idColumns: ['id'],
    fields: {
      id: 'string',
      source_id: 'string',
      target_id: 'string',
      relation_type: 'string',
      confidence: 'number',
      reason: 'string',
      created_at: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'field-revision',
  },
  {
    entityType: 'recall-feedback',
    tableName: 'memory_recall_feedback',
    idColumns: ['id'],
    fields: {
      id: 'string',
      memory_id: 'string',
      query: 'string',
      kind: 'string',
      reason: 'nullable-string',
      sources_json: 'string',
      score: 'nullable-number',
      created_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
  },
  {
    entityType: 'timeline-thread',
    tableName: 'memory_timeline_threads',
    idColumns: ['id'],
    fields: {
      id: 'string',
      title: 'nullable-string',
      hidden: 'number',
      manual: 'number',
      created_at: 'number',
      updated_at: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'field-revision',
  },
  {
    entityType: 'timeline-member',
    tableName: 'memory_timeline_members',
    idColumns: ['thread_id', 'memory_id'],
    fields: {
      thread_id: 'string',
      memory_id: 'string',
      included: 'number',
      position: 'number',
      created_at: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'field-revision',
  },
  {
    entityType: 'topic-override',
    tableName: 'memory_topic_overrides',
    idColumns: ['topic_key'],
    fields: {
      topic_key: 'string',
      display_name: 'nullable-string',
      hidden: 'number',
      updated_at: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'field-revision',
  },
  {
    entityType: 'current-state',
    tableName: 'memory_current_states',
    idColumns: ['id'],
    fields: {
      id: 'string',
      title: 'string',
      content: 'string',
      kind: 'string',
      status: 'string',
      starts_at: 'number',
      updated_at: 'number',
      expires_at: 'nullable-number',
      resolved_at: 'nullable-number',
      resolve_reason: 'nullable-string',
      source_type: 'string',
      source_memory_id: 'nullable-string',
      source_candidate_id: 'nullable-string',
      source_title: 'nullable-string',
      created_at: 'number',
      known_at: 'nullable-number',
      source_refs_json: 'string',
    },
    insertOperation: 'upsert',
    mergeMode: 'state-machine',
    validateRecord: assertCurrentStateRecord,
  },
  {
    entityType: 'style-memory',
    tableName: 'style_memories',
    idColumns: ['id'],
    fields: {
      id: 'string',
      context: 'string',
      feeling_before: 'string',
      reply: 'string',
      hamster_reaction: 'string',
      quality: 'number',
      mass: 'number',
      embedding_json: 'string',
      created_at: 'number',
      last_accessed_at: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'field-revision',
  },
  {
    entityType: 'lifecycle-event',
    tableName: 'memory_lifecycle_events',
    idColumns: ['id'],
    fields: {
      id: 'string',
      memory_id: 'string',
      event_type: 'string',
      actor: 'string',
      operation_id: 'nullable-string',
      related_memory_id: 'nullable-string',
      reason_code: 'nullable-string',
      previous_type: 'nullable-string',
      next_type: 'nullable-string',
      previous_resolved: 'nullable-number',
      next_resolved: 'nullable-number',
      changed_fields_json: 'string',
      comment_id: 'nullable-string',
      created_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
    captureActions: ['insert', 'delete'],
    validateRecord: assertMemoryLifecycleRecord,
  },
  {
    entityType: 'merge-recovery',
    tableName: 'memory_merge_recovery_snapshots',
    idColumns: ['operation_id'],
    fields: {
      operation_id: 'string',
      source_memory_id: 'string',
      target_memory_id: 'string',
      mode: 'string',
      target_before_json: 'nullable-string',
      target_version_after: 'string',
      introduced_source_refs_json: 'string',
      source_previous_type: 'nullable-string',
      source_previous_resolved: 'nullable-number',
      legacy: 'number',
      created_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
    captureActions: ['insert', 'delete'],
    validateRecord: assertMemoryMergeRecoveryRecord,
  },
  {
    entityType: 'continuity-event',
    tableName: 'continuity_events',
    idColumns: ['id'],
    fields: {
      id: 'string',
      kind: 'string',
      status: 'string',
      stage: 'string',
      subject: 'string',
      returning_subject: 'nullable-string',
      primary_intent: 'nullable-string',
      item_name: 'nullable-string',
      progress: 'nullable-string',
      duration_ms: 'nullable-number',
      care_time_sources_json: 'nullable-string',
      care_evidence_json: 'nullable-string',
      parent_event_id: 'nullable-string',
      idempotency_key: 'string',
      coalescing_key: 'nullable-string',
      focus_excerpt: 'nullable-string',
      source_kind: 'string',
      source_id: 'string',
      source_global_basis_json: 'nullable-string',
      occurred_at: 'number',
      occurred_local_date: 'string',
      timezone_offset_minutes: 'number',
      next_action_at: 'nullable-number',
      resume_condition_json: 'nullable-string',
      required_behaviors_json: 'nullable-string',
      completion_rule_json: 'string',
      permission_requirements_json: 'string',
      attempt_count: 'number',
      last_attempt_at: 'nullable-number',
      last_attempt_outcome: 'nullable-string',
      pause_reason_code: 'nullable-string',
      cancelled_reason: 'nullable-string',
      created_at: 'number',
      updated_at: 'number',
      completed_at: 'nullable-number',
      cancelled_at: 'nullable-number',
      revision: 'number',
      schema_version: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'state-machine',
    captureActions: ['insert', 'update', 'delete'],
    bootstrapAdapterId: 'continuity.ledger',
    allowRestore: false,
    validateRecord: assertContinuityEventRecord,
  },
  {
    entityType: 'continuity-transition',
    tableName: 'continuity_event_transitions',
    idColumns: ['id'],
    fields: {
      id: 'string',
      operation_id: 'string',
      event_id: 'string',
      transition_kind: 'string',
      from_status: 'nullable-string',
      to_status: 'nullable-string',
      from_stage: 'nullable-string',
      to_stage: 'nullable-string',
      reason_code: 'nullable-string',
      evidence_id: 'nullable-string',
      evidence_kind: 'nullable-string',
      evidence_source_id: 'nullable-string',
      evidence_outcome: 'nullable-string',
      occurred_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
    captureActions: ['insert', 'delete'],
    bootstrapAdapterId: 'continuity.ledger',
    allowRestore: false,
    validateRecord: assertContinuityTransitionRecord,
  },
  {
    entityType: 'continuity-link',
    tableName: 'continuity_event_links',
    idColumns: ['event_id', 'relation', 'target_kind', 'target_id'],
    fields: {
      event_id: 'string',
      relation: 'string',
      target_kind: 'string',
      target_id: 'string',
      created_at: 'number',
    },
    insertOperation: 'append',
    mergeMode: 'append-set',
    captureActions: ['insert', 'delete'],
    bootstrapAdapterId: 'continuity.ledger',
    allowRestore: true,
    validateRecord: assertContinuityLinkRecord,
  },
  {
    entityType: 'continuity-candidate',
    tableName: 'continuity_event_candidates',
    idColumns: ['id'],
    fields: {
      id: 'string',
      candidate_key: 'string',
      candidate_kind: 'string',
      state: 'string',
      event_kind: 'nullable-string',
      primary_intent: 'nullable-string',
      target_event_id: 'nullable-string',
      proposed_resolution: 'nullable-string',
      session_id: 'string',
      message_id: 'string',
      detection_basis: 'string',
      confidence: 'number',
      reason_codes_json: 'string',
      coalescing_key: 'nullable-string',
      result_event_id: 'nullable-string',
      occurred_at: 'number',
      expires_at: 'number',
      resolved_at: 'nullable-number',
      created_at: 'number',
      updated_at: 'number',
      revision: 'number',
      schema_version: 'number',
    },
    insertOperation: 'upsert',
    mergeMode: 'state-machine',
    captureActions: ['insert', 'update', 'delete'],
    bootstrapAdapterId: 'continuity.ledger',
    allowRestore: false,
    validateRecord: assertContinuityCandidateRecord,
  },
  ...POST_RECORD_ENTITY_SPECS,
] as const;

const specByEntityType = new Map<MemoryRecordEntityType, MemoryRecordEntitySpec>(
  MEMORY_RECORD_ENTITY_SPECS.map((spec) => [spec.entityType, spec]),
);

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

export function isRetiredStayMemoryRecordPayload(
  entityType: MemoryRecordEntityType,
  payload: unknown,
) {
  if (
    entityType !== 'continuity-event'
    && entityType !== 'continuity-candidate'
  ) return false;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = (payload as { record?: unknown }).record;
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  return entityType === 'continuity-candidate' || isRetiredContinuityCard(record as Record<string, unknown>);
}

export function isRetiredStayMemoryRecordsMutation(value: PlainMutationV1) {
  return isRetiredStayMemoryRecordPayload(
    value.entity.type as MemoryRecordEntityType,
    value.payload,
  );
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string) {
  const expectedKeys = new Set(expected);
  const extra = Object.keys(record).filter((key) => !expectedKeys.has(key));
  if (extra.length) {
    throw new Error(`${label} 包含未允许字段：${extra.sort().join(', ')}。`);
  }
  const missing = expected.filter((key) => !(key in record));
  if (missing.length) {
    throw new Error(`${label} 缺少字段：${missing.join(', ')}。`);
  }
}

function assertField(value: unknown, kind: MemoryRecordFieldKind, label: string) {
  if (value === null && (kind === 'nullable-string' || kind === 'nullable-number')) return;
  const expected = kind.endsWith('string') ? 'string' : 'number';
  if (
    typeof value !== expected
    || (expected === 'number' && !Number.isFinite(value))
  ) {
    throw new Error(`${label} 必须是${kind.startsWith('nullable') ? '可空' : ''}${expected === 'number' ? '有限数字' : '字符串'}。`);
  }
}

const POST_IMAGE_RECORD_FIELDS = ['image_group_json', 'image_assets_json', 'image_description'];
export type BaiyunPostSyncImageAsset = {
  id: string; width: number; height: number; byte_size: number;
  object_id: string | null; chunk_count: number | null;
};

/** Pending capture rows can lack object IDs until the existing object channel stages their JPEGs. */
export function readBaiyunPostImageAssets(record: Record<string, unknown>): BaiyunPostSyncImageAsset[] {
  const value = parseJsonForMemoryRecord(record.image_assets_json, 'post image assets');
  if (!Array.isArray(value) || value.length > 9) throw new Error('post image assets 无效。');
  for (const item of value) {
    const asset = recordOf(item, 'post image asset');
    assertExactKeys(asset, ['id', 'width', 'height', 'byte_size', 'object_id', 'chunk_count'], 'post image asset');
    if (typeof asset.id !== 'string' || !/^post-image-\d+-[a-z0-9]+$/.test(asset.id)) throw new Error('post image ID 无效。');
    for (const key of ['width', 'height', 'byte_size'] as const) {
      if (!Number.isSafeInteger(asset[key]) || Number(asset[key]) < 1) throw new Error(`post image ${key} 无效。`);
    }
    if (asset.object_id !== null) assertBase64Url(asset.object_id, 'post image object ID', { exactBytes: 32 });
    if ((asset.object_id === null) !== (asset.chunk_count === null)
      || (asset.chunk_count !== null && asset.chunk_count !== Math.ceil(Number(asset.byte_size) / (4 * 1024 * 1024)))) {
      throw new Error('post image chunks 与大小不一致。');
    }
  }
  return value as BaiyunPostSyncImageAsset[];
}

function assertBaiyunPostImageRecord(record: Record<string, unknown>) {
  const assets = readBaiyunPostImageAssets(record);
  if (record.image_group_json === null) {
    if (assets.length || record.image_description !== null) throw new Error('post image 缺少正式图组。');
    return;
  }
  const group = recordOf(parseJsonForMemoryRecord(record.image_group_json, 'post image group'), 'post image group');
  assertExactKeys(group, ['id', 'version', 'imageIds'], 'post image group');
  if (typeof group.id !== 'string' || !group.id.trim() || !Number.isSafeInteger(group.version)
    || Number(group.version) < 1 || !Array.isArray(group.imageIds) || !group.imageIds.length
    || group.imageIds.length > 9 || new Set(group.imageIds).size !== group.imageIds.length
    || JSON.stringify(group.imageIds) !== JSON.stringify(assets.map(asset => asset.id))) {
    throw new Error('post image group 与有序资产不一致。');
  }
  if (record.image_description !== null && (typeof record.image_description !== 'string' || !record.image_description.trim())) {
    throw new Error('post image description 无效。');
  }
}

export function getMemoryRecordObjectRefs(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const value = payload as Record<string, unknown>;
  if (value.schemaVersion !== POST_IMAGE_RECORDS_SCHEMA_VERSION && ![9, 10].includes(Number(value.schemaVersion))
    || !value.record || !('image_assets_json' in recordOf(value.record, 'post image record'))) return [];
  return [...new Set(readBaiyunPostImageAssets(recordOf(value.record, 'post image record'))
    .map(asset => asset.object_id).filter((id): id is string => id !== null))];
}

export function getMemoryRecordEntitySpec(entityType: string) {
  return specByEntityType.get(entityType as MemoryRecordEntityType);
}

function isSupportedMemoryRecordsSchemaVersion(value: unknown): value is 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 {
  return value === 1 || value === 2 || value === 3 || value === 4 || value === MEMORY_RECORDS_SCHEMA_VERSION
    || value === POST_IMAGE_RECORDS_SCHEMA_VERSION || value === POST_TAG_RECORDS_SCHEMA_VERSION
    || value === POST_REVIEW_RECORDS_SCHEMA_VERSION || value === MEMORY_STATS_RECORDS_SCHEMA_VERSION || value === MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION;
}

function requiresMemoryRecordsV2(
  entityType: MemoryRecordEntityType,
  operation?: SyncOperation,
) {
  return entityType === 'lifecycle-event'
    || entityType === 'merge-recovery'
    || entityType === 'continuity-candidate'
    || (entityType === 'continuity-link' && operation === 'delete');
}

export function assertMemoryRecordPayload(
  entityType: MemoryRecordEntityType,
  operation: SyncOperation,
  payload: unknown,
) {
  const spec = specByEntityType.get(entityType);
  if (!spec) throw new Error('memory.records entity type 无效。');
  const payloadRecord = recordOf(payload, 'memory.records payload');
  if (entityType === 'continuity-link' && operation === 'restore'
    && payloadRecord.schemaVersion !== MEMORY_RECORDS_SCHEMA_VERSION) {
    throw new Error('continuity link restore 只接受 schema 5。');
  }
  const imageRecord = entityType === 'post' || entityType === 'post-comment';
  const reviewRecord = entityType === 'post-review' || entityType === 'post-review-action';
  if ((imageRecord && !(entityType === 'post' ? [5, 6, 9, 10] : [5, 6]).includes(Number(payloadRecord.schemaVersion)))
    || ([9, 10].includes(Number(payloadRecord.schemaVersion)) && !['memory', 'post'].includes(entityType))
    || (entityType === 'post-tag' && ![5, 7].includes(Number(payloadRecord.schemaVersion)))
    || (entityType === 'post-confirmation' && payloadRecord.schemaVersion !== 5)
    || (!imageRecord && payloadRecord.schemaVersion === 6)
    || (entityType !== 'post-tag' && payloadRecord.schemaVersion === 7)
    || (reviewRecord && payloadRecord.schemaVersion !== POST_REVIEW_RECORDS_SCHEMA_VERSION)
    || (!reviewRecord && payloadRecord.schemaVersion === POST_REVIEW_RECORDS_SCHEMA_VERSION)) {
    throw new Error('memory.records entity schemaVersion 不兼容。');
  }
  if (reviewRecord && operation !== 'upsert') throw new Error('post review 只接受完整 upsert，不接受删除或 restore。');
  if (operation === 'delete') {
    const captureActions = spec.captureActions ?? DEFAULT_MEMORY_RECORD_CAPTURE_ACTIONS;
    if (!captureActions.includes('delete')) {
      throw new Error(`${entityType} 是 append/state-machine 历史，不接受删除墓碑。`);
    }
    const corrected = payloadRecord.schemaVersion === MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION;
    assertExactKeys(payloadRecord, ['schemaVersion', 'deletedAt', ...(corrected ? ['chatSummaryCorrection'] : [])], 'memory.records delete payload');
    if (corrected) assertMemoryChatSummaryCorrectionJson(payloadRecord.chatSummaryCorrection);
    if (
      !isSupportedMemoryRecordsSchemaVersion(payloadRecord.schemaVersion)
      || (requiresMemoryRecordsV2(entityType, operation) && payloadRecord.schemaVersion === 1)
      || !Number.isSafeInteger(payloadRecord.deletedAt)
      || (payloadRecord.deletedAt as number) < 0
    ) {
      throw new Error('memory.records 删除墓碑无效。');
    }
    return;
  }
  assertExactKeys(payloadRecord, ['schemaVersion', 'record'], 'memory.records record payload');
  if (
    !isSupportedMemoryRecordsSchemaVersion(payloadRecord.schemaVersion)
    || (requiresMemoryRecordsV2(entityType, operation) && payloadRecord.schemaVersion === 1)
  ) {
    throw new Error('memory.records payload schemaVersion 无效。');
  }
  const rawRecord = recordOf(payloadRecord.record, `memory.records ${entityType} record`);
  if (entityType === 'memory' && payloadRecord.schemaVersion !== MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION && 'chat_summary_correction_json' in rawRecord) {
    throw new Error('memory.records legacy memory 不允许更正标记。');
  }
  if (entityType === 'post' && payloadRecord.schemaVersion !== MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION
    && 'chat_summary_correction_json' in recordOf(parseJsonForMemoryRecord(rawRecord.memory_json, 'post body'), 'post body')) {
    throw new Error('memory.records legacy post 不允许更正标记。');
  }
  if (entityType === 'post' && [9, 10].includes(Number(payloadRecord.schemaVersion))) {
    assertMemoryRecordPayload('memory', 'upsert', { schemaVersion: payloadRecord.schemaVersion,
      record: parseJsonForMemoryRecord(rawRecord.memory_json, 'post body') });
  }
  if (imageRecord && payloadRecord.schemaVersion === 5) {
    assertExactKeys(rawRecord, Object.keys(spec.fields).filter(field => !POST_IMAGE_RECORD_FIELDS.includes(field)), 'post v5 record');
  }
  if (entityType === 'post-tag' && payloadRecord.schemaVersion === 5) {
    assertExactKeys(rawRecord, ['id', 'name', 'scope'], 'post tag v5 record');
  }
  const compatibleRecord = imageRecord && payloadRecord.schemaVersion === 5
    ? { image_group_json: null, image_assets_json: '[]', image_description: null, ...rawRecord }
    : entityType === 'post-tag' && payloadRecord.schemaVersion === 5
    ? { merged_into_id: null, merged_at: null, updated_at: 0, version_id: `legacy:${rawRecord.id}`, ...rawRecord }
    : entityType === 'current-state' && payloadRecord.schemaVersion !== MEMORY_RECORDS_SCHEMA_VERSION
    ? { known_at: null, source_refs_json: '[]', ...rawRecord }
    : entityType === 'continuity-event'
    ? { focus_excerpt: null, item_name: null, progress: null, duration_ms: null, care_time_sources_json: null, care_evidence_json: null, ...rawRecord }
    : entityType === 'memory' && [1, 2, 3].includes(Number(payloadRecord.schemaVersion))
      ? {
        ...(payloadRecord.schemaVersion === 1 || payloadRecord.schemaVersion === 2
          ? { weekly_context_basis_json: null } : {}),
        understanding_subject: null, understanding_basis_json: null, ...rawRecord,
      }
      : rawRecord;
  const withCorrection = entityType === 'memory' && payloadRecord.schemaVersion !== MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION
    ? { chat_summary_correction_json: null, ...compatibleRecord } : compatibleRecord;
  const record = entityType === 'memory' && ![9, 10].includes(Number(payloadRecord.schemaVersion))
    ? { ...withCorrection, stats_semantics_version: 0, last_mentioned_at: null }
    : withCorrection;
  const fieldNames = Object.keys(spec.fields);
  assertExactKeys(record, fieldNames, `memory.records ${entityType} record`);
  for (const fieldName of fieldNames) {
    assertField(
      record[fieldName],
      spec.fields[fieldName],
      `memory.records ${entityType}.${fieldName}`,
    );
  }
  spec.validateRecord?.(record);
  assertJsonValue(record);
}

export function assertMemoryRecordsMutationV1(
  value: unknown,
): asserts value is PlainMutationV1 {
  assertPlainMutationV1(value);
  if (value.entity.domain !== 'memory') {
    throw new Error('memory.records mutation domain 必须为 memory。');
  }
  const spec = specByEntityType.get(value.entity.type as MemoryRecordEntityType);
  if (!spec) {
    throw new Error('memory.records mutation entity type 无效。');
  }
  if (
    !isSupportedMemoryRecordsSchemaVersion(value.revision.schemaVersion)
    || (requiresMemoryRecordsV2(value.entity.type as MemoryRecordEntityType, value.revision.operation)
      && value.revision.schemaVersion === 1)
  ) {
    throw new Error('memory.records mutation schemaVersion 无效。');
  }
  const payloadSchemaVersion = value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload)
    ? (value.payload as { schemaVersion?: unknown }).schemaVersion
    : undefined;
  if (payloadSchemaVersion !== value.revision.schemaVersion) {
    throw new Error('memory.records mutation 与 payload schemaVersion 不一致。');
  }
  if (value.entity.type === 'post-confirmation' && value.revision.operation !== 'delete') {
    const record = recordOf((value.payload as Record<string, unknown>).record, 'post confirmation');
    if (value.entity.id !== JSON.stringify([record.batch_id, record.item_key])) throw new Error('post confirmation entity ID 不一致。');
  }
  if (value.entity.type === 'post-review' || value.entity.type === 'post-review-action') {
    const record = recordOf((value.payload as Record<string, unknown>).record, 'post review');
    const expectedId = value.entity.type === 'post-review' ? JSON.stringify([record.batch_id, record.item_key]) : record.id;
    if (value.entity.id !== expectedId) throw new Error('post review entity ID 不一致。');
    if ((value.entity.type === 'post-review' || record.state !== 'pending') && value.sourceDeviceId !== record.owner_device_id) {
      throw new Error('post review 正式草稿和处理结果只接受原 owner。');
    }
  }
  if (value.sensitivity !== 'high') {
    throw new Error('memory.records mutation sensitivity 必须为 high。');
  }
  if (value.retentionClass !== MEMORY_RECORDS_RETENTION_CLASS) {
    throw new Error('memory.records mutation retentionClass 无效。');
  }
  if (value.revision.operation === 'restore' && spec.mergeMode === 'append-set'
    && value.entity.type !== 'continuity-link') {
    throw new Error('append-set 记录不能使用 restore。');
  }
  if (value.revision.operation === 'upsert' && spec.mergeMode === 'append-set') {
    throw new Error('append-set 记录只能使用 append 或 delete。');
  }
  if (value.revision.operation === 'restore' && spec.allowRestore === false) {
    throw new Error(`${value.entity.type} 不接受 restore。`);
  }
  if (value.revision.operation === 'append' && spec.insertOperation !== 'append') {
    throw new Error(`${value.entity.type} 不能使用 append。`);
  }
  assertMemoryRecordPayload(
    value.entity.type as MemoryRecordEntityType,
    value.revision.operation,
    value.payload,
  );
  if (value.entity.type === 'continuity-link' && value.revision.operation === 'restore') {
    const record = recordOf((value.payload as Record<string, unknown>).record, 'continuity link restore record');
    if (value.entity.id !== JSON.stringify(spec.idColumns.map(column => record[column]))) {
      throw new Error('continuity link restore entity ID 不一致。');
    }
  }
  const refs = getMemoryRecordObjectRefs(value.payload);
  if (JSON.stringify([...value.objectRefs].sort()) !== JSON.stringify([...refs].sort())) {
    throw new Error('memory.records objectRefs 与正式图片不一致。');
  }
  if ([6, 9].includes(value.revision.schemaVersion) && value.revision.operation !== 'delete'
    && ['post', 'post-comment'].includes(value.entity.type)) {
    const record = recordOf((value.payload as Record<string, unknown>).record, 'post images');
    if (readBaiyunPostImageAssets(record).some(asset => asset.object_id === null || asset.chunk_count === null)) {
      throw new Error('post images 尚未交给对象通道。');
    }
  }
}

export function buildMemoryRecordMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: MemoryRecordEntityType;
  entityId: string;
  operation: SyncOperation;
  payload: JsonValue;
}) {
  if (isRetiredStayMemoryRecordPayload(input.entityType, input.payload)) {
    throw new Error('memory.records 不外发已退役 stay 记录。');
  }
  const mutation: PlainMutationV1 = {
    protocolVersion: 1,
    mutationId: input.envelope.mutationId,
    vaultId: input.envelope.vaultId,
    sourceDeviceId: input.envelope.sourceDeviceId,
    sourceSequence: input.envelope.sourceSequence,
    createdAt: input.envelope.createdAt,
    entity: {
      domain: 'memory',
      type: input.entityType,
      id: input.entityId,
    },
    revision: {
      id: input.envelope.revisionId,
      parents: [...input.envelope.parentRevisionIds],
      operation: input.operation,
      schemaVersion: Number((input.payload as Record<string, unknown>).schemaVersion),
    },
    sensitivity: 'high',
    payload: input.payload,
    objectRefs: getMemoryRecordObjectRefs(input.payload),
    retentionClass: MEMORY_RECORDS_RETENTION_CLASS,
  };
  assertMemoryRecordsMutationV1(mutation);
  return mutation;
}

export function buildMemoryRecordUpsertMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: MemoryRecordEntityType;
  entityId: string;
  record: JsonValue;
  operation?: Extract<SyncOperation, 'upsert' | 'append' | 'restore'>;
  schemaVersion?: 5 | 6 | 7 | 8 | 9 | 10;
}) {
  const spec = specByEntityType.get(input.entityType);
  if (!spec) throw new Error('memory.records entity type 无效。');
  const operation = input.operation ?? spec.insertOperation;
  const schemaVersion = input.schemaVersion ?? spec.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION;
  let record = input.record;
  if (schemaVersion === MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION && input.entityType === 'post') {
    const post = recordOf(record, 'post record');
    record = { ...post, memory_json: JSON.stringify({ chat_summary_correction_json: null,
      ...recordOf(parseJsonForMemoryRecord(post.memory_json, 'post memory'), 'post memory') }) };
  }
  return buildMemoryRecordMutation({
    ...input,
    operation,
    payload: {
      schemaVersion,
      record: input.entityType === 'memory'
        ? { weekly_context_basis_json: null, understanding_subject: null, understanding_basis_json: null,
          ...(schemaVersion === MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION ? { chat_summary_correction_json: null } : {}),
          ...recordOf(record, 'memory record') } as JsonValue
        : record,
    },
  });
}

export function buildMemoryRecordDeleteMutation(input: {
  envelope: ChatCoreMutationEnvelope;
  entityType: MemoryRecordEntityType;
  entityId: string;
  deletedAt: number;
  chatSummaryCorrection?: string | null;
  schemaVersion?: 5 | 6 | 7 | 8 | 9 | 10;
}) {
  const schemaVersion = input.schemaVersion ?? getMemoryRecordEntitySpec(input.entityType)?.schemaVersion ?? MEMORY_RECORDS_SCHEMA_VERSION;
  return buildMemoryRecordMutation({
    ...input,
    operation: 'delete',
    payload: {
      schemaVersion,
      deletedAt: input.deletedAt,
      ...(schemaVersion === MEMORY_CORRECTION_RECORDS_SCHEMA_VERSION ? { chatSummaryCorrection: input.chatSummaryCorrection ?? null } : {}),
    },
  });
}
