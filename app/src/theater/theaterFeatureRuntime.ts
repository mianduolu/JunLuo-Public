import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { createTheaterBranchRuntime } from './theaterBranchRuntime';
import { createTheaterBackstageOwner } from './theaterBackstageRuntime';
import { createTheaterSetupRepository } from './theaterSetupStore';
import { TheaterSetupSession } from './theaterSetupSession';
import type { TheaterBinding } from './theaterGenerationStore';

type Tab = 'chat' | 'setup' | 'history';
type State = { tab: Tab; storyId: string | null };

// App-owned, not page-owned: changing screens never disposes a running reply.
export function createTheaterFeatureRuntime(options: Omit<Parameters<typeof createTheaterBranchRuntime>[0],
  'backstage' | 'backstageOwner'> & { onBringToChat: () => void; mountChat: () => void }) {
  let disposed = false;
  let navigation = 0;
  // All panels share this original DB. Serialize their exclusive transactions
  // so a refresh and a save cannot contend on different SQLite connections.
  const database = options.database;
  let transactionTail: Promise<void> = Promise.resolve();
  options = { ...options, database: {
    execAsync: database.execAsync.bind(database), runAsync: database.runAsync.bind(database),
    getAllAsync: database.getAllAsync.bind(database), getFirstAsync: database.getFirstAsync.bind(database),
    withExclusiveTransactionAsync(work) {
      const run = () => {
        if (disposed) throw new Error('theater-restoring');
        return database.withExclusiveTransactionAsync(work);
      };
      const result = transactionTail.then(run, run);
      transactionTail = result.catch(() => undefined); return result;
    },
  } };
  let state: State = { tab: 'history', storyId: null };
  const listeners = new Set<() => void>();
  const update = (patch: Partial<State>) => {
    if (disposed) return;
    state = { ...state, ...patch }; listeners.forEach(fn => fn());
  };
  const backstage = createTheaterBackstageOwner({ ...options,
    onReady: options.onBringToChat, mountChat: options.mountChat });
  const branch = createTheaterBranchRuntime({ ...options, backstageOwner: backstage });
  const repository = createTheaterSetupRepository(options.database, options.createId);
  const current = () => {
    const epoch = captureBackupRestoreDataEpoch();
    if (disposed || epoch === null) throw new Error('theater-restoring');
    return epoch;
  };
  const read = async () => {
    const epoch = current(), stories = await repository.load();
    if (disposed || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('theater-restoring');
    return stories;
  };
  const write = async <T,>(work: () => Promise<T>) => {
    const epoch = current();
    const result = await runBackupRestoreDataEpochCommit(epoch, work);
    if (disposed || !result.committed || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('theater-restoring');
    return result.value;
  };
  const setup = new TheaterSetupSession({ load: read,
    save: (...args) => write(() => repository.save(...args)),
    rename: (...args) => write(() => repository.rename(...args)),
  }, story => { navigation++; update({ tab: 'chat', storyId: story.id }); });
  // Setup actions also originate in history cards (copy, edit, new, draft save).
  const unsubscribe = setup.subscribe(() => {
    const current = setup.getSnapshot();
    if (current.editor) { navigation++; update({ tab: 'setup' }); }
    else if (state.tab === 'setup' && !current.saving) update({ tab: 'history' });
    if (state.storyId && !current.loading && !current.loadError && !current.saving
      && !current.stories.some(story => story.id === state.storyId)) update({ storyId: null, tab: 'history' });
  });
  const openStory = (binding: TheaterBinding) => setup.requestLeave(() => {
    const request = ++navigation;
    void branch.branches.open(binding.storyId).then(() => {
      if (disposed || request !== navigation || branch.branches.getSnapshot().detail?.story.id !== binding.storyId) return;
      branch.branches.switchBranch(binding.branchId);
      update({ storyId: binding.storyId, tab: 'chat' });
    });
  });
  const selectTab = (tab: Tab) => {
    navigation++;
    if (tab === 'setup') {
      if (setup.getSnapshot().editor) { update({ tab }); return; }
      const story = setup.getSnapshot().stories.find(value => value.id === state.storyId);
      if (story) setup.editStory(story); else setup.newStory();
      return;
    }
    setup.requestLeave(() => {
      setup.history();
      update({ tab: tab === 'chat' && !state.storyId ? 'history' : tab });
    });
  };
  return { ...branch, setup, backstageOwner: backstage, openStory, selectTab,
    async invalidateForRestore() {
      await Promise.all([backstage.invalidateForRestore(), branch.reading.reset()]);
    },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    dispose() {
      disposed = true; unsubscribe(); listeners.clear(); branch.dispose(); backstage.dispose();
    },
  };
}

export type TheaterFeatureRuntime = ReturnType<typeof createTheaterFeatureRuntime>;
