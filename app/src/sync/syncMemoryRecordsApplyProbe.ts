import type * as SQLite from 'expo-sqlite';

import {
  MemoryRecordsBusinessApplier,
} from './syncMemoryRecordsApply';
import {
  MEMORY_RECORD_ENTITY_SPECS,
  type MemoryRecordFieldKind,
} from './syncMemoryRecords';
import {
  ensureMemoryRecordsCaptureSchema,
  loadMemoryRecordsCaptureRuntime,
  runWithMemoryRecordsCaptureSuppressed,
} from './syncMemoryRecordsSqlitePort';
import {
  memoryRecordsSqliteApplyPort,
} from './syncMemoryRecordsSqliteApply';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

const PROBE_MEMORY_ID = '__junluo_sync_memory_records_probe__';
const PROBE_SOURCE_SEQUENCE = 9_700_000_001;
const REMOTE_MUTATION_ID = 'f7100000-0000-4000-8000-000000000001';
const REMOTE_REVISION_ID = 'f7000000-0000-4000-8000-000000000001';
const CONFLICT_MUTATION_ID = 'e7100000-0000-4000-8000-000000000001';
const CONFLICT_REVISION_ID = 'e7000000-0000-4000-8000-000000000001';
const REMOTE_DEVICE_ID = 'f7200000-0000-4000-8000-000000000001';
const SYNTHETIC_VAULT_ID = 'f7300000-0000-4000-8000-000000000001';
const SYNTHETIC_DEVICE_ID = 'f7400000-0000-4000-8000-000000000001';

type RuntimeRow = {
  capture_enabled: number;
  suppress_capture: number;
  vault_id: string | null;
  source_device_id: string | null;
  updated_at: number;
};

type LocalOutboxRow = {
  local_sequence: number;
  mutation_id: string;
  revision_id: string;
  parent_revision_ids_json: string;
  vault_id: string;
  source_device_id: string;
  source_sequence: number | null;
  operation: 'upsert' | 'delete' | 'restore' | 'append';
  schema_version: number;
  payload_json: string;
  created_at: number;
};

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`[memory-records-apply-probe] ${message}`);
}

function sampleValue(name: string, kind: MemoryRecordFieldKind): string | number | null {
  if (kind === 'nullable-number' || kind === 'nullable-string') return null;
  if (kind === 'number') return 1;
  return `${name}-probe`;
}

function probeMemoryRecord(now: number) {
  const spec = MEMORY_RECORD_ENTITY_SPECS.find((entry) => entry.entityType === 'memory');
  if (!spec) throw new Error('memory probe 缺少 memory entity spec。');
  const record = Object.fromEntries(
    Object.entries(spec.fields).map(([name, kind]) => [name, sampleValue(name, kind)]),
  ) as Record<string, string | number | null>;
  return {
    spec,
    record: {
      ...record,
      id: PROBE_MEMORY_ID,
      title: 'memory records probe',
      content: 'local probe value',
      domain: 'system-probe',
      tags_json: '[]',
      recall_cues_json: '[]',
      type: 'dynamic',
      tier: 'working',
      semantic_type: 'other',
      atomic_kind: 'unknown',
      event_time_precision: 'unknown',
      event_time_basis: 'unknown',
      extraction_basis: 'unknown',
      source_type: 'manual',
      confirmation_level: 'manual',
      source_trace_mode: 'none',
      created_at: now,
      updated_at: now,
    },
  };
}

async function cleanupProbe(transaction: SQLite.SQLiteDatabase) {
  await transaction.runAsync(
    `DELETE FROM memory_sync_applied_mutations
     WHERE revision_id IN (
       SELECT revision_id FROM memory_sync_revision_log
       WHERE entity_type = 'memory' AND entity_id = ?
       UNION
       SELECT revision_id FROM memory_sync_domain_outbox
       WHERE entity_type = 'memory' AND entity_id = ?
     )`,
    PROBE_MEMORY_ID,
    PROBE_MEMORY_ID,
  );
  await transaction.runAsync(
    `DELETE FROM memory_sync_conflicts
     WHERE entity_type = 'memory' AND entity_id = ?`,
    PROBE_MEMORY_ID,
  );
  await transaction.runAsync(
    `DELETE FROM memory_sync_entity_heads
     WHERE entity_type = 'memory' AND entity_id = ?`,
    PROBE_MEMORY_ID,
  );
  await transaction.runAsync(
    `DELETE FROM memory_sync_revision_log
     WHERE entity_type = 'memory' AND entity_id = ?`,
    PROBE_MEMORY_ID,
  );
  await transaction.runAsync(
    `DELETE FROM memory_sync_domain_outbox
     WHERE entity_type = 'memory' AND entity_id = ?`,
    PROBE_MEMORY_ID,
  );
  await transaction.runAsync("DELETE FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", PROBE_MEMORY_ID);
  await transaction.runAsync("DELETE FROM memory_processing_jobs WHERE target_kind = 'memory' AND memory_id = ?", PROBE_MEMORY_ID);
  await transaction.runAsync('DELETE FROM memories WHERE id = ?', PROBE_MEMORY_ID);
}

