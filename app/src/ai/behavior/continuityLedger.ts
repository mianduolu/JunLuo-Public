import AsyncStorage from '@react-native-async-storage/async-storage';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { ensureChatCareCleanup } from './chatCareCleanup';
import { HEART_CARE_RECORD_PREDICATE, isHeartCareMatter, loadHeartCareDeviceRecord } from './heartCareMatter';
import { recordChatCareRejection } from '../../chat/chatAuxiliaryDiagnostics';
import { canonicalizeContinuityMatterRecord, isRetiredContinuityCard, CONTINUITY_MATTER_REAL_EVIDENCE } from './continuityMatterRecord';

import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../../backup/backupRestoreCoordinator';
import type { MemoryContinuityContextLink } from '../../memory/memoryDataBoundary';
import {
  beginContinuityPendingOperationAttempt,
  buildContinuityPendingOperationJournal,
  CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
  markContinuityPendingOperationCommitted,
  parseContinuityPendingOperationJournal,
  serializeContinuityPendingOperationJournal,
  type ContinuityPendingOperationJournalV1,
} from '../../sync/syncContinuityPendingOperation';
import { runWithMemoryRecordsCaptureSuppressed } from '../../sync/syncMemoryRecordsSqlitePort';
import { getMemoryDatabase as getMemoryDatabaseForSource } from '../../memory/memoryStore';
import {
  BAIYUN_CONTINUITY_EVENT_KINDS,
  BAIYUN_CONTINUITY_EVENT_STATUSES,
  assertBaiyunContinuityTransition,
  buildBaiyunContinuityEvent,
  canCompleteBaiyunContinuityEvent,
  resolveBaiyunContinuityCompletionRule,
  type BaiyunContinuityCompletionRule,
  type BaiyunContinuityEvent,
  type BaiyunContinuityEventKind,
  type BaiyunContinuityEventSource,
  type BaiyunContinuityEventStage,
  type BaiyunContinuityEventStatus,
  type BaiyunContinuityEvidence,
  type BaiyunContinuityEvidenceKind,
  type BaiyunContinuityResumeCondition,
  type BaiyunContinuitySubject,
  type BaiyunCareMatterProgress,
  type BaiyunCareTimeSources,
} from './continuityEvent';
import {
  getBaiyunActionContract,
  isBaiyunActionIntentId,
  isBaiyunRetiredActionIntentId,
  type BaiyunActionIntentId,
  type BaiyunRequiredBehaviorId,
} from './actionIntent';

const getMemoryDatabase = () => getMemoryDatabaseForSource('continuity');

export const BAIYUN_CONTINUITY_TEST_PREFIX = 'continuity-acceptance:';

const RETIRED_STAY_FOSSIL_EVENT_IDS = [
  'continuity-event-msxav0jd-jppp8k6q',
  'continuity-event-msxaw6r3-huijr9ar',
  'continuity-event-msxcf3a4-sltteyiq',
  'continuity-event-mszswy5d-a3okgpcu',
  'continuity-event-mt61t8im-knh3x4cv',
  'continuity-event-mt79ldck-sx0jj3l8',
] as const;
const RETIRED_STAY_FOSSIL_PLACEHOLDERS = RETIRED_STAY_FOSSIL_EVENT_IDS.map(() => '?').join(', ');
const RETIRED_STAY_FOSSIL_LINK_COUNT = 28;

type RetiredStaySyncOutboxRow = {
  mutation_id: string;
  revision_id: string;
  entity_id: string;
  operation: string;
  state: string;
  attempt_count: number;
  source_sequence: number | null;
  lease_id: string | null;
  lease_expires_at: number | null;
};

type RetiredStaySyncHeadRow = {
  entity_id: string;
  revision_id: string;
};

export const BAIYUN_CONTINUITY_CANDIDATE_KINDS = [
  'create_event',
  'resolve_event',
] as const;
export type BaiyunContinuityCandidateKind =
  typeof BAIYUN_CONTINUITY_CANDIDATE_KINDS[number];

export const BAIYUN_CONTINUITY_CANDIDATE_STATES = [
  'pending',
  'accepted',
  'dismissed',
  'expired',
] as const;
export type BaiyunContinuityCandidateState =
  typeof BAIYUN_CONTINUITY_CANDIDATE_STATES[number];

export const BAIYUN_CONTINUITY_RESOLUTION_STATES = [
  'progressed',
  'completed',
  'cancelled',
] as const;
export type BaiyunContinuityResolutionState =
  typeof BAIYUN_CONTINUITY_RESOLUTION_STATES[number];

export const BAIYUN_CONTINUITY_DETECTION_BASES = [
  'local_explicit',
  'semantic',
  'combined',
] as const;
export type BaiyunContinuityDetectionBasis =
  typeof BAIYUN_CONTINUITY_DETECTION_BASES[number];

export type BaiyunContinuityCandidate = {
  id: string;
  candidateKey: string;
  kind: BaiyunContinuityCandidateKind;
  state: BaiyunContinuityCandidateState;
  eventKind?: BaiyunContinuityEventKind;
  primaryIntent?: BaiyunActionIntentId;
  targetEventId?: string;
  proposedResolution?: BaiyunContinuityResolutionState;
  sessionId: string;
  messageId: string;
  detectionBasis: BaiyunContinuityDetectionBasis;
  confidence: number;
  reasonCodes: string[];
  coalescingKey?: string;
  resultEventId?: string;
  occurredAt: number;
  expiresAt: number;
  resolvedAt?: number;
  createdAt: number;
  updatedAt: number;
  revision: number;
  schemaVersion: 1;
};

type ContinuityDatabase = Awaited<ReturnType<typeof getMemoryDatabase>>;

type ContinuityEventRow = {
  id: string;
  kind: string;
  status: string;
  stage: string;
  subject: string;
  returning_subject: string | null;
  primary_intent: string | null;
  item_name: string | null;
  progress: string | null;
  duration_ms: number | null;
  care_time_sources_json: string | null;
  care_evidence_json: string | null;
  parent_event_id: string | null;
  idempotency_key: string;
  coalescing_key: string | null;
  focus_excerpt: string | null;
  source_kind: string;
  source_id: string;
  source_global_basis_json: string | null;
  occurred_at: number;
  occurred_local_date: string;
  timezone_offset_minutes: number;
  next_action_at: number | null;
  resume_condition_json: string | null;
  required_behaviors_json: string | null;
  completion_rule_json: string;
  permission_requirements_json: string;
  attempt_count: number;
  last_attempt_at: number | null;
  last_attempt_outcome: string | null;
  pause_reason_code: string | null;
  cancelled_reason: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  cancelled_at: number | null;
  revision: number;
  schema_version: number;
};

type ContinuityCandidateRow = {
  id: string;
  candidate_key: string;
  candidate_kind: string;
  state: string;
  event_kind: string | null;
  primary_intent: string | null;
  target_event_id: string | null;
  proposed_resolution: string | null;
  session_id: string;
  message_id: string;
  detection_basis: string;
  confidence: number;
  reason_codes_json: string;
  coalescing_key: string | null;
  result_event_id: string | null;
  occurred_at: number;
  expires_at: number;
  resolved_at: number | null;
  created_at: number;
  updated_at: number;
  revision: number;
  schema_version: number;
};

export type BaiyunContinuityTransition = {
  id: string;
  operationId: string;
  eventId: string;
  kind: 'created' | 'merged' | 'transitioned' | 'evidence_recorded' | 'completed' | 'cancelled';
  fromStatus?: BaiyunContinuityEventStatus;
  toStatus?: BaiyunContinuityEventStatus;
  fromStage?: BaiyunContinuityEventStage;
  toStage?: BaiyunContinuityEventStage;
  reasonCode?: string;
  evidence?: BaiyunContinuityEvidence;
  occurredAt: number;
};

type ContinuityTransitionRow = {
  id: string;
  operation_id: string;
  event_id: string;
  transition_kind: BaiyunContinuityTransition['kind'];
  from_status: BaiyunContinuityEventStatus | null;
  to_status: BaiyunContinuityEventStatus | null;
  from_stage: BaiyunContinuityEventStage | null;
  to_stage: BaiyunContinuityEventStage | null;
  reason_code: string | null;
  evidence_id: string | null;
  evidence_kind: BaiyunContinuityEvidenceKind | null;
  evidence_source_id: string | null;
  evidence_outcome: BaiyunContinuityEvidence['outcome'] | null;
  occurred_at: number;
};

export type BaiyunContinuityEventLink = {
  eventId: string;
  relation:
    | 'source'
    | 'parent'
    | 'message'
    | 'tool'
    | 'device'
    | 'notification'
    | 'task'
    | MemoryContinuityContextLink['relation'];
  targetKind: string;
  targetId: string;
  createdAt: number;
};

export type BaiyunContinuityDateRange = {
  fromInclusive: number;
  toExclusive: number;
};

export type ListBaiyunContinuityEventsQuery = {
  offset?: number;
  readOnly?: boolean;
  statuses?: readonly BaiyunContinuityEventStatus[];
  kinds?: readonly BaiyunContinuityEventKind[];
  contextTarget?: MemoryContinuityContextLink;
  activeDuring?: BaiyunContinuityDateRange;
  limit?: number;
};

export type BaiyunContinuityContextSummary = {
  eventId: string;
  memories: Array<{
    id: string;
    title: string;
    status: 'active' | 'archived';
  }>;
  currentStates: Array<{
    id: string;
    title: string;
    kind: string;
    status: 'active' | 'resolved' | 'expired';
  }>;
};

export type SetBaiyunContinuityContextOutcome = {
  status:
    | 'updated'
    | 'unchanged'
    | 'target_missing'
    | 'event_missing'
    | 'terminal_event'
    | 'data_epoch_changed';
  added: number;
  removed: number;
};

type CreateOperation = {
  version: 1;
  type: 'create';
  operationId: string;
  event: BaiyunContinuityEvent;
  links: BaiyunContinuityEventLink[];
};

type TransitionOperation = {
  version: 1;
  type: 'transition';
  operationId: string;
  eventId: string;
  expectedRevision: number;
  nextStage: BaiyunContinuityEventStage;
  nextStatus?: Extract<BaiyunContinuityEventStatus, 'open' | 'waiting'>;
  reasonCode: string;
  occurredAt: number;
  nextActionAt?: number;
  resumeCondition?: BaiyunContinuityResumeCondition;
};

type EvidenceOperation = {
  version: 1;
  type: 'evidence';
  operationId: string;
  eventId: string;
  expectedRevision: number;
  evidence: BaiyunContinuityEvidence;
  nextStage?: BaiyunContinuityEventStage;
  nextStatus?: Extract<BaiyunContinuityEventStatus, 'open' | 'waiting'>;
  reasonCode?: string;
  nextActionAt?: number;
};

type CancelOperation = {
  version: 1;
  type: 'cancel';
  operationId: string;
  eventId: string;
  expectedRevision: number;
  reasonCode: string;
  occurredAt: number;
};

type DueOperation = {
  version: 1;
  type: 'advance_due';
  operationId: string;
  now: number;
};

type ClearAcceptanceOperation = {
  version: 1;
  type: 'clear_acceptance';
  operationId: string;
  occurredAt: number;
};

type CandidateUpsertOperation = {
  version: 1;
  type: 'candidate_upsert';
  operationId: string;
  candidate: BaiyunContinuityCandidate;
};

type CandidateAcceptOperation = {
  version: 1;
  type: 'candidate_accept';
  operationId: string;
  candidateId: string;
  expectedRevision: number;
  occurredAt: number;
};

type CandidateSetStateOperation = {
  version: 1;
  type: 'candidate_set_state';
  operationId: string;
  candidateId: string;
  expectedRevision: number;
  nextState: Extract<BaiyunContinuityCandidateState, 'dismissed' | 'expired'>;
  occurredAt: number;
};

type CandidateExpireOperation = {
  version: 1;
  type: 'candidate_expire';
  operationId: string;
  now: number;
};

type CandidateUndoRegistrationOperation = {
  version: 1;
  type: 'candidate_undo_registration';
  operationId: string;
  candidateId: string;
  expectedRevision: number;
  occurredAt: number;
};

type PendingOperation =
  | CareMatterOperation
  | CreateOperation
  | TransitionOperation
  | EvidenceOperation
  | CancelOperation
  | DueOperation
  | ClearAcceptanceOperation
  | CandidateUpsertOperation
  | CandidateAcceptOperation
  | CandidateSetStateOperation
  | CandidateExpireOperation
  | CandidateUndoRegistrationOperation;

let mutationQueue: Promise<void> = Promise.resolve();
let recoveryFlight: Promise<void> | null = null;

