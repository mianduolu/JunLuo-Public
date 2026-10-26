import {
  canCommitBackupRestoreDataEpoch,
} from '../backup/backupRestoreCoordinator';
import {
  JunLuoToolAgentTurnError,
  type JunLuoToolAgentFailureCode,
} from './toolAgentErrors';
import {
  createToolAgentTurn,
  isToolAgentTurnTerminal,
  transitionToolAgentTurn,
  type JunLuoToolAgentCancelReason,
  type JunLuoToolAgentPendingCallSnapshot,
  type JunLuoToolAgentPendingGate,
  type JunLuoToolAgentResultSnapshot,
  type JunLuoToolAgentTurnContext,
  type JunLuoToolAgentTurnIdentity,
  type JunLuoToolAgentTurnStatus,
} from './toolAgentState';
import type { JunLuoToolCapabilityDiscoverySnapshot } from './toolCapabilityDiscovery';

export const TOOL_AGENT_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

type ToolAgentTurnListener = (snapshot: JunLuoToolAgentTurnContext | null) => void;

type ToolAgentTurnScheduler = {
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
  setTimeout: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
};

export type CreateToolAgentTurnControllerOptions = {
  canCommitDataEpoch?: (dataEpoch: number) => boolean;
  now?: () => number;
  scheduler?: ToolAgentTurnScheduler;
};

export type JunLuoToolAgentTurnTransitionPatch = {
  candidateToolIds?: string[];
  completedResults?: JunLuoToolAgentResultSnapshot[];
  failureCode?: JunLuoToolAgentFailureCode;
  pendingCalls?: JunLuoToolAgentPendingCallSnapshot[];
  pendingGate?: JunLuoToolAgentPendingGate;
  toolRound?: 0 | 1 | 2 | 3;
  totalCallCount?: number;
  discoveryCallCount?: 0 | 1;
  capabilityDiscoveries?: JunLuoToolCapabilityDiscoverySnapshot[];
};

export type JunLuoToolAgentTurnHandle = {
  readonly identity: JunLuoToolAgentTurnIdentity;
  readonly signal: AbortSignal;
  assertActive: () => void;
  isDataEpochCurrent: () => boolean;
  cancel: (reason: JunLuoToolAgentCancelReason) => boolean;
  finishCancellation: (results?: readonly JunLuoToolAgentResultSnapshot[]) => void;
  getSnapshot: () => JunLuoToolAgentTurnContext;
  transition: (
    status: JunLuoToolAgentTurnStatus,
    patch?: JunLuoToolAgentTurnTransitionPatch,
  ) => JunLuoToolAgentTurnContext;
};

export type JunLuoToolAgentTurnController = {
  cancel: (reason: JunLuoToolAgentCancelReason) => boolean;
  cancelForSession: (
    sessionId: string,
    reason: Extract<JunLuoToolAgentCancelReason, 'source_session_cleared' | 'source_session_deleted'>,
  ) => boolean;
  cancelForSourceMessage: (messageId: string) => boolean;
  dispose: () => void;
  getSnapshot: () => JunLuoToolAgentTurnContext | null;
  start: (
    identity: JunLuoToolAgentTurnIdentity,
    candidateToolIds: readonly string[],
  ) => JunLuoToolAgentTurnHandle;
  subscribe: (listener: ToolAgentTurnListener) => () => void;
};

function clonePendingGate(gate: JunLuoToolAgentPendingGate | undefined) {
  if (!gate) return undefined;
  return gate.kind === 'permission'
    ? { ...gate, callIds: [...gate.callIds] }
    : { ...gate, callIds: [...gate.callIds] };
}

function cloneTurnContext(
  context: JunLuoToolAgentTurnContext,
): JunLuoToolAgentTurnContext {
  return {
    ...context,
    identity: { ...context.identity },
    candidateToolIds: [...context.candidateToolIds],
    pendingCalls: context.pendingCalls.map((call) => ({
      ...call,
      argumentKeys: [...call.argumentKeys],
    })),
    completedResults: context.completedResults.map((result) => ({ ...result })),
    capabilityDiscoveries: context.capabilityDiscoveries.map((discovery) => ({
      ...discovery,
      packageIds: [...discovery.packageIds],
      toolIds: [...discovery.toolIds],
    })),
    pendingGate: clonePendingGate(context.pendingGate),
    cancellation: context.cancellation ? { ...context.cancellation } : undefined,
  };
}

