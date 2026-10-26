import {
  loadTheaterAdoptions, loadTheaterBranches, loadTheaterCheckpoints, loadTheaterStories,
  loadTheaterTextVersions, loadTheaterAnchors, writeTheaterStoryTransaction,
  type TheaterStoryDatabase, type TheaterStorySql,
} from './theaterStoryStore';
import type {
  TheaterAdoption, TheaterAnchor, TheaterBranch, TheaterCheckpoint, TheaterStory, TheaterTextVersion,
} from './theaterStoryTypes';
import { theaterUsedAnchorsUnchanged } from './theaterAnchorMaterials';

export type TheaterBinding = { storyId: string; branchId: string };
export type TheaterGenerationSnapshot = {
  story: TheaterStory;
  branch: TheaterBranch;
  adoptions: TheaterAdoption[];
  versions: TheaterTextVersion[];
  checkpoint: TheaterCheckpoint | null;
  anchors?: TheaterAnchor[];
};

export class TheaterGenerationBasisError extends Error {
  constructor() { super('theater-generation-basis-changed'); this.name = 'TheaterGenerationBasisError'; }
}
export class TheaterGenerationCancelledError extends Error {
  constructor() { super('theater-generation-cancelled'); this.name = 'TheaterGenerationCancelledError'; }
}
export class TheaterAnchorBasisError extends TheaterGenerationBasisError {}
export class TheaterAnchorReadError extends Error {}
export async function loadTheaterGenerationAnchors(tx: TheaterStorySql, branchId: string) {
  try { return await loadTheaterAnchors(tx, branchId); } catch { throw new TheaterAnchorReadError('theater-anchor-read-failed'); }
}

function sameAdoptions(a: TheaterAdoption[], b: TheaterAdoption[]) {
  return a.length === b.length && a.every((entry, index) => entry.positionId === b[index].positionId
    && entry.versionId === b[index].versionId);
}
function sameVersion(a: TheaterTextVersion, b: TheaterTextVersion) {
  const source = (value: TheaterTextVersion) => value.coCreation ? {
    branchId: value.coCreation.branchId, youVersionIds: value.coCreation.youVersionIds,
    identities: value.coCreation.identities,
  } : null;
  return a.id === b.id && a.conversationId === b.conversationId && a.positionId === b.positionId
    && a.kind === b.kind && a.subject === b.subject && a.content === b.content && a.origin === b.origin
    && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt
    && JSON.stringify(source(a)) === JSON.stringify(source(b));
}

async function readSnapshot(tx: TheaterStorySql, binding: TheaterBinding): Promise<TheaterGenerationSnapshot> {
  const story = (await loadTheaterStories(tx)).find((entry) => entry.id === binding.storyId);
  const branch = (await loadTheaterBranches(tx, binding.storyId)).find((entry) => entry.id === binding.branchId);
  if (!story || !branch) throw new TheaterGenerationBasisError();
  const adoptions = await loadTheaterAdoptions(tx, binding.branchId);
  const allVersions = new Map((await loadTheaterTextVersions(tx, binding.storyId)).map((entry) => [entry.id, entry]));
  const versions = adoptions.map((entry) => {
    const version = allVersions.get(entry.versionId);
    if (!version || version.positionId !== entry.positionId) throw new TheaterGenerationBasisError();
    return version;
  });
  const checkpoint = branch.activeCheckpointId
    ? (await loadTheaterCheckpoints(tx, branch.id)).find((entry) => entry.id === branch.activeCheckpointId) ?? null
    : null;
  return { story, branch, adoptions, versions, checkpoint, anchors: await loadTheaterGenerationAnchors(tx, branch.id) };
}

