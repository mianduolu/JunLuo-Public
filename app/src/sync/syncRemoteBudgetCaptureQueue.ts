let remoteBudgetCaptureQueue = Promise.resolve();

export function runRemoteBudgetCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = remoteBudgetCaptureQueue
    .catch(() => undefined)
    .then(callback);
  remoteBudgetCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
