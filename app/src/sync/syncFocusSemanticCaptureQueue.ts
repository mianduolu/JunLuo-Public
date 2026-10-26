let focusSemanticCaptureQueue = Promise.resolve();
let focusSemanticStorageCaptureEnabled = false;

export function enableFocusSemanticStorageCapture() {
  focusSemanticStorageCaptureEnabled = true;
}

export function disableFocusSemanticStorageCapture() {
  focusSemanticStorageCaptureEnabled = false;
}

export function isFocusSemanticStorageCaptureEnabled() {
  return focusSemanticStorageCaptureEnabled;
}

export function runFocusSemanticCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = focusSemanticCaptureQueue
    .catch(() => undefined)
    .then(callback);
  focusSemanticCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
