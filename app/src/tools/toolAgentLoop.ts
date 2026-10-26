import { isWishToolId, projectWishToolResult } from '../wishPool/wishToolContract';
import { isGiftToolId, serializeGiftToolResult } from '../gifts/giftToolContract';
import type { BaiyunReminderAction, BaiyunFixedEnvelopeRootFailure } from '../ai/behavior/actionChatFixedEnvelope';
import { phoneLimitMinimumResultCharacters, phoneLimitPreExecutionResult, serializePhoneLimitModelResult } from './phoneLimitModelResult';
import { projectPhoneLocationResultForModel } from './phoneLocationModelResult';
import { mapSearchSummaryForModel, WEATHER_MODEL_FAILURE_SUMMARIES } from './weatherMapNearbyModelResultProjector';
import type {
  JunLuoToolInvocation,
  JunLuoToolInvocationParseError,
} from './toolCallProtocol';
import { JunLuoToolAgentTurnError } from './toolAgentErrors';
import type {
  JunLuoToolAgentAssistantMessage,
  JunLuoToolAgentContinuationMessage,
  JunLuoToolAgentResultMessage,
} from './toolAgentMessages';
import { getToolDefinition, listToolPackages } from './toolRegistry';
import {
  createToolAgentPendingCallSnapshot,
  createToolAgentResultSnapshot,
  type JunLuoToolAgentTurnContext,
} from './toolAgentState';
import type { JunLuoToolAgentTurnHandle } from './toolAgentTurn';
import type {
  JunLuoToolCandidateEntry,
  JunLuoToolExecutionAuthority,
} from './toolCandidateSelector';
import type {
  JunLuoRegisteredToolDefinition,
  JunLuoToolResult,
} from './toolTypes';
import type { JunLuoToolPermissionPreauthorizationReceipt } from './toolPermissions';
import {
  createMemoryToolExecutionAttemptJournal,
  createToolAgentHostExecutionId,
  toolExecutionAttemptOutcomeFromResult,
  type JunLuoToolExecutionAttemptJournal,
  type JunLuoToolExecutionAttemptRecord,
} from './toolExecutionAttemptJournal';
import {
  createNativeToolPackageDiscoveryTool,
  rejectToolCapabilityDiscoveryLimit,
  resolveToolCapabilityDiscovery,
  type JunLuoToolCapabilityDiscoveryOffer,
  type JunLuoToolCapabilityDiscoveryResult,
  type JunLuoToolCapabilityDiscoverySnapshot,
} from './toolCapabilityDiscovery';

export const TOOL_AGENT_MAX_ROUNDS = 2;
export const TOOL_AGENT_MAX_CALLS_PER_ROUND = 3;
export const TOOL_AGENT_MAX_CALLS_PER_TURN = 4;
export const TOOL_AGENT_MAX_MODEL_REQUESTS = 3;
export const TOOL_AGENT_MAX_RAW_CALLS_PER_MESSAGE = 12;
export const TOOL_AGENT_MAX_CALL_ID_CHARACTERS = 256;
export const TOOL_AGENT_MAX_RESULT_SUMMARY_CHARACTERS = 1200;
export const TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS = 12000;
export const TOOL_AGENT_MAX_MODEL_RESULTS_PER_ROUND_CHARACTERS = 24000;
const TOOL_AGENT_MAX_CANDIDATES = 8;
export const TOOL_AGENT_DEFAULT_READ_SETTLEMENT_DEADLINE_MS = 30_000;
export const TOOL_AGENT_DEFAULT_SIDE_EFFECT_SETTLEMENT_DEADLINE_MS = 90_000;
export const TOOL_AGENT_MIN_SETTLEMENT_DEADLINE_MS = 1_000;
export const TOOL_AGENT_MAX_SETTLEMENT_DEADLINE_MS = 300_000;
const TOOL_AGENT_ABORT_SETTLEMENT_GRACE_MS = 1000;

const HOST_RESULT_ERROR_CODES = new Set([
  'TOOL_LIMIT_EXCEEDED',
  'DUPLICATE_TOOL_CALL',
  'INVALID_ARGUMENTS',
  'TOOL_DISABLED',
  'TOOL_TIMEOUT',
  'TOOL_OUTCOME_UNKNOWN',
  'TOOL_NOT_STARTED',
  'TOOL_EXECUTION_PENDING',
  'TOOL_INPUT_REQUIRED',
  'EXECUTION_FAILED',
  'PERMISSION_DENIED',
  'CANCELLED_BY_YOU',
]);

class JunLuoToolAgentExecutionContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JunLuoToolAgentExecutionContractError';
  }
}

export type JunLuoToolAgentInvocationExecutionContext = {
  turnId: string;
  sourceMessageId: string;
  dataEpoch: number;
  round: 1 | 2 | 3;
  providerCallId: string;
  semanticExecutionKey: string;
  hostExecutionId: string;
  gateReceipt?: JunLuoToolAgentInvocationGateReceipt;
  signal: AbortSignal;
};

export type JunLuoToolAgentInvocationGateReceipt = {
  auditId: string;
  frozenInput: Record<string, unknown>;
  inputHash: string;
  permission: JunLuoToolPermissionPreauthorizationReceipt;
  proposalId?: string;
};

export type JunLuoToolAgentInvocationGateResolution =
  | {
      decision: 'execute';
      receipt: JunLuoToolAgentInvocationGateReceipt;
    }
  | {
      decision: 'result';
      result: JunLuoToolResult;
    };

export type JunLuoToolAgentInvocationGate =
  | {
      kind: 'none';
      receipt: JunLuoToolAgentInvocationGateReceipt;
    }
  | {
      kind: 'permission';
      wait: (signal: AbortSignal) => Promise<JunLuoToolAgentInvocationGateResolution>;
    }
  | {
      kind: 'confirmation';
      proposalId: string;
      expiresAt: number;
      wait: (signal: AbortSignal) => Promise<JunLuoToolAgentInvocationGateResolution>;
    };

export type JunLuoToolAgentExecutionPolicy =
  | {
      timeoutMode: 'abortable';
      timeoutMs: number;
    }
  | {
      timeoutMode: 'non_abortable';
      settlementDeadlineMs: number;
      recoveryMode: 'none' | 'reconcile';
    };

export type JunLuoToolAgentInvocationSettlement =
  | 'settled'
  | 'aborted'
  | 'outcome_unknown';

export type JunLuoToolAgentPendingExecutionRegistry = {
  clear(conflictKey: string, hostExecutionId: string): void;
  get(conflictKey: string): string | undefined;
  hold(conflictKey: string, hostExecutionId: string): boolean;
};

export function createToolAgentPendingExecutionRegistry(): JunLuoToolAgentPendingExecutionRegistry {
  const pending = new Map<string, Set<string>>();
  return {
    clear(conflictKey, hostExecutionId) {
      const hostExecutionIds = pending.get(conflictKey);
      if (!hostExecutionIds) return;
      hostExecutionIds.delete(hostExecutionId);
      if (hostExecutionIds.size === 0) pending.delete(conflictKey);
    },
    get: (conflictKey) => pending.get(conflictKey)?.values().next().value,
    hold(conflictKey, hostExecutionId) {
      const hostExecutionIds = pending.get(conflictKey) ?? new Set<string>();
      hostExecutionIds.add(hostExecutionId);
      pending.set(conflictKey, hostExecutionIds);
      return true;
    },
  };
}

export type JunLuoToolAgentLoopDiagnostics = {
  requestCount: number;
  toolRoundCount: number;
  acceptedCallCount: number;
  rejectedCallCount: number;
  parallelBatchCount: number;
  serialBatchCount: number;
  duplicateCallCount: number;
  timedOutCallCount: number;
  unknownOutcomeCallCount: number;
  modelVisibleResultCharacters: number;
};

export type JunLuoToolAgentProtocolFailureCode =
  | 'DUPLICATE_CALL_ID'
  | 'FINISH_REASON_MISMATCH'
  | 'INVALID_TOOL_CALL_BATCH'
  | 'INVALID_REPLY_FORMAT'
  | 'MISSING_CALL_ID'
  | 'MODEL_REQUEST_LIMIT'
  | 'TOOL_NOT_ALLOWED'
  | 'REMINDER_DRAFT_INCOMPLETE';

export type JunLuoToolAgentProtocolCallError = {
  callId?: string;
  errorCode:
    | 'DUPLICATE_CALL_ID'
    | 'INVALID_ARGUMENTS'
    | 'INVALID_TOOL_CALL'
    | 'MISSING_CALL_ID'
    | 'TOOL_NOT_ALLOWED'
    | 'UNKNOWN_TOOL';
};

export type JunLuoReminderActionIssue =
  | 'inspection_not_applicable'
  | 'semantic_envelope_absent'
  | 'root_invalid'
  | 'messages_not_first'
  | 'unexpected_root_keys'
  | 'messages_invalid'
  | 'action_missing'
  | 'action_invalid';

