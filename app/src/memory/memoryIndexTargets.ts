import type { SQLiteDatabase } from 'expo-sqlite';

export type MemoryIndexTargetKind = 'memory' | 'current_state' | 'shiying_record' | 'post_source';
export type MemoryProcessingTargetKind = MemoryIndexTargetKind | 'weekly_period';

export function shiyingRecordProcessingHash(source: { sourceContentHash: string; materialHash: string }) {
  return JSON.stringify([source.sourceContentHash, source.materialHash]);
}

export function postSourceProcessingHash(source: { sourceHash: string }) {
  return JSON.stringify(['post-source-v1', source.sourceHash]);
}

export const MEMORY_EMBEDDING_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS memory_embeddings (
  target_kind TEXT NOT NULL DEFAULT 'memory' CHECK (target_kind IN ('memory', 'current_state', 'shiying_record', 'post_source')),
  memory_id TEXT NOT NULL, embedding_json TEXT NOT NULL, model TEXT NOT NULL,
  content_hash TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (target_kind, memory_id)
);`;

export function memoryEmbeddingMigrationSql(hasTargetKind = false) {
  return `ALTER TABLE memory_embeddings RENAME TO memory_embeddings_upgrade;
    ${MEMORY_EMBEDDING_SCHEMA_SQL}
    INSERT INTO memory_embeddings (target_kind, memory_id, embedding_json, model, content_hash, updated_at)
      SELECT ${hasTargetKind ? 'target_kind' : "'memory'"}, memory_id, embedding_json, model, content_hash, updated_at FROM memory_embeddings_upgrade;
    DROP TABLE memory_embeddings_upgrade;`;
}

export async function ensureMemoryEmbeddingSchema(database: SQLiteDatabase) {
  const columns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(memory_embeddings)');
  const table = columns.length ? await database.getFirstAsync<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memory_embeddings'") : null;
  if (columns.length && (!columns.some(column => column.name === 'target_kind') || !table?.sql.includes("'post_source'"))) {
    await database.withExclusiveTransactionAsync(async transaction => {
      await transaction.execAsync(memoryEmbeddingMigrationSql(columns.some(column => column.name === 'target_kind')));
    });
  } else await database.execAsync(MEMORY_EMBEDDING_SCHEMA_SQL);
}

export const MEMORY_PROCESSING_SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS memory_processing_jobs (
      target_kind TEXT NOT NULL DEFAULT 'memory' CHECK (target_kind IN ('memory', 'current_state', 'weekly_period', 'shiying_record', 'post_source')),
      memory_id TEXT NOT NULL,
      job_type TEXT NOT NULL CHECK (
        job_type IN ('embedding', 'duplicate_analysis', 'continuation_analysis', 'source_integrity', 'weekly_refresh')
      ),
      desired_hash TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK (
        state IN ('pending', 'leased', 'blocked', 'failed', 'completed')
      ),
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at INTEGER NOT NULL,
      lease_id TEXT,
      lease_expires_at INTEGER,
      last_error_code TEXT,
      last_error_at INTEGER,
      completed_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (target_kind, memory_id, job_type),
      CHECK (target_kind = 'memory' OR (target_kind IN ('current_state', 'shiying_record', 'post_source') AND job_type = 'embedding')
        OR (target_kind = 'weekly_period' AND job_type = 'weekly_refresh'))
    );
    CREATE INDEX IF NOT EXISTS idx_memory_processing_jobs_ready
      ON memory_processing_jobs(state, available_at, job_type, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_processing_jobs_lease
      ON memory_processing_jobs(state, lease_expires_at);
  `;

export function memoryProcessingMigrationSql(hasTargetKind = false) {
  const columns = 'memory_id, job_type, desired_hash, state, attempt_count, available_at, lease_id, lease_expires_at, last_error_code, last_error_at, completed_at, created_at, updated_at';
  return `ALTER TABLE memory_processing_jobs RENAME TO memory_processing_jobs_upgrade;
    ${MEMORY_PROCESSING_SCHEMA_SQL}
    INSERT INTO memory_processing_jobs (target_kind, ${columns}) SELECT ${hasTargetKind ? 'target_kind' : "'memory'"}, ${columns} FROM memory_processing_jobs_upgrade;
    DROP TABLE memory_processing_jobs_upgrade;
    ${MEMORY_PROCESSING_SCHEMA_SQL}`;
}
export type CurrentStateIndexSource = {
  id: string; title: string; content: string; status: string;
  expires_at: number | null; updated_at: number;
};

export function currentStateIndexEligible(source: CurrentStateIndexSource | null): source is CurrentStateIndexSource {
  return !!source && source.status === 'active';
}

export function currentStateEmbeddingText(source: Pick<CurrentStateIndexSource, 'title' | 'content'>) {
  return [source.title, source.content].join('\n');
}

export function currentStateProcessingHash(source: CurrentStateIndexSource) {
  const value = JSON.stringify([currentStateEmbeddingText(source), currentStateIndexEligible(source)]);
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function loadCurrentStateIndexSource(database: SQLiteDatabase, id: string) {
  return database.getFirstAsync<CurrentStateIndexSource>(
    'SELECT id, title, content, status, expires_at, updated_at FROM memory_current_states WHERE id = ?', id,
  );
}

export function loadCurrentStateIndexSources(database: SQLiteDatabase) {
  return database.getAllAsync<CurrentStateIndexSource>(
    "SELECT id, title, content, status, expires_at, updated_at FROM memory_current_states WHERE status = 'active' ORDER BY updated_at DESC, id",
  );
}