function enqueueMutation<T>(work: () => Promise<T>) {
  const turn = mutationQueue.catch(() => undefined);
  let release!: () => void;
  const occupied = new Promise<void>((resolve) => {
    release = resolve;
  });
  mutationQueue = turn.then(() => occupied);
  return turn.then(work).finally(release);
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function createId(prefix: string, now = Date.now()) {
  return `${prefix}-${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function eventFromRow(row: ContinuityEventRow): BaiyunContinuityEvent {
  const globalBasis = parseJson<BaiyunContinuityEventSource | undefined>(
    row.source_global_basis_json,
    undefined,
  );
  const source = row.source_kind === 'theater'
    ? {
      kind: 'theater' as const,
      sourceId: row.source_id,
      globalBasis: globalBasis?.kind === 'theater' || globalBasis?.kind === 'bedtime_care' ? undefined : globalBasis,
    }
    : { kind: row.source_kind, sourceId: row.source_id } as BaiyunContinuityEventSource;
  const storedCompletionRule = parseJson<BaiyunContinuityCompletionRule>(
    row.completion_rule_json,
    { allOf: [], anyOf: [] },
  );
  return {
    id: row.id,
    kind: row.kind as BaiyunContinuityEventKind,
    status: row.status as BaiyunContinuityEventStatus,
    stage: row.stage as BaiyunContinuityEventStage,
    subject: row.subject as BaiyunContinuitySubject,
    returningSubject: row.returning_subject as BaiyunContinuitySubject | undefined,
    ...(row.schema_version === 1 ? { primaryIntent: row.primary_intent as BaiyunActionIntentId } : {}),
    itemName: row.item_name ?? undefined,
    progress: (row.progress ?? undefined) as BaiyunCareMatterProgress | undefined,
    durationMs: row.duration_ms ?? undefined,
    careTimeSources: parseJson<BaiyunCareTimeSources | undefined>(row.care_time_sources_json, undefined),
    careEvidence: parseJson<BaiyunContinuityEvent['careEvidence']>(row.care_evidence_json, undefined),
    parentEventId: row.parent_event_id ?? undefined,
    idempotencyKey: row.idempotency_key,
    coalescingKey: row.coalescing_key ?? undefined,
    focusExcerpt: row.focus_excerpt ?? undefined,
    source,
    occurredAt: row.occurred_at,
    occurredLocalDate: row.occurred_local_date,
    timezoneOffsetMinutes: row.timezone_offset_minutes,
    nextActionAt: row.next_action_at ?? undefined,
    resumeCondition: parseJson<BaiyunContinuityResumeCondition | undefined>(
      row.resume_condition_json,
      undefined,
    ),
    ...(row.schema_version === 1 ? { requiredBehaviors: parseJson<BaiyunRequiredBehaviorId[]>(row.required_behaviors_json, []) } : {}),
    completionRule: row.schema_version !== 1 ? storedCompletionRule : resolveBaiyunContinuityCompletionRule({
      kind: row.kind as BaiyunContinuityEventKind,
      primaryIntent: row.primary_intent as BaiyunActionIntentId,
      storedRule: storedCompletionRule,
      status: row.status as BaiyunContinuityEventStatus,
    }),
    permissionRequirements: parseJson<string[]>(row.permission_requirements_json, []),
    attemptCount: row.attempt_count,
    lastAttemptAt: row.last_attempt_at ?? undefined,
    lastAttemptOutcome: row.last_attempt_outcome as BaiyunContinuityEvent['lastAttemptOutcome'],
    pauseReasonCode: row.pause_reason_code ?? undefined,
    cancelledReason: row.cancelled_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
    cancelledAt: row.cancelled_at ?? undefined,
    revision: row.revision,
    schemaVersion: row.schema_version === 3 ? 3 : row.schema_version === 2 ? 2 : 1,
  };
}

function candidateFromRow(row: ContinuityCandidateRow): BaiyunContinuityCandidate {
  return {
    id: row.id,
    candidateKey: row.candidate_key,
    kind: row.candidate_kind as BaiyunContinuityCandidateKind,
    state: row.state as BaiyunContinuityCandidateState,
    eventKind: row.event_kind as BaiyunContinuityEventKind | undefined,
    primaryIntent: row.primary_intent as BaiyunActionIntentId | undefined,
    targetEventId: row.target_event_id ?? undefined,
    proposedResolution: row.proposed_resolution as BaiyunContinuityResolutionState | undefined,
    sessionId: row.session_id,
    messageId: row.message_id,
    detectionBasis: row.detection_basis as BaiyunContinuityDetectionBasis,
    confidence: row.confidence,
    reasonCodes: parseJson<string[]>(row.reason_codes_json, []),
    coalescingKey: row.coalescing_key ?? undefined,
    resultEventId: row.result_event_id ?? undefined,
    occurredAt: row.occurred_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    schemaVersion: 1,
  };
}

function isRetiredContinuityEvent(event: BaiyunContinuityEvent) {
  return isRetiredContinuityCard({ id: event.id, schema_version: event.schemaVersion,
    idempotency_key: event.idempotencyKey, kind: event.kind, source_kind: event.source.kind });
}

function isRetiredContinuityCandidate(candidate: BaiyunContinuityCandidate) {
  return isBaiyunRetiredActionIntentId(candidate.primaryIntent);
}

async function candidateTargetsRetiredEvent(
  database: ContinuityDatabase,
  candidate: BaiyunContinuityCandidate,
) {
  if (isRetiredContinuityCandidate(candidate)) return true;
  const eventIds = [candidate.targetEventId, candidate.resultEventId]
    .filter((eventId): eventId is string => typeof eventId === 'string');
  for (const eventId of eventIds) {
    const row = await getEventRow(database, eventId);
    if (row?.primary_intent === 'stay') return true;
  }
  return false;
}

function transitionFromRow(row: ContinuityTransitionRow): BaiyunContinuityTransition {
  const evidence = row.evidence_id && row.evidence_kind && row.evidence_source_id && row.evidence_outcome
    ? {
      id: row.evidence_id,
      kind: row.evidence_kind,
      sourceId: row.evidence_source_id,
      occurredAt: row.occurred_at,
      outcome: row.evidence_outcome,
    }
    : undefined;
  return {
    id: row.id,
    operationId: row.operation_id,
    eventId: row.event_id,
    kind: row.transition_kind,
    fromStatus: row.from_status ?? undefined,
    toStatus: row.to_status ?? undefined,
    fromStage: row.from_stage ?? undefined,
    toStage: row.to_stage ?? undefined,
    reasonCode: row.reason_code ?? undefined,
    evidence,
    occurredAt: row.occurred_at,
  };
}

async function getContinuityDatabase(readOnly = false) {
  const database = await getMemoryDatabase();
  if (!readOnly) await ensureChatCareCleanup(database);
  return database;
}

async function getEventRow(database: ContinuityDatabase, eventId: string) {
  return database.getFirstAsync<ContinuityEventRow>(
    'SELECT * FROM continuity_events WHERE id = ?',
    eventId,
  );
}

async function getEventByIdempotencyKey(database: ContinuityDatabase, idempotencyKey: string) {
  return database.getFirstAsync<ContinuityEventRow>(
    'SELECT * FROM continuity_events WHERE idempotency_key = ?',
    idempotencyKey,
  );
}

async function getCandidateRow(database: ContinuityDatabase, candidateId: string) {
  return database.getFirstAsync<ContinuityCandidateRow>(
    'SELECT * FROM continuity_event_candidates WHERE id = ?',
    candidateId,
  );
}

async function getCandidateByKey(database: ContinuityDatabase, candidateKey: string) {
  return database.getFirstAsync<ContinuityCandidateRow>(
    'SELECT * FROM continuity_event_candidates WHERE candidate_key = ?',
    candidateKey,
  );
}

async function operationAlreadyApplied(database: ContinuityDatabase, operationId: string) {
  const row = await database.getFirstAsync<{ id: string }>(
    'SELECT id FROM continuity_event_transitions WHERE operation_id = ?',
    operationId,
  );
  return Boolean(row);
}

async function getEventRowForOperation(
  database: ContinuityDatabase,
  operationId: string,
) {
  return database.getFirstAsync<ContinuityEventRow>(
    `SELECT event.* FROM continuity_events event
     INNER JOIN continuity_event_transitions transition_row
       ON transition_row.event_id = event.id
     WHERE transition_row.operation_id = ?
       AND event.primary_intent IS NOT 'stay'`,
    operationId,
  );
}

async function insertTransition(
  database: ContinuityDatabase,
  transition: BaiyunContinuityTransition,
) {
  await database.runAsync(
    `INSERT OR IGNORE INTO continuity_event_transitions (
      id, operation_id, event_id, transition_kind,
      from_status, to_status, from_stage, to_stage,
      reason_code, evidence_id, evidence_kind, evidence_source_id,
      evidence_outcome, occurred_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    transition.id,
    transition.operationId,
    transition.eventId,
    transition.kind,
    transition.fromStatus ?? null,
    transition.toStatus ?? null,
    transition.fromStage ?? null,
    transition.toStage ?? null,
    transition.reasonCode ?? null,
    transition.evidence?.id ?? null,
    transition.evidence?.kind ?? null,
    transition.evidence?.sourceId ?? null,
    transition.evidence?.outcome ?? null,
    transition.occurredAt,
  );
}

async function insertLinks(
  database: ContinuityDatabase,
  links: readonly BaiyunContinuityEventLink[],
) {
  for (const link of links) {
    await database.runAsync(
      `INSERT OR IGNORE INTO continuity_event_links (
        event_id, relation, target_kind, target_id, created_at
      ) VALUES (?, ?, ?, ?, ?)`,
      link.eventId,
      link.relation,
      link.targetKind,
      link.targetId,
      link.createdAt,
    );
  }
}

async function insertEvent(database: ContinuityDatabase, event: BaiyunContinuityEvent) {
  const globalBasis = event.source.kind === 'theater'
    ? JSON.stringify(event.source.globalBasis)
    : null;
  await database.runAsync(
    `INSERT INTO continuity_events (
      id, kind, status, stage, subject, returning_subject,
      primary_intent, parent_event_id, idempotency_key, coalescing_key,
      focus_excerpt, source_kind, source_id, source_global_basis_json,
      occurred_at, occurred_local_date, timezone_offset_minutes,
      next_action_at, resume_condition_json, required_behaviors_json,
      completion_rule_json, permission_requirements_json, attempt_count,
      created_at, updated_at, revision, schema_version,
      item_name, progress, duration_ms, care_time_sources_json, completed_at, cancelled_at, care_evidence_json
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`,
    event.id,
    event.kind,
    event.status,
    event.stage,
    event.subject,
    event.returningSubject ?? null,
    event.schemaVersion !== 1 ? null : event.primaryIntent ?? null,
    event.parentEventId ?? null,
    event.idempotencyKey,
    event.coalescingKey ?? null,
    event.focusExcerpt ?? null,
    event.source.kind,
    event.source.sourceId,
    globalBasis,
    event.occurredAt,
    event.occurredLocalDate,
    event.timezoneOffsetMinutes,
    event.nextActionAt ?? null,
    event.resumeCondition ? JSON.stringify(event.resumeCondition) : null,
    event.schemaVersion !== 1 ? null : JSON.stringify(event.requiredBehaviors ?? []),
    JSON.stringify(event.completionRule),
    JSON.stringify(event.permissionRequirements),
    event.attemptCount,
    event.createdAt,
    event.updatedAt,
    event.revision,
    event.schemaVersion,
    event.itemName ?? null,
    event.progress ?? null,
    event.durationMs ?? null,
    event.careTimeSources ? JSON.stringify(event.careTimeSources) : null,
    event.completedAt ?? null,
    event.cancelledAt ?? null,
    event.careEvidence ? JSON.stringify(event.careEvidence) : null,
  );
}

function earlierDefinedTime(left?: number, right?: number) {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return Math.min(left, right);
}

async function applyCreateOperation(
  database: ContinuityDatabase,
  operation: CreateOperation,
) {
  if (isRetiredContinuityEvent(operation.event)) return;
  if (await operationAlreadyApplied(database, operation.operationId)) return;
  if (operation.event.schemaVersion === 1) {
    if (operation.event.source.kind === 'global_action_plan') {
      const evidence = await database.getFirstAsync<{ id: string }>(
        `SELECT id FROM continuity_event_transitions WHERE event_id = ? AND evidence_outcome = 'succeeded'
         AND evidence_kind IN (${CONTINUITY_MATTER_REAL_EVIDENCE.map(() => '?').join(',')}) LIMIT 1`,
        operation.event.id, ...CONTINUITY_MATTER_REAL_EVIDENCE,
      );
      if (!evidence) return;
    }
    const { primaryIntent: _intent, requiredBehaviors: _behaviors, ...event } = operation.event;
    const upgraded = canonicalizeContinuityMatterRecord({ schema_version: 1, kind: event.kind, status: event.status, completion_rule_json: JSON.stringify(event.completionRule) });
    operation = { ...operation, event: { ...event, schemaVersion: 2, completionRule: JSON.parse(upgraded.completion_rule_json) as BaiyunContinuityCompletionRule } };
  }
  const exact = await getEventByIdempotencyKey(database, operation.event.idempotencyKey);
  if (exact) {
    if (exact.primary_intent === 'stay') return;
    await insertTransition(database, {
      id: createId('continuity-transition', operation.event.updatedAt),
      operationId: operation.operationId,
      eventId: exact.id,
      kind: 'merged',
      fromStatus: exact.status as BaiyunContinuityEventStatus,
      toStatus: exact.status as BaiyunContinuityEventStatus,
      fromStage: exact.stage as BaiyunContinuityEventStage,
      toStage: exact.stage as BaiyunContinuityEventStage,
      reasonCode: 'exact_idempotency_match',
      occurredAt: operation.event.updatedAt,
    });
    return;
  }

  const coalesced = operation.event.coalescingKey
    ? await database.getFirstAsync<ContinuityEventRow>(
      `SELECT * FROM continuity_events
       WHERE kind = ? AND coalescing_key = ? AND status IN ('open', 'waiting')
         AND primary_intent IS NOT 'stay'
       ORDER BY occurred_at ASC LIMIT 1`,
      operation.event.kind,
      operation.event.coalescingKey,
    )
    : null;
  if (coalesced) {
    const existing = eventFromRow(coalesced);
    const requiredBehaviors = [...new Set([
      ...(existing.requiredBehaviors ?? []),
      ...(operation.event.requiredBehaviors ?? []),
    ])];
    const permissionRequirements = [...new Set([
      ...existing.permissionRequirements,
      ...operation.event.permissionRequirements,
    ])];
    const nextActionAt = earlierDefinedTime(existing.nextActionAt, operation.event.nextActionAt);
    const updated = await database.runAsync(
      `UPDATE continuity_events SET
        focus_excerpt = COALESCE(?, focus_excerpt), next_action_at = ?, required_behaviors_json = ?,
        permission_requirements_json = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`,
      operation.event.focusExcerpt ?? null,
      nextActionAt ?? null,
      existing.schemaVersion === 2 ? null : JSON.stringify(requiredBehaviors),
      JSON.stringify(permissionRequirements),
      operation.event.updatedAt,
      existing.id,
      existing.revision,
    );
    if (updated.changes !== 1) throw new Error('continuity_revision_conflict');
    await insertLinks(database, operation.links.map((link) => ({ ...link, eventId: existing.id })));
    await insertTransition(database, {
      id: createId('continuity-transition', operation.event.updatedAt),
      operationId: operation.operationId,
      eventId: existing.id,
      kind: 'merged',
      fromStatus: existing.status,
      toStatus: existing.status,
      fromStage: existing.stage,
      toStage: existing.stage,
      reasonCode: 'explicit_coalescing_key_match',
      occurredAt: operation.event.updatedAt,
    });
    return;
  }

  if (operation.event.kind === 'return_commitment' && operation.event.parentEventId) {
    const parentRow = await getEventRow(database, operation.event.parentEventId);
    if (!parentRow) throw new Error('continuity_return_parent_not_found');
    const parent = eventFromRow(parentRow);
    if (isRetiredContinuityEvent(parent)) throw new Error('continuity_return_parent_retired');
    if (parent.kind !== 'relationship_rupture') {
      throw new Error('continuity_return_parent_must_be_relationship_rupture');
    }
    if (parent.status === 'completed' || parent.status === 'cancelled') {
      throw new Error('continuity_return_parent_is_terminal');
    }
    if (parent.stage === 'retained') {
      const parentUpdated = await database.runAsync(
        `UPDATE continuity_events SET
          status = 'waiting', stage = 'paused_for_return',
          next_action_at = NULL, updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ?`,
        operation.event.createdAt,
        parent.id,
        parent.revision,
      );
      if (parentUpdated.changes !== 1) throw new Error('continuity_parent_revision_conflict');
      await insertTransition(database, {
        id: createId('continuity-transition', operation.event.createdAt + 1),
        operationId: `${operation.operationId}:parent-paused`,
        eventId: parent.id,
        kind: 'transitioned',
        fromStatus: parent.status,
        toStatus: 'waiting',
        fromStage: parent.stage,
        toStage: 'paused_for_return',
        reasonCode: 'return_commitment_created',
        occurredAt: operation.event.createdAt,
      });
    } else if (parent.stage !== 'paused_for_return') {
      throw new Error('continuity_return_parent_not_ready_for_pause');
    }
  }

  await insertEvent(database, operation.event);
  await insertLinks(database, operation.links);
  await insertTransition(database, {
    id: createId('continuity-transition', operation.event.createdAt),
    operationId: operation.operationId,
    eventId: operation.event.id,
    kind: 'created',
    toStatus: operation.event.status,
    toStage: operation.event.stage,
    reasonCode: 'event_created',
    occurredAt: operation.event.createdAt,
  });
}

async function applyTransitionOperation(
  database: ContinuityDatabase,
  operation: TransitionOperation,
) {
  if (await operationAlreadyApplied(database, operation.operationId)) return;
  const row = await getEventRow(database, operation.eventId);
  if (!row) throw new Error('continuity_event_not_found');
  const event = eventFromRow(row);
  if (isRetiredContinuityEvent(event)) return;
  if (event.revision !== operation.expectedRevision) throw new Error('continuity_revision_conflict');
  if (operation.nextStage !== event.stage) {
    assertBaiyunContinuityTransition(event, operation.nextStage);
  }
  const nextStatus = operation.nextStatus ?? event.status;
  const updated = await database.runAsync(
    `UPDATE continuity_events SET
      status = ?, stage = ?, next_action_at = ?, resume_condition_json = ?,
      pause_reason_code = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ?`,
    nextStatus,
    operation.nextStage,
    operation.nextActionAt ?? event.nextActionAt ?? null,
    operation.resumeCondition || event.resumeCondition ? JSON.stringify(operation.resumeCondition ?? event.resumeCondition) : null,
    nextStatus === 'waiting' ? operation.reasonCode : null,
    operation.occurredAt,
    event.id,
    event.revision,
  );
  if (updated.changes !== 1) throw new Error('continuity_revision_conflict');
  await insertTransition(database, {
    id: createId('continuity-transition', operation.occurredAt),
    operationId: operation.operationId,
    eventId: event.id,
    kind: 'transitioned',
    fromStatus: event.status,
    toStatus: nextStatus,
    fromStage: event.stage,
    toStage: operation.nextStage,
    reasonCode: operation.reasonCode,
    occurredAt: operation.occurredAt,
  });
}

async function loadSuccessfulEvidence(
  database: ContinuityDatabase,
  eventId: string,
) {
  const rows = await database.getAllAsync<ContinuityTransitionRow>(
    `SELECT * FROM continuity_event_transitions
     WHERE event_id = ? AND evidence_kind IS NOT NULL
     ORDER BY occurred_at ASC`,
    eventId,
  );
  return rows.map(transitionFromRow)
    .map((transition) => transition.evidence)
    .filter((evidence): evidence is BaiyunContinuityEvidence => Boolean(evidence));
}

function linkRelationForEvidence(
  kind: BaiyunContinuityEvidenceKind,
): BaiyunContinuityEventLink['relation'] {
  if (kind === 'tool_success_receipt' || kind === 'scoped_shared_task_completion_receipt') {
    return 'tool';
  }
  if (kind === 'device_success_receipt') return 'device';
  if (kind === 'notification_dispatch_receipt') return 'notification';
  if (kind === 'shared_task_progress') return 'task';
  return 'message';
}

async function applyEvidenceOperation(
  database: ContinuityDatabase,
  operation: EvidenceOperation,
) {
  if (await operationAlreadyApplied(database, operation.operationId)) return;
  const row = await getEventRow(database, operation.eventId);
  if (!row) throw new Error('continuity_event_not_found');
  const event = eventFromRow(row);
  if (isRetiredContinuityEvent(event)) return;
  if (event.revision !== operation.expectedRevision) throw new Error('continuity_revision_conflict');
  if (event.schemaVersion === 3 && operation.evidence.kind === 'manual_completion') {
    await deleteChatCareEvent(database, event.id); return;
  }
  const nextStage = operation.nextStage ?? event.stage;
  if (nextStage !== event.stage) assertBaiyunContinuityTransition(event, nextStage);
  const nextStatus = operation.nextStatus ?? event.status;
  const nextEvent: BaiyunContinuityEvent = {
    ...event,
    status: nextStatus,
    stage: nextStage,
    nextActionAt: operation.nextActionAt,
    attemptCount: event.attemptCount + 1,
    lastAttemptAt: operation.evidence.occurredAt,
    lastAttemptOutcome: operation.evidence.outcome,
    updatedAt: operation.evidence.occurredAt,
    revision: event.revision + 1,
  };
  const evidence = [...await loadSuccessfulEvidence(database, event.id), operation.evidence];
  const completed = canCompleteBaiyunContinuityEvent(nextEvent, evidence);
  const persistedStatus: BaiyunContinuityEventStatus = completed ? 'completed' : nextStatus;
  const updated = await database.runAsync(
    `UPDATE continuity_events SET
      status = ?, stage = ?, next_action_at = ?,
      attempt_count = ?, last_attempt_at = ?, last_attempt_outcome = ?,
      updated_at = ?, completed_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ?`,
    persistedStatus,
    nextStage,
    operation.nextActionAt ?? event.nextActionAt ?? null,
    nextEvent.attemptCount,
    operation.evidence.occurredAt,
    operation.evidence.outcome,
    operation.evidence.occurredAt,
    completed ? operation.evidence.occurredAt : null,
    event.id,
    event.revision,
  );
  if (updated.changes !== 1) throw new Error('continuity_revision_conflict');
  await insertTransition(database, {
    id: createId('continuity-transition', operation.evidence.occurredAt),
    operationId: operation.operationId,
    eventId: event.id,
    kind: completed ? 'completed' : 'evidence_recorded',
    fromStatus: event.status,
    toStatus: persistedStatus,
    fromStage: event.stage,
    toStage: nextStage,
    reasonCode: operation.reasonCode,
    evidence: operation.evidence,
    occurredAt: operation.evidence.occurredAt,
  });
  await insertLinks(database, [{
    eventId: event.id,
    relation: linkRelationForEvidence(operation.evidence.kind),
    targetKind: operation.evidence.kind,
    targetId: operation.evidence.sourceId,
    createdAt: operation.evidence.occurredAt,
  }]);

  if (completed && event.kind === 'return_commitment' && event.parentEventId) {
    const parentRow = await getEventRow(database, event.parentEventId);
    if (parentRow) {
      const parent = eventFromRow(parentRow);
      if (parent.status !== 'completed' && parent.status !== 'cancelled' && parent.stage === 'paused_for_return') {
        const parentUpdated = await database.runAsync(
          `UPDATE continuity_events SET
            status = 'open', stage = 'returned', next_action_at = NULL,
            updated_at = ?, revision = revision + 1
           WHERE id = ? AND revision = ?`,
          operation.evidence.occurredAt,
          parent.id,
          parent.revision,
        );
        if (parentUpdated.changes !== 1) throw new Error('continuity_parent_revision_conflict');
        await insertTransition(database, {
          id: createId('continuity-transition', operation.evidence.occurredAt + 1),
          operationId: `${operation.operationId}:parent-returned`,
          eventId: parent.id,
          kind: 'transitioned',
          fromStatus: parent.status,
          toStatus: 'open',
          fromStage: parent.stage,
          toStage: 'returned',
          reasonCode: 'child_return_delivery_completed',
          occurredAt: operation.evidence.occurredAt,
        });
      }
    }
  }
}

async function applyCancelOperation(
  database: ContinuityDatabase,
  operation: CancelOperation,
  options: { allowRetiredStay?: boolean } = {},
) {
  if (await operationAlreadyApplied(database, operation.operationId)) return;
  const row = await getEventRow(database, operation.eventId);
  if (!row) throw new Error('continuity_event_not_found');
  const event = eventFromRow(row);
  if (isRetiredContinuityEvent(event) && options.allowRetiredStay !== true) return;
  if (event.revision !== operation.expectedRevision) throw new Error('continuity_revision_conflict');
  if (event.status === 'completed' || event.status === 'cancelled') return;
  if (event.schemaVersion === 3) { await deleteChatCareEvent(database, event.id); return; }
  const updated = await database.runAsync(
    `UPDATE continuity_events SET
      status = 'cancelled', cancelled_reason = ?, cancelled_at = ?,
      next_action_at = NULL, updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ?`,
    operation.reasonCode,
    operation.occurredAt,
    operation.occurredAt,
    event.id,
    event.revision,
  );
  if (updated.changes !== 1) throw new Error('continuity_revision_conflict');
  await insertTransition(database, {
    id: createId('continuity-transition', operation.occurredAt),
    operationId: operation.operationId,
    eventId: event.id,
    kind: 'cancelled',
    fromStatus: event.status,
    toStatus: 'cancelled',
    fromStage: event.stage,
    toStage: event.stage,
    reasonCode: operation.reasonCode,
    occurredAt: operation.occurredAt,
  });
}

function candidateEventSourceKind(kind: BaiyunContinuityEventKind) {
  if (kind === 'care_process') return 'real_care' as const;
  if (kind === 'shared_task' || kind === 'cross_day_life') return 'real_life' as const;
  return 'global_relationship' as const;
}

function localDateKeyAt(timestamp: number) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

async function applyCandidateUpsertOperation(
  database: ContinuityDatabase,
  operation: CandidateUpsertOperation,
) {
  const candidate = operation.candidate;
  if (await candidateTargetsRetiredEvent(database, candidate)) return;
  const existing = await getCandidateByKey(database, candidate.candidateKey);
  if (existing) {
    if (existing.state === 'pending' && candidate.confidence > existing.confidence) {
      await database.runAsync(
        `UPDATE continuity_event_candidates SET
          confidence = ?, reason_codes_json = ?, detection_basis = ?,
          updated_at = ?, revision = revision + 1
         WHERE id = ? AND revision = ? AND state = 'pending'`,
        candidate.confidence,
        JSON.stringify(candidate.reasonCodes),
        candidate.detectionBasis,
        candidate.updatedAt,
        existing.id,
        existing.revision,
      );
    }
    return;
  }
  await database.runAsync(
    `INSERT INTO continuity_event_candidates (
      id, candidate_key, candidate_kind, state,
      event_kind, primary_intent, target_event_id, proposed_resolution,
      session_id, message_id, detection_basis, confidence,
      reason_codes_json, coalescing_key, result_event_id,
      occurred_at, expires_at, resolved_at, created_at, updated_at,
      revision, schema_version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    candidate.id, candidate.candidateKey, candidate.kind, candidate.state,
    candidate.eventKind ?? null, candidate.primaryIntent ?? null,
    candidate.targetEventId ?? null, candidate.proposedResolution ?? null,
    candidate.sessionId, candidate.messageId, candidate.detectionBasis, candidate.confidence,
    JSON.stringify(candidate.reasonCodes), candidate.coalescingKey ?? null,
    candidate.resultEventId ?? null, candidate.occurredAt, candidate.expiresAt,
    candidate.resolvedAt ?? null, candidate.createdAt, candidate.updatedAt,
    candidate.revision, candidate.schemaVersion,
  );
}

async function applyCandidateAcceptOperation(
  database: ContinuityDatabase,
  operation: CandidateAcceptOperation,
) {
  const row = await getCandidateRow(database, operation.candidateId);
  if (!row) throw new Error('continuity_candidate_not_found');
  const candidate = candidateFromRow(row);
  if (await candidateTargetsRetiredEvent(database, candidate)) return;
  if (candidate.state === 'accepted') return;
  if (candidate.state !== 'pending') throw new Error('continuity_candidate_not_pending');
  if (candidate.revision !== operation.expectedRevision) throw new Error('continuity_candidate_revision_conflict');
  if (candidate.expiresAt <= operation.occurredAt) {
    const expired = await database.runAsync(
      `UPDATE continuity_event_candidates SET
        state = 'expired', resolved_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ? AND state = 'pending'`,
      operation.occurredAt, operation.occurredAt, candidate.id, candidate.revision,
    );
    if (expired.changes !== 1) throw new Error('continuity_candidate_revision_conflict');
    return;
  }
  let resultEventId: string;
  if (candidate.kind === 'create_event') {
    if (!candidate.eventKind || !candidate.primaryIntent) throw new Error('continuity_create_candidate_invalid');
    const eventId = `${candidate.id}:event`;
    const event = buildBaiyunContinuityEvent({
      id: eventId,
      kind: candidate.eventKind,
      subject: 'you',
      primaryIntent: candidate.primaryIntent,
      idempotencyKey: `continuity-candidate:${candidate.candidateKey}`,
      coalescingKey: candidate.coalescingKey,
      source: { kind: candidateEventSourceKind(candidate.eventKind), sourceId: candidate.messageId },
      occurredAt: candidate.occurredAt,
      occurredLocalDate: localDateKeyAt(candidate.occurredAt),
      timezoneOffsetMinutes: new Date(candidate.occurredAt).getTimezoneOffset(),
      requiredBehaviors: getBaiyunActionContract(candidate.primaryIntent).requiredBehaviors,
    });
    const eventOperationId = `${operation.operationId}:event`;
    await applyCreateOperation(database, {
      version: 1,
      type: 'create',
      operationId: eventOperationId,
      event,
      links: [{
        eventId, relation: 'source', targetKind: event.source.kind,
        targetId: event.source.sourceId, createdAt: event.createdAt,
      }, {
        eventId, relation: 'message', targetKind: 'chat_message',
        targetId: candidate.messageId, createdAt: event.createdAt,
      }],
    });
    const persisted = await getEventRowForOperation(database, eventOperationId);
    if (!persisted) throw new Error('continuity_candidate_event_not_persisted');
    resultEventId = persisted.id;
  } else {
    if (!candidate.targetEventId || !candidate.proposedResolution) throw new Error('continuity_resolution_candidate_invalid');
    const targetRow = await getEventRow(database, candidate.targetEventId);
    if (!targetRow) throw new Error('continuity_candidate_target_not_found');
    const target = eventFromRow(targetRow);
    if (target.status === 'completed' || target.status === 'cancelled') throw new Error('continuity_candidate_target_terminal');
    const evidenceKind: BaiyunContinuityEvidenceKind = candidate.proposedResolution === 'progressed'
      ? 'you_explicit_progress'
      : candidate.proposedResolution === 'completed'
        ? 'you_explicit_completion'
        : 'you_explicit_cancellation';
    await applyEvidenceOperation(database, {
      version: 1,
      type: 'evidence',
      operationId: `${operation.operationId}:evidence`,
      eventId: target.id,
      expectedRevision: target.revision,
      evidence: {
        id: `${candidate.id}:evidence`,
        kind: evidenceKind,
        sourceId: candidate.messageId,
        occurredAt: operation.occurredAt,
        outcome: 'succeeded',
      },
      reasonCode: `you_explicit_${candidate.proposedResolution}`,
      ...(candidate.proposedResolution === 'progressed'
        && target.kind === 'shared_task'
        && target.stage === 'awaiting_shared_confirmation'
        ? {
            nextStage: 'waiting_shared_action' as const,
            nextStatus: 'open' as const,
          }
        : {}),
    });
    if (candidate.proposedResolution === 'cancelled') {
      const refreshedRow = await getEventRow(database, target.id);
      if (!refreshedRow) throw new Error('continuity_candidate_target_not_found');
      const refreshed = eventFromRow(refreshedRow);
      await applyCancelOperation(database, {
        version: 1, type: 'cancel', operationId: `${operation.operationId}:cancel`,
        eventId: refreshed.id, expectedRevision: refreshed.revision,
        reasonCode: 'you_explicit_cancellation', occurredAt: operation.occurredAt,
      });
    }
    resultEventId = target.id;
  }
  const updated = await database.runAsync(
    `UPDATE continuity_event_candidates SET
      state = 'accepted', result_event_id = ?, resolved_at = ?,
      updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ? AND state = 'pending'`,
    resultEventId, operation.occurredAt, operation.occurredAt, candidate.id, candidate.revision,
  );
  if (updated.changes !== 1) throw new Error('continuity_candidate_revision_conflict');
}

async function applyCandidateUndoRegistrationOperation(
  database: ContinuityDatabase,
  operation: CandidateUndoRegistrationOperation,
) {
  const row = await getCandidateRow(database, operation.candidateId);
  if (!row) throw new Error('continuity_candidate_not_found');
  const candidate = candidateFromRow(row);
  if (await candidateTargetsRetiredEvent(database, candidate)) return;
  if (candidate.state === 'dismissed') return;
  if (candidate.state !== 'accepted' || candidate.kind !== 'create_event') {
    throw new Error('continuity_candidate_registration_not_undoable');
  }
  if (candidate.revision !== operation.expectedRevision) {
    throw new Error('continuity_candidate_revision_conflict');
  }
  if (!candidate.resultEventId) {
    throw new Error('continuity_candidate_result_event_missing');
  }
  const eventRow = await getEventRow(database, candidate.resultEventId);
  if (candidate.resultEventId === `${candidate.id}:event`) {
    if (eventRow) {
      const event = eventFromRow(eventRow);
      if (event.status !== 'cancelled') {
        if (
          (event.status !== 'open' && event.status !== 'waiting')
          || event.revision !== 1
        ) {
          throw new Error('continuity_candidate_event_advanced');
        }
        await applyCancelOperation(database, {
          version: 1,
          type: 'cancel',
          operationId: `${operation.operationId}:cancel`,
          eventId: event.id,
          expectedRevision: event.revision,
          reasonCode: 'candidate_registration_undone',
          occurredAt: operation.occurredAt,
        });
      }
    }
  } else if (eventRow) {
    await database.runAsync(
      `DELETE FROM continuity_event_links
       WHERE event_id = ? AND target_id = ?
         AND (
           (relation = 'message' AND target_kind = 'chat_message')
           OR relation = 'source'
         )`,
      candidate.resultEventId,
      candidate.messageId,
    );
  }
  const updated = await database.runAsync(
    `UPDATE continuity_event_candidates SET
      state = 'dismissed', resolved_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ? AND state = 'accepted'`,
    operation.occurredAt,
    operation.occurredAt,
    candidate.id,
    candidate.revision,
  );
  if (updated.changes !== 1) {
    throw new Error('continuity_candidate_revision_conflict');
  }
}

async function applyCandidateSetStateOperation(
  database: ContinuityDatabase,
  operation: CandidateSetStateOperation,
) {
  const row = await getCandidateRow(database, operation.candidateId);
  if (!row) throw new Error('continuity_candidate_not_found');
  const candidate = candidateFromRow(row);
  if (await candidateTargetsRetiredEvent(database, candidate)) return;
  if (candidate.state === operation.nextState) return;
  if (candidate.state !== 'pending') throw new Error('continuity_candidate_not_pending');
  if (candidate.revision !== operation.expectedRevision) throw new Error('continuity_candidate_revision_conflict');
  const updated = await database.runAsync(
    `UPDATE continuity_event_candidates SET
      state = ?, resolved_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND revision = ? AND state = 'pending'`,
    operation.nextState, operation.occurredAt, operation.occurredAt, candidate.id, candidate.revision,
  );
  if (updated.changes !== 1) throw new Error('continuity_candidate_revision_conflict');
}

async function applyCandidateExpireOperation(
  database: ContinuityDatabase,
  operation: CandidateExpireOperation,
) {
  await database.runAsync(
    `UPDATE continuity_event_candidates SET
      state = 'expired', resolved_at = ?, updated_at = ?, revision = revision + 1
     WHERE state = 'pending' AND expires_at <= ?
       AND COALESCE(primary_intent, '') <> 'stay'
       AND NOT EXISTS (
         SELECT 1 FROM continuity_events retired_target
         WHERE retired_target.id = continuity_event_candidates.target_event_id
           AND retired_target.primary_intent = 'stay'
       )
       AND NOT EXISTS (
         SELECT 1 FROM continuity_events retired_result
         WHERE retired_result.id = continuity_event_candidates.result_event_id
           AND retired_result.primary_intent = 'stay'
       )`,
    operation.now, operation.now, operation.now,
  );
  await database.runAsync(
    `DELETE FROM continuity_event_candidates
     WHERE state IN ('accepted', 'dismissed', 'expired')
       AND resolved_at IS NOT NULL AND resolved_at <= ?
       AND COALESCE(primary_intent, '') <> 'stay'
       AND NOT EXISTS (
         SELECT 1 FROM continuity_events retired_target
         WHERE retired_target.id = continuity_event_candidates.target_event_id
           AND retired_target.primary_intent = 'stay'
       )
       AND NOT EXISTS (
         SELECT 1 FROM continuity_events retired_result
         WHERE retired_result.id = continuity_event_candidates.result_event_id
           AND retired_result.primary_intent = 'stay'
       )`,
    operation.now - 30 * 24 * 60 * 60 * 1000,
  );
}

function dueStageForEvent(event: BaiyunContinuityEvent): BaiyunContinuityEventStage {
  if (event.kind === 'return_commitment' && event.stage === 'waiting_condition') return 'due';
  if (event.kind === 'care_process' && event.stage === 'awaiting_response') return 'follow_up_due';
  if (event.kind === 'cross_day_life' && event.stage === 'recorded') return 'follow_up_due';
  return event.stage;
}

async function applyDueOperation(
  database: ContinuityDatabase,
  operation: DueOperation,
) {
  const rows = await database.getAllAsync<ContinuityEventRow>(
    `SELECT * FROM continuity_events
     WHERE status IN ('open', 'waiting')
       AND primary_intent IS NOT 'stay'
       AND next_action_at IS NOT NULL
       AND next_action_at <= ?
     ORDER BY next_action_at ASC`,
    operation.now,
  );
  for (const row of rows) {
    const event = eventFromRow(row);
    if (isRetiredContinuityEvent(event)) continue;
    const childOperationId = `${operation.operationId}:${event.id}`;
    if (await operationAlreadyApplied(database, childOperationId)) continue;
    const nextStage = dueStageForEvent(event);
    if (nextStage !== event.stage) assertBaiyunContinuityTransition(event, nextStage);
    const updated = await database.runAsync(
      `UPDATE continuity_events SET
        status = 'open', stage = ?, next_action_at = NULL,
        updated_at = ?, revision = revision + 1
       WHERE id = ? AND revision = ?`,
      nextStage,
      operation.now,
      event.id,
      event.revision,
    );
    if (updated.changes !== 1) throw new Error('continuity_revision_conflict');
    await insertTransition(database, {
      id: createId('continuity-transition', operation.now),
      operationId: childOperationId,
      eventId: event.id,
      kind: 'transitioned',
      fromStatus: event.status,
      toStatus: 'open',
      fromStage: event.stage,
      toStage: nextStage,
      reasonCode: 'next_action_due',
      occurredAt: operation.now,
    });
  }
}

async function applyClearAcceptanceOperation(
  database: ContinuityDatabase,
  operation: ClearAcceptanceOperation,
) {
  const rows = await database.getAllAsync<{ id: string }>(
    'SELECT id FROM continuity_events WHERE idempotency_key LIKE ?',
    `${BAIYUN_CONTINUITY_TEST_PREFIX}%`,
  );
  for (const row of rows) {
    await database.runAsync('DELETE FROM continuity_event_transitions WHERE event_id = ?', row.id);
    await database.runAsync('DELETE FROM continuity_event_links WHERE event_id = ?', row.id);
    await database.runAsync('DELETE FROM continuity_events WHERE id = ?', row.id);
  }
  await database.runAsync(
    'DELETE FROM continuity_event_candidates WHERE candidate_key LIKE ?',
    `${BAIYUN_CONTINUITY_TEST_PREFIX}%`,
  );
}

async function applyOperation(database: ContinuityDatabase, operation: PendingOperation, canCommit?: () => boolean) {
  if (operation.type.startsWith('candidate_')) return;
  await database.withExclusiveTransactionAsync(async (transaction) => {
    if (canCommit?.() === false) throw new Error('care_matter_invalid_expired_reply');
    if (operation.type === 'care_matter') await applyCareMatterOperation(transaction, operation);
    else if (operation.type === 'create') await applyCreateOperation(transaction, operation);
    else if (operation.type === 'transition') await applyTransitionOperation(transaction, operation);
    else if (operation.type === 'evidence') await applyEvidenceOperation(transaction, operation);
    else if (operation.type === 'cancel') await applyCancelOperation(transaction, operation);
    else if (operation.type === 'advance_due') await applyDueOperation(transaction, operation);
    else if (operation.type === 'clear_acceptance') await applyClearAcceptanceOperation(transaction, operation);
    else if (operation.type === 'candidate_upsert') await applyCandidateUpsertOperation(transaction, operation);
    else if (operation.type === 'candidate_accept') await applyCandidateAcceptOperation(transaction, operation);
    else if (operation.type === 'candidate_set_state') await applyCandidateSetStateOperation(transaction, operation);
    else if (operation.type === 'candidate_expire') await applyCandidateExpireOperation(transaction, operation);
    else await applyCandidateUndoRegistrationOperation(transaction, operation);
  });
}

function isPendingOperation(value: unknown): value is PendingOperation {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { version?: unknown; type?: unknown; operationId?: unknown };
  return candidate.version === 1
    && typeof candidate.operationId === 'string'
    && (
      candidate.type === 'create'
      || candidate.type === 'care_matter'
      || candidate.type === 'transition'
      || candidate.type === 'evidence'
      || candidate.type === 'cancel'
      || candidate.type === 'advance_due'
      || candidate.type === 'clear_acceptance'
      || candidate.type === 'candidate_upsert'
      || candidate.type === 'candidate_accept'
      || candidate.type === 'candidate_set_state'
      || candidate.type === 'candidate_expire'
      || candidate.type === 'candidate_undo_registration'
    );
}

function pendingOperationJournalTime(operation: PendingOperation) {
  if (operation.type === 'create') return operation.event.createdAt;
  if (operation.type === 'evidence') return operation.evidence.occurredAt;
  if (operation.type === 'advance_due' || operation.type === 'candidate_expire') return operation.now;
  if (operation.type === 'candidate_upsert') return operation.candidate.createdAt;
  return operation.occurredAt;
}

function shouldDiscardPendingOperationAfterError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (/^care_matter_(name_conflict|terminal_event|contact_reschedule_limit)$/.test(message)) return true;
  return /backup.*restore|restore.*backup|data.?epoch|write_blocked_by_backup_restore|invalid|malformed|revision|not.?found/i.test(message);
}

async function commitOperation(operation: PendingOperation, dataEpoch: number | null, canCommit?: () => boolean) {
  if (operation.type.startsWith('candidate_')) throw new Error('continuity_candidate_retired');
  if (dataEpoch === null) throw new Error('continuity_write_blocked_by_backup_restore');
  await getContinuityDatabase();
  // Already inside the mutation lane: resume directly, never enqueue behind ourselves.
  // The sole journal belongs to the earlier operation until it has been reconciled.
  const resumedId = await resumePendingContinuityLedgerOperation(canCommit);
  if (resumedId === operation.operationId) return;
  let journal = buildContinuityPendingOperationJournal({
    logicalMutation: operation,
    createdAt: pendingOperationJournalTime(operation),
  });
  await AsyncStorage.setItem(
    CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
    serializeContinuityPendingOperationJournal(journal),
  );
  journal = beginContinuityPendingOperationAttempt(
    journal,
    Math.max(journal.updatedAt, Date.now()),
  );
  await AsyncStorage.setItem(
    CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
    serializeContinuityPendingOperationJournal(journal),
  );
  try {
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getContinuityDatabase();
      await applyOperation(database, operation, canCommit);
    });
    if (!committed.committed) {
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
      throw new Error('continuity_write_blocked_by_backup_restore');
    }
    journal = markContinuityPendingOperationCommitted(
      journal,
      Math.max(journal.updatedAt, Date.now()),
    );
    try {
      await AsyncStorage.setItem(
        CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
        serializeContinuityPendingOperationJournal(journal),
      );
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
    } catch (error) {
      // The care transaction has positively committed. Leave its original journal
      // for reconciliation; a housekeeping failure cannot turn that into lost care.
      if (operation.type !== 'care_matter') throw error;
    }
  } catch (error) {
    if (shouldDiscardPendingOperationAfterError(error)) {
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
    }
    throw error;
  }
}

export async function recoverPendingContinuityLedgerOperation() {
  if (recoveryFlight) return recoveryFlight;
  recoveryFlight = enqueueMutation(async () => {
    await resumePendingContinuityLedgerOperation();
  }).finally(() => {
    recoveryFlight = null;
  });
  return recoveryFlight;
}

async function resumePendingContinuityLedgerOperation(canCommit?: () => boolean): Promise<string | undefined> {
    await getContinuityDatabase();
    const serialized = await AsyncStorage.getItem(
      CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
    );
    if (!serialized) return;
    let journal: ContinuityPendingOperationJournalV1;
    try {
      journal = parseContinuityPendingOperationJournal(serialized);
    } catch {
      let legacyOperation: unknown;
      try {
        legacyOperation = JSON.parse(serialized);
      } catch {
        await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
        return;
      }
      if (!isPendingOperation(legacyOperation)) {
        await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
        return;
      }
      if (
        legacyOperation.type === 'create'
        && isRetiredContinuityEvent(legacyOperation.event)
      ) {
        await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
        return;
      }
      try {
        journal = buildContinuityPendingOperationJournal({
          logicalMutation: legacyOperation,
          createdAt: pendingOperationJournalTime(legacyOperation),
        });
      } catch {
        await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
        return;
      }
    }
    const operation = journal.logicalMutation;
    if (!isPendingOperation(operation)) {
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
      return;
    }
    if (journal.state === 'committed') {
      try {
        await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
      } catch (error) {
        if (operation.type !== 'care_matter') throw error;
      }
      return operation.operationId;
    }
    journal = beginContinuityPendingOperationAttempt(
      journal,
      Math.max(journal.updatedAt, Date.now()),
    );
    await AsyncStorage.setItem(
      CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
      serializeContinuityPendingOperationJournal(journal),
    );
    const dataEpoch = captureBackupRestoreDataEpoch();
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getContinuityDatabase();
      await applyOperation(database, operation, canCommit ? () => {
        // A cancelled caller must not invalidate an earlier operation's journal.
        if (!canCommit()) throw new Error('continuity_pending_caller_cancelled');
        return true;
      } : undefined);
    }).catch(async (error: unknown) => {
      if (!shouldDiscardPendingOperationAfterError(error)) throw error;
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
      return { committed: false };
    });
    if (!committed.committed) {
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
      return;
    }
    journal = markContinuityPendingOperationCommitted(
      journal,
      Math.max(journal.updatedAt, Date.now()),
    );
    try {
      await AsyncStorage.setItem(
        CONTINUITY_PENDING_OPERATION_STORAGE_KEY,
        serializeContinuityPendingOperationJournal(journal),
      );
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
    } catch (error) {
      if (operation.type !== 'care_matter') throw error;
    }
    return operation.operationId;
}

export type BaiyunCareMatterUpdate = import('./chatCareUpdates').ChatCareUpdate;

type CareMatterOperation = {
  version: 1;
  type: 'care_matter';
  formatVersion: 3;
  operationId: string;
  sessionId: string;
  update: BaiyunCareMatterUpdate;
  occurredAt: number;
  allowNew: boolean;
};

async function deleteChatCareEvent(database: ContinuityDatabase, eventId: string) {
  await database.runAsync('DELETE FROM continuity_event_candidates WHERE target_event_id = ? OR result_event_id = ?', eventId, eventId);
  await database.runAsync('DELETE FROM continuity_event_links WHERE event_id = ? OR (target_kind = ? AND target_id = ?)', eventId, 'continuity_event', eventId);
  await database.runAsync('DELETE FROM continuity_event_transitions WHERE event_id = ?', eventId);
  await database.runAsync('DELETE FROM continuity_events WHERE id = ?', eventId);
}

async function applyCareMatterOperation(database: ContinuityDatabase, operation: CareMatterOperation) {
  if (operation.formatVersion !== 3) throw new Error('care_matter_invalid_legacy_format');
  if (await operationAlreadyApplied(database, operation.operationId)) return;
  const update = operation.update;
  const row = update.eventId ? await getEventRow(database, update.eventId) : null;
  if (update.eventId && !row) throw new Error('care_matter_target_not_found');
  const current = row ? eventFromRow(row) : undefined;
  const deviceCare = current && isHeartCareMatter(current);
  if (current && ((!deviceCare && (current.schemaVersion !== 3 || !current.careEvidence))
    || !['open', 'waiting'].includes(current.status)
    || current.revision !== update.expectedRevision)) throw new Error('care_matter_revision_conflict');
  if (!update.quote?.trim() || !['继续', '结束'].includes(update.state)) throw new Error('care_matter_invalid_evidence');
  if (update.state === '结束' && !deviceCare) {
    if (!current) throw new Error('care_matter_target_not_found');
    await deleteChatCareEvent(database, current.id);
    return;
  }
  const evidence = { sessionId: operation.sessionId, messageId: update.sourceMessageId,
    sentAt: update.occurredAt, quote: update.quote };
  const id = current?.id ?? `care:${operation.operationId}`;
  if (!current) {
    if (!operation.allowNew) throw new Error('care_matter_invalid_snapshot_capacity');
    const duplicate = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM continuity_events WHERE (schema_version = 3 OR ${HEART_CARE_RECORD_PREDICATE}) AND kind = 'care_process'
       AND EXISTS (SELECT 1 FROM json_each(care_evidence_json) e
         WHERE json_extract(e.value, '$.sessionId') = ? AND json_extract(e.value, '$.messageId') = ?
           AND json_extract(e.value, '$.quote') = ?) LIMIT 1`,
      operation.sessionId, update.sourceMessageId, update.quote,
    );
    if (duplicate) throw new Error('care_matter_invalid_duplicate_quote');
    const deleted = await database.getFirstAsync<{ entity_id: string }>(
      `SELECT h.entity_id FROM memory_sync_entity_heads h
       LEFT JOIN memory_sync_domain_outbox o ON o.revision_id = h.revision_id
       LEFT JOIN memory_sync_revision_log r ON r.revision_id = h.revision_id
       WHERE h.entity_type = 'continuity-event' AND h.entity_id = ?
       AND COALESCE(o.operation, r.operation) = 'delete' LIMIT 1`, id,
    );
    if (deleted) throw new Error('care_matter_target_not_found');
    const count = await database.getFirstAsync<{ n: number }>(
      `SELECT COUNT(*) AS n FROM continuity_events WHERE kind = 'care_process' AND (schema_version = 3 OR ${HEART_CARE_RECORD_PREDICATE}) AND status IN ('open', 'waiting')`,
    );
    if ((count?.n ?? 0) >= 6) throw new Error('care_matter_invalid_capacity');
  }
  const at = operation.occurredAt;
  const event: BaiyunContinuityEvent = {
    ...(current ?? { id, kind: 'care_process', stage: 'signal_seen', subject: 'you',
      idempotencyKey: operation.operationId, source: { kind: 'real_care', sourceId: update.sourceMessageId },
      occurredAt: update.occurredAt, occurredLocalDate: localDateKey(update.occurredAt),
      timezoneOffsetMinutes: new Date(update.occurredAt).getTimezoneOffset(),
      completionRule: { allOf: [], anyOf: ['manual_completion'] },
      permissionRequirements: [], attemptCount: 0, createdAt: at }),
    status: current?.status ?? 'open', updatedAt: at, revision: (current?.revision ?? 0) + 1, schemaVersion: current?.schemaVersion ?? 3,
    careEvidence: current?.careEvidence ? { origin: current.careEvidence.origin, latest: evidence } : { origin: evidence },
  };
  if (current) {
    await database.runAsync(
      'UPDATE continuity_events SET care_evidence_json = ?, updated_at = ?, revision = ? WHERE id = ? AND revision = ?',
      JSON.stringify(event.careEvidence), at, event.revision, id, current.revision,
    );
    await database.runAsync(
      `DELETE FROM continuity_event_links
       WHERE event_id = ?
         AND relation IN ('message', 'source')
         AND target_kind IN ('chat_message', 'chat_session')
         AND NOT EXISTS (
           SELECT 1 FROM continuity_events event, json_each(event.care_evidence_json) reference
           WHERE event.id = continuity_event_links.event_id
             AND ((continuity_event_links.relation = 'message'
                   AND continuity_event_links.target_kind = 'chat_message'
                   AND continuity_event_links.target_id = json_extract(reference.value, '$.messageId'))
               OR (continuity_event_links.relation = 'source'
                   AND continuity_event_links.target_kind = 'chat_session'
                   AND continuity_event_links.target_id = json_extract(reference.value, '$.sessionId')))
         )`,
      id,
    );
  } else await insertEvent(database, event);
  for (const reference of [event.careEvidence!.origin, event.careEvidence!.latest].filter(Boolean)) {
    await insertLinks(database, [
      { eventId: id, relation: 'message', targetKind: 'chat_message', targetId: reference!.messageId, createdAt: reference!.sentAt },
      { eventId: id, relation: 'source', targetKind: 'chat_session', targetId: reference!.sessionId, createdAt: reference!.sentAt },
    ]);
  }
  if (deviceCare && update.state === '结束') {
    // Keep the system episode's terminal identity, as manual completion does,
    // so a repeated device registration cannot resurrect the same episode.
    await applyEvidenceOperation(database, { version: 1, type: 'evidence', operationId: operation.operationId,
      eventId: id, expectedRevision: event.revision, reasonCode: 'care_matter_update',
      evidence: { id: operation.operationId, kind: 'you_confirmed_care_complete',
        sourceId: update.sourceMessageId, occurredAt: at, outcome: 'succeeded' } });
    return;
  }
  await insertTransition(database, {
    id: `transition:${operation.operationId}`, operationId: operation.operationId, eventId: id,
    kind: current ? 'transitioned' : 'created', fromStatus: current?.status, toStatus: event.status,
    fromStage: current?.stage, toStage: event.stage, reasonCode: 'care_matter_update', occurredAt: at,
  });
}