export type JunLuoToolAgentProtocolFailure = {
  code: JunLuoToolAgentProtocolFailureCode;
  callErrors: JunLuoToolAgentProtocolCallError[];
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

export type {
  JunLuoToolAgentAssistantMessage,
  JunLuoToolAgentContinuationMessage,
  JunLuoToolAgentResultMessage,
} from './toolAgentMessages';

export type JunLuoToolAgentModelTurn = {
  silent?: true;
  assistantToolCallMessage?: JunLuoToolAgentAssistantMessage;
  assistantText: string;
  finishReason?: string;
  rawToolCallCount?: number;
  reasoningContent?: string;
  textualToolProtocol?: boolean;
  toolInvocationErrors: JunLuoToolInvocationParseError[];
  toolInvocations: JunLuoToolInvocation[];
  reminderAction?: { sourceMessageId: string; choice: BaiyunReminderAction };
  reminderActionIssue?: JunLuoReminderActionIssue;
  reminderActionDirectIssue?: JunLuoReminderActionIssue | 'valid';
  reminderVisibleReplySource?: 'direct_content' | 'reasoning_marked_visible';
  reminderActionRootFailure?: BaiyunFixedEnvelopeRootFailure;
  reminderActionDirectRootFailure?: BaiyunFixedEnvelopeRootFailure;
};

export type JunLuoToolAgentModelRequest = {
  allowTools: boolean;
  completedResults: readonly JunLuoToolResult[];
  continuationMessages: readonly JunLuoToolAgentContinuationMessage[];
  requestKind: 'concrete_tools' | 'package_discovery' | 'final';
  responseInstruction?: string;
  signal: AbortSignal;
  toolChoice: 'auto' | 'required';
  toolRound: 0 | 1 | 2 | 3;
  tools: readonly JunLuoRegisteredToolDefinition[];
};

export type JunLuoToolAgentModelResultProjectionContext = {
  turnId: string;
  sourceMessageId: string;
  dataEpoch: number;
  round: 1 | 2 | 3;
  providerCallId: string;
};

export type JunLuoToolAgentModelResultProjector = (
  invocation: JunLuoToolInvocation,
  fullResult: JunLuoToolResult,
  context: JunLuoToolAgentModelResultProjectionContext,
) => JunLuoToolResult;

export type JunLuoToolAgentInvocationPreparation =
  | {
      kind: 'ready';
      input: Record<string, unknown>;
    }
  | {
      kind: 'rejected';
      result: JunLuoToolResult;
    };

export type RunToolAgentLoopOptions = {
  allowFinalDraftCorrection?: boolean;
  finalDayPlanRepair?: {
    allowed: boolean;
    remainingRequests: () => number;
  };
  reminderDraftContract?: {
    continuationInstruction: string;
    remainingRequests: () => number;
    onRequired: () => void;
    isCurrent: () => Promise<boolean>;
    cardDelivered: () => boolean;
  };
  allowPhoneEmergencySilence?: boolean;
  onDiagnosticToolEvent?: (event: { kind: 'package' | 'execution'; callId?: string; name: string; status: string; at: number }) => void;
  allowPostMemoryMusic?: boolean;
  maxCandidates?: number;
  /** Host-granted internal tools; still require an offered candidate and its authority. */
  hostOnlyAllowedToolIds?: readonly string[];
  isToolAvailableForRequest?: (toolId: string) => Promise<boolean>;
  turn: JunLuoToolAgentTurnHandle;
  initialCandidates: readonly JunLuoToolCandidateEntry[];
  packageDiscovery?: JunLuoToolCapabilityDiscoveryOffer;
  resolvePackageDiscovery?: (invocation: JunLuoToolInvocation, result: JunLuoToolCapabilityDiscoveryResult) => Promise<JunLuoToolCapabilityDiscoveryResult>;
  requestModel: (request: JunLuoToolAgentModelRequest) => Promise<JunLuoToolAgentModelTurn>;
  emptyResponseRetryInstruction?: string;
  allowEmptyResponseRetry?: boolean;
  bodyOnlyRetry?: {
    continuationMessages: readonly JunLuoToolAgentContinuationMessage[];
    completedResults: readonly JunLuoToolResult[];
  };
  requestProtocolCorrection?: (request: {
    allowTools: boolean;
    completedResults: readonly JunLuoToolResult[];
    continuationMessages: readonly JunLuoToolAgentContinuationMessage[];
    failure: JunLuoToolAgentProtocolFailure;
    previousTurn: JunLuoToolAgentModelTurn;
    requestKind: JunLuoToolAgentModelRequest['requestKind'];
    responseInstruction?: string;
    signal: AbortSignal;
    toolChoice: 'auto' | 'required';
    toolRound: 0 | 1 | 2 | 3;
    tools: readonly JunLuoRegisteredToolDefinition[];
  }) => Promise<JunLuoToolAgentModelTurn>;
  executeInvocation: (
    invocation: JunLuoToolInvocation,
    context: JunLuoToolAgentInvocationExecutionContext,
  ) => Promise<JunLuoToolResult>;
  prepareInvocation?: (
    invocation: JunLuoToolInvocation,
    context: JunLuoToolAgentModelResultProjectionContext,
  ) => JunLuoToolAgentInvocationPreparation;
  projectResultForModel?: JunLuoToolAgentModelResultProjector;
  resolveInvocationGate?: (
    invocation: JunLuoToolInvocation,
    context: Omit<JunLuoToolAgentInvocationExecutionContext, 'gateReceipt'>,
  ) => Promise<JunLuoToolAgentInvocationGate>;
  /** A failed memory correction may prepare a new proposal; execution still requires a new confirmation gate. */
  reconfirmMemoryCorrection?: (
    invocation: JunLuoToolInvocation, result: JunLuoToolResult,
  ) => Promise<JunLuoToolInvocation | null>;
  resolveExecutionPolicy?: (
    invocation: JunLuoToolInvocation,
  ) => JunLuoToolAgentExecutionPolicy;
  executionAttemptJournal?: JunLuoToolExecutionAttemptJournal;
  pendingExecutionRegistry?: JunLuoToolAgentPendingExecutionRegistry;
  enforceAgentEpochSafety?: boolean;
  onSettlement?: (input: {
    attempt?: JunLuoToolExecutionAttemptRecord;
    hostExecutionId: string;
    invocation: JunLuoToolInvocation;
    result: JunLuoToolResult;
    dataEpochStillCurrent: boolean;
    sourceSessionId: string;
    turnId: string;
    continuationMessages: JunLuoToolAgentContinuationMessage[];
  }) => Promise<void>;
  completeWithVisibleCard?: (results: readonly JunLuoToolResult[]) => Promise<boolean>;
  onLateSettlement?: (input: {
    attempt?: JunLuoToolExecutionAttemptRecord;
    hostExecutionId: string;
    invocation: JunLuoToolInvocation;
    result: JunLuoToolResult;
    dataEpochStillCurrent: boolean;
    sourceSessionId: string;
    turnId: string;
    continuationMessages: JunLuoToolAgentContinuationMessage[];
  }) => Promise<void>;
  abortSettlementGraceMs?: number;
  executionScheduler?: {
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  };
  now?: () => number;
  selectFollowUpCandidates?: (
    results: readonly JunLuoToolResult[],
    previousCandidates: readonly JunLuoToolCandidateEntry[],
  ) => readonly JunLuoToolCandidateEntry[];
  requireToolCallForCandidates?: (
    candidates: readonly JunLuoToolCandidateEntry[],
  ) => boolean;
};

export type RunToolAgentLoopResult = {
  silent?: true;
  completedWithVisibleCard?: boolean;
  reminderDraftIncomplete?: true;
  assistantText: string;
  capabilityDiscoveries: JunLuoToolCapabilityDiscoverySnapshot[];
  finishReason?: string;
  diagnostics: JunLuoToolAgentLoopDiagnostics;
  protocolCorrectionAttempts: number;
  protocolFailure?: JunLuoToolAgentProtocolFailure;
  requestCount: number;
  results: JunLuoToolResult[];
  state: JunLuoToolAgentTurnContext;
  toolRounds: number;
};

function parseErrorCode(error: JunLuoToolInvocationParseError): JunLuoToolAgentProtocolCallError['errorCode'] {
  if (error.code === 'DUPLICATE_CALL_ID') return 'DUPLICATE_CALL_ID';
  if (error.code === 'MISSING_CALL_ID') return 'MISSING_CALL_ID';
  if (error.code === 'UNKNOWN_TOOL_NAME') return 'UNKNOWN_TOOL';
  if (error.code === 'INVALID_ARGUMENTS_JSON' || error.code === 'INVALID_ARGUMENTS_SHAPE') {
    return 'INVALID_ARGUMENTS';
  }
  return 'INVALID_TOOL_CALL';
}

function failureCodeForParseErrors(
  errors: readonly JunLuoToolInvocationParseError[],
): JunLuoToolAgentProtocolFailureCode {
  if (errors.some((error) => error.code === 'DUPLICATE_CALL_ID')) return 'DUPLICATE_CALL_ID';
  if (errors.some((error) => error.code === 'MISSING_CALL_ID')) return 'MISSING_CALL_ID';
  if (errors.some((error) => error.code === 'UNKNOWN_TOOL_NAME')) return 'TOOL_NOT_ALLOWED';
  return 'INVALID_TOOL_CALL_BATCH';
}

function rawToolCallCount(turn: JunLuoToolAgentModelTurn) {
  return turn.rawToolCallCount
    ?? turn.toolInvocations.length + turn.toolInvocationErrors.length;
}

function inspectModelTurnProtocol({
  allowTools,
  hostOnlyAllowedToolIds = [],
  resultByCallId,
  tools,
  turn,
}: {
  allowTools: boolean;
  hostOnlyAllowedToolIds?: readonly string[];
  resultByCallId: ReadonlyMap<string, JunLuoToolResult>;
  tools: readonly JunLuoRegisteredToolDefinition[];
  turn: JunLuoToolAgentModelTurn;
}): JunLuoToolAgentProtocolFailure | undefined {
  const rawCallCount = rawToolCallCount(turn);
  if (rawCallCount > TOOL_AGENT_MAX_RAW_CALLS_PER_MESSAGE) {
    return {
      code: 'INVALID_TOOL_CALL_BATCH',
      callErrors: [],
      finishReason: turn.finishReason,
      rawToolCallCount: rawCallCount,
    };
  }
  if (
    (turn.finishReason === 'tool_calls' && rawCallCount === 0)
    || (rawCallCount > 0 && turn.finishReason !== undefined && turn.finishReason !== 'tool_calls')
  ) {
    return {
      code: 'FINISH_REASON_MISMATCH',
      callErrors: [],
      finishReason: turn.finishReason,
      rawToolCallCount: rawCallCount,
    };
  }
  if (turn.toolInvocationErrors.length > 0) {
    return {
      code: failureCodeForParseErrors(turn.toolInvocationErrors),
      callErrors: turn.toolInvocationErrors.map((error) => ({
        callId: error.callId,
        errorCode: parseErrorCode(error),
      })),
      finishReason: turn.finishReason,
      rawToolCallCount: rawCallCount,
    };
  }
  if (rawCallCount === 0 && turn.textualToolProtocol) {
    return {
      code: 'INVALID_REPLY_FORMAT',
      replyFormatReason: 'textual_tool_protocol',
      callErrors: [],
      finishReason: turn.finishReason,
      rawToolCallCount: 0,
    };
  }
  const seenCallIds = new Set<string>();
  for (const invocation of turn.toolInvocations) {
    if (!invocation.callId) {
      return {
        code: 'MISSING_CALL_ID',
        callErrors: [{ errorCode: 'MISSING_CALL_ID' }],
        finishReason: turn.finishReason,
        rawToolCallCount: rawCallCount,
      };
    }
    if (
      invocation.callId.length > TOOL_AGENT_MAX_CALL_ID_CHARACTERS
      || /[\u0000-\u001f\u007f]/u.test(invocation.callId)
    ) {
      return {
        code: 'INVALID_TOOL_CALL_BATCH',
        callErrors: [{ callId: invocation.callId, errorCode: 'INVALID_TOOL_CALL' }],
        finishReason: turn.finishReason,
        rawToolCallCount: rawCallCount,
      };
    }
    if (seenCallIds.has(invocation.callId) || resultByCallId.has(invocation.callId)) {
      return {
        code: 'DUPLICATE_CALL_ID',
        callErrors: [{ callId: invocation.callId, errorCode: 'DUPLICATE_CALL_ID' }],
        finishReason: turn.finishReason,
        rawToolCallCount: rawCallCount,
      };
    }
    seenCallIds.add(invocation.callId);
  }
  if (!turn.toolInvocations.length) return undefined;
  const allowedToolIds = new Set(tools.map((tool) => tool.id));
  const hostOnlyAllowed = new Set(hostOnlyAllowedToolIds);
  const blocked = turn.toolInvocations.find((invocation) => {
    const tool = getToolDefinition(invocation.toolId);
    return !allowTools
      || !tool
      || !allowedToolIds.has(invocation.toolId)
      || tool.chatExposure === 'disabled'
      || (tool.chatExposure === 'internal_only' && !hostOnlyAllowed.has(invocation.toolId));
  });
  if (!blocked) return undefined;
  return {
    code: 'TOOL_NOT_ALLOWED',
    callErrors: [{ callId: blocked.callId, errorCode: 'TOOL_NOT_ALLOWED' }],
    finishReason: turn.finishReason,
    rawToolCallCount: rawCallCount,
  };
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, stableValue(item)]),
  );
}

export function createToolInvocationFingerprint(
  turnId: string,
  invocation: JunLuoToolInvocation,
) {
  return `${turnId}:${invocation.toolId}:${isWishToolId(invocation.toolId) ? invocation.callId + ':' : ''}${JSON.stringify(stableValue(invocation.input))}`;
}

function executionConflictKey(invocation: JunLuoToolInvocation) {
  const tool = getToolDefinition(invocation.toolId);
  return tool?.conflictGroup || invocation.toolId;
}

function defaultExecutionPolicy(
  invocation: JunLuoToolInvocation,
): JunLuoToolAgentExecutionPolicy {
  const tool = getToolDefinition(invocation.toolId);
  const settlementDeadlineMs = tool?.agentSettlementDeadlineMs
    ?? (tool?.readOnly
      ? TOOL_AGENT_DEFAULT_READ_SETTLEMENT_DEADLINE_MS
      : TOOL_AGENT_DEFAULT_SIDE_EFFECT_SETTLEMENT_DEADLINE_MS);
  return {
    timeoutMode: 'non_abortable',
    settlementDeadlineMs,
    recoveryMode: 'none',
  };
}

function assertExecutionPolicy(policy: JunLuoToolAgentExecutionPolicy) {
  const duration = policy.timeoutMode === 'abortable'
    ? policy.timeoutMs
    : policy.settlementDeadlineMs;
  if (
    !Number.isFinite(duration)
    || duration < TOOL_AGENT_MIN_SETTLEMENT_DEADLINE_MS
    || duration > TOOL_AGENT_MAX_SETTLEMENT_DEADLINE_MS
  ) {
    throw new JunLuoToolAgentExecutionContractError(
      'tool execution deadline must be between 1000 and 300000 milliseconds',
    );
  }
}

