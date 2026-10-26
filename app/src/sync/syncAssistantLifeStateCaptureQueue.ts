let assistantLifeStateCaptureQueue = Promise.resolve();

export function runAssistantLifeStateCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = assistantLifeStateCaptureQueue
    .catch(() => undefined)
    .then(callback);
  assistantLifeStateCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
