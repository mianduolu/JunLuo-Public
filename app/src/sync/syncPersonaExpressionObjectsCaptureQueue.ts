let personaExpressionObjectsCaptureQueue = Promise.resolve();

export function runPersonaExpressionObjectsCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = personaExpressionObjectsCaptureQueue
    .catch(() => undefined)
    .then(callback);
  personaExpressionObjectsCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