export function createToolAgentTurnController(
  options: CreateToolAgentTurnControllerOptions = {},
): JunLuoToolAgentTurnController {
  const now = options.now ?? Date.now;
  const scheduler = options.scheduler ?? {
    clearTimeout: (timer) => clearTimeout(timer),
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  };
  const canCommitDataEpoch = options.canCommitDataEpoch ?? canCommitBackupRestoreDataEpoch;
  const listeners = new Set<ToolAgentTurnListener>();
  let abortController: AbortController | null = null;
  let confirmationTimer: ReturnType<typeof setTimeout> | null = null;
  let context: JunLuoToolAgentTurnContext | null = null;

  const clearConfirmationTimer = () => {
    if (confirmationTimer === null) return;
    scheduler.clearTimeout(confirmationTimer);
    confirmationTimer = null;
  };

  const snapshot = () => context ? cloneTurnContext(context) : null;
  const publish = () => {
    const current = snapshot();
    listeners.forEach((listener) => listener(current));
  };
  const requireContext = () => {
    if (!context || !abortController) {
      throw new JunLuoToolAgentTurnError('TURN_NOT_ACTIVE', '当前没有工具轮次。');
    }
    return context;
  };
  const finishCancelled = (results?: readonly JunLuoToolAgentResultSnapshot[]) => {
    const current = requireContext();
    if (current.status === 'cancelled') return;
    if (isToolAgentTurnTerminal(current.status)) return;
    clearConfirmationTimer();
    context = transitionToolAgentTurn(current, 'cancelled', {
      completedResults: results ? [...results] : current.completedResults,
      pendingCalls: [],
      pendingGate: undefined,
    }, now());
    publish();
  };
  const cancel = (reason: JunLuoToolAgentCancelReason) => {
    if (!context || !abortController || isToolAgentTurnTerminal(context.status)) return false;
    if (context.cancellation) return true;
    abortController.abort();
    context = {
      ...context,
      cancellation: { reason, requestedAt: now() },
      updatedAt: now(),
    };
    publish();
    if (context.status !== 'executing' || context.pendingCalls.length === 0) {
      finishCancelled();
    }
    return true;
  };

  return {
    start(identity, candidateToolIds) {
      if (context && !isToolAgentTurnTerminal(context.status)) {
        throw new JunLuoToolAgentTurnError(
          'TURN_ALREADY_ACTIVE',
          '已经有一个工具轮次正在进行。',
        );
      }
      if (identity.turnId !== identity.sourceMessageId) {
        throw new JunLuoToolAgentTurnError(
          'TURN_ID_MISMATCH',
          '聊天工具轮次 ID 必须与来源 you 消息 ID 一致。',
        );
      }
      if (!canCommitDataEpoch(identity.dataEpoch)) {
        throw new JunLuoToolAgentTurnError(
          'STALE_DATA_EPOCH',
          '当前数据纪元不能启动工具轮次。',
        );
      }
      clearConfirmationTimer();
      abortController = new AbortController();
      context = createToolAgentTurn({ identity, candidateToolIds, now: now() });
      publish();

      const handle: JunLuoToolAgentTurnHandle = {
        identity: { ...identity },
        signal: abortController.signal,
        assertActive() {
          const current = requireContext();
          if (current.identity.turnId !== identity.turnId) {
            throw new JunLuoToolAgentTurnError(
              'TURN_ID_MISMATCH',
              '工具轮次已经被其他轮次替换。',
            );
          }
          if (!canCommitDataEpoch(identity.dataEpoch)) {
            cancel('stale_data_epoch');
            throw new JunLuoToolAgentTurnError(
              'STALE_DATA_EPOCH',
              '工具轮次的数据纪元已经失效。',
            );
          }
          if (current.cancellation || abortController?.signal.aborted || current.status === 'cancelled') {
            throw new JunLuoToolAgentTurnError('TURN_CANCELLED', '工具轮次已经取消。');
          }
          if (current.status === 'failed' || current.status === 'completed') {
            throw new JunLuoToolAgentTurnError('TURN_NOT_ACTIVE', '工具轮次已经结束。');
          }
        },
        isDataEpochCurrent() {
          return canCommitDataEpoch(identity.dataEpoch);
        },
        cancel,
        finishCancellation(results) {
          const current = requireContext();
          if (current.identity.turnId !== identity.turnId) {
            throw new JunLuoToolAgentTurnError('TURN_ID_MISMATCH', '工具轮次已经被其他轮次替换。');
          }
          if (!current.cancellation) return;
          finishCancelled(results);
        },
        getSnapshot() {
          const current = requireContext();
          if (current.identity.turnId !== identity.turnId) {
            throw new JunLuoToolAgentTurnError('TURN_ID_MISMATCH', '工具轮次已经被其他轮次替换。');
          }
          return cloneTurnContext(current);
        },
        transition(status, patch = {}) {
          const current = requireContext();
          if (current.identity.turnId !== identity.turnId) {
            throw new JunLuoToolAgentTurnError('TURN_ID_MISMATCH', '工具轮次已经被其他轮次替换。');
          }
          if (current.cancellation && status !== 'cancelled') {
            throw new JunLuoToolAgentTurnError('TURN_CANCELLED', '工具轮次已经请求取消。');
          }
          if (status === 'awaiting_permission' && patch.pendingGate?.kind !== 'permission') {
            throw new JunLuoToolAgentTurnError(
              'INVALID_TURN_TRANSITION',
              '等待权限状态必须携带 permission gate。',
            );
          }
          if (status === 'awaiting_confirmation' && patch.pendingGate?.kind !== 'confirmation') {
            throw new JunLuoToolAgentTurnError(
              'INVALID_TURN_TRANSITION',
              '等待确认状态必须携带 confirmation gate。',
            );
          }
          clearConfirmationTimer();
          const normalizedPatch = status === 'awaiting_permission' || status === 'awaiting_confirmation'
            ? patch
            : { ...patch, pendingGate: undefined };
          context = transitionToolAgentTurn(current, status, normalizedPatch, now());
          if (status === 'awaiting_confirmation' && patch.pendingGate?.kind === 'confirmation') {
            const delayMs = Math.max(0, patch.pendingGate.expiresAt - now());
            confirmationTimer = scheduler.setTimeout(() => {
              confirmationTimer = null;
              cancel('confirmation_expired');
            }, delayMs);
          }
          publish();
          return cloneTurnContext(context);
        },
      };
      return handle;
    },
    cancel,
    cancelForSession(sessionId, reason) {
      if (context?.identity.sourceSessionId !== sessionId) return false;
      return cancel(reason);
    },
    cancelForSourceMessage(messageId) {
      if (context?.identity.sourceMessageId !== messageId) return false;
      return cancel('source_message_removed');
    },
    dispose() {
      cancel('controller_disposed');
      clearConfirmationTimer();
      listeners.clear();
    },
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
