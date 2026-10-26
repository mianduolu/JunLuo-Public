import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { createTheaterBranchRepository } from './theaterBranchStore';
import type { TheaterStoryDatabase } from './theaterStoryStore';
import type { TheaterDraftStorage } from './theaterDraftSession';
import { THEATER_LOCAL_STORAGE_PREFIX } from './theaterLocalState';
import { buildBackstageSource } from './theaterBackstageMaterial';
import { innerMaterialKey } from '../chat/chatAfterglowState';
import { checkBackstageCapacity, type BackstageCapacityInput } from './theaterBackstageCapacity';
import { TheaterBackstageSession } from './theaterBackstageSession';
import { loadTheaterBackstageUsedCount } from '../chat/chatStorage';
import type { ChatTheaterBackstagePort } from '../chat/chatTheaterBackstage';

/** One owner for theater and chat; retains a live reader, never a previous request snapshot. */
export function createTheaterBackstageOwner(options: Omit<Parameters<typeof createTheaterBackstageRuntime>[0], 'getRequest'> & {
  mountChat?: () => void;
}) {
  let prepare: (() => Promise<BackstageCapacityInput>) | undefined;
  let onBound: (() => void) | undefined;
  const runtime = createTheaterBackstageRuntime({ ...options, getRequest: async () => {
    if (!prepare && options.mountChat) {
      // First use can start in theater. Mount the normal chat reader without
      // navigating or dispatching a reply, then wait for its capacity binding.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { onBound = undefined; reject(new Error('backstage-chat-not-mounted')); }, 10000);
        onBound = () => { clearTimeout(timer); onBound = undefined; resolve(); };
        options.mountChat!();
      });
    }
    if (!prepare) throw new Error('backstage-chat-not-mounted');
    return prepare();
  } });
  const port: ChatTheaterBackstagePort = { session: runtime.session, bindPreparation(next) {
    prepare = next;
    onBound?.();
    return () => { if (prepare === next) prepare = undefined; };
  } };
  return { ...runtime, port, dispose() { prepare = undefined; onBound?.(); runtime.dispose(); } };
}

// Device-local preparation only; excluded by the existing theater-local backup/sync predicate.
export const BACKSTAGE_PREPARATION_KEY = `${THEATER_LOCAL_STORAGE_PREFIX}backstage-preparation`;

// Candidate owner supplies current chat inputs. Hydration never dispatches a model request.
export function createTheaterBackstageRuntime(options: {
  database: TheaterStoryDatabase; localStorage: TheaterDraftStorage;
  getRequest: () => Promise<BackstageCapacityInput>; onReady: () => void;
  createId?: () => string;
}) {
  const repository = createTheaterBranchRepository(options.database);
  let writing: Promise<unknown> = Promise.resolve();
  const write = (work: () => Promise<void>) => {
    const result = writing.then(work, work); writing = result.catch(() => undefined); return result;
  };
  const load: ConstructorParameters<typeof TheaterBackstageSession>[0]['load'] = async binding => {
      const detail = await repository.load(binding.storyId);
      if (!detail) return { missing: 'story' };
      const row = detail.branches.find(item => item.branch.id === binding.branchId);
      if (!row) return { missing: 'branch' };
      const versions = row.adoptions.map(adoption => {
        const version = detail.versions.find(item => item.id === adoption.versionId && item.positionId === adoption.positionId);
        if (!version) throw new Error('theater-backstage-incomplete-source');
        return version;
      });
      return { source: buildBackstageSource({ story: detail.story, branch: row.branch,
        adoptions: row.adoptions, versions, anchors: row.anchors,
        checkpoint: row.checkpoints.find(item => item.id === row.branch.activeCheckpointId) ?? null,
      }, detail.versions) };
    };
  const session = new TheaterBackstageSession({
    epoch: captureBackupRestoreDataEpoch, createId: options.createId, load,
    async fits(card) { return (await checkBackstageCapacity(await options.getRequest(), card)).fits; },
    save: (value, isCurrent) => write(async () => {
      const epoch = captureBackupRestoreDataEpoch();
      const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
        if (!isCurrent()) throw new Error('theater-backstage-cancelled');
        // No rendered full card or original story copied into a second store.
        await options.localStorage.setItem(BACKSTAGE_PREPARATION_KEY, JSON.stringify({
          binding: value.source.binding, sourceKey: innerMaterialKey(value.source.revision),
          selection: value.selection, mode: value.mode, batch: value.batch,
        }));
      });
      if (!result.committed || !canCommitBackupRestoreDataEpoch(epoch) || !isCurrent()) throw new Error('theater-backstage-cancelled');
    }),
    clear: () => write(() => options.localStorage.removeItem(BACKSTAGE_PREPARATION_KEY)),
    onReady: options.onReady,
  });
  const invalidateForRestore = () => {
    session.invalidate();
    // Serialized after any in-flight local write, never resurrect a restored preparation.
    return write(() => options.localStorage.removeItem(BACKSTAGE_PREPARATION_KEY));
  };
  const unsubscribe = subscribeBackupRestoreRuntimeState(state => {
    if (state.status !== 'ready') void invalidateForRestore().catch(() => undefined);
  });
  const ready = session.hydrate(async () => {
    const raw = await options.localStorage.getItem(BACKSTAGE_PREPARATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    // Old preparations have no activation batch; neither migration nor another device starts one.
    if (!value?.batch || typeof value.batch.id !== 'string' || !value.batch.id
      || !Number.isInteger(value.batch.usedCount) || value.batch.usedCount < 0 || value.batch.usedCount > 6
      || typeof value.binding?.storyId !== 'string' || typeof value.binding?.branchId !== 'string') return null;
    const loaded = await load(value.binding);
    if ('missing' in loaded || value.sourceKey !== innerMaterialKey(loaded.source.revision)) return null;
    const selection = value.selection;
    if (typeof selection?.world?.included !== 'boolean' || typeof selection.world.text !== 'string'
      || typeof selection?.checkpoint?.included !== 'boolean' || typeof selection.checkpoint.text !== 'string'
      || !Array.isArray(selection.anchorIds) || !Array.isArray(selection.lineIds)
      || !selection.anchorIds.every((id: unknown) => typeof id === 'string' && loaded.source.anchors.some(item => item.id === id))
      || !selection.lineIds.every((id: unknown) => typeof id === 'string' && loaded.source.lines.some(item => item.id === id))) return null;
    const usedCount = Math.max(value.batch.usedCount, await loadTheaterBackstageUsedCount(value.batch.id));
    return { source: loaded.source, selection, mode: usedCount ? 'slim' : 'full',
      batch: { id: value.batch.id, usedCount: Math.min(6, usedCount) } };
  });
  return { session, ready, invalidateForRestore, dispose() { unsubscribe(); session.invalidate(); } };
}
