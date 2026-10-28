import AsyncStorage from '@react-native-async-storage/async-storage';
import { normalizeChatProviderHost, normalizeChatProviderRequestId, normalizeChatTransportErrorCode, normalizeChatTransportErrorName } from '../chatCompletionTransport';
import type { JunLuoReminderActionIssue } from '../../tools/toolAgentLoop';
import type { BaiyunFixedEnvelopeRootFailure, BaiyunFixedEnvelopeJsonParseIssue } from './actionChatFixedEnvelope';
import type { MemoryRecallPreparationDiagnostic, MemoryRecallStageDiagnostic } from '../../memory/memoryChatPreparation';
import { MEMORY_RECALL_WORK_PHASES } from '../../memory/memoryChatPreparation';
import { normalizeChatAuxiliaryFailureDetails, type ChatAuxiliaryFailureDetails } from '../../chat/chatAuxiliaryDiagnostics';

import type { BaiyunSemanticSignalKind } from './actionSemantic';
import type { BaiyunActionIntentId } from './actionIntent';
import type {
  VisibleReplyFailureReason,
  VisibleReplySource,
  VisibleReplyStatus,
} from '../visibleReplyExtraction';
import type {
  BaiyunSemanticSignalDiagnostic,
  BaiyunSemanticSignalRejectionCode,
  BaiyunShareResponseDiagnostic,
  BaiyunShareResponseRejectionCode,
} from './actionChatSemantic';
import type {
  BaiyunContinuityResolutionDiagnostic,
  BaiyunContinuityResolutionRejectionCode,
} from './actionChatContinuityEvidence';
import type {
  BaiyunLocalShareMatchKind,
  BaiyunLocalShareMatchSkipReason,
} from './actionShareResponse';
import {
  CHAT_REPLY_FAILURE_CODE,
  isChatReplyFailureCode,
  isChatReplyFailureStage,
  isChatReplyTechnicalReasonCode,
  type ChatReplyFailureCode,
  type ChatReplyFailureStage,
  type ChatReplyTechnicalReasonCode,
} from '../../chat/chatReplyFailure';

const CHAT_SEMANTIC_DIAGNOSTICS_KEY = 'junluo.baiyunBehavior.chatSemanticDiagnostics.v1';
const CHAT_REPLY_FAILURE_DIAGNOSTICS_KEY = 'junluo.baiyunBehavior.chatReplyFailureDiagnostics.v1';
const CHAT_REPLY_FAILURE_FIXTURE_KEY = 'junluo.baiyunBehavior.chatReplyFailureFixture.v1';
const MAX_DIAGNOSTIC_ENTRIES = 30;

export type BaiyunChatSemanticDiagnosticStatus =
  | 'valid'
  | 'partial'
  | 'semantic_unresolved'
  | 'messages_invalid';

export type BaiyunChatActionDisposition =
  | 'actionable'
  | 'ordinary_no_action'
  | 'unresolved';

export type BaiyunChatModelAttemptDiagnostic = {
  attemptOrdinal: number;
  mode: 'full' | 'messages_only';
  requestType?: 'initial' | 'continuation' | 'retry';
  retryKind?: 'tool_fact_correction' | 'quality_retry' | 'protocol_correction';
  transportOutcome?: 'started' | 'response_received' | 'http_error' | 'network_error' | 'timeout' | 'aborted';
  httpStatus?: number;
  directContentChars?: number;
  reasoningContentChars?: number;
  finishReason?: string;
  usagePresent?: boolean;
  toolCallCount?: number;
  offeredToolCount?: number;
  toolCapabilitySource?: 'official_profile' | 'verified_probe' | 'disabled_default' | 'protocol_default';
  technicalCode?: 'provider_empty_success';
  responseObserved?: boolean;
  startedAt?: number;
  headersReceivedAt?: number;
  transportKind?: 'fetch' | 'xhr';
  responseAvailableAt?: number;
  bodyReadStartedAt?: number;
  timeoutMs?: number;
  errorName?: string;
  errorCode?: string;
  causeCode?: string;
  externalAborted?: boolean;
  providerRequestId?: string;
  providerHost?: string;
  firstContentAt?: number;
  responseCompletedAt?: number;
  finishedAt?: number;
  responseChars?: number;
  bodyParseFailure?: 'invalid_json' | 'body_read_failed' | 'invalid_payload';
  stopCause?: 'timeout' | 'aborted';
  providerErrorCode?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number; cachedPromptTokens?: number };
  requestPurpose?: 'package_discovery' | 'concrete_tools' | 'final';
  retryReason?: 'empty_response' | 'visible_envelope_invalid' | 'tool_fact_correction' | 'protocol_correction';
  failureCode?: ChatReplyFailureCode;
  toolGroundingReasons?: string[];
};

export type BaiyunChatToolDiagnosticEvent = {
  callId?: string;
  kind: 'package' | 'execution';
  name: string;
  status: string;
  at: number;
  modelAttemptOrdinal?: number;
};

type ChatDiagnosticContext = {
  replyPurpose?: 'ordinary' | 'day_plan_adjustment' | 'day_plan_receipt';
  toolProtocolFailure?: {
    code: string;
    callErrors: Array<{ errorCode: string }>;
    finishReason?: string;
    rawToolCallCount: number;
    replyFormatReason?: 'textual_tool_protocol' | 'reminder_action_contract_missing'
      | 'reminder_source_mismatch' | 'reminder_choice_invalid';
    reminderActionIssue?: JunLuoReminderActionIssue;
    reminderActionDirectIssue?: JunLuoReminderActionIssue | 'valid';
    reminderVisibleReplySource?: 'direct_content' | 'reasoning_marked_visible';
    reminderActionRootFailure?: BaiyunFixedEnvelopeRootFailure;
    reminderActionDirectRootFailure?: BaiyunFixedEnvelopeRootFailure;
  };
  sendStartedAt?: number;
  firstBubbleCommittedAt?: number;
  preparationCheckpoints?: {
    youPersistedAt?: number;
    sleepAcceptedAt?: number;
    replyQueuedAt?: number;
    runReplyEnteredAt?: number;
    sourceReadyAt?: number;
    contextStartedAt?: number;
    contextReadyAt?: number;
    providerEnteredAt?: number;
    envelopeReadyAt?: number;
    preflightReadyAt?: number;
    replyReadyAt?: number;
  };
  providerPreparation?: {
    requestOrdinal: number;
    checkpoint: 'providerEnteredAt' | 'envelopeReadyAt' | 'preflightReadyAt';
    at: number;
  };
  memoryPreparation?: MemoryRecallPreparationDiagnostic;
  deliveryKind?: 'text' | 'tool_card';
  turnAttemptId?: string;
  sessionId?: string;
  sourceMessageId?: string;
  startedAt?: number;
  finishedAt?: number;
  connectionId?: string;
  connectionName?: string;
  model?: string;
  toolEvents?: BaiyunChatToolDiagnosticEvent[];
  auxiliaryFailures?: Array<{ phase: string; stage: string; step?: string; at: number } & ChatAuxiliaryFailureDetails>;
};