export async function applyBaiyunCareMatterUpdates(input: {
  updates: readonly BaiyunCareMatterUpdate[];
  sessionId: string;
  now: number;
  allowNew: boolean;
  canCommit?: () => boolean;
  onRejected?: (reason: string) => void;
}): Promise<BaiyunContinuityEvent[]> {
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const result: BaiyunContinuityEvent[] = [];
    const reject = (reason: string) => { void recordChatCareRejection(reason); input.onRejected?.(reason); };
    for (const update of input.updates.slice(0, 3)) {
      if (input.canCommit?.() === false) break;
      if (typeof update.quote !== 'string' || !update.quote.trim()
        || !['继续', '结束'].includes(update.state)
        || Object.keys(update).some(key => !['eventId', 'expectedRevision', 'quote', 'state', 'sourceMessageId', 'occurredAt'].includes(key))) {
        reject('care_matter_invalid_evidence'); continue;
      }
      if (!input.sessionId || !update.sourceMessageId || !Number.isSafeInteger(update.occurredAt)
        || update.occurredAt < 0 || !Number.isSafeInteger(input.now) || input.now < update.occurredAt) {
        reject('care_matter_source_invalid'); continue;
      }
      const operationId = `care-update-v3:${bytesToHex(sha256(utf8ToBytes(JSON.stringify([input.sessionId, update.sourceMessageId, update.eventId ?? null, update.quote]))))}`;
      try {
        await commitOperation({ version: 1, type: 'care_matter', formatVersion: 3, operationId,
          sessionId: input.sessionId, update, occurredAt: input.now, allowNew: input.allowNew }, epoch, input.canCommit);
        const row = await getEventRowForOperation(await getContinuityDatabase(), operationId);
        if (row) result.push(eventFromRow(row));
      } catch (error) {
        if (!shouldDiscardPendingOperationAfterError(error)) throw error;
        reject(error instanceof Error ? error.message : 'care_matter_write_rejected');
      }
    }
    return result;
  });
}

