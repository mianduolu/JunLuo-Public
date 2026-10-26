let chatRelationshipCaptureQueue = Promise.resolve();

export function runChatRelationshipCaptureExclusive<T>(
  task: () => Promise<T>,
) {
  const current = chatRelationshipCaptureQueue
    .catch(() => undefined)
    .then(task);
  chatRelationshipCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
