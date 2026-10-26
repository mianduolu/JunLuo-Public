export type MemoryProcessingWakeReason =
  | 'memory_changed'
  | 'configuration_changed'
  | 'memory_screen'
  | 'manual_retry'
  | 'app_started'
  | 'app_resumed';

type Listener = (reason: MemoryProcessingWakeReason) => void;

const listeners = new Set<Listener>();
const updateListeners = new Set<() => void>();

// Page refreshes are separate from worker wake-ups, so reading cannot schedule work.
export function notifyMemoryProcessingUpdated() {
  for (const listener of updateListeners) {
    try { listener(); } catch { /* A page must not fail a completed background job. */ }
  }
}

export function subscribeMemoryProcessingUpdates(listener: () => void) {
  updateListeners.add(listener);
  return () => { updateListeners.delete(listener); };
}

export function notifyMemoryProcessingWorkAvailable(reason: MemoryProcessingWakeReason) {
  for (const listener of listeners) {
    try { listener(reason); } catch { /* A notification must not turn a committed write into a failed save. */ }
  }
}

export function subscribeMemoryProcessingWorkAvailable(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
