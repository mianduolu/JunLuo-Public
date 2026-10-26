import * as SQLite from 'expo-sqlite';

export const SHIYING_DATABASE_NAME = 'junluo-shiying.db' as const;
export const SHIYING_DATABASE_VERSION = 10 as const;
export const SHIYING_REJECTED_ENTRY_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

export interface ShiyingMigrationConnection {
  execAsync(source: string): Promise<void>;
  getFirstAsync<T>(source: string): Promise<T | null>;
  getAllAsync<T>(source: string): Promise<T[]>;
  withExclusiveTransactionAsync(
    task: (transaction: ShiyingMigrationConnection) => Promise<void>,
  ): Promise<void>;
}

type UserVersionRow = {
  user_version: number;
};

export const SHIYING_SCHEMA_V1_SQL = `
CREATE TABLE shiying_entries (
  id TEXT PRIMARY KEY NOT NULL,
  batch_id TEXT NOT NULL,
  life_date TEXT NOT NULL
    CHECK(length(life_date) = 10 AND life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  category TEXT NOT NULL
    CHECK(category IN ('anticipation', 'liking', 'accomplishment', 'comfort', 'felt_seen', 'creative_excitement')),
  body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  event_started_at INTEGER NOT NULL CHECK(event_started_at >= 0),
  event_ended_at INTEGER NOT NULL CHECK(event_ended_at >= event_started_at),
  status TEXT NOT NULL CHECK(status IN ('active', 'rejected')),
  edited_at INTEGER CHECK(edited_at IS NULL OR edited_at >= created_at),
  rejected_at INTEGER CHECK(rejected_at IS NULL OR rejected_at >= created_at),
  presented_at INTEGER CHECK(presented_at IS NULL OR presented_at >= created_at),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  CHECK(edited_at IS NULL OR edited_at <= updated_at),
  CHECK(rejected_at IS NULL OR rejected_at <= updated_at),
  CHECK(presented_at IS NULL OR presented_at <= updated_at),
  CHECK(
    (status = 'active' AND rejected_at IS NULL)
    OR (status = 'rejected' AND rejected_at IS NOT NULL)
  )
);

CREATE INDEX idx_shiying_entries_life_date
  ON shiying_entries(life_date DESC, event_started_at DESC, id DESC);
CREATE INDEX idx_shiying_entries_pending
  ON shiying_entries(status, presented_at, batch_id, created_at);
CREATE INDEX idx_shiying_entries_batch
  ON shiying_entries(batch_id, id);

CREATE TABLE shiying_entry_sources (
  entry_id TEXT NOT NULL
    REFERENCES shiying_entries(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  message_id TEXT NOT NULL CHECK(length(message_id) > 0),
  role TEXT NOT NULL CHECK(role IN ('I', 'you')),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('primary_you', 'context_I')),
  message_created_at INTEGER NOT NULL CHECK(message_created_at >= 0),
  excerpt_snapshot TEXT NOT NULL,
  evidence_quote TEXT,
  content_hash TEXT NOT NULL CHECK(content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  PRIMARY KEY(entry_id, ordinal),
  UNIQUE(entry_id, session_id, message_id),
  CHECK(
    (evidence_kind = 'primary_you' AND role = 'you'
      AND evidence_quote IS NOT NULL AND length(evidence_quote) > 0
      AND instr(excerpt_snapshot, evidence_quote) > 0)
    OR (evidence_kind = 'context_I' AND role = 'I' AND evidence_quote IS NULL)
  )
);

CREATE INDEX idx_shiying_entry_sources_message
  ON shiying_entry_sources(session_id, message_id, entry_id);
CREATE INDEX idx_shiying_entry_sources_created
  ON shiying_entry_sources(message_created_at, entry_id);

CREATE TABLE shiying_summaries (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('week', 'month', 'year')),
  period_start_life_date TEXT NOT NULL
    CHECK(length(period_start_life_date) = 10 AND period_start_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end_life_date TEXT NOT NULL
    CHECK(length(period_end_life_date) = 10 AND period_end_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  fact_summary TEXT NOT NULL CHECK(length(trim(fact_summary)) > 0),
  baiyun_note TEXT NOT NULL CHECK(length(trim(baiyun_note)) > 0),
  input_hash TEXT NOT NULL CHECK(input_hash GLOB 'sha256:[0-9a-f]*' AND length(input_hash) = 71),
  contract_version INTEGER NOT NULL CHECK(contract_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('active', 'rejected')),
  dirty INTEGER NOT NULL CHECK(dirty IN (0, 1)),
  rejected_at INTEGER CHECK(rejected_at IS NULL OR rejected_at >= created_at),
  presented_at INTEGER CHECK(presented_at IS NULL OR presented_at >= created_at),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  CHECK(period_start_life_date <= period_end_life_date),
  CHECK(rejected_at IS NULL OR rejected_at <= updated_at),
  CHECK(presented_at IS NULL OR presented_at <= updated_at),
  CHECK(
    (status = 'active' AND rejected_at IS NULL)
    OR (status = 'rejected' AND rejected_at IS NOT NULL)
  )
);

CREATE INDEX idx_shiying_summaries_period
  ON shiying_summaries(kind, period_start_life_date DESC, status);
CREATE INDEX idx_shiying_summaries_pending
  ON shiying_summaries(status, presented_at, dirty, updated_at);

CREATE TABLE shiying_summary_sources (
  summary_id TEXT NOT NULL
    REFERENCES shiying_summaries(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  entry_id TEXT NOT NULL
    REFERENCES shiying_entries(id) ON DELETE RESTRICT,
  PRIMARY KEY(summary_id, ordinal),
  UNIQUE(summary_id, entry_id)
);

CREATE INDEX idx_shiying_summary_sources_entry
  ON shiying_summary_sources(entry_id, summary_id);

CREATE TABLE shiying_coverage_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  lane TEXT NOT NULL CHECK(lane IN ('live', 'backfill')),
  batch_id TEXT NOT NULL,
  chunk_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  life_date_start TEXT NOT NULL
    CHECK(length(life_date_start) = 10 AND life_date_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  life_date_end TEXT NOT NULL
    CHECK(length(life_date_end) = 10 AND life_date_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  window_start_cursor_json TEXT,
  window_end_cursor_json TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(input_hash GLOB 'sha256:[0-9a-f]*' AND length(input_hash) = 71),
  contract_version INTEGER NOT NULL CHECK(contract_version >= 1),
  outcome TEXT NOT NULL CHECK(outcome IN ('zero', 'entries')),
  executor_device_id TEXT,
  completed_at INTEGER NOT NULL CHECK(completed_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at = completed_at),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  CHECK(life_date_start <= life_date_end)
);

CREATE INDEX idx_shiying_coverage_lane_completed
  ON shiying_coverage_receipts(lane, completed_at, id);
CREATE INDEX idx_shiying_coverage_batch
  ON shiying_coverage_receipts(batch_id, chunk_index, id);

CREATE TABLE shiying_coverage_sources (
  receipt_id TEXT NOT NULL
    REFERENCES shiying_coverage_receipts(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  session_id TEXT NOT NULL CHECK(length(session_id) > 0),
  message_id TEXT NOT NULL CHECK(length(message_id) > 0),
  role TEXT NOT NULL CHECK(role IN ('I', 'you')),
  message_created_at INTEGER NOT NULL CHECK(message_created_at >= 0),
  content_hash TEXT NOT NULL CHECK(content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  PRIMARY KEY(receipt_id, ordinal),
  UNIQUE(receipt_id, session_id, message_id)
);

CREATE INDEX idx_shiying_coverage_sources_message
  ON shiying_coverage_sources(session_id, message_id, content_hash, receipt_id);
`;

