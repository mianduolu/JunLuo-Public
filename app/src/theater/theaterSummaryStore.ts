import {
  loadTheaterAdoptions, loadTheaterBranches, loadTheaterCheckpoints, loadTheaterStories,
  loadTheaterTextVersions, writeTheaterStoryTransaction,
  type TheaterStoryDatabase, type TheaterStorySql,
} from './theaterStoryStore';
import {
  TheaterGenerationBasisError, TheaterGenerationCancelledError, loadTheaterGenerationAnchors,
  type TheaterBinding, type TheaterGenerationSnapshot,
} from './theaterGenerationStore';
import type { TheaterCheckpoint } from './theaterStoryTypes';

export type TheaterSummarySnapshot = TheaterGenerationSnapshot & { checkpoints: TheaterCheckpoint[] };

// Return the zero-based adopted position, not the dialogue count. Legacy notes do not form summary evidence.
export function theaterCheckpointCoverage(snapshot: TheaterGenerationSnapshot, checkpoint: TheaterCheckpoint): number | null {
  if (checkpoint.status !== 'saved' || !checkpoint.content.trim() || checkpoint.branchId !== snapshot.branch.id
    || checkpoint.conversationId !== snapshot.story.id || !checkpoint.basis.length
    || checkpoint.coveredPositionId !== checkpoint.basis.at(-1)?.positionId) return null;
  const dialogue = snapshot.adoptions.filter((_entry, index) => snapshot.versions[index]?.kind === 'dialogue');
  if (checkpoint.basis.some((entry, index) => entry.positionId !== dialogue[index]?.positionId
    || entry.versionId !== dialogue[index]?.versionId)) return null;
  const index = snapshot.adoptions.findIndex((entry) => entry.positionId === checkpoint.coveredPositionId);
  return index < 0 ? null : index;
}

export function theaterSummaryStatus(snapshot: TheaterSummarySnapshot): {
  checkpoint: TheaterCheckpoint | null; invalid: boolean; uncovered: number; reminder: boolean;
} {
  const staleId = snapshot.branch.staleCheckpointId ?? null;
  const checkpoint = snapshot.checkpoints.find((node) => node.id === (snapshot.branch.activeCheckpointId ?? staleId)) ?? null;
  const coverage = checkpoint && !staleId ? theaterCheckpointCoverage(snapshot, checkpoint) : null;
  const invalid = staleId !== null || (snapshot.branch.activeCheckpointId !== null && coverage === null);
  const uncovered = snapshot.versions.filter((version, index) => version.kind === 'dialogue' && index > (coverage ?? -1)).length;
  const interval = snapshot.story.summaryInterval;
  return { checkpoint, invalid, uncovered, reminder: !invalid && interval !== null && interval > 0 && uncovered >= interval };
}

const basisError = (): never => { throw new TheaterGenerationBasisError(); };

async function read(tx: TheaterStorySql, binding: TheaterBinding): Promise<TheaterSummarySnapshot> {
  const story = (await loadTheaterStories(tx)).find((entry) => entry.id === binding.storyId) ?? basisError();
  const branch = (await loadTheaterBranches(tx, story.id)).find((entry) => entry.id === binding.branchId) ?? basisError();
  const adoptions = (await loadTheaterAdoptions(tx, branch.id)).map((entry) => ({ ...entry }));
  const all = new Map((await loadTheaterTextVersions(tx, story.id)).map((version) => [version.id, version]));
  const versions = adoptions.map((entry) => {
    const version = all.get(entry.versionId) ?? basisError();
    if (version.positionId !== entry.positionId) basisError();
    return version;
  });
  const checkpoints = await loadTheaterCheckpoints(tx, branch.id);
  return { story, branch, adoptions, versions, checkpoints, anchors: await loadTheaterGenerationAnchors(tx, branch.id),
    checkpoint: checkpoints.find((node) => node.id === branch.activeCheckpointId) ?? null };
}

function sameCheckpoint(a: TheaterCheckpoint, b: TheaterCheckpoint) {
  return a.id === b.id && a.conversationId === b.conversationId && a.branchId === b.branchId
    && a.content === b.content && a.coveredPositionId === b.coveredPositionId && a.status === b.status
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt && a.basis.length === b.basis.length
    && a.basis.every((entry, index) => entry.positionId === b.basis[index].positionId && entry.versionId === b.basis[index].versionId);
}

