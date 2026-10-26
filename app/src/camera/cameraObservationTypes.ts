import type { CameraVisionStructuredResultV1 } from './cameraVisionStructured';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';

export const CAMERA_OBSERVATION_DATABASE_NAME = 'junluo-camera-observation.db' as const;
export const CAMERA_OBSERVATION_SCHEMA_VERSION = 3 as const;

export const CAMERA_OBSERVATION_TRIGGER_KINDS = [
  'manual_look',
  'action_opportunity',
  'max_interval_deadline',
  'retry_after_failure',
] as const;

export type CameraObservationTriggerKind = typeof CAMERA_OBSERVATION_TRIGGER_KINDS[number];

export type CameraObservationRecordV1 = {
  schemaVersion: 1;
  observationId: string;
  actionId: string;
  requestId: string;
  sessionId: string;
  triggerKind: CameraObservationTriggerKind;
  sourceKind: 'android_front' | 'android_back' | 'pc_webcam';
  capturedAt: number;
  analyzedAt: number;
  persistedAt: number;
  capture: {
    width: number;
    height: number;
    rotation: 0 | 90 | 180 | 270;
    mirrored: boolean;
  };
  analysis: {
    provider: string;
    model: string;
    latencyMs: number;
    attemptCount: 1 | 2;
    repairUsed: boolean;
    responseFormatRequested: boolean;
  };
  result: CameraVisionStructuredResultV1;
  cleanup: {
    cleanupState: 'verified_deleted';
    deletionVerified: true;
    completedAt: number;
    auditPersisted: boolean;
  };
};

export type CameraObservationPersistInput = Omit<
  CameraObservationRecordV1,
  'schemaVersion' | 'observationId' | 'persistedAt'
>;

export type CameraObservationCursor = {
  capturedAt: number;
  observationId: string;
};

export type CameraObservationResponseBinding = {
  targetSessionId: string;
  origin: 'manual_share' | 'chat_tool' | 'proactive_tool';
  sourceTurnId: string;
  requestedAt: number;
};

export type CameraObservationReplyDraft = {
  replyId: string;
  messages: SubjectiveMessage[];
  adoptedReply?: string;
};

export type CameraObservationResponse = {
  observationId: string;
  binding: CameraObservationResponseBinding;
  status: 'pending' | 'draft_ready' | 'delivered' | 'cancelled';
  draft?: CameraObservationReplyDraft;
  messageIds: string[];
};

export type CameraObservationTimelineItem = {
  observationId: string;
  capturedAt: number;
  sourceKind: CameraObservationRecordV1['sourceKind'];
  triggerKind: CameraObservationTriggerKind;
  sceneSummary: string;
  frameUsability: CameraVisionStructuredResultV1['frameUsability'];
  overallConfidence: CameraVisionStructuredResultV1['overallConfidence'];
  visibleCount: number | null;
  responseStatus: 'not_scheduled' | CameraObservationResponse['status'];
};

export type CameraObservationHistoryPage = {
  records: CameraObservationTimelineItem[];
  nextCursor?: CameraObservationCursor;
};

export type CameraObservationHistorySummary = {
  recordCount: number;
  latestCapturedAt?: number;
};

export type CameraObservationRecallCandidate = Pick<
  CameraObservationRecordV1,
  'observationId' | 'capturedAt' | 'sourceKind' | 'result'
>;

export type CameraObservationDeleteReason = 'single' | 'date_range' | 'delete_all';

export type CameraObservationDeletionTombstone = {
  observationId: string;
  deletedAt: number;
  deleteReason: CameraObservationDeleteReason;
  responseDeliveryStatus?: 'blocked' | CameraObservationResponse['status'];
  messageId?: string;
};

export type CameraObservationBackupInspection = {
  schemaVersion: 1 | 2 | 3;
  recordCount: number;
};
