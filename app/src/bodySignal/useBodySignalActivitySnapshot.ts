import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { subscribeGuardianActivitySaved } from './bodySignalGuardianRuntime';
import { loadBodySignalActivityOverview, type BodySignalActivityOverview } from './bodySignalActivityOverview';

export function useBodySignalActivitySnapshot(deviceProfileId?: string, options: { readOnly?: boolean; clock?: number } = {}) {
  const readOnly = Boolean(options.readOnly);
  const [state, setState] = useState<{ requestedId?: string; readOnly?: boolean;
    data?: BodySignalActivityOverview; loading: boolean; error?: string }>({ loading: true });
  const [retryCount, setRetryCount] = useState(0);
  // The owning page supplies its existing clock; this hook starts no polling timer.
  const clockDate = options.clock === undefined ? undefined : new Date(options.clock);
  const localDay = readOnly && clockDate ? `${clockDate.toDateString()}:${clockDate.getTimezoneOffset()}` : undefined;
  useEffect(() => {
    let alive = true;
    let running = false;
    let requestedAgain = false;
    setState(previous => ({ requestedId: deviceProfileId, readOnly,
      data: previous.requestedId === deviceProfileId && previous.readOnly === readOnly ? previous.data : undefined, loading: true }));
    const refresh = async () => {
      if (!alive) return;
      if (running) { requestedAgain = true; return; }
      running = true;
      try {
        do {
          requestedAgain = false;
          try {
            const data = await loadBodySignalActivityOverview(deviceProfileId, { readOnly });
            if (alive) setState({ requestedId: deviceProfileId, readOnly, data, loading: false });
          } catch {
            if (alive) setState(previous => ({ ...previous, loading: false, error: '活动记录暂时读取失败' }));
          }
        } while (alive && requestedAgain);
      } finally { running = false; }
    };
    const unsubscribe = subscribeGuardianActivitySaved(() => { void refresh(); });
    const foreground = AppState.addEventListener('change', next => { if (next === 'active') void refresh(); });
    void refresh();
    return () => { alive = false; unsubscribe(); foreground.remove(); };
  }, [deviceProfileId, readOnly, retryCount, localDay]);
  const retry = () => setRetryCount(value => value + 1);
  // Effects follow render, so hide the previous device before its next read starts.
  return state.requestedId === deviceProfileId && state.readOnly === readOnly
    ? { data: state.data, loading: state.loading, error: state.error, retry }
    : { data: undefined, loading: true, error: undefined, retry };
}