function parseJson<T>(raw: string, label: string) {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`[memory-records-apply-probe] ${label} 不是有效 JSON。`);
  }
}

function localMutation(row: LocalOutboxRow): PlainMutationV1 {
  expect(row.source_sequence !== null, '本地 probe mutation 尚未分配 sourceSequence');
  return {
    protocolVersion: 1,
    mutationId: row.mutation_id,
    vaultId: row.vault_id,
    sourceDeviceId: row.source_device_id,
    sourceSequence: row.source_sequence,
    createdAt: row.created_at,
    entity: {
      domain: 'memory',
      type: 'memory',
      id: PROBE_MEMORY_ID,
    },
    revision: {
      id: row.revision_id,
      parents: parseJson<string[]>(row.parent_revision_ids_json, 'parents'),
      operation: row.operation,
      schemaVersion: row.schema_version,
    },
    sensitivity: 'high',
    payload: parseJson<JsonValue>(row.payload_json, 'payload'),
    objectRefs: [],
    retentionClass: 'relationship-history',
  };
}

function remoteMutation(input: {
  local: PlainMutationV1;
  mutationId: string;
  revisionId: string;
  parentRevisionId: string;
  sourceSequence: number;
  content: string;
}) {
  const payload = input.local.payload as {
    schemaVersion: 1;
    record: Record<string, JsonValue>;
  };
  return {
    ...input.local,
    mutationId: input.mutationId,
    sourceDeviceId: REMOTE_DEVICE_ID,
    sourceSequence: input.sourceSequence,
    createdAt: input.local.createdAt + input.sourceSequence - PROBE_SOURCE_SEQUENCE,
    revision: {
      ...input.local.revision,
      id: input.revisionId,
      parents: [input.parentRevisionId],
      operation: 'upsert' as const,
    },
    payload: {
      schemaVersion: 1 as const,
      record: {
        ...payload.record,
        content: input.content,
        updated_at: input.local.createdAt + input.sourceSequence - PROBE_SOURCE_SEQUENCE,
      },
    },
  } satisfies PlainMutationV1;
}

let probePromise: Promise<void> | null = null;