export const SHIYING_MIGRATION_V1_TO_V2_SQL = `
DROP INDEX idx_shiying_summary_sources_entry;

CREATE TABLE shiying_summary_sources_v2 (
  summary_id TEXT NOT NULL
    REFERENCES shiying_summaries(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  entry_id TEXT NOT NULL,
  PRIMARY KEY(summary_id, ordinal),
  UNIQUE(summary_id, entry_id)
);

INSERT INTO shiying_summary_sources_v2 (summary_id, ordinal, entry_id)
SELECT summary_id, ordinal, entry_id
  FROM shiying_summary_sources;

DROP TABLE shiying_summary_sources;
ALTER TABLE shiying_summary_sources_v2 RENAME TO shiying_summary_sources;

CREATE INDEX idx_shiying_summary_sources_entry
  ON shiying_summary_sources(entry_id, summary_id);
`;

export const SHIYING_MIGRATION_V2_TO_V3_SQL = `
CREATE TABLE shiying_runs (
  batch_id TEXT PRIMARY KEY NOT NULL,
  lane TEXT NOT NULL UNIQUE CHECK(lane = 'live'),
  life_date_start TEXT NOT NULL
    CHECK(length(life_date_start) = 10 AND life_date_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  life_date_end TEXT NOT NULL
    CHECK(length(life_date_end) = 10 AND life_date_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  window_start_cursor_json TEXT,
  window_end_cursor_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'blocked')),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  CHECK(life_date_start <= life_date_end),
  CHECK(
    (status = 'pending' AND last_error_code IS NULL)
    OR (status = 'blocked' AND last_error_code IS NOT NULL)
  )
);

CREATE TABLE shiying_run_chunks (
  run_id TEXT NOT NULL REFERENCES shiying_runs(batch_id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0),
  chunk_id TEXT NOT NULL UNIQUE,
  operation_id TEXT NOT NULL UNIQUE,
  input_hash TEXT NOT NULL CHECK(input_hash GLOB 'sha256:[0-9a-f]*' AND length(input_hash) = 71),
  overlap_from_previous INTEGER NOT NULL CHECK(overlap_from_previous BETWEEN 0 AND 2),
  estimated_tokens INTEGER NOT NULL CHECK(estimated_tokens >= 0),
  status TEXT NOT NULL CHECK(status IN ('pending', 'in_flight', 'completed')),
  attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
  started_at INTEGER CHECK(started_at IS NULL OR started_at >= 0),
  completed_at INTEGER CHECK(completed_at IS NULL OR completed_at >= 0),
  materials_json TEXT NOT NULL CHECK(length(materials_json) > 0),
  candidates_json TEXT,
  PRIMARY KEY(run_id, chunk_index),
  CHECK(
    (status = 'pending' AND candidates_json IS NULL AND completed_at IS NULL)
    OR (status = 'in_flight' AND candidates_json IS NULL AND started_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'completed' AND candidates_json IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX idx_shiying_run_chunks_status
  ON shiying_run_chunks(run_id, status, chunk_index);
`;