export function createTheaterSummaryRepository(database: TheaterStoryDatabase) {
  async function transaction<T>(isCurrent: () => boolean, work: (tx: TheaterStorySql) => Promise<T>) {
    const assertCurrent = () => { if (!isCurrent()) throw new TheaterGenerationCancelledError(); };
    const guarded: TheaterStoryDatabase = {
      execAsync: database.execAsync.bind(database), runAsync: database.runAsync.bind(database),
      getAllAsync: database.getAllAsync.bind(database), getFirstAsync: database.getFirstAsync.bind(database),
      withExclusiveTransactionAsync: (task) => database.withExclusiveTransactionAsync(async (tx) => {
        assertCurrent(); await task(tx); assertCurrent(); // Includes the shared helper's final foreign-key await.
      }),
    };
    return writeTheaterStoryTransaction(guarded, work);
  }

  return {
    load: (binding: TheaterBinding) => transaction(() => true, (tx) => read(tx, binding)),
    save(binding: TheaterBinding, checkpoint: TheaterCheckpoint, isCurrent: () => boolean) {
      return transaction(isCurrent, async (tx) => {
        if (checkpoint.conversationId !== binding.storyId || checkpoint.branchId !== binding.branchId
          || !checkpoint.id.trim() || !checkpoint.content.trim() || checkpoint.status !== 'saved'
          || !Number.isSafeInteger(checkpoint.createdAt) || checkpoint.createdAt < 0
          || !Number.isSafeInteger(checkpoint.updatedAt) || checkpoint.updatedAt < 0) basisError();
        const snapshot = await read(tx, binding);
        const existing = snapshot.checkpoints.find((node) => node.id === checkpoint.id);
        if (existing) {
          if (!sameCheckpoint(existing, checkpoint)) basisError();
          // A receipt retry confirms persistence, never undoes a later explicit selection or edit.
          return snapshot;
        }
        if (theaterCheckpointCoverage(snapshot, checkpoint) === null
          || await tx.getFirstAsync('SELECT id FROM theater_checkpoints WHERE id = ?', checkpoint.id)) basisError();
        await tx.runAsync(`INSERT INTO theater_checkpoints
          (id, conversation_id, branch_id, content, covered_position_id, basis_json, status, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, checkpoint.id, checkpoint.conversationId, checkpoint.branchId,
        checkpoint.content, checkpoint.coveredPositionId, JSON.stringify(checkpoint.basis), checkpoint.status,
        checkpoint.createdAt, checkpoint.updatedAt);
        await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = ?, stale_checkpoint_id = NULL, updated_at = MAX(updated_at, ?) WHERE id = ?',
          checkpoint.id, checkpoint.updatedAt, binding.branchId);
        await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0, updated_at = MAX(updated_at, ?) WHERE id = ?',
          checkpoint.updatedAt, binding.storyId);
        return read(tx, binding);
      });
    },
    remove(binding: TheaterBinding, id: string, expectedActiveId: string | null, isCurrent: () => boolean, expectedStaleId?: string | null) {
      return transaction(isCurrent, async (tx) => {
        const snapshot = await read(tx, binding);
        if (snapshot.branch.activeCheckpointId !== expectedActiveId
          || (expectedStaleId !== undefined && (snapshot.branch.staleCheckpointId ?? null) !== expectedStaleId)
          || !snapshot.checkpoints.some((node) => node.id === id)) basisError();
        const now = Date.now();
        // Capture the inactive state before the delete; receivers never retain a dangling selection.
        if (snapshot.branch.activeCheckpointId === id) {
          await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = NULL WHERE id = ?', binding.branchId);
        }
        if (snapshot.branch.staleCheckpointId === id) {
          await tx.runAsync('UPDATE theater_branches SET stale_checkpoint_id = NULL WHERE id = ?', binding.branchId);
        }
        await tx.runAsync('DELETE FROM theater_checkpoints WHERE id = ? AND branch_id = ?', id, binding.branchId);
        await tx.runAsync('UPDATE theater_branches SET updated_at = MAX(updated_at, ?) WHERE id = ?', now, binding.branchId);
        await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0, updated_at = MAX(updated_at, ?) WHERE id = ?', now, binding.storyId);
        return read(tx, binding);
      });
    },
  };
}
