export const MEMORY_BASE_SCHEMA_SQL = `
        CREATE TABLE IF NOT EXISTS memories (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          content TEXT NOT NULL,
          domain TEXT NOT NULL DEFAULT '其他',
          tags_json TEXT NOT NULL,
          recall_cues_json TEXT NOT NULL DEFAULT '[]',
          importance INTEGER NOT NULL,
          valence REAL NOT NULL,
          arousal REAL NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          anchor INTEGER NOT NULL DEFAULT 0,
          anchor_kind TEXT,
          type TEXT NOT NULL DEFAULT 'dynamic',
          tier TEXT NOT NULL DEFAULT 'working',
          semantic_type TEXT NOT NULL DEFAULT 'other',
          stability REAL NOT NULL DEFAULT 0.5,
          resolved INTEGER NOT NULL DEFAULT 0,
          digested INTEGER NOT NULL DEFAULT 0,
          activation_count REAL NOT NULL DEFAULT 0,
          last_active_at INTEGER NOT NULL DEFAULT 0,
          confidence REAL,
          model_valence REAL,
          protected INTEGER NOT NULL DEFAULT 0,
          archived_at INTEGER,
          archive_reason TEXT,
          atomic_kind TEXT NOT NULL DEFAULT 'unknown',
          event_at INTEGER,
          event_start_at INTEGER,
          event_end_at INTEGER,
          event_time_precision TEXT NOT NULL DEFAULT 'unknown',
          event_time_basis TEXT NOT NULL DEFAULT 'unknown',
          event_time_source_message_id TEXT,
          event_time_expression TEXT,
          extraction_basis TEXT NOT NULL DEFAULT 'unknown',
          source TEXT,
          period TEXT,
          date TEXT,
          source_type TEXT NOT NULL,
          source_start_at INTEGER,
          source_end_at INTEGER,
          confirmation_level TEXT NOT NULL DEFAULT 'automatic',
          source_trace_mode TEXT NOT NULL DEFAULT 'legacy_range',
          remembered_reason TEXT,
          weekly_context_basis_json TEXT,
          understanding_subject TEXT CHECK (understanding_subject IN ('I', 'you')),
          understanding_basis_json TEXT,
          chat_summary_correction_json TEXT,
          last_surfaced_at INTEGER,
          surface_suppressed_until INTEGER,
          surface_muted_at INTEGER,
          surface_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_comments (
          id TEXT PRIMARY KEY NOT NULL,
          memory_id TEXT NOT NULL,
          content TEXT NOT NULL,
          source_type TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'comment',
          author TEXT NOT NULL DEFAULT '白云小姐',
          valence REAL,
          arousal REAL,
          source TEXT,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_embeddings (
          memory_id TEXT PRIMARY KEY NOT NULL,
          embedding_json TEXT NOT NULL,
          model TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_source_refs (
          memory_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          message_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('I', 'you')),
          message_created_at INTEGER NOT NULL,
          relation TEXT NOT NULL CHECK (relation IN ('direct', 'derived')),
          excerpt TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (memory_id, session_id, message_id, relation)
        );
        CREATE TABLE IF NOT EXISTS memory_edges (
          id TEXT PRIMARY KEY NOT NULL,
          source_id TEXT NOT NULL,
          target_id TEXT NOT NULL,
          relation_type TEXT NOT NULL,
          confidence REAL NOT NULL,
          reason TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_recall_feedback (
          id TEXT PRIMARY KEY NOT NULL,
          memory_id TEXT NOT NULL,
          query TEXT NOT NULL,
          kind TEXT NOT NULL,
          reason TEXT,
          sources_json TEXT NOT NULL DEFAULT '[]',
          score REAL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_timeline_threads (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT,
          hidden INTEGER NOT NULL DEFAULT 0,
          manual INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_timeline_members (
          thread_id TEXT NOT NULL,
          memory_id TEXT NOT NULL,
          included INTEGER NOT NULL DEFAULT 1,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (thread_id, memory_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_comments_memory_id
          ON memory_comments(memory_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_source_refs_memory
          ON memory_source_refs(memory_id, message_created_at ASC);
        CREATE INDEX IF NOT EXISTS idx_memory_source_refs_message
          ON memory_source_refs(session_id, message_id);
        CREATE INDEX IF NOT EXISTS idx_memory_edges_source
          ON memory_edges(source_id, confidence DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_edges_target
          ON memory_edges(target_id, confidence DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_recall_feedback_memory
          ON memory_recall_feedback(memory_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_memory_timeline_members_thread
          ON memory_timeline_members(thread_id, position ASC);
      `;

export const MEMORY_FTS_SCHEMA_SQL = `
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        title,
        content,
        domain,
        tags,
        recall_cues
      );
      CREATE TRIGGER IF NOT EXISTS memory_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memory_fts(memory_id, title, content, domain, tags, recall_cues)
        VALUES (new.id, new.title, new.content, new.domain, new.tags_json, new.recall_cues_json);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_delete AFTER DELETE ON memories BEGIN
        DELETE FROM memory_fts WHERE memory_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS memory_fts_update AFTER UPDATE OF title, content, domain, tags_json, recall_cues_json ON memories BEGIN
        DELETE FROM memory_fts WHERE memory_id = old.id;
        INSERT INTO memory_fts(memory_id, title, content, domain, tags, recall_cues)
        VALUES (new.id, new.title, new.content, new.domain, new.tags_json, new.recall_cues_json);
      END;
      DELETE FROM memory_fts;
      INSERT INTO memory_fts(memory_id, title, content, domain, tags, recall_cues)
      SELECT id, title, content, domain, tags_json, recall_cues_json FROM memories;
    `;