export const SHIYING_MIGRATION_V3_TO_V4_SQL = `
CREATE TABLE shiying_records (
  id TEXT PRIMARY KEY NOT NULL,
  record_date TEXT NOT NULL CHECK(length(record_date) = 10 AND record_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  author TEXT NOT NULL CHECK(author = 'you'),
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft', 'finalized')),
  nominal_finalize_at INTEGER NOT NULL CHECK(nominal_finalize_at > created_at),
  finalized_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  CHECK((status = 'draft' AND finalized_at IS NULL)
    OR (status = 'finalized' AND finalized_at IS NOT NULL AND finalized_at >= nominal_finalize_at AND finalized_at <= updated_at))
);
CREATE INDEX idx_shiying_records_date ON shiying_records(record_date DESC, id DESC);

CREATE TABLE shiying_record_images (
  id TEXT PRIMARY KEY NOT NULL,
  record_id TEXT NOT NULL REFERENCES shiying_records(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  content_hash TEXT NOT NULL CHECK(content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  mime_type TEXT NOT NULL CHECK(mime_type LIKE 'image/%'),
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  width INTEGER CHECK(width IS NULL OR width > 0),
  height INTEGER CHECK(height IS NULL OR height > 0),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  UNIQUE(record_id, ordinal)
);
CREATE INDEX idx_shiying_record_images_hash ON shiying_record_images(content_hash, record_id);

CREATE TABLE shiying_events (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  overview TEXT NOT NULL CHECK(length(trim(overview)) > 0),
  dirty INTEGER NOT NULL CHECK(dirty IN (0, 1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1)
);
CREATE TABLE shiying_event_nodes (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES shiying_events(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL CHECK(length(event_date) = 10 AND event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version = 1),
  UNIQUE(event_id, event_date, ordinal)
);
CREATE INDEX idx_shiying_event_nodes_order ON shiying_event_nodes(event_id, event_date, ordinal, id);
CREATE TABLE shiying_event_node_sources (
  node_id TEXT NOT NULL REFERENCES shiying_event_nodes(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('entry', 'record')),
  source_id TEXT NOT NULL,
  content_hash TEXT NOT NULL CHECK(content_hash GLOB 'sha256:[0-9a-f]*' AND length(content_hash) = 71),
  image_ids_json TEXT NOT NULL,
  PRIMARY KEY(node_id, ordinal),
  UNIQUE(node_id, source_kind, source_id)
);
CREATE INDEX idx_shiying_event_sources_fact ON shiying_event_node_sources(source_kind, source_id, node_id);
CREATE TABLE shiying_event_exclusions (
  event_id TEXT NOT NULL REFERENCES shiying_events(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('entry', 'record')),
  source_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
  PRIMARY KEY(event_id, source_kind, source_id)
);

CREATE TABLE shiying_summaries_v4 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('week', 'month', 'year')),
  period_start_life_date TEXT NOT NULL
    CHECK(length(period_start_life_date) = 10 AND period_start_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end_life_date TEXT NOT NULL
    CHECK(length(period_end_life_date) = 10 AND period_end_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  fact_summary TEXT NOT NULL CHECK(length(trim(fact_summary)) > 0),
  baiyun_note TEXT NOT NULL CHECK(length(trim(baiyun_note)) > 0),
  input_hash TEXT NOT NULL CHECK(input_hash GLOB 'sha256:[0-9a-f]*' AND length(input_hash) = 71),
  contract_version INTEGER NOT NULL CHECK(contract_version >= 1),
  status TEXT NOT NULL CHECK(status IN ('active', 'rejected')),
  dirty INTEGER NOT NULL CHECK(dirty IN (0, 1)),
  rejected_at INTEGER CHECK(rejected_at IS NULL OR rejected_at >= created_at),
  presented_at INTEGER CHECK(presented_at IS NULL OR presented_at >= created_at),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version IN (1, 2)),
  CHECK(period_start_life_date <= period_end_life_date),
  CHECK(rejected_at IS NULL OR rejected_at <= updated_at),
  CHECK(presented_at IS NULL OR presented_at <= updated_at),
  CHECK((status = 'active' AND rejected_at IS NULL) OR (status = 'rejected' AND rejected_at IS NOT NULL))
);
CREATE TABLE shiying_summary_sources_v4 (
  summary_id TEXT NOT NULL REFERENCES shiying_summaries_v4(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_kind TEXT NOT NULL CHECK(source_kind IN ('entry', 'record')),
  source_id TEXT NOT NULL,
  content_hash TEXT CHECK(content_hash IS NULL OR length(content_hash) = 71),
  image_ids_json TEXT NOT NULL,
  PRIMARY KEY(summary_id, ordinal),
  UNIQUE(summary_id, source_kind, source_id)
);
INSERT INTO shiying_summaries_v4 SELECT * FROM shiying_summaries;
INSERT INTO shiying_summary_sources_v4
  SELECT summary_id, ordinal, 'entry', entry_id, NULL, '[]' FROM shiying_summary_sources;
DROP TABLE shiying_summary_sources;
DROP TABLE shiying_summaries;
ALTER TABLE shiying_summaries_v4 RENAME TO shiying_summaries;
ALTER TABLE shiying_summary_sources_v4 RENAME TO shiying_summary_sources;
CREATE INDEX idx_shiying_summaries_period ON shiying_summaries(kind, period_start_life_date DESC, status);
CREATE INDEX idx_shiying_summaries_pending ON shiying_summaries(status, presented_at, dirty, updated_at);
CREATE INDEX idx_shiying_summary_sources_fact ON shiying_summary_sources(source_kind, source_id, summary_id);
`;

