import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { getProactiveDeviceControl } from './proactiveDeviceControl';
import type { ProactiveControlTechnicalState } from './proactiveControlPresentation';
import { loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { readUnifiedContactState } from './unifiedContactStore';
import { contactLocalDay } from './unifiedContact';

function read(): ProactiveControlTechnicalState | null {
  const state = getProactiveDeviceControl()?.snapshot();
  return state ? { contactDeviceId: state.current?.state === 'started' ? state.current.ownerDeviceId : state.routeDeviceId,
    used: state.used, day: state.day, waitReason: state.waitReason ?? 'ready', participants: state.participants } : null;
}
async function readPhone(): Promise<ProactiveControlTechnicalState> {
  const pending = { contactDeviceId: null, used: null, day: null,
    waitReason: 'phone-primary-handover-pending', participants: [] };
  if (!await loadPhonePrimaryActivation()) return pending;
  const local = await readUnifiedContactState();
  const day = contactLocalDay(Date.now());
  return { ...pending, day, used: local.day === day ? local.used : 0, waitReason: 'phone-primary-ready' };
}
/** Pure status reads only; mounting never activates a runtime, source or model. */
export function useProactiveControlStatus() {
  const [state, setState] = useState<ProactiveControlTechnicalState | null>(Platform.OS === 'android' ? null : read);
  useEffect(() => {
    let mounted = true, reading = false;
    const refresh = async () => {
      if (reading) return;
      reading = true;
      try {
        const next = Platform.OS === 'android' ? await readPhone() : read();
        if (mounted) setState(next);
      } catch { if (mounted) setState(null); }
      finally { reading = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 5000);
    return () => { mounted = false; clearInterval(timer); };
  }, []);
  return state;
}
