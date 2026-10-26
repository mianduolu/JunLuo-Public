import {
  captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit, subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import { createTheaterBranchRepository } from './theaterBranchStore';
import { TheaterBranchSession } from './theaterBranchSession';
import { TheaterDraftSession, type TheaterDraftStorage } from './theaterDraftSession';
import { createTheaterGenerationRuntime } from './theaterGenerationRuntime';
import { createTheaterSummaryRuntime } from './theaterSummaryRuntime';
import { createTheaterAnchorRepository } from './theaterAnchorStore';
import { TheaterAnchorSession } from './theaterAnchorSession';
import { TheaterReadingSession } from './theaterReadingSession';
import { TheaterSearchSession } from './theaterSearchSession';
import { TheaterHistorySession } from './theaterHistorySession';
import { createTheaterHistoryRepository } from './theaterHistoryStore';
import { createTheaterBackstageRuntime } from './theaterBackstageRuntime';

// Does not open a DB, install a schema, mount the live feature, or start a request.
export function createTheaterBranchRuntime(options: Parameters<typeof createTheaterGenerationRuntime>[0] & {
  localStorage: TheaterDraftStorage;
  backstage?: Pick<Parameters<typeof createTheaterBackstageRuntime>[0], 'getRequest' | 'onReady'>;
  backstageOwner?: ReturnType<typeof import('./theaterBackstageRuntime').createTheaterBackstageOwner>;
}) {
  const backstage = options.backstageOwner ?? (options.backstage ? createTheaterBackstageRuntime({ ...options, ...options.backstage }) : null);
  const repository = createTheaterBranchRepository(options.database);
  const reading = new TheaterReadingSession(options.localStorage);
  const generation = createTheaterGenerationRuntime({ ...options, saveAlternative: repository.saveAlternative,
    onReplySaved: (binding, version) => reading.replySaved(binding, version.id) });
  const search = new TheaterSearchSession({ load: repository.load });
  const historyRepository = createTheaterHistoryRepository(options.database);
  const history = new TheaterHistorySession({ load: async () => {
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) throw new Error('theater-restoring');
    const rows = await historyRepository.load();
    if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('theater-restoring');
    return rows;
  }, setPinned: async (storyId, pinned) => {
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) throw new Error('theater-restoring');
    const result = await runBackupRestoreDataEpochCommit(epoch, () => historyRepository.setPinned(storyId, pinned));
    if (!result.committed || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('theater-restoring');
    return result.value;
  } });
  const updateLocal = () => history.setLocal({ selectedByStory: reading.getSnapshot().selectedByStory,
    unreadStoryIds: reading.unreadStoryIds(), generatingStoryId: generation.getSnapshot().active?.binding.storyId ?? null });
  const unsubscribeReading = reading.subscribe(updateLocal), unsubscribeGeneration = generation.subscribe(updateLocal);
  const unsubscribeRestore = subscribeBackupRestoreRuntimeState(value => {
    if (value.status !== 'ready') { search.close(); history.invalidate(); void reading.reset(); }
  });
  const drafts = new TheaterDraftSession(options.localStorage);
  const branches = new TheaterBranchSession({ repository, generation, drafts, reading,
    createId: options.createId, epoch: {
      captureDataEpoch: captureBackupRestoreDataEpoch, canCommitDataEpoch: canCommitBackupRestoreDataEpoch,
      runDataEpochCommit: runBackupRestoreDataEpochCommit, subscribeRuntimeState: subscribeBackupRestoreRuntimeState,
    } });
  const anchors = new TheaterAnchorSession({ repository: createTheaterAnchorRepository(options.database),
    createId: options.createId, epoch: {
      captureDataEpoch: captureBackupRestoreDataEpoch, canCommitDataEpoch: canCommitBackupRestoreDataEpoch,
      runDataEpochCommit: runBackupRestoreDataEpochCommit, subscribeRuntimeState: subscribeBackupRestoreRuntimeState,
    }, onChanged: async binding => {
      await generation.sourceChanged(binding); await summaries.sourceChanged(binding); await generation.refresh(binding);
    } });
  const summaries = createTheaterSummaryRuntime(options, generation, anchors);
  let previous = branches.getSnapshot().detail;
  const unsubscribe = branches.subscribe(() => {
    const detail = branches.getSnapshot().detail;
    if (detail === previous) return;
    const old = previous; previous = detail;
    void backstage?.session.sourceChanged();
    const bindings = new Map<string, { storyId: string; branchId: string }>();
    for (const value of [old, detail]) if (value) for (const row of value.branches) {
      bindings.set(row.branch.id, { storyId: value.story.id, branchId: row.branch.id });
    }
    for (const binding of bindings.values()) void summaries.sourceChanged(binding);
  });
  const refreshBackstage = () => { void backstage?.session.sourceChanged(); };
  const unsubscribeBackstageSummary = summaries.subscribe(refreshBackstage);
  const unsubscribeBackstageAnchors = anchors.subscribe(refreshBackstage);
  return { generation, drafts, branches, summaries, anchors, reading, search, history,
    backstage: backstage?.session, backstageReady: backstage?.ready, dispose() {
    unsubscribe(); unsubscribeReading(); unsubscribeGeneration(); unsubscribeRestore();
    unsubscribeBackstageSummary(); unsubscribeBackstageAnchors();
    if (!options.backstageOwner) backstage?.dispose();
    reading.dispose(); search.dispose(); history.invalidate(); anchors.dispose(); summaries.dispose(); branches.dispose(); generation.dispose();
  } };
}
