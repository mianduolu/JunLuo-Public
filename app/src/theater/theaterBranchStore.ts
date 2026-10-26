import {
  loadTheaterAdoptions, loadTheaterAnchors, loadTheaterBranches, loadTheaterCheckpoints,
  loadTheaterStories, loadTheaterTextVersions, writeTheaterStoryTransaction,
  type TheaterStoryDatabase, type TheaterStorySql,
} from './theaterStoryStore';
import {
  TheaterAnchorBasisError, TheaterGenerationBasisError, TheaterGenerationCancelledError,
  type TheaterBinding, type TheaterGenerationSnapshot,
} from './theaterGenerationStore';
import { theaterUsedAnchorsUnchanged } from './theaterAnchorMaterials';
import type {
  TheaterAdoption, TheaterAnchor, TheaterBranch, TheaterCheckpoint, TheaterStory, TheaterTextVersion,
} from './theaterStoryTypes';

export type TheaterBranchDetail = {
  branch: TheaterBranch; adoptions: TheaterAdoption[]; checkpoints: TheaterCheckpoint[]; anchors: TheaterAnchor[];
};
export type TheaterStoryDetail = { story: TheaterStory; branches: TheaterBranchDetail[]; versions: TheaterTextVersion[] };
export type TheaterNewBranch = { id: string; name: string; createdAt: number };
export type TheaterBranchOperation = (
  | { type: 'edit'; version: TheaterTextVersion; newBranch?: TheaterNewBranch }
  | { type: 'forkBefore'; positionId: string; newBranch: TheaterNewBranch }
  | { type: 'forkVersion'; versionId: string; newBranch: TheaterNewBranch }
  | { type: 'adopt'; versionId: string }
  | { type: 'saveAlternative'; version: TheaterTextVersion }
  | { type: 'rename'; name: string }
  | { type: 'deleteLast'; replacementVersionId?: string | null }
  | { type: 'deleteVersion'; versionId: string }
  | { type: 'deleteBranch'; emptyBranch: TheaterNewBranch; expectedBranchIds: string[] }
  | { type: 'deleteStory'; expectedBranches: { id: string; adoptions: TheaterAdoption[] }[] }
) & { now?: number };
export type TheaterBranchResult = { detail: TheaterStoryDetail | null; branchId: string | null; deletedBranchIds: string[] };

const basisError = (): never => { throw new TheaterGenerationBasisError(); };
const equal = (a: TheaterAdoption[], b: TheaterAdoption[]) => a.length === b.length && a.every((item, i) =>
  item.positionId === b[i]?.positionId && item.versionId === b[i]?.versionId);
const prefix = (a: TheaterAdoption[], b: TheaterAdoption[]) => equal(a, b.slice(0, a.length));
const sameVersion = (a: TheaterTextVersion, b: TheaterTextVersion) =>
  a.id === b.id && a.conversationId === b.conversationId && a.positionId === b.positionId
  && a.kind === b.kind && a.subject === b.subject && a.content === b.content && a.origin === b.origin
  && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt;

async function read(tx: TheaterStorySql, storyId: string): Promise<TheaterStoryDetail | null> {
  const story = (await loadTheaterStories(tx)).find((item) => item.id === storyId);
  if (!story) return null;
  const branches: TheaterBranchDetail[] = [];
  for (const branch of await loadTheaterBranches(tx, storyId)) branches.push({ branch,
    adoptions: (await loadTheaterAdoptions(tx, branch.id)).map((item) => ({ ...item })), checkpoints: await loadTheaterCheckpoints(tx, branch.id),
    anchors: await loadTheaterAnchors(tx, branch.id) });
  return { story, branches, versions: await loadTheaterTextVersions(tx, storyId) };
}

function selected(detail: TheaterStoryDetail, branchId: string) {
  return detail.branches.find((item) => item.branch.id === branchId) ?? basisError();
}
function getVersion(detail: TheaterStoryDetail, id: string) {
  return detail.versions.find((item) => item.id === id) ?? basisError();
}
function dialoguePrefix(detail: TheaterStoryDetail, adoptions: TheaterAdoption[]) {
  return adoptions.filter((item) => getVersion(detail, item.versionId).kind === 'dialogue');
}
function validCheckpoint(node: TheaterCheckpoint, adoptions: TheaterAdoption[]) {
  return node.status === 'saved' && node.basis.length > 0
    && node.coveredPositionId === node.basis.at(-1)?.positionId && prefix(node.basis, adoptions);
}
function generationSnapshot(detail: TheaterStoryDetail, branchId: string): TheaterGenerationSnapshot {
  const item = selected(detail, branchId);
  return { story: detail.story, branch: item.branch, adoptions: item.adoptions,
    versions: item.adoptions.map((entry) => getVersion(detail, entry.versionId)),
    checkpoint: item.checkpoints.find((node) => node.id === item.branch.activeCheckpointId) ?? null, anchors: item.anchors };
}

