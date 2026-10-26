import { THEATER_STORY_SCHEMA_SQL } from './theaterStorySchema';
import { writeTheaterStoryTransaction, type TheaterStoryDatabase, type TheaterStorySql } from './theaterStoryStore';
import { emptyTheaterStorySettings, readTheaterSummaryInterval } from './theaterStoryTypes';

type LegacyPersona = {
  id: string; name: string; persona: string; temperature?: number; context_limit?: number;
  created_at: number; updated_at: number;
};
type LegacyConversation = {
  id: string; title: string; persona_id?: string | null; persona_snapshot?: string | null;
  story_state?: string | null; summary_interval?: number | null;
  created_at: number; updated_at: number;
};
type LegacyMessage = {
  id: string; conversation_id: string; role: string; content: string;
  created_at: number; updated_at?: number;
};

export const legacyTheaterBranchId = (id: string) => `legacy-branch:${id}`;
export const legacyTheaterPositionId = (id: string) => `legacy-position:${id}`;
export const legacyTheaterVersionId = (id: string) => `legacy-version:${id}`;
export const legacyTheaterDraftId = (id: string) => `legacy-draft:${id}`;

async function hasTable(tx: TheaterStorySql, table: string) {
  return Boolean(await tx.getFirstAsync(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table,
  ));
}

function snapshotSettings(raw: string, persona?: LegacyPersona) {
  return {
    ...emptyTheaterStorySettings(),
    legacyPersona: raw,
    temperature: persona?.temperature ?? 0.8,
    contextLimit: persona?.context_limit ?? 20,
  };
}

// These columns extend an already migrated database; this is not the migration entry point.
export async function ensureTheaterStorySyncColumns(tx: TheaterStorySql) {
  const versionColumns = await tx.getAllAsync<{ name: string }>('PRAGMA table_info(theater_text_versions)');
  if (versionColumns.length && !versionColumns.some((column) => column.name === 'co_creation_json')) {
    await tx.execAsync('ALTER TABLE theater_text_versions ADD COLUMN co_creation_json TEXT');
  }
  const branchColumns = await tx.getAllAsync<{ name: string }>('PRAGMA table_info(theater_branches)');
  if (branchColumns.length && !branchColumns.some((column) => column.name === 'fork_boundary')) {
    await tx.execAsync('ALTER TABLE theater_branches ADD COLUMN fork_boundary INTEGER CHECK (fork_boundary IS NULL OR fork_boundary >= 0)');
  }
  if (branchColumns.length && !branchColumns.some((column) => column.name === 'stale_checkpoint_id')) {
    // Old tables cannot gain a composite FK with ADD COLUMN; restore validation checks this reference too.
    await tx.execAsync('ALTER TABLE theater_branches ADD COLUMN stale_checkpoint_id TEXT');
  }
  const columns = new Set((await tx.getAllAsync<{ name: string }>('PRAGMA table_info(theater_conversations)')).map((row) => row.name));
  for (const column of ['is_pinned', 'legacy_sync_open']) {
    if (!columns.has(column)) await tx.execAsync(`ALTER TABLE theater_conversations ADD COLUMN ${column} INTEGER NOT NULL DEFAULT 0 CHECK (${column} IN (0, 1))`);
  }
}

