let chatCoreCaptureQueue = Promise.resolve();

export function runChatCoreCaptureExclusive<T>(
  operation: () => Promise<T>,
) {
  const current = chatCoreCaptureQueue.catch(() => undefined).then(operation);
  chatCoreCaptureQueue = current.then(() => undefined, () => undefined);
  return current;
}
