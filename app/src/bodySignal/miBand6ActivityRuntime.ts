import { AppState } from 'react-native';
import { pruneBodySignalActivityHistory } from './bodySignalActivityStore';
import { getColmiConnectionSnapshot, getColmiProviderContext, subscribeColmiConnection } from './colmi/colmiConnection';
import { MI_BAND_6_ACTIVITY_VERIFIED } from './colmi/miBand6ActivityProtocol';
import { readMiBand6Battery } from './miBand6Battery';
import { syncMiBand6ActivityHistory } from './miBand6Activity';

let started = false;
export function startMiBand6ActivityRuntime(): () => void {
  if (started || !MI_BAND_6_ACTIVITY_VERIFIED) return () => undefined;
  started = true;
  const cleanup = () => { void pruneBodySignalActivityHistory().catch(() => undefined); };
  cleanup();
  const foreground = AppState.addEventListener('change', state => { if (state === 'active') cleanup(); });
  let readyKey: string | undefined;
  let previousMeasurement: string | undefined;
  const check = () => {
    const connection = getColmiConnectionSnapshot();
    const profile = getColmiProviderContext()?.profile;
    if (!connection.isConnected) { readyKey = undefined; previousMeasurement = undefined; return; }
    if (profile?.family !== 'mi_band_6' || connection.huami2021AuthStatus !== 'authenticated') return;
    const key = `${profile.id}:${profile.lastConnectedAt}`;
    const measurement = connection.miBand6RealtimeHeartRateSession.status;
    const finished = previousMeasurement === 'stopping' && measurement === 'completed';
    previousMeasurement = measurement;
    if (readyKey === key && !finished) return;
    readyKey = key;
    void readMiBand6Battery({ trigger: 'connected' }).catch(() => undefined).then(() => {
      if (started && readyKey === key) return syncMiBand6ActivityHistory({ trigger: finished ? 'sampling_finished' : 'connected' });
    }).catch(() => undefined);
  };
  const unsubscribe = subscribeColmiConnection(check);
  check();
  return () => { started = false; unsubscribe(); foreground.remove(); };
}
