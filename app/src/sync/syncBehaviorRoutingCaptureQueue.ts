let behaviorRoutingCaptureQueue = Promise.resolve();

export function runBehaviorRoutingCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = behaviorRoutingCaptureQueue
    .catch(() => undefined)
    .then(callback);
  behaviorRoutingCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