export type BaiyunChatSemanticDiagnosticEntry = ChatDiagnosticContext & {
  id: string;
  attemptedAt: number;
  localDate: string;
  status: BaiyunChatSemanticDiagnosticStatus;
  basketStatuses?: Partial<Record<'messages' | 'careUpdates' | 'shareResponses' | 'innerReaction' | 'wishDiscussion' | 'memoryMentions', string>>;
  actionDisposition?: BaiyunChatActionDisposition;
  reason?: string;
  signalKinds: Array<BaiyunSemanticSignalKind | BaiyunActionIntentId>;
  connectionId: string;
  connectionName: string;
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedPromptTokens?: number;
  modelRequestCount?: number;
  replyPersisted?: boolean;
  replyPersistAttempts?: number;
  insertedMessageCount?: number;
  finishReason?: string;
  jsonOutputRequested?: boolean;
  rawContentFormat?: 'empty' | 'json_object' | 'json_value' | 'fenced_content' | 'tagged_content' | 'non_json';
  rawContentChars?: number;
  reasoningContentChars?: number;
  recoveredFromReasoning?: boolean;
  responseEnvelopeMode?: 'messages_only' | 'messages_with_semantic';
  semanticPrefixCompletionRequested?: boolean;
  usagePresent?: boolean;
  visibleReplyFailureReason?: VisibleReplyFailureReason;
  visibleReplySource?: VisibleReplySource;
  visibleReplyStatus?: VisibleReplyStatus;
  semanticOutputEstimatedTokens: number;
  shareResponseDiagnostic?: BaiyunShareResponseDiagnostic;
  signalDiagnostic?: BaiyunSemanticSignalDiagnostic;
  continuityResolutionDiagnostic?: BaiyunContinuityResolutionDiagnostic;
  modelAttempts?: BaiyunChatModelAttemptDiagnostic[];
};

export type BaiyunChatSemanticDiagnostics = {
  entries: BaiyunChatSemanticDiagnosticEntry[];
};

export type BaiyunChatReplyFailureDiagnosticEntry = ChatDiagnosticContext & {
  id: string;
  attemptedAt: number;
  localDate: string;
  code: ChatReplyFailureCode;
  stage: ChatReplyFailureStage;
  secondaryStages?: ChatReplyFailureStage[];
  technicalReasonCode?: ChatReplyTechnicalReasonCode;
  modelAttempts?: BaiyunChatModelAttemptDiagnostic[];
  modelRequestCount?: number;
  replyPersisted?: boolean;
  replyPersistAttempts?: number;
};

export type BaiyunChatReplyFailureDiagnostics = {
  entries: BaiyunChatReplyFailureDiagnosticEntry[];
};

export type BaiyunChatReplyFailureFixtureCode =
  | typeof CHAT_REPLY_FAILURE_CODE.modelVisibleTextMissing
  | typeof CHAT_REPLY_FAILURE_CODE.visibleEnvelopeInvalid
  | typeof CHAT_REPLY_FAILURE_CODE.sessionPersistFailed;

const CHAT_REPLY_FAILURE_FIXTURE_CODES = new Set<BaiyunChatReplyFailureFixtureCode>([
  CHAT_REPLY_FAILURE_CODE.modelVisibleTextMissing,
  CHAT_REPLY_FAILURE_CODE.visibleEnvelopeInvalid,
  CHAT_REPLY_FAILURE_CODE.sessionPersistFailed,
]);

function isDevelopmentRuntime() {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function isChatReplyFailureFixtureCode(
  value: unknown,
): value is BaiyunChatReplyFailureFixtureCode {
  return typeof value === 'string'
    && CHAT_REPLY_FAILURE_FIXTURE_CODES.has(value as BaiyunChatReplyFailureFixtureCode);
}

function localDateKey(now: number) {
  const date = new Date(now);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

const SHARE_RESPONSE_REJECTION_CODES = new Set<BaiyunShareResponseRejectionCode>([
  'model_omitted',
  'invalid_shape',
  'unknown_share',
  'duplicate_share',
  'direct_target_conflict',
  'low_confidence',
  'invalid_evidence',
]);
const LOCAL_SHARE_MATCH_KINDS = new Set<BaiyunLocalShareMatchKind>([
  'direct_concrete',
  'direct_generic',
  'concrete_content',
  'generic_all',
  'generic_latest',
]);
const LOCAL_SHARE_MATCH_SKIP_REASONS = new Set<BaiyunLocalShareMatchSkipReason>([
  'not_seen_or_deferred',
  'no_content_anchor',
]);
const SIGNAL_REJECTION_CODES = new Set<BaiyunSemanticSignalRejectionCode>([
  'invalid_shape',
  'invalid_kind',
  'invalid_confidence',
  'invalid_evidence',
  'invalid_temporality',
  'invalid_boundary_target',
  'overflow',
  'extra_fields_ignored',
  'normal_target_normalized',
  'required_signal_missing',
  'ordinary_chat_invalid',
  'ordinary_with_action_signal',
]);
const CONTINUITY_REJECTION_CODES = new Set<BaiyunContinuityResolutionRejectionCode>([
  'model_omitted',
  'invalid_shape',
  'unknown_event',
  'duplicate_event',
  'invalid_confidence',
  'invalid_evidence',
]);

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

export function normalizeChatPreparationCheckpoints(value: unknown): ChatDiagnosticContext['preparationCheckpoints'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  const checkpoints: NonNullable<ChatDiagnosticContext['preparationCheckpoints']> = {};
  for (const key of ['youPersistedAt', 'sleepAcceptedAt', 'replyQueuedAt', 'runReplyEnteredAt',
    'sourceReadyAt', 'contextStartedAt', 'contextReadyAt', 'providerEnteredAt', 'envelopeReadyAt',
    'preflightReadyAt', 'replyReadyAt'] as const) {
    const at = nonnegativeNumber(candidate[key]);
    if (at !== undefined) checkpoints[key] = at;
  }
  return Object.keys(checkpoints).length ? checkpoints : undefined;
}

export function normalizeChatProviderPreparation(value: unknown): ChatDiagnosticContext['providerPreparation'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { requestOrdinal, checkpoint, at } = value as Record<string, unknown>;
  if (typeof requestOrdinal !== 'number' || !Number.isSafeInteger(requestOrdinal) || requestOrdinal <= 0
    || typeof at !== 'number' || !Number.isFinite(at) || at <= 0
    || checkpoint !== 'providerEnteredAt' && checkpoint !== 'envelopeReadyAt' && checkpoint !== 'preflightReadyAt') return undefined;
  return { requestOrdinal, checkpoint, at };
}

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,100}$/.test(value) ? value : undefined;
}

