import type { BaiyunActionIntentId } from '../ai/behavior/actionIntent';

export const CAMERA_PERCEPTION_SCHEMA_VERSION = 1 as const;

export const CAMERA_SOURCE_KINDS = [
  'android_front',
  'android_back',
  'pc_webcam',
  'esp32_cam',
] as const;

export type CameraSourceKind = typeof CAMERA_SOURCE_KINDS[number];

export const CAMERA_SESSION_STATUSES = [
  'stopped',
  'starting',
  'running',
  'paused_camera_busy',
  'paused_permission',
  'paused_system',
  'stopping',
  'error',
] as const;

export type CameraSessionStatus = typeof CAMERA_SESSION_STATUSES[number];

export const CAMERA_TRIGGER_KINDS = [
  'manual_look',
  'manual_save',
  'action_opportunity',
  'max_interval_deadline',
  'retry_after_failure',
] as const;

export type CameraTriggerKind = typeof CAMERA_TRIGGER_KINDS[number];
export type CameraObservationConfidence = 'high' | 'medium' | 'low';
export type CameraInternalSubject = 'I' | 'you';
export type CameraFacing = 'front' | 'back' | 'fixed';
export type CameraRawFrameRetention = 'deleted_after_analysis' | 'explicitly_saved_by_you';

export type CameraStoppedObservationSession = {
  schemaVersion: typeof CAMERA_PERCEPTION_SCHEMA_VERSION;
  revision: number;
  status: 'stopped';
  stoppedAt?: number;
  lastSessionId?: string;
  stopReasonCode?: string;
};

export type CameraActiveObservationSession = {
  schemaVersion: typeof CAMERA_PERCEPTION_SCHEMA_VERSION;
  revision: number;
  status: Exclude<CameraSessionStatus, 'stopped'>;
  sessionId: string;
  sourceKind: CameraSourceKind;
  startedAt: number;
  startedBy: Extract<CameraInternalSubject, 'you'>;
  lastHeartbeatAt: number;
  lastSuccessfulObservationAt?: number;
  nextOpportunityAt?: number;
  hardDeadlineAt?: number;
  lastFailureCode?: string;
  stopReasonCode?: string;
  persistentNotificationVisible: boolean;
};

export type CameraObservationSession =
  | CameraStoppedObservationSession
  | CameraActiveObservationSession;

export type CameraObservationRequest = {
  schemaVersion: typeof CAMERA_PERCEPTION_SCHEMA_VERSION;
  requestId: string;
  sessionId: string;
  sourceKind: CameraSourceKind;
  triggerKind: CameraTriggerKind;
  requestedAt: number;
  actionIntentId?: BaiyunActionIntentId;
  continuityEventId?: string;
  minimumIntervalBypassed: boolean;
  privacyMode: 'analyze_then_delete' | 'explicit_save';
  idempotencyKey: string;
};

type CameraCaptureReceiptBase = {
  schemaVersion: typeof CAMERA_PERCEPTION_SCHEMA_VERSION;
  requestId: string;
  sessionId: string;
  sourceKind: CameraSourceKind;
};

export type CameraCaptureSuccessReceipt = CameraCaptureReceiptBase & {
  captureSucceeded: true;
  captureGeneration: number;
  revision: number;
  capturedAt: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  temporaryUri: string;
  temporaryFrameId: string;
  releaseToken: string;
  sha256: string;
  byteLength: number;
};

export type CameraCaptureFailureReceipt = CameraCaptureReceiptBase & {
  captureSucceeded: false;
  failedAt: number;
  failureCode: string;
};

export type CameraCaptureReceipt = CameraCaptureSuccessReceipt | CameraCaptureFailureReceipt;

export type CameraManualSaveDestination = {
  configured: boolean;
  available: boolean;
  directoryDisplayName?: string;
  selectedAt?: number;
};

export type CameraFrameCleanupState =
  | 'none'
  | 'deleting'
  | 'retrying'
  | 'verified_deleted'
  | 'failed';

export type CameraFrameDeletionProof = {
  proofId: string;
  completedAt: number;
  trigger: string;
  byteLength?: number;
  sha256Prefix?: string;
  attemptCount: number;
  deletionVerified: boolean;
  orphanRecovered: boolean;
};

export type CameraFramePrivacyState = {
  schemaVersion: 1;
  activeFrameCount: number;
  retryingFrameCount: number;
  orphanFrameCount: number;
  cacheEmpty: boolean;
  lastCleanupAt?: number;
  lastCleanupState: CameraFrameCleanupState;
  lastCleanupTrigger?: string;
  startupOrphansDeleted: number;
  auditAvailable: boolean;
  latestProof?: CameraFrameDeletionProof;
};

