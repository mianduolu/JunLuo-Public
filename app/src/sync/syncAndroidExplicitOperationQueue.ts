let explicitAndroidSyncQueue: Promise<void> = Promise.resolve();

export function enqueueAndroidExplicitSyncOperation<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const next = explicitAndroidSyncQueue.then(operation);
  explicitAndroidSyncQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}