function normalizeRootFailure(value: unknown): BaiyunFixedEnvelopeRootFailure | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (entry.kind === 'non_object_root' && ['array', 'null', 'string', 'number', 'boolean'].includes(entry.rootType as string)) {
    return { kind: 'non_object_root', rootType: entry.rootType as 'array' | 'null' | 'string' | 'number' | 'boolean' };
  }
  if (entry.kind !== 'json_parse_error') return undefined;
  const result: BaiyunFixedEnvelopeRootFailure = { kind: 'json_parse_error' };
  if (['unexpected_end', 'unexpected_token', 'expected_property_name', 'expected_delimiter',
    'unterminated_string', 'invalid_escape', 'trailing_content'].includes(entry.parseIssue as string)) {
    result.parseIssue = entry.parseIssue as BaiyunFixedEnvelopeJsonParseIssue;
  }
  for (const key of ['position', 'line', 'column'] as const) {
    const number = entry[key];
    if (typeof number === 'number' && Number.isSafeInteger(number) && number >= (key === 'position' ? 0 : 1)) {
      result[key] = number;
    }
  }
  return result;
}

export function normalizeChatToolProtocolFailure(value: unknown): ChatDiagnosticContext['toolProtocolFailure'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (!['DUPLICATE_CALL_ID', 'FINISH_REASON_MISMATCH', 'INVALID_TOOL_CALL_BATCH', 'INVALID_REPLY_FORMAT',
    'MISSING_CALL_ID', 'MODEL_REQUEST_LIMIT', 'TOOL_NOT_ALLOWED', 'REMINDER_DRAFT_INCOMPLETE'].includes(candidate.code as string)
    || nonnegativeNumber(candidate.rawToolCallCount) === undefined) return undefined;
  const errorCodes = ['DUPLICATE_CALL_ID', 'INVALID_ARGUMENTS', 'INVALID_TOOL_CALL', 'MISSING_CALL_ID', 'TOOL_NOT_ALLOWED', 'UNKNOWN_TOOL'];
  const reminderIssues = ['inspection_not_applicable', 'semantic_envelope_absent', 'root_invalid',
    'messages_not_first', 'unexpected_root_keys', 'messages_invalid', 'action_missing', 'action_invalid'];
  const missingReminderContract = candidate.code === 'INVALID_REPLY_FORMAT'
    && candidate.replyFormatReason === 'reminder_action_contract_missing' && candidate.rawToolCallCount === 0;
  const rootFailure = missingReminderContract && candidate.reminderActionIssue === 'root_invalid'
    ? normalizeRootFailure(candidate.reminderActionRootFailure) : undefined;
  const directRootFailure = missingReminderContract && candidate.reminderActionDirectIssue === 'root_invalid'
    ? normalizeRootFailure(candidate.reminderActionDirectRootFailure) : undefined;
  return {
    code: candidate.code as string,
    callErrors: Array.isArray(candidate.callErrors) ? candidate.callErrors.flatMap(error =>
      error && typeof error === 'object' && errorCodes.includes(error.errorCode)
        ? [{ errorCode: error.errorCode as string }] : []) : [],
    finishReason: ['stop', 'tool_calls', 'length', 'max_tokens', 'content_filter', 'function_call'].includes(candidate.finishReason as string)
      ? candidate.finishReason as string : undefined,
    rawToolCallCount: candidate.rawToolCallCount as number,
    ...(candidate.code === 'INVALID_REPLY_FORMAT' && ['textual_tool_protocol', 'reminder_action_contract_missing',
      'reminder_source_mismatch', 'reminder_choice_invalid'].includes(candidate.replyFormatReason as string)
      ? { replyFormatReason: candidate.replyFormatReason as NonNullable<ChatDiagnosticContext['toolProtocolFailure']>['replyFormatReason'] }
      : {}),
    ...(missingReminderContract && reminderIssues.includes(candidate.reminderActionIssue as string)
      ? { reminderActionIssue: candidate.reminderActionIssue as JunLuoReminderActionIssue } : {}),
    ...(missingReminderContract && [...reminderIssues, 'valid'].includes(candidate.reminderActionDirectIssue as string)
      ? { reminderActionDirectIssue: candidate.reminderActionDirectIssue as JunLuoReminderActionIssue | 'valid' } : {}),
    ...(missingReminderContract && ['direct_content', 'reasoning_marked_visible'].includes(candidate.reminderVisibleReplySource as string)
      ? { reminderVisibleReplySource: candidate.reminderVisibleReplySource as 'direct_content' | 'reasoning_marked_visible' } : {}),
    ...(rootFailure ? { reminderActionRootFailure: rootFailure } : {}),
    ...(directRootFailure ? { reminderActionDirectRootFailure: directRootFailure } : {}),
  };
}

