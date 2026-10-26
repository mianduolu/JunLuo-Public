let wishPoolLifeCaptureQueue = Promise.resolve();

export function runWishPoolLifeCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = wishPoolLifeCaptureQueue
    .catch(() => undefined)
    .then(callback);
  wishPoolLifeCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
