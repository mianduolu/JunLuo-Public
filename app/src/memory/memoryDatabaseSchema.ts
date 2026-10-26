import type * as SQLite from 'expo-sqlite';
import { retainSavedPostConfirmations } from '../sync/syncBaiyunPostConfirmations';
import { buildBaiyunPostTagUpgradeSql } from '../sync/syncBaiyunPostRecordsSql';
import { MEMORY_BASE_SCHEMA_SQL, MEMORY_FTS_SCHEMA_SQL } from './memoryBaseSchema';
import { POST_METADATA_SCHEMA_SQL } from '../posts/baiyunPostMetadata';
import { MEMORY_RECORDS_CAPTURE_TABLE_SCHEMA_SQL, buildMemoryRecordsStorageSchemaSql, buildMemoryCurrentStateUpgradeSql, buildMemoryRecordsOutboxIdUpgradeSql } from '../sync/syncMemoryRecordsSql';
import { buildContinuityMatterUpgradeSql } from '../ai/behavior/continuityMatterSchema';
import { ensureMemoryIngestionSchema } from './memoryIngestionLedger';
import { ensureMemoryProcessingSchema } from './memoryProcessingQueue';
import { ensureMemoryLifecycleSchema } from './memoryLifecycle';
import { ensureMemoryEmbeddingSchema } from './memoryIndexTargets';
import { GIFT_SCHEMA_SQL } from '../gifts/giftSchema';

export type MemoryFtsState = { available: boolean; error: string };

export { MEMORY_BASE_SCHEMA_SQL, MEMORY_FTS_SCHEMA_SQL } from './memoryBaseSchema';