export function createTheaterGenerationRepository(database: TheaterStoryDatabase) {
  return {
    load(binding: TheaterBinding) {
      return writeTheaterStoryTransaction(database, (tx) => readSnapshot(tx, binding));
    },
    append(binding: TheaterBinding, version: TheaterTextVersion, expected: TheaterAdoption[], isCurrent: () => boolean, usedAnchors?: TheaterAnchor[]) {
      const assertCurrent = () => { if (!isCurrent()) throw new TheaterGenerationCancelledError(); };
      // The final guard runs after the shared helper's foreign-key await, immediately
      // before Expo commits. A cancellation during any awaited operation rolls back.
      const guardedDatabase: TheaterStoryDatabase = {
        execAsync: database.execAsync.bind(database),
        runAsync: database.runAsync.bind(database),
        getAllAsync: database.getAllAsync.bind(database),
        getFirstAsync: database.getFirstAsync.bind(database),
        withExclusiveTransactionAsync: (task) => database.withExclusiveTransactionAsync(async (tx) => {
          assertCurrent();
          await task(tx);
          assertCurrent();
        }),
      };
      return writeTheaterStoryTransaction(guardedDatabase, async (tx) => {
        assertCurrent();
        if (version.conversationId !== binding.storyId || version.kind !== 'dialogue'
          || !version.content.trim()) throw new TheaterGenerationBasisError();
        const snapshot = await readSnapshot(tx, binding);
        const appended = [...expected, { positionId: version.positionId, versionId: version.id }];
        if (sameAdoptions(snapshot.adoptions, appended)
          && sameVersion(snapshot.versions[snapshot.versions.length - 1], version)) return snapshot;
        if (usedAnchors && !theaterUsedAnchorsUnchanged(usedAnchors, snapshot)) throw new TheaterAnchorBasisError();
        if (!sameAdoptions(snapshot.adoptions, expected)) throw new TheaterGenerationBasisError();
        if (version.coCreation) {
          const unanswered: string[] = [];
          for (const item of [...snapshot.versions].reverse()) {
            if (item.kind !== 'dialogue') continue;
            if (item.subject !== 'you') break;
            unanswered.unshift(item.id);
          }
          if (version.subject !== 'I' || version.origin !== 'generated'
            || version.coCreation.branchId !== binding.branchId
            || !Number.isSafeInteger(version.coCreation.completedAt)
            || version.coCreation.completedAt < version.createdAt
            || JSON.stringify(unanswered) !== JSON.stringify(version.coCreation.youVersionIds)
            || (!unanswered.length && snapshot.versions.some((item) => item.kind === 'dialogue'))) {
            throw new TheaterGenerationBasisError();
          }
        }
        const collision = await tx.getFirstAsync(`SELECT id FROM theater_text_versions
          WHERE id = ? OR (conversation_id = ? AND position_id = ?) LIMIT 1`,
        version.id, binding.storyId, version.positionId);
        if (collision) throw new TheaterGenerationBasisError();
        assertCurrent();
        await tx.runAsync(`INSERT INTO theater_text_versions
          (id, conversation_id, position_id, kind, subject, content, origin, created_at, updated_at, co_creation_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        version.id, version.conversationId, version.positionId, version.kind, version.subject,
        version.content, version.origin, version.createdAt, version.updatedAt,
        version.coCreation ? JSON.stringify(version.coCreation) : null);
        assertCurrent();
        await tx.runAsync(`INSERT INTO theater_branch_positions
          (conversation_id, branch_id, ordinal, position_id, version_id) VALUES (?, ?, ?, ?, ?)`,
        binding.storyId, binding.branchId, expected.length, version.positionId, version.id);
        assertCurrent();
        await tx.runAsync(`UPDATE theater_branches SET updated_at = MAX(updated_at, ?) WHERE id = ?`,
          version.updatedAt, binding.branchId);
        assertCurrent();
        await tx.runAsync(`UPDATE theater_conversations SET is_draft = 0, legacy_sync_open = 0,
          updated_at = MAX(updated_at, ?) WHERE id = ?`, version.updatedAt, binding.storyId);
        return readSnapshot(tx, binding);
      });
    },
  };
}
