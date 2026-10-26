import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
} from '../backup/backupRestoreCoordinator';
import { createToolError } from './toolErrors';
import { executeToolCall, type JunLuoToolExecutionOptions } from './toolExecution';
import {
  createToolAgentHostExecutionId,
  toolExecutionAttemptOutcomeFromResult,
  type JunLuoToolExecutionAttemptJournal,
} from './toolExecutionAttemptJournal';
import { localToolExecutionAttemptJournal } from './toolExecutionAttemptStore';
import { createToolInvocationFingerprint } from './toolAgentLoop';
import { getToolDefinition } from './toolRegistry';
import { createToolErrorResult } from './toolResult';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

const pendingManualExecutions = new Map<string, string>();

export type ExecuteManualToolWithSettlementOptions = JunLuoToolExecutionOptions & {
  attemptJournal?: JunLuoToolExecutionAttemptJournal;
  execute?: typeof executeToolCall;
  now?: () => number;
  sourceSessionId: string;
  scheduler?: {
    clearTimeout(timer: ReturnType<typeof setTimeout>): void;
    setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  };
  onLateResult?: (result: JunLuoToolResult, dataEpochStillCurrent: boolean) => void | Promise<void>;
};

function hostFailure(call: JunLuoToolCall, code: 'EXECUTION_FAILED' | 'TOOL_EXECUTION_PENDING' | 'TOOL_OUTCOME_UNKNOWN') {
  const summary = code === 'TOOL_OUTCOME_UNKNOWN'
    ? '结果待核对'
    : code === 'TOOL_EXECUTION_PENDING'
      ? '已有同类动作等待结果'
      : '工具执行失败';
  return createToolErrorResult(call, createToolError(code, summary), summary);
}

export async function executeManualToolCallWithSettlement(
  call: JunLuoToolCall,
  options: ExecuteManualToolWithSettlementOptions,
): Promise<JunLuoToolResult> {
  const {
    attemptJournal = localToolExecutionAttemptJournal,
    execute = executeToolCall,
    now = Date.now,
    onLateResult,
    scheduler = {
      clearTimeout: (timer) => clearTimeout(timer),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    },
    sourceSessionId,
    ...executionOptions
  } = options;
  const tool = getToolDefinition(call.toolId);
  if (!tool) return hostFailure(call, 'EXECUTION_FAILED');
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return hostFailure(call, 'EXECUTION_FAILED');
  const turnId = call.sourceMessageId || call.callId;
  const semanticExecutionKey = createToolInvocationFingerprint(turnId, {
    callId: call.callId,
    input: call.input,
    source: 'openai-tools',
    toolId: call.toolId,
  });
  const hostExecutionId = createToolAgentHostExecutionId(semanticExecutionKey);
  const conflictKey = tool.conflictGroup || tool.id;
  if (pendingManualExecutions.has(conflictKey)) {
    return hostFailure(call, 'TOOL_EXECUTION_PENDING');
  }

  const deadlineMs = tool.agentSettlementDeadlineMs ?? (tool.readOnly ? 30_000 : 90_000);
  let attemptPrepared = false;
  if (!tool.readOnly) {
    const preparedAt = now();
    try {
      const prepared = await attemptJournal.prepare({
        conflictKey,
        createdAt: preparedAt,
        dataEpoch,
        deadlineAt: preparedAt + deadlineMs,
        dispatchedAt: preparedAt,
        hostExecutionId,
        providerCallId: call.callId,
        sourceMessageId: call.sourceMessageId || call.callId,
        sourceSessionId,
        toolId: call.toolId,
        turnId,
      });
      if (prepared.status === 'pending') return hostFailure(call, 'TOOL_EXECUTION_PENDING');
      if (prepared.status !== 'prepared') return hostFailure(call, 'EXECUTION_FAILED');
      attemptPrepared = true;
    } catch {
      return hostFailure(call, 'EXECUTION_FAILED');
    }
  }

  pendingManualExecutions.set(conflictKey, hostExecutionId);
  const executionPromise = execute(call, {
    ...executionOptions,
    toolAgentHostExecutionId: hostExecutionId,
  }).catch(() => hostFailure(call, 'EXECUTION_FAILED'));
  let deadlineHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    deadlineHandle = scheduler.setTimeout(() => resolve('deadline'), deadlineMs);
  });
  const winner = await Promise.race([
    executionPromise.then((result) => ({ kind: 'result' as const, result })),
    deadline.then(() => ({ kind: 'deadline' as const })),
  ]);

  if (winner.kind === 'result') {
    if (deadlineHandle) scheduler.clearTimeout(deadlineHandle);
    pendingManualExecutions.delete(conflictKey);
    if (attemptPrepared) {
      await attemptJournal.markSettled(
        hostExecutionId,
        toolExecutionAttemptOutcomeFromResult(winner.result),
        now(),
      );
      await attemptJournal.acknowledgeDelivery(hostExecutionId);
    }
    return winner.result;
  }

  if (attemptPrepared) {
    await attemptJournal.markOutcomeUnknown(hostExecutionId, now());
  }
  void executionPromise.then(async (result) => {
    pendingManualExecutions.delete(conflictKey);
    if (attemptPrepared) {
      await attemptJournal.markSettled(
        hostExecutionId,
        toolExecutionAttemptOutcomeFromResult(result),
        now(),
      );
    }
    try {
      await onLateResult?.(result, canCommitBackupRestoreDataEpoch(dataEpoch));
      if (attemptPrepared) {
        await attemptJournal.acknowledgeDelivery(hostExecutionId);
      }
    } catch {
      // Keep settled_pending_delivery so startup reconciliation can retry without replaying the action.
    }
  }).catch(() => undefined);
  return hostFailure(call, 'TOOL_OUTCOME_UNKNOWN');
}