export const SHIYING_MIGRATION_V4_TO_V5_SQL = `
CREATE TABLE shiying_record_local_state (
  record_id TEXT PRIMARY KEY NOT NULL REFERENCES shiying_records(id) ON DELETE CASCADE,
  resume_until_at INTEGER NOT NULL CHECK(resume_until_at >= 0),
  editing INTEGER NOT NULL CHECK(editing IN (0, 1))
);
CREATE UNIQUE INDEX idx_shiying_record_one_editor
  ON shiying_record_local_state(editing) WHERE editing = 1;
CREATE INDEX idx_shiying_records_preview
  ON shiying_records(record_date DESC, created_at DESC, id DESC);
CREATE INDEX idx_shiying_records_due
  ON shiying_records(status, nominal_finalize_at);
`;

export const SHIYING_MIGRATION_V5_TO_V6_SQL = `
CREATE TABLE shiying_record_image_notes (
  id TEXT PRIMARY KEY NOT NULL,
  record_id TEXT NOT NULL UNIQUE REFERENCES shiying_records(id) ON DELETE CASCADE,
  record_date TEXT NOT NULL,
  record_content_hash TEXT NOT NULL CHECK(length(record_content_hash) = 71),
  status TEXT NOT NULL CHECK(status IN ('ready', 'skipped')),
  body TEXT,
  edited_at INTEGER,
  skipped_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_json TEXT NOT NULL,
  CHECK((status = 'ready' AND body IS NOT NULL AND length(trim(body)) > 0 AND skipped_at IS NULL)
    OR (status = 'skipped' AND body IS NULL AND edited_at IS NULL AND skipped_at IS NOT NULL)),
  CHECK(edited_at IS NULL OR (edited_at >= created_at AND edited_at <= updated_at)),
  CHECK(skipped_at IS NULL OR (skipped_at >= created_at AND skipped_at <= updated_at))
);
CREATE INDEX idx_shiying_image_notes_status ON shiying_record_image_notes(status, record_date, record_id);

CREATE TABLE shiying_record_image_jobs (
  record_id TEXT PRIMARY KEY NOT NULL REFERENCES shiying_records(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK(status IN ('pending', 'blocked', 'skipped')),
  last_error_code TEXT CHECK(last_error_code IS NULL OR length(last_error_code) BETWEEN 1 AND 120),
  created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_json TEXT NOT NULL,
  CHECK((status = 'pending' AND last_error_code IS NULL)
    OR (status IN ('blocked', 'skipped') AND last_error_code IS NOT NULL))
);
CREATE INDEX idx_shiying_image_jobs_queue ON shiying_record_image_jobs(status, created_at, record_id);
`;

export const SHIYING_MIGRATION_V6_TO_V7_SQL = `
CREATE TABLE shiying_automatic_state (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id = 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  first_enabled_life_date TEXT CHECK(first_enabled_life_date IS NULL OR
    (length(first_enabled_life_date) = 10
      AND first_enabled_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(first_enabled_life_date, '+0 days') IS NOT NULL
      AND date(first_enabled_life_date, '+0 days') = first_enabled_life_date)),
  scan_floor_at INTEGER CHECK(scan_floor_at IS NULL OR
    (typeof(scan_floor_at) = 'integer' AND scan_floor_at >= 0)),
  night_life_date TEXT CHECK(night_life_date IS NULL OR
    (length(night_life_date) = 10
      AND night_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND date(night_life_date, '+0 days') IS NOT NULL
      AND date(night_life_date, '+0 days') = night_life_date)),
  reserved_calls INTEGER NOT NULL DEFAULT 0
    CHECK(typeof(reserved_calls) = 'integer' AND reserved_calls BETWEEN 0 AND 2),
  closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0, 1)),
  batch_id TEXT CHECK(batch_id IS NULL OR length(batch_id) > 0),
  last_error_code TEXT CHECK(last_error_code IS NULL OR
    (length(last_error_code) BETWEEN 1 AND 120 AND last_error_code NOT GLOB '*[^a-zA-Z0-9_.:-]*')),
  updated_at INTEGER NOT NULL DEFAULT 0 CHECK(typeof(updated_at) = 'integer' AND updated_at >= 0),
  CHECK((first_enabled_life_date IS NULL) = (scan_floor_at IS NULL)),
  CHECK(enabled = 0 OR first_enabled_life_date IS NOT NULL),
  CHECK(night_life_date IS NULL OR
    (first_enabled_life_date IS NOT NULL AND night_life_date >= first_enabled_life_date)),
  CHECK(night_life_date IS NOT NULL OR (reserved_calls = 0 AND closed = 0 AND batch_id IS NULL AND last_error_code IS NULL))
);
INSERT INTO shiying_automatic_state (id) VALUES (1);
`;

