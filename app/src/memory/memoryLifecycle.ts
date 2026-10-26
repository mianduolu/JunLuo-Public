import type { SQLiteDatabase } from 'expo-sqlite';

export type MemoryLifecycleEventType =
  | 'baseline'
  | 'created'
  | 'confirmed'
  | 'edited'
  | 'state_changed'
  | 'source_rebound'
  | 'corrected'
  | 'organized'
  | 'merged_into'
  | 'absorbed_merge'
  | 'archived'
  | 'restored'
  | 'merge_undone';

export type MemoryLifecycleActor = 'automatic' | 'manual' | 'maintenance' | 'migration';

export type MemoryLifecycleEvent = {
  id: string;
  memoryId: string;
  eventType: MemoryLifecycleEventType;
  actor: MemoryLifecycleActor;
  operationId?: string;
  relatedMemoryId?: string;
  reasonCode?: string;
  previousType?: string;
  nextType?: string;
  previousResolved?: boolean;
  nextResolved?: boolean;
  changedFields: string[];
  commentId?: string;
  createdAt: number;
};

export type MemoryLifecycleEventInput = Omit<MemoryLifecycleEvent, 'id' | 'changedFields' | 'createdAt'> & {
  id?: string;
  changedFields?: string[];
  createdAt?: number;
};

export type MemoryMergeRecoverySnapshot = {
  operationId: string;
  sourceMemoryId: string;
  targetMemoryId: string;
  mode: 'merge' | 'update';
  targetBeforeJson?: string;
  targetVersionAfter: string;
  introducedSourceRefsJson: string;
  sourcePreviousType?: string;
  sourcePreviousResolved?: boolean;
  legacy: boolean;
  createdAt: number;
};

type LifecycleRow = {
  id: string;
  memory_id: string;
  event_type: string;
  actor: string;
  operation_id: string | null;
  related_memory_id: string | null;
  reason_code: string | null;
  previous_type: string | null;
  next_type: string | null;
  previous_resolved: number | null;
  next_resolved: number | null;
  changed_fields_json: string;
  comment_id: string | null;
  created_at: number;
};

type MergeRecoveryRow = {
  operation_id: string;
  source_memory_id: string;
  target_memory_id: string;
  mode: string;
  target_before_json: string | null;
  target_version_after: string;
  introduced_source_refs_json: string;
  source_previous_type: string | null;
  source_previous_resolved: number | null;
  legacy: number;
  created_at: number;
};

const EVENT_TYPES: MemoryLifecycleEventType[] = [
  'baseline',
  'created',
  'confirmed',
  'edited',
  'state_changed',
  'source_rebound',
  'corrected',
  'organized',
  'merged_into',
  'absorbed_merge',
  'archived',
  'restored',
  'merge_undone',
];

const ACTORS: MemoryLifecycleActor[] = ['automatic', 'manual', 'maintenance', 'migration'];

