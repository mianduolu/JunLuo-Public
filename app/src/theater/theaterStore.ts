import * as SQLite from 'expo-sqlite';
import { prepareTheaterStoryRestore } from './theaterStoryBackup';
import { hasTheaterStorySchema } from '../sync/syncTheaterStorySqlite';
import { THEATER_STORY_CAPTURE_SQL } from '../sync/syncTheaterStorySql';
import { ensureTheaterStorySyncColumns } from './theaterStoryMigration';
import { openDatabaseImportSource, type DatabaseImportSource } from '../backup/sqliteBackupFiles';
import {
  THEATER_ISOLATED_FULL_CAPTURE_SCHEMA_SQL,
  THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL,
} from '../sync/syncTheaterIsolatedSql';

export type TheaterMessageRole = 'you' | 'I' | 'system';

export type TheaterPersona = {
  contextLimit: number;
  createdAt: number;
  id: string;
  name: string;
  persona: string;
  temperature: number;
  updatedAt: number;
};

export type TheaterConversation = {
  createdAt: number;
  id: string;
  lastSummarizedMessageCount: number;
  messageCount: number;
  personaId: string | null;
  personaSnapshot: string;
  storyState: string;
  summaryInterval: number | null;
  title: string;
  updatedAt: number;
};

export type TheaterMessage = {
  content: string;
  conversationId: string;
  createdAt: number;
  id: string;
  role: TheaterMessageRole;
  updatedAt: number;
};

export type TheaterPersonaDraft = {
  contextLimit?: number;
  name: string;
  persona: string;
  temperature?: number;
};

export type TheaterConversationDraft = {
  persona?: TheaterPersona | null;
  summaryInterval?: number | null;
  title?: string;
};

type TheaterPersonaRow = {
  context_limit: number;
  created_at: number;
  id: string;
  name: string;
  persona: string;
  temperature: number;
  updated_at: number;
};

type TheaterConversationRow = {
  created_at: number;
  id: string;
  last_summarized_message_count?: number | null;
  message_count?: number;
  persona_id: string | null;
  persona_snapshot?: string | null;
  story_state?: string | null;
  summary_interval?: number | null;
  title: string;
  updated_at: number;
};

type TheaterMessageRow = {
  content: string;
  conversation_id: string;
  created_at: number;
  id: string;
  role: TheaterMessageRole;
  updated_at: number;
};

let databasePromise: Promise<SQLite.SQLiteDatabase> | undefined;

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampTemperature(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0.8;
  return Math.max(0, Math.min(2, value));
}

function clampContextLimit(value?: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  return Math.max(4, Math.min(80, Math.round(value)));
}

function normalizeSummaryInterval(value?: number | null) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return 20;
  const rounded = Math.round(value);
  if (rounded <= 0) return null;
  return Math.max(3, Math.min(200, rounded));
}

function fromPersonaRow(row: TheaterPersonaRow): TheaterPersona {
  return {
    contextLimit: row.context_limit,
    createdAt: row.created_at,
    id: row.id,
    name: row.name,
    persona: row.persona,
    temperature: row.temperature,
    updatedAt: row.updated_at,
  };
}

function fromConversationRow(row: TheaterConversationRow): TheaterConversation {
  return {
    createdAt: row.created_at,
    id: row.id,
    lastSummarizedMessageCount: row.last_summarized_message_count ?? 0,
    messageCount: row.message_count ?? 0,
    personaId: row.persona_id,
    personaSnapshot: row.persona_snapshot ?? '',
    storyState: row.story_state ?? '',
    summaryInterval: row.summary_interval ?? 20,
    title: row.title,
    updatedAt: row.updated_at,
  };
}