export type CreateBaiyunContinuityEventInput = {
  eventId?: string;
  operationId?: string;
  kind: BaiyunContinuityEventKind;
  subject: BaiyunContinuitySubject;
  primaryIntent?: BaiyunActionIntentId;
  itemName?: string;
  idempotencyKey: string;
  source: BaiyunContinuityEventSource;
  occurredAt: number;
  occurredLocalDate: string;
  timezoneOffsetMinutes: number;
  parentEventId?: string;
  returningSubject?: BaiyunContinuitySubject;
  coalescingKey?: string;
  focusExcerpt?: string;
  nextActionAt?: number;
  resumeCondition?: BaiyunContinuityResumeCondition;
  requiredBehaviors?: readonly BaiyunRequiredBehaviorId[];
  permissionRequirements?: readonly string[];
  links?: readonly Omit<BaiyunContinuityEventLink, 'eventId' | 'createdAt'>[];
};

export async function createBaiyunContinuityEvent(input: CreateBaiyunContinuityEventInput) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const eventId = input.eventId ?? createId('continuity-event', input.occurredAt);
    const event = buildBaiyunContinuityEvent({
      ...input,
      id: eventId,
    });
    const sourceLink: BaiyunContinuityEventLink = {
      eventId,
      relation: 'source',
      targetKind: event.source.kind,
      targetId: event.source.sourceId,
      createdAt: event.createdAt,
    };
    const parentLink: BaiyunContinuityEventLink[] = event.parentEventId
      ? [{
        eventId,
        relation: 'parent',
        targetKind: 'continuity_event',
        targetId: event.parentEventId,
        createdAt: event.createdAt,
      }]
      : [];
    const extraLinks = (input.links ?? []).map((link) => ({
      ...link,
      eventId,
      createdAt: event.createdAt,
    }));
    const operationId = input.operationId ?? createId('continuity-operation', event.createdAt);
    await commitOperation({
      version: 1,
      type: 'create',
      operationId,
      event,
      links: [sourceLink, ...parentLink, ...extraLinks],
    }, dataEpoch);
    const database = await getContinuityDatabase();
    const persisted = await getEventRowForOperation(database, operationId);
    if (!persisted) throw new Error('continuity_event_create_not_persisted');
    return eventFromRow(persisted);
  });
}