export function normalizeChatMemoryPreparation(value: unknown): MemoryRecallPreparationDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as MemoryRecallPreparationDiagnostic;
  const statuses = ['ready', 'not_started', 'failed', 'timeout'];
  if (!statuses.includes(candidate.status)) return undefined;
  const startedAt = nonnegativeNumber(candidate.startedAt);
  const finishedAt = nonnegativeNumber(candidate.finishedAt);
  if (startedAt === undefined || finishedAt === undefined) return undefined;
  const reasons = ['empty_query', 'configuration_missing', 'cancelled', 'timeout', 'http_error', 'parse_error',
    'network_error', 'index_unavailable', 'configuration_changed', 'read_failed', 'deadline_exceeded',
    'background_only', 'route_unavailable', 'route_fallback', 'database_busy', 'response_payload_invalid', 'response_empty',
    'response_reasoning_only', 'response_truncated', 'route_json_missing', 'route_json_invalid', 'route_shape_invalid',
    'post_database_busy', 'post_read_failed', 'focus_database_busy', 'focus_read_failed',
    'shiying_source_unavailable', 'shiying_read_failed'];
  const reason = (input: unknown) => typeof input === 'string' && reasons.includes(input) ? input : undefined;
  const stage = (input: unknown): MemoryRecallStageDiagnostic => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { status: 'not_started' };
    const item = input as MemoryRecallStageDiagnostic;
    const work: NonNullable<MemoryRecallStageDiagnostic['work']> = {};
    for (const phase of MEMORY_RECALL_WORK_PHASES) {
      const measurement = item.work?.[phase];
      if (!measurement || typeof measurement !== 'object') continue;
      const elapsedMs = nonnegativeNumber(measurement.elapsedMs);
      const count = nonnegativeNumber(measurement.count), active = nonnegativeNumber(measurement.active);
      if (elapsedMs !== undefined && count !== undefined && active !== undefined) {
        const httpStatus = measurement.httpStatus;
        work[phase] = { elapsedMs, count: Math.trunc(count), active: Math.min(Math.trunc(active), Math.trunc(count)),
          ...(phase === 'embedding_http' && Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599
            ? { httpStatus } : {}) };
      }
    }
    return {
      status: [...statuses, 'cancelled'].includes(item.status) ? item.status : 'not_started',
      reason: reason(item.reason), startedAt: nonnegativeNumber(item.startedAt), finishedAt: nonnegativeNumber(item.finishedAt),
      ...(Object.keys(work).length ? { work } : {}),
    };
  };
  return { status: candidate.status, reason: reason(candidate.reason), startedAt, finishedAt,
    route: stage(candidate.route), local: stage(candidate.local), semantic: stage(candidate.semantic) };
}

function normalizeDiagnosticContext(candidate: ChatDiagnosticContext): ChatDiagnosticContext {
  return {
    replyPurpose: ['ordinary', 'day_plan_adjustment', 'day_plan_receipt'].includes(candidate.replyPurpose ?? '')
      ? candidate.replyPurpose : undefined,
    toolProtocolFailure: normalizeChatToolProtocolFailure(candidate.toolProtocolFailure),
    deliveryKind: candidate.deliveryKind === 'text' || candidate.deliveryKind === 'tool_card' ? candidate.deliveryKind : undefined,
    turnAttemptId: typeof candidate.turnAttemptId === 'string' ? candidate.turnAttemptId : undefined,
    sessionId: typeof candidate.sessionId === 'string' ? candidate.sessionId : undefined,
    sourceMessageId: typeof candidate.sourceMessageId === 'string' ? candidate.sourceMessageId : undefined,
    startedAt: nonnegativeNumber(candidate.startedAt), finishedAt: nonnegativeNumber(candidate.finishedAt),
    sendStartedAt: nonnegativeNumber(candidate.sendStartedAt),
    firstBubbleCommittedAt: nonnegativeNumber(candidate.firstBubbleCommittedAt),
    preparationCheckpoints: normalizeChatPreparationCheckpoints(candidate.preparationCheckpoints),
    providerPreparation: normalizeChatProviderPreparation(candidate.providerPreparation),
    memoryPreparation: normalizeChatMemoryPreparation(candidate.memoryPreparation),
    connectionId: typeof candidate.connectionId === 'string' ? candidate.connectionId : undefined,
    connectionName: typeof candidate.connectionName === 'string' ? candidate.connectionName : undefined,
    model: typeof candidate.model === 'string' ? candidate.model : undefined,
    auxiliaryFailures: Array.isArray(candidate.auxiliaryFailures) ? candidate.auxiliaryFailures.filter(event => event
      && diagnosticCode(event.phase) && diagnosticCode(event.stage) && nonnegativeNumber(event.at) !== undefined)
      .map(event => ({ phase: event.phase, stage: event.stage, step: diagnosticCode(event.step), at: event.at,
        ...normalizeChatAuxiliaryFailureDetails(event) })) : undefined,
    toolEvents: Array.isArray(candidate.toolEvents) ? candidate.toolEvents.filter(event => event
      && (event.kind === 'package' || event.kind === 'execution') && typeof event.name === 'string'
      && typeof event.status === 'string' && nonnegativeNumber(event.at) !== undefined).map(event => ({
      kind: event.kind, name: event.name.slice(0, 160), status: diagnosticCode(event.status) ?? 'unknown',
      callId: typeof event.callId === 'string' ? event.callId : undefined,
      at: event.at, modelAttemptOrdinal: nonnegativeNumber(event.modelAttemptOrdinal),
    })) : undefined,
  };
}