function createRejectedResult(
  invocation: JunLuoToolInvocation,
  code: 'DUPLICATE_TOOL_CALL' | 'TOOL_LIMIT_EXCEEDED' | 'TOOL_DISABLED',
): JunLuoToolResult {
  const now = Date.now();
  return phoneLimitPreExecutionResult({
    callId: invocation.callId,
    toolId: invocation.toolId,
    ok: false,
    status: 'error',
    summary: '',
    error: { code, message: code },
    startedAt: now,
    finishedAt: now,
  });
}

function executionFailureResult(
  invocation: JunLuoToolInvocation,
  code:
    | 'EXECUTION_FAILED'
    | 'TOOL_TIMEOUT'
    | 'TOOL_OUTCOME_UNKNOWN'
    | 'TOOL_NOT_STARTED'
    | 'TOOL_EXECUTION_PENDING',
): JunLuoToolResult {
  const now = Date.now();
  const result: JunLuoToolResult = {
    callId: invocation.callId,
    toolId: invocation.toolId,
    ok: false,
    status: 'error',
    summary: '',
    error: { code, message: code },
    startedAt: now,
    finishedAt: now,
  };
  return code === 'TOOL_NOT_STARTED' ? phoneLimitPreExecutionResult(result) : result;
}

function isDayPlanRepeatFrequencyFailure(result: JunLuoToolResult): boolean {
  if (result.toolId !== 'schedule.submit_day_plan' || result.ok
    || result.error?.code !== 'EXECUTION_FAILED' || result.error.message !== 'INVALID_ARGUMENTS') return false;
  const issue = (result.data as { argumentIssue?: { field?: unknown; reason?: unknown } } | undefined)?.argumentIssue;
  return issue?.field === 'repeat.frequency' && issue.reason === 'frequency_value';
}

function knownDayPlanResultIssues(result: JunLuoToolResult) {
  if (result.toolId !== 'schedule.submit_day_plan' || result.ok
    || result.error?.code !== 'EXECUTION_FAILED' || result.error.message !== 'INVALID_ARGUMENTS') return undefined;
  const issues = (result.data as { argumentIssues?: unknown } | undefined)?.argumentIssues;
  if (!Array.isArray(issues) || !issues.length || !issues.every(issue => issue && typeof issue === 'object' && !Array.isArray(issue)
    && Number.isSafeInteger(issue.entry) && issue.entry >= 1
    && (issue.field === 'startAt' && issue.reason === 'conflicts_with_startLocal'
      || issue.field === 'endAt' && issue.reason === 'conflicts_with_endLocal'
      || issue.field === 'repeat.frequency' && issue.reason === 'frequency_value'
      || issue.field === 'steps' && issue.reason === 'empty_array'))) return undefined;
  return issues.map(issue => ({ entry: issue.entry, field: issue.field, reason: issue.reason }));
}

function resultMessage(
  result: JunLuoToolResult,
  forceDataOmitted = false,
): JunLuoToolAgentResultMessage {
  if (isGiftToolId(result.toolId)) return { subject: 'I', kind: 'tool_result',
    callId: result.callId, toolId: result.toolId, content: serializeGiftToolResult(result) };
  const phone = serializePhoneLimitModelResult(result, TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS, forceDataOmitted);
  if (phone !== null) return { subject: 'I', kind: 'tool_result', callId: result.callId,
    toolId: result.toolId, content: phone };
  result = projectPhoneLocationResultForModel(result);
  if (result.toolId === 'communication.open_phone_dialer' && !result.ok && result.error?.code === 'EXECUTION_FAILED'
    && ['没有找到对应联系人。', '尚未获得通讯录读取权限。', '这次没能读取通讯录。', '这次没能打开拨号页。'].includes(result.summary)) {
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: result.status, summary: result.summary, errorCode: result.error.code }) };
  }
  const wish = projectWishToolResult(result);
  if (wish) return { subject: 'I', kind: 'tool_result',
    callId: result.callId, toolId: result.toolId, content: JSON.stringify(wish) };
  if (!result.ok && result.toolId.startsWith('weather.') && WEATHER_MODEL_FAILURE_SUMMARIES.has(result.summary)
    && result.error?.code !== 'STALE_DATA_EPOCH'
    && (result.error?.code === 'EXECUTION_FAILED' || result.error?.code === 'PERMISSION_DENIED'
      || !result.error || !HOST_RESULT_ERROR_CODES.has(result.error.code))) {
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: result.status, summary: result.summary, errorCode: result.error?.code }) };
  }
  if (result.toolId === 'camera.read_observations' && !result.ok
    && result.summary === '观察本暂时读取失败。'
    && (result.error?.code === 'INVALID_ARGUMENTS' || result.error?.code === 'EXECUTION_FAILED')) {
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: result.status, summary: result.summary, errorCode: result.error.code }) };
  }
  const approvedMapStatuses = new Set([
    '本次查询没有找到匹配地点。', '暂时没有足够准确的新定位。', '尚未获得位置权限。',
    '本次地图查询未完成：网络连接失败。', '本次地图查询未完成：请求超时。',
    '本次地图查询未完成：请求过于频繁。', '本次地图查询未完成：地图服务配置需要检查。',
    '地图查询额度已用完。', '自动地图查询已暂停，等待明确重试。', '本次地图查询未完成。',
    '上次搜索已失效，需要重新搜索。', '这次搜索可查看的结果已展示完。',
  ]);
  if (!result.ok && (result.toolId.startsWith('map.') || result.toolId === 'nearby.describe_place_context')
    && (approvedMapStatuses.has(result.summary) || !result.error || !HOST_RESULT_ERROR_CODES.has(result.error.code))) {
    const summary = approvedMapStatuses.has(result.summary) ? result.summary
      : result.error?.code === 'PERMISSION_DENIED' ? '尚未获得位置权限。'
      : result.error?.code === 'TOOL_TIMEOUT' ? '本次地图查询未完成：请求超时。' : '本次地图查询未完成。';
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: result.status, summary, errorCode: result.error?.code }) };
  }
  if (result.toolId === 'http.call_named_service' && !result.ok && result.data === undefined
    && result.error?.code === 'EXECUTION_FAILED' && result.summary) {
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: result.status, summary: result.summary, errorCode: result.error.code }) };
  }
  if (result.error?.code === 'TOOL_INPUT_REQUIRED') {
    return {
      subject: 'I',
      kind: 'tool_result',
      callId: result.callId,
      toolId: result.toolId,
      content: JSON.stringify({
        ok: false,
        status: 'input_required',
        errorCode: 'TOOL_INPUT_REQUIRED',
        required: ['place'],
      }),
    };
  }
  if (result.toolId === 'schedule.submit_day_plan' && !result.ok
    && result.error?.code === 'EXECUTION_FAILED' && result.error.message === 'schedule-target-not-queried') {
    const issue = (result.data as { argumentIssue?: { field?: unknown; reason?: unknown } } | undefined)?.argumentIssue;
    if (issue?.field === 'occurrenceId' && issue.reason === 'not_in_current_query') {
      return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
        content: JSON.stringify({ ok: false, status: 'error', errorCode: 'EXECUTION_FAILED',
          data: { argumentIssue: { field: 'occurrenceId', reason: 'not_in_current_query' } } }) };
    }
  }
  if (isDayPlanRepeatFrequencyFailure(result)) {
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: 'error', errorCode: 'EXECUTION_FAILED',
        data: { argumentIssue: { field: 'repeat.frequency', reason: 'frequency_value' } } }) };
  }
  const argumentIssues = knownDayPlanResultIssues(result);
  if (argumentIssues) {
    return { subject: 'I', kind: 'tool_result', callId: result.callId, toolId: result.toolId,
      content: JSON.stringify({ ok: false, status: 'error', errorCode: 'EXECUTION_FAILED', data: { argumentIssues } }) };
  }
  if (result.error && (HOST_RESULT_ERROR_CODES.has(result.error.code)
    || result.toolId.startsWith('weather.') && result.error.code === 'STALE_DATA_EPOCH')) {
    const status = result.error.code === 'TOOL_OUTCOME_UNKNOWN'
      ? 'outcome_unknown'
      : result.error.code === 'PERMISSION_DENIED'
        ? 'permission_denied'
        : result.error.code === 'CANCELLED_BY_YOU'
          ? 'cancelled'
          : 'error';
    return {
      subject: 'I',
      kind: 'tool_result',
      callId: result.callId,
      toolId: result.toolId,
      content: JSON.stringify({ ok: false, status, errorCode: result.error.code }),
    };
  }
  const envelope = {
    ok: result.ok,
    status: result.status,
    summary: mapSearchSummaryForModel(result, !forceDataOmitted).slice(0, TOOL_AGENT_MAX_RESULT_SUMMARY_CHARACTERS),
    ...(result.data === undefined || forceDataOmitted ? {} : { data: result.data }),
    ...(result.error ? { errorCode: result.error.code } : {}),
  };
  let content = JSON.stringify(envelope);
  if (result.ok && (forceDataOmitted || content.length > TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS)) {
    content = JSON.stringify({
      ok: true,
      status: 'success',
      summary: mapSearchSummaryForModel(result, false).slice(0, TOOL_AGENT_MAX_RESULT_SUMMARY_CHARACTERS),
      dataOmitted: true,
    });
  } else if (content.length > TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS) {
    content = JSON.stringify({
      ok: result.ok,
      status: result.status,
      summary: result.summary.slice(0, TOOL_AGENT_MAX_RESULT_SUMMARY_CHARACTERS),
      ...(result.error ? { errorCode: result.error.code } : {}),
    });
  }
  return {
    subject: 'I',
    kind: 'tool_result',
    callId: result.callId,
    toolId: result.toolId,
    content,
  };
}

function roundResultMessages(
  results: readonly JunLuoToolResult[],
) {
  let characters = 0;
  // The approved wish receipt is small and indivisible (at most three wishes).
  // Reserve it inside the existing budget before considering other large data.
  let pendingWishCharacters = results.reduce((total, result) => total
    + (projectWishToolResult(result) ? resultMessage(result).content.length : 0), 0);
  let pendingGiftCharacters = results.reduce((total, result) => total
    + (isGiftToolId(result.toolId) ? resultMessage(result).content.length : 0), 0);
  let pendingPhoneCharacters = results.reduce((total, result) => total + phoneLimitMinimumResultCharacters(result), 0);
  let pendingOtherFailureCharacters = results.reduce((total, result) => total
    + (!result.ok && !isGiftToolId(result.toolId) && !projectWishToolResult(result) && !phoneLimitMinimumResultCharacters(result)
      ? resultMessage(result).content.length : 0), 0);
  const messages = results.map((result) => {
    let message = resultMessage(result);
    if (projectWishToolResult(result)) pendingWishCharacters -= message.content.length;
    if (isGiftToolId(result.toolId)) pendingGiftCharacters -= message.content.length;
    const minimumPhoneCharacters = phoneLimitMinimumResultCharacters(result);
    pendingPhoneCharacters -= minimumPhoneCharacters;
    if (!result.ok && !isGiftToolId(result.toolId) && !projectWishToolResult(result) && !minimumPhoneCharacters) {
      pendingOtherFailureCharacters -= message.content.length;
    }
    if (
      characters + message.content.length + pendingWishCharacters + pendingGiftCharacters + pendingPhoneCharacters
        + (minimumPhoneCharacters > 0 ? pendingOtherFailureCharacters : 0)
      > TOOL_AGENT_MAX_MODEL_RESULTS_PER_ROUND_CHARACTERS
    ) {
      message = resultMessage(result, result.ok || minimumPhoneCharacters > 0);
    }
    characters += message.content.length;
    return message;
  });
  // Other domains' indivisible failure receipts can already fill the entire
  // existing budget. Do not change them or send an oversized new phone round.
  // The caller has recorded the real settlements before reaching this point.
  if (results.some(result => phoneLimitMinimumResultCharacters(result) > 0)
    && characters > TOOL_AGENT_MAX_MODEL_RESULTS_PER_ROUND_CHARACTERS) {
    throw new JunLuoToolAgentExecutionContractError('phone result round exceeds the existing model budget');
  }
  if (results.some(result => isGiftToolId(result.toolId))
    && characters > TOOL_AGENT_MAX_MODEL_RESULTS_PER_ROUND_CHARACTERS) {
    throw new JunLuoToolAgentExecutionContractError('gift result round exceeds the existing model budget');
  }
  return { characters, messages };
}