export const SHIYING_MIGRATION_V7_TO_V8_SQL = `
CREATE TABLE shiying_events_v8 (
  id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  overview TEXT NOT NULL CHECK(length(trim(overview)) > 0), dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version IN (1,2)),
  association_feedback_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE shiying_event_nodes_v8 (
  id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES shiying_events_v8(id) ON DELETE CASCADE,
  event_date TEXT NOT NULL CHECK(length(event_date)=10 AND event_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), body TEXT NOT NULL CHECK(length(trim(body)) > 0),
  created_at INTEGER NOT NULL CHECK(created_at >= 0), updated_at INTEGER NOT NULL CHECK(updated_at >= created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version IN (1,2)), UNIQUE(event_id,event_date,ordinal)
);
CREATE TABLE shiying_event_node_sources_v8 (
  node_id TEXT NOT NULL REFERENCES shiying_event_nodes_v8(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), source_kind TEXT NOT NULL CHECK(source_kind IN ('entry','record')),
  source_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=71), image_ids_json TEXT NOT NULL,
  text_ranges_json TEXT, image_note_ranges_json TEXT, image_note_hash TEXT CHECK(image_note_hash IS NULL OR length(image_note_hash)=71),
  PRIMARY KEY(node_id,ordinal), UNIQUE(node_id,source_kind,source_id)
);
CREATE TABLE shiying_event_exclusions_v8 (
  event_id TEXT NOT NULL REFERENCES shiying_events_v8(id) ON DELETE CASCADE,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('entry','record')), source_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL CHECK(updated_at >= 0), PRIMARY KEY(event_id,source_kind,source_id)
);
INSERT INTO shiying_events_v8 (id,title,overview,dirty,created_at,updated_at,payload_version)
  SELECT id,title,overview,dirty,created_at,updated_at,payload_version FROM shiying_events;
INSERT INTO shiying_event_nodes_v8 SELECT * FROM shiying_event_nodes;
INSERT INTO shiying_event_node_sources_v8 (node_id,ordinal,source_kind,source_id,content_hash,image_ids_json)
  SELECT node_id,ordinal,source_kind,source_id,content_hash,image_ids_json FROM shiying_event_node_sources;
INSERT INTO shiying_event_exclusions_v8 SELECT * FROM shiying_event_exclusions;
DROP TABLE shiying_event_node_sources;
DROP TABLE shiying_event_exclusions;
DROP TABLE shiying_event_nodes;
DROP TABLE shiying_events;
ALTER TABLE shiying_events_v8 RENAME TO shiying_events;
ALTER TABLE shiying_event_nodes_v8 RENAME TO shiying_event_nodes;
ALTER TABLE shiying_event_node_sources_v8 RENAME TO shiying_event_node_sources;
ALTER TABLE shiying_event_exclusions_v8 RENAME TO shiying_event_exclusions;
CREATE INDEX idx_shiying_event_nodes_order ON shiying_event_nodes(event_id,event_date,ordinal,id);
CREATE INDEX idx_shiying_event_sources_fact ON shiying_event_node_sources(source_kind,source_id,node_id);
CREATE INDEX idx_shiying_events_browse ON shiying_events(updated_at DESC,id DESC);
CREATE TABLE shiying_topics (
  id TEXT PRIMARY KEY NOT NULL, summary_id TEXT NOT NULL, title TEXT NOT NULL CHECK(length(trim(title)) > 0),
  dirty INTEGER NOT NULL CHECK(dirty IN (0,1)), created_at INTEGER NOT NULL CHECK(created_at >= 0),
  updated_at INTEGER NOT NULL CHECK(updated_at >= created_at), payload_version INTEGER NOT NULL CHECK(payload_version=1)
);
CREATE INDEX idx_shiying_topics_summary ON shiying_topics(summary_id,id);
CREATE TABLE shiying_topic_sources (
  topic_id TEXT NOT NULL REFERENCES shiying_topics(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0), source_kind TEXT NOT NULL CHECK(source_kind IN ('entry','record')),
  source_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=71), image_ids_json TEXT NOT NULL,
  text_ranges_json TEXT NOT NULL, image_note_ranges_json TEXT NOT NULL,
  image_note_hash TEXT CHECK(image_note_hash IS NULL OR length(image_note_hash)=71),
  PRIMARY KEY(topic_id,ordinal), UNIQUE(topic_id,source_kind,source_id)
);
CREATE INDEX idx_shiying_topic_sources_fact ON shiying_topic_sources(source_kind,source_id,topic_id);
CREATE TABLE shiying_review_runs (
  id TEXT PRIMARY KEY NOT NULL, singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL CHECK(period_end >= period_start),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=71), prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=71),
  status TEXT NOT NULL CHECK(status IN ('pending','blocked')), last_error_code TEXT, plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at >= 0), updated_at INTEGER NOT NULL CHECK(updated_at >= created_at)
);
CREATE TABLE shiying_review_chunks (
  id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES shiying_review_runs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index >= 0), stage TEXT NOT NULL CHECK(stage IN ('read','final')),
  status TEXT NOT NULL CHECK(status IN ('pending','in_flight','completed')), payload_json TEXT NOT NULL, result_json TEXT,
  attempts INTEGER NOT NULL CHECK(attempts >= 0), started_at INTEGER, completed_at INTEGER, last_error_code TEXT,
  UNIQUE(run_id,chunk_index),
  CHECK((status='completed' AND result_json IS NOT NULL AND completed_at IS NOT NULL) OR (status!='completed' AND result_json IS NULL AND completed_at IS NULL))
);
CREATE TABLE shiying_review_receipts (
  id TEXT PRIMARY KEY NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL CHECK(period_end >= period_start),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=71), basis_hash TEXT NOT NULL CHECK(length(basis_hash)=71), prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=71),
  outcome TEXT NOT NULL CHECK(outcome IN ('review','empty','sparse')), summary_id TEXT,
  completed_at INTEGER NOT NULL CHECK(completed_at >= 0), dirty INTEGER NOT NULL DEFAULT 0 CHECK(dirty IN (0,1)),
  commit_hash TEXT NOT NULL CHECK(length(commit_hash)=71),
  CHECK((outcome='review' AND summary_id IS NOT NULL) OR (outcome!='review' AND summary_id IS NULL))
);
CREATE INDEX idx_shiying_review_receipts_period ON shiying_review_receipts(period_start,period_end,dirty);
`;

