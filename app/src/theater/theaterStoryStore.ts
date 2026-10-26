import type { SQLiteDatabase } from 'expo-sqlite';
import {
  readTheaterSummaryInterval,
  type TheaterAdoption, type TheaterAnchor, type TheaterBranch,
  type TheaterCheckpoint, type TheaterStory, type TheaterTextVersion,
} from './theaterStoryTypes';

export type TheaterStorySql = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'getFirstAsync'>;
export type TheaterStoryDatabase = TheaterStorySql & Pick<SQLiteDatabase, 'withExclusiveTransactionAsync'>;

// The caller supplies the database; importing this module never opens/migrates a live store.
export async function writeTheaterStoryTransaction<T>(
  database: TheaterStoryDatabase,
  work: (transaction: TheaterStorySql) => Promise<T>,
): Promise<T> {
  let result!: T;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    result = await work(transaction);
    // Expo's exclusive transaction uses another connection. Check references even if
    // foreign_keys was enabled only on the original connection. No deletion API here.
    const violations = await transaction.getAllAsync('PRAGMA foreign_key_check');
    if (violations.length) throw new Error('theater-story-invalid-reference');
  });
  return result;
}

type StoryRow = {
  id: string; title: string; settings_json: string; summary_interval?: number | null;
  is_draft: number; is_pinned: number; created_at: number; updated_at: number;
};

export async function loadTheaterStories(database: TheaterStorySql): Promise<TheaterStory[]> {
  const rows = await database.getAllAsync<StoryRow>(
    'SELECT * FROM theater_conversations ORDER BY updated_at DESC, id ASC',
  );
  return rows.map((row) => ({
    id: row.id, title: row.title, settings: JSON.parse(row.settings_json),
    summaryInterval: readTheaterSummaryInterval(row.summary_interval), isDraft: row.is_draft === 1,
    isPinned: row.is_pinned === 1, createdAt: row.created_at, updatedAt: row.updated_at,
  }));
}

export async function saveTheaterStory(database: TheaterStoryDatabase, story: TheaterStory) {
  await writeTheaterStoryTransaction(database, async (tx) => {
    await tx.runAsync(`INSERT INTO theater_conversations
      (id, title, settings_json, summary_interval, is_draft, is_pinned, legacy_sync_open, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title = excluded.title, settings_json = excluded.settings_json,
        summary_interval = excluded.summary_interval, is_draft = excluded.is_draft,
        is_pinned = COALESCE(?, theater_conversations.is_pinned), legacy_sync_open = 0,
        updated_at = excluded.updated_at`,
    story.id, story.title, JSON.stringify(story.settings), story.summaryInterval,
    Number(story.isDraft), Number(story.isPinned ?? false), story.createdAt, story.updatedAt,
    story.isPinned === undefined ? null : Number(story.isPinned));
  });
}

export async function loadTheaterBranches(database: TheaterStorySql, conversationId: string) {
  return database.getAllAsync<TheaterBranch>(`SELECT id, conversation_id AS conversationId,
    name, active_checkpoint_id AS activeCheckpointId, stale_checkpoint_id AS staleCheckpointId,
    fork_boundary AS forkBoundary, created_at AS createdAt, updated_at AS updatedAt
    FROM theater_branches WHERE conversation_id = ? ORDER BY created_at, id`, conversationId);
}

