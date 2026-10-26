// Installed explicitly by the chapter-2 migrator, NOT by the live database opener.
// All tables belong in the existing junluo-theater.db. No second story database.
export const THEATER_STORY_SCHEMA_SQL = `
  CREATE TABLE theater_story_schema (version INTEGER PRIMARY KEY CHECK (version = 2));

  CREATE TABLE theater_branches (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES theater_conversations(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    active_checkpoint_id TEXT,
    stale_checkpoint_id TEXT,
    fork_boundary INTEGER CHECK (fork_boundary IS NULL OR fork_boundary >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (conversation_id, id),
    CHECK (active_checkpoint_id IS NULL OR stale_checkpoint_id IS NULL),
    FOREIGN KEY (conversation_id, id, active_checkpoint_id)
      REFERENCES theater_checkpoints(conversation_id, branch_id, id),
    FOREIGN KEY (conversation_id, id, stale_checkpoint_id)
      REFERENCES theater_checkpoints(conversation_id, branch_id, id)
  );
  CREATE INDEX idx_theater_branches_conversation ON theater_branches(conversation_id);

  CREATE TABLE theater_text_versions (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES theater_conversations(id) ON DELETE CASCADE,
    position_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('dialogue', 'legacy-context-note')),
    subject TEXT,
    content TEXT NOT NULL,
    origin TEXT NOT NULL CHECK (origin IN ('legacy', 'generated', 'edited')),
    co_creation_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'dialogue' AND subject IS NOT NULL AND subject IN ('I', 'you'))
      OR (kind = 'legacy-context-note' AND subject IS NULL)),
    UNIQUE (conversation_id, position_id, id)
  );
  CREATE INDEX idx_theater_versions_position ON theater_text_versions(conversation_id, position_id);

  CREATE TABLE theater_branch_positions (
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
    position_id TEXT NOT NULL,
    version_id TEXT NOT NULL,
    PRIMARY KEY (branch_id, position_id),
    UNIQUE (branch_id, ordinal),
    FOREIGN KEY (conversation_id, branch_id)
      REFERENCES theater_branches(conversation_id, id) ON DELETE CASCADE,
    FOREIGN KEY (conversation_id, position_id, version_id)
      REFERENCES theater_text_versions(conversation_id, position_id, id)
  );

  CREATE TABLE theater_checkpoints (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    content TEXT NOT NULL,
    covered_position_id TEXT,
    basis_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'saved', 'legacy-unverified')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (conversation_id, branch_id, id),
    FOREIGN KEY (conversation_id, branch_id)
      REFERENCES theater_branches(conversation_id, id) ON DELETE CASCADE
  );
  CREATE INDEX idx_theater_checkpoints_branch ON theater_checkpoints(branch_id);

  CREATE TABLE theater_anchors (
    id TEXT PRIMARY KEY NOT NULL,
    conversation_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    position_id TEXT NOT NULL,
    source_version_id TEXT,
    source TEXT NOT NULL CHECK (source IN ('manual', 'message', 'summary')),
    content TEXT NOT NULL,
    confirmed INTEGER NOT NULL CHECK (confirmed IN (0, 1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (source != 'message' OR source_version_id IS NOT NULL),
    FOREIGN KEY (conversation_id, branch_id)
      REFERENCES theater_branches(conversation_id, id) ON DELETE CASCADE,
    FOREIGN KEY (branch_id, position_id)
      REFERENCES theater_branch_positions(branch_id, position_id),
    FOREIGN KEY (conversation_id, position_id, source_version_id)
      REFERENCES theater_text_versions(conversation_id, position_id, id)
  );
  CREATE INDEX idx_theater_anchors_branch ON theater_anchors(branch_id);
`;