function normalizeModelAttemptDiagnostic(
  value: unknown,
): BaiyunChatModelAttemptDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunChatModelAttemptDiagnostic>;
  if (
    typeof candidate.attemptOrdinal !== 'number'
    || !Number.isFinite(candidate.attemptOrdinal)
    || candidate.attemptOrdinal < 1
    || (candidate.mode !== 'full' && candidate.mode !== 'messages_only')
  ) return undefined;
  return {
    attemptOrdinal: Math.max(1, Math.round(candidate.attemptOrdinal)),
    mode: candidate.mode,
    requestType: candidate.requestType === 'initial' || candidate.requestType === 'retry' || candidate.requestType === 'continuation'
      ? candidate.requestType
      : undefined,
    retryKind: candidate.retryKind === 'tool_fact_correction' || candidate.retryKind === 'quality_retry' || candidate.retryKind === 'protocol_correction'
      ? candidate.retryKind
      : undefined,
    transportOutcome: ['started', 'response_received', 'http_error', 'network_error', 'timeout', 'aborted'].includes(candidate.transportOutcome ?? '')
      ? candidate.transportOutcome : undefined,
    httpStatus: typeof candidate.httpStatus === 'number' && Number.isFinite(candidate.httpStatus)
      ? candidate.httpStatus : undefined,
    directContentChars: nonnegativeNumber(candidate.directContentChars),
    reasoningContentChars: nonnegativeNumber(candidate.reasoningContentChars),
    finishReason: typeof candidate.finishReason === 'string'
      ? candidate.finishReason.slice(0, 80)
      : undefined,
    usagePresent: typeof candidate.usagePresent === 'boolean' ? candidate.usagePresent : undefined,
    toolCallCount: nonnegativeNumber(candidate.toolCallCount),
    offeredToolCount: nonnegativeNumber(candidate.offeredToolCount),
    toolCapabilitySource: ['official_profile', 'verified_probe', 'disabled_default', 'protocol_default'].includes(candidate.toolCapabilitySource ?? '')
      ? candidate.toolCapabilitySource : undefined,
    technicalCode: candidate.technicalCode === 'provider_empty_success'
      ? candidate.technicalCode
      : undefined,
    responseObserved: typeof candidate.responseObserved === 'boolean' ? candidate.responseObserved : undefined,
    startedAt: nonnegativeNumber(candidate.startedAt),
    headersReceivedAt: nonnegativeNumber(candidate.headersReceivedAt),
    transportKind: candidate.transportKind === 'fetch' || candidate.transportKind === 'xhr' ? candidate.transportKind : undefined,
    responseAvailableAt: nonnegativeNumber(candidate.responseAvailableAt),
    bodyReadStartedAt: nonnegativeNumber(candidate.bodyReadStartedAt),
    timeoutMs: nonnegativeNumber(candidate.timeoutMs),
    errorName: normalizeChatTransportErrorName(candidate.errorName),
    errorCode: normalizeChatTransportErrorCode(candidate.errorCode),
    causeCode: normalizeChatTransportErrorCode(candidate.causeCode),
    externalAborted: typeof candidate.externalAborted === 'boolean' ? candidate.externalAborted : undefined,
    providerRequestId: normalizeChatProviderRequestId(candidate.providerRequestId),
    providerHost: normalizeChatProviderHost(candidate.providerHost),
    firstContentAt: nonnegativeNumber(candidate.firstContentAt),
    responseCompletedAt: nonnegativeNumber(candidate.responseCompletedAt),
    finishedAt: nonnegativeNumber(candidate.finishedAt),
    responseChars: nonnegativeNumber(candidate.responseChars),
    bodyParseFailure: candidate.bodyParseFailure === 'invalid_json' || candidate.bodyParseFailure === 'body_read_failed' || candidate.bodyParseFailure === 'invalid_payload'
      ? candidate.bodyParseFailure : undefined,
    stopCause: candidate.stopCause === 'timeout' || candidate.stopCause === 'aborted' ? candidate.stopCause : undefined,
    providerErrorCode: diagnosticCode(candidate.providerErrorCode),
    usage: candidate.usage && typeof candidate.usage === 'object' ? {
      promptTokens: nonnegativeNumber(candidate.usage.promptTokens),
      completionTokens: nonnegativeNumber(candidate.usage.completionTokens),
      totalTokens: nonnegativeNumber(candidate.usage.totalTokens),
      cachedPromptTokens: nonnegativeNumber(candidate.usage.cachedPromptTokens),
    } : undefined,
    requestPurpose: ['package_discovery', 'concrete_tools', 'final'].includes(candidate.requestPurpose ?? '')
      ? candidate.requestPurpose : undefined,
    retryReason: ['empty_response', 'visible_envelope_invalid', 'tool_fact_correction', 'protocol_correction'].includes(candidate.retryReason ?? '')
      ? candidate.retryReason : undefined,
    failureCode: isChatReplyFailureCode(candidate.failureCode) ? candidate.failureCode : undefined,
    toolGroundingReasons: Array.isArray(candidate.toolGroundingReasons)
      ? candidate.toolGroundingReasons.filter((reason): reason is string => typeof reason === 'string' && reason.length > 0)
        .slice(0, 64).map(reason => reason.slice(0, 128))
      : undefined,
  };
}

function normalizeModelAttemptDiagnostics(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  const entries = value
    .map(normalizeModelAttemptDiagnostic)
    .filter((entry): entry is BaiyunChatModelAttemptDiagnostic => Boolean(entry));
  return entries.length ? entries : undefined;
}

export function appendBaiyunChatModelAttemptDiagnostic(
  target: BaiyunChatModelAttemptDiagnostic[],
  value: unknown,
) {
  const entry = normalizeModelAttemptDiagnostic(value);
  if (!entry) return undefined;
  target.push(entry);
  return entry;
}
function normalizeSignalDiagnostic(value: unknown): BaiyunSemanticSignalDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunSemanticSignalDiagnostic>;
  const numericKeys = [
    'returnedCount', 'acceptedCount', 'discardedCount', 'normalizedCount', 'overflowCount',
  ] as const;
  if (
    numericKeys.some((key) => typeof candidate[key] !== 'number' || !Number.isFinite(candidate[key]))
    || !Array.isArray(candidate.rejectionCodes)
  ) return undefined;
  return {
    returnedCount: Math.max(0, Math.round(candidate.returnedCount!)),
    acceptedCount: Math.max(0, Math.round(candidate.acceptedCount!)),
    discardedCount: Math.max(0, Math.round(candidate.discardedCount!)),
    normalizedCount: Math.max(0, Math.round(candidate.normalizedCount!)),
    overflowCount: Math.max(0, Math.round(candidate.overflowCount!)),
    rejectionCodes: [...new Set(candidate.rejectionCodes.filter(
      (code): code is BaiyunSemanticSignalRejectionCode => (
        typeof code === 'string' && SIGNAL_REJECTION_CODES.has(code as BaiyunSemanticSignalRejectionCode)
      ),
    ))],
  };
}

