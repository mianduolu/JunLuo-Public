import * as FileSystem from 'expo-file-system/legacy';
import { useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';

import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { persistCameraObservation } from './cameraObservationStore';
import type { CameraObservationResponseBinding } from './cameraObservationTypes';
import { syncAutomaticObservationPolicy } from './cameraAutomaticObservationRuntime';
import { loadCameraPerceptionSettings } from './cameraPerceptionSettings';
import {
  analyzeCameraFrameStructured,
  type CameraVisionAnalysisSuccessV1,
  type CameraVisionTransportDiagnostic,
  type CameraVisionValidationIssue,
} from './cameraVisionStructured';
import { cameraPerceptionNative } from './cameraPerceptionNative';
import { cameraPerceptionRuntime } from './cameraPerceptionRuntime';
import type {
  CameraCaptureSuccessReceipt,
  CameraLookOnceReceipt,
  CameraManualSaveDestination,
  CameraManualSaveReceipt,
} from './cameraPerceptionTypes';
import { cameraPreviewRuntime } from './cameraPreviewRuntime';

export type CameraManualActionPhase =
  | 'idle'
  | 'preparing'
  | 'capturing'
  | 'understanding'
  | 'repairing'
  | 'cleaning'
  | 'saving'
  | 'cancelled'
  | 'error';

export type CameraManualActionsState = {
  phase: CameraManualActionPhase;
  activeKind?: 'look' | 'save';
  destination?: CameraManualSaveDestination;
  visionModelLabel?: string;
  lookReceipt?: CameraLookOnceReceipt;
  structuredAnalysis?: CameraVisionAnalysisSuccessV1;
  visionTransportDiagnostic?: CameraVisionTransportDiagnostic;
  visionAttemptDiagnostics?: Partial<Record<1 | 2, CameraVisionTransportDiagnostic>>;
  visionFirstValidationIssueCodes?: readonly string[];
  visionValidationIssues?: Partial<Record<1 | 2, readonly CameraVisionValidationIssue[]>>;
  saveReceipt?: CameraManualSaveReceipt;
  lastErrorCode?: string;
  schedulerSyncErrorCode?: string;
};

function errorCode(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) return error.message;
  return fallback;
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const CAMERA_MANUAL_LOOK_TIMEOUT_MS = 285_000;

function makeManualSaveFileName(sourceKind: 'android_front' | 'android_back', now = new Date()) {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('') + `-${String(now.getMilliseconds()).padStart(3, '0')}`;
  const facing = sourceKind === 'android_front' ? 'front' : 'back';
  const suffix = cameraPerceptionNative.newId('save').split('-').at(-1)?.slice(0, 8) ?? Date.now().toString(36);
  return `JunLuo-camera-${stamp}-${facing}-${suffix}.jpg`;
}

class CameraManualActionsRuntime {
  private state: CameraManualActionsState = { phase: 'idle' };
  private readonly listeners = new Set<() => void>();
  private retainCount = 0;
  private pageGeneration = 0;
  private appStateSubscription?: { remove(): void };
  private action?: {
    kind: 'look' | 'save';
    actionId: string;
    sessionId: string;
    requestId: string;
    pageGeneration: number;
    controller: AbortController;
    captureDelivered: boolean;
  };

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retain() {
    this.retainCount += 1;
    if (this.retainCount === 1) {
      this.pageGeneration += 1;
      void this.refreshContext();
      this.appStateSubscription = AppState.addEventListener('change', (state) => {
        if (state === 'active') {
          void this.refreshContext();
        } else {
          void this.cancelCurrent();
          this.clearPageResults();
        }
      });
    }
    return () => {
      this.retainCount = Math.max(0, this.retainCount - 1);
      if (this.retainCount === 0) {
        this.pageGeneration += 1;
        this.appStateSubscription?.remove();
        this.appStateSubscription = undefined;
        void this.cancelCurrent();
        this.patch({ phase: 'idle', lookReceipt: undefined, structuredAnalysis: undefined, saveReceipt: undefined, lastErrorCode: undefined });
      }
    };
  }

  async refreshContext() {
    const [destination, config] = await Promise.all([
      cameraPerceptionNative.getManualSaveDestination(),
      loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 }).catch(() => undefined),
    ]);
    this.patch({
      destination,
      visionModelLabel: config?.visionConnection
        ? `${config.visionConnection.name} · ${config.visionConnection.model}`
        : undefined,
    });
    return this.state;
  }

  async chooseDestination() {
    if (this.action) throw new Error('camera_manual_action_in_progress');
    const previousSelectedAt = this.state.destination?.selectedAt;
    await cameraPerceptionNative.openManualSaveDestinationPicker();
    const deadline = Date.now() + 120_000;
    let pickerBecameVisible = AppState.currentState !== 'active';
    while (Date.now() < deadline) {
      await wait(200);
      if (AppState.currentState !== 'active') {
        pickerBecameVisible = true;
        continue;
      }
      if (!pickerBecameVisible) continue;
      const destination = await cameraPerceptionNative.getManualSaveDestination();
      if (destination.configured && destination.available && destination.selectedAt !== previousSelectedAt) {
        this.patch({ destination, lastErrorCode: undefined });
        return destination;
      }
      throw new Error('camera_manual_save_cancelled');
    }
    throw new Error('camera_manual_save_cancelled');
  }

  async clearDestination() {
    if (this.action) throw new Error('camera_manual_action_in_progress');
    const destination = await cameraPerceptionNative.clearManualSaveDestination();
    this.patch({ destination, lastErrorCode: undefined });
    return destination;
  }

  previewSaveFileName() {
    const snapshot = cameraPerceptionRuntime.getSnapshot().nativeSnapshot;
    return makeManualSaveFileName(snapshot?.sourceKind ?? 'android_front');
  }

  async lookOnce(options?: {
    debugForceRepair?: boolean;
    actionId?: string;
    replyBinding?: CameraObservationResponseBinding;
    dataEpoch?: number;
  }): Promise<CameraLookOnceReceipt> {
    if (this.action) throw new Error('camera_manual_action_in_progress');
    const responseBinding = options?.debugForceRepair ? undefined : options?.replyBinding;
    const canCommitResponse = () => !responseBinding || (
      options?.dataEpoch !== undefined && canCommitBackupRestoreDataEpoch(options.dataEpoch)
    );
    if (!canCommitResponse()) throw new Error('camera_vision_cancelled');
    const session = cameraPerceptionRuntime.getSnapshot().session;
    if (session.status !== 'running') throw new Error(session.status === 'paused_camera_busy' ? 'camera_resource_busy' : 'camera_not_running');
    const action = {
      kind: 'look' as const,
      actionId: options?.actionId ?? cameraPerceptionNative.newId('camera-look'),
      sessionId: session.sessionId,
      requestId: cameraPerceptionNative.newId('camera-look-frame'),
      pageGeneration: this.pageGeneration,
      controller: new AbortController(),
      captureDelivered: false,
    };
    this.action = action;
    this.patch({
      phase: 'preparing',
      activeKind: 'look',
      lookReceipt: undefined,
      structuredAnalysis: undefined,
      visionTransportDiagnostic: undefined,
      visionAttemptDiagnostics: undefined,
      visionFirstValidationIssueCodes: undefined,
      visionValidationIssues: undefined,
      saveReceipt: undefined,
      lastErrorCode: undefined,
      schedulerSyncErrorCode: undefined,
    });
    let frame: CameraCaptureSuccessReceipt | undefined;
    let failurePhase: Extract<CameraManualActionPhase, 'error' | 'cancelled'> = 'error';
    const shouldPublish = () => this.retainCount > 0 && action.pageGeneration === this.pageGeneration;
    const assertActionActive = () => {
      if (action.controller.signal.aborted || this.action !== action || !canCommitResponse()) {
        throw new Error('camera_vision_cancelled');
      }
    };
    const startedAt = Date.now();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      if (this.action !== action || action.controller.signal.aborted) return;
      timedOut = true;
      if (shouldPublish()) this.patch({ phase: 'error', lastErrorCode: 'camera_vision_timeout' });
      action.controller.abort();
      if (!action.captureDelivered) {
        void cameraPerceptionNative.cancelCapture(action.sessionId, action.requestId).catch(() => undefined);
      }
    }, CAMERA_MANUAL_LOOK_TIMEOUT_MS);
    try {
      // The page-owned runtime already performs an authoritative refresh on
      // mount/resume. Reuse that invalidation-aware snapshot here instead of
      // serially reopening every encrypted connection key before each frame.
      const config = await loadAiConfigPreferencesSnapshot();
      if (!config.visionConnection || !config.visionKey.trim()) {
        throw new Error('camera_vision_configuration_required');
      }
      assertActionActive();
      if (shouldPublish()) {
        this.patch({
          phase: 'capturing',
          visionModelLabel: `${config.visionConnection.name} · ${config.visionConnection.model}`,
        });
      }
      const captured = await cameraPerceptionRuntime.captureFrame(action.requestId);
      if ('failureCode' in captured) throw new Error(captured.failureCode);
      if (captured.sourceKind !== 'android_front' && captured.sourceKind !== 'android_back') {
        throw new Error('camera_invalid_bridge_payload');
      }
      const sourceKind = captured.sourceKind;
      frame = captured;
      action.captureDelivered = true;
      assertActionActive();
      if (shouldPublish()) this.patch({ phase: 'understanding' });
      const base64 = await FileSystem.readAsStringAsync(frame.temporaryUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      assertActionActive();
      const analysis = await analyzeCameraFrameStructured({
        apiKey: config.visionKey,
        connection: config.visionConnection,
        imageDataUrl: base64,
        mimeType: 'image/jpeg',
        frame: {
          sourceKind: captured.sourceKind,
          width: captured.width,
          height: captured.height,
          rotation: captured.rotation,
          mirrored: captured.mirrored,
        },
        subjectIdentityContext: { status: 'unknown' },
        deviceContextFacts: [],
        debugForceFirstAttemptInvalid: options?.debugForceRepair === true,
        signal: action.controller.signal,
        onRepairStarted: (issueCodes) => {
          if (shouldPublish()) this.patch({ phase: 'repairing', visionFirstValidationIssueCodes: issueCodes });
        },
        onValidationFailed: (attemptNumber, issues) => {
          if (shouldPublish()) {
            this.patch({
              visionValidationIssues: {
                ...this.state.visionValidationIssues,
                [attemptNumber]: issues.map((issue) => ({ ...issue })),
              },
            });
          }
        },
        onTransportDiagnostic: (diagnostic) => {
          if (
            shouldPublish()
            && diagnostic.stage !== 'request_started'
            && diagnostic.stage !== 'streaming'
          ) {
            this.patch({
              visionTransportDiagnostic: diagnostic,
              visionAttemptDiagnostics: {
                ...this.state.visionAttemptDiagnostics,
                [diagnostic.attemptNumber]: diagnostic,
              },
            });
          }
        },
      });
      // A transport can finish at the same moment the user cancels. Never let
      // that late success advance into cleanup/persistence.
      assertActionActive();
      const analyzedAt = Date.now();
      if (shouldPublish()) this.patch({ phase: 'cleaning' });
      const releaseReceipt = await cameraPerceptionRuntime.releaseFrame(frame);
      frame = undefined;
      assertActionActive();
      const cleanupCompletedAt = Date.now();
      const persistObservation = () => persistCameraObservation({
        actionId: action.actionId,
        requestId: action.requestId,
        sessionId: action.sessionId,
        triggerKind: 'manual_look',
        sourceKind,
        capturedAt: captured.capturedAt,
        analyzedAt,
        capture: {
          width: captured.width,
          height: captured.height,
          rotation: captured.rotation,
          mirrored: captured.mirrored,
        },
        analysis: {
          provider: analysis.provider,
          model: analysis.model,
          latencyMs: analysis.latencyMs,
          attemptCount: analysis.attemptCount,
          repairUsed: analysis.repairUsed,
          responseFormatRequested: analysis.responseFormatRequested,
        },
        result: analysis.result,
        cleanup: {
          cleanupState: 'verified_deleted',
          deletionVerified: true,
          completedAt: cleanupCompletedAt,
          auditPersisted: releaseReceipt.auditPersisted,
        },
      }, {
        signal: action.controller.signal,
        responseBinding,
        canCommit: canCommitResponse,
      });
      const observation = responseBinding
        ? await runBackupRestoreDataEpochCommit(options!.dataEpoch!, persistObservation).then(commit => {
            if (!commit.committed) throw new Error('camera_vision_cancelled');
            return commit.value;
          })
        : await persistObservation();
      assertActionActive();
      await loadCameraPerceptionSettings()
        .then((settings) => syncAutomaticObservationPolicy(settings, observation.capturedAt))
        .then(() => {
          if (shouldPublish()) this.patch({ schedulerSyncErrorCode: undefined });
        })
        .catch((error) => {
          if (shouldPublish()) {
            this.patch({
              schedulerSyncErrorCode: errorCode(error, 'camera_automatic_policy_sync_failed'),
            });
          }
        });
      const completedAt = Date.now();
      const receipt: CameraLookOnceReceipt = {
        schemaVersion: 1,
        actionId: action.actionId,
        sessionId: action.sessionId,
        requestId: action.requestId,
        sourceKind: captured.sourceKind,
        capturedAt: captured.capturedAt,
        completedAt,
        width: captured.width,
        height: captured.height,
        rotation: captured.rotation,
        mirrored: captured.mirrored,
        visionProvider: analysis.provider,
        visionModel: analysis.model,
        latencyMs: completedAt - startedAt,
        schemaValid: true,
        analysisAttempts: analysis.attemptCount,
        repairUsed: analysis.repairUsed,
        structuredContentPresented: true,
        freeFormContentPresented: false,
        temporaryFrameReleased: true,
        persisted: true,
        observationId: observation.observationId,
      };
      if (shouldPublish()) this.patch({ phase: 'idle', activeKind: undefined, lookReceipt: receipt, structuredAnalysis: analysis });
      return receipt;
    } catch (error) {
      const rawCode = errorCode(error, '');
      const code = timedOut
        ? 'camera_vision_timeout'
        : action.controller.signal.aborted
          ? 'camera_vision_cancelled'
          : rawCode.startsWith('camera_')
            ? rawCode
            : /超时|timeout/i.test(rawCode)
              ? 'camera_vision_timeout'
              : 'camera_vision_request_failed';
      failurePhase = code === 'camera_vision_cancelled' ? 'cancelled' : 'error';
      if (shouldPublish()) this.patch({ phase: failurePhase, lastErrorCode: code });
      throw new Error(code);
    } finally {
      clearTimeout(timeoutId);
      if (frame) {
        if (shouldPublish()) this.patch({ phase: 'cleaning' });
        await cameraPerceptionRuntime.releaseFrame(frame).then(() => {
          if (shouldPublish()) this.patch({ phase: failurePhase });
        }).catch(() => {
          if (shouldPublish()) this.patch({ phase: 'cleaning', lastErrorCode: 'camera_frame_cleanup_failed' });
        });
      }
      if (this.action === action) {
        this.action = undefined;
        if (shouldPublish()) this.patch({ activeKind: undefined });
      }
    }
  }

  async saveCurrentFrame(fileName: string): Promise<CameraManualSaveReceipt> {
    if (this.action) throw new Error('camera_manual_action_in_progress');
    const session = cameraPerceptionRuntime.getSnapshot().session;
    const preview = cameraPreviewRuntime.getSnapshot();
    if (session.status !== 'running' || preview.phase !== 'streaming' || !preview.active) {
      throw new Error('camera_manual_save_requires_preview');
    }
    const action = {
      kind: 'save' as const,
      actionId: cameraPerceptionNative.newId('camera-save'),
      sessionId: session.sessionId,
      requestId: cameraPerceptionNative.newId('camera-save-frame'),
      pageGeneration: this.pageGeneration,
      controller: new AbortController(),
      captureDelivered: false,
    };
    this.action = action;
    let frame: CameraCaptureSuccessReceipt | undefined;
    let failurePhase: Extract<CameraManualActionPhase, 'error' | 'cancelled'> = 'error';
    const shouldPublish = () => this.retainCount > 0 && action.pageGeneration === this.pageGeneration;
    try {
      const destination = await cameraPerceptionNative.getManualSaveDestination();
      if (shouldPublish()) this.patch({ destination });
      if (!destination.configured || !destination.available) throw new Error('camera_manual_save_destination_required');
      if (shouldPublish()) this.patch({ phase: 'capturing', activeKind: 'save', lookReceipt: undefined, structuredAnalysis: undefined, saveReceipt: undefined, lastErrorCode: undefined });
      const captured = await cameraPerceptionRuntime.captureFrame(action.requestId);
      if ('failureCode' in captured) throw new Error(captured.failureCode);
      frame = captured;
      action.captureDelivered = true;
      if (action.controller.signal.aborted) throw new Error('camera_manual_save_cancelled');
      if (shouldPublish()) this.patch({ phase: 'saving' });
      const receipt = await cameraPerceptionNative.saveFrameToDestination({
        actionId: action.actionId,
        commandId: cameraPerceptionNative.newId('camera-save-command'),
        fileName,
        receipt: frame,
      });
      frame = undefined;
      if (shouldPublish()) this.patch({ phase: 'idle', activeKind: undefined, saveReceipt: receipt, destination, lastErrorCode: undefined });
      return receipt;
    } catch (error) {
      const rawCode = errorCode(error, '');
      const code = action.controller.signal.aborted
        ? 'camera_manual_save_cancelled'
        : rawCode.startsWith('camera_')
          ? rawCode
          : 'camera_manual_save_write_failed';
      failurePhase = code === 'camera_manual_save_cancelled' ? 'cancelled' : 'error';
      if (shouldPublish()) this.patch({ phase: failurePhase, lastErrorCode: code });
      if (code === 'camera_manual_save_permission_lost') {
        await this.refreshContext().catch(() => undefined);
      }
      throw new Error(code);
    } finally {
      if (frame) {
        await cameraPerceptionRuntime.releaseFrame(frame).then(() => {
          if (shouldPublish()) this.patch({ phase: failurePhase });
        }).catch(() => {
          if (shouldPublish()) this.patch({ phase: 'cleaning', lastErrorCode: 'camera_frame_cleanup_failed' });
        });
      }
      if (this.action === action) {
        this.action = undefined;
        if (shouldPublish()) this.patch({ activeKind: undefined });
      }
    }
  }

  async cancelCurrent() {
    const action = this.action;
    if (!action) return;
    if (action.kind === 'save') return;
    this.patch({ phase: 'cancelled', lastErrorCode: 'camera_vision_cancelled' });
    action.controller.abort();
    if (!action.captureDelivered) {
      await cameraPerceptionNative.cancelCapture(action.sessionId, action.requestId).catch(() => undefined);
    }
  }

  clearPageResults() {
    this.patch({
      lookReceipt: undefined,
      structuredAnalysis: undefined,
      visionTransportDiagnostic: undefined,
      visionAttemptDiagnostics: undefined,
      visionFirstValidationIssueCodes: undefined,
      visionValidationIssues: undefined,
      saveReceipt: undefined,
      lastErrorCode: undefined,
      schedulerSyncErrorCode: undefined,
      phase: this.action ? this.state.phase : 'idle',
    });
  }

  private patch(patch: Partial<CameraManualActionsState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export const cameraManualActionsRuntime = new CameraManualActionsRuntime();

export function useCameraManualActionsRuntime() {
  useEffect(() => cameraManualActionsRuntime.retain(), []);
  return useSyncExternalStore(
    cameraManualActionsRuntime.subscribe,
    cameraManualActionsRuntime.getSnapshot,
    cameraManualActionsRuntime.getSnapshot,
  );
}
