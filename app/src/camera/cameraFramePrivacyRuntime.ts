import { useEffect, useSyncExternalStore } from 'react';

import { cameraPerceptionNative } from './cameraPerceptionNative';
import type { CameraFramePrivacyState } from './cameraPerceptionTypes';

type CameraFramePrivacyRuntimeState = {
  loading: boolean;
  privacy?: CameraFramePrivacyState;
  lastErrorCode?: string;
};

class CameraFramePrivacyRuntime {
  private state: CameraFramePrivacyRuntimeState = { loading: true };
  private readonly listeners = new Set<() => void>();
  private retainCount = 0;
  private subscription?: { remove(): void };

  readonly getSnapshot = () => this.state;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  retain() {
    this.retainCount += 1;
    if (this.retainCount === 1) {
      this.subscription = cameraPerceptionNative.subscribePrivacy((privacy) => {
        this.patch({ loading: false, privacy, lastErrorCode: undefined });
      });
      void this.refresh(false);
    }
    return () => {
      this.retainCount = Math.max(0, this.retainCount - 1);
      if (this.retainCount === 0) {
        this.subscription?.remove();
        this.subscription = undefined;
      }
    };
  }

  async refresh(verify = true) {
    try {
      const privacy = verify
        ? await cameraPerceptionNative.verifyTemporaryFrameCleanup()
        : await cameraPerceptionNative.getTemporaryFramePrivacyState();
      this.patch({ loading: false, privacy, lastErrorCode: undefined });
      return privacy;
    } catch (error) {
      const code = error instanceof Error && error.message.trim()
        ? error.message
        : 'camera_frame_privacy_state_unavailable';
      this.patch({ loading: false, lastErrorCode: code });
      throw new Error(code);
    }
  }

  async runDebugSelfTest(mode: 'delete_now' | 'fail_once' | 'fail_all' | 'create_orphan' | 'watchdog') {
    const receipt = await cameraPerceptionNative.runPrivacyDebugSelfTest(mode);
    await this.refresh(false);
    return receipt;
  }

  private patch(patch: Partial<CameraFramePrivacyRuntimeState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
}

export const cameraFramePrivacyRuntime = new CameraFramePrivacyRuntime();

export function useCameraFramePrivacyRuntime() {
  useEffect(() => cameraFramePrivacyRuntime.retain(), []);
  return useSyncExternalStore(
    cameraFramePrivacyRuntime.subscribe,
    cameraFramePrivacyRuntime.getSnapshot,
    cameraFramePrivacyRuntime.getSnapshot,
  );
}