function normalizeContinuityResolutionDiagnostic(
  value: unknown,
): BaiyunContinuityResolutionDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunContinuityResolutionDiagnostic>;
  if (
    typeof candidate.pendingCount !== 'number'
    || !Number.isFinite(candidate.pendingCount)
    || typeof candidate.returnedCount !== 'number'
    || !Number.isFinite(candidate.returnedCount)
    || typeof candidate.acceptedCount !== 'number'
    || !Number.isFinite(candidate.acceptedCount)
    || !Array.isArray(candidate.rejectionCodes)
  ) return undefined;
  return {
    pendingCount: Math.max(0, Math.round(candidate.pendingCount)),
    returnedCount: Math.max(0, Math.round(candidate.returnedCount)),
    acceptedCount: Math.max(0, Math.round(candidate.acceptedCount)),
    rejectionCodes: [...new Set(candidate.rejectionCodes.filter(
      (code): code is BaiyunContinuityResolutionRejectionCode => (
        typeof code === 'string'
        && CONTINUITY_REJECTION_CODES.has(code as BaiyunContinuityResolutionRejectionCode)
      ),
    ))],
  };
}

function normalizeShareResponseDiagnostic(value: unknown): BaiyunShareResponseDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunShareResponseDiagnostic>;
  if (
    typeof candidate.pendingCount !== 'number'
    || !Number.isFinite(candidate.pendingCount)
    || typeof candidate.directReplyTargeted !== 'boolean'
    || typeof candidate.returnedCount !== 'number'
    || !Number.isFinite(candidate.returnedCount)
    || typeof candidate.acceptedCount !== 'number'
    || !Number.isFinite(candidate.acceptedCount)
    || !Array.isArray(candidate.rejectionCodes)
  ) return undefined;
  return {
    pendingCount: Math.max(0, Math.round(candidate.pendingCount)),
    directReplyTargeted: candidate.directReplyTargeted,
    returnedCount: Math.max(0, Math.round(candidate.returnedCount)),
    acceptedCount: Math.max(0, Math.round(candidate.acceptedCount)),
    rejectionCodes: [...new Set(candidate.rejectionCodes.filter(
      (code): code is BaiyunShareResponseRejectionCode => (
        typeof code === 'string'
        && SHARE_RESPONSE_REJECTION_CODES.has(code as BaiyunShareResponseRejectionCode)
      ),
    ))],
    localAcceptedCount: typeof candidate.localAcceptedCount === 'number'
      && Number.isFinite(candidate.localAcceptedCount)
      ? Math.max(0, Math.round(candidate.localAcceptedCount))
      : undefined,
    localMatchKind: typeof candidate.localMatchKind === 'string'
      && LOCAL_SHARE_MATCH_KINDS.has(candidate.localMatchKind as BaiyunLocalShareMatchKind)
      ? candidate.localMatchKind as BaiyunLocalShareMatchKind
      : undefined,
    localSkippedReason: typeof candidate.localSkippedReason === 'string'
      && LOCAL_SHARE_MATCH_SKIP_REASONS.has(
        candidate.localSkippedReason as BaiyunLocalShareMatchSkipReason,
      )
      ? candidate.localSkippedReason as BaiyunLocalShareMatchSkipReason
      : undefined,
  };
}