async function insertVersion(tx: TheaterStorySql, detail: TheaterStoryDetail, version: TheaterTextVersion) {
  // Both callers create edits or same-position alternatives, never a new completed unit.
  if (version.coCreation) basisError();
  if (version.conversationId !== detail.story.id || version.kind !== 'dialogue' || !version.content.trim()) basisError();
  const existing = detail.versions.find((item) => item.id === version.id);
  if (existing) { if (!sameVersion(existing, version)) basisError(); return; }
  const position = detail.versions.find((item) => item.positionId === version.positionId);
  if (!position || position.kind !== 'dialogue' || position.subject !== version.subject) basisError();
  await tx.runAsync(`INSERT INTO theater_text_versions
    (id, conversation_id, position_id, kind, subject, content, origin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, version.id, version.conversationId, version.positionId,
  version.kind, version.subject, version.content, version.origin, version.createdAt, version.updatedAt);
}

// Retire the explicit selection before capture sees a changed adopted prefix. It stays review-only.
async function deactivateIfNeeded(tx: TheaterStorySql, detail: TheaterStoryDetail, branch: TheaterBranchDetail, next: TheaterAdoption[]) {
  const active = branch.checkpoints.find((node) => node.id === branch.branch.activeCheckpointId);
  if (branch.branch.activeCheckpointId && (!active || !validCheckpoint(active, dialoguePrefix(detail, next)))) {
    if (!active) basisError();
    await tx.runAsync('UPDATE theater_branches SET stale_checkpoint_id = active_checkpoint_id, active_checkpoint_id = NULL WHERE id = ?', branch.branch.id);
  }
}

async function replaceLast(tx: TheaterStorySql, detail: TheaterStoryDetail, branch: TheaterBranchDetail, next: TheaterAdoption[]) {
  await deactivateIfNeeded(tx, detail, branch, next);
  const last = branch.adoptions.at(-1) ?? basisError();
  if (next.length < branch.adoptions.length) {
    // Anchors are local to the removed occurrence. Other branches and checkpoint evidence survive.
    await tx.runAsync('DELETE FROM theater_anchors WHERE branch_id = ? AND position_id = ?', branch.branch.id, last.positionId);
    await tx.runAsync('DELETE FROM theater_branch_positions WHERE branch_id = ? AND position_id = ?', branch.branch.id, last.positionId);
  } else {
    if (last.versionId !== next.at(-1)!.versionId) {
      // Explicitly retire the confirmation; selecting the old version again must not reactivate it.
      await tx.runAsync(`UPDATE theater_anchors SET confirmed = 0, updated_at = MAX(updated_at, ?)
        WHERE branch_id = ? AND position_id = ? AND confirmed = 1`,
      getVersion(detail, next.at(-1)!.versionId).updatedAt, branch.branch.id, last.positionId);
    }
    await tx.runAsync('UPDATE theater_branch_positions SET version_id = ? WHERE branch_id = ? AND position_id = ?',
      next.at(-1)!.versionId, branch.branch.id, last.positionId);
  }
}

async function fork(tx: TheaterStorySql, detail: TheaterStoryDetail, source: TheaterBranchDetail,
  draft: TheaterNewBranch, adoptions: TheaterAdoption[], boundary: number) {
  if (!draft.name.trim() || draft.id === source.branch.id) basisError();
  const existing = detail.branches.find((item) => item.branch.id === draft.id);
  if (existing) {
    if (!equal(existing.adoptions, adoptions) || existing.branch.name !== draft.name
      || existing.branch.createdAt !== draft.createdAt || existing.branch.forkBoundary !== boundary) basisError();
    return;
  }
  await tx.runAsync(`INSERT INTO theater_branches (id, conversation_id, name, fork_boundary, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`, draft.id, detail.story.id, draft.name, boundary, draft.createdAt, draft.createdAt);
  for (const [ordinal, entry] of adoptions.entries()) await tx.runAsync(`INSERT INTO theater_branch_positions
    (conversation_id, branch_id, ordinal, position_id, version_id) VALUES (?, ?, ?, ?, ?)`,
  detail.story.id, draft.id, ordinal, entry.positionId, entry.versionId);
  const common = source.adoptions.slice(0, boundary);
  const commonDialogue = dialoguePrefix(detail, common);
  let active: string | null = null;
  const inherited = source.checkpoints.filter((item) => item.id !== source.branch.staleCheckpointId
    && validCheckpoint(item, commonDialogue));
  const checkpointId = (index: number) => JSON.stringify([draft.id, 'checkpoint', index]);
  for (const [index, node] of inherited.entries()) {
    const id = checkpointId(index);
    await tx.runAsync(`INSERT INTO theater_checkpoints
      (id, conversation_id, branch_id, content, covered_position_id, basis_json, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, detail.story.id, draft.id, node.content,
    node.coveredPositionId, JSON.stringify(node.basis), node.status, node.createdAt, node.updatedAt);
  }
  // A fork may use the latest still-valid saved prefix node; never one covering the changed sentence.
  const best = inherited.map((node, index) => ({ node, index })).sort((a, b) =>
    b.node.basis.length - a.node.basis.length || b.node.updatedAt - a.node.updatedAt || b.node.id.localeCompare(a.node.id))[0];
  if (best) active = checkpointId(best.index);
  if (active) await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = ? WHERE id = ?', active, draft.id);
  for (const [index, anchor] of source.anchors.filter((item) => item.confirmed && common.some((entry) =>
    entry.positionId === item.positionId && item.sourceVersionId === entry.versionId
    && getVersion(detail, entry.versionId).kind === 'dialogue')).entries()) {
    await tx.runAsync(`INSERT INTO theater_anchors
      (id, conversation_id, branch_id, position_id, source_version_id, source, content, confirmed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`, JSON.stringify([draft.id, 'anchor', index]), detail.story.id,
    draft.id, anchor.positionId, anchor.sourceVersionId, anchor.source, anchor.content, anchor.createdAt, anchor.updatedAt);
  }
}

function hasEvidenceReference(detail: TheaterStoryDetail, versionId: string) {
  return detail.branches.some((item) => item.checkpoints.some((node) => node.basis.some((entry) => entry.versionId === versionId))
    || item.anchors.some((anchor) => anchor.sourceVersionId === versionId));
}
async function garbageCollect(tx: TheaterStorySql, storyId: string) {
  const detail = await read(tx, storyId);
  if (!detail) return;
  const livePositions = new Set(detail.branches.flatMap((item) => item.adoptions.map((entry) => entry.positionId)));
  for (const version of detail.versions) if (!livePositions.has(version.positionId) && !hasEvidenceReference(detail, version.id)) {
    await tx.runAsync('DELETE FROM theater_text_versions WHERE id = ?', version.id);
  }
}
async function removeBranch(tx: TheaterStorySql, branchId: string) {
  await tx.runAsync('UPDATE theater_branches SET active_checkpoint_id = NULL, stale_checkpoint_id = NULL WHERE id = ?', branchId);
  await tx.runAsync('DELETE FROM theater_anchors WHERE branch_id = ?', branchId);
  await tx.runAsync('DELETE FROM theater_checkpoints WHERE branch_id = ?', branchId);
  await tx.runAsync('DELETE FROM theater_branch_positions WHERE branch_id = ?', branchId);
  await tx.runAsync('DELETE FROM theater_branches WHERE id = ?', branchId);
}

export function createTheaterBranchRepository(database: TheaterStoryDatabase) {
  async function transaction<T>(isCurrent: () => boolean, task: (tx: TheaterStorySql) => Promise<T>) {
    const assertCurrent = () => { if (!isCurrent()) throw new TheaterGenerationCancelledError(); };
    const guarded: TheaterStoryDatabase = { execAsync: database.execAsync.bind(database), runAsync: database.runAsync.bind(database),
      getAllAsync: database.getAllAsync.bind(database), getFirstAsync: database.getFirstAsync.bind(database),
      withExclusiveTransactionAsync: (work) => database.withExclusiveTransactionAsync(async (tx) => {
        assertCurrent(); await work(tx); assertCurrent(); // Includes the foreign-key check's final await.
      }) };
    return writeTheaterStoryTransaction(guarded, task);
  }

  async function saveAlternative(binding: TheaterBinding, version: TheaterTextVersion, expected: TheaterAdoption[], isCurrent: () => boolean,
    usedAnchors?: TheaterAnchor[]) {
    return transaction(isCurrent, async (tx) => {
      const detail = await read(tx, binding.storyId) ?? basisError();
      const source = selected(detail, binding.branchId);
      const index = expected.findIndex((item) => item.positionId === version.positionId);
      if (index < 0 || version.kind !== 'dialogue' || version.subject !== 'I' || version.origin !== 'generated') basisError();
      const old = getVersion(detail, expected[index].versionId);
      if (old.subject !== 'I' || old.positionId !== version.positionId) basisError();
      const present = detail.versions.find((item) => item.id === version.id);
      if (present) {
        if (!sameVersion(present, version) || !prefix(expected.slice(0, index), source.adoptions)
          || source.adoptions[index]?.positionId !== version.positionId) basisError();
        // Receipt retry does not restore adoption after a later deliberate user selection.
        return generationSnapshot(detail, binding.branchId);
      }
      if (!prefix(expected.slice(0, index + 1), source.adoptions)) basisError();
      if (usedAnchors && !theaterUsedAnchorsUnchanged(usedAnchors, generationSnapshot(detail, binding.branchId))) {
        throw new TheaterAnchorBasisError();
      }
      await insertVersion(tx, detail, version);
      detail.versions.push(version);
      if (source.adoptions.length === index + 1) await replaceLast(tx, detail, source,
        [...source.adoptions.slice(0, -1), { positionId: version.positionId, versionId: version.id }]);
      await tx.runAsync('UPDATE theater_branches SET updated_at = MAX(updated_at, ?) WHERE id = ?', version.updatedAt, binding.branchId);
      await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0, updated_at = MAX(updated_at, ?) WHERE id = ?', version.updatedAt, binding.storyId);
      return generationSnapshot((await read(tx, binding.storyId))!, binding.branchId);
    });
  }

  async function execute(binding: TheaterBinding, expected: TheaterAdoption[], operation: TheaterBranchOperation,
    isCurrent: () => boolean = () => true): Promise<TheaterBranchResult> {
    if (operation.type === 'saveAlternative') {
      await saveAlternative(binding, operation.version, expected, isCurrent);
      return { detail: await transaction(isCurrent, (tx) => read(tx, binding.storyId)), branchId: binding.branchId, deletedBranchIds: [] };
    }
    return transaction(isCurrent, async (tx) => {
      const detail = await read(tx, binding.storyId) ?? basisError();
      const source = selected(detail, binding.branchId);
      const now = operation.now ?? ('version' in operation ? operation.version.updatedAt : Date.now());
      let branchId: string | null = binding.branchId;
      const deletedBranchIds: string[] = [];
      // Recognize only the exact already-committed last edit, without applying it again.
      if (operation.type === 'edit' && !operation.newBranch && expected.at(-1)?.positionId === operation.version.positionId
        && equal(source.adoptions, [...expected.slice(0, -1), { positionId: operation.version.positionId, versionId: operation.version.id }])
        && sameVersion(getVersion(detail, operation.version.id), operation.version)) return { detail, branchId, deletedBranchIds };
      if (!equal(expected, source.adoptions)) basisError();
      if (operation.type === 'edit') {
        const index = expected.findIndex((item) => item.positionId === operation.version.positionId);
        if (index < 0 || operation.version.origin !== 'edited') basisError();
        const changed = { positionId: operation.version.positionId, versionId: operation.version.id };
        await insertVersion(tx, detail, operation.version);
        detail.versions.push(operation.version);
        if (index < expected.length - 1) {
          const newBranch = operation.newBranch ?? basisError();
          await fork(tx, detail, source, newBranch, [...expected.slice(0, index), changed], index);
          branchId = newBranch.id;
        } else {
          if (operation.newBranch) basisError();
          await replaceLast(tx, detail, source, [...expected.slice(0, index), changed]);
        }
      } else if (operation.type === 'forkBefore' || operation.type === 'forkVersion') {
        const version = operation.type === 'forkVersion' ? getVersion(detail, operation.versionId) : null;
        if (version && (version.kind !== 'dialogue' || version.subject !== 'I')) basisError();
        const positionId = version?.positionId ?? (operation as { positionId: string }).positionId;
        const index = expected.findIndex((item) => item.positionId === positionId);
        if (index < 0) basisError();
        const next = expected.slice(0, index);
        if (version) next.push({ positionId, versionId: version.id });
        await fork(tx, detail, source, operation.newBranch, next, index);
        branchId = operation.newBranch.id;
      } else if (operation.type === 'adopt') {
        const version = getVersion(detail, operation.versionId);
        if (version.kind !== 'dialogue' || version.subject !== 'I' || version.positionId !== expected.at(-1)?.positionId) basisError();
        await replaceLast(tx, detail, source, [...expected.slice(0, -1), { positionId: version.positionId, versionId: version.id }]);
      } else if (operation.type === 'rename') {
        if (!operation.name.trim()) basisError();
        await tx.runAsync('UPDATE theater_branches SET name = ? WHERE id = ?', operation.name, binding.branchId);
      } else if (operation.type === 'deleteVersion') {
        const version = getVersion(detail, operation.versionId);
        if (version.subject !== 'I' || !expected.some((item) => item.positionId === version.positionId)
          || detail.branches.some((item) => item.adoptions.some((entry) => entry.versionId === version.id))
          || hasEvidenceReference(detail, version.id)) basisError();
        await tx.runAsync('DELETE FROM theater_text_versions WHERE id = ?', version.id);
      } else if (operation.type === 'deleteLast') {
        const last = expected.at(-1) ?? basisError();
        const version = getVersion(detail, last.versionId);
        if (version.kind !== 'dialogue') basisError();
        const alternatives = detail.versions.filter((item) => item.positionId === last.positionId && item.id !== version.id);
        let next = expected.slice(0, -1);
        if (version.subject === 'I' && alternatives.length) {
          const replacement = alternatives.find((item) => item.id === operation.replacementVersionId) ?? basisError();
          next = [...next, { positionId: last.positionId, versionId: replacement.id }];
        } else if (operation.replacementVersionId) basisError();
        await replaceLast(tx, detail, source, next);
        const after = (await read(tx, binding.storyId))!;
        if (!after.branches.some((item) => item.adoptions.some((entry) => entry.versionId === version.id)) && !hasEvidenceReference(after, version.id)) {
          await tx.runAsync('DELETE FROM theater_text_versions WHERE id = ?', version.id);
        }
        await garbageCollect(tx, binding.storyId);
      } else if (operation.type === 'deleteBranch') {
        if (operation.expectedBranchIds.length !== detail.branches.length
          || detail.branches.some((item) => !operation.expectedBranchIds.includes(item.branch.id))) basisError();
        await removeBranch(tx, binding.branchId);
        deletedBranchIds.push(binding.branchId);
        branchId = null;
        if (detail.branches.length === 1) {
          if (operation.emptyBranch.id === binding.branchId) basisError();
          await tx.runAsync(`INSERT INTO theater_branches (id, conversation_id, name, fork_boundary, created_at, updated_at)
            VALUES (?, ?, '最初走向', NULL, ?, ?)`, operation.emptyBranch.id, binding.storyId,
          operation.emptyBranch.createdAt, operation.emptyBranch.createdAt);
          branchId = operation.emptyBranch.id;
        }
        await garbageCollect(tx, binding.storyId);
      } else if (operation.type === 'deleteStory') {
        if (operation.expectedBranches.length !== detail.branches.length || detail.branches.some((item) => {
          const expectedBranch = operation.expectedBranches.find((entry) => entry.id === item.branch.id);
          return !expectedBranch || !equal(expectedBranch.adoptions, item.adoptions);
        })) basisError();
        for (const item of detail.branches) { await removeBranch(tx, item.branch.id); deletedBranchIds.push(item.branch.id); }
        await tx.runAsync('DELETE FROM theater_text_versions WHERE conversation_id = ?', binding.storyId);
        if (await tx.getFirstAsync("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'theater_messages'")) {
          await tx.runAsync('DELETE FROM theater_messages WHERE conversation_id = ?', binding.storyId);
        }
        await tx.runAsync('DELETE FROM theater_conversations WHERE id = ?', binding.storyId);
        return { detail: null, branchId: null, deletedBranchIds };
      }
      if (branchId) await tx.runAsync('UPDATE theater_branches SET updated_at = MAX(updated_at, ?) WHERE id = ?', now, branchId);
      await tx.runAsync('UPDATE theater_conversations SET legacy_sync_open = 0, updated_at = MAX(updated_at, ?) WHERE id = ?', now, binding.storyId);
      return { detail: await read(tx, binding.storyId), branchId, deletedBranchIds };
    });
  }
  return { load: (storyId: string) => transaction(() => true, (tx) => read(tx, storyId)), execute, saveAlternative };
}
