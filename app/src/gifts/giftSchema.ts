import { GIFT_SYNC_SCHEMA_SQL } from '../sync/syncGiftsSql';

/** Installed alongside the existing memory database; does not change its user_version. */
export const GIFT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS gift_creation_run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS gift_records (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    record_json TEXT NOT NULL CHECK (json_valid(record_json))
  );
  CREATE TABLE IF NOT EXISTS gift_attachment_activity (
    gift_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    viewer TEXT NOT NULL CHECK (viewer IN ('I', 'you')),
    revision INTEGER NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    PRIMARY KEY (gift_id, attachment_id, viewer)
  );
  CREATE TABLE IF NOT EXISTS gift_processing_state (
    gift_id TEXT NOT NULL,
    gift_revision INTEGER NOT NULL,
    stage TEXT NOT NULL,
    last_failed_attempt INTEGER NOT NULL DEFAULT 0,
    retry_at INTEGER NOT NULL DEFAULT 0,
    error_code TEXT,
    PRIMARY KEY (gift_id, gift_revision, stage)
  );
  CREATE TABLE IF NOT EXISTS gift_understanding_receipts (
    gift_id TEXT NOT NULL,
    gift_revision INTEGER NOT NULL,
    attachment_id TEXT NOT NULL,
    original_id TEXT NOT NULL,
    subject TEXT NOT NULL CHECK (subject = 'I'),
    content TEXT NOT NULL,
    understood_at INTEGER NOT NULL,
    PRIMARY KEY (gift_id, gift_revision, attachment_id)
  );
  CREATE TABLE IF NOT EXISTS gift_echoes (
    gift_id TEXT NOT NULL,
    id TEXT NOT NULL,
    gift_revision INTEGER NOT NULL CHECK (gift_revision >= 1),
    sequence INTEGER NOT NULL CHECK (sequence >= 1),
    subject TEXT NOT NULL CHECK (subject IN ('I', 'you')),
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('message', 'understanding', 'reply')),
    reply_to_id TEXT,
    attachment_id TEXT,
    original_id TEXT,
    read_at INTEGER,
    PRIMARY KEY (gift_id, id),
    UNIQUE (gift_id, sequence),
    UNIQUE (gift_id, reply_to_id)
  );
  CREATE TABLE IF NOT EXISTS gift_echo_reads (
    gift_id TEXT NOT NULL,
    gift_revision INTEGER NOT NULL CHECK (gift_revision >= 1),
    reply_to_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    original_id TEXT NOT NULL,
    selected_at INTEGER NOT NULL CHECK (selected_at >= 0),
    PRIMARY KEY (gift_id, gift_revision, reply_to_id)
  );
${GIFT_SYNC_SCHEMA_SQL}
`;