export const SHIYING_MIGRATION_V8_TO_V9_SQL = `
CREATE TABLE shiying_summaries_v9 (
  id TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('week','month','year')),
  period_start_life_date TEXT NOT NULL CHECK(length(period_start_life_date)=10 AND period_start_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end_life_date TEXT NOT NULL CHECK(length(period_end_life_date)=10 AND period_end_life_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND period_end_life_date>=period_start_life_date),
  fact_summary TEXT NOT NULL CHECK(length(trim(fact_summary))>0),
  baiyun_note TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(input_hash GLOB 'sha256:[0-9a-f]*' AND length(input_hash)=71),
  contract_version INTEGER NOT NULL CHECK(contract_version>=1),
  status TEXT NOT NULL CHECK(status IN ('active','rejected')),
  dirty INTEGER NOT NULL CHECK(dirty IN (0,1)),
  rejected_at INTEGER, presented_at INTEGER,
  created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at),
  payload_version INTEGER NOT NULL CHECK(payload_version IN (1,2,3)),
  title TEXT, edited_at INTEGER,
  source_invalidated INTEGER NOT NULL DEFAULT 0 CHECK(source_invalidated IN (0,1)),
  image_coverage_json TEXT,
  CHECK((status='active' AND rejected_at IS NULL) OR (status='rejected' AND rejected_at IS NOT NULL)),
  CHECK(rejected_at IS NULL OR (rejected_at>=created_at AND rejected_at<=updated_at)),
  CHECK(presented_at IS NULL OR (presented_at>=created_at AND presented_at<=updated_at)),
  CHECK(edited_at IS NULL OR (edited_at>=created_at AND edited_at<=updated_at)),
  CHECK(length(trim(baiyun_note))>0 OR (payload_version=3 AND edited_at IS NOT NULL)),
  CHECK(payload_version!=3 OR (title IS NOT NULL AND length(trim(title))>0 AND image_coverage_json IS NOT NULL))
);
CREATE TABLE shiying_summary_sources_v9 (
  summary_id TEXT NOT NULL REFERENCES shiying_summaries_v9(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0), source_kind TEXT NOT NULL CHECK(source_kind IN ('entry','record')),
  source_id TEXT NOT NULL, content_hash TEXT CHECK(content_hash IS NULL OR length(content_hash)=71),
  image_ids_json TEXT NOT NULL, text_ranges_json TEXT, image_note_ranges_json TEXT,
  image_note_hash TEXT CHECK(image_note_hash IS NULL OR length(image_note_hash)=71),
  PRIMARY KEY(summary_id,ordinal), UNIQUE(summary_id,source_kind,source_id)
);
INSERT INTO shiying_summaries_v9
  (id,kind,period_start_life_date,period_end_life_date,fact_summary,baiyun_note,input_hash,contract_version,status,dirty,
   rejected_at,presented_at,created_at,updated_at,payload_version)
  SELECT id,kind,period_start_life_date,period_end_life_date,fact_summary,baiyun_note,input_hash,contract_version,status,dirty,
   rejected_at,presented_at,created_at,updated_at,payload_version FROM shiying_summaries;
INSERT INTO shiying_summary_sources_v9 (summary_id,ordinal,source_kind,source_id,content_hash,image_ids_json)
  SELECT summary_id,ordinal,source_kind,source_id,content_hash,image_ids_json FROM shiying_summary_sources;
DROP TABLE shiying_summary_sources;
DROP TABLE shiying_summaries;
ALTER TABLE shiying_summaries_v9 RENAME TO shiying_summaries;
ALTER TABLE shiying_summary_sources_v9 RENAME TO shiying_summary_sources;
CREATE INDEX idx_shiying_summaries_period ON shiying_summaries(kind,period_start_life_date DESC,status);
CREATE INDEX idx_shiying_summaries_pending ON shiying_summaries(status,presented_at,dirty,updated_at);
CREATE INDEX idx_shiying_summary_sources_fact ON shiying_summary_sources(source_kind,source_id,summary_id);
CREATE TABLE shiying_summary_inputs (
  summary_id TEXT NOT NULL REFERENCES shiying_summaries(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0), source_kind TEXT NOT NULL CHECK(source_kind IN ('summary','event_node')),
  source_id TEXT NOT NULL, content_hash TEXT NOT NULL CHECK(length(content_hash)=71), payload_json TEXT NOT NULL,
  PRIMARY KEY(summary_id,ordinal), UNIQUE(summary_id,source_kind,source_id)
);
CREATE INDEX idx_shiying_summary_inputs_source ON shiying_summary_inputs(source_kind,source_id,summary_id);

CREATE TABLE shiying_review_runs_v9 (
  id TEXT PRIMARY KEY NOT NULL, kind TEXT NOT NULL DEFAULT 'week' UNIQUE CHECK(kind IN ('week','month','year')),
  contract_version INTEGER NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2)),
  period_start TEXT NOT NULL, period_end TEXT NOT NULL CHECK(period_end>=period_start),
  input_hash TEXT NOT NULL CHECK(length(input_hash)=71), prompt_hash TEXT NOT NULL CHECK(length(prompt_hash)=71),
  status TEXT NOT NULL CHECK(status IN ('pending','blocked')), last_error_code TEXT, plan_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0), updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
);
CREATE TABLE shiying_review_chunks_v9 (
  id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES shiying_review_runs_v9(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0), stage TEXT NOT NULL CHECK(stage IN ('read','final')),
  status TEXT NOT NULL CHECK(status IN ('pending','in_flight','completed')), payload_json TEXT NOT NULL, result_json TEXT,
  attempts INTEGER NOT NULL CHECK(attempts>=0), started_at INTEGER, completed_at INTEGER, last_error_code TEXT,
  UNIQUE(run_id,chunk_index),
  CHECK((status='completed' AND result_json IS NOT NULL AND completed_at IS NOT NULL) OR (status!='completed' AND result_json IS NULL AND completed_at IS NULL))
);
INSERT INTO shiying_review_runs_v9 (id,period_start,period_end,input_hash,prompt_hash,status,last_error_code,plan_json,created_at,updated_at)
  SELECT id,period_start,period_end,input_hash,prompt_hash,status,last_error_code,plan_json,created_at,updated_at FROM shiying_review_runs;
INSERT INTO shiying_review_chunks_v9 SELECT * FROM shiying_review_chunks;
DROP TABLE shiying_review_chunks;
DROP TABLE shiying_review_runs;
ALTER TABLE shiying_review_runs_v9 RENAME TO shiying_review_runs;
ALTER TABLE shiying_review_chunks_v9 RENAME TO shiying_review_chunks;
ALTER TABLE shiying_review_receipts ADD COLUMN kind TEXT NOT NULL DEFAULT 'week' CHECK(kind IN ('week','month','year'));
ALTER TABLE shiying_review_receipts ADD COLUMN contract_version INTEGER NOT NULL DEFAULT 1 CHECK(contract_version IN (1,2));
ALTER TABLE shiying_review_receipts ADD COLUMN regeneration_intent_id TEXT;
CREATE INDEX idx_shiying_review_receipts_kind ON shiying_review_receipts(kind,period_start,period_end,dirty);
`;

