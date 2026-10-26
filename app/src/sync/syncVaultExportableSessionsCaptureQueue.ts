let vaultExportableSessionsCaptureQueue = Promise.resolve();

export function runVaultExportableSessionsCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = vaultExportableSessionsCaptureQueue
    .catch(() => undefined)
    .then(callback);
  vaultExportableSessionsCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