async function runProbe() {
  const database = await ensureMemoryRecordsCaptureSchema();
  const previousRuntime = await database.getFirstAsync<RuntimeRow>(
    `SELECT capture_enabled, suppress_capture, vault_id, source_device_id, updated_at
     FROM memory_sync_runtime WHERE singleton_id = 1`,
  );
  expect(previousRuntime, '缺少 memory_sync_runtime');
  await runWithMemoryRecordsCaptureSuppressed(cleanupProbe);
  const runtime = await loadMemoryRecordsCaptureRuntime();
  const vaultId = runtime.vaultId ?? SYNTHETIC_VAULT_ID;
  const sourceDeviceId = runtime.sourceDeviceId ?? SYNTHETIC_DEVICE_ID;
  const now = Date.now();
  await database.runAsync(
    `UPDATE memory_sync_runtime
     SET capture_enabled = 1,
         suppress_capture = 0,
         vault_id = ?,
         source_device_id = ?,
         updated_at = ?
     WHERE singleton_id = 1`,
    vaultId,
    sourceDeviceId,
    now,
  );
  try {
    const { spec, record } = probeMemoryRecord(now);
    const columns = Object.keys(spec.fields);
    await database.runAsync(
      `INSERT INTO memories (
         ${columns.map((column) => `"${column}"`).join(', ')}
       ) VALUES (${columns.map(() => '?').join(', ')})`,
      ...columns.map((column) => (record as Record<string, string | number | null>)[column]),
    );
    const localRow = await database.getFirstAsync<LocalOutboxRow>(
      `SELECT local_sequence, mutation_id, revision_id, parent_revision_ids_json,
              vault_id, source_device_id, source_sequence, operation,
              schema_version, payload_json, created_at
       FROM memory_sync_domain_outbox
       WHERE entity_type = 'memory' AND entity_id = ?
       ORDER BY local_sequence DESC
       LIMIT 1`,
      PROBE_MEMORY_ID,
    );
    expect(localRow, '真实 INSERT 没有在同事务捕获本地域 outbox');
    await database.runAsync(
      `UPDATE memory_sync_domain_outbox
       SET source_sequence = ?, updated_at = ?
       WHERE local_sequence = ?`,
      PROBE_SOURCE_SEQUENCE,
      now,
      localRow.local_sequence,
    );
    localRow.source_sequence = PROBE_SOURCE_SEQUENCE;
    const local = localMutation(localRow);
    const applier = new MemoryRecordsBusinessApplier(memoryRecordsSqliteApplyPort);
    const echo = await applier.applySyncMutation(local);
    expect(echo.status === 'applied', '本地回声没有被幂等接纳');
    const duplicate = await applier.applySyncMutation(local);
    expect(duplicate.status === 'already-applied', '重复本地回声未命中 applied ledger');

    const sequential = remoteMutation({
      local,
      mutationId: REMOTE_MUTATION_ID,
      revisionId: REMOTE_REVISION_ID,
      parentRevisionId: local.revision.id,
      sourceSequence: PROBE_SOURCE_SEQUENCE + 1,
      content: 'remote sequential value',
    });
    const sequentialResult = await applier.applySyncMutation(sequential);
    expect(sequentialResult.status === 'applied', '顺序远端 revision 应成功应用');
    const sequentialRecord = await database.getFirstAsync<{ content: string }>(
      'SELECT content FROM memories WHERE id = ?',
      PROBE_MEMORY_ID,
    );
    expect(
      sequentialRecord?.content === 'remote sequential value',
      '顺序远端 revision 没有写入真实 memories 表',
    );

    const conflict = remoteMutation({
      local,
      mutationId: CONFLICT_MUTATION_ID,
      revisionId: CONFLICT_REVISION_ID,
      parentRevisionId: local.revision.id,
      sourceSequence: PROBE_SOURCE_SEQUENCE + 2,
      content: 'remote conflict value',
    });
    const conflictResult = await applier.applySyncMutation(conflict);
    expect(conflictResult.status === 'conflict', '同字段并发没有进入 pending conflict');
    const conflictCount = await database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM memory_sync_conflicts
       WHERE entity_type = 'memory' AND entity_id = ? AND state = 'pending'`,
      PROBE_MEMORY_ID,
    );
    expect(conflictCount?.count === 1, '真实 conflict ledger 数量不正确');
    const heads = await database.getAllAsync<{ revision_id: string }>(
      `SELECT revision_id
       FROM memory_sync_entity_heads
       WHERE entity_type = 'memory' AND entity_id = ?
       ORDER BY revision_id`,
      PROBE_MEMORY_ID,
    );
    expect(
      JSON.stringify(heads.map((row) => row.revision_id))
        === JSON.stringify([CONFLICT_REVISION_ID, REMOTE_REVISION_ID]),
      '并发冲突没有同时保留两个 revision heads',
    );
    const outboxCount = await database.getFirstAsync<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM memory_sync_domain_outbox
       WHERE entity_type = 'memory' AND entity_id = ?`,
      PROBE_MEMORY_ID,
    );
    expect(outboxCount?.count === 1, '远端应用产生了同步回声 outbox');
    console.info('[sync-memory-records-apply-probe] PASS');
  } finally {
    await runWithMemoryRecordsCaptureSuppressed(cleanupProbe);
    await database.runAsync(
      `UPDATE memory_sync_runtime
       SET capture_enabled = ?,
           suppress_capture = ?,
           vault_id = ?,
           source_device_id = ?,
           updated_at = ?
       WHERE singleton_id = 1`,
      previousRuntime.capture_enabled,
      previousRuntime.suppress_capture,
      previousRuntime.vault_id,
      previousRuntime.source_device_id,
      previousRuntime.updated_at,
    );
  }
}

export function runMemoryRecordsApplyProbe() {
  if (!probePromise) probePromise = runProbe();
  return probePromise;
}

