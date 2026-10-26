import { notifyAutomaticDataSyncWorkAvailable } from '../sync/automaticDataSyncEvents';

const listeners = new Set<() => void>();

export function subscribeGiftChanges(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitGiftChanges() {
  notifyAutomaticDataSyncWorkAvailable();
  for (const listener of listeners) {
    try { listener(); } catch { /* A detached page cannot roll back a stored gift. */ }
  }
}
