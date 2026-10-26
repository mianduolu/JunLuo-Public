let readingWorkspaceCaptureQueue = Promise.resolve();
let readingWorkspaceStorageCaptureEnabled = false;

export function enableReadingWorkspaceStorageCapture() {
  readingWorkspaceStorageCaptureEnabled = true;
}

export function disableReadingWorkspaceStorageCapture() {
  readingWorkspaceStorageCaptureEnabled = false;
}

export function isReadingWorkspaceStorageCaptureEnabled() {
  return readingWorkspaceStorageCaptureEnabled;
}

export function runReadingWorkspaceCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = readingWorkspaceCaptureQueue
    .catch(() => undefined)
    .then(callback);
  readingWorkspaceCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