function fromMessageRow(row: TheaterMessageRow): TheaterMessage {
  return {
    content: row.content,
    conversationId: row.conversation_id,
    createdAt: row.created_at,
    id: row.id,
    role: row.role,
    updatedAt: row.updated_at,
  };
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = SQLite.openDatabaseAsync('junluo-theater.db').then(async (database) => {
      await database.execAsync(`
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS theater_personas (
          id TEXT PRIMARY KEY NOT NULL,
          name TEXT NOT NULL,
          persona TEXT NOT NULL DEFAULT '',
          temperature REAL NOT NULL DEFAULT 0.8,
          context_limit INTEGER NOT NULL DEFAULT 20,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_theater_personas_updated_at
          ON theater_personas(updated_at DESC);

        CREATE TABLE IF NOT EXISTS theater_conversations (
          id TEXT PRIMARY KEY NOT NULL,
          title TEXT NOT NULL,
          persona_id TEXT,
          persona_snapshot TEXT NOT NULL DEFAULT '',
          story_state TEXT NOT NULL DEFAULT '',
          summary_interval INTEGER DEFAULT 20,
          last_summarized_message_count INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_theater_conversations_updated_at
          ON theater_conversations(updated_at DESC);

        CREATE TABLE IF NOT EXISTS theater_messages (
          id TEXT PRIMARY KEY NOT NULL,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY(conversation_id) REFERENCES theater_conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_theater_messages_conversation_created
          ON theater_messages(conversation_id, created_at ASC);
      `);
      await database.execAsync('ALTER TABLE theater_conversations ADD COLUMN persona_snapshot TEXT NOT NULL DEFAULT \'\';').catch(() => undefined);
      await database.execAsync('ALTER TABLE theater_conversations ADD COLUMN story_state TEXT NOT NULL DEFAULT \'\';').catch(() => undefined);
      await database.execAsync('ALTER TABLE theater_conversations ADD COLUMN summary_interval INTEGER DEFAULT 20;').catch(() => undefined);
      await database.execAsync('ALTER TABLE theater_conversations ADD COLUMN last_summarized_message_count INTEGER NOT NULL DEFAULT 0;').catch(() => undefined);
      await database.execAsync(THEATER_ISOLATED_FULL_CAPTURE_SCHEMA_SQL);
      if (await hasTheaterStorySchema(database)) {
        await ensureTheaterStorySyncColumns(database);
        await database.execAsync(THEATER_STORY_CAPTURE_SQL);
      }
      return database;
    });
  }
  return databasePromise;
}

export async function getTheaterDatabase() {
  return getDatabase();
}

export async function exportTheaterDatabase() {
  const database = await getDatabase();
  return database.serializeAsync();
}

export async function importTheaterDatabase(sourceFile: DatabaseImportSource) {
  const source = await openDatabaseImportSource(sourceFile);
  try {
    await prepareTheaterStoryRestore(source);
    if (databasePromise) {
      const openDatabase = await databasePromise;
      await openDatabase.closeAsync();
      databasePromise = undefined;
    }
    const destination = await SQLite.openDatabaseAsync('junluo-theater.db');
    try {
      await SQLite.backupDatabaseAsync({ sourceDatabase: source, destDatabase: destination });
    } finally {
      await destination.closeAsync();
    }
  } finally {
    await source.closeAsync();
  }
  databasePromise = undefined;
  const importedDatabase = await getDatabase();
  await importedDatabase.execAsync(THEATER_ISOLATED_RESET_TECHNICAL_STATE_SQL);
}

export async function clearTheaterDatabase() {
  const database = await getDatabase();
  if (await hasTheaterStorySchema(database)) {
    await database.withExclusiveTransactionAsync(async (tx) => {
      await tx.execAsync(`DELETE FROM theater_anchors;
        UPDATE theater_branches SET active_checkpoint_id = NULL;
        DELETE FROM theater_checkpoints; DELETE FROM theater_branch_positions;
        DELETE FROM theater_branches; DELETE FROM theater_text_versions;
        DELETE FROM theater_messages; DELETE FROM theater_conversations; DELETE FROM theater_personas;`);
    });
    return;
  }
  await database.execAsync('DELETE FROM theater_messages; DELETE FROM theater_conversations; DELETE FROM theater_personas;');
}

