import { JunLuoToolAgentTurnError, type JunLuoToolAgentFailureCode } from './toolAgentErrors';
import type { JunLuoToolCapabilityDiscoverySnapshot } from './toolCapabilityDiscovery';
import type { JunLuoToolResult, JunLuoToolResultStatus } from './toolTypes';

export type JunLuoToolAgentTurnStatus =
  | 'idle'
  | 'deciding'
  | 'awaiting_permission'
  | 'awaiting_confirmation'
  | 'executing'
  | 'feeding_result'
  | 'finalizing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type JunLuoToolAgentTurnIdentity = {
  turnId: string;
  sourceMessageId: string;
  sourceSessionId: string;
  dataEpoch: number;
  createdAt: number;
};

export type JunLuoToolAgentPendingCallSnapshot = {
  callId: string;
  toolId: string;
  round: 1 | 2 | 3;
  argumentKeys: string[];
  argumentCharacterCount: number;
};

export type JunLuoToolAgentResultSnapshot = {
  callId: string;
  toolId: string;
  ok: boolean;
  status: JunLuoToolResultStatus;
  errorCode?: string;
};

export type JunLuoToolAgentPendingGate =
  | {
      kind: 'permission';
      callIds: string[];
    }
  | {
      kind: 'confirmation';
      callIds: string[];
      proposalId: string;
      expiresAt: number;
    };

export type JunLuoToolAgentCancelReason =
  | 'you_stopped'
  | 'source_session_cleared'
  | 'source_session_deleted'
  | 'source_message_removed'
  | 'confirmation_expired'
  | 'stale_data_epoch'
  | 'controller_disposed';

export type JunLuoToolAgentCancellationSnapshot = {
  reason: JunLuoToolAgentCancelReason;
  requestedAt: number;
};

export type JunLuoToolAgentTurnContext = {
  identity: JunLuoToolAgentTurnIdentity;
  status: JunLuoToolAgentTurnStatus;
  candidateToolIds: string[];
  toolRound: 0 | 1 | 2 | 3;
  totalCallCount: number;
  discoveryCallCount: 0 | 1;
  capabilityDiscoveries: JunLuoToolCapabilityDiscoverySnapshot[];
  pendingCalls: JunLuoToolAgentPendingCallSnapshot[];
  completedResults: JunLuoToolAgentResultSnapshot[];
  pendingGate?: JunLuoToolAgentPendingGate;
  cancellation?: JunLuoToolAgentCancellationSnapshot;
  failureCode?: JunLuoToolAgentFailureCode;
  updatedAt: number;
  finishedAt?: number;
};

const ALLOWED_TRANSITIONS: Record<JunLuoToolAgentTurnStatus, JunLuoToolAgentTurnStatus[]> = {
  idle: ['deciding', 'failed', 'cancelled'],
  deciding: ['awaiting_permission', 'awaiting_confirmation', 'executing', 'finalizing', 'failed', 'cancelled'],
  awaiting_permission: ['executing', 'feeding_result', 'failed', 'cancelled'],
  awaiting_confirmation: ['executing', 'feeding_result', 'failed', 'cancelled'],
  executing: ['awaiting_permission', 'awaiting_confirmation', 'feeding_result', 'failed', 'cancelled'],
  feeding_result: ['deciding', 'finalizing', 'failed', 'cancelled'],
  finalizing: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createToolAgentTurn(input: {
  identity: JunLuoToolAgentTurnIdentity;
  candidateToolIds: readonly string[];
  now?: number;
}): JunLuoToolAgentTurnContext {
  const now = input.now ?? Date.now();
  return {
    identity: { ...input.identity },
    status: 'idle',
    candidateToolIds: [...input.candidateToolIds],
    toolRound: 0,
    totalCallCount: 0,
    discoveryCallCount: 0,
    capabilityDiscoveries: [],
    pendingCalls: [],
    completedResults: [],
    updatedAt: now,
  };
}

export function transitionToolAgentTurn(
  turn: JunLuoToolAgentTurnContext,
  status: JunLuoToolAgentTurnStatus,
  patch: Partial<Omit<JunLuoToolAgentTurnContext, 'identity' | 'status'>> = {},
  now = Date.now(),
): JunLuoToolAgentTurnContext {
  if (!ALLOWED_TRANSITIONS[turn.status].includes(status)) {
    throw new JunLuoToolAgentTurnError(
      'INVALID_TURN_TRANSITION',
      `非法工具轮次状态转换：${turn.status} -> ${status}`,
    );
  }
  const terminal = isToolAgentTurnTerminal(status);
  return {
    ...turn,
    ...patch,
    status,
    updatedAt: now,
    ...(terminal ? { finishedAt: now } : {}),
  };
}

export function isToolAgentTurnTerminal(status: JunLuoToolAgentTurnStatus) {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function createToolAgentPendingCallSnapshot(input: {
  callId: string;
  toolId: string;
  arguments: Record<string, unknown>;
  round: 1 | 2 | 3;
}): JunLuoToolAgentPendingCallSnapshot {
  return {
    callId: input.callId,
    toolId: input.toolId,
    round: input.round,
    argumentKeys: Object.keys(input.arguments).sort(),
    argumentCharacterCount: JSON.stringify(input.arguments).length,
  };
}

export function createToolAgentResultSnapshot(
  result: JunLuoToolResult,
): JunLuoToolAgentResultSnapshot {
  return {
    callId: result.callId,
    toolId: result.toolId,
    ok: result.ok,
    status: result.status,
    ...(result.error?.code ? { errorCode: result.error.code } : {}),
  };
}
