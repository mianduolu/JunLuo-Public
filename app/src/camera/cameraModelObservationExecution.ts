import type { CameraCaptureSuccessReceipt, CameraCaptureReceipt, CameraSourceKind } from './cameraPerceptionTypes';
import type { CameraObservationPersistInput, CameraObservationRecordV1 } from './cameraObservationTypes';
import type { AnalyzeCameraFrameStructuredOptions, CameraVisionAnalysisSuccessV1 } from './cameraVisionStructured';
import { createCameraModelObservationResult, type CameraModelObservationFailureStage } from './cameraModelObservationMaterials';
import type { JunLuoToolResult } from '../tools/toolTypes';

export const CAMERA_MODEL_OBSERVATION_TIMEOUT_MS = 285_000;
const FRAME_RETENTION_MS = 120_000;

type Attempt = { sessionId: string; attemptId: string; requestId: string; scheduleGeneration: number };
/** Only execution facts cross this seam; Android's native snapshot parser stays unchanged. */
export type CameraObservationExecutionSnapshot = {
  status: string;
  sessionId?: string;
  automaticObservation: {
    enabled: boolean; phase: string; scheduleGeneration: number;
    activeAttemptId?: string; activeRequestId?: string;
  };
};
type CommandReceipt = { ok: boolean; failureCode?: string };
export type CameraModelObservationExecutionPorts = {
  now(): number;
  newRequestId(): string;
  isCurrent(): boolean;
  ready(requiresNewFrame?: boolean): Promise<boolean>;
  snapshot(): Promise<CameraObservationExecutionSnapshot>;
  subscribe(listener: (snapshot: CameraObservationExecutionSnapshot) => void): (() => void);
  claim(attempt: Attempt): Promise<CommandReceipt>;
  retry(attempt: Attempt, nextRequestId?: string): Promise<CommandReceipt>;
  capture(attempt: Attempt): Promise<CameraCaptureReceipt>;
  acceptsSource?(sourceKind: CameraSourceKind): boolean;
  cancel(attempt: Attempt): Promise<unknown>;
  release(frame: CameraCaptureSuccessReceipt): Promise<{ released: boolean; deletionVerified: boolean; auditPersisted: boolean }>;
  readFrame(frame: CameraCaptureSuccessReceipt): Promise<string>;
  analyze(frame: CameraCaptureSuccessReceipt, image: string, options: Pick<AnalyzeCameraFrameStructuredOptions,
    'signal' | 'beforeAttempt' | 'attemptTimeoutMs'>): Promise<CameraVisionAnalysisSuccessV1>;
  beforeTransport(requestId: string, signal: AbortSignal): Promise<void>;
  persist(input: CameraObservationPersistInput, signal: AbortSignal): Promise<CameraObservationRecordV1>;
  findCommitted(actionId: string): Promise<CameraObservationRecordV1 | null>;
  complete(attempt: Attempt, result: { observation?: CameraObservationRecordV1; failureCode?: string; prerequisiteBlocked?: boolean }): Promise<CommandReceipt>;
};

