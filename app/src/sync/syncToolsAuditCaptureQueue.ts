let toolsAuditCaptureQueue = Promise.resolve();

export function runToolsAuditCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = toolsAuditCaptureQueue
    .catch(() => undefined)
    .then(callback);
  toolsAuditCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