export type CameraFrameReleaseReceipt = {
  success: boolean;
  cleanupState: 'verified_deleted' | 'retrying' | 'failed';
  deletionVerified: boolean;
  alreadyDeleted: boolean;
  auditPersisted: boolean;
  failureCode?: string;
};

export type CameraSensitiveBackupPolicy = {
  schemaVersion: 1;
  consentGranted: boolean;
  updatedAt?: number;
};

export type CameraLookOnceReceipt = {
  schemaVersion: 1;
  actionId: string;
  sessionId: string;
  requestId: string;
  sourceKind: Extract<CameraSourceKind, 'android_front' | 'android_back'>;
  capturedAt: number;
  completedAt: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  visionProvider: string;
  visionModel: string;
  latencyMs: number;
  schemaValid: true;
  analysisAttempts: 1 | 2;
  repairUsed: boolean;
  structuredContentPresented: true;
  freeFormContentPresented: false;
  temporaryFrameReleased: true;
  persisted: true;
  observationId: string;
};

export type CameraManualSaveReceipt = {
  actionId: string;
  sessionId: string;
  requestId: string;
  sourceKind: Extract<CameraSourceKind, 'android_front' | 'android_back'>;
  capturedAt: number;
  savedAt: number;
  fileName: string;
  directoryDisplayName: string;
  mimeType: 'image/jpeg';
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  mirrored: boolean;
  byteLength: number;
  sha256: string;
  destinationVerified: true;
  sourceFrameCleanup: 'released' | 'retrying';
  consentSource: 'explicit_manual_save_confirmation';
  longTermStorage: 'user_selected_saf_directory';
};

export type CameraCaptureAuditReceipt =
  | Omit<CameraCaptureSuccessReceipt, 'temporaryUri' | 'temporaryFrameId' | 'releaseToken'>
  | CameraCaptureFailureReceipt;

export type CameraSubjectVisibility =
  | 'clearly_visible'
  | 'partially_visible'
  | 'not_visible'
  | 'uncertain';

export type CameraObservation = {
  schemaVersion: typeof CAMERA_PERCEPTION_SCHEMA_VERSION;
  observationId: string;
  requestId: string;
  sourceKind: CameraSourceKind;
  capturedAt: number;
  analyzedAt: number;
  objectiveFacts: readonly string[];
  subjectVisibility: CameraSubjectVisibility;
  sceneSummary: string;
  inferences: readonly string[];
  uncertainties: readonly string[];
  confidence: CameraObservationConfidence;
  deviceContextFacts: readonly string[];
  suggestedIntentIds: readonly BaiyunActionIntentId[];
  needsTimelyResponse: boolean;
  visionProvider: string;
  visionModel: string;
  latencyMs: number;
  schemaValid: true;
  rawFrameDeletedAt?: number;
  rawFrameRetention: CameraRawFrameRetention;
};

export type CameraResponseObligation = {
  schemaVersion: typeof CAMERA_PERCEPTION_SCHEMA_VERSION;
  observationId: string;
  continuityEventId: string;
  deliveryStatus: 'pending' | 'blocked' | 'delivered' | 'cancelled';
  messageId?: string;
  attemptCount: number;
  nextActionAt?: number;
};

function assertNonEmpty(value: string, code: string) {
  if (!value.trim()) throw new Error(code);
}

export function validateCameraObservationRequest(request: CameraObservationRequest) {
  assertNonEmpty(request.requestId, 'camera_request_id_required');
  assertNonEmpty(request.sessionId, 'camera_session_id_required');
  assertNonEmpty(request.idempotencyKey, 'camera_idempotency_key_required');

  if (request.triggerKind === 'manual_save') {
    if (request.privacyMode !== 'explicit_save') {
      throw new Error('camera_manual_save_requires_explicit_retention');
    }
  } else if (request.privacyMode !== 'analyze_then_delete') {
    throw new Error('camera_autonomous_frame_must_be_ephemeral');
  }

  const mayBypassInterval = request.triggerKind === 'manual_look'
    || request.triggerKind === 'manual_save';
  if (request.minimumIntervalBypassed && !mayBypassInterval) {
    throw new Error('camera_interval_bypass_requires_manual_trigger');
  }
  return request;
}

export function toCameraCaptureAuditReceipt(
  receipt: CameraCaptureReceipt,
): CameraCaptureAuditReceipt {
  if (!receipt.captureSucceeded) return { ...receipt };
  return {
    schemaVersion: receipt.schemaVersion,
    requestId: receipt.requestId,
    sessionId: receipt.sessionId,
    sourceKind: receipt.sourceKind,
    captureSucceeded: true,
    captureGeneration: receipt.captureGeneration,
    revision: receipt.revision,
    capturedAt: receipt.capturedAt,
    width: receipt.width,
    height: receipt.height,
    rotation: receipt.rotation,
    mirrored: receipt.mirrored,
    sha256: receipt.sha256,
    byteLength: receipt.byteLength,
  };
}
