import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { subscribeBodySignalGuardianState, subscribeGuardianActivitySaved } from './bodySignalGuardianRuntime';
import { subscribeColmiConnection } from './colmi/colmiConnection';
import { getMiBand6SleepConnection } from './miBand6SleepInspection';
import { getMiBand6ActivitySyncState, syncMiBand6ActivityHistory } from './miBand6Activity';
import { miBand6ActivityError } from './colmi/miBand6ActivityProtocol';
import { getMiBand6SleepSyncState, miBand6SleepSyncError, subscribeMiBand6SleepSync, syncMiBand6SleepHistory } from './miBand6SleepSync';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';

/** Status reads only. The two explicit actions below are the only device-reading calls. */
export function useBodyDataSync() {
  const [target, setTarget] = useState<string>();
  const [activity, setActivity] = useState<Awaited<ReturnType<typeof getMiBand6ActivitySyncState>>>();
  const [sleep, setSleep] = useState(getMiBand6SleepSyncState);
  const [busy, setBusy] = useState<'activity' | 'sleep'>();
  const [errors, setErrors] = useState<{ activity?: string; sleep?: string }>({});
  const [activityStatusError, setActivityStatusError] = useState<string>();
  const inFlight = useRef(false);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const connectionRef = useRef<Awaited<ReturnType<typeof getMiBand6SleepConnection>> | undefined>(undefined);
  const activityRef = useRef<typeof activity>(undefined);
  const statusReady = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    let alive = true, version = 0;
    const acceptConnection = (connection?: Awaited<ReturnType<typeof getMiBand6SleepConnection>>) => {
      if (connectionRef.current?.connectionKey !== connection?.connectionKey) {
        generation.current++; setErrors({}); setBusy(undefined);
      }
      connectionRef.current = connection;
      setTarget(connection?.deviceProfileId);
    };
    const refresh = async () => {
      if (!alive) return;
      const mine = ++version, epoch = captureBackupRestoreDataEpoch();
      statusReady.current = false;
      setTarget(undefined);
      setActivityStatusError(undefined);
      setActivity(undefined); activityRef.current = undefined;
      if (!canCommitBackupRestoreDataEpoch(epoch)) { acceptConnection(); return; }
      try {
        const connection = await getMiBand6SleepConnection();
        // Activity support/status is independent from the existing sleep capability.
        let statusFailure: string | undefined;
        const next = await getMiBand6ActivitySyncState().catch((error: unknown) => {
          statusFailure = error instanceof Error ? error.message : 'activity_transfer_failed';
          return undefined;
        });
        if (alive && mine === version && canCommitBackupRestoreDataEpoch(epoch)) {
          acceptConnection(connection);
          const currentActivity = next?.deviceProfileId && next.deviceProfileId !== connection.deviceProfileId ? undefined : next;
          setActivity(currentActivity); activityRef.current = currentActivity;
          setActivityStatusError(statusFailure ? miBand6ActivityError(statusFailure)
            : currentActivity && currentActivity.formallyVerified !== true ? miBand6ActivityError('activity_update_required') : undefined);
          setSleep(getMiBand6SleepSyncState());
          statusReady.current = true;
        }
      } catch { if (alive && mine === version && canCommitBackupRestoreDataEpoch(epoch)) acceptConnection(); }
    };
    refreshRef.current = refresh;
    const guardian = subscribeBodySignalGuardianState(() => { void refresh(); });
    const connection = subscribeColmiConnection(() => { void refresh(); });
    const saved = subscribeGuardianActivitySaved(() => { void refresh(); });
    const synced = subscribeMiBand6SleepSync(() => { if (alive) setSleep(getMiBand6SleepSyncState()); void refresh(); });
    const foreground = AppState.addEventListener('change', state => { if (state === 'active') void refresh(); });
    const restored = subscribeBackupRestoreRuntimeState(() => { generation.current++; setErrors({}); setBusy(undefined); void refresh(); });
    void refresh();
    return () => { alive = false; version++; generation.current++; refreshRef.current = undefined; connectionRef.current = undefined; statusReady.current = false;
      guardian(); connection(); saved(); synced(); restored(); foreground.remove(); };
  }, []);
  const sync = async (kind: 'activity' | 'sleep', profileId?: string) => {
    const epoch = captureBackupRestoreDataEpoch(), expected = connectionRef.current;
    const occupied = () => getMiBand6SleepSyncState().busy || activityRef.current?.status === 'syncing'
      || activityRef.current?.status === 'pending_save';
    if (inFlight.current || !statusReady.current || !profileId || profileId !== target || expected?.deviceProfileId !== profileId
      || !canCommitBackupRestoreDataEpoch(epoch) || occupied()
      || kind === 'activity' && activityRef.current?.formallyVerified !== true) return;
    inFlight.current = true;
    const mine = generation.current;
    const current = () => mine === generation.current && canCommitBackupRestoreDataEpoch(epoch)
      && connectionRef.current?.connectionKey === expected.connectionKey;
    setBusy(kind); setErrors(previous => ({ ...previous, [kind]: undefined }));
    try {
      const connection = await getMiBand6SleepConnection();
      if (!current() || !statusReady.current) return;
      if (connection.deviceProfileId !== profileId || connection.connectionKey !== expected.connectionKey) {
        await refreshRef.current?.(); return;
      }
      if (occupied()) return;
      if (kind === 'activity') await syncMiBand6ActivityHistory({ trigger: 'manual', deviceProfileId: profileId });
      else await syncMiBand6SleepHistory('manual', profileId);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (current()) setErrors(previous => ({ ...previous,
        [kind]: kind === 'activity' ? miBand6ActivityError(code) : miBand6SleepSyncError(code) }));
    } finally {
      inFlight.current = false;
      if (current()) { setBusy(undefined); await refreshRef.current?.(); }
    }
  };
  const visibleErrors = { ...errors };
  if (!visibleErrors.activity && activityStatusError) visibleErrors.activity = activityStatusError;
  if (!visibleErrors.activity && activity?.lastErrorCode) visibleErrors.activity = miBand6ActivityError(activity.lastErrorCode);
  if (!visibleErrors.sleep && sleep.deviceProfileId === target && sleep.error) visibleErrors.sleep = miBand6SleepSyncError(sleep.error);
  return { target, activity, sleep: { ...sleep, error: sleep.deviceProfileId === target ? sleep.error : undefined }, busy,
    errors: visibleErrors, sync };
}
