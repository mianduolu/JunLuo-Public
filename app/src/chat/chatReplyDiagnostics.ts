import type { ChatReplyDiagnostics, ChatTransportAttemptEvent } from '../ai/openAiCompatibleProvider';
import type {
  BaiyunChatModelAttemptDiagnostic, BaiyunChatReplyFailureDiagnosticEntry, BaiyunChatToolDiagnosticEvent,
} from '../ai/behavior/actionChatSemanticStore';
import type { ChatReplyFailureClassification, ChatReplyFailureCode } from './chatReplyFailure';
import type { MemoryRecallPreparationDiagnostic } from '../memory/memoryChatPreparation';
import { normalizeChatMemoryPreparation, normalizeChatPreparationCheckpoints, normalizeChatProviderPreparation, normalizeChatToolProtocolFailure } from '../ai/behavior/actionChatSemanticStore';

export type ChatSendAction = {
  messageId: string;
  startedAt: number;
  youPersistedAt?: number;
  sleepAcceptedAt?: number;
  replyQueuedAt?: number;
};

// This collector observes one reply attempt. It never controls retries or saves chat content.
export function createChatReplyDiagnosticCollector(context: {
  sessionId: string; sourceMessageId: string; connectionId: string; connectionName: string; model: string;
  replyPurpose?: 'ordinary' | 'day_plan_adjustment' | 'day_plan_receipt';
}, now = Date.now) {
  const startedAt = now();
  const turnAttemptId = `reply-${startedAt}-${Math.random().toString(36).slice(2, 10)}`;
  const attempts: BaiyunChatModelAttemptDiagnostic[] = [];
  const toolEvents: BaiyunChatToolDiagnosticEvent[] = [];
  const auxiliaryFailures: NonNullable<BaiyunChatReplyFailureDiagnosticEntry['auxiliaryFailures']> = [];
  let toolProtocolFailure: BaiyunChatReplyFailureDiagnosticEntry['toolProtocolFailure'];
  const observeToolProtocolFailure = (value: unknown) => {
    toolProtocolFailure = normalizeChatToolProtocolFailure(value);
  };
  let sendStartedAt: number | undefined;
  let firstBubbleCommittedAt: number | undefined;
  const preparationCheckpoints: NonNullable<BaiyunChatReplyFailureDiagnosticEntry['preparationCheckpoints']> = {};
  let providerPreparation: BaiyunChatReplyFailureDiagnosticEntry['providerPreparation'];
  let memoryPreparation: MemoryRecallPreparationDiagnostic | undefined;
  const markSendStartedAt = (at: number) => {
    if (sendStartedAt === undefined && Number.isFinite(at) && at >= 0) sendStartedAt = at;
  };
  const markFirstBubbleCommitted = (at = now()) => {
    if (firstBubbleCommittedAt === undefined && Number.isFinite(at) && at >= 0) firstBubbleCommittedAt = at;
  };
  const markPreparationCheckpoint = (key: keyof typeof preparationCheckpoints, at = now()) => {
    if (['providerEnteredAt', 'envelopeReadyAt', 'preflightReadyAt'].includes(key) && Number.isFinite(at) && at > 0) {
      // Preparation may recur before HTTP; only observed transports advance this ordinal.
      providerPreparation = normalizeChatProviderPreparation({ requestOrdinal: attempts.length + 1, checkpoint: key, at });
    }
    if (['youPersistedAt', 'sleepAcceptedAt', 'replyQueuedAt', 'runReplyEnteredAt',
      'sourceReadyAt', 'contextStartedAt', 'contextReadyAt', 'providerEnteredAt', 'envelopeReadyAt',
      'preflightReadyAt', 'replyReadyAt'].includes(key)
      && preparationCheckpoints[key] === undefined && Number.isFinite(at) && at >= 0) preparationCheckpoints[key] = at;
  };
  const observeMemoryPreparation = (value: MemoryRecallPreparationDiagnostic) => {
    memoryPreparation = normalizeChatMemoryPreparation(value);
  };
  let pendingRetry: BaiyunChatModelAttemptDiagnostic['retryReason'];
  const current = () => attempts[attempts.length - 1];
  const markFailure = (code: ChatReplyFailureCode, reasons?: readonly string[]) => {
    const attempt = current();
    if (attempt && !attempt.failureCode) attempt.failureCode = code;
    if (attempt && code === 'tool_grounding_rejected' && reasons?.length) attempt.toolGroundingReasons = [...reasons];
  };
  const observeTransportAttempt = (event: ChatTransportAttemptEvent) => {
    if (event.phase === 'started') {
      if (event.retryReason) markFailure(event.retryReason === 'empty_response' ? 'model_visible_text_missing'
        : event.retryReason === 'tool_fact_correction' ? 'tool_grounding_rejected' : 'visible_envelope_invalid');
      attempts.push({
        attemptOrdinal: attempts.length + 1,
        mode: event.responseEnvelopeMode === 'messages_only' ? 'messages_only' : 'full',
        requestType: event.requestKind === 'initial' ? 'initial'
          : event.requestKind === 'tool_continuation' ? 'continuation'
            : event.requestKind ? 'retry' : undefined,
        retryKind: event.requestKind === 'quality_retry' || event.requestKind === 'tool_fact_correction'
          || event.requestKind === 'protocol_correction' ? event.requestKind : undefined,
        retryReason: event.retryReason ?? pendingRetry,
        requestPurpose: event.requestPurpose,
        startedAt: event.startedAt ?? now(), transportOutcome: 'started',
      });
      pendingRetry = undefined;
    }
    const attempt = current();
    if (!attempt) return;
    for (const key of ['startedAt', 'headersReceivedAt', 'firstContentAt', 'responseCompletedAt',
      'responseAvailableAt', 'bodyReadStartedAt', 'timeoutMs', 'finishedAt', 'responseChars', 'httpStatus'] as const) {
      if (typeof event[key] === 'number') attempt[key] = event[key];
    }
    for (const key of ['transportKind', 'errorName', 'errorCode', 'causeCode', 'providerRequestId'] as const) {
      if (event[key] !== undefined) Object.assign(attempt, { [key]: event[key] });
    }
    if (event.externalAborted !== undefined) attempt.externalAborted = event.externalAborted;
    if (event.outcome) attempt.transportOutcome = event.outcome;
    if (event.bodyParseFailure) attempt.bodyParseFailure = event.bodyParseFailure;
    if (event.stopCause) attempt.stopCause = event.stopCause;
    if (event.providerErrorCode) attempt.providerErrorCode = event.providerErrorCode;
    if (event.offeredToolCount !== undefined) attempt.offeredToolCount = event.offeredToolCount;
    if (event.toolCapabilitySource !== undefined) attempt.toolCapabilitySource = event.toolCapabilitySource;
    if (event.usagePresent !== undefined) attempt.usagePresent = event.usagePresent;
    if (event.usage) attempt.usage = { ...event.usage };
    if (event.phase === 'finished') attempt.finishedAt ??= now();
    if (event.outcome === 'timeout') markFailure('model_timeout');
    else if (event.outcome === 'network_error') markFailure('model_network_failed');
    else if (event.outcome === 'aborted') markFailure('model_cancelled');
    else if (event.outcome === 'http_error') markFailure(event.httpStatus === 401
      || (event.httpStatus === 403 && event.providerErrorCode !== 'AllocationQuota.FreeTierOnly')
      ? 'model_authentication_failed' : 'model_http_failed');
    else if (event.bodyParseFailure) markFailure('provider_payload_invalid');
  };
  const observeReplyDiagnostics = (diagnostics: ChatReplyDiagnostics) => {
    const attempt = current();
    if (!attempt) return;
    attempt.responseObserved = diagnostics.responseObserved ?? !attempt.bodyParseFailure;
    if (attempt.responseObserved) {
      attempt.directContentChars = diagnostics.directContentChars;
      attempt.reasoningContentChars = diagnostics.reasoningContentChars;
      attempt.toolCallCount = diagnostics.toolCallCount;
      attempt.usagePresent = diagnostics.usagePresent;
      attempt.finishReason = diagnostics.finishReason;
    }
    if (diagnostics.usage) attempt.usage = { ...diagnostics.usage };
    attempt.technicalCode = diagnostics.technicalCode;
    if (diagnostics.technicalCode === 'provider_empty_success') markFailure('model_visible_text_missing');
  };
  const markRetry = (reason: NonNullable<BaiyunChatModelAttemptDiagnostic['retryReason']>) => {
    pendingRetry = reason;
    markFailure(reason === 'tool_fact_correction' ? 'tool_grounding_rejected'
      : reason === 'empty_response' ? 'model_visible_text_missing' : 'visible_envelope_invalid');
  };
  const observeToolEvent = (event: Omit<BaiyunChatToolDiagnosticEvent, 'modelAttemptOrdinal'>) => {
    const existing = event.callId ? toolEvents.find(item => item.callId === event.callId && item.kind === event.kind) : undefined;
    if (existing) {
      if (event.at >= existing.at) Object.assign(existing, event);
    } else toolEvents.push({ ...event, modelAttemptOrdinal: current()?.attemptOrdinal });
  };
  const snapshot = () => ({
    toolProtocolFailure: normalizeChatToolProtocolFailure(toolProtocolFailure),
    ...context, turnAttemptId, startedAt, finishedAt: now(),
    sendStartedAt, firstBubbleCommittedAt,
    preparationCheckpoints: normalizeChatPreparationCheckpoints(preparationCheckpoints),
    providerPreparation: normalizeChatProviderPreparation(providerPreparation),
    memoryPreparation: normalizeChatMemoryPreparation(memoryPreparation),
    modelRequestCount: attempts.length,
    modelAttempts: attempts.map(attempt => ({ ...attempt, usage: attempt.usage ? { ...attempt.usage } : undefined,
      toolGroundingReasons: attempt.toolGroundingReasons ? [...attempt.toolGroundingReasons] : undefined })),
    toolEvents: toolEvents.map(event => ({ ...event })),
    auxiliaryFailures: auxiliaryFailures.map(event => ({ ...event })),
  });
  const failureSnapshot = (failure: ChatReplyFailureClassification, delivery: {
    replyPersisted: boolean; replyPersistAttempts: number;
  }): BaiyunChatReplyFailureDiagnosticEntry => ({
    ...snapshot(), ...failure, ...delivery, id: turnAttemptId, attemptedAt: startedAt,
    localDate: new Date(startedAt).toLocaleDateString('sv-SE'),
  });
  return { turnAttemptId, attempts, current, markFailure, markRetry, observeTransportAttempt, observeReplyDiagnostics,
    observeToolEvent, observeToolProtocolFailure, snapshot, failureSnapshot, auxiliaryFailures,
    markSendStartedAt, markFirstBubbleCommitted, markPreparationCheckpoint, observeMemoryPreparation };
}
