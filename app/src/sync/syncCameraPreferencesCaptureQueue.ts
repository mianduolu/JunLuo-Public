let cameraPreferencesCaptureQueue = Promise.resolve();

export function runCameraPreferencesCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = cameraPreferencesCaptureQueue
    .catch(() => undefined)
    .then(callback);
  cameraPreferencesCaptureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}
