import { useCallback, useEffect, useRef, useState } from 'react';
import { loadSleepHeartRateSnapshot, subscribeSleepHeartRateChanged } from './sleepHeartRateStore';

type Data = Awaited<ReturnType<typeof loadSleepHeartRateSnapshot>>;
type State = { requestedId?: string; data?: Data; loading: boolean; error?: string };

/** Page actions only read saved samples; accumulation belongs to the existing runtime. */
export function useSleepHeartRateSnapshot(deviceProfileId?: string, refreshSource?: unknown) {
  const [state, setState] = useState<State>({ loading: Boolean(deviceProfileId) });
  const [retryCount, setRetryCount] = useState(0);
  const retry = useCallback(() => setRetryCount(value => value + 1), []);
  const refreshRef = useRef<(() => Promise<void>) | undefined>(undefined);
  const sourceRef = useRef(refreshSource);
  useEffect(() => {
    let alive = true, running = false, requestedAgain = false;
    sourceRef.current = refreshSource;
    refreshRef.current = undefined;
    setState({ requestedId: deviceProfileId, loading: Boolean(deviceProfileId) });
    if (!deviceProfileId) return () => { alive = false; };
    const refresh = async () => {
      if (!alive) return;
      if (running) { requestedAgain = true; return; }
      running = true;
      try {
        do {
          requestedAgain = false;
          try {
            const data = await loadSleepHeartRateSnapshot(deviceProfileId, Date.now());
            if (data.deviceProfileId !== deviceProfileId) throw new Error('profile mismatch');
            if (alive) setState({ requestedId: deviceProfileId, data, loading: false });
          } catch {
            if (alive) setState({ requestedId: deviceProfileId, loading: false,
              error: '睡眠心率记录暂时读取失败，请重试。' });
          }
        } while (alive && requestedAgain);
      } finally { running = false; }
    };
    refreshRef.current = refresh;
    const changed = subscribeSleepHeartRateChanged(() => { void refresh(); });
    void refresh();
    return () => { alive = false; changed(); refreshRef.current = undefined; };
  }, [deviceProfileId, retryCount]);
  // The original sleep snapshot owns foreground, minute and sync-completion refreshes.
  // Reuse its committed snapshot identity, without adding another timer/subscription.
  useEffect(() => {
    if (sourceRef.current !== refreshSource) {
      sourceRef.current = refreshSource;
      void refreshRef.current?.();
    }
  }, [refreshSource]);
  return state.requestedId === deviceProfileId
    ? { data: state.data, loading: state.loading, error: state.error, retry }
    : { data: undefined, loading: Boolean(deviceProfileId), error: undefined, retry };
}
