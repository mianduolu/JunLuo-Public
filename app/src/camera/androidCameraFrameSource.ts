import type {
  CameraFacingSwitchReceipt,
  CameraFrameSource,
  CameraSourceAvailability,
  CameraSourceHealth,
  CameraSourceStartOptions,
  CameraSourceStartReceipt,
  CameraSourceStopReceipt,
} from './cameraFrameSource';
import { cameraPerceptionNative } from './cameraPerceptionNative';
import type { CameraCaptureReceipt, CameraObservationRequest, CameraSourceKind } from './cameraPerceptionTypes';

const ANDROID_KINDS = ['android_front', 'android_back'] as const;

function facingFromSource(sourceKind: CameraSourceKind) {
  return sourceKind === 'android_back' ? 'back' as const : 'front' as const;
}

function failureCode(error: unknown) {
  return error instanceof Error ? error.message : 'camera_unknown_error';
}

export const androidCameraFrameSource: CameraFrameSource = {
  sourceId: 'junluo-android-camerax',
  supportedKinds: ANDROID_KINDS,

  async getAvailability(sourceKind): Promise<CameraSourceAvailability> {
    if (!ANDROID_KINDS.includes(sourceKind as typeof ANDROID_KINDS[number])) {
      return { sourceKind, status: 'unavailable', checkedAt: Date.now(), reasonCode: 'camera_unavailable' };
    }
    try {
      const raw = await cameraPerceptionNative.getAvailability(facingFromSource(sourceKind));
      return {
        sourceKind,
        status: raw.available === true ? 'available' : 'unavailable',
        checkedAt: typeof raw.checkedAt === 'number' ? raw.checkedAt : Date.now(),
        reasonCode: typeof raw.failureCode === 'string' ? raw.failureCode : undefined,
      };
    } catch (error) {
      return { sourceKind, status: 'error', checkedAt: Date.now(), reasonCode: failureCode(error) };
    }
  },

  async start(options: CameraSourceStartOptions): Promise<CameraSourceStartReceipt> {
    const receipt = await cameraPerceptionNative.start(options.sessionId, facingFromSource(options.sourceKind));
    return receipt.ok
      ? { sessionId: options.sessionId, sourceKind: options.sourceKind, started: true, startedAt: Date.now() }
      : {
        sessionId: options.sessionId,
        sourceKind: options.sourceKind,
        started: false,
        failedAt: Date.now(),
        failureCode: receipt.failureCode ?? 'camera_unknown_error',
      };
  },

  async stop(sessionId: string): Promise<CameraSourceStopReceipt> {
    const receipt = await cameraPerceptionNative.stop(sessionId);
    return {
      sessionId,
      stopped: receipt.ok,
      occurredAt: Date.now(),
      failureCode: receipt.ok ? undefined : receipt.failureCode,
    };
  },

  async captureOnce(request: CameraObservationRequest): Promise<CameraCaptureReceipt> {
    return cameraPerceptionNative.capture(request.sessionId, request.requestId);
  },

  async getHealth(sessionId?: string): Promise<CameraSourceHealth> {
    const snapshot = await cameraPerceptionNative.getState();
    const sourceKind = snapshot.sourceKind ?? 'android_front';
    const matches = !sessionId || snapshot.sessionId === sessionId;
    return {
      sourceKind,
      sessionId: snapshot.sessionId,
      status: matches && snapshot.status !== 'stopped' && snapshot.status !== 'error' ? 'available' : 'unavailable',
      checkedAt: Date.now(),
      reasonCode: matches ? snapshot.lastFailureCode : 'camera_stale_session',
    };
  },

  async switchFacing(sessionId, facing): Promise<CameraFacingSwitchReceipt> {
    const receipt = await cameraPerceptionNative.switchFacing(sessionId, facing);
    if (!receipt.ok) {
      return {
        sessionId,
        switched: false,
        occurredAt: Date.now(),
        failureCode: receipt.failureCode ?? 'camera_unknown_error',
      };
    }
    return {
      sessionId,
      switched: true,
      sourceKind: facing === 'front' ? 'android_front' : 'android_back',
      facing,
      occurredAt: Date.now(),
    };
  },

  async releaseFrame(receipt) {
    try {
      const released = await cameraPerceptionNative.releaseFrame(receipt.temporaryFrameId, receipt.releaseToken);
      return {
        released: released.deletionVerified,
        alreadyReleased: released.alreadyDeleted,
        failureCode: released.failureCode,
      };
    } catch (error) {
      return { released: false, alreadyReleased: false, failureCode: failureCode(error) };
    }
  },
};
