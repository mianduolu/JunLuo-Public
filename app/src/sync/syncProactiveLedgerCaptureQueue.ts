let proactiveLedgerCaptureQueue = Promise.resolve();

export function runProactiveLedgerCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = proactiveLedgerCaptureQueue
    .catch(() => undefined)
    .then(callback);
  proactiveLedgerCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