function normalizeEntry(value: unknown): BaiyunChatSemanticDiagnosticEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunChatSemanticDiagnosticEntry>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.attemptedAt !== 'number'
    || !Number.isFinite(candidate.attemptedAt)
    || typeof candidate.status !== 'string'
    || !['valid', 'partial', 'semantic_unresolved', 'messages_invalid'].includes(candidate.status)
    || typeof candidate.connectionId !== 'string'
    || typeof candidate.connectionName !== 'string'
    || typeof candidate.model !== 'string'
  ) {
    return undefined;
  }
  return {
    id: candidate.id,
    ...normalizeDiagnosticContext(candidate),
    attemptedAt: candidate.attemptedAt,
    localDate: typeof candidate.localDate === 'string'
      ? candidate.localDate
      : localDateKey(candidate.attemptedAt),
    status: candidate.status as BaiyunChatSemanticDiagnosticStatus,
    basketStatuses: candidate.basketStatuses
      && (candidate.basketStatuses.wishDiscussion !== undefined
        ? ['messages', 'wishDiscussion', 'innerReaction', 'memoryMentions']
        : ['messages', 'careUpdates', 'shareResponses', 'innerReaction']).every((field) => (
        ['valid', 'missing', 'malformed', 'unavailable'].includes(
          candidate.basketStatuses![field as keyof NonNullable<BaiyunChatSemanticDiagnosticEntry['basketStatuses']>] ?? '',
        )
      ))
      ? candidate.basketStatuses.wishDiscussion !== undefined ? {
          messages: candidate.basketStatuses.messages, wishDiscussion: candidate.basketStatuses.wishDiscussion,
          innerReaction: candidate.basketStatuses.innerReaction, memoryMentions: candidate.basketStatuses.memoryMentions,
        } : {
          messages: candidate.basketStatuses.messages,
          careUpdates: candidate.basketStatuses.careUpdates,
          shareResponses: candidate.basketStatuses.shareResponses,
          innerReaction: candidate.basketStatuses.innerReaction,
        }
      : undefined,
    actionDisposition: typeof candidate.actionDisposition === 'string'
      && ['actionable', 'ordinary_no_action', 'unresolved'].includes(candidate.actionDisposition)
      ? candidate.actionDisposition as BaiyunChatActionDisposition
      : undefined,
    reason: typeof candidate.reason === 'string' ? candidate.reason : undefined,
    signalKinds: Array.isArray(candidate.signalKinds)
      ? candidate.signalKinds.filter(
          (entry): entry is BaiyunSemanticSignalKind | BaiyunActionIntentId => typeof entry === 'string',
        )
      : [],
    connectionId: candidate.connectionId,
    connectionName: candidate.connectionName,
    model: candidate.model,
    promptTokens: typeof candidate.promptTokens === 'number' ? candidate.promptTokens : undefined,
    completionTokens: typeof candidate.completionTokens === 'number' ? candidate.completionTokens : undefined,
    totalTokens: typeof candidate.totalTokens === 'number' ? candidate.totalTokens : undefined,
    cachedPromptTokens: typeof candidate.cachedPromptTokens === 'number'
      ? candidate.cachedPromptTokens
      : undefined,
    modelRequestCount: typeof candidate.modelRequestCount === 'number'
      ? Math.max(0, Math.round(candidate.modelRequestCount))
      : undefined,
    replyPersisted: typeof candidate.replyPersisted === 'boolean' ? candidate.replyPersisted : undefined,
    replyPersistAttempts: typeof candidate.replyPersistAttempts === 'number' && Number.isFinite(candidate.replyPersistAttempts)
      ? Math.max(0, Math.round(candidate.replyPersistAttempts)) : undefined,
    insertedMessageCount: typeof candidate.insertedMessageCount === 'number' && Number.isFinite(candidate.insertedMessageCount)
      ? Math.max(0, Math.round(candidate.insertedMessageCount)) : undefined,
    finishReason: typeof candidate.finishReason === 'string' ? candidate.finishReason : undefined,
    jsonOutputRequested: typeof candidate.jsonOutputRequested === 'boolean'
      ? candidate.jsonOutputRequested
      : undefined,
    rawContentFormat: typeof candidate.rawContentFormat === 'string'
      && ['empty', 'json_object', 'json_value', 'fenced_content', 'tagged_content', 'non_json'].includes(candidate.rawContentFormat)
      ? candidate.rawContentFormat as BaiyunChatSemanticDiagnosticEntry['rawContentFormat']
      : undefined,
    rawContentChars: typeof candidate.rawContentChars === 'number'
      ? Math.max(0, Math.round(candidate.rawContentChars))
      : undefined,
    reasoningContentChars: typeof candidate.reasoningContentChars === 'number'
      ? Math.max(0, Math.round(candidate.reasoningContentChars))
      : undefined,
    recoveredFromReasoning: typeof candidate.recoveredFromReasoning === 'boolean'
      ? candidate.recoveredFromReasoning
      : undefined,
    responseEnvelopeMode: candidate.responseEnvelopeMode === 'messages_only'
      || candidate.responseEnvelopeMode === 'messages_with_semantic'
      ? candidate.responseEnvelopeMode
      : undefined,
    semanticPrefixCompletionRequested: typeof candidate.semanticPrefixCompletionRequested === 'boolean'
      ? candidate.semanticPrefixCompletionRequested
      : undefined,
    usagePresent: typeof candidate.usagePresent === 'boolean' ? candidate.usagePresent : undefined,
    visibleReplyFailureReason: typeof candidate.visibleReplyFailureReason === 'string'
      && [
        'no_safe_visible_candidate',
        'hidden_state_only',
        'messages_empty',
        'messages_malformed',
      ].includes(candidate.visibleReplyFailureReason)
      ? candidate.visibleReplyFailureReason as VisibleReplyFailureReason
      : undefined,
    visibleReplySource: candidate.visibleReplySource === 'direct_content'
      || candidate.visibleReplySource === 'reasoning_marked_visible'
      ? candidate.visibleReplySource
      : undefined,
    visibleReplyStatus: typeof candidate.visibleReplyStatus === 'string'
      && ['visible', 'model_empty', 'structure_invalid'].includes(candidate.visibleReplyStatus)
      ? candidate.visibleReplyStatus as VisibleReplyStatus
      : undefined,
    semanticOutputEstimatedTokens: typeof candidate.semanticOutputEstimatedTokens === 'number'
      ? Math.max(0, Math.round(candidate.semanticOutputEstimatedTokens))
      : 0,
    shareResponseDiagnostic: normalizeShareResponseDiagnostic(candidate.shareResponseDiagnostic),
    signalDiagnostic: normalizeSignalDiagnostic(candidate.signalDiagnostic),
    continuityResolutionDiagnostic: normalizeContinuityResolutionDiagnostic(
      candidate.continuityResolutionDiagnostic,
    ),
    modelAttempts: normalizeModelAttemptDiagnostics(candidate.modelAttempts),
  };
}

function normalizeReplyFailureEntry(
  value: unknown,
): BaiyunChatReplyFailureDiagnosticEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<BaiyunChatReplyFailureDiagnosticEntry>;
  if (
    typeof candidate.id !== 'string'
    || typeof candidate.attemptedAt !== 'number'
    || !Number.isFinite(candidate.attemptedAt)
    || !isChatReplyFailureCode(candidate.code)
    || !isChatReplyFailureStage(candidate.stage)
  ) {
    return undefined;
  }
  const secondaryStages = Array.isArray(candidate.secondaryStages)
    ? [...new Set(candidate.secondaryStages.filter(isChatReplyFailureStage))]
      .filter((stage) => stage !== candidate.stage)
    : undefined;
  return {
    id: candidate.id,
    ...normalizeDiagnosticContext(candidate),
    attemptedAt: candidate.attemptedAt,
    localDate: typeof candidate.localDate === 'string'
      ? candidate.localDate
      : localDateKey(candidate.attemptedAt),
    code: candidate.code,
    stage: candidate.stage,
    secondaryStages: secondaryStages?.length ? secondaryStages : undefined,
    technicalReasonCode: isChatReplyTechnicalReasonCode(candidate.technicalReasonCode) ? candidate.technicalReasonCode : undefined,
    modelAttempts: normalizeModelAttemptDiagnostics(candidate.modelAttempts),
    modelRequestCount: typeof candidate.modelRequestCount === 'number' && Number.isFinite(candidate.modelRequestCount)
      ? Math.max(0, Math.round(candidate.modelRequestCount)) : undefined,
    replyPersisted: typeof candidate.replyPersisted === 'boolean' ? candidate.replyPersisted : undefined,
    replyPersistAttempts: typeof candidate.replyPersistAttempts === 'number' && Number.isFinite(candidate.replyPersistAttempts)
      ? Math.max(0, Math.round(candidate.replyPersistAttempts)) : undefined,
  };
}