export async function transitionBaiyunContinuityEvent(input: {
  eventId: string;
  expectedRevision: number;
  nextStage: BaiyunContinuityEventStage;
  nextStatus?: Extract<BaiyunContinuityEventStatus, 'open' | 'waiting'>;
  reasonCode: string;
  occurredAt?: number;
  operationId?: string;
  nextActionAt?: number;
  resumeCondition?: BaiyunContinuityResumeCondition;
}) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const currentRow = await getEventRow(database, input.eventId);
    if (currentRow?.primary_intent === 'stay') throw new Error('continuity_event_retired');
    const occurredAt = input.occurredAt ?? Date.now();
    await commitOperation({
      version: 1,
      type: 'transition',
      operationId: input.operationId ?? createId('continuity-operation', occurredAt),
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      nextStage: input.nextStage,
      nextStatus: input.nextStatus,
      reasonCode: input.reasonCode,
      occurredAt,
      nextActionAt: input.nextActionAt,
      resumeCondition: input.resumeCondition,
    }, dataEpoch);
    const event = await getEventRow(database, input.eventId);
    if (!event) throw new Error('continuity_event_not_found_after_transition');
    return eventFromRow(event);
  });
}

export async function recordBaiyunContinuityEvidence(input: {
  eventId: string;
  expectedRevision: number;
  evidence: BaiyunContinuityEvidence;
  operationId?: string;
  nextStage?: BaiyunContinuityEventStage;
  nextStatus?: Extract<BaiyunContinuityEventStatus, 'open' | 'waiting'>;
  reasonCode?: string;
  nextActionAt?: number;
}) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const currentRow = await getEventRow(database, input.eventId);
    if (currentRow?.primary_intent === 'stay') throw new Error('continuity_event_retired');
    await commitOperation({
      version: 1,
      type: 'evidence',
      operationId: input.operationId ?? createId('continuity-operation', input.evidence.occurredAt),
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      evidence: input.evidence,
      nextStage: input.nextStage,
      nextStatus: input.nextStatus,
      reasonCode: input.reasonCode,
      nextActionAt: input.nextActionAt,
    }, dataEpoch);
    const event = await getEventRow(database, input.eventId);
    if (!event && currentRow?.schema_version === 3) return eventFromRow(currentRow);
    if (!event) throw new Error('continuity_event_not_found_after_evidence');
    return eventFromRow(event);
  });
}