function projectRoundResultsForModel(
  results: readonly JunLuoToolResult[],
  invocations: readonly JunLuoToolInvocation[],
  round: 1 | 2 | 3,
  turn: JunLuoToolAgentTurnHandle,
  projector: JunLuoToolAgentModelResultProjector | undefined,
) {
  if (!projector) return [...results];
  const invocationByCallId = new Map(invocations.map((invocation) => [
    invocation.callId,
    invocation,
  ] as const));
  return results.map((fullResult) => {
    const invocation = invocationByCallId.get(fullResult.callId);
    if (!invocation) return fullResult;
    try {
      const projected = projector(invocation, fullResult, {
        turnId: turn.identity.turnId,
        sourceMessageId: turn.identity.sourceMessageId,
        dataEpoch: turn.identity.dataEpoch,
        round,
        providerCallId: invocation.callId,
      });
      if (
        projected.callId !== fullResult.callId
        || projected.toolId !== fullResult.toolId
        || projected.ok !== fullResult.ok
        || projected.status !== fullResult.status
        || projected.error?.code !== fullResult.error?.code
      ) {
        return executionFailureResult(invocation, 'EXECUTION_FAILED');
      }
      return projected;
    } catch {
      return executionFailureResult(invocation, 'EXECUTION_FAILED');
    }
  });
}

function capabilityDiscoveryMessage(
  callId: string,
  result: JunLuoToolCapabilityDiscoveryResult,
): JunLuoToolAgentResultMessage {
  return {
    subject: 'I',
    kind: 'tool_result',
    callId,
    toolId: 'system.use_package',
    content: result.content,
  };
}

function assistantMessage(turn: JunLuoToolAgentModelTurn): JunLuoToolAgentAssistantMessage {
  if (turn.assistantToolCallMessage) return turn.assistantToolCallMessage;
  return {
    subject: 'I',
    kind: 'tool_request',
    content: turn.assistantText,
    reasoningContent: turn.reasoningContent,
    toolCalls: turn.toolInvocations.map((invocation) => ({
      callId: invocation.callId,
      type: 'function',
      rawName: invocation.rawName ?? invocation.toolId.replace(/\./g, '__'),
      rawArguments: invocation.rawArguments ?? '{}',
    })),
  };
}

function settlementMessages(
  invocation: JunLuoToolInvocation,
  result: JunLuoToolResult,
): JunLuoToolAgentContinuationMessage[] {
  return [{
    subject: 'I', kind: 'tool_request', content: '',
    toolCalls: [{
      callId: invocation.callId, type: 'function',
      rawName: invocation.rawName ?? invocation.toolId.replace(/\./g, '__'),
      rawArguments: invocation.rawName === 'wish__use' ? invocation.rawArguments ?? '{}' : JSON.stringify(invocation.input),
    }],
  }, resultMessage(result)];
}

function canExecuteRoundInParallel(invocations: readonly JunLuoToolInvocation[]) {
  const conflictGroups = new Set<string>();
  return invocations.every((invocation) => {
    const tool = getToolDefinition(invocation.toolId);
    const toolPackage = tool
      ? listToolPackages().find((item) => item.id === tool.packageId)
      : undefined;
    if (
      !tool
      || toolPackage?.source !== 'builtin'
      || !tool.readOnly
      || tool.permission !== 'allow'
      || typeof tool.executor !== 'function'
    ) return false;
    if (!tool.conflictGroup) return true;
    if (conflictGroups.has(tool.conflictGroup)) return false;
    conflictGroups.add(tool.conflictGroup);
    return true;
  });
}

async function executeOneInvocation(
  invocation: JunLuoToolInvocation,
  gate: JunLuoToolAgentInvocationGate | undefined,
  round: 1 | 2 | 3,
  executeInvocation: RunToolAgentLoopOptions['executeInvocation'],
  resolveExecutionPolicy: RunToolAgentLoopOptions['resolveExecutionPolicy'],
  abortSettlementGraceMs: number,
  scheduler: NonNullable<RunToolAgentLoopOptions['executionScheduler']>,
  now: () => number,
  attemptJournal: JunLuoToolExecutionAttemptJournal,
  pendingRegistry: JunLuoToolAgentPendingExecutionRegistry,
  enforceAgentEpochSafety: boolean,
  onSettlement: RunToolAgentLoopOptions['onSettlement'],
  onLateSettlement: RunToolAgentLoopOptions['onLateSettlement'],
  turn: JunLuoToolAgentTurnHandle,
) {
  const policy = resolveExecutionPolicy?.(invocation) ?? defaultExecutionPolicy(invocation);
  assertExecutionPolicy(policy);
  const tool = getToolDefinition(invocation.toolId);
  const semanticExecutionKey = createToolInvocationFingerprint(turn.identity.turnId, invocation);
  const hostExecutionId = createToolAgentHostExecutionId(semanticExecutionKey);
  const conflictKey = executionConflictKey(invocation);
  const context: JunLuoToolAgentInvocationExecutionContext = {
    turnId: turn.identity.turnId,
    sourceMessageId: turn.identity.sourceMessageId,
    dataEpoch: turn.identity.dataEpoch,
    round,
    providerCallId: invocation.callId,
    semanticExecutionKey,
    hostExecutionId,
    signal: turn.signal,
  };

  if (gate) {
    if (gate.kind === 'none') {
      context.gateReceipt = gate.receipt;
    } else {
      const current = turn.getSnapshot();
      if (gate.kind === 'permission') {
        turn.transition('awaiting_permission', {
          pendingCalls: current.pendingCalls,
          pendingGate: { kind: 'permission', callIds: [invocation.callId] },
        });
      } else {
        turn.transition('awaiting_confirmation', {
          pendingCalls: current.pendingCalls,
          pendingGate: {
            kind: 'confirmation',
            callIds: [invocation.callId],
            proposalId: gate.proposalId,
            expiresAt: gate.expiresAt,
          },
        });
      }
      const resolution = await gate.wait(turn.signal);
      turn.assertActive();
      turn.transition('executing', { pendingCalls: current.pendingCalls });
      if (resolution.decision === 'result') {
        return {
          invocation,
          result: phoneLimitPreExecutionResult(resolution.result),
          settlement: 'settled' as const,
          timedOut: false,
          blocksFurtherTools: false,
        };
      }
      context.gateReceipt = resolution.receipt;
    }
  }

  const epochMode = tool?.agentEpochMode
    ?? (tool?.readOnly ? 'read_only_outside_lease' : 'whole_execution_lease');
  if (
    enforceAgentEpochSafety
    && policy.timeoutMode === 'non_abortable'
    && !tool?.readOnly
    && epochMode === 'whole_execution_lease'
  ) {
    return {
      invocation,
      result: createRejectedResult(invocation, 'TOOL_DISABLED'),
      settlement: 'settled' as const,
      timedOut: false,
      blocksFurtherTools: false,
    };
  }
  let attempt: JunLuoToolExecutionAttemptRecord | undefined;
  if (!tool?.readOnly) {
    const createdAt = now();
    const deadlineMs = policy.timeoutMode === 'abortable'
      ? policy.timeoutMs
      : policy.settlementDeadlineMs;
    let prepared;
    try {
      prepared = await attemptJournal.prepare({
        hostExecutionId,
        turnId: turn.identity.turnId,
        sourceMessageId: turn.identity.sourceMessageId,
        sourceSessionId: turn.identity.sourceSessionId,
        providerCallId: invocation.callId,
        toolId: invocation.toolId,
        conflictKey,
        dataEpoch: turn.identity.dataEpoch,
        createdAt,
        dispatchedAt: createdAt,
        deadlineAt: createdAt + deadlineMs,
      });
    } catch {
      return {
        invocation,
        result: executionFailureResult(invocation, 'EXECUTION_FAILED'),
        settlement: 'settled' as const,
        timedOut: false,
        blocksFurtherTools: false,
      };
    }
    if (prepared.status === 'pending') {
      return {
        invocation,
        result: executionFailureResult(invocation, 'TOOL_EXECUTION_PENDING'),
        settlement: 'outcome_unknown' as const,
        timedOut: false,
        blocksFurtherTools: true,
      };
    }
    if (prepared.status === 'capacity_exceeded') {
      return {
        invocation,
        result: executionFailureResult(invocation, 'EXECUTION_FAILED'),
        settlement: 'settled' as const,
        timedOut: false,
        blocksFurtherTools: false,
      };
    }
    attempt = prepared.record;
  }

  const settleAttempt = async (result: JunLuoToolResult) => {
    if (attempt) {
      await attemptJournal.markSettled(
        hostExecutionId,
        toolExecutionAttemptOutcomeFromResult(result),
        now(),
      );
    }
    if (!onSettlement) return;
    await onSettlement({
      attempt,
      hostExecutionId,
      invocation,
      result,
      dataEpochStillCurrent: turn.isDataEpochCurrent(),
      sourceSessionId: turn.identity.sourceSessionId,
      turnId: turn.identity.turnId,
      continuationMessages: settlementMessages(invocation, result),
    });
    if (attempt) await attemptJournal.acknowledgeDelivery(hostExecutionId);
  };

  if (policy.timeoutMode === 'non_abortable') {
    if (pendingRegistry.get(conflictKey)) {
      if (attempt) await attemptJournal.remove(hostExecutionId);
      return {
        invocation,
        result: executionFailureResult(invocation, 'TOOL_EXECUTION_PENDING'),
        settlement: 'outcome_unknown' as const,
        timedOut: false,
        blocksFurtherTools: true,
      };
    }
    let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
    const executorPromise = Promise.resolve()
      .then(() => executeInvocation(invocation, context))
      .then((result) => {
        if (result.error?.code === 'TOOL_TIMEOUT') {
          throw new JunLuoToolAgentExecutionContractError(
            'non_abortable executor returned TOOL_TIMEOUT without a host abort',
          );
        }
        return result;
      })
      .catch((error) => {
        if (error instanceof JunLuoToolAgentExecutionContractError) throw error;
        return executionFailureResult(invocation, 'EXECUTION_FAILED');
      });
    const deadline = new Promise<'deadline'>((resolve) => {
      deadlineHandle = scheduler.setTimeout(
        () => resolve('deadline'),
        policy.settlementDeadlineMs,
      );
    });
    let winner: { kind: 'result'; result: JunLuoToolResult } | { kind: 'deadline' };
    try {
      winner = await Promise.race([
        executorPromise.then((result) => ({ kind: 'result' as const, result })),
        deadline.then(() => ({ kind: 'deadline' as const })),
      ]);
    } finally {
      if (deadlineHandle !== undefined) scheduler.clearTimeout(deadlineHandle);
    }
    if (winner.kind === 'result') {
      await settleAttempt(winner.result);
      return {
        invocation,
        result: winner.result,
        settlement: 'settled' as const,
        timedOut: false,
        blocksFurtherTools: false,
      };
    }

    pendingRegistry.hold(conflictKey, hostExecutionId);
    if (attempt) await attemptJournal.markOutcomeUnknown(hostExecutionId, now());
    void executorPromise.then(async (result) => {
      pendingRegistry.clear(conflictKey, hostExecutionId);
      if (attempt) {
        await attemptJournal.markSettled(
          hostExecutionId,
          toolExecutionAttemptOutcomeFromResult(result),
          now(),
        );
      }
      try {
        if (onLateSettlement) await onLateSettlement({
          attempt,
          hostExecutionId,
          invocation,
          result,
          dataEpochStillCurrent: turn.isDataEpochCurrent(),
          sourceSessionId: turn.identity.sourceSessionId,
          turnId: turn.identity.turnId,
          continuationMessages: settlementMessages(invocation, result),
        });
        if (attempt && onLateSettlement) {
          await attemptJournal.acknowledgeDelivery(hostExecutionId);
        }
      } catch {
        // Keep settled_pending_delivery so startup can retry delivery without re-execution.
      }
    }).catch(() => undefined);
    return {
      invocation,
      result: executionFailureResult(invocation, 'TOOL_OUTCOME_UNKNOWN'),
      settlement: 'outcome_unknown' as const,
      timedOut: false,
      blocksFurtherTools: true,
    };
  }

  const controller = new AbortController();
  const abortFromTurn = () => controller.abort(turn.signal.reason);
  if (turn.signal.aborted) abortFromTurn();
  else turn.signal.addEventListener('abort', abortFromTurn, { once: true });
  let timedOut = false;
  let executorSettled = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let graceHandle: ReturnType<typeof setTimeout> | undefined;
  const contractFailure = new Promise<never>((_, reject) => {
    timeoutHandle = scheduler.setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('TOOL_TIMEOUT'));
      graceHandle = scheduler.setTimeout(() => {
        reject(new JunLuoToolAgentExecutionContractError(
          'abortable executor did not settle after its signal was aborted',
        ));
      }, abortSettlementGraceMs);
    }, policy.timeoutMs);
  });
  try {
    const result = await Promise.race([
      Promise.resolve(executeInvocation(invocation, { ...context, signal: controller.signal })),
      contractFailure,
    ]);
    if (result.error?.code === 'TOOL_TIMEOUT' && !timedOut) {
      throw new JunLuoToolAgentExecutionContractError(
        'abortable executor returned TOOL_TIMEOUT before the host deadline',
      );
    }
    executorSettled = true;
    await settleAttempt(result);
    return {
      invocation,
      result,
      settlement: result.error?.code === 'TOOL_TIMEOUT' ? 'aborted' as const : 'settled' as const,
      timedOut: result.error?.code === 'TOOL_TIMEOUT',
      blocksFurtherTools: false,
    };
  } catch (error) {
    if (error instanceof JunLuoToolAgentExecutionContractError) throw error;
    // A persistence error is not a second, failed tool execution.
    if (executorSettled) throw error;
    if (turn.signal.aborted && !timedOut) throw error;
    if (timedOut) {
      const timeoutResult = executionFailureResult(invocation, 'TOOL_TIMEOUT');
      await settleAttempt(timeoutResult);
      return {
        invocation,
        result: timeoutResult,
        settlement: 'aborted' as const,
        timedOut: true,
        blocksFurtherTools: false,
      };
    }
    const failureResult = executionFailureResult(invocation, 'EXECUTION_FAILED');
    await settleAttempt(failureResult);
    return {
      invocation,
      result: failureResult,
      settlement: 'settled' as const,
      timedOut: false,
      blocksFurtherTools: false,
    };
  } finally {
    if (timeoutHandle) scheduler.clearTimeout(timeoutHandle);
    if (graceHandle) scheduler.clearTimeout(graceHandle);
    turn.signal.removeEventListener('abort', abortFromTurn);
  }
}