function parseStringArray(value: string | null | undefined) {
  try {
    const parsed = JSON.parse(value ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function normalizeEventType(value: unknown): MemoryLifecycleEventType {
  return typeof value === 'string' && EVENT_TYPES.includes(value as MemoryLifecycleEventType)
    ? value as MemoryLifecycleEventType
    : 'state_changed';
}

function normalizeActor(value: unknown): MemoryLifecycleActor {
  return typeof value === 'string' && ACTORS.includes(value as MemoryLifecycleActor)
    ? value as MemoryLifecycleActor
    : 'automatic';
}

function lifecycleFromRow(row: LifecycleRow): MemoryLifecycleEvent {
  return {
    id: row.id,
    memoryId: row.memory_id,
    eventType: normalizeEventType(row.event_type),
    actor: normalizeActor(row.actor),
    operationId: row.operation_id ?? undefined,
    relatedMemoryId: row.related_memory_id ?? undefined,
    reasonCode: row.reason_code ?? undefined,
    previousType: row.previous_type ?? undefined,
    nextType: row.next_type ?? undefined,
    previousResolved: row.previous_resolved === null ? undefined : row.previous_resolved === 1,
    nextResolved: row.next_resolved === null ? undefined : row.next_resolved === 1,
    changedFields: parseStringArray(row.changed_fields_json),
    commentId: row.comment_id ?? undefined,
    createdAt: row.created_at,
  };
}

function mergeRecoveryFromRow(row: MergeRecoveryRow): MemoryMergeRecoverySnapshot {
  return {
    operationId: row.operation_id,
    sourceMemoryId: row.source_memory_id,
    targetMemoryId: row.target_memory_id,
    mode: row.mode === 'update' ? 'update' : 'merge',
    targetBeforeJson: row.target_before_json ?? undefined,
    targetVersionAfter: row.target_version_after,
    introducedSourceRefsJson: row.introduced_source_refs_json,
    sourcePreviousType: row.source_previous_type ?? undefined,
    sourcePreviousResolved: row.source_previous_resolved === null ? undefined : row.source_previous_resolved === 1,
    legacy: row.legacy === 1,
    createdAt: row.created_at,
  };
}

export function buildMemoryLifecycleOperationId(prefix: string, now = Date.now()) {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildMemoryLifecycleEventId(
  operationId: string,
  eventType: MemoryLifecycleEventType,
  memoryId: string,
) {
  return `lifecycle-${operationId}-${eventType}-${memoryId}`;
}

export const MEMORY_LIFECYCLE_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS memory_lifecycle_events (
      id TEXT PRIMARY KEY NOT NULL,
      memory_id TEXT NOT NULL,
      event_type TEXT NOT NULL CHECK (
        event_type IN (
          'baseline', 'created', 'confirmed', 'edited', 'state_changed',
          'source_rebound', 'corrected', 'organized', 'merged_into',
          'absorbed_merge', 'archived', 'restored', 'merge_undone'
        )
      ),
      actor TEXT NOT NULL CHECK (actor IN ('automatic', 'manual', 'maintenance', 'migration')),
      operation_id TEXT,
      related_memory_id TEXT,
      reason_code TEXT,
      previous_type TEXT,
      next_type TEXT,
      previous_resolved INTEGER,
      next_resolved INTEGER,
      changed_fields_json TEXT NOT NULL DEFAULT '[]',
      comment_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_memory
      ON memory_lifecycle_events(memory_id, created_at ASC, id ASC);
    CREATE INDEX IF NOT EXISTS idx_memory_lifecycle_operation
      ON memory_lifecycle_events(operation_id, event_type);

    CREATE TABLE IF NOT EXISTS memory_merge_recovery_snapshots (
      operation_id TEXT PRIMARY KEY NOT NULL,
      source_memory_id TEXT NOT NULL,
      target_memory_id TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('merge', 'update')),
      target_before_json TEXT,
      target_version_after TEXT NOT NULL,
      introduced_source_refs_json TEXT NOT NULL DEFAULT '[]',
      source_previous_type TEXT,
      source_previous_resolved INTEGER,
      legacy INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_merge_recovery_source
      ON memory_merge_recovery_snapshots(source_memory_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_merge_recovery_target
      ON memory_merge_recovery_snapshots(target_memory_id, created_at DESC);
  `;

export async function ensureMemoryLifecycleSchema(database: SQLiteDatabase) {
  await database.execAsync(MEMORY_LIFECYCLE_SCHEMA_SQL);

  await database.withTransactionAsync(async () => {
    await database.runAsync(`
      INSERT OR IGNORE INTO memory_lifecycle_events (
        id, memory_id, event_type, actor, operation_id, reason_code,
        changed_fields_json, created_at
      )
      SELECT
        'lifecycle-baseline-' || id,
        id,
        'baseline',
        'migration',
        'baseline:' || id,
        'pre_lifecycle_memory',
        '[]',
        CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      FROM memories memory
      WHERE NOT EXISTS (
        SELECT 1 FROM memory_lifecycle_events event
        WHERE event.memory_id = memory.id
      )
    `);
    await database.runAsync(`
      INSERT OR IGNORE INTO memory_lifecycle_events (
        id, memory_id, event_type, actor, operation_id, related_memory_id,
        reason_code, changed_fields_json, comment_id, created_at
      )
      SELECT
        'lifecycle-comment-' || id,
        memory_id,
        CASE kind
          WHEN 'confirmation' THEN 'confirmed'
          WHEN 'correction' THEN 'corrected'
          WHEN 'dehydration' THEN 'organized'
          WHEN 'merge' THEN 'absorbed_merge'
          ELSE 'edited'
        END,
        'migration',
        'legacy-comment:' || id,
        CASE
          WHEN kind IN ('merge', 'update') AND source LIKE 'memory-%' THEN source
          ELSE NULL
        END,
        'legacy_comment',
        '[]',
        id,
        created_at
      FROM memory_comments
      WHERE kind IN ('confirmation', 'correction', 'update', 'merge', 'dehydration')
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_events baseline
          WHERE baseline.memory_id = memory_comments.memory_id
            AND baseline.event_type = 'baseline'
            AND memory_comments.created_at <= baseline.created_at
        )
    `);
    await database.runAsync(`
      INSERT OR IGNORE INTO memory_lifecycle_events (
        id, memory_id, event_type, actor, operation_id, reason_code,
        next_type, next_resolved, changed_fields_json, created_at
      )
      SELECT
        'lifecycle-legacy-archive-' || id,
        id,
        'archived',
        'migration',
        'legacy-archive:' || id,
        'legacy_archive',
        'archived',
        1,
        '["type","resolved"]',
        COALESCE(archived_at, updated_at, created_at)
      FROM memories
      WHERE type = 'archived'
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_events baseline
          WHERE baseline.memory_id = memories.id
            AND baseline.event_type = 'baseline'
            AND COALESCE(memories.archived_at, memories.updated_at, memories.created_at) <= baseline.created_at
        )
    `);
    await database.runAsync(`
      INSERT OR IGNORE INTO memory_lifecycle_events (
        id, memory_id, event_type, actor, operation_id, related_memory_id,
        reason_code, next_type, next_resolved, changed_fields_json, created_at
      )
      SELECT
        'lifecycle-legacy-merge-source-' || id,
        target_id,
        'merged_into',
        'migration',
        'legacy-merge:' || id,
        source_id,
        'legacy_supersedes',
        'archived',
        1,
        '["type","resolved"]',
        created_at
      FROM memory_edges
      WHERE relation_type = 'supersedes'
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_events baseline
          WHERE baseline.memory_id = memory_edges.target_id
            AND baseline.event_type = 'baseline'
            AND memory_edges.created_at <= baseline.created_at
        )
    `);
    await database.runAsync(`
      INSERT OR IGNORE INTO memory_lifecycle_events (
        id, memory_id, event_type, actor, operation_id, related_memory_id,
        reason_code, changed_fields_json, created_at
      )
      SELECT
        'lifecycle-legacy-merge-target-' || id,
        source_id,
        'absorbed_merge',
        'migration',
        'legacy-merge:' || id,
        target_id,
        'legacy_supersedes',
        '[]',
        created_at
      FROM memory_edges
      WHERE relation_type = 'supersedes'
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_events baseline
          WHERE baseline.memory_id = memory_edges.target_id
            AND baseline.event_type = 'baseline'
            AND memory_edges.created_at <= baseline.created_at
        )
    `);
    await database.runAsync(`
      INSERT OR IGNORE INTO memory_merge_recovery_snapshots (
        operation_id, source_memory_id, target_memory_id, mode,
        target_before_json, target_version_after, introduced_source_refs_json,
        source_previous_type, source_previous_resolved, legacy, created_at
      )
      SELECT
        'legacy-merge:' || id,
        target_id,
        source_id,
        'merge',
        NULL,
        '',
        '[]',
        NULL,
        NULL,
        1,
        created_at
      FROM memory_edges
      WHERE relation_type = 'supersedes'
        AND EXISTS (
          SELECT 1 FROM memory_lifecycle_events baseline
          WHERE baseline.memory_id = memory_edges.target_id
            AND baseline.event_type = 'baseline'
            AND memory_edges.created_at <= baseline.created_at
        )
    `);
    await database.runAsync(`
      DELETE FROM memory_embeddings
      WHERE target_kind = 'memory' AND memory_id IN (SELECT id FROM memories WHERE type = 'archived')
    `);
    await database.runAsync(`
      DELETE FROM memory_processing_jobs
      WHERE target_kind = 'memory' AND memory_id IN (SELECT id FROM memories WHERE type = 'archived')
    `);
  });
}

export async function insertMemoryLifecycleEventWithDatabase(
  database: SQLiteDatabase,
  input: MemoryLifecycleEventInput,
) {
  const createdAt = input.createdAt ?? Date.now();
  const operationId = input.operationId?.trim() || undefined;
  const id = input.id
    ?? (operationId
      ? buildMemoryLifecycleEventId(operationId, input.eventType, input.memoryId)
      : buildMemoryLifecycleOperationId(`lifecycle-${input.eventType}`, createdAt));
  const changedFields = Array.from(new Set((input.changedFields ?? []).filter(Boolean))).sort();
  await database.runAsync(
    `INSERT OR IGNORE INTO memory_lifecycle_events (
      id, memory_id, event_type, actor, operation_id, related_memory_id,
      reason_code, previous_type, next_type, previous_resolved, next_resolved,
      changed_fields_json, comment_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.memoryId,
    input.eventType,
    input.actor,
    operationId ?? null,
    input.relatedMemoryId ?? null,
    input.reasonCode ?? null,
    input.previousType ?? null,
    input.nextType ?? null,
    input.previousResolved === undefined ? null : input.previousResolved ? 1 : 0,
    input.nextResolved === undefined ? null : input.nextResolved ? 1 : 0,
    JSON.stringify(changedFields),
    input.commentId ?? null,
    createdAt,
  );
  return id;
}

export async function loadMemoryLifecycleEventsWithDatabase(
  database: SQLiteDatabase,
  memoryId: string,
  limit = 100,
) {
  const rows = await database.getAllAsync<LifecycleRow>(
    `SELECT * FROM (
       SELECT * FROM memory_lifecycle_events
       WHERE memory_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?
     ) recent
     ORDER BY created_at ASC, id ASC`,
    memoryId,
    Math.max(1, Math.min(100, Math.floor(limit))),
  );
  return rows.map(lifecycleFromRow);
}

export async function insertMemoryMergeRecoverySnapshotWithDatabase(
  database: SQLiteDatabase,
  snapshot: MemoryMergeRecoverySnapshot,
) {
  await database.runAsync(
    `INSERT OR IGNORE INTO memory_merge_recovery_snapshots (
      operation_id, source_memory_id, target_memory_id, mode,
      target_before_json, target_version_after, introduced_source_refs_json,
      source_previous_type, source_previous_resolved, legacy, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    snapshot.operationId,
    snapshot.sourceMemoryId,
    snapshot.targetMemoryId,
    snapshot.mode,
    snapshot.targetBeforeJson ?? null,
    snapshot.targetVersionAfter,
    snapshot.introducedSourceRefsJson,
    snapshot.sourcePreviousType ?? null,
    snapshot.sourcePreviousResolved === undefined ? null : snapshot.sourcePreviousResolved ? 1 : 0,
    snapshot.legacy ? 1 : 0,
    snapshot.createdAt,
  );
}

export async function loadActiveMemoryMergeRecoveryWithDatabase(
  database: SQLiteDatabase,
  sourceMemoryId: string,
) {
  const row = await database.getFirstAsync<MergeRecoveryRow>(
    `SELECT snapshot.*
     FROM memory_merge_recovery_snapshots snapshot
     WHERE snapshot.source_memory_id = ?
       AND NOT EXISTS (
         SELECT 1 FROM memory_lifecycle_events event
         WHERE event.operation_id = snapshot.operation_id
           AND event.event_type = 'merge_undone'
       )
     ORDER BY snapshot.created_at DESC
     LIMIT 1`,
    sourceMemoryId,
  );
  return row ? mergeRecoveryFromRow(row) : null;
}

export function formatMemoryLifecycleEventLabel(event: MemoryLifecycleEvent) {
  if (event.eventType === 'baseline') return '功能启用前已存在';
  if (event.eventType === 'created') {
    if (event.reasonCode === 'manual_created') return '手动创建';
    if (event.reasonCode === 'reviewed_created') return '确认后保存';
    return '自动整理保存';
  }
  if (event.eventType === 'confirmed') return '小仓鼠已确认';
  if (event.eventType === 'edited') return '正文已修改';
  if (event.eventType === 'state_changed') return '状态已调整';
  if (event.eventType === 'source_rebound') return '来源已重选';
  if (event.eventType === 'corrected') return '理解已纠正';
  if (event.eventType === 'organized') return '旧记忆已整理';
  if (event.eventType === 'merged_into') return '合并进另一页';
  if (event.eventType === 'absorbed_merge') return '接收另一页';
  if (event.eventType === 'archived') return '已归档';
  if (event.eventType === 'restored') return event.reasonCode === 'legacy_type_fallback'
    ? '已恢复（旧归档）'
    : '已恢复';
  return '已撤销合并';
}

export function buildMemoryLifecycleSummary(events: MemoryLifecycleEvent[]) {
  const compact: Array<{ count: number; label: string }> = [];
  for (const event of events) {
    const label = formatMemoryLifecycleEventLabel(event);
    const previous = compact[compact.length - 1];
    if (previous?.label === label) previous.count += 1;
    else compact.push({ count: 1, label });
  }
  let labels = compact.map((item) => item.count > 1 ? `${item.label} × ${item.count}` : item.label);
  if (labels.length > 5) labels = [labels[0], '…', ...labels.slice(-3)];
  return labels.length ? labels.join(' → ') : '还没有足迹';
}