export async function cancelBaiyunContinuityEvent(input: {
  eventId: string;
  expectedRevision: number;
  reasonCode: string;
  occurredAt?: number;
  operationId?: string;
}) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const currentRow = await getEventRow(database, input.eventId);
    if (currentRow?.primary_intent === 'stay') throw new Error('continuity_event_retired');
    const occurredAt = input.occurredAt ?? Date.now();
    await commitOperation({
      version: 1,
      type: 'cancel',
      operationId: input.operationId ?? createId('continuity-operation', occurredAt),
      eventId: input.eventId,
      expectedRevision: input.expectedRevision,
      reasonCode: input.reasonCode,
      occurredAt,
    }, dataEpoch);
    const event = await getEventRow(database, input.eventId);
    if (!event && currentRow?.schema_version === 3) return eventFromRow(currentRow);
    if (!event) throw new Error('continuity_event_not_found_after_cancel');
    return eventFromRow(event);
  });
}

async function inspectRetiredStayFossils(database: ContinuityDatabase) {
  const targetRows = await database.getAllAsync<Pick<ContinuityEventRow, 'id' | 'primary_intent'>>(
    `SELECT id, primary_intent FROM continuity_events
     WHERE id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
    ...RETIRED_STAY_FOSSIL_EVENT_IDS,
  );
  if (targetRows.length !== 0 && targetRows.length !== RETIRED_STAY_FOSSIL_EVENT_IDS.length) {
    throw new Error('continuity_retired_stay_fossils_partial');
  }
  if (targetRows.some((row) => row.primary_intent !== 'stay')) {
    throw new Error('continuity_retired_stay_fossil_invalid');
  }
  const unexpectedStay = await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM continuity_events
     WHERE primary_intent = 'stay'
       AND id NOT IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})
     LIMIT 1`,
    ...RETIRED_STAY_FOSSIL_EVENT_IDS,
  );
  if (unexpectedStay) throw new Error('continuity_retired_stay_allowlist_mismatch');

  if (!targetRows.length) {
    const [candidate, transition, link] = await Promise.all([
      database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM continuity_event_candidates
         WHERE target_event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})
            OR result_event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
        ...RETIRED_STAY_FOSSIL_EVENT_IDS,
        ...RETIRED_STAY_FOSSIL_EVENT_IDS,
      ),
      database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM continuity_event_transitions
         WHERE event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
        ...RETIRED_STAY_FOSSIL_EVENT_IDS,
      ),
      database.getFirstAsync<{ count: number }>(
        `SELECT COUNT(*) AS count FROM continuity_event_links
         WHERE event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
        ...RETIRED_STAY_FOSSIL_EVENT_IDS,
      ),
    ]);
    if ((candidate?.count ?? 0) || (transition?.count ?? 0) || (link?.count ?? 0)) {
      throw new Error('continuity_retired_stay_fossils_partial');
    }
    return 'already_absent' as const;
  }
  return 'present' as const;
}

async function purgeLeakedRetiredStaySyncCapture(database: ContinuityDatabase) {
  const outboxRows = await database.getAllAsync<RetiredStaySyncOutboxRow>(
    `SELECT mutation_id, revision_id, entity_id, operation, state, attempt_count,
            source_sequence, lease_id, lease_expires_at
     FROM memory_sync_domain_outbox
     WHERE entity_type = 'continuity-link'
       AND json_valid(entity_id) = 1
       AND json_extract(entity_id, '$[0]') IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
    ...RETIRED_STAY_FOSSIL_EVENT_IDS,
  );
  const headRows = await database.getAllAsync<RetiredStaySyncHeadRow>(
    `SELECT entity_id, revision_id
     FROM memory_sync_entity_heads
     WHERE entity_type = 'continuity-link'
       AND json_valid(entity_id) = 1
       AND json_extract(entity_id, '$[0]') IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
    ...RETIRED_STAY_FOSSIL_EVENT_IDS,
  );
  if (!outboxRows.length && !headRows.length) return;
  const expectedHeads = new Set(
    outboxRows.map((row) => `${row.entity_id}\u0000${row.revision_id}`),
  );
  if (
    outboxRows.length !== RETIRED_STAY_FOSSIL_LINK_COUNT
    || headRows.length !== RETIRED_STAY_FOSSIL_LINK_COUNT
    || expectedHeads.size !== RETIRED_STAY_FOSSIL_LINK_COUNT
    || outboxRows.some((row) => (
      row.operation !== 'delete'
      || row.state !== 'pending'
      || row.attempt_count !== 0
      || row.source_sequence !== null
      || row.lease_id !== null
      || row.lease_expires_at !== null
    ))
    || headRows.some((row) => !expectedHeads.has(`${row.entity_id}\u0000${row.revision_id}`))
  ) {
    throw new Error('continuity_retired_stay_sync_leak_invalid');
  }
  for (const row of outboxRows) {
    const head = await database.runAsync(
      `DELETE FROM memory_sync_entity_heads
       WHERE entity_type = 'continuity-link'
         AND entity_id = ?
         AND revision_id = ?`,
      row.entity_id,
      row.revision_id,
    );
    const outbox = await database.runAsync(
      `DELETE FROM memory_sync_domain_outbox
       WHERE mutation_id = ?
         AND revision_id = ?`,
      row.mutation_id,
      row.revision_id,
    );
    if (head.changes !== 1 || outbox.changes !== 1) {
      throw new Error('continuity_retired_stay_sync_leak_delete_incomplete');
    }
  }
}

export async function purgeBaiyunRetiredStayFossils() {
  await recoverPendingContinuityLedgerOperation();
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) throw new Error('continuity_write_blocked_by_backup_restore');
  const databaseCleanup = await enqueueMutation(async () => {
    let outcome = {
      status: 'already_absent' as 'deleted' | 'already_absent',
      candidates: 0,
      transitions: 0,
      links: 0,
      events: 0,
    };
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      await runWithMemoryRecordsCaptureSuppressed(async (transaction) => {
        await purgeLeakedRetiredStaySyncCapture(transaction);
        const state = await inspectRetiredStayFossils(transaction);
        if (state === 'already_absent') return;
        const candidates = await transaction.runAsync(
          `DELETE FROM continuity_event_candidates
           WHERE target_event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})
              OR result_event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
          ...RETIRED_STAY_FOSSIL_EVENT_IDS,
          ...RETIRED_STAY_FOSSIL_EVENT_IDS,
        );
        const transitions = await transaction.runAsync(
          `DELETE FROM continuity_event_transitions
           WHERE event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
          ...RETIRED_STAY_FOSSIL_EVENT_IDS,
        );
        const links = await transaction.runAsync(
          `DELETE FROM continuity_event_links
           WHERE event_id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
          ...RETIRED_STAY_FOSSIL_EVENT_IDS,
        );
        const events = await transaction.runAsync(
          `DELETE FROM continuity_events
           WHERE id IN (${RETIRED_STAY_FOSSIL_PLACEHOLDERS})`,
          ...RETIRED_STAY_FOSSIL_EVENT_IDS,
        );
        if (events.changes !== RETIRED_STAY_FOSSIL_EVENT_IDS.length) {
          throw new Error('continuity_retired_stay_fossil_delete_incomplete');
        }
        if (await inspectRetiredStayFossils(transaction) !== 'already_absent') {
          throw new Error('continuity_retired_stay_fossil_delete_incomplete');
        }
        outcome = {
          status: 'deleted',
          candidates: candidates.changes,
          transitions: transitions.changes,
          links: links.changes,
          events: events.changes,
        };
      });
    });
    if (!committed.committed) throw new Error('continuity_write_blocked_by_backup_restore');
    return outcome;
  });
  return databaseCleanup;
}

