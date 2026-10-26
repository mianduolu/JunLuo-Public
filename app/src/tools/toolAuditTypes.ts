import type { JunLuoToolCallSource } from './toolTypes';
import type { MusicPlaybackObservation } from '../music/musicPlaybackObservation';
import type { OwnScheduleSave } from '../schedule/ownScheduleSaveState';
import type { UserRoutineSaveState } from '../schedule/userRoutineSaveState';
import type { PhoneLimitSave } from './phoneLimitAuditState';

export type JunLuoToolAuditStatus =
  | 'requested'
  | 'awaiting_permission'
  | 'awaiting_confirmation'
  | 'permission_denied'
  | 'running'
  | 'success'
  | 'error'
  | 'cancelled'
  | 'outcome_unknown';

export type JunLuoToolPermissionDecision = 'not_checked' | 'allowed' | 'denied' | 'cancelled';

export type JunLuoToolPermissionAuthorizationSource =
  | 'bypass'
  | 'tool_override'
  | 'package_override'
  | 'global_default'
  | 'tool_definition'
  | 'risk_default'
  | 'session_grant'
  | 'today_grant'
  | 'parameter_grant'
  | 'music_preference'
  | 'prompt';

export type JunLuoToolInputPreviewValue =
  | string
  | number
  | boolean
  | null
  | { type: 'array'; length: number }
  | { type: 'object'; keys: string[] }
  | { type: 'unknown' };

export type JunLuoToolAuditRecord = {
  callId: string;
  executionId?: string;
  toolId: string;
  packageId: string;
  source: JunLuoToolCallSource;
  sourceMessageId?: string;
  executionIntentId?: string;
  executionIntentSource?: string;
  inputPreview: Record<string, JunLuoToolInputPreviewValue>;
  permissionDecision: JunLuoToolPermissionDecision;
  permissionSource?: JunLuoToolPermissionAuthorizationSource;
  permissionGrantId?: string;
  permissionExpiresAt?: number;
  permissionSilent?: boolean;
  status: JunLuoToolAuditStatus;
  resultSummary?: string;
  errorMessage?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Confirmed player observations; only the mutable audit-event is synchronized. */
  musicPlayback?: MusicPlaybackObservation[];
  scheduleSave?: OwnScheduleSave;
  routineSave?: UserRoutineSaveState;
  /** Device-local delivery references; excluded from the existing sync projection. */
  cameraReply?: { sessionId: string; messageIds: string[] };
  /** Device-local phone continuation. Null means a present, unreadable continuation. */
  phoneLimitSave?: PhoneLimitSave | null;
  agent?: JunLuoToolAgentAuditMetadata;
};

export type JunLuoToolAgentAuditMetadata = {
  auditId: string;
  turnId: string;
  providerCallId: string;
  toolRound: 1 | 2 | 3;
  candidateSource?: string;
  authorityKind?: string;
  providerFinishReason?: string;
  proposalId?: string;
  confirmationDecision?: 'confirmed' | 'declined' | 'expired';
  settlement?: 'settled' | 'aborted' | 'outcome_unknown';
  dataEpoch: number;
  executionDurationMs?: number;
};