export const SHIYING_MIGRATION_V9_TO_V10_SQL = `
CREATE TABLE shiying_backfill_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  singleton INTEGER NOT NULL DEFAULT 1 UNIQUE CHECK(singleton=1),
  status TEXT NOT NULL CHECK(status IN ('paused','running','blocked','completed')),
  revision INTEGER NOT NULL CHECK(revision>=0),
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL CHECK(created_at>=0),
  updated_at INTEGER NOT NULL CHECK(updated_at>=created_at)
);
CREATE TABLE shiying_backfill_chunks (
  task_id TEXT NOT NULL REFERENCES shiying_backfill_tasks(id) ON DELETE CASCADE,
  life_date TEXT NOT NULL,
  chunk_index INTEGER NOT NULL CHECK(chunk_index>=0),
  payload_json TEXT NOT NULL,
  PRIMARY KEY(task_id,life_date,chunk_index)
);
`;

function databaseError(code: string): Error {
  return new Error(`shiying_database_${code}`);
}

export async function purgeExpiredRejectedShiyingEntries(
  database: Pick<SQLite.SQLiteDatabase, 'runAsync'>,
  now = Date.now(),
) {
  if (!Number.isSafeInteger(now) || now < 0) throw databaseError('cleanup_time');
  const cutoff = now - SHIYING_REJECTED_ENTRY_RETENTION_MS;
  if (cutoff < 0) return 0;
  const result = await database.runAsync(
    `DELETE FROM shiying_entries
      WHERE status = 'rejected'
        AND rejected_at <= ?;`,
    cutoff,
  );
  return result.changes;
}

