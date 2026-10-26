import type { SQLiteDatabase, SQLiteBindValue } from 'expo-sqlite';
import { legacyTheaterBranchId, legacyTheaterPositionId, legacyTheaterVersionId, legacyTheaterDraftId } from '../theater/theaterStoryMigration';
import { emptyTheaterStorySettings } from '../theater/theaterStoryTypes';
import { validateTheaterStoryDatabase } from '../theater/theaterStoryValidation';
import { assertTheaterStoryRecord, type TheaterStoryRecordKind } from './syncTheaterStoryRecord';

export type StoryTransaction = Pick<SQLiteDatabase, 'getFirstAsync' | 'getAllAsync' | 'runAsync' | 'execAsync'>;
type RecordValue = Record<string, any>;
const tables: Record<TheaterStoryRecordKind, string> = {
  story: 'theater_conversations', 'text-version': 'theater_text_versions', branch: 'theater_branches',
  checkpoint: 'theater_checkpoints', anchor: 'theater_anchors',
};

export async function hasTheaterStorySchema(tx: Pick<SQLiteDatabase, 'getFirstAsync'>) {
  if (!await tx.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'theater_story_schema'")) return false;
  const marker = await tx.getFirstAsync<{ version: number }>('SELECT version FROM theater_story_schema');
  if (marker?.version !== 2) throw new Error('theater-story-unsupported-schema');
  return true;
}

async function upsert(tx: StoryTransaction, table: string, values: Record<string, SQLiteBindValue>) {
  const columns = Object.keys(values);
  await tx.runAsync(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})
    ON CONFLICT(id) DO UPDATE SET ${columns.filter((key) => key !== 'id').map((key) => `${key} = excluded.${key}`).join(', ')}`,
  ...Object.values(values));
}

export async function applyTheaterStoryRecord(tx: StoryTransaction, kind: TheaterStoryRecordKind, entityId: string, row: RecordValue) {
  assertTheaterStoryRecord(kind, entityId, row);
  if (!await hasTheaterStorySchema(tx)) throw new Error('theater-story-unsupported-schema');
  const owner = kind === 'story' ? row.id : row.conversationId;
  if (kind !== 'story' && !await tx.getFirstAsync('SELECT id FROM theater_conversations WHERE id = ?', owner)) {
    throw new Error('theater-story-invalid-reference');
  }
  const common = { id: row.id, created_at: row.createdAt, updated_at: row.updatedAt };
  const existing = await tx.getFirstAsync<RecordValue>(`SELECT * FROM ${tables[kind]} WHERE id = ?`, row.id);
  if (existing && kind !== 'story' && existing.conversation_id !== owner) throw new Error('theater-story-invalid-reference');
  if (kind === 'story') {
    await upsert(tx, tables[kind], { ...common, title: row.title, settings_json: JSON.stringify(row.settings),
      summary_interval: row.summaryInterval, is_draft: Number(row.isDraft), is_pinned: Number(row.isPinned), legacy_sync_open: 0 });
  } else if (kind === 'text-version') {
    const values = { ...common, conversation_id: owner, position_id: row.positionId, kind: row.kind,
      subject: row.subject, content: row.content, origin: row.origin,
      // Older payloads must never erase an already-saved completion source.
      co_creation_json: row.coCreation == null ? existing?.co_creation_json ?? null : JSON.stringify(row.coCreation) };
    if (existing && Object.entries(values).some(([key, value]) => existing[key] !== value)) {
      throw new Error('theater-story-position-subject-mismatch');
    }
    if (!existing) await upsert(tx, tables[kind], values);
  } else if (kind === 'branch') {
    await upsert(tx, tables[kind], { ...common, conversation_id: owner, name: row.name,
      // Old payloads omit the field; an explicit null is a new payload's authoritative value.
      fork_boundary: row.forkBoundary === undefined ? existing?.fork_boundary ?? null : row.forkBoundary });
    const old = await tx.getAllAsync<{ position_id: string; ordinal: number }>('SELECT position_id, ordinal FROM theater_branch_positions WHERE branch_id = ?', row.id);
    const adopted = row.adoptions as { positionId: string; versionId: string }[];
    const keep = new Set(adopted.map((entry) => entry.positionId));
    for (const item of old) {
      if (!keep.has(item.position_id)) await tx.runAsync('DELETE FROM theater_branch_positions WHERE branch_id = ? AND position_id = ?', row.id, item.position_id);
    }
    const offset = Math.max(0, ...old.map((entry) => entry.ordinal)) + adopted.length + 1;
    await tx.runAsync('UPDATE theater_branch_positions SET ordinal = ordinal + ? WHERE branch_id = ?', offset, row.id);
    for (const [ordinal, item] of adopted.entries()) {
      await tx.runAsync(`INSERT INTO theater_branch_positions (conversation_id, branch_id, ordinal, position_id, version_id)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(branch_id, position_id) DO UPDATE SET ordinal = excluded.ordinal, version_id = excluded.version_id`,
      owner, row.id, ordinal, item.positionId, item.versionId);
    }
  } else if (kind === 'checkpoint') {
    if (existing && existing.branch_id !== row.branchId) throw new Error('theater-story-invalid-reference');
    await upsert(tx, tables[kind], { ...common, conversation_id: owner, branch_id: row.branchId,
      content: row.content, covered_position_id: row.coveredPositionId, basis_json: JSON.stringify(row.basis), status: row.status });
    const selected = await tx.getFirstAsync<{ active_checkpoint_id: string | null; stale_checkpoint_id: string | null }>(
      'SELECT active_checkpoint_id, stale_checkpoint_id FROM theater_branches WHERE id = ?', row.branchId);
    const needsReview = row.needsReview === undefined ? selected?.stale_checkpoint_id === row.id : row.needsReview;
    if (row.active) {
      if ((selected?.active_checkpoint_id && selected.active_checkpoint_id !== row.id)
        || selected?.stale_checkpoint_id) {
        throw new Error('theater-story-active-checkpoint-conflict');
      }
      await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = ? WHERE id = ? AND conversation_id = ?', row.id, row.branchId, owner);
    } else {
      await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = NULL WHERE id = ? AND active_checkpoint_id = ?', row.branchId, row.id);
    }
    if (needsReview) {
      // Same-node active -> review is one selection transition; other selected nodes conflict.
      if ((selected?.active_checkpoint_id && selected.active_checkpoint_id !== row.id)
        || (selected?.stale_checkpoint_id && selected.stale_checkpoint_id !== row.id)) {
        throw new Error('theater-story-review-checkpoint-conflict');
      }
      await tx.runAsync('UPDATE theater_branches SET stale_checkpoint_id = ? WHERE id = ? AND conversation_id = ?', row.id, row.branchId, owner);
    } else if (row.needsReview !== undefined) {
      await tx.runAsync('UPDATE theater_branches SET stale_checkpoint_id = NULL WHERE id = ? AND stale_checkpoint_id = ?', row.branchId, row.id);
    }
  } else {
    if (existing && existing.branch_id !== row.branchId) throw new Error('theater-story-invalid-reference');
    await upsert(tx, tables[kind], { ...common, conversation_id: owner, branch_id: row.branchId,
      position_id: row.positionId, source_version_id: row.sourceVersionId, source: row.source,
      content: row.content, confirmed: Number(row.confirmed) });
  }
  await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0 WHERE id = ?', owner);
  await validateTheaterStoryDatabase(tx);
}

export async function deleteTheaterStoryRecord(tx: StoryTransaction, kind: TheaterStoryRecordKind, id: string) {
  if (!await hasTheaterStorySchema(tx)) throw new Error('theater-story-unsupported-schema');
  const existing = await tx.getFirstAsync<{ conversation_id: string }>(`SELECT * FROM ${tables[kind]} WHERE id = ?`, id);
  if (existing) await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0 WHERE id = ?', kind === 'story' ? id : existing.conversation_id);
  if (kind === 'text-version') {
    const basisRef = await tx.getFirstAsync(`SELECT c.id FROM theater_checkpoints c, json_each(c.basis_json) b
      WHERE json_extract(b.value, '$.versionId') = ? LIMIT 1`, id);
    if (basisRef) throw new Error('theater-story-invalid-reference');
  }
  if (kind === 'branch') {
    const refs = await tx.getFirstAsync(`SELECT id FROM theater_checkpoints WHERE branch_id = ?
      UNION ALL SELECT id FROM theater_anchors WHERE branch_id = ? LIMIT 1`, id, id);
    if (refs) throw new Error('theater-story-invalid-reference');
    await tx.runAsync('DELETE FROM theater_branch_positions WHERE branch_id = ?', id);
  }
  if (kind === 'story') {
    const refs = await tx.getFirstAsync(`SELECT id FROM theater_branches WHERE conversation_id = ?
      UNION ALL SELECT id FROM theater_text_versions WHERE conversation_id = ? LIMIT 1`, id, id);
    if (refs) throw new Error('theater-story-invalid-reference');
    await tx.runAsync('DELETE FROM theater_messages WHERE conversation_id = ?', id);
  }
  if (kind === 'checkpoint') {
    await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = NULL WHERE active_checkpoint_id = ?', id);
    await tx.runAsync('UPDATE theater_branches SET stale_checkpoint_id = NULL WHERE stale_checkpoint_id = ?', id);
  }
  await tx.runAsync(`DELETE FROM ${tables[kind]} WHERE id = ?`, id);
  await validateTheaterStoryDatabase(tx);
}

export async function assertLegacyTheaterWriteAllowed(tx: StoryTransaction, kind: string, id: string, row?: RecordValue) {
  if (!await hasTheaterStorySchema(tx)) return;
  const owner = kind === 'persona' ? legacyTheaterDraftId(id) : kind === 'conversation' ? id : row?.conversationId
    ?? (await tx.getFirstAsync<{ conversation_id: string }>('SELECT conversation_id FROM theater_messages WHERE id = ?', id))?.conversation_id;
  if (!owner) return;
  if (await tx.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'theater_sync_entity_heads'")) {
    const localHead = await tx.getFirstAsync("SELECT revision_id FROM theater_sync_entity_heads WHERE entity_type = 'theater-record' AND entity_id = ? LIMIT 1", `story:${owner}`);
    if (localHead) throw new Error('theater-story-unsupported-schema');
  }
  if (kind === 'persona') return;
  const story = await tx.getFirstAsync<{ settings_json: string | null; legacy_sync_open: number }>(
    'SELECT settings_json, legacy_sync_open FROM theater_conversations WHERE id = ?', owner);
  if (story?.settings_json && !story.legacy_sync_open) throw new Error('theater-story-unsupported-schema');
  if (kind !== 'conversation') {
    const previous = await tx.getFirstAsync<{ conversation_id: string }>('SELECT conversation_id FROM theater_messages WHERE id = ?', id);
    if (previous && previous.conversation_id !== owner) throw new Error('theater-story-invalid-reference');
  }
}

export async function projectReceivedLegacyDraft(tx: StoryTransaction, personaId: string | null | undefined) {
  if (!personaId || !await hasTheaterStorySchema(tx)) return;
  const id = legacyTheaterDraftId(personaId);
  const existing = await tx.getFirstAsync<RecordValue>('SELECT * FROM theater_conversations WHERE id = ?', id);
  if (existing && !existing.legacy_sync_open) return;
  const persona = await tx.getFirstAsync<RecordValue>('SELECT * FROM theater_personas WHERE id = ?', personaId);
  const used = await tx.getFirstAsync('SELECT id FROM theater_conversations WHERE persona_id = ? LIMIT 1', personaId);
  if (!persona || used) {
    if (existing) await tx.runAsync('DELETE FROM theater_conversations WHERE id = ? AND legacy_sync_open = 1', id);
    return;
  }
  const settings = { ...emptyTheaterStorySettings(), legacyPersona: persona.persona,
    temperature: persona.temperature, contextLimit: persona.context_limit };
  await upsert(tx, 'theater_conversations', { id, title: persona.name, settings_json: JSON.stringify(settings),
    summary_interval: 20, is_draft: 1, is_pinned: 0, legacy_sync_open: 1,
    created_at: persona.created_at, updated_at: persona.updated_at });
  await validateTheaterStoryDatabase(tx);
}

// A legacy stream is projected only until a v2/local edit takes ownership. Preserve all
// original rows so late legacy messages can fill the first branch without fake timestamps.
export async function projectReceivedLegacyStory(tx: StoryTransaction, conversationId: string) {
  if (!await hasTheaterStorySchema(tx)) return;
  const story = await tx.getFirstAsync<RecordValue>('SELECT * FROM theater_conversations WHERE id = ?', conversationId);
  if (!story || (story.settings_json && !story.legacy_sync_open)) return;
  const persona = story.persona_id ? await tx.getFirstAsync<RecordValue>('SELECT * FROM theater_personas WHERE id = ?', story.persona_id) : null;
  const settings = { ...emptyTheaterStorySettings(), legacyPersona: story.persona_snapshot || persona?.persona || '',
    temperature: persona?.temperature ?? 0.8, contextLimit: persona?.context_limit ?? 20 };
  await tx.runAsync('UPDATE theater_conversations SET settings_json = ?, legacy_sync_open = 1 WHERE id = ?', JSON.stringify(settings), conversationId);
  const branchId = legacyTheaterBranchId(conversationId);
  await tx.runAsync(`INSERT OR IGNORE INTO theater_branches (id, conversation_id, name, created_at, updated_at)
    VALUES (?, ?, '最初走向', ?, ?)`, branchId, conversationId, story.created_at, story.updated_at);
  await tx.runAsync('DELETE FROM theater_branch_positions WHERE branch_id = ?', branchId);
  await tx.runAsync('DELETE FROM theater_text_versions WHERE conversation_id = ?', conversationId);
  const messages = await tx.getAllAsync<RecordValue>('SELECT * FROM theater_messages WHERE conversation_id = ? ORDER BY created_at, rowid', conversationId);
  for (const [ordinal, message] of messages.entries()) {
    await tx.runAsync(`INSERT INTO theater_text_versions
      (id, conversation_id, position_id, kind, subject, content, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'legacy', ?, ?)`,
    legacyTheaterVersionId(message.id), conversationId, legacyTheaterPositionId(message.id),
    message.role === 'system' ? 'legacy-context-note' : 'dialogue', message.role === 'system' ? null : message.role,
    message.content, message.created_at, message.updated_at);
    await tx.runAsync(`INSERT INTO theater_branch_positions (conversation_id, branch_id, ordinal, position_id, version_id) VALUES (?, ?, ?, ?, ?)`,
      conversationId, branchId, ordinal, legacyTheaterPositionId(message.id), legacyTheaterVersionId(message.id));
  }
  if (story.story_state) await upsert(tx, 'theater_checkpoints', {
    id: `legacy-checkpoint:${conversationId}`, conversation_id: conversationId, branch_id: branchId,
    content: story.story_state, covered_position_id: null, basis_json: '[]', status: 'legacy-unverified',
    created_at: story.created_at, updated_at: story.updated_at,
  });
  else await tx.runAsync('DELETE FROM theater_checkpoints WHERE id = ?', `legacy-checkpoint:${conversationId}`);
  await validateTheaterStoryDatabase(tx);
}
