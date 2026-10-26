import { useEffect, useRef, useState } from 'react';

export const SETTINGS_READ_TIMEOUT_MS = 8_000;

export function withSettingsTimeout<T>(task: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([task, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export type SettingsReadState = { loaded: boolean; loading: boolean; failed: boolean };

// These are read-only panels. Timing out stops waiting, not the underlying storage operation.
export function useSettingsRead<T>(enabled: boolean, read: () => Promise<T>, apply: (value: T) => void) {
  const [state, setState] = useState<SettingsReadState>({ loaded: false, loading: true, failed: false });
  const current = useRef({ active: false, request: 0, loaded: false, read, apply });
  current.current.read = read;
  current.current.apply = apply;

  const refresh = async () => {
    const ref = current.current;
    if (!ref.active) return;
    const request = ++ref.request;
    setState({ loaded: ref.loaded, loading: true, failed: false });
    try {
      const result = await withSettingsTimeout(ref.read(), SETTINGS_READ_TIMEOUT_MS, '设置资料读取超时');
      if (!ref.active || request !== ref.request) return;
      ref.apply(result);
      ref.loaded = true;
      setState({ loaded: true, loading: false, failed: false });
    } catch {
      if (ref.active && request === ref.request) {
        setState({ loaded: ref.loaded, loading: false, failed: true });
      }
    }
  };
  const invalidate = () => {
    const ref = current.current;
    ref.request += 1;
    if (ref.active) setState({ loaded: ref.loaded, loading: false, failed: false });
  };
  const accept = (value: T) => {
    const ref = current.current;
    ref.request += 1;
    if (!ref.active) return;
    ref.apply(value);
    ref.loaded = true;
    setState({ loaded: true, loading: false, failed: false });
  };

  useEffect(() => {
    current.current.active = enabled;
    if (enabled) void refresh();
    return () => {
      current.current.active = false;
      current.current.request += 1;
    };
  }, [enabled]);
  return { state, refresh, invalidate, accept };
}
