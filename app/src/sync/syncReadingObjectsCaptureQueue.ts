let readingObjectsCaptureQueue = Promise.resolve();
let readingObjectsStorageCaptureEnabled = false;

export function isReadingObjectsStorageCaptureEnabled() {
  return readingObjectsStorageCaptureEnabled;
}

export function enableReadingObjectsStorageCapture() {
  readingObjectsStorageCaptureEnabled = true;
}

export function disableReadingObjectsStorageCaptureForTests() {
  readingObjectsStorageCaptureEnabled = false;
}

export function runReadingObjectsCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = readingObjectsCaptureQueue
    .catch(() => undefined)
    .then(callback);
  readingObjectsCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