/** One selected tool invocation. This is not a timer, queue, or manual UI action. */
export async function executeCameraModelObservation(input: {
  callId: string;
  sessionId: string;
  scheduleGeneration: number;
  signal?: AbortSignal;
  /** A real, current manual click; this does not enable session standby. */
  manualClick?: boolean;
}, ports: CameraModelObservationExecutionPorts): Promise<JunLuoToolResult> {
  const startedAt = ports.now();
  const attempt: Attempt = { ...input, attemptId: input.callId, requestId: ports.newRequestId() };
  const controller = new AbortController();
  let timedOut = false;
  let invalidated = false;
  let claimed = false;
  let completing = false;
  let retryUsed = false;
  let blocked = false;
  let stage: CameraModelObservationFailureStage = 'availability';
  let frame: CameraCaptureSuccessReceipt | undefined;
  let image = '';
  let analysis: CameraVisionAnalysisSuccessV1 | undefined;
  let persistInput: CameraObservationPersistInput | undefined;
  let visionRequests = 0;
  let failureCode = 'camera_observation_failed';
  let frameExpiry: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    controller.abort();
    if (claimed) void ports.cancel(attempt).catch(() => undefined);
  };
  if (input.signal?.aborted) abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; abort(); }, CAMERA_MODEL_OBSERVATION_TIMEOUT_MS);
  const unsubscribe = ports.subscribe(snapshot => {
    if (!claimed || completing) return;
    if (!matches(snapshot)) { invalidated = true; abort(); }
  });
  function matches(snapshot: CameraObservationExecutionSnapshot) {
    const state = snapshot.automaticObservation;
    return snapshot.status === 'running' && snapshot.sessionId === attempt.sessionId && (state.enabled || input.manualClick === true)
      && state.scheduleGeneration === attempt.scheduleGeneration && state.phase === 'executing'
      && state.activeAttemptId === attempt.attemptId && state.activeRequestId === attempt.requestId;
  }
  async function assertCurrent() {
    if (controller.signal.aborted || !ports.isCurrent()) throw new Error('camera_vision_cancelled');
    if (claimed && !matches(await ports.snapshot())) {
      invalidated = true; abort(); throw new Error('camera_vision_cancelled');
    }
  }
  function checkReceipt(receipt: CommandReceipt) {
    if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_invalid_bridge_payload');
  }
  async function releaseFrame() {
    if (!frame) return;
    const released = await ports.release(frame);
    if (!released.deletionVerified || !released.released) throw new Error('camera_frame_cleanup_failed');
    frame = undefined; image = '';
    if (frameExpiry) clearTimeout(frameExpiry);
    frameExpiry = undefined;
    return released;
  }
  async function claimRetry(nextRequestId?: string) {
    if (retryUsed) throw new Error('camera_automatic_retry_not_available');
    await assertCurrent();
    if (!await ports.ready(Boolean(nextRequestId))) { blocked = true; throw new Error('camera_observation_prerequisite'); }
    const previousRequest = attempt.requestId;
    // Native publishes before its promise resolves; accept exactly this prospective request.
    if (nextRequestId) attempt.requestId = nextRequestId;
    try { checkReceipt(await ports.retry({ ...attempt, requestId: previousRequest }, nextRequestId)); }
    catch (error) { attempt.requestId = previousRequest; throw error; }
    retryUsed = true;
  }
  function result(outcome: { status: 'success'; record: CameraObservationRecordV1 } | { status: 'error' | 'cancelled' }) {
    const base = { callId: input.callId, startedAt, finishedAt: ports.now() };
    if (outcome.status === 'success') return createCameraModelObservationResult({ ...base, ...outcome, retryUsed });
    if (outcome.status === 'cancelled') return createCameraModelObservationResult({ ...base, status: 'cancelled' });
    return createCameraModelObservationResult({ ...base, status: 'error', retryUsed, failureStage: stage });
  }
  try {
    await assertCurrent();
    if (!await ports.ready(true)) return result({ status: 'error' });
    const existing = await ports.findCommitted(input.callId);
    await assertCurrent();
    if (existing) return result({ status: 'success', record: existing });
    checkReceipt(await ports.claim(attempt));
    claimed = true;
    await assertCurrent();
    for (;;) {
      try {
        if (!analysis) {
          if (!frame) {
            stage = 'capture';
            await assertCurrent();
            if (!await ports.ready(true)) { blocked = true; throw new Error('camera_observation_prerequisite'); }
            const captured = await ports.capture(attempt);
            if (captured.captureSucceeded === false) throw new Error(captured.failureCode);
            frame = captured;
            if (!(ports.acceptsSource?.(frame.sourceKind) ?? (frame.sourceKind === 'android_front' || frame.sourceKind === 'android_back'))) {
              blocked = true;
              throw new Error('camera_invalid_bridge_payload');
            }
          }
          if (!image) image = await ports.readFrame(frame);
          stage = 'vision';
          const remaining = frame.capturedAt + FRAME_RETENTION_MS - ports.now();
          if (remaining <= 0) throw new Error('camera_frame_expired');
          const visionController = new AbortController();
          const abortVision = () => visionController.abort();
          controller.signal.addEventListener('abort', abortVision, { once: true });
          frameExpiry = setTimeout(abortVision, remaining);
          try {
            analysis = await ports.analyze(frame, image, {
              signal: visionController.signal,
              // Leave time for the shared supplement and final cleanup; manual limits are unchanged.
              attemptTimeoutMs: Math.min(100_000, remaining),
              beforeAttempt: async number => {
                await assertCurrent();
                if (visionController.signal.aborted) throw new Error('camera_frame_expired');
                if (number === 2) await claimRetry();
                if (visionRequests >= 2) throw new Error('camera_automatic_retry_not_available');
                try { await ports.beforeTransport(`${input.callId}:vision:${visionRequests + 1}`, visionController.signal); }
                catch (error) { blocked = true; throw error; }
                visionRequests += 1;
              },
            });
          } finally {
            controller.signal.removeEventListener('abort', abortVision);
            if (frameExpiry) clearTimeout(frameExpiry);
            frameExpiry = undefined;
          }
          await assertCurrent();
        }
        if (!persistInput) {
          stage = 'cleanup';
          const captured = frame!;
          const analyzedAt = ports.now();
          const release = await releaseFrame();
          await assertCurrent();
          persistInput = {
            actionId: input.callId, requestId: attempt.requestId, sessionId: attempt.sessionId,
            triggerKind: input.manualClick ? 'manual_look' : 'action_opportunity', sourceKind: captured.sourceKind as CameraObservationRecordV1['sourceKind'],
            capturedAt: captured.capturedAt, analyzedAt,
            capture: { width: captured.width, height: captured.height, rotation: captured.rotation, mirrored: captured.mirrored },
            analysis: { provider: analysis.provider, model: analysis.model, latencyMs: analysis.latencyMs,
              attemptCount: Math.max(analysis.attemptCount, visionRequests) as 1 | 2,
              repairUsed: analysis.repairUsed, responseFormatRequested: analysis.responseFormatRequested },
            result: analysis.result,
            cleanup: { cleanupState: 'verified_deleted', deletionVerified: true, completedAt: ports.now(), auditPersisted: release!.auditPersisted },
          };
        }
        stage = 'persistence';
        await assertCurrent();
        const observation = await ports.persist(persistInput, controller.signal);
        await assertCurrent();
        completing = true;
        checkReceipt(await ports.complete(attempt, { observation }));
        return result({ status: 'success', record: observation });
      } catch (error) {
        failureCode = error instanceof Error && error.message.startsWith('camera_') ? error.message : 'camera_observation_failed';
        if (failureCode === 'camera_low_battery' || failureCode === 'camera_thermal_paused') blocked = true;
        if (controller.signal.aborted || invalidated || !ports.isCurrent()) break;
        if (completing || blocked || stage === 'cleanup') break;
        if (stage === 'persistence') {
          const committed = await ports.findCommitted(input.callId);
          await assertCurrent();
          if (committed) {
            completing = true;
            checkReceipt(await ports.complete(attempt, { observation: committed }));
            return result({ status: 'success', record: committed });
          }
        }
        // Looking up an uncertain commit does not spend another attempt.
        if (retryUsed) break;
        const needsFrame = !analysis && (!frame || ports.now() >= frame.capturedAt + FRAME_RETENTION_MS);
        if (needsFrame && frame) {
          stage = 'cleanup';
          await releaseFrame();
        }
        await claimRetry(needsFrame ? ports.newRequestId() : undefined);
      }
    }
  } catch (error) {
    failureCode = error instanceof Error && error.message.startsWith('camera_') ? error.message : 'camera_observation_failed';
    if (failureCode === 'camera_low_battery' || failureCode === 'camera_thermal_paused') blocked = true;
  } finally {
    clearTimeout(timer);
    if (frameExpiry) clearTimeout(frameExpiry);
    input.signal?.removeEventListener('abort', abort);
    unsubscribe();
    try { await releaseFrame(); } catch { stage = 'cleanup'; failureCode = 'camera_frame_cleanup_failed'; }
    image = '';
  }
  if (claimed && !invalidated) {
    completing = true;
    await ports.complete(attempt, { failureCode, prerequisiteBlocked: blocked }).catch(() => undefined);
  }
  return result({ status: (input.signal?.aborted || invalidated || !ports.isCurrent()) && !timedOut ? 'cancelled' : 'error' });
}
