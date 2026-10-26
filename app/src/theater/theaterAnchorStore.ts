import {
  loadTheaterAdoptions, loadTheaterAnchors, loadTheaterBranches, loadTheaterStories,
  loadTheaterTextVersions, writeTheaterStoryTransaction,
  type TheaterStoryDatabase, type TheaterStorySql,
} from './theaterStoryStore';
import {
  TheaterGenerationBasisError, TheaterGenerationCancelledError, type TheaterBinding,
} from './theaterGenerationStore';
import type { TheaterAdoption, TheaterAnchor, TheaterBranch, TheaterStory, TheaterTextVersion } from './theaterStoryTypes';

export type TheaterAnchorSnapshot = {
  story: TheaterStory; branch: TheaterBranch; adoptions: TheaterAdoption[];
  versions: TheaterTextVersion[]; anchors: TheaterAnchor[];
};
export type TheaterAnchorEvidence = { adoptions: TheaterAdoption[]; anchors: TheaterAnchor[] };
export class TheaterAnchorConflictError extends TheaterGenerationBasisError {}

export function sameTheaterAnchor(a: TheaterAnchor, b: TheaterAnchor): boolean {
  return a.id === b.id && a.conversationId === b.conversationId && a.branchId === b.branchId
    && a.positionId === b.positionId && a.sourceVersionId === b.sourceVersionId && a.source === b.source
    && a.content === b.content && a.confirmed === b.confirmed
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;
}
const basisError = (): never => { throw new TheaterGenerationBasisError(); };
const conflict = (): never => { throw new TheaterAnchorConflictError(); };

async function read(tx: TheaterStorySql, binding: TheaterBinding): Promise<TheaterAnchorSnapshot | null> {
  const story = (await loadTheaterStories(tx)).find((item) => item.id === binding.storyId);
  if (!story) return null;
  const branch = (await loadTheaterBranches(tx, story.id)).find((item) => item.id === binding.branchId);
  if (!branch) return null;
  const adoptions = (await loadTheaterAdoptions(tx, branch.id)).map((item) => ({ ...item }));
  const all = new Map((await loadTheaterTextVersions(tx, story.id)).map((item) => [item.id, item]));
  const versions = adoptions.map((entry) => {
    const version = all.get(entry.versionId) ?? basisError();
    if (version.positionId !== entry.positionId) basisError();
    return version;
  });
  return { story, branch, adoptions, versions, anchors: await loadTheaterAnchors(tx, branch.id) };
}

export function createTheaterAnchorRepository(database: TheaterStoryDatabase) {
  async function transaction<T>(isCurrent: () => boolean, work: (tx: TheaterStorySql) => Promise<T>) {
    const assertCurrent = () => { if (!isCurrent()) throw new TheaterGenerationCancelledError(); };
    const guarded: TheaterStoryDatabase = {
      execAsync: database.execAsync.bind(database), runAsync: database.runAsync.bind(database),
      getAllAsync: database.getAllAsync.bind(database), getFirstAsync: database.getFirstAsync.bind(database),
      withExclusiveTransactionAsync: (task) => database.withExclusiveTransactionAsync(async (tx) => {
        assertCurrent(); await task(tx); assertCurrent();
      }),
    };
    return writeTheaterStoryTransaction(guarded, work);
  }
  async function touch(tx: TheaterStorySql, binding: TheaterBinding, now: number) {
    await tx.runAsync('UPDATE theater_branches SET updated_at = MAX(updated_at, ?) WHERE id = ?', now, binding.branchId);
    await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0, updated_at = MAX(updated_at, ?) WHERE id = ?', now, binding.storyId);
  }
  return {
    load: (binding: TheaterBinding) => transaction(() => true, (tx) => read(tx, binding)),
    save(binding: TheaterBinding, anchor: TheaterAnchor, expected: TheaterAnchor | null, isCurrent: () => boolean,
      evidence?: TheaterAnchorEvidence) {
      return transaction(isCurrent, async (tx) => {
        if (anchor.conversationId !== binding.storyId || anchor.branchId !== binding.branchId
          || !anchor.id.trim() || !anchor.content.trim() || anchor.confirmed !== true
          || !['manual', 'message', 'summary'].includes(anchor.source)
          || !Number.isSafeInteger(anchor.createdAt) || anchor.createdAt < 0
          || !Number.isSafeInteger(anchor.updatedAt) || anchor.updatedAt < 0) basisError();
        const snapshot = await read(tx, binding) ?? basisError();
        const version = snapshot.versions.find((item) => item.positionId === anchor.positionId);
        if (!version || version.kind !== 'dialogue' || anchor.sourceVersionId !== version.id) basisError();
        const existing = snapshot.anchors.find((item) => item.id === anchor.id);
        // The same operation may have committed even when its receipt was lost.
        if (existing && sameTheaterAnchor(existing, anchor)) return snapshot;
        if (evidence && (evidence.adoptions.some((entry, index) => entry.positionId !== snapshot.adoptions[index]?.positionId
          || entry.versionId !== snapshot.adoptions[index]?.versionId)
          || evidence.anchors.some((used) => {
            const current = snapshot.anchors.find((item) => item.id === used.id);
            return !current || !current.confirmed || !sameTheaterAnchor(used, current)
              || !snapshot.versions.some((item) => item.kind === 'dialogue' && item.positionId === current.positionId
                && item.id === current.sourceVersionId);
          }))) basisError();
        if (expected) {
          if (expected.id !== anchor.id || !existing || !sameTheaterAnchor(existing, expected)) conflict();
          if (anchor.createdAt !== expected.createdAt) basisError();
          await tx.runAsync(`UPDATE theater_anchors SET position_id = ?, source_version_id = ?, source = ?,
            content = ?, confirmed = 1, updated_at = ? WHERE id = ? AND branch_id = ?`,
          anchor.positionId, anchor.sourceVersionId, anchor.source, anchor.content, anchor.updatedAt, anchor.id, binding.branchId);
        } else {
          if (existing || await tx.getFirstAsync('SELECT id FROM theater_anchors WHERE id = ?', anchor.id)) conflict();
          await tx.runAsync(`INSERT INTO theater_anchors
            (id, conversation_id, branch_id, position_id, source_version_id, source, content, confirmed, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, anchor.id, anchor.conversationId, anchor.branchId,
          anchor.positionId, anchor.sourceVersionId, anchor.source, anchor.content, anchor.createdAt, anchor.updatedAt);
        }
        await touch(tx, binding, anchor.updatedAt);
        return (await read(tx, binding))!;
      });
    },
    remove(binding: TheaterBinding, expected: TheaterAnchor, isCurrent: () => boolean) {
      return transaction(isCurrent, async (tx) => {
        const snapshot = await read(tx, binding) ?? basisError();
        const existing = snapshot.anchors.find((item) => item.id === expected.id);
        if (!existing || !sameTheaterAnchor(existing, expected)) conflict();
        await tx.runAsync('DELETE FROM theater_anchors WHERE id = ? AND branch_id = ?', expected.id, binding.branchId);
        await touch(tx, binding, Date.now());
        return (await read(tx, binding))!;
      });
    },
  };
}