export async function initializeShiyingDatabaseSchema(
  database: ShiyingMigrationConnection,
) {
  await database.execAsync('PRAGMA foreign_keys = ON;');
  const versionRow = await database.getFirstAsync<UserVersionRow>('PRAGMA user_version;');
  const version = versionRow?.user_version ?? 0;
  if (version > SHIYING_DATABASE_VERSION) throw databaseError('newer_version');
  if (version < SHIYING_DATABASE_VERSION) {
    await database.withExclusiveTransactionAsync(async (transaction) => {
      let nextVersion = version;
      if (nextVersion === 0) {
        await transaction.execAsync(SHIYING_SCHEMA_V1_SQL);
        await transaction.execAsync('PRAGMA user_version = 1;');
        nextVersion = 1;
      }
      if (nextVersion === 1) {
        await transaction.execAsync(SHIYING_MIGRATION_V1_TO_V2_SQL);
        await transaction.execAsync('PRAGMA user_version = 2;');
        nextVersion = 2;
      }
      if (nextVersion === 2) {
        await transaction.execAsync(SHIYING_MIGRATION_V2_TO_V3_SQL);
        await transaction.execAsync('PRAGMA user_version = 3;');
        nextVersion = 3;
      }
      if (nextVersion === 3) {
        await transaction.execAsync(SHIYING_MIGRATION_V3_TO_V4_SQL);
        await transaction.execAsync('PRAGMA user_version = 4;');
        nextVersion = 4;
      }
      if (nextVersion === 4) {
        await transaction.execAsync(SHIYING_MIGRATION_V4_TO_V5_SQL);
        await transaction.execAsync('PRAGMA user_version = 5;');
        nextVersion = 5;
      }
      if (nextVersion === 5) {
        await transaction.execAsync(SHIYING_MIGRATION_V5_TO_V6_SQL);
        await transaction.execAsync('PRAGMA user_version = 6;');
        nextVersion = 6;
      }
      if (nextVersion === 6) {
        await transaction.execAsync(SHIYING_MIGRATION_V6_TO_V7_SQL);
        await transaction.execAsync('PRAGMA user_version = 7;');
        nextVersion = 7;
      }
      if (nextVersion === 7) {
        await transaction.execAsync(SHIYING_MIGRATION_V7_TO_V8_SQL);
        await transaction.execAsync('PRAGMA user_version = 8;');
        nextVersion = 8;
      }
      if (nextVersion === 8) {
        await transaction.execAsync(SHIYING_MIGRATION_V8_TO_V9_SQL);
        const violations = await transaction.getAllAsync<Record<string, unknown>>('PRAGMA foreign_key_check;');
        if (violations.length > 0) throw databaseError('foreign_key_check_failed');
        await transaction.execAsync('PRAGMA user_version = 9;');
        nextVersion = 9;
      }
      if (nextVersion === 9) {
        await transaction.execAsync(SHIYING_MIGRATION_V9_TO_V10_SQL);
        await transaction.execAsync('PRAGMA user_version = 10;');
      }
    });
  }
  const violations = await database.getAllAsync<Record<string, unknown>>(
    'PRAGMA foreign_key_check;',
  );
  if (violations.length > 0) throw databaseError('foreign_key_check_failed');
}

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;
let operationQueue = Promise.resolve();
let maintenance = false;

export function enqueueShiyingDatabaseOperation<T>(operation: () => Promise<T>) {
  const current = operationQueue.catch(() => undefined).then(operation);
  operationQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function getShiyingDatabase() {
  if (maintenance) throw databaseError('maintenance');
  if (!databasePromise) {
    const opening = SQLite.openDatabaseAsync(SHIYING_DATABASE_NAME).then(async (database) => {
      try {
        await initializeShiyingDatabaseSchema(database);
        await purgeExpiredRejectedShiyingEntries(database);
        return database;
      } catch (error) {
        await database.closeAsync().catch(() => undefined);
        throw error;
      }
    });
    const retryable = opening.catch((error) => {
      if (databasePromise === retryable) databasePromise = undefined;
      throw error;
    });
    databasePromise = retryable;
  }
  return databasePromise;
}

export function runShiyingDatabaseOperation<T>(
  operation: (database: SQLite.SQLiteDatabase) => Promise<T>,
) {
  return enqueueShiyingDatabaseOperation(async () => operation(await getShiyingDatabase()));
}

export function runShiyingTransaction<T>(
  operation: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  return runShiyingDatabaseOperation(async (database) => {
    // SDK 54's exclusive helper opens another connection without inheriting foreign_keys.
    // The domain queue serializes every operation; retain this initialized connection.
    await database.execAsync('BEGIN EXCLUSIVE;');
    try {
      const result = await operation(database);
      await database.execAsync('COMMIT;');
      return result;
    } catch (error) {
      await database.execAsync('ROLLBACK;');
      throw error;
    }
  });
}

export function closeShiyingDatabase() {
  return enqueueShiyingDatabaseOperation(async () => {
    const current = databasePromise;
    databasePromise = undefined;
    if (!current) return;
    const database = await current;
    await database.closeAsync();
  });
}

// The caller already owns the restore window. Do not enqueue close again here.
export function runShiyingDatabaseMaintenance<T>(operation: () => Promise<T>) {
  return enqueueShiyingDatabaseOperation(async () => {
    maintenance = true;
    try {
      const current = databasePromise;
      databasePromise = undefined;
      if (current) await (await current).closeAsync();
      return await operation();
    } finally {
      databasePromise = undefined;
      maintenance = false;
    }
  });
}