export async function insertTheaterBranch(
  database: TheaterStoryDatabase,
  branch: Omit<TheaterBranch, 'activeCheckpointId'>,
  adoptions: TheaterAdoption[] = [],
) {
  await writeTheaterStoryTransaction(database, async (tx) => {
    await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0 WHERE id = ?', branch.conversationId);
    await tx.runAsync(`INSERT INTO theater_branches
      (id, conversation_id, name, fork_boundary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    branch.id, branch.conversationId, branch.name, branch.forkBoundary ?? null, branch.createdAt, branch.updatedAt);
    for (const [ordinal, adoption] of adoptions.entries()) {
      await tx.runAsync(`INSERT INTO theater_branch_positions
        (conversation_id, branch_id, ordinal, position_id, version_id) VALUES (?, ?, ?, ?, ?)`,
      branch.conversationId, branch.id, ordinal, adoption.positionId, adoption.versionId);
    }
  });
}

export async function insertTheaterTextVersion(database: TheaterStoryDatabase, version: TheaterTextVersion) {
  // Immutable: callers must create a new id for an edit or regeneration.
  await writeTheaterStoryTransaction(database, async (tx) => {
    await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0 WHERE id = ?', version.conversationId);
    const existing = await tx.getFirstAsync<{ kind: string; subject: string | null }>(
      'SELECT kind, subject FROM theater_text_versions WHERE conversation_id = ? AND position_id = ? LIMIT 1',
      version.conversationId, version.positionId,
    );
    if (existing && (existing.kind !== version.kind || existing.subject !== version.subject)) {
      throw new Error('theater-story-position-subject-mismatch');
    }
    await tx.runAsync(`INSERT INTO theater_text_versions
      (id, conversation_id, position_id, kind, subject, content, origin, created_at, updated_at, co_creation_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    version.id, version.conversationId, version.positionId, version.kind, version.subject,
    version.content, version.origin, version.createdAt, version.updatedAt,
    version.coCreation ? JSON.stringify(version.coCreation) : null);
  });
}

export async function loadTheaterTextVersions(database: TheaterStorySql, conversationId: string) {
  const rows = await database.getAllAsync<TheaterTextVersion & { coCreationJson: string | null }>(`SELECT id, conversation_id AS conversationId,
    position_id AS positionId, kind, subject, content, origin, created_at AS createdAt, updated_at AS updatedAt,
    co_creation_json AS coCreationJson
    FROM theater_text_versions WHERE conversation_id = ? ORDER BY created_at, id`, conversationId);
  return rows.map(({ coCreationJson, ...row }) => ({ ...row,
    ...(coCreationJson ? { coCreation: JSON.parse(coCreationJson) as NonNullable<TheaterTextVersion['coCreation']> } : {}) }));
}

export async function loadTheaterAdoptions(database: TheaterStorySql, branchId: string) {
  return database.getAllAsync<TheaterAdoption>(`SELECT position_id AS positionId, version_id AS versionId
    FROM theater_branch_positions WHERE branch_id = ? ORDER BY ordinal`, branchId);
}

// Chapter 2 only stores nodes. Activation, staleness, editing and inheritance are chapter 8.
export async function insertTheaterCheckpoint(database: TheaterStoryDatabase, node: TheaterCheckpoint) {
  await writeTheaterStoryTransaction(database, async (tx) => {
    await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0 WHERE id = ?', node.conversationId);
    if (node.status === 'legacy-unverified' && (node.coveredPositionId !== null || node.basis.length)) {
      throw new Error('theater-story-unverified-checkpoint-basis');
    }
    if ((node.basis.at(-1)?.positionId ?? null) !== node.coveredPositionId
      || new Set(node.basis.map((entry) => entry.positionId)).size !== node.basis.length) {
      throw new Error('theater-story-invalid-checkpoint-basis');
    }
    for (const entry of node.basis) {
      const version = await tx.getFirstAsync(`SELECT id FROM theater_text_versions
        WHERE id = ? AND conversation_id = ? AND position_id = ?`,
      entry.versionId, node.conversationId, entry.positionId);
      if (!version) throw new Error('theater-story-invalid-checkpoint-basis');
    }
    await tx.runAsync(`INSERT INTO theater_checkpoints
      (id, conversation_id, branch_id, content, covered_position_id, basis_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    node.id, node.conversationId, node.branchId, node.content, node.coveredPositionId,
    JSON.stringify(node.basis), node.status, node.createdAt, node.updatedAt);
  });
}

export async function loadTheaterCheckpoints(database: TheaterStorySql, branchId: string): Promise<TheaterCheckpoint[]> {
  const rows = await database.getAllAsync<Omit<TheaterCheckpoint, 'basis'> & { basisJson: string }>(
    `SELECT id, conversation_id AS conversationId, branch_id AS branchId, content,
      covered_position_id AS coveredPositionId, basis_json AS basisJson, status,
      created_at AS createdAt, updated_at AS updatedAt
      FROM theater_checkpoints WHERE branch_id = ? ORDER BY created_at, id`, branchId,
  );
  return rows.map(({ basisJson, ...row }) => ({ ...row, basis: JSON.parse(basisJson) }));
}

export async function insertTheaterAnchor(database: TheaterStoryDatabase, anchor: TheaterAnchor) {
  await writeTheaterStoryTransaction(database, async (tx) => {
    await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0 WHERE id = ?', anchor.conversationId);
    await tx.runAsync(`INSERT INTO theater_anchors
      (id, conversation_id, branch_id, position_id, source_version_id, source, content, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    anchor.id, anchor.conversationId, anchor.branchId, anchor.positionId, anchor.sourceVersionId,
    anchor.source, anchor.content, Number(anchor.confirmed), anchor.createdAt, anchor.updatedAt);
  });
}

export async function loadTheaterAnchors(database: TheaterStorySql, branchId: string): Promise<TheaterAnchor[]> {
  const rows = await database.getAllAsync<Omit<TheaterAnchor, 'confirmed'> & { confirmed: number }>(
    `SELECT id, conversation_id AS conversationId, branch_id AS branchId, position_id AS positionId,
      source_version_id AS sourceVersionId, source, content, confirmed, created_at AS createdAt, updated_at AS updatedAt
      FROM theater_anchors WHERE branch_id = ? ORDER BY created_at, id`, branchId,
  );
  return rows.map((row) => ({ ...row, confirmed: row.confirmed === 1 }));
}
