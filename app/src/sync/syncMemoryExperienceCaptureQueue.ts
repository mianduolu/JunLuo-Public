let memoryExperienceCaptureQueue = Promise.resolve();

export function runMemoryExperienceCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = memoryExperienceCaptureQueue
    .catch(() => undefined)
    .then(callback);
  memoryExperienceCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
