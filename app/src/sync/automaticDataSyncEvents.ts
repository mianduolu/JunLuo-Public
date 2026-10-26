const listeners = new Set<() => void>();

export function notifyAutomaticDataSyncWorkAvailable() {
  for (const listener of listeners) listener();
}

export function subscribeAutomaticDataSyncWorkAvailable(
  listener: () => void,
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