export async function loadBaiyunChatSemanticDiagnostics(options?: { strict?: boolean }): Promise<BaiyunChatSemanticDiagnostics> {
  const raw = await AsyncStorage.getItem(CHAT_SEMANTIC_DIAGNOSTICS_KEY);
  if (raw === null || (!options?.strict && !raw)) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (options?.strict && (!parsed || !Array.isArray(parsed.entries))) throw new Error('invalid-chat-semantic-diagnostics');
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(normalizeEntry).filter((entry): entry is BaiyunChatSemanticDiagnosticEntry => Boolean(entry))
      : [];
    return { entries: entries.slice(-MAX_DIAGNOSTIC_ENTRIES) };
  } catch (error) {
    if (options?.strict) throw error;
    return { entries: [] };
  }
}

export async function loadBaiyunChatReplyFailureDiagnostics(options?: { strict?: boolean }): Promise<
  BaiyunChatReplyFailureDiagnostics
> {
  const raw = await AsyncStorage.getItem(CHAT_REPLY_FAILURE_DIAGNOSTICS_KEY);
  if (raw === null || (!options?.strict && !raw)) return { entries: [] };
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (options?.strict && (!parsed || !Array.isArray(parsed.entries))) throw new Error('invalid-chat-reply-failure-diagnostics');
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries
        .map(normalizeReplyFailureEntry)
        .filter((entry): entry is BaiyunChatReplyFailureDiagnosticEntry => Boolean(entry))
      : [];
    return { entries: entries.slice(-MAX_DIAGNOSTIC_ENTRIES) };
  } catch (error) {
    if (options?.strict) throw error;
    return { entries: [] };
  }
}

export async function saveBaiyunChatReplyFailureFixture(
  code: BaiyunChatReplyFailureFixtureCode | null,
) {
  if (!isDevelopmentRuntime()) return;
  if (code === null) {
    await AsyncStorage.removeItem(CHAT_REPLY_FAILURE_FIXTURE_KEY);
    return;
  }
  await AsyncStorage.setItem(CHAT_REPLY_FAILURE_FIXTURE_KEY, code);
}

export async function consumeBaiyunChatReplyFailureFixture(): Promise<
  BaiyunChatReplyFailureFixtureCode | null
> {
  if (!isDevelopmentRuntime()) return null;
  const code = await AsyncStorage.getItem(CHAT_REPLY_FAILURE_FIXTURE_KEY);
  if (!isChatReplyFailureFixtureCode(code)) return null;
  await AsyncStorage.removeItem(CHAT_REPLY_FAILURE_FIXTURE_KEY);
  return code;
}

let diagnosticsMutationQueue: Promise<unknown> = Promise.resolve();
let replyFailureDiagnosticsMutationQueue: Promise<unknown> = Promise.resolve();

export async function recordBaiyunChatSemanticDiagnostic(
  input: Omit<BaiyunChatSemanticDiagnosticEntry, 'id' | 'localDate'>,
) {
  let resolveResult: (entry: BaiyunChatSemanticDiagnosticEntry) => void;
  let rejectResult: (reason: unknown) => void;
  const result = new Promise<BaiyunChatSemanticDiagnosticEntry>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  diagnosticsMutationQueue = diagnosticsMutationQueue.catch(() => undefined).then(async () => {
    try {
      const current = await loadBaiyunChatSemanticDiagnostics();
      const previous = input.turnAttemptId ? current.entries.find(entry => entry.turnAttemptId === input.turnAttemptId) : undefined;
      const entry: BaiyunChatSemanticDiagnosticEntry = {
        ...input,
        ...normalizeDiagnosticContext(input),
        connectionId: input.connectionId, connectionName: input.connectionName, model: input.model,
        modelAttempts: normalizeModelAttemptDiagnostics(input.modelAttempts),
        id: previous?.id ?? `chat-semantic-${input.attemptedAt}-${Math.random().toString(36).slice(2, 8)}`,
        localDate: localDateKey(input.attemptedAt),
      };
      const next = [...current.entries.filter(item => item.id !== previous?.id), entry].slice(-MAX_DIAGNOSTIC_ENTRIES);
      await AsyncStorage.setItem(
        CHAT_SEMANTIC_DIAGNOSTICS_KEY,
        JSON.stringify({ entries: next }),
      );
      resolveResult(entry);
    } catch (error) {
      rejectResult(error);
    }
  });
  return result;
}

export async function recordBaiyunChatReplyFailureDiagnostic(
  input: Omit<BaiyunChatReplyFailureDiagnosticEntry, 'id' | 'localDate'>,
) {
  let resolveResult: (entry: BaiyunChatReplyFailureDiagnosticEntry) => void;
  let rejectResult: (reason: unknown) => void;
  const result = new Promise<BaiyunChatReplyFailureDiagnosticEntry>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  replyFailureDiagnosticsMutationQueue = replyFailureDiagnosticsMutationQueue
    .catch(() => undefined)
    .then(async () => {
      try {
        const current = await loadBaiyunChatReplyFailureDiagnostics();
        const previous = input.turnAttemptId ? current.entries.find(entry => entry.turnAttemptId === input.turnAttemptId) : undefined;
        const entry: BaiyunChatReplyFailureDiagnosticEntry = {
          ...input,
          ...normalizeDiagnosticContext(input),
          technicalReasonCode: isChatReplyTechnicalReasonCode(input.technicalReasonCode) ? input.technicalReasonCode : undefined,
          modelAttempts: normalizeModelAttemptDiagnostics(input.modelAttempts),
          id: previous?.id ?? `chat-reply-failure-${input.attemptedAt}-${Math.random().toString(36).slice(2, 8)}`,
          localDate: localDateKey(input.attemptedAt),
        };
        const next = [...current.entries.filter(item => item.id !== previous?.id), entry].slice(-MAX_DIAGNOSTIC_ENTRIES);
        await AsyncStorage.setItem(
          CHAT_REPLY_FAILURE_DIAGNOSTICS_KEY,
          JSON.stringify({ entries: next }),
        );
        resolveResult(entry);
      } catch (error) {
        rejectResult(error);
      }
    });
  return result;
}
