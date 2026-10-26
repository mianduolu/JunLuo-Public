import type { SQLiteDatabase } from 'expo-sqlite';
import { assertTheaterStoryRecord, type TheaterStoryRecordKind } from '../sync/syncTheaterStoryRecord';
import { THEATER_STORY_RECORD_SELECT_SQL } from '../sync/syncTheaterStorySql';

type Row = { kind: TheaterStoryRecordKind; entity_id: string; record_json: string };
type Adoption = { positionId: string; versionId: string };

// A schema marker proves only installation, never the integrity of restored records.
export async function validateTheaterStoryDatabase(database: Pick<SQLiteDatabase, 'getAllAsync' | 'getFirstAsync'>) {
  const marker = await database.getFirstAsync<{ version: number }>('SELECT version FROM theater_story_schema');
  if (marker?.version !== 2) throw new Error('theater-story-unsupported-schema');
  const records = new Map<string, Record<string, unknown>>();
  for (const statement of THEATER_STORY_RECORD_SELECT_SQL) {
    for (const row of await database.getAllAsync<Row>(statement)) {
      const record = JSON.parse(row.record_json) as Record<string, unknown>;
      assertTheaterStoryRecord(row.kind, row.entity_id, record);
      records.set(row.entity_id, record);
    }
  }
  if ((await database.getAllAsync('PRAGMA foreign_key_check')).length) throw new Error('theater-story-invalid-reference');
  // Also check upgraded tables without the new composite FK, and restored files opened with FK enforcement off.
  const selections = await database.getAllAsync<{
    id: string; conversation_id: string; active_checkpoint_id: string | null; stale_checkpoint_id: string | null;
  }>('SELECT id, conversation_id, active_checkpoint_id, stale_checkpoint_id FROM theater_branches');
  for (const selection of selections) {
    if (selection.active_checkpoint_id !== null && selection.stale_checkpoint_id !== null) {
      throw new Error('theater-story-conflicting-checkpoint-selection');
    }
    if (selection.stale_checkpoint_id === null) continue;
    const node = records.get(`checkpoint:${selection.stale_checkpoint_id}`);
    if (!node || node.conversationId !== selection.conversation_id || node.branchId !== selection.id
      || node.status !== 'saved' || !String(node.content ?? '').trim() || !(node.basis as Adoption[]).length) {
      throw new Error('theater-story-invalid-stale-checkpoint');
    }
  }
  const subjects = new Map<string, { kind: unknown; subject: unknown }>();
  for (const [entityId, record] of records) {
    if (entityId.startsWith('text-version:')) {
      const key = JSON.stringify([record.conversationId, record.positionId]);
      const previous = subjects.get(key);
      if (previous && (previous.kind !== record.kind || previous.subject !== record.subject)) {
        throw new Error('theater-story-position-subject-mismatch');
      }
      subjects.set(key, { kind: record.kind, subject: record.subject });
    }
    if (!entityId.startsWith('checkpoint:')) continue;
    const branch = records.get(`branch:${record.branchId}`);
    if (!branch || branch.conversationId !== record.conversationId) throw new Error('theater-story-invalid-reference');
    const basis = record.basis as Adoption[];
    for (const item of basis) {
      const version = records.get(`text-version:${item.versionId}`);
      if (!version || version.conversationId !== record.conversationId || version.positionId !== item.positionId) {
        throw new Error('theater-story-invalid-checkpoint-basis');
      }
    }
    if (record.active) {
      const adopted = (branch.adoptions as Adoption[]).filter((item) => records.get(`text-version:${item.versionId}`)?.kind === 'dialogue');
      if (basis.some((item, index) => item.positionId !== adopted[index]?.positionId || item.versionId !== adopted[index]?.versionId)) {
        throw new Error('theater-story-invalid-checkpoint-basis');
      }
    }
  }
}