// Chapter 3 compatibility + separate device authorization are prerequisites for live use.
// DDL, legacy conversion and the version marker commit together; a failure rolls all back.
export async function migrateTheaterStoryDatabase(database: TheaterStoryDatabase): Promise<boolean> {
  return writeTheaterStoryTransaction(database, async (tx) => {
    if (await hasTable(tx, 'theater_story_schema')) {
      const marker = await tx.getFirstAsync<{ version: number }>('SELECT version FROM theater_story_schema');
      if (marker?.version !== 2) throw new Error('theater-story-unsupported-schema');
      await ensureTheaterStorySyncColumns(tx);
      return false;
    }

    const personas = await hasTable(tx, 'theater_personas')
      ? await tx.getAllAsync<LegacyPersona>('SELECT * FROM theater_personas ORDER BY rowid') : [];
    const conversations = await hasTable(tx, 'theater_conversations')
      ? await tx.getAllAsync<LegacyConversation>('SELECT * FROM theater_conversations ORDER BY rowid') : [];
    // rowid preserves insertion order for equal timestamps in the existing ordinary SQLite table.
    const messages = await hasTable(tx, 'theater_messages')
      ? await tx.getAllAsync<LegacyMessage>('SELECT * FROM theater_messages ORDER BY created_at, rowid') : [];
    const conversationIds = new Set(conversations.map((row) => row.id));
    for (const message of messages) {
      if (!conversationIds.has(message.conversation_id)) throw new Error('theater-story-orphan-legacy-message');
      if (!['I', 'you', 'system'].includes(message.role)) throw new Error('theater-story-unknown-legacy-subject');
    }

    await tx.execAsync(`CREATE TABLE IF NOT EXISTS theater_conversations (
      id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, persona_id TEXT,
      persona_snapshot TEXT NOT NULL DEFAULT '', story_state TEXT NOT NULL DEFAULT '',
      summary_interval INTEGER DEFAULT 20, last_summarized_message_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`);
    const columns = new Set((await tx.getAllAsync<{ name: string }>(
      'PRAGMA table_info(theater_conversations)',
    )).map((row) => row.name));
    // Known historical optional fields only; never guess missing ids, times or message bodies.
    const additions = [
      ['persona_id', 'TEXT'], ['persona_snapshot', "TEXT NOT NULL DEFAULT ''"],
      ['story_state', "TEXT NOT NULL DEFAULT ''"], ['summary_interval', 'INTEGER DEFAULT 20'],
      ['last_summarized_message_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['settings_json', 'TEXT'], ['is_draft', 'INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1))'],
    ];
    for (const [column, definition] of additions) {
      if (!columns.has(column)) await tx.execAsync(`ALTER TABLE theater_conversations ADD COLUMN ${column} ${definition}`);
    }
    await tx.execAsync(THEATER_STORY_SCHEMA_SQL);
    await ensureTheaterStorySyncColumns(tx);

    const personasById = new Map(personas.map((row) => [row.id, row]));
    const usedPersonas = new Set<string>();
    for (const conversation of conversations) {
      const persona = conversation.persona_id ? personasById.get(conversation.persona_id) : undefined;
      if (persona) usedPersonas.add(persona.id);
      // Match the old runtime's snapshot || shared-persona precedence, without trimming/rewording.
      const raw = conversation.persona_snapshot || persona?.persona || '';
      await tx.runAsync('UPDATE theater_conversations SET settings_json = ? WHERE id = ?',
        JSON.stringify(snapshotSettings(raw, persona)), conversation.id);
      const branchId = legacyTheaterBranchId(conversation.id);
      await tx.runAsync(`INSERT INTO theater_branches (id, conversation_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)`, branchId, conversation.id, '最初走向', conversation.created_at, conversation.updated_at);
      const ordered = messages.filter((message) => message.conversation_id === conversation.id);
      for (const [ordinal, message] of ordered.entries()) {
        const positionId = legacyTheaterPositionId(message.id);
        const versionId = legacyTheaterVersionId(message.id);
        await tx.runAsync(`INSERT INTO theater_text_versions
          (id, conversation_id, position_id, kind, subject, content, origin, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 'legacy', ?, ?)`,
        versionId, conversation.id, positionId,
        message.role === 'system' ? 'legacy-context-note' : 'dialogue',
        message.role === 'system' ? null : message.role, message.content,
        message.created_at, message.updated_at ?? message.created_at);
        await tx.runAsync(`INSERT INTO theater_branch_positions
          (conversation_id, branch_id, ordinal, position_id, version_id) VALUES (?, ?, ?, ?, ?)`,
        conversation.id, branchId, ordinal, positionId, versionId);
      }
      if (conversation.story_state) {
        // The old count cannot prove which edited versions or last-80 window were summarized.
        await tx.runAsync(`INSERT INTO theater_checkpoints
          (id, conversation_id, branch_id, content, covered_position_id, basis_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, NULL, '[]', 'legacy-unverified', ?, ?)`,
        `legacy-checkpoint:${conversation.id}`, conversation.id, branchId, conversation.story_state,
        conversation.created_at, conversation.updated_at);
      }
    }

    for (const persona of personas) {
      if (usedPersonas.has(persona.id)) continue;
      // A saved setting without a story becomes an editable saved draft, not an empty play.
      await tx.runAsync(`INSERT INTO theater_conversations
        (id, title, persona_id, persona_snapshot, settings_json, summary_interval, is_draft, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      legacyTheaterDraftId(persona.id), persona.name, persona.id, persona.persona,
      JSON.stringify(snapshotSettings(persona.persona, persona)), readTheaterSummaryInterval(undefined),
      persona.created_at, persona.updated_at);
    }
    await tx.runAsync('INSERT INTO theater_story_schema (version) VALUES (2)');
    return true;
  });
}