async function retireInvalidPostCommentCapture(database: SQLite.SQLiteDatabase) {
  const triggers = await database.getAllAsync<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (
      'memory_sync_capture_baiyun_post_comment_metadata_insert',
      'memory_sync_capture_baiyun_post_comment_metadata_update',
      'memory_sync_capture_baiyun_post_metadata_update',
      'memory_sync_capture_baiyun_post_metadata_delete')`,
  );
  const invalid = triggers.filter(trigger => trigger.name.startsWith('memory_sync_capture_baiyun_post_comment_metadata_')
    ? /\b(?:NEW|OLD)\.comment_json\b/i.test(trigger.sql)
    : /\b(?:NEW|OLD)\.content_version\b/i.test(trigger.sql));
  if (!invalid.length) return;
  // These legacy rules cannot execute: comment_json/content_version belong to the computed
  // view. Retire them before any table rename; the normal install below
  // recreates current rules before this connection is exposed to consumers.
  await database.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(invalid.map(trigger => `DROP TRIGGER ${trigger.name};`).join('\n'));
  });
}

async function ensureColumns(database: SQLite.SQLiteDatabase, table: string, columns: Array<[string, string]>) {
  const existing = await database.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
  const names = new Set(existing.map((column) => column.name));
  for (const [name, statement] of columns) {
    if (!names.has(name)) {
      await database.execAsync(statement);
    }
  }
}

async function ensureStyleMemoryCompatibility(database: SQLite.SQLiteDatabase) {
  const existing = await database.getAllAsync<{ name: string }>(
    'PRAGMA table_info(style_memories)',
  );
  if (!existing.length) return;
  const names = new Set(existing.map((column) => column.name));
  if (names.has('mouse_reaction') && !names.has('hamster_reaction')) {
    await database.execAsync(
      'ALTER TABLE style_memories RENAME COLUMN mouse_reaction TO hamster_reaction',
    );
    return;
  }
  if (!names.has('hamster_reaction')) {
    throw new Error(
      'style_memories 缺少 hamster_reaction，拒绝安装同步触发器。',
    );
  }
}

async function ensureMemoryColumns(database: SQLite.SQLiteDatabase) {
  await ensureColumns(database, 'memories', [
    ['title', "ALTER TABLE memories ADD COLUMN title TEXT NOT NULL DEFAULT '';"],
    ['domain', "ALTER TABLE memories ADD COLUMN domain TEXT NOT NULL DEFAULT '其他';"],
    ['anchor', 'ALTER TABLE memories ADD COLUMN anchor INTEGER NOT NULL DEFAULT 0;'],
    ['anchor_kind', 'ALTER TABLE memories ADD COLUMN anchor_kind TEXT;'],
    ['recall_cues_json', "ALTER TABLE memories ADD COLUMN recall_cues_json TEXT NOT NULL DEFAULT '[]';"],
    ['type', "ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'dynamic';"],
    ['tier', "ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'working';"],
    ['semantic_type', "ALTER TABLE memories ADD COLUMN semantic_type TEXT NOT NULL DEFAULT 'other';"],
    ['stability', 'ALTER TABLE memories ADD COLUMN stability REAL NOT NULL DEFAULT 0.5;'],
    ['resolved', 'ALTER TABLE memories ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0;'],
    ['digested', 'ALTER TABLE memories ADD COLUMN digested INTEGER NOT NULL DEFAULT 0;'],
    ['activation_count', 'ALTER TABLE memories ADD COLUMN activation_count REAL NOT NULL DEFAULT 0;'],
    ['last_active_at', 'ALTER TABLE memories ADD COLUMN last_active_at INTEGER NOT NULL DEFAULT 0;'],
    ['confidence', 'ALTER TABLE memories ADD COLUMN confidence REAL;'],
    ['model_valence', 'ALTER TABLE memories ADD COLUMN model_valence REAL;'],
    ['protected', 'ALTER TABLE memories ADD COLUMN protected INTEGER NOT NULL DEFAULT 0;'],
    ['archived_at', 'ALTER TABLE memories ADD COLUMN archived_at INTEGER;'],
    ['archive_reason', 'ALTER TABLE memories ADD COLUMN archive_reason TEXT;'],
    ['atomic_kind', "ALTER TABLE memories ADD COLUMN atomic_kind TEXT NOT NULL DEFAULT 'unknown';"],
    ['event_at', 'ALTER TABLE memories ADD COLUMN event_at INTEGER;'],
    ['event_start_at', 'ALTER TABLE memories ADD COLUMN event_start_at INTEGER;'],
    ['event_end_at', 'ALTER TABLE memories ADD COLUMN event_end_at INTEGER;'],
    ['event_time_precision', "ALTER TABLE memories ADD COLUMN event_time_precision TEXT NOT NULL DEFAULT 'unknown';"],
    ['event_time_basis', "ALTER TABLE memories ADD COLUMN event_time_basis TEXT NOT NULL DEFAULT 'unknown';"],
    ['event_time_source_message_id', 'ALTER TABLE memories ADD COLUMN event_time_source_message_id TEXT;'],
    ['event_time_expression', 'ALTER TABLE memories ADD COLUMN event_time_expression TEXT;'],
    ['extraction_basis', "ALTER TABLE memories ADD COLUMN extraction_basis TEXT NOT NULL DEFAULT 'unknown';"],
    ['source', 'ALTER TABLE memories ADD COLUMN source TEXT;'],
    ['period', 'ALTER TABLE memories ADD COLUMN period TEXT;'],
    ['date', 'ALTER TABLE memories ADD COLUMN date TEXT;'],
    ['remembered_reason', 'ALTER TABLE memories ADD COLUMN remembered_reason TEXT;'],
    ['weekly_context_basis_json', 'ALTER TABLE memories ADD COLUMN weekly_context_basis_json TEXT;'],
    ['understanding_subject', "ALTER TABLE memories ADD COLUMN understanding_subject TEXT CHECK (understanding_subject IN ('I', 'you'));"],
    ['understanding_basis_json', 'ALTER TABLE memories ADD COLUMN understanding_basis_json TEXT;'],
    ['chat_summary_correction_json', 'ALTER TABLE memories ADD COLUMN chat_summary_correction_json TEXT;'],
    ['last_surfaced_at', 'ALTER TABLE memories ADD COLUMN last_surfaced_at INTEGER;'],
    ['surface_suppressed_until', 'ALTER TABLE memories ADD COLUMN surface_suppressed_until INTEGER;'],
    ['surface_muted_at', 'ALTER TABLE memories ADD COLUMN surface_muted_at INTEGER;'],
    ['surface_count', 'ALTER TABLE memories ADD COLUMN surface_count INTEGER NOT NULL DEFAULT 0;'],
    ['stats_semantics_version', 'ALTER TABLE memories ADD COLUMN stats_semantics_version INTEGER NOT NULL DEFAULT 0;'],
    ['last_mentioned_at', 'ALTER TABLE memories ADD COLUMN last_mentioned_at INTEGER;'],
    ['confirmation_level', "ALTER TABLE memories ADD COLUMN confirmation_level TEXT NOT NULL DEFAULT 'automatic';"],
    ['source_trace_mode', "ALTER TABLE memories ADD COLUMN source_trace_mode TEXT NOT NULL DEFAULT 'legacy_range';"],
  ]);
  await ensureColumns(database, 'memory_comments', [
    ['kind', "ALTER TABLE memory_comments ADD COLUMN kind TEXT NOT NULL DEFAULT 'comment';"],
    ['author', "ALTER TABLE memory_comments ADD COLUMN author TEXT NOT NULL DEFAULT '白云小姐';"],
    ['valence', 'ALTER TABLE memory_comments ADD COLUMN valence REAL;'],
    ['arousal', 'ALTER TABLE memory_comments ADD COLUMN arousal REAL;'],
    ['source', 'ALTER TABLE memory_comments ADD COLUMN source TEXT;'],
  ]);
  await database.execAsync(`
    UPDATE memories
    SET title = substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 24)
    WHERE (title IS NULL OR title = '')
      AND title IS NOT substr(replace(replace(content, char(10), ' '), char(13), ' '), 1, 24);
    UPDATE memories
    SET type = 'permanent'
    WHERE pinned = 1 AND type = 'dynamic';
    UPDATE memories
    SET type = 'dynamic'
    WHERE pinned = 0 AND protected = 0 AND type = 'permanent';
    UPDATE memories
    SET anchor_kind = 'other'
    WHERE anchor = 1 AND (anchor_kind IS NULL OR anchor_kind = '');
    UPDATE memories
    SET anchor_kind = NULL
    WHERE (anchor IS NULL OR anchor = 0)
      AND anchor_kind IS NOT NULL;
    UPDATE memories
    SET tier = 'core'
    WHERE (pinned = 1 OR protected = 1 OR anchor = 1 OR importance >= 8 OR domain IN ('边界', '称呼', '约定'))
      AND (tier IS NULL OR tier <> 'core');
    UPDATE memories
    SET tier = 'working'
    WHERE tier IS NULL OR tier NOT IN ('core', 'working', 'peripheral');
    UPDATE memories
    SET semantic_type = CASE
      WHEN domain IN ('喜好', '边界', '称呼') THEN 'preference'
      WHEN domain IN ('经历', '日常') THEN 'event'
      WHEN domain = '约定' THEN 'pattern'
      WHEN domain = '相处' THEN 'profile'
      ELSE 'other'
    END
    WHERE semantic_type IS NULL
      OR (
        semantic_type = 'other'
        AND domain IN ('喜好', '边界', '称呼', '经历', '日常', '约定', '相处')
      );
  `);
}

async function ensureMemoryFts(database: SQLite.SQLiteDatabase, onFtsState: (state: MemoryFtsState) => void) {
  try {
    await database.execAsync(MEMORY_FTS_SCHEMA_SQL);
    onFtsState({ available: true, error: '' });
  } catch (error) {
    onFtsState({ available: false, error: error instanceof Error ? error.message : String(error) });
  }
}

export async function initializeMemoryDatabase(
  database: SQLite.SQLiteDatabase,
  onFtsState: (state: MemoryFtsState) => void,
) {
  await retireInvalidPostCommentCapture(database);
  await database.execAsync(MEMORY_BASE_SCHEMA_SQL);
  await database.execAsync(GIFT_SCHEMA_SQL);
  await ensureMemoryColumns(database);
  await ensureMemoryEmbeddingSchema(database);
  await database.execAsync(POST_METADATA_SCHEMA_SQL);
  if (!await database.getFirstAsync("SELECT name FROM pragma_table_info('baiyun_post_metadata') WHERE name = 'title'")) {
    await database.execAsync('ALTER TABLE baiyun_post_metadata ADD COLUMN title TEXT');
  }
  for (const [name, type] of [['object_id', 'TEXT'], ['chunk_count', 'INTEGER']]) {
    if (!await database.getFirstAsync("SELECT name FROM pragma_table_info('baiyun_post_images') WHERE name = ?", name)) {
      await database.execAsync(`ALTER TABLE baiyun_post_images ADD COLUMN ${name} ${type}`);
    }
  }
  await ensureMemoryIngestionSchema(database);
  await ensureMemoryProcessingSchema(database);
  await ensureMemoryLifecycleSchema(database);
  await ensureMemoryFts(database, onFtsState);
  await ensureStyleMemoryCompatibility(database);
  const outboxTable = await database.getFirstAsync<{ sql: string }>(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='memory_sync_domain_outbox'",
  );
  const outboxTriggers = outboxTable ? await database.getAllAsync<{ name: string; sql: string }>(
    "SELECT name, sql FROM sqlite_master WHERE type='trigger' AND sql LIKE '%memory_sync_domain_outbox%'",
  ) : [];
  const outboxUpgrade = buildMemoryRecordsOutboxIdUpgradeSql(outboxTable?.sql, outboxTriggers);
  if (outboxUpgrade) await database.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(outboxUpgrade);
  });
  await database.execAsync(MEMORY_RECORDS_CAPTURE_TABLE_SCHEMA_SQL);
  const { ensurePostReviewColumns, POST_REVIEW_SCHEMA_SQL } = await import('../sync/syncBaiyunPostReviews');
  await ensurePostReviewColumns(database);
  await database.execAsync(POST_REVIEW_SCHEMA_SQL);
  const continuityColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(continuity_events)');
  if (continuityColumns.length) {
    const upgrade = buildContinuityMatterUpgradeSql(continuityColumns.map((column) => column.name));
    if (upgrade) await database.withExclusiveTransactionAsync(async (transaction) => {
      await transaction.execAsync(upgrade);
    });
  }
  const currentStateColumns = await database.getAllAsync<{ name: string; notnull: number }>('PRAGMA table_info(memory_current_states)');
  const currentStateUpgrade = buildMemoryCurrentStateUpgradeSql(currentStateColumns);
  if (currentStateUpgrade) await database.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(currentStateUpgrade);
  });
  const tagColumns = await database.getAllAsync<{ name: string }>('PRAGMA table_info(baiyun_post_tags)');
  const tagTable = await database.getFirstAsync<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type='table' AND name='baiyun_post_tags'");
  const tagUpgrade = buildBaiyunPostTagUpgradeSql(tagColumns.map(column => column.name), tagTable?.sql);
  if (tagUpgrade) await database.withExclusiveTransactionAsync(async transaction => {
    await transaction.execAsync(tagUpgrade);
  });
  await database.execAsync(buildMemoryRecordsStorageSchemaSql());
  // This database's header records completion; reopening no longer scans memories.
  // Keep the reset and header in one transaction, after current capture rules install.
  const statsUpgrade = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  if ((statsUpgrade?.user_version ?? 0) < 1) {
    await database.withExclusiveTransactionAsync(async transaction => {
      await transaction.runAsync(`UPDATE memories SET activation_count = 0, last_active_at = 0,
        surface_count = 0, last_mentioned_at = NULL, stats_semantics_version = 1
        WHERE COALESCE(stats_semantics_version, 0) = 0`);
      await transaction.execAsync('PRAGMA user_version = 1');
    });
  }
  await retainSavedPostConfirmations(database);
  await ensureColumns(database, 'continuity_events', [
    ['focus_excerpt', 'ALTER TABLE continuity_events ADD COLUMN focus_excerpt TEXT;'],
  ]);
  return database;
}
