let togetherWalkedLifeCaptureQueue = Promise.resolve();
let togetherWalkedLifeStorageCaptureEnabled = false;

export function isTogetherWalkedLifeStorageCaptureEnabled() {
  return togetherWalkedLifeStorageCaptureEnabled;
}

export function enableTogetherWalkedLifeStorageCapture() {
  togetherWalkedLifeStorageCaptureEnabled = true;
}

export function disableTogetherWalkedLifeStorageCaptureForTests() {
  togetherWalkedLifeStorageCaptureEnabled = false;
}

export function runTogetherWalkedLifeCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = togetherWalkedLifeCaptureQueue
    .catch(() => undefined)
    .then(callback);
  togetherWalkedLifeCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
