let relationshipAuthorizationCaptureQueue = Promise.resolve();

export function runRelationshipAuthorizationCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = relationshipAuthorizationCaptureQueue
    .catch(() => undefined)
    .then(callback);
  relationshipAuthorizationCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