export type UpsertBaiyunContinuityCandidateInput = {
  candidateKey: string;
  kind: BaiyunContinuityCandidateKind;
  eventKind?: BaiyunContinuityEventKind;
  primaryIntent?: BaiyunActionIntentId;
  targetEventId?: string;
  proposedResolution?: BaiyunContinuityResolutionState;
  sessionId: string;
  messageId: string;
  detectionBasis: BaiyunContinuityDetectionBasis;
  confidence: number;
  reasonCodes?: readonly string[];
  coalescingKey?: string;
  occurredAt?: number;
  expiresAt?: number;
};

function normalizeCandidateTechnicalCode(value: string) {
  return value.trim().replace(/[^a-z0-9_:-]/giu, '_').slice(0, 80);
}

function buildContinuityCandidate(input: UpsertBaiyunContinuityCandidateInput): BaiyunContinuityCandidate {
  const now = input.occurredAt ?? Date.now();
  const candidateKey = input.candidateKey.trim();
  const sessionId = input.sessionId.trim();
  const messageId = input.messageId.trim();
  const confidence = Math.max(0, Math.min(1, input.confidence));
  if (!candidateKey || !sessionId || !messageId) throw new Error('continuity_candidate_identity_required');
  if (!Number.isFinite(input.confidence)) throw new Error('continuity_candidate_confidence_invalid');
  if (input.kind === 'create_event') {
    if (
      !input.eventKind
      || !isBaiyunActionIntentId(input.primaryIntent)
      || input.targetEventId
      || input.proposedResolution
    ) {
      throw new Error('continuity_create_candidate_invalid');
    }
  } else if (!input.targetEventId || !input.proposedResolution || input.eventKind || input.primaryIntent) {
    throw new Error('continuity_resolution_candidate_invalid');
  }
  const reasonCodes = [...new Set(
    (input.reasonCodes ?? []).map(normalizeCandidateTechnicalCode).filter(Boolean),
  )].slice(0, 8);
  return {
    id: createId('continuity-candidate', now), candidateKey, kind: input.kind,
    state: 'pending', eventKind: input.eventKind, primaryIntent: input.primaryIntent,
    targetEventId: input.targetEventId?.trim() || undefined,
    proposedResolution: input.proposedResolution, sessionId, messageId,
    detectionBasis: input.detectionBasis, confidence, reasonCodes,
    coalescingKey: input.coalescingKey?.trim() || undefined, occurredAt: now,
    expiresAt: input.expiresAt ?? now + 7 * 24 * 60 * 60 * 1000,
    createdAt: now, updatedAt: now, revision: 1, schemaVersion: 1,
  };
}

export async function upsertBaiyunContinuityCandidate(input: UpsertBaiyunContinuityCandidateInput) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const candidate = buildContinuityCandidate(input);
    const database = await getContinuityDatabase();
    if (await candidateTargetsRetiredEvent(database, candidate)) {
      throw new Error('continuity_candidate_retired');
    }
    await commitOperation({
      version: 1, type: 'candidate_upsert',
      operationId: `continuity-candidate-upsert:${candidate.candidateKey}`, candidate,
    }, dataEpoch);
    const row = await getCandidateByKey(database, candidate.candidateKey);
    if (!row) throw new Error('continuity_candidate_not_persisted');
    return candidateFromRow(row);
  });
}

export async function listPendingBaiyunContinuityCandidates(input: {
  sessionId?: string;
  limit?: number;
} = {}) {
  return [] as BaiyunContinuityCandidate[];
}

export async function listBaiyunContinuityCandidates(input: {
  sessionId?: string;
  states?: readonly BaiyunContinuityCandidateState[];
  since?: number;
  limit?: number;
  maintain?: boolean;
} = {}) {
  return [] as BaiyunContinuityCandidate[];
}

export async function acceptBaiyunContinuityCandidate(input: {
  candidateId: string; expectedRevision: number; occurredAt?: number;
}) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const existingRow = await getCandidateRow(database, input.candidateId);
    if (
      existingRow
      && await candidateTargetsRetiredEvent(database, candidateFromRow(existingRow))
    ) throw new Error('continuity_candidate_retired');
    const occurredAt = input.occurredAt ?? Date.now();
    await commitOperation({
      version: 1, type: 'candidate_accept',
      operationId: `continuity-candidate-accept:${input.candidateId}:${input.expectedRevision}`,
      candidateId: input.candidateId, expectedRevision: input.expectedRevision, occurredAt,
    }, dataEpoch);
    const row = await getCandidateRow(database, input.candidateId);
    if (!row) throw new Error('continuity_candidate_not_found_after_accept');
    return candidateFromRow(row);
  });
}

export async function dismissBaiyunContinuityCandidate(input: {
  candidateId: string; expectedRevision: number; occurredAt?: number;
}) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const existingRow = await getCandidateRow(database, input.candidateId);
    if (
      existingRow
      && await candidateTargetsRetiredEvent(database, candidateFromRow(existingRow))
    ) throw new Error('continuity_candidate_retired');
    const occurredAt = input.occurredAt ?? Date.now();
    await commitOperation({
      version: 1, type: 'candidate_set_state',
      operationId: `continuity-candidate-dismiss:${input.candidateId}:${input.expectedRevision}`,
      candidateId: input.candidateId, expectedRevision: input.expectedRevision,
      nextState: 'dismissed', occurredAt,
    }, dataEpoch);
    const row = await getCandidateRow(database, input.candidateId);
    if (!row) throw new Error('continuity_candidate_not_found_after_dismiss');
    return candidateFromRow(row);
  });
}

export async function undoBaiyunContinuityRegistration(input: {
  candidateId: string;
  expectedRevision: number;
  occurredAt?: number;
}) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const existingRow = await getCandidateRow(database, input.candidateId);
    if (
      existingRow
      && await candidateTargetsRetiredEvent(database, candidateFromRow(existingRow))
    ) throw new Error('continuity_candidate_retired');
    const occurredAt = input.occurredAt ?? Date.now();
    await commitOperation({
      version: 1,
      type: 'candidate_undo_registration',
      operationId: `continuity-candidate-undo:${input.candidateId}:${input.expectedRevision}`,
      candidateId: input.candidateId,
      expectedRevision: input.expectedRevision,
      occurredAt,
    }, dataEpoch);
    const row = await getCandidateRow(database, input.candidateId);
    if (!row) throw new Error('continuity_candidate_not_found_after_undo');
    return candidateFromRow(row);
  });
}

export async function expireBaiyunContinuityCandidates(now = Date.now()) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(() => commitOperation({
    version: 1, type: 'candidate_expire',
    operationId: `continuity-candidate-expire:${Math.floor(now / 60000)}`, now,
  }, dataEpoch));
}

export async function completeBaiyunContinuityEventManually(input: {
  eventId: string; expectedRevision: number; occurredAt?: number;
}) {
  const occurredAt = input.occurredAt ?? Date.now();
  return recordBaiyunContinuityEvidence({
    eventId: input.eventId, expectedRevision: input.expectedRevision,
    operationId: `continuity-manual-completion:${input.eventId}:${input.expectedRevision}`,
    evidence: {
      id: `continuity-manual-completion:${input.eventId}:${input.expectedRevision}`,
      kind: 'manual_completion', sourceId: input.eventId, occurredAt, outcome: 'succeeded',
    },
    reasonCode: 'manual_completion',
  });
}

export async function advanceDueBaiyunContinuityEvents(now = Date.now()) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(async () => {
    const database = await getContinuityDatabase();
    const dueRow = await database.getFirstAsync<{ id: string }>(
      `SELECT id FROM continuity_events
       WHERE status IN ('open', 'waiting')
         AND primary_intent IS NOT 'stay'
         AND next_action_at IS NOT NULL
         AND next_action_at <= ?
       LIMIT 1`,
      now,
    );
    if (dueRow) {
      await commitOperation({
        version: 1,
        type: 'advance_due',
        operationId: createId('continuity-due', now),
        now,
      }, dataEpoch);
    }
    const rows = await database.getAllAsync<ContinuityEventRow>(
      `SELECT * FROM continuity_events
       WHERE status IN ('open', 'waiting')
         AND primary_intent IS NOT 'stay'
       ORDER BY
         CASE WHEN next_action_at IS NOT NULL THEN 0 ELSE 1 END,
         next_action_at ASC,
         occurred_at ASC`,
    );
    return rows.map(eventFromRow).filter((event) => !isRetiredContinuityEvent(event));
  });
}

export async function clearBaiyunContinuityAcceptanceEvents(now = Date.now()) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  return enqueueMutation(() => commitOperation({
    version: 1,
    type: 'clear_acceptance',
    operationId: createId('continuity-clear-acceptance', now),
    occurredAt: now,
  }, dataEpoch));
}

export async function getBaiyunContinuityEvent(eventId: string, readOnly = false) {
  if (!readOnly) await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase(readOnly);
  const row = await getEventRow(database, eventId);
  const event = row ? eventFromRow(row) : null;
  return event && !isRetiredContinuityEvent(event) ? event : null;
}

export async function getBaiyunContinuityEventByIdempotencyKey(idempotencyKey: string) {
  await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase();
  const row = await getEventByIdempotencyKey(database, idempotencyKey);
  const event = row ? eventFromRow(row) : null;
  return event && !isRetiredContinuityEvent(event) ? event : null;
}

export async function listOpenBaiyunContinuityEvents() {
  return listBaiyunContinuityEvents({ statuses: ['open', 'waiting'] });
}

function normalizeContextTarget(target: MemoryContinuityContextLink) {
  const targetId = target.targetId.trim();
  if (!targetId) throw new Error('continuity_context_target_invalid');
  if (target.relation === 'memory' && target.targetKind === 'memory') {
    return { relation: 'memory', targetKind: 'memory', targetId } as const;
  }
  if (target.relation === 'current_state' && target.targetKind === 'memory_current_state') {
    return { relation: 'current_state', targetKind: 'memory_current_state', targetId } as const;
  }
  throw new Error('continuity_context_target_invalid');
}

function normalizeContinuityDateRange(range: BaiyunContinuityDateRange) {
  if (
    !Number.isSafeInteger(range.fromInclusive)
    || !Number.isSafeInteger(range.toExclusive)
    || range.fromInclusive < 0
    || range.toExclusive <= range.fromInclusive
  ) {
    throw new Error('continuity_date_range_invalid');
  }
  return range;
}

function normalizeContinuityEventIds(eventIds: readonly string[]) {
  const ids = [...new Set(eventIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length > 100) throw new Error('continuity_context_event_limit');
  return ids;
}

export async function listBaiyunContinuityEvents(
  query: ListBaiyunContinuityEventsQuery = {},
) {
  if (!query.readOnly) await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase(query.readOnly);
  const clauses: string[] = [];
  const parameters: Array<string | number> = [];
  clauses.push('event.primary_intent IS NOT ?');
  parameters.push('stay');
  if (query.statuses?.length) {
    const statuses = [...new Set(query.statuses)];
    if (statuses.some((status) => !BAIYUN_CONTINUITY_EVENT_STATUSES.includes(status))) {
      throw new Error('continuity_status_filter_invalid');
    }
    clauses.push(`event.status IN (${statuses.map(() => '?').join(', ')})`);
    parameters.push(...statuses);
  }
  if (query.kinds?.length) {
    const kinds = [...new Set(query.kinds)];
    if (kinds.some((kind) => !BAIYUN_CONTINUITY_EVENT_KINDS.includes(kind))) {
      throw new Error('continuity_kind_filter_invalid');
    }
    clauses.push(`event.kind IN (${kinds.map(() => '?').join(', ')})`);
    parameters.push(...kinds);
  }
  if (query.contextTarget) {
    const target = normalizeContextTarget(query.contextTarget);
    clauses.push(
      `EXISTS (
        SELECT 1 FROM continuity_event_links context_link
        WHERE context_link.event_id = event.id
          AND context_link.relation = ?
          AND context_link.target_kind = ?
          AND context_link.target_id = ?
      )`,
    );
    parameters.push(target.relation, target.targetKind, target.targetId);
  }
  if (query.activeDuring) {
    const range = normalizeContinuityDateRange(query.activeDuring);
    clauses.push(
      `event.occurred_at < ?
       AND COALESCE(event.completed_at, event.cancelled_at, 9223372036854775807) > ?`,
    );
    parameters.push(range.toExclusive, range.fromInclusive);
  }
  const limit = Math.max(1, Math.min(200, Math.floor(query.limit ?? 200)));
  const rows = await database.getAllAsync<ContinuityEventRow>(
    `SELECT event.* FROM continuity_events event
     ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
     ORDER BY
       CASE WHEN event.status IN ('open', 'waiting') THEN 0 ELSE 1 END,
       CASE WHEN event.next_action_at IS NOT NULL THEN 0 ELSE 1 END,
       event.next_action_at ASC,
       event.occurred_at ASC, event.id ASC
     LIMIT ? OFFSET ?`,
    ...parameters,
    limit,
    Math.max(0, Math.floor(query.offset ?? 0)),
  );
  return rows.map(eventFromRow).filter((event) => !isRetiredContinuityEvent(event));
}

export async function listBaiyunContinuityEventsForContext(
  target: MemoryContinuityContextLink,
) {
  return listBaiyunContinuityEvents({ contextTarget: target });
}

async function contextTargetExists(
  database: ContinuityDatabase,
  target: MemoryContinuityContextLink,
) {
  const row = target.relation === 'memory'
    ? await database.getFirstAsync<{ id: string }>('SELECT id FROM memories WHERE id = ?', target.targetId)
    : await database.getFirstAsync<{ id: string }>('SELECT id FROM memory_current_states WHERE id = ?', target.targetId);
  return Boolean(row);
}

export async function setBaiyunContinuityEventsForContextTarget(input: {
  target: MemoryContinuityContextLink;
  eventIds: readonly string[];
  now?: number;
}): Promise<SetBaiyunContinuityContextOutcome> {
  await recoverPendingContinuityLedgerOperation();
  const target = normalizeContextTarget(input.target);
  const eventIds = normalizeContinuityEventIds(input.eventIds);
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) {
    return { status: 'data_epoch_changed', added: 0, removed: 0 };
  }
  return enqueueMutation(async () => {
    let outcome: SetBaiyunContinuityContextOutcome = {
      status: 'unchanged',
      added: 0,
      removed: 0,
    };
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getContinuityDatabase();
      await database.withExclusiveTransactionAsync(async (transaction) => {
        if (!await contextTargetExists(transaction, target)) {
          outcome = { status: 'target_missing', added: 0, removed: 0 };
          return;
        }
        const existingRows = await transaction.getAllAsync<{ event_id: string }>(
          `SELECT link.event_id FROM continuity_event_links link
           INNER JOIN continuity_events event ON event.id = link.event_id
           WHERE event.primary_intent IS NOT 'stay'
             AND link.relation = ? AND link.target_kind = ? AND link.target_id = ?`,
          target.relation,
          target.targetKind,
          target.targetId,
        );
        const existingIds = new Set(existingRows.map((row) => row.event_id));
        const eventRows = eventIds.length
          ? await transaction.getAllAsync<{ id: string; status: BaiyunContinuityEventStatus }>(
            `SELECT id, status FROM continuity_events
             WHERE primary_intent IS NOT 'stay'
               AND id IN (${eventIds.map(() => '?').join(', ')})`,
            ...eventIds,
          )
          : [];
        if (eventRows.length !== eventIds.length) {
          outcome = { status: 'event_missing', added: 0, removed: 0 };
          return;
        }
        const newlyLinkedTerminal = eventRows.some((row) => (
          !existingIds.has(row.id) && row.status !== 'open' && row.status !== 'waiting'
        ));
        if (newlyLinkedTerminal) {
          outcome = { status: 'terminal_event', added: 0, removed: 0 };
          return;
        }
        const requestedIds = new Set(eventIds);
        const toAdd = eventIds.filter((id) => !existingIds.has(id));
        const toRemove = [...existingIds].filter((id) => !requestedIds.has(id));
        for (const eventId of toAdd) {
          await transaction.runAsync(
            `INSERT OR IGNORE INTO continuity_event_links (
              event_id, relation, target_kind, target_id, created_at
            ) VALUES (?, ?, ?, ?, ?)`,
            eventId,
            target.relation,
            target.targetKind,
            target.targetId,
            input.now ?? Date.now(),
          );
        }
        for (const eventId of toRemove) {
          await transaction.runAsync(
            `DELETE FROM continuity_event_links
             WHERE event_id = ? AND relation = ? AND target_kind = ? AND target_id = ?`,
            eventId,
            target.relation,
            target.targetKind,
            target.targetId,
          );
        }
        outcome = {
          status: toAdd.length || toRemove.length ? 'updated' : 'unchanged',
          added: toAdd.length,
          removed: toRemove.length,
        };
      });
    });
    return committed.committed
      ? outcome
      : { status: 'data_epoch_changed', added: 0, removed: 0 };
  });
}

