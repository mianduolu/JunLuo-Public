import { getColmiConnectionSnapshot, getColmiProviderContext, subscribeColmiConnection } from './colmi/colmiConnection';
import { readMiBand6Battery } from './miBand6Battery';

let started = false;

// Connection-ready events only; the native store owns cooldowns across both owners.
export function startMiBand6BatteryRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  let readyKey: string | undefined;
  const check = () => {
    const connection = getColmiConnectionSnapshot();
    const profile = getColmiProviderContext()?.profile;
    if (!connection.isConnected) { readyKey = undefined; return; }
    if (profile?.family !== 'mi_band_6' || connection.huami2021AuthStatus !== 'authenticated') return;
    const key = `${profile.id}:${profile.lastConnectedAt}`;
    if (readyKey === key) return;
    readyKey = key;
    void Promise.resolve().then(() => {
      if (started && readyKey === key) return readMiBand6Battery({ trigger: 'connected' });
    }).catch(() => undefined);
  };
  const unsubscribe = subscribeColmiConnection(check);
  check();
  return () => { started = false; unsubscribe(); };
}
