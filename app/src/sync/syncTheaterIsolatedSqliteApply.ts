import type * as SQLite from 'expo-sqlite';
import { isTheaterStoryRecordKind } from './syncTheaterStoryRecord';
import { applyTheaterStoryRecord, deleteTheaterStoryRecord, assertLegacyTheaterWriteAllowed, projectReceivedLegacyStory, projectReceivedLegacyDraft, hasTheaterStorySchema } from './syncTheaterStorySqlite';

import type {
  TheaterIsolatedBusinessPort,
} from './syncTheaterIsolatedApply';
import {
  assertTheaterIsolatedRecord,
  theaterIsolatedLocalId,
  type TheaterIsolatedRecordKind,
} from './syncTheaterIsolated';
import type { JsonValue } from './syncProtocol';

type TheaterRecord = JsonValue & Record<string, JsonValue>;
type SqlTransaction = Pick<
  SQLite.SQLiteDatabase,
  'getFirstAsync' | 'getAllAsync' | 'runAsync' | 'execAsync'
>;

async function writePersona(
  transaction: SqlTransaction,
  record: TheaterRecord,
) {
  await transaction.runAsync(
    `INSERT INTO theater_personas (
       id, name, persona, temperature, context_limit,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       persona = excluded.persona,
       temperature = excluded.temperature,
       context_limit = excluded.context_limit,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.name as string,
    record.persona as string,
    record.temperature as number,
    record.contextLimit as number,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeConversation(
  transaction: SqlTransaction,
  record: TheaterRecord,
) {
  await transaction.runAsync(
    `INSERT INTO theater_conversations (
       id, title, persona_id, persona_snapshot, story_state,
       summary_interval, last_summarized_message_count,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       persona_id = excluded.persona_id,
       persona_snapshot = excluded.persona_snapshot,
       story_state = excluded.story_state,
       summary_interval = excluded.summary_interval,
       last_summarized_message_count =
         excluded.last_summarized_message_count,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.title as string,
    record.personaId as string | null,
    record.personaSnapshot as string,
    record.storyState as string,
    record.summaryInterval as number | null,
    record.lastSummarizedMessageCount as number,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

async function writeMessage(
  transaction: SqlTransaction,
  kind: 'message' | 'legacy-context-note',
  record: TheaterRecord,
) {
  const role = kind === 'legacy-context-note'
    ? 'system'
    : record.role as 'I' | 'you';
  const existing = await transaction.getFirstAsync<{
    role: 'I' | 'you' | 'system';
  }>(
    'SELECT role FROM theater_messages WHERE id = ?',
    record.id as string,
  );
  if (existing && existing.role !== role) {
    throw new Error(
      'theater message identity 已绑定不同主体种类，拒绝静默改写。',
    );
  }
  await transaction.runAsync(
    `INSERT INTO theater_messages (
       id, conversation_id, role, content, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       content = excluded.content,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at`,
    record.id as string,
    record.conversationId as string,
    role,
    record.content as string,
    record.createdAt as number,
    record.updatedAt as number,
  );
}

export async function applyTheaterIsolatedRecordToSqlite(input: {
  transaction: SqlTransaction;
  kind: TheaterIsolatedRecordKind;
  entityId: string;
  record: TheaterRecord;
}) {
  assertTheaterIsolatedRecord(
    input.kind,
    input.entityId,
    input.record,
  );
  if (isTheaterStoryRecordKind(input.kind)) {
    await applyTheaterStoryRecord(input.transaction, input.kind, input.entityId, input.record);
    return;
  }
  await assertLegacyTheaterWriteAllowed(input.transaction, input.kind, input.record.id as string, input.record);
  if (input.kind === 'persona') {
    await writePersona(input.transaction, input.record);
    await projectReceivedLegacyDraft(input.transaction, input.record.id as string);
    if (await hasTheaterStorySchema(input.transaction)) {
      for (const story of await input.transaction.getAllAsync<{ id: string }>('SELECT id FROM theater_conversations WHERE persona_id = ? AND legacy_sync_open = 1', input.record.id as string)) {
        await projectReceivedLegacyStory(input.transaction, story.id);
      }
    }
    return;
  }
  if (input.kind === 'conversation') {
    const previous = await input.transaction.getFirstAsync<{ persona_id: string | null }>('SELECT persona_id FROM theater_conversations WHERE id = ?', input.record.id as string);
    await writeConversation(input.transaction, input.record);
    await projectReceivedLegacyStory(input.transaction, input.record.id as string);
    await projectReceivedLegacyDraft(input.transaction, (input.record as TheaterRecord).personaId as string | null);
    await projectReceivedLegacyDraft(input.transaction, previous?.persona_id);
    return;
  }
  await writeMessage(input.transaction, input.kind, input.record);
  await projectReceivedLegacyStory(input.transaction, (input.record as TheaterRecord).conversationId as string);
}

export async function deleteTheaterIsolatedRecordFromSqlite(input: {
  transaction: SqlTransaction;
  kind: TheaterIsolatedRecordKind;
  entityId: string;
}) {
  const localId = theaterIsolatedLocalId(
    input.kind,
    input.entityId,
  );
  if (isTheaterStoryRecordKind(input.kind)) {
    await deleteTheaterStoryRecord(input.transaction, input.kind, localId);
    return;
  }
  await assertLegacyTheaterWriteAllowed(input.transaction, input.kind, localId);
  if (input.kind === 'persona') {
    await input.transaction.runAsync(
      'DELETE FROM theater_personas WHERE id = ?',
      localId,
    );
    await projectReceivedLegacyDraft(input.transaction, localId);
    return;
  }
  if (input.kind === 'conversation') {
    const previous = await input.transaction.getFirstAsync<{ persona_id: string | null }>('SELECT persona_id FROM theater_conversations WHERE id = ?', localId);
    if (await hasTheaterStorySchema(input.transaction)) {
      await input.transaction.runAsync('DELETE FROM theater_checkpoints WHERE conversation_id = ?', localId);
      await input.transaction.runAsync('DELETE FROM theater_branch_positions WHERE conversation_id = ?', localId);
      await input.transaction.runAsync('DELETE FROM theater_branches WHERE conversation_id = ?', localId);
      await input.transaction.runAsync('DELETE FROM theater_text_versions WHERE conversation_id = ?', localId);
    }
    await input.transaction.runAsync('DELETE FROM theater_messages WHERE conversation_id = ?', localId);
    await input.transaction.runAsync(
      'DELETE FROM theater_conversations WHERE id = ?',
      localId,
    );
    await projectReceivedLegacyDraft(input.transaction, previous?.persona_id);
    return;
  }
  const oldMessage = await input.transaction.getFirstAsync<{ conversation_id: string }>('SELECT conversation_id FROM theater_messages WHERE id = ?', localId);
  await input.transaction.runAsync(
    input.kind === 'legacy-context-note'
      ? `DELETE FROM theater_messages
         WHERE id = ? AND role = 'system'`
      : `DELETE FROM theater_messages
         WHERE id = ? AND role IN ('I', 'you')`,
    localId,
  );
  if (oldMessage) await projectReceivedLegacyStory(input.transaction, oldMessage.conversation_id);
}

async function runSuppressed<T>(
  apply: (transaction: SQLite.SQLiteDatabase) => Promise<T>,
) {
  const { runWithTheaterIsolatedCaptureSuppressed } =
    await import('./syncTheaterIsolatedSqlitePort');
  return runWithTheaterIsolatedCaptureSuppressed(apply);
}

export const theaterIsolatedSqliteBusinessPort:
TheaterIsolatedBusinessPort = {
  upsertRecord: async (input) => {
    if (!isTheaterStoryRecordKind(input.kind)) {
      const owner = input.kind === 'persona' ? `legacy-draft:${input.record.id}`
        : input.kind === 'conversation' ? input.record.id : input.record.conversationId;
      const { hasTheaterStorySyncHistory } = await import('./syncMutationStateStore');
      if (await hasTheaterStorySyncHistory(owner as string)) throw new Error('theater-story-unsupported-schema');
    }
    await runSuppressed(async (transaction) => {
      await applyTheaterIsolatedRecordToSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
        record: input.record,
      });
    });
  },
  deleteRecord: async (input) => {
    await runSuppressed(async (transaction) => {
      await deleteTheaterIsolatedRecordFromSqlite({
        transaction,
        kind: input.kind,
        entityId: input.entityId,
      });
    });
  },
};
