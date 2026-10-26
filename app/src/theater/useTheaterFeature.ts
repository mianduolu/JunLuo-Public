import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { THEATER_STORY_CAPTURE_SQL } from '../sync/syncTheaterStorySql';
import { getTheaterDatabase } from './theaterStore';
import { migrateTheaterStoryDatabase } from './theaterStoryMigration';
import { createTheaterFeatureRuntime, type TheaterFeatureRuntime } from './theaterFeatureRuntime';
import { createTheaterCoCreationSelectionRuntime } from './theaterCoCreationSelectionRuntime';

type Options = Pick<Parameters<typeof createTheaterFeatureRuntime>[0], 'getModel' | 'mountChat' | 'onBringToChat'>;
type Runtime = TheaterFeatureRuntime & { coCreation: ReturnType<typeof createTheaterCoCreationSelectionRuntime>['session'] };

// Called once by App. Activation is lazy; imports/ordinary home visits do not
// create a story or open/migrate the theater database.
export function useTheaterFeature(options: Options) {
  const latest = useRef(options); latest.current = options;
  const instance = useRef<Runtime | null>(null);
  const requested = useRef(false), visible = useRef(false), alive = useRef(true);
  const flight = useRef<Promise<void> | null>(null);
  const restoreCleanup = useRef<Promise<void>>(Promise.resolve());
  const retryRestoreCleanup = useRef<(() => Promise<void>) | null>(null);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState(false);
  const activate = useCallback(() => {
    requested.current = true;
    if (instance.current || flight.current || !alive.current) return;
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return;
    setError(false);
    const pending = (async () => {
      try {
        try { await restoreCleanup.current; }
        catch {
          if (!retryRestoreCleanup.current) throw new Error('theater-restore-cleanup');
          restoreCleanup.current = retryRestoreCleanup.current();
          await restoreCleanup.current;
        }
        retryRestoreCleanup.current = null;
        const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
          const database = await getTheaterDatabase();
          await migrateTheaterStoryDatabase(database);
          await database.execAsync(THEATER_STORY_CAPTURE_SQL);
          return database;
        });
        if (!alive.current || !result.committed || !canCommitBackupRestoreDataEpoch(epoch)) return;
        const feature = createTheaterFeatureRuntime({ database: result.value, localStorage: AsyncStorage,
          createId: () => `theater-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
          getModel: () => latest.current.getModel(), mountChat: () => latest.current.mountChat(),
          onBringToChat: () => latest.current.onBringToChat(),
        });
        const coCreation = createTheaterCoCreationSelectionRuntime();
        instance.current = { ...feature, coCreation: coCreation.session,
          dispose() { coCreation.dispose(); feature.dispose(); } };
        setRuntime(instance.current);
      } catch {
        if (alive.current && canCommitBackupRestoreDataEpoch(epoch)) setError(true);
      }
    })();
    flight.current = pending;
    void pending.finally(() => { if (flight.current === pending) flight.current = null; });
  }, []);
  useEffect(() => {
    alive.current = true;
    const unsubscribe = subscribeBackupRestoreRuntimeState(state => {
      if (state.status !== 'ready') {
        // The App listener was registered before child listeners. Explicitly
        // clear restored activation before dispose removes their subscriptions.
        if (instance.current) {
          retryRestoreCleanup.current = instance.current.invalidateForRestore;
          restoreCleanup.current = retryRestoreCleanup.current();
        }
        instance.current?.dispose(); instance.current = null; setRuntime(null);
        void restoreCleanup.current.catch(() => { if (alive.current) setError(true); });
      } else if (requested.current) {
        // Wait for a superseded activation to leave the shared restore boundary.
        void (flight.current ?? Promise.resolve()).then(activate);
      }
    });
    return () => {
      alive.current = false; unsubscribe(); instance.current?.dispose(); instance.current = null;
    };
  }, [activate]);
  const setVisible = useCallback((value: boolean) => { visible.current = value; }, []);
  const requestLeave = useCallback((action: () => void) => {
    if (visible.current && instance.current) instance.current.setup.requestLeave(action);
    else action();
  }, []);
  return { runtime, error, activate, setVisible, requestLeave };
}

export type TheaterFeatureController = ReturnType<typeof useTheaterFeature>;
