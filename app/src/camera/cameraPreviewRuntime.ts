import { useEffect, useLayoutEffect, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import type { CameraObservationSession } from './cameraPerceptionTypes';
import {
  shouldActivateCameraPreview,
  shouldClearCameraPreviewIntent,
  shouldRequestCameraPreviewFacing,
} from './cameraPreviewPolicy';
import type { CameraPreviewEvent, CameraPreviewPhase } from './cameraPreviewView';

export type CameraPreviewRuntimeState = {
  previewId: string;
  generation: number;
  active: boolean;
  phase: CameraPreviewPhase;
  requestedFacing: 'front' | 'back';
  actualFacing?: 'front' | 'back';
  intentSessionId?: string;
  previewWidth?: number;
  previewHeight?: number;
  failureCode?: string;
  reasonCode?: string;
};

class CameraPreviewRuntime {
  private state: CameraPreviewRuntimeState = {
    previewId: `camera-preview-${Date.now().toString(36)}`,
    generation: 0,
    active: false,
    phase: 'off',
    requestedFacing: 'front',
  };
  private readonly listeners = new Set<() => void>();
  private pageVisible = false;
  private appActive = AppState.currentState === 'active';
  private currentSession?: CameraObservationSession;
  private retainCount = 0;
  private appStateSubscription?: { remove(): void };
  private pendingLeavePage?: ReturnType<typeof setTimeout>;

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  enterPage() {
    if (this.pendingLeavePage) {
      clearTimeout(this.pendingLeavePage);
      this.pendingLeavePage = undefined;
    }
    this.pageVisible = true;
    this.recomputeActive();
  }

  leavePage() {
    if (this.pendingLeavePage) return;
    this.pendingLeavePage = setTimeout(() => {
      this.pendingLeavePage = undefined;
      this.pageVisible = false;
      this.setNativeActive(false, this.state.intentSessionId ? 'suspended' : 'off');
    }, 0);
  }

  syncSession(session: CameraObservationSession) {
    this.currentSession = session;
    if (shouldClearCameraPreviewIntent(this.state.intentSessionId, session)) {
      this.clearIntent(session.status === 'stopped' ? 'camera_session_stopped' : 'camera_preview_stale_generation');
      return;
    }
    this.recomputeActive();
  }

  enable(sessionId: string, facing: 'front' | 'back') {
    this.patch({
      intentSessionId: sessionId,
      requestedFacing: facing,
      phase: 'starting',
      failureCode: undefined,
      reasonCode: undefined,
      generation: this.state.generation + 1,
    });
    this.recomputeActive();
  }

  disableExplicit() {
    this.clearIntent('user_closed_preview');
  }

  pauseForThermal() {
    if (!this.state.intentSessionId && !this.state.active) return;
    this.clearIntent('camera_thermal_paused');
  }

  requestFacing(facing: 'front' | 'back') {
    if (!shouldRequestCameraPreviewFacing(this.state.phase, this.state.actualFacing, facing)) return;
    this.patch({ requestedFacing: facing, phase: this.state.active ? 'switching' : this.state.phase, failureCode: undefined });
  }

  handleEvent(event: CameraPreviewEvent) {
    if (
      event.previewId !== this.state.previewId ||
      event.generation !== this.state.generation ||
      (this.state.intentSessionId && event.sessionId !== this.state.intentSessionId)
    ) return;
    if (event.reasonCode === 'camera_thermal_paused' || event.failureCode === 'camera_thermal_paused') {
      this.pauseForThermal();
      return;
    }
    this.patch({
      phase: event.phase,
      requestedFacing: event.phase === 'streaming' && event.failureCode && event.facing
        ? event.facing
        : this.state.requestedFacing,
      actualFacing: event.facing ?? this.state.actualFacing,
      previewWidth: event.previewWidth ?? this.state.previewWidth,
      previewHeight: event.previewHeight ?? this.state.previewHeight,
      failureCode: event.failureCode,
      reasonCode: event.reasonCode,
    });
  }

  retain() {
    this.retainCount += 1;
    if (this.retainCount === 1) {
      this.appActive = AppState.currentState === 'active';
      this.appStateSubscription = AppState.addEventListener('change', (next) => {
        this.appActive = next === 'active';
        this.recomputeActive();
      });
    }
    return () => {
      this.retainCount = Math.max(0, this.retainCount - 1);
      if (this.retainCount === 0) {
        this.appStateSubscription?.remove();
        this.appStateSubscription = undefined;
      }
    };
  }

  private recomputeActive() {
    const session = this.currentSession;
    const shouldRun = shouldActivateCameraPreview({
      android: Platform.OS === 'android',
      pageVisible: this.pageVisible,
      appActive: this.appActive,
      intentSessionId: this.state.intentSessionId,
      session,
    });
    this.setNativeActive(shouldRun, shouldRun ? this.state.phase : this.state.intentSessionId ? 'suspended' : 'off');
  }

  private setNativeActive(active: boolean, phase: CameraPreviewPhase) {
    if (this.state.active === active && this.state.phase === phase) return;
    this.patch({ active, phase, generation: this.state.active !== active ? this.state.generation + 1 : this.state.generation });
  }

  private clearIntent(reasonCode: string) {
    this.patch({
      active: false,
      phase: 'off',
      intentSessionId: undefined,
      actualFacing: undefined,
      previewWidth: undefined,
      previewHeight: undefined,
      failureCode: undefined,
      reasonCode,
      generation: this.state.generation + 1,
    });
  }

  private patch(patch: Partial<CameraPreviewRuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export const cameraPreviewRuntime = new CameraPreviewRuntime();

export function useCameraPreviewRuntime(session: CameraObservationSession) {
  useEffect(() => cameraPreviewRuntime.retain(), []);
  useLayoutEffect(() => {
    cameraPreviewRuntime.enterPage();
    return () => cameraPreviewRuntime.leavePage();
  }, []);
  useEffect(() => cameraPreviewRuntime.syncSession(session), [session]);
  return useSyncExternalStore(
    cameraPreviewRuntime.subscribe,
    cameraPreviewRuntime.getSnapshot,
    cameraPreviewRuntime.getSnapshot,
  );
}