export async function removeBaiyunContinuityContextLink(input: {
  eventId: string;
  target: MemoryContinuityContextLink;
}) {
  await recoverPendingContinuityLedgerOperation();
  const target = normalizeContextTarget(input.target);
  const eventId = input.eventId.trim();
  if (!eventId) return false;
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return false;
  return enqueueMutation(async () => {
    let removed = false;
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getContinuityDatabase();
      await database.withExclusiveTransactionAsync(async (transaction) => {
        const result = await transaction.runAsync(
          `DELETE FROM continuity_event_links
           WHERE event_id = ? AND relation = ? AND target_kind = ? AND target_id = ?
             AND EXISTS (
               SELECT 1 FROM continuity_events active_event
               WHERE active_event.id = continuity_event_links.event_id
                 AND active_event.primary_intent IS NOT 'stay'
             )`,
          eventId,
          target.relation,
          target.targetKind,
          target.targetId,
        );
        removed = result.changes > 0;
      });
    });
    return committed.committed && removed;
  });
}

export async function loadBaiyunContinuityContextSummary(
  eventId: string,
): Promise<BaiyunContinuityContextSummary> {
  await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase();
  const eventRow = await getEventRow(database, eventId);
  if (!eventRow || eventRow.primary_intent === 'stay') {
    return { eventId, memories: [], currentStates: [] };
  }
  const memories = await database.getAllAsync<{
    id: string;
    title: string;
    type: string;
  }>(
    `SELECT memory.id, memory.title, memory.type
     FROM continuity_event_links link
     INNER JOIN memories memory ON memory.id = link.target_id
     WHERE link.event_id = ? AND link.relation = 'memory' AND link.target_kind = 'memory'
     ORDER BY link.created_at ASC`,
    eventId,
  );
  const currentStates = await database.getAllAsync<{
    id: string;
    title: string;
    kind: string;
    status: 'active' | 'resolved' | 'expired';
  }>(
    `SELECT state.id, state.title, state.kind, state.status
     FROM continuity_event_links link
     INNER JOIN memory_current_states state ON state.id = link.target_id
     WHERE link.event_id = ?
       AND link.relation = 'current_state'
       AND link.target_kind = 'memory_current_state'
     ORDER BY link.created_at ASC`,
    eventId,
  );
  return {
    eventId,
    memories: memories.map((memory) => ({
      id: memory.id,
      title: memory.title,
      status: memory.type === 'archived' ? 'archived' : 'active',
    })),
    currentStates,
  };
}

export async function reconcileBaiyunContinuityContextLinks() {
  await recoverPendingContinuityLedgerOperation();
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return { status: 'data_epoch_changed' as const, removed: 0 };
  return enqueueMutation(async () => {
    let removed = 0;
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const database = await getContinuityDatabase();
      await database.withExclusiveTransactionAsync(async (transaction) => {
        const result = await transaction.runAsync(
          `DELETE FROM continuity_event_links
           WHERE EXISTS (
             SELECT 1 FROM continuity_events active_event
             WHERE active_event.id = continuity_event_links.event_id
               AND active_event.primary_intent IS NOT 'stay'
           ) AND ((
             relation = 'memory'
             AND (
               target_kind <> 'memory'
               OR NOT EXISTS (SELECT 1 FROM memories WHERE memories.id = continuity_event_links.target_id)
             )
           ) OR (
             relation = 'current_state'
             AND (
               target_kind <> 'memory_current_state'
               OR NOT EXISTS (
                 SELECT 1 FROM memory_current_states
                 WHERE memory_current_states.id = continuity_event_links.target_id
               )
             )
           ))`,
        );
        removed = result.changes;
      });
    });
    return committed.committed
      ? { status: 'completed' as const, removed }
      : { status: 'data_epoch_changed' as const, removed: 0 };
  });
}

export async function listBaiyunContinuityTransitions(eventId: string, readOnly = false) {
  if (!readOnly) await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase(readOnly);
  const eventRow = await getEventRow(database, eventId);
  if (!eventRow || eventRow.primary_intent === 'stay') return [];
  const rows = await database.getAllAsync<ContinuityTransitionRow>(
    `SELECT * FROM continuity_event_transitions
     WHERE event_id = ? ORDER BY occurred_at ASC`,
    eventId,
  );
  return rows.map(transitionFromRow);
}

export async function listBaiyunContinuityLinks(eventId: string, readOnly = false) {
  if (!readOnly) await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase(readOnly);
  const eventRow = await getEventRow(database, eventId);
  if (!eventRow || eventRow.primary_intent === 'stay') return [];
  const rows = await database.getAllAsync<{
    event_id: string;
    relation: BaiyunContinuityEventLink['relation'];
    target_kind: string;
    target_id: string;
    created_at: number;
  }>(
    'SELECT * FROM continuity_event_links WHERE event_id = ? ORDER BY created_at ASC',
    eventId,
  );
  return rows.map((row) => ({
    eventId: row.event_id,
    relation: row.relation,
    targetKind: row.target_kind,
    targetId: row.target_id,
    createdAt: row.created_at,
  }));
}

function localDateKey(at: number) {
  const date = new Date(at);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export async function createBaiyunContinuityAcceptanceEvents(now = Date.now()) {
  const common = {
    occurredAt: now,
    occurredLocalDate: localDateKey(now),
    timezoneOffsetMinutes: -new Date(now).getTimezoneOffset(),
  };
  await createBaiyunContinuityEvent({
    ...common,
    eventId: `${BAIYUN_CONTINUITY_TEST_PREFIX}closeness`,
    operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}create-closeness`,
    kind: 'closeness_request',
    subject: 'you',
    primaryIntent: 'affection',
    idempotencyKey: `${BAIYUN_CONTINUITY_TEST_PREFIX}closeness`,
    source: { kind: 'global_relationship', sourceId: 'acceptance-closeness' },
  });
  let rupture = await createBaiyunContinuityEvent({
    ...common,
    eventId: `${BAIYUN_CONTINUITY_TEST_PREFIX}rupture`,
    operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}create-rupture`,
    kind: 'relationship_rupture',
    subject: 'you',
    primaryIntent: 'retain',
    idempotencyKey: `${BAIYUN_CONTINUITY_TEST_PREFIX}rupture`,
    source: { kind: 'global_relationship', sourceId: 'acceptance-rupture' },
  });
  if (rupture.stage === 'rupture_detected') {
    rupture = await transitionBaiyunContinuityEvent({
      eventId: rupture.id,
      expectedRevision: rupture.revision,
      nextStage: 'retained',
      reasonCode: 'acceptance_retain_delivered',
      occurredAt: now + 1,
      operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}retain-rupture`,
    });
  }
  await createBaiyunContinuityEvent({
    ...common,
    occurredAt: now + 2,
    eventId: `${BAIYUN_CONTINUITY_TEST_PREFIX}return`,
    operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}create-return`,
    kind: 'return_commitment',
    subject: 'I',
    returningSubject: 'I',
    primaryIntent: 'rest_return',
    parentEventId: rupture.id,
    idempotencyKey: `${BAIYUN_CONTINUITY_TEST_PREFIX}return`,
    source: { kind: 'global_action_plan', sourceId: 'acceptance-return-plan' },
    nextActionAt: now + 30 * 60_000,
    resumeCondition: { kind: 'at_time', dueAt: now + 30 * 60_000 },
  });
  await createBaiyunContinuityEvent({
    ...common,
    eventId: `${BAIYUN_CONTINUITY_TEST_PREFIX}proactive`,
    operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}create-proactive`,
    kind: 'proactive_intention',
    subject: 'I',
    primaryIntent: 'approach',
    idempotencyKey: `${BAIYUN_CONTINUITY_TEST_PREFIX}proactive`,
    source: { kind: 'global_action_plan', sourceId: 'acceptance-proactive-plan' },
  });
  await createBaiyunContinuityEvent({
    ...common,
    eventId: `${BAIYUN_CONTINUITY_TEST_PREFIX}care`,
    operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}create-care`,
    kind: 'care_process',
    subject: 'you',
    primaryIntent: 'interrupt',
    idempotencyKey: `${BAIYUN_CONTINUITY_TEST_PREFIX}care`,
    source: { kind: 'real_care', sourceId: 'acceptance-care-signal' },
    nextActionAt: now + 20 * 60_000,
    resumeCondition: { kind: 'at_time', dueAt: now + 20 * 60_000 },
    permissionRequirements: ['care_preauthorization'],
  });
  await createBaiyunContinuityEvent({
    ...common,
    eventId: `${BAIYUN_CONTINUITY_TEST_PREFIX}cross-day`,
    operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}create-cross-day`,
    kind: 'cross_day_life',
    subject: 'you',
    primaryIntent: 'care_check',
    idempotencyKey: `${BAIYUN_CONTINUITY_TEST_PREFIX}cross-day`,
    source: { kind: 'real_life', sourceId: 'acceptance-cross-day-fact' },
    nextActionAt: now + 24 * 60 * 60_000,
    resumeCondition: { kind: 'at_time', dueAt: now + 24 * 60 * 60_000 },
  });
  return listOpenBaiyunContinuityEvents();
}

export async function forceBaiyunContinuityAcceptanceEventsDue(now = Date.now()) {
  const events = await listOpenBaiyunContinuityEvents();
  for (const event of events) {
    if (
      !event.idempotencyKey.startsWith(BAIYUN_CONTINUITY_TEST_PREFIX)
      || event.nextActionAt === undefined
    ) continue;
    await transitionBaiyunContinuityEvent({
      eventId: event.id,
      expectedRevision: event.revision,
      nextStage: event.stage,
      nextStatus: 'waiting',
      reasonCode: 'acceptance_force_due',
      occurredAt: now,
      operationId: `${BAIYUN_CONTINUITY_TEST_PREFIX}force-due:${event.id}:${event.revision}`,
      nextActionAt: now,
      resumeCondition: { kind: 'at_time', dueAt: now },
    });
  }
  return advanceDueBaiyunContinuityEvents(now);
}


/** Shared six-slot chat ledger; independent of diary/system pagination. */
export async function listChatCareMatters(readOnly = false) {
  if (!readOnly) await recoverPendingContinuityLedgerOperation();
  const database = await getContinuityDatabase(readOnly);
  const rows = await database.getAllAsync<ContinuityEventRow>(
    `SELECT * FROM continuity_events WHERE kind = 'care_process' AND (schema_version = 3 OR ${HEART_CARE_RECORD_PREDICATE}) AND status IN ('open', 'waiting') ORDER BY updated_at DESC, id ASC`,
  );
  return Promise.all(rows.map(async row => {
    const event = eventFromRow(row);
    return { ...event, deviceRecord: await loadHeartCareDeviceRecord(event) };
  }));
}
