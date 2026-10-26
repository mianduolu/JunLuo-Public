let vaultSharedSecretsCaptureQueue = Promise.resolve();

export function runVaultSharedSecretsCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = vaultSharedSecretsCaptureQueue
    .catch(() => undefined)
    .then(callback);
  vaultSharedSecretsCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