export async function loadTheaterPersonas() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TheaterPersonaRow>('SELECT * FROM theater_personas ORDER BY updated_at DESC');
  return rows.map(fromPersonaRow);
}

export async function createTheaterPersona(draft: TheaterPersonaDraft) {
  const database = await getDatabase();
  const now = Date.now();
  const persona: TheaterPersona = {
    contextLimit: clampContextLimit(draft.contextLimit),
    createdAt: now,
    id: makeId('theater-persona'),
    name: draft.name.trim() || '临时小剧场',
    persona: draft.persona.trim(),
    temperature: clampTemperature(draft.temperature),
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO theater_personas (id, name, persona, temperature, context_limit, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    persona.id,
    persona.name,
    persona.persona,
    persona.temperature,
    persona.contextLimit,
    persona.createdAt,
    persona.updatedAt,
  );
  return persona;
}

export async function updateTheaterPersona(id: string, draft: Partial<TheaterPersonaDraft>) {
  const existing = (await loadTheaterPersonas()).find((persona) => persona.id === id);
  if (!existing) return null;
  const database = await getDatabase();
  const now = Date.now();
  const next: TheaterPersona = {
    ...existing,
    contextLimit: clampContextLimit(draft.contextLimit ?? existing.contextLimit),
    name: draft.name?.trim() || existing.name,
    persona: draft.persona?.trim() ?? existing.persona,
    temperature: clampTemperature(draft.temperature ?? existing.temperature),
    updatedAt: now,
  };
  await database.runAsync(
    `UPDATE theater_personas
       SET name = ?, persona = ?, temperature = ?, context_limit = ?, updated_at = ?
     WHERE id = ?`,
    next.name,
    next.persona,
    next.temperature,
    next.contextLimit,
    next.updatedAt,
    next.id,
  );
  return next;
}

export async function deleteTheaterPersona(id: string) {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM theater_personas WHERE id = ?', id);
}

export async function loadTheaterConversations() {
  const database = await getDatabase();
  const rows = await database.getAllAsync<TheaterConversationRow>(
    `SELECT c.*,
            (SELECT COUNT(1) FROM theater_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM theater_conversations c
      ORDER BY c.updated_at DESC`,
  );
  return rows.map(fromConversationRow);
}

export async function loadTheaterConversation(id: string) {
  const database = await getDatabase();
  const row = await database.getFirstAsync<TheaterConversationRow>(
    `SELECT c.*,
            (SELECT COUNT(1) FROM theater_messages m WHERE m.conversation_id = c.id) AS message_count
       FROM theater_conversations c
      WHERE c.id = ?`,
    id,
  );
  return row ? fromConversationRow(row) : null;
}

export async function createTheaterConversation(draft: TheaterConversationDraft = {}) {
  const database = await getDatabase();
  const now = Date.now();
  const conversation: TheaterConversation = {
    createdAt: now,
    id: makeId('theater-conv'),
    lastSummarizedMessageCount: 0,
    messageCount: 0,
    personaId: draft.persona?.id ?? null,
    personaSnapshot: draft.persona?.persona ?? '',
    storyState: '',
    summaryInterval: normalizeSummaryInterval(draft.summaryInterval),
    title: draft.title?.trim() || '新剧场',
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO theater_conversations
      (id, title, persona_id, persona_snapshot, story_state, summary_interval, last_summarized_message_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    conversation.id,
    conversation.title,
    conversation.personaId,
    conversation.personaSnapshot,
    conversation.storyState,
    conversation.summaryInterval,
    conversation.lastSummarizedMessageCount,
    conversation.createdAt,
    conversation.updatedAt,
  );
  return conversation;
}

export async function updateTheaterConversation(id: string, patch: {
  lastSummarizedMessageCount?: number;
  persona?: TheaterPersona | null;
  storyState?: string;
  summaryInterval?: number | null;
  title?: string;
}) {
  const existing = await loadTheaterConversation(id);
  if (!existing) return null;
  const database = await getDatabase();
  const now = Date.now();
  const hasPersona = Object.prototype.hasOwnProperty.call(patch, 'persona');
  const next: TheaterConversation = {
    ...existing,
    lastSummarizedMessageCount: typeof patch.lastSummarizedMessageCount === 'number'
      ? Math.max(0, Math.round(patch.lastSummarizedMessageCount))
      : existing.lastSummarizedMessageCount,
    personaId: hasPersona ? patch.persona?.id ?? null : existing.personaId,
    personaSnapshot: hasPersona ? patch.persona?.persona ?? existing.personaSnapshot : existing.personaSnapshot,
    storyState: patch.storyState?.trim() ?? existing.storyState,
    summaryInterval: Object.prototype.hasOwnProperty.call(patch, 'summaryInterval')
      ? normalizeSummaryInterval(patch.summaryInterval)
      : existing.summaryInterval,
    title: patch.title?.trim() || existing.title,
    updatedAt: now,
  };
  await database.runAsync(
    `UPDATE theater_conversations
       SET title = ?, persona_id = ?, persona_snapshot = ?, story_state = ?, summary_interval = ?, last_summarized_message_count = ?, updated_at = ?
     WHERE id = ?`,
    next.title,
    next.personaId,
    next.personaSnapshot,
    next.storyState,
    next.summaryInterval,
    next.lastSummarizedMessageCount,
    next.updatedAt,
    next.id,
  );
  return next;
}

export async function deleteTheaterConversation(id: string) {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM theater_conversations WHERE id = ?', id);
}

export async function loadTheaterMessages(conversationId: string, limit?: number) {
  const database = await getDatabase();
  const rows = typeof limit === 'number'
    ? await database.getAllAsync<TheaterMessageRow>(
      `SELECT * FROM (
         SELECT * FROM theater_messages
          WHERE conversation_id = ?
          ORDER BY created_at DESC
          LIMIT ?
       ) ORDER BY created_at ASC`,
      conversationId,
      Math.max(1, Math.round(limit)),
    )
    : await database.getAllAsync<TheaterMessageRow>(
      'SELECT * FROM theater_messages WHERE conversation_id = ? ORDER BY created_at ASC',
      conversationId,
    );
  return rows.map(fromMessageRow);
}

export async function appendTheaterMessage(input: {
  content: string;
  conversationId: string;
  role: TheaterMessageRole;
}) {
  const database = await getDatabase();
  const now = Date.now();
  const message: TheaterMessage = {
    content: input.content.trim(),
    conversationId: input.conversationId,
    createdAt: now,
    id: makeId('theater-msg'),
    role: input.role,
    updatedAt: now,
  };
  await database.runAsync(
    `INSERT INTO theater_messages (id, conversation_id, role, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    message.id,
    message.conversationId,
    message.role,
    message.content,
    message.createdAt,
    message.updatedAt,
  );
  await database.runAsync('UPDATE theater_conversations SET updated_at = ? WHERE id = ?', now, input.conversationId);
  return message;
}

export async function updateTheaterMessage(id: string, content: string) {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync('UPDATE theater_messages SET content = ?, updated_at = ? WHERE id = ?', content.trim(), now, id);
}

export async function deleteTheaterMessage(id: string) {
  const database = await getDatabase();
  await database.runAsync('DELETE FROM theater_messages WHERE id = ?', id);
}

export async function clearTheaterConversation(id: string) {
  const database = await getDatabase();
  const now = Date.now();
  await database.runAsync('DELETE FROM theater_messages WHERE conversation_id = ?', id);
  await database.runAsync(
    'UPDATE theater_conversations SET story_state = \'\', last_summarized_message_count = 0, updated_at = ? WHERE id = ?',
    now,
    id,
  );
}
