import type {
  CameraCaptureReceipt,
  CameraFacing,
  CameraObservationRequest,
  CameraSourceKind,
} from './cameraPerceptionTypes';

export type CameraSourceAvailabilityStatus =
  | 'available'
  | 'unavailable'
  | 'busy'
  | 'permission_required'
  | 'disconnected'
  | 'error';

export type CameraSourceAvailability = {
  sourceKind: CameraSourceKind;
  status: CameraSourceAvailabilityStatus;
  checkedAt: number;
  reasonCode?: string;
};

export type CameraSourceStartOptions = {
  sessionId: string;
  sourceKind: CameraSourceKind;
  requestedAt: number;
};

export type CameraSourceStartReceipt =
  | {
    sessionId: string;
    sourceKind: CameraSourceKind;
    started: true;
    startedAt: number;
  }
  | {
    sessionId: string;
    sourceKind: CameraSourceKind;
    started: false;
    failedAt: number;
    failureCode: string;
  };

export type CameraSourceStopReceipt = {
  sessionId: string;
  stopped: boolean;
  occurredAt: number;
  failureCode?: string;
};

export type CameraSourceHealth = {
  sourceKind: CameraSourceKind;
  sessionId?: string;
  status: CameraSourceAvailabilityStatus;
  checkedAt: number;
  reasonCode?: string;
};

export type CameraFacingSwitchReceipt =
  | {
    sessionId: string;
    switched: true;
    sourceKind: Extract<CameraSourceKind, 'android_front' | 'android_back'>;
    facing: Extract<CameraFacing, 'front' | 'back'>;
    occurredAt: number;
  }
  | {
    sessionId: string;
    switched: false;
    occurredAt: number;
    failureCode: string;
  };

export interface CameraFrameSource {
  readonly sourceId: string;
  readonly supportedKinds: readonly CameraSourceKind[];
  getAvailability(sourceKind: CameraSourceKind): Promise<CameraSourceAvailability>;
  start(options: CameraSourceStartOptions): Promise<CameraSourceStartReceipt>;
  stop(sessionId: string): Promise<CameraSourceStopReceipt>;
  captureOnce(request: CameraObservationRequest): Promise<CameraCaptureReceipt>;
  getHealth(sessionId?: string): Promise<CameraSourceHealth>;
  switchFacing?(sessionId: string, facing: Extract<CameraFacing, 'front' | 'back'>):
    Promise<CameraFacingSwitchReceipt>;
  releaseFrame?(receipt: Extract<CameraCaptureReceipt, { captureSucceeded: true }>): Promise<{
    released: boolean;
    alreadyReleased: boolean;
    failureCode?: string;
  }>;
}