async function executeRound(
  invocations: readonly JunLuoToolInvocation[],
  round: 1 | 2 | 3,
  executeInvocation: RunToolAgentLoopOptions['executeInvocation'],
  resolveInvocationGate: RunToolAgentLoopOptions['resolveInvocationGate'],
  reconfirmMemoryCorrection: RunToolAgentLoopOptions['reconfirmMemoryCorrection'],
  resolveExecutionPolicy: RunToolAgentLoopOptions['resolveExecutionPolicy'],
  abortSettlementGraceMs: number,
  scheduler: NonNullable<RunToolAgentLoopOptions['executionScheduler']>,
  now: () => number,
  attemptJournal: JunLuoToolExecutionAttemptJournal,
  pendingRegistry: JunLuoToolAgentPendingExecutionRegistry,
  enforceAgentEpochSafety: boolean,
  onSettlement: RunToolAgentLoopOptions['onSettlement'],
  onLateSettlement: RunToolAgentLoopOptions['onLateSettlement'],
  turn: JunLuoToolAgentTurnHandle,
) {
  const gates = new Map<JunLuoToolInvocation, JunLuoToolAgentInvocationGate>();
  const staticallyParallel = canExecuteRoundInParallel(invocations);
  if (resolveInvocationGate && staticallyParallel) {
    for (const invocation of invocations) {
      const semanticExecutionKey = createToolInvocationFingerprint(turn.identity.turnId, invocation);
      const gate = await resolveInvocationGate(invocation, {
        turnId: turn.identity.turnId,
        sourceMessageId: turn.identity.sourceMessageId,
        dataEpoch: turn.identity.dataEpoch,
        round,
        providerCallId: invocation.callId,
        semanticExecutionKey,
        hostExecutionId: createToolAgentHostExecutionId(semanticExecutionKey),
        signal: turn.signal,
      });
      gates.set(invocation, gate);
    }
  }
  const parallel = staticallyParallel
    && [...gates.values()].every((gate) => gate.kind === 'none');
  if (parallel) {
    turn.assertActive();
    const settled = await Promise.allSettled(
      invocations.map((invocation) => executeOneInvocation(
        invocation,
        gates.get(invocation),
        round,
        executeInvocation,
        resolveExecutionPolicy,
        abortSettlementGraceMs,
        scheduler,
        now,
        attemptJournal,
        pendingRegistry,
        enforceAgentEpochSafety,
        onSettlement,
        onLateSettlement,
        turn,
      )),
    );
    const rejected = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    return {
      parallel: true,
      interruption: rejected?.reason,
      blocksFurtherTools: settled.some((result) => (
        result.status === 'fulfilled' && result.value.blocksFurtherTools
      )),
      results: settled.flatMap((result, index) => (
        result.status === 'fulfilled'
          ? [result.value]
          : []
      )),
    };
  }
  const results: Array<{
    invocation: JunLuoToolInvocation;
    result: JunLuoToolResult;
    settlement: JunLuoToolAgentInvocationSettlement;
    timedOut: boolean;
    blocksFurtherTools: boolean;
  }> = [];
  for (let index = 0; index < invocations.length; index += 1) {
    const invocation = invocations[index];
    try {
      turn.assertActive();
    } catch (error) {
      return { interruption: error, results };
    }
    try {
      let gate = gates.get(invocation);
      if (!gate && resolveInvocationGate) {
        const semanticExecutionKey = createToolInvocationFingerprint(turn.identity.turnId, invocation);
        gate = await resolveInvocationGate(invocation, {
          turnId: turn.identity.turnId,
          sourceMessageId: turn.identity.sourceMessageId,
          dataEpoch: turn.identity.dataEpoch,
          round,
          providerCallId: invocation.callId,
          semanticExecutionKey,
          hostExecutionId: createToolAgentHostExecutionId(semanticExecutionKey),
          signal: turn.signal,
        });
      }
      let executedInvocation = invocation;
      let executed = await executeOneInvocation(
        invocation,
        gate,
        round,
        executeInvocation,
        resolveExecutionPolicy,
        abortSettlementGraceMs,
        scheduler,
        now,
        attemptJournal,
        pendingRegistry,
        enforceAgentEpochSafety,
        onSettlement,
        onLateSettlement,
        turn,
      );
      // A rejected version check has made no memory write. It is the only failure eligible
      // for another local review. Waiting happens outside the executor's settlement deadline.
      while (reconfirmMemoryCorrection && resolveInvocationGate
        && invocation.toolId === 'memory.update' && executed.settlement === 'settled'
        && !executed.timedOut && !executed.blocksFurtherTools && !executed.result.ok
        && executed.result.error?.code === 'VALIDATION_FAILED'
        && ['MEMORY_CORRECTION_STALE', 'MEMORY_EDIT_CONFLICT'].includes(executed.result.error.message)) {
        turn.assertActive();
        const revised = await reconfirmMemoryCorrection(executedInvocation, executed.result);
        turn.assertActive();
        if (!revised || revised.toolId !== invocation.toolId || revised.callId === executedInvocation.callId) break;
        const semanticExecutionKey = createToolInvocationFingerprint(turn.identity.turnId, revised);
        const revisedGate = await resolveInvocationGate(revised, {
          turnId: turn.identity.turnId, sourceMessageId: turn.identity.sourceMessageId,
          dataEpoch: turn.identity.dataEpoch, round, providerCallId: revised.callId,
          semanticExecutionKey, hostExecutionId: createToolAgentHostExecutionId(semanticExecutionKey), signal: turn.signal,
        });
        if (revisedGate.kind !== 'confirmation') break;
        executedInvocation = revised;
        executed = await executeOneInvocation(revised, revisedGate, round, executeInvocation,
          resolveExecutionPolicy, abortSettlementGraceMs, scheduler, now, attemptJournal,
          pendingRegistry, enforceAgentEpochSafety, onSettlement, onLateSettlement, turn);
      }
      results.push({ ...executed, invocation, result: { ...executed.result, callId: invocation.callId } });
    } catch (error) {
      return { interruption: error, results };
    }
    if (results.at(-1)?.blocksFurtherTools) {
      invocations.slice(index + 1).forEach((pendingInvocation) => {
        results.push({
          invocation: pendingInvocation,
          result: executionFailureResult(pendingInvocation, 'TOOL_NOT_STARTED'),
          settlement: 'settled',
          timedOut: false,
          blocksFurtherTools: false,
        });
      });
      return { parallel: false, blocksFurtherTools: true, results };
    }
    if (turn.signal.aborted) break;
  }
  return { parallel: false, blocksFurtherTools: false, results };
}

function isCancelledTurnError(error: unknown) {
  return error instanceof JunLuoToolAgentTurnError
    && (error.code === 'TURN_CANCELLED' || error.code === 'STALE_DATA_EPOCH');
}

