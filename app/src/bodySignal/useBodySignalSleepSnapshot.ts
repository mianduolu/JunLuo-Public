import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';
import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';
import { buildBodySignalSleepSummary, type BodySignalSleepSummary } from './bodySignalSleepSummary';
import { loadMiBand6SleepHistory } from './miBand6SleepStore';
import { getMiBand6SleepSyncState, subscribeMiBand6SleepSync } from './miBand6SleepSync';

type Snapshot = {
  requestedId?: string;
  data?: BodySignalSleepSummary;
  devices: BodySignalDeviceProfile[];
  loading: boolean;
  error?: string;
};

/** A local-only view: all BLE reads remain owned by the existing sync action. */
export function useBodySignalSleepSnapshot(deviceProfileId?: string, clock?: number) {
  const [state, setState] = useState<Snapshot>({ devices: [], loading: true });
  const [retryCount, setRetryCount] = useState(0);
  const retry = useCallback(() => setRetryCount(value => value + 1), []);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const externalClock = clock !== undefined;
  useEffect(() => {
    let alive = true, running = false, requestedAgain = false;
    setState(previous => ({ requestedId: deviceProfileId, devices: previous.devices, loading: true }));
    const refresh = async () => {
      if (!alive) return;
      if (running) { requestedAgain = true; return; }
      running = true;
      try {
        do {
          requestedAgain = false;
          try {
            const epoch = captureBackupRestoreDataEpoch();
            if (epoch === null) throw new Error('restore in progress');
            const devices = (await loadPersistedBodySignalDeviceProfiles()).filter(item => item.family === 'mi_band_6');
            if (!alive) return;
            const profile = deviceProfileId ? devices.find(item => item.id === deviceProfileId) : devices.find(item => item.isPrimary) ?? devices[0];
            // A removed/changed profile must disappear before its replacement read finishes.
            setState(previous => ({ requestedId: deviceProfileId, devices, loading: Boolean(profile),
              data: previous.data?.deviceProfileId === profile?.id ? previous.data : undefined }));
            const now = Date.now();
            const data = profile ? buildBodySignalSleepSummary(await loadMiBand6SleepHistory(profile.id, now), profile.id, now) : undefined;
            if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('restore changed');
            if (alive) setState({ requestedId: deviceProfileId, devices, data, loading: false });
          } catch {
            if (alive) setState(previous => ({ requestedId: deviceProfileId, devices: previous.devices,
              loading: false, error: '睡眠记录暂时读取失败，请重试。' }));
          }
        } while (alive && requestedAgain);
      } finally { running = false; }
    };
    const unsubscribe = subscribeMiBand6SleepSync(() => {
      if (!getMiBand6SleepSyncState().busy) void refresh();
    });
    const foreground = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    refreshRef.current = refresh;
    const restored = subscribeBackupRestoreRuntimeState(() => {
      setState({ requestedId: deviceProfileId, devices: [], loading: true });
      void refresh();
    });
    const timer = externalClock ? undefined : setInterval(() => { if (AppState.currentState === 'active') void refresh(); }, 60_000);
    void refresh();
    return () => { alive = false; unsubscribe(); restored(); foreground.remove(); clearInterval(timer); refreshRef.current = undefined; };
  }, [deviceProfileId, retryCount, externalClock]);
  const previousClock = useRef(clock);
  useEffect(() => {
    if (previousClock.current !== clock) { previousClock.current = clock; void refreshRef.current?.(); }
  }, [clock]);
  // Effects run after render: mask the old profile even on that first changed render.
  return state.requestedId === deviceProfileId
    ? { data: state.data, devices: state.devices, loading: state.loading, error: state.error, retry }
    : { data: undefined, devices: state.devices, loading: true, error: undefined, retry };
}
