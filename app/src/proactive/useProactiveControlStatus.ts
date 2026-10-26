import { useEffect, useState } from 'react';
import { getProactiveDeviceControl } from './proactiveDeviceControl';
import type { ProactiveControlTechnicalState } from './proactiveControlPresentation';

function read(): ProactiveControlTechnicalState | null {
  const state = getProactiveDeviceControl()?.snapshot();
  return state ? { contactDeviceId: state.current?.state === 'started' ? state.current.ownerDeviceId : state.routeDeviceId,
    used: state.used, day: state.day, waitReason: state.waitReason ?? 'ready', participants: state.participants } : null;
}
/** Reads in-memory technical metadata only; mounting never starts a source or model. */
export function useProactiveControlStatus() {
  const [state, setState] = useState(read);
  useEffect(() => { const timer = setInterval(() => setState(read()), 5000); return () => clearInterval(timer); }, []);
  return state;
}
