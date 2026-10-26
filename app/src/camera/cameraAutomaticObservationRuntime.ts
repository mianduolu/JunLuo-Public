import type { runBackupProtectedTask } from '../backup/backupService';
import { cameraPerceptionNative } from './cameraPerceptionNative';
import { cameraPerceptionRuntime } from './cameraPerceptionRuntime';
import type { CameraPerceptionSettings } from './cameraPerceptionSettings';

// Keep the registered name as a no-op for already delivered legacy native tasks.
// Chapter 13 observations must originate from a model-selected tool call.
export async function handleCameraAutomaticObservationHeadlessTask(
  _payload: unknown,
  _runProtectedTask: typeof runBackupProtectedTask,
): Promise<void> {}

export async function syncAutomaticObservationPolicy(
  settings: CameraPerceptionSettings,
  latestSuccessfulObservationAt?: number,
  options: { enabled?: boolean } = {},
) {
  const runtime = cameraPerceptionRuntime.getSnapshot();
  const session = runtime.session;
  const sessionActive = session.status !== 'stopped';
  const enabled = options.enabled ?? (
    sessionActive
    && runtime.nativeSnapshot?.sessionId === session.sessionId
    && runtime.nativeSnapshot.automaticObservation.enabled
  );
  const receipt = await cameraPerceptionNative.updateAutomaticPolicy({
    sessionId: sessionActive ? session.sessionId : undefined,
    enabled,
    minimumIntervalMinutes: settings.minimumIntervalMinutes,
    maximumIntervalMinutes: settings.maximumIntervalMinutes,
    quietHours: { ...settings.quietHours },
    latestSuccessfulObservationAt,
  });
  if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_invalid_bridge_payload');
  await cameraPerceptionRuntime.refresh(true);
  return receipt;
}
