import {
  CAMERA_PERCEPTION_SCHEMA_VERSION,
  type CameraActiveObservationSession,
  type CameraCaptureReceipt,
  type CameraObservationRequest,
  type CameraObservationSession,
  type CameraSourceKind,
  type CameraStoppedObservationSession,
} from './cameraPerceptionTypes';

type CameraPauseReason = 'camera_busy' | 'permission' | 'system';

export type CameraSessionEvent =
  | {
    type: 'start_requested';
    expectedRevision: number;
    sessionId: string;
    sourceKind: CameraSourceKind;
    at: number;
  }
  | {
    type: 'start_succeeded';
    expectedRevision: number;
    sessionId: string;
    at: number;
    persistentNotificationVisible: boolean;
  }
  | {
    type: 'heartbeat';
    expectedRevision: number;
    sessionId: string;
    at: number;
  }
  | {
    type: 'pause';
    expectedRevision: number;
    sessionId: string;
    at: number;
    reason: CameraPauseReason;
    failureCode?: string;
  }
  | {
    type: 'resume';
    expectedRevision: number;
    sessionId: string;
    at: number;
  }
  | {
    type: 'stop_requested';
    expectedRevision: number;
    sessionId: string;
    at: number;
    reasonCode: string;
  }
  | {
    type: 'stop_succeeded';
    expectedRevision: number;
    sessionId: string;
    at: number;
    reasonCode?: string;
  }
  | {
    type: 'failed';
    expectedRevision: number;
    sessionId: string;
    at: number;
    failureCode: string;
  };

export function createStoppedCameraSession(
  revision = 0,
): CameraStoppedObservationSession {
  return {
    schemaVersion: CAMERA_PERCEPTION_SCHEMA_VERSION,
    revision,
    status: 'stopped',
  };
}

function assertExpectedRevision(state: CameraObservationSession, expectedRevision: number) {
  if (state.revision !== expectedRevision) {
    throw new Error(`camera_session_revision_conflict:${state.revision}:${expectedRevision}`);
  }
}

function assertActiveSession(
  state: CameraObservationSession,
  sessionId: string,
): asserts state is CameraActiveObservationSession {
  if (state.status === 'stopped') throw new Error('camera_session_not_active');
  if (state.sessionId !== sessionId) {
    throw new Error(`camera_session_identity_conflict:${state.sessionId}:${sessionId}`);
  }
}

function assertStatus(
  state: CameraObservationSession,
  eventType: CameraSessionEvent['type'],
  allowedStatuses: readonly CameraObservationSession['status'][],
) {
  if (!allowedStatuses.includes(state.status)) {
    throw new Error(`camera_session_transition_not_allowed:${state.status}:${eventType}`);
  }
}

function pauseStatus(reason: CameraPauseReason): CameraActiveObservationSession['status'] {
  if (reason === 'camera_busy') return 'paused_camera_busy';
  if (reason === 'permission') return 'paused_permission';
  return 'paused_system';
}

export function transitionCameraSession(
  state: CameraObservationSession,
  event: CameraSessionEvent,
): CameraObservationSession {
  assertExpectedRevision(state, event.expectedRevision);

  if (event.type === 'start_requested') {
    assertStatus(state, event.type, ['stopped']);
    if (!event.sessionId.trim()) throw new Error('camera_session_id_required');
    return {
      schemaVersion: CAMERA_PERCEPTION_SCHEMA_VERSION,
      revision: state.revision + 1,
      status: 'starting',
      sessionId: event.sessionId,
      sourceKind: event.sourceKind,
      startedAt: event.at,
      startedBy: 'you',
      lastHeartbeatAt: event.at,
      persistentNotificationVisible: false,
    };
  }

  assertActiveSession(state, event.sessionId);

  if (event.type === 'start_succeeded') {
    assertStatus(state, event.type, ['starting']);
    return {
      ...state,
      revision: state.revision + 1,
      status: 'running',
      lastHeartbeatAt: event.at,
      persistentNotificationVisible: event.persistentNotificationVisible,
      lastFailureCode: undefined,
    };
  }

  if (event.type === 'heartbeat') {
    assertStatus(state, event.type, [
      'starting',
      'running',
      'paused_camera_busy',
      'paused_permission',
      'paused_system',
      'stopping',
      'error',
    ]);
    return {
      ...state,
      revision: state.revision + 1,
      lastHeartbeatAt: event.at,
    };
  }

  if (event.type === 'pause') {
    assertStatus(state, event.type, ['running']);
    return {
      ...state,
      revision: state.revision + 1,
      status: pauseStatus(event.reason),
      lastHeartbeatAt: event.at,
      lastFailureCode: event.failureCode,
    };
  }

  if (event.type === 'resume') {
    assertStatus(state, event.type, [
      'paused_camera_busy',
      'paused_permission',
      'paused_system',
    ]);
    return {
      ...state,
      revision: state.revision + 1,
      status: 'running',
      lastHeartbeatAt: event.at,
      lastFailureCode: undefined,
    };
  }

  if (event.type === 'stop_requested') {
    assertStatus(state, event.type, [
      'starting',
      'running',
      'paused_camera_busy',
      'paused_permission',
      'paused_system',
      'error',
    ]);
    return {
      ...state,
      revision: state.revision + 1,
      status: 'stopping',
      lastHeartbeatAt: event.at,
      stopReasonCode: event.reasonCode,
    };
  }

  if (event.type === 'stop_succeeded') {
    assertStatus(state, event.type, ['stopping']);
    return {
      schemaVersion: CAMERA_PERCEPTION_SCHEMA_VERSION,
      revision: state.revision + 1,
      status: 'stopped',
      stoppedAt: event.at,
      lastSessionId: state.sessionId,
      stopReasonCode: event.reasonCode ?? state.stopReasonCode,
    };
  }

  assertStatus(state, event.type, [
    'starting',
    'running',
    'paused_camera_busy',
    'paused_permission',
    'paused_system',
  ]);
  return {
    ...state,
    revision: state.revision + 1,
    status: 'error',
    lastHeartbeatAt: event.at,
    lastFailureCode: event.failureCode,
  };
}

export function assertCameraCaptureReceiptMatches(
  state: CameraObservationSession,
  request: CameraObservationRequest,
  receipt: CameraCaptureReceipt,
) {
  if (state.status !== 'running') throw new Error('camera_capture_requires_running_session');
  if (request.sessionId !== state.sessionId || receipt.sessionId !== state.sessionId) {
    throw new Error('camera_capture_stale_session');
  }
  if (receipt.requestId !== request.requestId) throw new Error('camera_capture_stale_request');
  if (request.sourceKind !== state.sourceKind || receipt.sourceKind !== state.sourceKind) {
    throw new Error('camera_capture_source_mismatch');
  }
  return receipt;
}

export function isCameraCaptureReceiptCurrent(
  state: CameraObservationSession,
  request: CameraObservationRequest,
  receipt: CameraCaptureReceipt,
) {
  try {
    assertCameraCaptureReceiptMatches(state, request, receipt);
    return true;
  } catch {
    return false;
  }
}
