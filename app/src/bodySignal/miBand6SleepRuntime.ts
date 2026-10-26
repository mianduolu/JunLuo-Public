import { AppState } from 'react-native';
import { subscribeColmiConnection } from './colmi/colmiConnection';
import { subscribeBodySignalGuardianState, subscribeGuardianActivitySaved } from './bodySignalGuardianRuntime';
import { pruneMiBand6SleepHistory } from './miBand6SleepStore';
import { cancelMiBand6SleepSync, syncMiBand6SleepHistory, subscribeMiBand6SleepSync, getMiBand6SleepSyncState } from './miBand6SleepSync';
import { subscribeBodySignalReadingSaved } from './bodySignalStore';
import { refreshSleepHeartRateHistory } from './sleepHeartRateStore';

let started = false;
// Foreground scheduling reuses the existing authenticated owner and read lease.
// Native heart-rate/background behavior is unchanged; no additional service.
export function startMiBand6SleepRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  let queued: ReturnType<typeof setTimeout> | undefined;
  let alive = true, deriving = false, deriveAgain = false;
  let derivation: AbortController | undefined;
  const refreshHeartRate = async () => {
    if (!alive || AppState.currentState !== 'active') return;
    if (deriving) { deriveAgain = true; return; }
    deriving = true;
    try {
      do {
        deriveAgain = false;
        derivation = new AbortController();
        await refreshSleepHeartRateHistory(Date.now(), derivation.signal).catch(() => undefined);
      } while (alive && deriveAgain && AppState.currentState === 'active');
    } finally { deriving = false; derivation = undefined; }
  };
  const check = () => {
    if (!started || AppState.currentState !== 'active' || queued) return;
    queued = setTimeout(() => {
      queued = undefined;
      if (started && AppState.currentState === 'active') void syncMiBand6SleepHistory('automatic').catch(() => undefined);
    }, 2_000);
  };
  const cleanup = () => { void pruneMiBand6SleepHistory().catch(() => undefined).then(refreshHeartRate); };
  const unsubscribeHeartRate = subscribeBodySignalReadingSaved(reading => {
    if (reading.kind === 'heart_rate') void refreshHeartRate();
  });
  const unsubscribeSleep = subscribeMiBand6SleepSync(() => {
    if (!getMiBand6SleepSyncState().busy) void refreshHeartRate();
  });
  const unsubscribeConnection = subscribeColmiConnection(check);
  const unsubscribeGuardian = subscribeBodySignalGuardianState(check);
  const unsubscribeSaved = subscribeGuardianActivitySaved(check);
  const foreground = AppState.addEventListener('change', next => {
    if (next === 'active') { cleanup(); check(); }
    else { if (queued) clearTimeout(queued); queued = undefined; cancelMiBand6SleepSync(); derivation?.abort(); deriveAgain = false; }
  });
  const timer = setInterval(check, 60_000);
  cleanup(); check();
  return () => {
    started = false;
    alive = false; derivation?.abort(); unsubscribeHeartRate(); unsubscribeSleep();
    if (queued) clearTimeout(queued);
    clearInterval(timer); foreground.remove(); unsubscribeConnection(); unsubscribeGuardian(); unsubscribeSaved();
    cancelMiBand6SleepSync();
  };
}
