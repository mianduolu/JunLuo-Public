let nearbyWorldHealthCaptureQueue = Promise.resolve();

export function runNearbyWorldHealthCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = nearbyWorldHealthCaptureQueue
    .catch(() => undefined)
    .then(callback);
  nearbyWorldHealthCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
