let lettersLifeCaptureQueue = Promise.resolve();

export function runLettersLifeCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = lettersLifeCaptureQueue
    .catch(() => undefined)
    .then(callback);
  lettersLifeCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
