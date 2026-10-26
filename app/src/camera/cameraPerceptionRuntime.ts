import { useEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import type { CameraObservationSession } from './cameraPerceptionTypes';
import {
  CAMERA_NATIVE_MODULE_UNAVAILABLE,
  cameraPerceptionNative,
  type NativeCameraCaptureReceipt,
  type NativeCameraPrerequisites,
  type NativeCameraSessionSnapshot,
} from './cameraPerceptionNative';

export type CameraPerceptionRuntimeState = {
  bridgeStatus: 'checking' | 'ready' | 'unavailable' | 'error';
  nativeSnapshot?: NativeCameraSessionSnapshot;
  session: CameraObservationSession;
  prerequisites?: NativeCameraPrerequisites;
  lastEventAt?: number;
  lastHeartbeatEventAt?: number;
  lastCaptureReceipt?: NativeCameraCaptureReceipt;
  lastErrorCode?: string;
};

const stoppedSession = (): CameraObservationSession => ({
  schemaVersion: 1,
  revision: 0,
  status: 'stopped',
});

function toObservationSession(snapshot: NativeCameraSessionSnapshot): CameraObservationSession {
  if (snapshot.status === 'stopped') {
    return {
      schemaVersion: 1,
      revision: snapshot.revision,
      status: 'stopped',
      lastSessionId: snapshot.lastSessionId,
      stopReasonCode: snapshot.stopReasonCode,
    };
  }
  const sessionId = snapshot.sessionId ?? snapshot.lastSessionId ?? 'camera-session-unknown';
  return {
    schemaVersion: 1,
    revision: snapshot.revision,
    status: snapshot.status,
    sessionId,
    sourceKind: snapshot.sourceKind ?? 'android_front',
    startedAt: snapshot.startedAt ?? Date.now(),
    startedBy: 'you',
    lastHeartbeatAt: snapshot.lastHeartbeatAt ?? snapshot.startedAt ?? Date.now(),
    lastSuccessfulObservationAt: snapshot.lastSuccessfulObservationAt,
    lastFailureCode: snapshot.lastFailureCode,
    stopReasonCode: snapshot.stopReasonCode,
    persistentNotificationVisible: snapshot.persistentNotificationVisible,
  };
}

class CameraPerceptionRuntime {
  private state: CameraPerceptionRuntimeState = {
    bridgeStatus: Platform.OS === 'android' ? 'checking' : 'unavailable',
    session: stoppedSession(),
  };
  private readonly listeners = new Set<() => void>();
  private subscriptions: Array<{ remove(): void }> = [];
  private appStateSubscription?: { remove(): void };
  private retainCount = 0;
  private readGeneration = 0;
  private captureKeys = new Set<string>();
  private captureInFlight?: Promise<NativeCameraCaptureReceipt>;
  private analysisInFlight?: Promise<unknown>;

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retain() {
    this.retainCount += 1;
    if (this.retainCount === 1) this.start();
    return () => {
      this.retainCount = Math.max(0, this.retainCount - 1);
      if (this.retainCount === 0) this.stopListening();
    };
  }

  async refresh(authoritative = true) {
    if (!cameraPerceptionNative.available) {
      this.patch({ bridgeStatus: 'unavailable', lastErrorCode: CAMERA_NATIVE_MODULE_UNAVAILABLE });
      return this.state;
    }
    const readGeneration = ++this.readGeneration;
    try {
      const [snapshot, prerequisites] = await Promise.all([
        cameraPerceptionNative.getState(),
        cameraPerceptionNative.getPrerequisites(),
      ]);
      if (readGeneration !== this.readGeneration) return this.state;
      if (this.state.nativeSnapshot && snapshot.revision < this.state.nativeSnapshot.revision) return this.state;
      this.applySnapshot(snapshot, authoritative);
      this.patch({ bridgeStatus: 'ready', prerequisites, lastErrorCode: undefined });
    } catch (error) {
      this.patch({
        bridgeStatus: cameraPerceptionNative.available ? 'error' : 'unavailable',
        lastErrorCode: error instanceof Error ? error.message : 'camera_invalid_bridge_payload',
      });
    }
    return this.state;
  }

  async startSession(
    facing: 'front' | 'back',
    options: { refreshAfterStart?: boolean } = {},
  ) {
    const sessionId = cameraPerceptionNative.newId('observation-session');
    const receipt = await cameraPerceptionNative.start(sessionId, facing);
    if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_invalid_bridge_payload');
    if (options.refreshAfterStart !== false) await this.refresh(true);
    return receipt;
  }

  async stopSession(reasonCode = 'user_stop') {
    const session = this.state.session;
    const sessionId = session.status === 'stopped' ? session.lastSessionId : session.sessionId;
    if (!sessionId) return;
    const receipt = await cameraPerceptionNative.stop(sessionId, reasonCode);
    if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_invalid_bridge_payload');
    await this.refresh(true);
  }

  async switchFacing(facing: 'front' | 'back') {
    const session = this.state.session;
    if (session.status === 'stopped') throw new Error('camera_not_running');
    const receipt = await cameraPerceptionNative.switchFacing(session.sessionId, facing);
    if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_invalid_bridge_payload');
    await this.refresh(true);
    return receipt;
  }

  async captureFrame(requestId = cameraPerceptionNative.newId('observation-frame')) {
    if (this.captureInFlight) throw new Error('camera_capture_in_progress');
    const session = this.state.session;
    if (session.status !== 'running') throw new Error(session.status === 'paused_camera_busy' ? 'camera_resource_busy' : 'camera_not_running');
    const operation = cameraPerceptionNative.capture(session.sessionId, requestId);
    this.captureInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.captureInFlight === operation) this.captureInFlight = undefined;
    }
  }

  async releaseFrame(receipt: Extract<NativeCameraCaptureReceipt, { captureSucceeded: true }>) {
    let released = await cameraPerceptionNative.releaseFrame(receipt.temporaryFrameId, receipt.releaseToken);
    if (released.cleanupState === 'retrying') {
      released = await cameraPerceptionNative.awaitFrameDeletion(receipt.temporaryFrameId, receipt.releaseToken);
    }
    if (!released.success || !released.deletionVerified) {
      throw new Error(released.failureCode ?? 'camera_frame_cleanup_failed');
    }
    return {
      released: true,
      alreadyReleased: released.alreadyDeleted,
      deletionVerified: true as const,
      auditPersisted: released.auditPersisted,
    };
  }

  reserveAnalysis<T>(work: () => Promise<T>) {
    if (this.analysisInFlight) throw new Error('camera_analysis_in_progress');
    const operation = work();
    this.analysisInFlight = operation;
    return operation.finally(() => {
      if (this.analysisInFlight === operation) this.analysisInFlight = undefined;
    });
  }

  private start() {
    if (!cameraPerceptionNative.available || this.subscriptions.length > 0) {
      void this.refresh(true);
      return;
    }
    const stateSubscription = cameraPerceptionNative.subscribeState((snapshot) => {
      this.applySnapshot(snapshot, false);
      this.patch({ lastEventAt: Date.now(), bridgeStatus: 'ready' });
    });
    const captureSubscription = cameraPerceptionNative.subscribeCapture((receipt) => {
      const key = `${receipt.sessionId}:${receipt.requestId}:${receipt.captureGeneration}`;
      if (this.captureKeys.has(key)) return;
      this.captureKeys.add(key);
      if (this.captureKeys.size > 64) this.captureKeys.delete(this.captureKeys.values().next().value as string);
      this.patch({ lastCaptureReceipt: receipt, lastEventAt: Date.now() });
    });
    const heartbeatSubscription = cameraPerceptionNative.subscribeHeartbeat((heartbeat) => {
      if (!heartbeat.sessionId || heartbeat.sessionId !== this.state.nativeSnapshot?.sessionId) return;
      this.patch({ lastHeartbeatEventAt: Date.now() });
      // JS may have slept; read native truth instead of treating missed events as a stopped service.
      void this.refresh(true);
    });
    this.subscriptions = [stateSubscription, captureSubscription, heartbeatSubscription]
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    this.appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void this.refresh(true);
    });
    // Subscribe first, then read native truth so no state transition can be lost between the two.
    void this.refresh(true);
  }

  private stopListening() {
    this.subscriptions.forEach((subscription) => subscription.remove());
    this.subscriptions = [];
    this.appStateSubscription?.remove();
    this.appStateSubscription = undefined;
    this.captureInFlight = undefined;
    this.analysisInFlight = undefined;
  }

  private applySnapshot(snapshot: NativeCameraSessionSnapshot, authoritative: boolean) {
    if (this.state.nativeSnapshot && (snapshot.revision < this.state.nativeSnapshot.revision
      || !authoritative && snapshot.revision === this.state.nativeSnapshot.revision)) return;
    this.patch({
      nativeSnapshot: snapshot,
      session: toObservationSession(snapshot),
      lastErrorCode: snapshot.lastFailureCode,
    });
  }

  private patch(patch: Partial<CameraPerceptionRuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export const cameraPerceptionRuntime = new CameraPerceptionRuntime();

export function useCameraPerceptionRuntime(enabled = true) {
  useEffect(() => (
    enabled ? cameraPerceptionRuntime.retain() : undefined
  ), [enabled]);
  return useSyncExternalStore(
    cameraPerceptionRuntime.subscribe,
    cameraPerceptionRuntime.getSnapshot,
    cameraPerceptionRuntime.getSnapshot,
  );
}