export async function runToolAgentLoop(
  options: RunToolAgentLoopOptions,
): Promise<RunToolAgentLoopResult> {
  const { turn } = options;
  const now = options.now ?? Date.now;
  const scheduler = options.executionScheduler ?? {
    clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
  };
  const attemptJournal = options.executionAttemptJournal
    ?? createMemoryToolExecutionAttemptJournal(now);
  const pendingRegistry = options.pendingExecutionRegistry
    ?? createToolAgentPendingExecutionRegistry();
  const maxCandidates = options.maxCandidates ?? TOOL_AGENT_MAX_CANDIDATES;
  let candidates = options.bodyOnlyRetry ? [] : [...options.initialCandidates].slice(0, maxCandidates);
  let discoveryOffer = options.bodyOnlyRetry ? undefined : options.packageDiscovery;
  let discoveryPhase = !!discoveryOffer;
  let tools = discoveryOffer && !discoveryOffer.alongsideTools
    ? [createNativeToolPackageDiscoveryTool(discoveryOffer)]
    : candidates
      .filter((candidate) => (
        candidate.executionMode === 'executable'
        && candidate.authority?.allowedToolIds.includes(candidate.tool.id)
      ))
      .map((candidate) => candidate.tool);
  if (discoveryOffer?.alongsideTools) tools.push(createNativeToolPackageDiscoveryTool(discoveryOffer));
  const continuationMessages: JunLuoToolAgentContinuationMessage[] = [...options.bodyOnlyRetry?.continuationMessages ?? []];
  const completedResults: JunLuoToolResult[] = [...options.bodyOnlyRetry?.completedResults ?? []];
  const capabilityDiscoveries: JunLuoToolCapabilityDiscoverySnapshot[] = [];
  const resultByCallId = new Map(completedResults.map((result) => [result.callId, result]));
  const mutatingFingerprintResults = new Map<string, JunLuoToolResult>();
  const rootAllowedToolIds = new Set([
    ...options.initialCandidates.flatMap((candidate) => candidate.authority?.allowedToolIds ?? []),
    ...(options.packageDiscovery?.authority?.allowedToolIds ?? []),
  ]);
  let toolRounds = 0;
  let postMemoryMusic = false;
  let requestCount = 0;
  let protocolCorrectionAttempts = 0;
  let pendingReminderDraft = false;
  let pendingFinalDraftChoice = false;
  const finalDraftChoiceTools = (offered: readonly JunLuoRegisteredToolDefinition[]) => {
    if (options.allowFinalDraftCorrection !== true || options.finalDayPlanRepair?.allowed !== true
      || !options.reminderDraftContract || options.bodyOnlyRetry || postMemoryMusic || pendingReminderDraft
      || requestCount !== TOOL_AGENT_MAX_MODEL_REQUESTS - 1 || options.finalDayPlanRepair.remainingRequests() !== 1
      || options.reminderDraftContract.remainingRequests() !== 1 || options.reminderDraftContract.cardDelivered()
      || toolRounds !== 0 || completedResults.length !== 0 || resultByCallId.size !== 0
      || turn.getSnapshot().totalCallCount !== 0) return [];
    const chosen = offered.filter(tool => ['schedule.submit_day_plan', 'reminder.propose_reminders'].includes(tool.id)
      && candidates.some(candidate => candidate.tool === tool && candidate.executionMode === 'executable'
        && candidate.authority?.dataEpoch === turn.identity.dataEpoch
        && candidate.authority.allowedToolIds.includes(tool.id) && rootAllowedToolIds.has(tool.id)
        && ['available_confirmation', 'available_read', 'you_explicit', 'you_confirmation', 'pending_proposal', 'manual_activation']
          .includes(candidate.authority.kind)
        && (candidate.authority.issuedAt === undefined || candidate.authority.issuedAt <= now())
        && (candidate.authority.expiresAt === undefined || candidate.authority.expiresAt >= now())));
    return chosen.length === 2 && ['schedule.submit_day_plan', 'reminder.propose_reminders'].every(id => chosen.some(tool => tool.id === id))
      ? chosen : [];
  };
  let finalDayPlanRepairCandidate: JunLuoToolCandidateEntry | undefined;
  let invalidReminderAction = false;
  const diagnosticCounts = {
    acceptedCallCount: 0,
    rejectedCallCount: 0,
    parallelBatchCount: 0,
    serialBatchCount: 0,
    duplicateCallCount: 0,
    timedOutCallCount: 0,
    unknownOutcomeCallCount: 0,
    modelVisibleResultCharacters: 0,
  };

  const diagnostics = (): JunLuoToolAgentLoopDiagnostics => ({
    requestCount,
    toolRoundCount: toolRounds,
    ...diagnosticCounts,
  });

  const resultSnapshots = () => completedResults.map(createToolAgentResultSnapshot);
  const cancelledResult = (finishReason?: string): RunToolAgentLoopResult => {
    turn.finishCancellation(resultSnapshots());
    return {
      assistantText: '',
      capabilityDiscoveries,
      diagnostics: diagnostics(),
      finishReason,
      protocolCorrectionAttempts,
      requestCount,
      results: completedResults,
      state: turn.getSnapshot(),
      toolRounds,
    };
  };

  const failWithProtocol = (
    failure: JunLuoToolAgentProtocolFailure,
    finishReason?: string,
  ): RunToolAgentLoopResult => {
    turn.transition('failed', {
      completedResults: resultSnapshots(),
      failureCode: failure.code === 'MODEL_REQUEST_LIMIT' ? 'MODEL_REQUEST_LIMIT' : 'PROTOCOL_ERROR',
      pendingCalls: [],
    });
    return {
      assistantText: '',
      capabilityDiscoveries,
      diagnostics: diagnostics(),
      finishReason,
      protocolCorrectionAttempts,
      protocolFailure: failure,
      ...(pendingReminderDraft || invalidReminderAction ? { reminderDraftIncomplete: true as const } : {}),
      requestCount,
      results: completedResults,
      state: turn.getSnapshot(),
      toolRounds,
    };
  };

  try {
    turn.assertActive();
    turn.transition('deciding', { candidateToolIds: tools.map((tool) => tool.id) });
    for (;;) {
      turn.assertActive();
      if (options.isToolAvailableForRequest && (!discoveryPhase || discoveryOffer?.alongsideTools)) {
        const available = await Promise.all(tools.map(tool => options.isToolAvailableForRequest!(tool.id)));
        tools = tools.filter((_tool, index) => available[index]);
        turn.assertActive();
      }
      if (pendingReminderDraft) {
        if (!await options.reminderDraftContract!.isCurrent()) return failWithProtocol({ code: 'REMINDER_DRAFT_INCOMPLETE', callErrors: [], rawToolCallCount: 0 });
        turn.assertActive();
        if (options.reminderDraftContract!.remainingRequests() < 1) return failWithProtocol({ code: 'MODEL_REQUEST_LIMIT', callErrors: [], rawToolCallCount: 0 });
        if (tools.length !== 1 || tools[0].id !== 'reminder.propose_reminders') return failWithProtocol({ code: 'TOOL_NOT_ALLOWED', callErrors: [], rawToolCallCount: 0 });
      }
      const modelRequestLimit = options.bodyOnlyRetry ? 1 : TOOL_AGENT_MAX_MODEL_REQUESTS + (postMemoryMusic ? 1 : 0);
      if (requestCount >= modelRequestLimit) {
        return failWithProtocol({
          code: 'MODEL_REQUEST_LIMIT',
          callErrors: [],
          rawToolCallCount: 0,
        });
      }
      if (pendingFinalDraftChoice) {
        if (!await options.reminderDraftContract!.isCurrent()) return failWithProtocol({ code: 'REMINDER_DRAFT_INCOMPLETE', callErrors: [], rawToolCallCount: 0 });
        turn.assertActive();
      }
      const finalDraftChoice = pendingFinalDraftChoice && finalDraftChoiceTools(tools).length === 2;
      if (pendingFinalDraftChoice && !finalDraftChoice) return failWithProtocol({ code: 'TOOL_NOT_ALLOWED', callErrors: [], rawToolCallCount: 0 });
      const finalDayPlanRepair = options.finalDayPlanRepair?.allowed === true
        && !options.bodyOnlyRetry && !postMemoryMusic && !pendingReminderDraft
        && modelRequestLimit === TOOL_AGENT_MAX_MODEL_REQUESTS
        && requestCount === TOOL_AGENT_MAX_MODEL_REQUESTS - 1
        && options.finalDayPlanRepair.remainingRequests() === 1
        && toolRounds < TOOL_AGENT_MAX_ROUNDS
        && !!finalDayPlanRepairCandidate
        && tools.length === 1 && tools[0] === finalDayPlanRepairCandidate.tool
        && finalDayPlanRepairCandidate.executionMode === 'executable'
        && finalDayPlanRepairCandidate.authority?.allowedToolIds.includes(tools[0].id) === true;
      let allowTools = toolRounds < TOOL_AGENT_MAX_ROUNDS + (postMemoryMusic ? 1 : 0)
        && tools.length > 0
        && (pendingReminderDraft || finalDayPlanRepair || finalDraftChoice || requestCount < modelRequestLimit - 1);
      if (!allowTools && turn.getSnapshot().status !== 'finalizing') {
        turn.transition('finalizing');
      }
      let finalDraftCorrectionRequest = finalDraftChoice;
      let modelRequest: JunLuoToolAgentModelRequest = {
        allowTools,
        completedResults: [...completedResults],
        continuationMessages,
        requestKind: discoveryPhase && !discoveryOffer?.alongsideTools && allowTools
          ? 'package_discovery'
          : allowTools
            ? 'concrete_tools'
            : 'final',
        responseInstruction: pendingReminderDraft ? options.reminderDraftContract!.continuationInstruction : discoveryPhase && allowTools
          ? discoveryOffer?.catalogInstruction
          : undefined,
        signal: turn.signal,
        toolChoice: allowTools && !finalDayPlanRepair && !finalDraftChoice && (pendingReminderDraft || options.requireToolCallForCandidates?.(candidates))
          ? 'required'
          : 'auto',
        toolRound: toolRounds as 0 | 1 | 2 | 3,
        tools: allowTools ? tools : [],
      };
      requestCount += 1;
      pendingFinalDraftChoice = false;
      let modelTurn: JunLuoToolAgentModelTurn;
      try {
        modelTurn = await options.requestModel(modelRequest);
      } catch (error) {
        if (pendingReminderDraft) throw new Error('REMINDER_DRAFT_INCOMPLETE', { cause: error });
        // A provider-empty final reply may use the remaining slot, but never
        // repeat execution or turn an unrelated transport error into a retry.
        if (
          !(error instanceof Error && 'kind' in error && error.kind === 'empty_response')
          || options.allowEmptyResponseRetry === false
          || (completedResults.length === 0 && !options.emptyResponseRetryInstruction)
          || requestCount >= modelRequestLimit
        ) throw error;
        turn.assertActive();
        allowTools = false;
        modelRequest = {
          ...modelRequest,
          allowTools: false,
          tools: [],
          toolChoice: 'auto',
          requestKind: 'final',
          responseInstruction: options.emptyResponseRetryInstruction,
        };
        if (turn.getSnapshot().status !== 'finalizing') turn.transition('finalizing');
        requestCount += 1;
        modelTurn = await options.requestModel(modelRequest);
      }
      turn.assertActive();
      const inspectReminderAction = () => {
        invalidReminderAction = !!options.reminderDraftContract && rawToolCallCount(modelTurn) === 0
          && (!modelTurn.reminderAction || modelTurn.reminderAction.sourceMessageId !== turn.identity.sourceMessageId
            || ![null, 'create_draft', 'clarify'].includes(modelTurn.reminderAction.choice));
        return invalidReminderAction ? { code: 'INVALID_REPLY_FORMAT' as const, callErrors: [],
          rawToolCallCount: 0, finishReason: modelTurn.finishReason,
          ...(!modelTurn.reminderAction ? {
            ...(modelTurn.reminderActionIssue ? { reminderActionIssue: modelTurn.reminderActionIssue } : {}),
            ...(modelTurn.reminderActionDirectIssue ? { reminderActionDirectIssue: modelTurn.reminderActionDirectIssue } : {}),
            ...(modelTurn.reminderVisibleReplySource ? { reminderVisibleReplySource: modelTurn.reminderVisibleReplySource } : {}),
            ...(modelTurn.reminderActionRootFailure ? { reminderActionRootFailure: modelTurn.reminderActionRootFailure } : {}),
            ...(modelTurn.reminderActionDirectRootFailure ? { reminderActionDirectRootFailure: modelTurn.reminderActionDirectRootFailure } : {}),
          } : {}),
          replyFormatReason: !modelTurn.reminderAction ? 'reminder_action_contract_missing' as const
            : modelTurn.reminderAction.sourceMessageId !== turn.identity.sourceMessageId
              ? 'reminder_source_mismatch' as const : 'reminder_choice_invalid' as const } : undefined;
      };
      let reminderActionFailure = inspectReminderAction();
      let protocolFailure = inspectModelTurnProtocol({
        allowTools,
        hostOnlyAllowedToolIds: discoveryPhase ? ['system.use_package', ...(options.hostOnlyAllowedToolIds ?? [])] : options.hostOnlyAllowedToolIds,
        resultByCallId,
        tools: modelRequest.tools,
        turn: modelTurn,
      }) ?? reminderActionFailure;
      if (
        !protocolFailure
        && modelRequest.toolChoice === 'required'
        && modelTurn.toolInvocations.length === 0
      ) {
        protocolFailure = {
          code: 'INVALID_TOOL_CALL_BATCH',
          callErrors: [],
          finishReason: modelTurn.finishReason,
          rawToolCallCount: rawToolCallCount(modelTurn),
        };
      }
      if (
        protocolFailure
        && !pendingReminderDraft
        && protocolCorrectionAttempts === 0
        && (requestCount === 1 || protocolFailure.code === 'INVALID_REPLY_FORMAT')
        && requestCount < modelRequestLimit
        && options.requestProtocolCorrection
      ) {
        protocolCorrectionAttempts = 1;
        requestCount += 1;
        const finalDraftTools = options.allowFinalDraftCorrection === true
          && options.finalDayPlanRepair?.allowed === true && !!options.reminderDraftContract
          && protocolFailure.code === 'INVALID_REPLY_FORMAT' && protocolFailure.rawToolCallCount === 0
          && !options.bodyOnlyRetry && !postMemoryMusic && modelRequestLimit === TOOL_AGENT_MAX_MODEL_REQUESTS
          && requestCount === modelRequestLimit && options.finalDayPlanRepair.remainingRequests() === 1
          && toolRounds < TOOL_AGENT_MAX_ROUNDS && resultByCallId.size > 0
          && [...resultByCallId.values()].every(result => result.ok && result.status === 'success'
            && ['schedule.query_agenda', 'reminder.query'].includes(result.toolId))
          ? modelRequest.tools.filter(tool => ['schedule.submit_day_plan', 'reminder.propose_reminders'].includes(tool.id)
            && candidates.some(candidate => candidate.tool === tool && candidate.executionMode === 'executable'
              && candidate.authority?.dataEpoch === turn.identity.dataEpoch
              && candidate.authority.allowedToolIds.includes(tool.id) && rootAllowedToolIds.has(tool.id)
              && ['available_confirmation', 'available_read', 'you_explicit', 'you_confirmation', 'pending_proposal', 'manual_activation']
                .includes(candidate.authority.kind)
              && (candidate.authority.issuedAt === undefined || candidate.authority.issuedAt <= now())
              && (candidate.authority.expiresAt === undefined || candidate.authority.expiresAt >= now())))
          : [];
        if (finalDraftTools.length) {
          finalDraftCorrectionRequest = true;
          allowTools = true;
          modelRequest = { ...modelRequest, allowTools: true, tools: finalDraftTools, toolChoice: 'auto', requestKind: 'concrete_tools' };
        } else if (protocolFailure.code === 'INVALID_REPLY_FORMAT'
          && (resultByCallId.size > 0 || requestCount === modelRequestLimit)) {
          // Repair only the reply; keep committed receipts and never repeat execution.
          allowTools = false;
          modelRequest = { ...modelRequest, allowTools: false, tools: [], toolChoice: 'auto', requestKind: 'final' };
          if (turn.getSnapshot().status !== 'finalizing') turn.transition('finalizing');
        }
        modelTurn = await options.requestProtocolCorrection({
          ...modelRequest,
          failure: protocolFailure,
          previousTurn: modelTurn,
        });
        turn.assertActive();
        reminderActionFailure = inspectReminderAction();
        protocolFailure = inspectModelTurnProtocol({
          allowTools,
          hostOnlyAllowedToolIds: discoveryPhase ? ['system.use_package', ...(options.hostOnlyAllowedToolIds ?? [])] : options.hostOnlyAllowedToolIds,
          resultByCallId,
          tools: modelRequest.tools,
          turn: modelTurn,
        }) ?? reminderActionFailure;
        if (
          !protocolFailure
          && modelRequest.toolChoice === 'required'
          && modelTurn.toolInvocations.length === 0
        ) {
          protocolFailure = {
            code: 'INVALID_TOOL_CALL_BATCH',
            callErrors: [],
            finishReason: modelTurn.finishReason,
            rawToolCallCount: rawToolCallCount(modelTurn),
          };
        }
      }
      if (protocolFailure) {
        return failWithProtocol(protocolFailure, modelTurn.finishReason);
      }
      if (finalDraftCorrectionRequest && rawToolCallCount(modelTurn) > 0
        && (rawToolCallCount(modelTurn) !== 1 || modelTurn.toolInvocations.length !== 1)) {
        return failWithProtocol({ code: 'INVALID_TOOL_CALL_BATCH', callErrors: [],
          rawToolCallCount: rawToolCallCount(modelTurn), finishReason: modelTurn.finishReason }, modelTurn.finishReason);
      }

      const mixedDiscovery = !!discoveryOffer?.alongsideTools
        && modelTurn.toolInvocations.some(invocation => invocation.toolId === 'system.use_package')
        && modelTurn.toolInvocations.some(invocation => invocation.toolId !== 'system.use_package');
      if (discoveryOffer?.alongsideTools && modelTurn.toolInvocations.length
        && (mixedDiscovery || !modelTurn.toolInvocations.some(invocation => invocation.toolId === 'system.use_package'))) {
        discoveryOffer = undefined; discoveryPhase = false;
        tools = tools.filter(tool => tool.id !== 'system.use_package');
      }
      if (discoveryPhase && allowTools && modelTurn.toolInvocations.length > 0) {
        const round = 1;
        const invocations = modelTurn.toolInvocations;
        const discoveryResults = await Promise.all(invocations.map(async (invocation) => {
          const result = (
          invocations.length === 1 && discoveryOffer
            ? resolveToolCapabilityDiscovery({
                callId: invocation.callId,
                arguments: invocation.input,
                offer: discoveryOffer,
              })
            : rejectToolCapabilityDiscoveryLimit(invocation.callId)
          );
          return options.resolvePackageDiscovery ? options.resolvePackageDiscovery(invocation, result) : result;
        }));
        const pendingCalls = invocations.map((invocation) => createToolAgentPendingCallSnapshot({
          callId: invocation.callId,
          toolId: invocation.toolId,
          arguments: invocation.input,
          round,
        }));
        turn.transition('executing', {
          candidateToolIds: ['system.use_package'],
          pendingCalls,
          toolRound: round,
          discoveryCallCount: 1,
        });
        capabilityDiscoveries.push(...discoveryResults.map((result) => result.snapshot));
        discoveryResults.forEach((result) => {
          const now = Date.now();
          try {
            void Promise.resolve(options.onDiagnosticToolEvent?.({ kind: 'package',
              callId: result.snapshot.callId,
              name: result.snapshot.packageIds.join(', ') || 'system.use_package',
              status: result.snapshot.status === 'package_discovery_rejected' ? 'failed' : 'success', at: now,
            })).catch(() => undefined);
          } catch { /* Diagnostics cannot affect package selection. */ }
          resultByCallId.set(result.snapshot.callId, {
            callId: result.snapshot.callId,
            toolId: 'system.use_package',
            ok: result.snapshot.status !== 'package_discovery_rejected',
            status: result.snapshot.status === 'package_discovery_rejected' ? 'error' : 'success',
            summary: '',
            startedAt: now,
            finishedAt: now,
          });
        });
        toolRounds = round;
        turn.assertActive();
        turn.transition('feeding_result', {
          capabilityDiscoveries: capabilityDiscoveries.map((result) => ({
            ...result,
            packageIds: [...result.packageIds],
            toolIds: [...result.toolIds],
          })),
          pendingCalls: [],
        });
        if (discoveryResults.some(result => result.snapshot.packageIds.includes('phone_limit'))
          && (discoveryResults.some(result => result.content.length > TOOL_AGENT_MAX_MODEL_RESULT_CHARACTERS)
            || discoveryResults.reduce((sum, result) => sum + result.content.length, 0) > TOOL_AGENT_MAX_MODEL_RESULTS_PER_ROUND_CHARACTERS)) {
          throw new JunLuoToolAgentExecutionContractError('phone discovery exceeds the existing model budget');
        }
        continuationMessages.push(
          assistantMessage(modelTurn),
          ...discoveryResults.map((result, index) => (
            capabilityDiscoveryMessage(invocations[index].callId, result)
          )),
        );
        const ready = discoveryResults.length === 1
          && discoveryResults[0].snapshot.status === 'tools_ready'
          ? discoveryResults[0]
          : undefined;
        candidates = discoveryOffer?.alongsideTools
          ? [...candidates, ...(ready?.candidates ?? []).filter(next => !candidates.some(old => old.tool.id === next.tool.id))]
          : ready?.candidates ?? [];
        rootAllowedToolIds.clear();
        candidates.forEach((candidate) => {
          if (candidate.authority?.allowedToolIds.includes(candidate.tool.id)) {
            rootAllowedToolIds.add(candidate.tool.id);
          }
        });
        tools = candidates
          .filter((candidate) => (
            candidate.executionMode === 'executable'
            && candidate.authority?.allowedToolIds.includes(candidate.tool.id)
            && rootAllowedToolIds.has(candidate.tool.id)
          ))
          .map((candidate) => candidate.tool);
        discoveryOffer = undefined;
        discoveryPhase = false;
        turn.assertActive();
        turn.transition('deciding', {
          candidateToolIds: tools.map((tool) => tool.id),
        });
        continue;
      }

      if (options.reminderDraftContract && rawToolCallCount(modelTurn) === 0
        && modelTurn.reminderAction?.choice === 'create_draft') {
        const choiceTools = finalDraftChoiceTools(modelRequest.tools);
        if (choiceTools.length === 2) {
          pendingFinalDraftChoice = true;
          tools = choiceTools;
          candidates = candidates.filter(candidate => tools.includes(candidate.tool));
          discoveryPhase = false;
          discoveryOffer = undefined;
          continue;
        }
        pendingReminderDraft = true;
        options.reminderDraftContract.onRequired();
        if (!await options.reminderDraftContract.isCurrent()) return failWithProtocol({ code: 'REMINDER_DRAFT_INCOMPLETE', callErrors: [], rawToolCallCount: 0 });
        turn.assertActive();
        if (options.reminderDraftContract.remainingRequests() < 1) return failWithProtocol({ code: 'MODEL_REQUEST_LIMIT', callErrors: [], rawToolCallCount: 0 });
        // Start from this request's actual offered tools, never from the catalog.
        tools = modelRequest.tools.filter(tool => tool.id === 'reminder.propose_reminders');
        candidates = candidates.filter(candidate => tools.includes(candidate.tool));
        if (tools.length !== 1) return failWithProtocol({ code: 'TOOL_NOT_ALLOWED', callErrors: [], rawToolCallCount: 0 });
        discoveryPhase = false;
        discoveryOffer = undefined;
        continue;
      }

      if (!allowTools || modelTurn.toolInvocations.length === 0) {
        if (turn.getSnapshot().status !== 'finalizing') turn.transition('finalizing');
        turn.assertActive();
        turn.transition('completed', {
          completedResults: resultSnapshots(),
          pendingCalls: [],
        });
        return {
          ...(options.allowPhoneEmergencySilence && modelTurn.silent === true
            && modelTurn.finishReason === 'stop' && rawToolCallCount(modelTurn) === 0
            ? { silent: true as const } : {}),
          assistantText: modelTurn.assistantText,
          capabilityDiscoveries,
          diagnostics: diagnostics(),
          finishReason: modelTurn.finishReason,
          protocolCorrectionAttempts,
          requestCount,
          results: completedResults,
          state: turn.getSnapshot(),
          toolRounds,
        };
      }

      const round = (toolRounds + 1) as 1 | 2 | 3;
      const remainingTurnCapacity = Math.max(
        0,
        TOOL_AGENT_MAX_CALLS_PER_TURN - turn.getSnapshot().totalCallCount,
      );
      const roundCapacity = Math.min(TOOL_AGENT_MAX_CALLS_PER_ROUND, remainingTurnCapacity);
      const accepted: JunLuoToolInvocation[] = [];
      const structurallyAccepted: JunLuoToolInvocation[] = [];
      const rejectedByInvocation = new Map<JunLuoToolInvocation, JunLuoToolResult>();
      const allowedToolIds = new Set(tools.map((tool) => tool.id));
      const candidateByToolId = new Map(candidates.map((candidate) => [candidate.tool.id, candidate]));
      const seenRoundCallIds = new Set<string>();
      const seenRoundMutationFingerprints = new Set<string>();

      const reject = (
        invocation: JunLuoToolInvocation,
        code: 'DUPLICATE_TOOL_CALL' | 'TOOL_LIMIT_EXCEEDED' | 'TOOL_DISABLED',
      ) => {
        if (rejectedByInvocation.has(invocation)) return;
        rejectedByInvocation.set(invocation, createRejectedResult(invocation, code));
        diagnosticCounts.rejectedCallCount += 1;
        if (code === 'DUPLICATE_TOOL_CALL') diagnosticCounts.duplicateCallCount += 1;
      };

      const sideEffectfulOverLimitBatch = modelTurn.toolInvocations.length > roundCapacity
        && modelTurn.toolInvocations.some((invocation) => {
          const tool = getToolDefinition(invocation.toolId);
          const toolPackage = tool
            ? listToolPackages().find((item) => item.id === tool.packageId)
            : undefined;
          return !tool?.readOnly || toolPackage?.source !== 'builtin';
        });

      if (sideEffectfulOverLimitBatch) {
        modelTurn.toolInvocations.forEach((invocation) => {
          reject(
            invocation,
            'TOOL_LIMIT_EXCEEDED',
          );
        });
      } else modelTurn.toolInvocations.forEach((invocation) => {
        // Opening a package still needs its own discovery opportunity. A mixed
        // batch rejects only that opening, never swallows ordinary/control tools.
        if (mixedDiscovery && invocation.toolId === 'system.use_package') {
          reject(invocation, 'TOOL_LIMIT_EXCEEDED'); return;
        }
        const tool = getToolDefinition(invocation.toolId);
        const candidate = candidateByToolId.get(invocation.toolId);
        if (
          !tool
          || !allowedToolIds.has(invocation.toolId)
          || !candidate
          || candidate.executionMode !== 'executable'
          || !candidate.authority
          || tool.chatExposure === 'disabled'
          || (tool.chatExposure === 'internal_only' && !options.hostOnlyAllowedToolIds?.includes(tool.id))
        ) {
          reject(
            invocation,
            'TOOL_DISABLED',
          );
          return;
        }
        if (seenRoundCallIds.has(invocation.callId) || resultByCallId.has(invocation.callId)) {
          reject(
            invocation,
            'DUPLICATE_TOOL_CALL',
          );
          return;
        }
        seenRoundCallIds.add(invocation.callId);
        if (options.prepareInvocation) {
          const prepared = options.prepareInvocation(invocation, {
            turnId: turn.identity.turnId,
            sourceMessageId: turn.identity.sourceMessageId,
            dataEpoch: turn.identity.dataEpoch,
            round,
            providerCallId: invocation.callId,
          });
          if (prepared.kind === 'rejected') {
            rejectedByInvocation.set(invocation, prepared.result);
            diagnosticCounts.rejectedCallCount += 1;
            return;
          }
          invocation.input = prepared.input;
        }
        const fingerprint = createToolInvocationFingerprint(turn.identity.turnId, invocation);
        const previousMutation = !tool.readOnly
          ? mutatingFingerprintResults.get(fingerprint)
          : undefined;
        if (previousMutation || (!tool.readOnly && seenRoundMutationFingerprints.has(fingerprint))) {
          reject(
            invocation,
            'DUPLICATE_TOOL_CALL',
          );
          return;
        }
        if (structurallyAccepted.length >= roundCapacity) {
          reject(
            invocation,
            'TOOL_LIMIT_EXCEEDED',
          );
          return;
        }
        if (!tool.readOnly) seenRoundMutationFingerprints.add(fingerprint);
        structurallyAccepted.push(invocation);
      });

      for (const invocation of structurallyAccepted) {
        const candidate = candidateByToolId.get(invocation.toolId);
        const authority = candidate?.authority;
        const now = options.now?.() ?? Date.now();
        const authorityAccepted = !!authority
          && ['available_confirmation', 'available_read', 'you_explicit', 'you_confirmation', 'pending_proposal', 'manual_activation'].includes(authority.kind)
          && authority.dataEpoch === turn.identity.dataEpoch
          && authority.allowedToolIds.includes(invocation.toolId)
          && rootAllowedToolIds.has(invocation.toolId)
          && (authority.issuedAt === undefined || authority.issuedAt <= now)
          && (authority.expiresAt === undefined || authority.expiresAt >= now);
        turn.assertActive();
        if (!authorityAccepted) {
          reject(
            invocation,
            'TOOL_DISABLED',
          );
          continue;
        }
        accepted.push(invocation);
      }

      if (finalDraftCorrectionRequest && accepted.length === 1
        && accepted[0].toolId === 'reminder.propose_reminders') {
        pendingReminderDraft = true;
        options.reminderDraftContract!.onRequired();
        if (!await options.reminderDraftContract!.isCurrent()) return failWithProtocol({
          code: 'REMINDER_DRAFT_INCOMPLETE', callErrors: [], rawToolCallCount: rawToolCallCount(modelTurn) });
        turn.assertActive();
      }
      diagnosticCounts.acceptedCallCount += accepted.length;

      const pendingCalls = accepted.map((invocation) => createToolAgentPendingCallSnapshot({
        callId: invocation.callId,
        toolId: invocation.toolId,
        arguments: invocation.input,
        round,
      }));
      const previousTotalCallCount = turn.getSnapshot().totalCallCount;
      turn.transition('executing', {
        candidateToolIds: tools.map((tool) => tool.id),
        pendingCalls,
        toolRound: round,
        totalCallCount: previousTotalCallCount + accepted.length,
      });
      const startedInvocations = new Set<string>();
      const execution = await executeRound(
        accepted,
        round,
        (invocation, context) => {
          startedInvocations.add(invocation.callId);
          return options.executeInvocation(invocation, context);
        },
        options.resolveInvocationGate,
        options.reconfirmMemoryCorrection,
        options.resolveExecutionPolicy,
        options.abortSettlementGraceMs ?? TOOL_AGENT_ABORT_SETTLEMENT_GRACE_MS,
        scheduler,
        now,
        attemptJournal,
        pendingRegistry,
        options.enforceAgentEpochSafety === true,
        options.onSettlement,
        options.onLateSettlement,
        turn,
      );
      if (accepted.length > 0) {
        if (execution.parallel) diagnosticCounts.parallelBatchCount += 1;
        else diagnosticCounts.serialBatchCount += 1;
      }
      diagnosticCounts.timedOutCallCount += execution.results.filter((item) => item.timedOut).length;
      diagnosticCounts.unknownOutcomeCallCount += execution.results.filter(
        (item) => item.result.error?.code === 'TOOL_OUTCOME_UNKNOWN',
      ).length;
      const executedByInvocation = new Map(
        execution.results.map(({ invocation, result }) => [invocation, result] as const),
      );
      const roundResults = modelTurn.toolInvocations
        .map((invocation) => executedByInvocation.get(invocation) ?? rejectedByInvocation.get(invocation))
        .filter((result): result is JunLuoToolResult => !!result);
      roundResults.forEach((result) => {
        try {
          void Promise.resolve(options.onDiagnosticToolEvent?.({ kind: 'execution', name: result.toolId,
            callId: result.callId,
            status: !startedInvocations.has(result.callId) ? 'skipped' : result.ok ? 'success'
              : result.error?.code === 'TOOL_OUTCOME_UNKNOWN' ? 'unknown'
                : result.status === 'cancelled' ? 'cancelled' : 'failed',
            at: result.finishedAt ?? now(),
          })).catch(() => undefined);
        } catch { /* Diagnostics cannot affect tool execution. */ }
        resultByCallId.set(result.callId, result);
        const tool = getToolDefinition(result.toolId);
        const invocation = accepted.find((item) => item.callId === result.callId);
        if (tool && invocation && !tool.readOnly) {
          mutatingFingerprintResults.set(
            createToolInvocationFingerprint(turn.identity.turnId, invocation),
            result,
          );
        }
      });
      completedResults.push(...roundResults);
      toolRounds = round;
      if (execution.interruption || turn.signal.aborted || turn.getSnapshot().cancellation) {
        if (turn.signal.aborted || turn.getSnapshot().cancellation) return cancelledResult();
        throw execution.interruption;
      }
      turn.assertActive();
      turn.transition('feeding_result', {
        completedResults: resultSnapshots(),
        pendingCalls: [],
      });
      const visibleCardDelivered = await options.completeWithVisibleCard?.(roundResults);
      if (pendingReminderDraft && (!visibleCardDelivered || !options.reminderDraftContract!.cardDelivered()
        || !roundResults.some(result => result.ok && result.toolId === 'reminder.propose_reminders'))) {
        return failWithProtocol({ code: 'REMINDER_DRAFT_INCOMPLETE', callErrors: [], rawToolCallCount: rawToolCallCount(modelTurn) });
      }
      if (visibleCardDelivered) {
        turn.assertActive();
        turn.transition('finalizing');
        turn.transition('completed');
        return {
          completedWithVisibleCard: true, assistantText: '', capabilityDiscoveries,
          diagnostics: diagnostics(), protocolCorrectionAttempts, requestCount,
          results: completedResults, state: turn.getSnapshot(), toolRounds,
        };
      }
      const modelResults = projectRoundResultsForModel(
        roundResults,
        modelTurn.toolInvocations,
        round,
        turn,
        options.projectResultForModel,
      );
      const visibleResults = roundResultMessages(modelResults);
      diagnosticCounts.modelVisibleResultCharacters += visibleResults.characters;
      continuationMessages.push(
        assistantMessage(modelTurn),
        ...visibleResults.messages,
      );
      const failedDayPlan = roundResults.find(result => result.toolId === 'schedule.submit_day_plan'
        && !result.ok && result.error?.code === 'EXECUTION_FAILED'
        && (result.error.message === 'schedule-target-not-queried' || isDayPlanRepeatFrequencyFailure(result) || !!knownDayPlanResultIssues(result))
        && startedInvocations.has(result.callId));
      const offeredDayPlans = modelRequest.tools.filter(tool => tool.id === 'schedule.submit_day_plan');
      finalDayPlanRepairCandidate = options.finalDayPlanRepair?.allowed === true && failedDayPlan
        && !options.bodyOnlyRetry && !postMemoryMusic && !pendingReminderDraft && !execution.blocksFurtherTools
        && modelRequestLimit === TOOL_AGENT_MAX_MODEL_REQUESTS
        && requestCount === TOOL_AGENT_MAX_MODEL_REQUESTS - 1
        && options.finalDayPlanRepair.remainingRequests() === 1 && toolRounds < TOOL_AGENT_MAX_ROUNDS
        && offeredDayPlans.length === 1
        ? candidates.find(candidate => candidate.tool === offeredDayPlans[0]
          && candidate.executionMode === 'executable' && candidate.authority?.allowedToolIds.includes(candidate.tool.id))
        : undefined;
      if (
        options.allowPostMemoryMusic && toolRounds === TOOL_AGENT_MAX_ROUNDS && !execution.blocksFurtherTools
        && completedResults.some((result) => result.toolId === 'memory.update' && result.ok)
        && !completedResults.some((result) => result.toolId === 'music.play')
        && candidates.some((candidate) => candidate.tool.id === 'music.play')
      ) {
        postMemoryMusic = true;
        candidates = candidates.filter((candidate) => candidate.tool.id === 'music.play');
        tools = candidates.map((candidate) => candidate.tool);
      } else if (toolRounds >= TOOL_AGENT_MAX_ROUNDS || execution.blocksFurtherTools) {
        candidates = [];
        tools = [];
      } else {
        candidates = options.selectFollowUpCandidates
          ? [...options.selectFollowUpCandidates(roundResults, candidates)].slice(0, maxCandidates)
          : candidates;
        candidates = candidates.filter((candidate) => (
          candidate.executionMode !== 'executable'
          || (
            candidate.authority?.allowedToolIds.includes(candidate.tool.id) === true
            && rootAllowedToolIds.has(candidate.tool.id)
          )
        ));
        tools = candidates
          .filter((candidate) => (
            candidate.executionMode === 'executable'
            && candidate.authority?.allowedToolIds.includes(candidate.tool.id)
          ))
          .map((candidate) => candidate.tool);
      }
      if (finalDayPlanRepairCandidate) {
        candidates = candidates.filter(candidate => candidate === finalDayPlanRepairCandidate);
        tools = tools.filter(tool => tool === finalDayPlanRepairCandidate!.tool);
      }
      turn.assertActive();
      turn.transition('deciding', {
        candidateToolIds: tools.map((tool) => tool.id),
      });
    }
  } catch (error) {
    if (turn.signal.aborted || isCancelledTurnError(error) || turn.getSnapshot().cancellation) {
      return cancelledResult();
    }
    const state = turn.getSnapshot();
    if (state.status !== 'failed' && state.status !== 'cancelled' && state.status !== 'completed') {
      turn.transition('failed', {
        completedResults: resultSnapshots(),
        failureCode: state.status === 'deciding' || state.status === 'finalizing'
          ? 'PROVIDER_ERROR'
          : 'HOST_ERROR',
        pendingCalls: [],
      });
    }
    if (error instanceof JunLuoToolAgentExecutionContractError) {
      return {
        assistantText: '',
        capabilityDiscoveries,
        diagnostics: diagnostics(),
        protocolCorrectionAttempts,
        ...(pendingReminderDraft ? { reminderDraftIncomplete: true as const } : {}),
        requestCount,
        results: completedResults,
        state: turn.getSnapshot(),
        toolRounds,
      };
    }
    throw error;
  }
}
