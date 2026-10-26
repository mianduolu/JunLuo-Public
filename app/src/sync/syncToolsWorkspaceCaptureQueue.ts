let toolsWorkspaceCaptureQueue = Promise.resolve();

export function runToolsWorkspaceCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = toolsWorkspaceCaptureQueue
    .catch(() => undefined)
    .then(callback);
  toolsWorkspaceCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
