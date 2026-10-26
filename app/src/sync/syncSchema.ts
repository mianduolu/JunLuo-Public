import {
  selectSyncDatabaseName,
} from './syncWorld';

export const SYNC_DATABASE_NAME = selectSyncDatabaseName();
export const SYNC_DATABASE_VERSION = 9;

export const SYNC_DATABASE_SCHEMA_V1 = `
  PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS sync_device_state (
    device_id TEXT PRIMARY KEY NOT NULL,
    vault_id TEXT NOT NULL,
    key_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    display_name TEXT NOT NULL,
    signing_public_key TEXT NOT NULL,
    exchange_public_key TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'active', 'revoked')),
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS sync_outbox (
    local_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    mutation_id TEXT NOT NULL UNIQUE,
    vault_id TEXT NOT NULL,
    source_device_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    mutation_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending'
      CHECK (state IN ('pending', 'leased', 'acked', 'quarantined')),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    available_at INTEGER NOT NULL,
    lease_id TEXT,
    lease_expires_at INTEGER,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (source_device_id, source_sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_sync_outbox_ready
    ON sync_outbox(state, available_at, local_sequence);

  CREATE TABLE IF NOT EXISTS sync_inbox (
    relay_cursor INTEGER PRIMARY KEY NOT NULL,
    mutation_id TEXT NOT NULL UNIQUE,
    vault_id TEXT NOT NULL,
    source_device_id TEXT NOT NULL,
    sealed_json TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'received'
      CHECK (state IN ('received', 'applied', 'quarantined')),
    received_at INTEGER NOT NULL,
    applied_at INTEGER,
    error_code TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_sync_inbox_state_cursor
    ON sync_inbox(state, relay_cursor);

  CREATE TABLE IF NOT EXISTS sync_applied_mutations (
    mutation_id TEXT PRIMARY KEY NOT NULL,
    relay_cursor INTEGER NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_cursors (
    stream_id TEXT PRIMARY KEY NOT NULL,
    cursor_value INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_entity_heads (
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    revision_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (domain, entity_type, entity_id, revision_id)
  );

  CREATE TABLE IF NOT EXISTS sync_entity_revisions (
    revision_id TEXT PRIMARY KEY NOT NULL,
    mutation_id TEXT NOT NULL UNIQUE,
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    parents_json TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete', 'restore', 'append')),
    schema_version INTEGER NOT NULL,
    mutation_json TEXT NOT NULL,
    source_device_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (source_device_id, source_sequence)
  );

  CREATE INDEX IF NOT EXISTS idx_sync_entity_revisions_entity
    ON sync_entity_revisions(domain, entity_type, entity_id, created_at, revision_id);

  CREATE INDEX IF NOT EXISTS idx_sync_entity_revisions_retention_scan
    ON sync_entity_revisions(
      domain, entity_type, created_at, entity_id, revision_id
    );

  CREATE TABLE IF NOT EXISTS sync_revision_object_refs (
    revision_id TEXT NOT NULL,
    object_id TEXT NOT NULL,
    PRIMARY KEY (revision_id, object_id),
    FOREIGN KEY (revision_id) REFERENCES sync_entity_revisions(revision_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sync_revision_object_refs_object
    ON sync_revision_object_refs(object_id, revision_id);

  CREATE TABLE IF NOT EXISTS sync_entity_conflicts (
    conflict_id TEXT PRIMARY KEY NOT NULL,
    domain TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('delete-edit', 'same-field')),
    revision_ids_json TEXT NOT NULL,
    conflicting_fields_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved')),
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_sync_entity_conflicts_pending
    ON sync_entity_conflicts(state, domain, entity_type, entity_id, created_at);

  CREATE TABLE IF NOT EXISTS sync_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    direction TEXT NOT NULL CHECK (direction IN ('inbox', 'outbox')),
    mutation_id TEXT NOT NULL,
    relay_cursor INTEGER,
    error_code TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sync_quarantine_mutation
    ON sync_quarantine(mutation_id, created_at);

  CREATE TABLE IF NOT EXISTS sync_durable_intents (
    operation_id TEXT PRIMARY KEY NOT NULL,
    adapter_id TEXT NOT NULL,
    intent_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'business_written', 'captured')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_execution_fences (
    operation_id TEXT PRIMARY KEY NOT NULL,
    category TEXT NOT NULL CHECK (category IN (
      'proactive-message', 'life-tick', 'reminder', 'alarm',
      'tool-call', 'wallet-transaction', 'timer'
    )),
    claim_id TEXT NOT NULL,
    claim_json TEXT NOT NULL,
    start_json TEXT,
    receipt_json TEXT,
    state TEXT NOT NULL CHECK (state IN (
      'claimed', 'started', 'completion-prepared', 'completed'
    )),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sync_execution_fences_state
    ON sync_execution_fences(state, updated_at, operation_id);

  CREATE TABLE IF NOT EXISTS sync_object_jobs (
    object_id TEXT PRIMARY KEY NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
    key_id TEXT NOT NULL,
    total_chunks INTEGER NOT NULL,
    completed_chunks INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK (state IN ('pending', 'running', 'verified', 'failed')),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    local_uri TEXT,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_object_retention_state (
    object_id TEXT PRIMARY KEY NOT NULL,
    unreferenced_at INTEGER,
    local_evicted_at INTEGER,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (object_id) REFERENCES sync_object_jobs(object_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sync_object_retention_cleanup
    ON sync_object_retention_state(
      unreferenced_at, local_evicted_at, object_id
    );

  CREATE TABLE IF NOT EXISTS sync_object_materializations (
    object_id TEXT NOT NULL,
    adapter_id TEXT NOT NULL,
    reference_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL
      CHECK (state IN ('pending', 'materialized', 'failed')),
    last_error_code TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (object_id, adapter_id),
    FOREIGN KEY (object_id) REFERENCES sync_object_jobs(object_id)
      ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_sync_object_materializations_state
    ON sync_object_materializations(
      state, updated_at, object_id, adapter_id
    );

  CREATE TABLE IF NOT EXISTS sync_mutation_relay_receipts_v1 (
    mutation_id TEXT PRIMARY KEY NOT NULL,
    source_device_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    relay_cursor INTEGER NOT NULL UNIQUE,
    recorded_at INTEGER NOT NULL,
    UNIQUE (source_device_id, source_sequence)
  );

  CREATE TABLE IF NOT EXISTS sync_device_freshness_checkpoint_v2 (
    device_id TEXT PRIMARY KEY NOT NULL,
    applied_cursor INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL DEFAULT 'incremental'
      CHECK (state IN ('incremental', 'refresh-required')),
    history_floor_cursor INTEGER NOT NULL DEFAULT 0,
    refresh_required_at INTEGER,
    last_reported_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_finite_deletion_compactions_v1 (
    compaction_id TEXT PRIMARY KEY NOT NULL,
    tombstone_mutation_id TEXT NOT NULL UNIQUE,
    tombstone_revision_id TEXT NOT NULL UNIQUE,
    request_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (
      'prepared', 'submitted', 'local-cleanup', 'acknowledged', 'complete'
    )),
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sync_finite_compaction_state
    ON sync_finite_deletion_compactions_v1(state, updated_at, compaction_id);

  CREATE TABLE IF NOT EXISTS sync_current_refresh_sessions_v1 (
    session_id TEXT PRIMARY KEY NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('source', 'requester')),
    state TEXT NOT NULL CHECK (state IN (
      'waiting-android', 'preparing', 'uploading', 'ready',
      'downloading', 'validating', 'committing', 'complete', 'failed'
    )),
    requester_device_id TEXT NOT NULL,
    source_device_id TEXT,
    cutover_cursor INTEGER,
    entry_count INTEGER,
    next_entry_index INTEGER NOT NULL DEFAULT 1,
    snapshot_digest TEXT,
    staging_path TEXT,
    rollback_path TEXT,
    last_error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sync_current_refresh_entries_v1 (
    session_id TEXT NOT NULL,
    entry_index INTEGER NOT NULL,
    revision_id TEXT NOT NULL,
    entity_key_digest TEXT NOT NULL,
    entry_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'uploaded', 'applied')),
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_index),
    UNIQUE (session_id, revision_id),
    UNIQUE (session_id, entity_key_digest),
    FOREIGN KEY (session_id) REFERENCES sync_current_refresh_sessions_v1(session_id)
      ON DELETE CASCADE
  );
`;
