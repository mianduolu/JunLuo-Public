import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import {
  checkToolPermission,
  type JunLuoToolPermissionCheckOptions,
  type JunLuoToolPermissionPreauthorizationReceipt,
} from './toolPermissions';
import { getToolDefinition } from './toolRegistry';
import {
  createToolCallCard as createUnprojectedToolCallCard,
  updateToolCallCardStatus,
  updateToolCallCardWithResult as updateUnprojectedToolCallCardWithResult,
  type JunLuoToolStatusChangeEvent,
} from './toolCallCard';
import {
  createToolAuditWriteBatch,
  flushToolAuditWriteBatch,
  recordToolCallRequested as recordUnprojectedToolCallRequested,
  recordToolExecutionResult as recordUnprojectedToolExecutionResult,
  recordToolExecutionStarted,
  recordToolPermissionDecision,
  loadToolExecutionOutcome,
  type ToolAuditWriteBatch,
} from './toolAuditStore';
import { emitToolLifecycleEvent } from './toolHookRegistry';
import type { JunLuoToolLifecycleEvent, JunLuoToolLifecycleEventType } from './toolHookTypes';
import { buildToolInputPreview } from './toolInputPreview';
import { isGiftToolId, projectGiftToolCardResult } from '../gifts/giftToolContract';
import type { JunLuoToolPermissionAuthorizationSource } from './toolAuditTypes';
import type { JunLuoToolAgentAuditMetadata } from './toolAuditTypes';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import { executeToolCallOnce } from './toolCallExecutionOnce';
import { localToolExecutionAttemptJournal } from './toolExecutionAttemptStore';
import {
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import {
  beginRuntimeWorkload,
  observeRuntimeWorkload,
  type RuntimeWorkloadStage,
} from '../runtime/runtimeWorkloadDiagnostics';

// Keep private preparation out of ordinary cards, previews and audit summaries.
// The executor and its execution journal continue to receive the actual call/result.
const visibleCall = (call: JunLuoToolCall) => isGiftToolId(call.toolId) ? { ...call, input: {} } : call;
const createToolCallCard: typeof createUnprojectedToolCallCard = call => createUnprojectedToolCallCard(visibleCall(call));
const updateToolCallCardWithResult: typeof updateUnprojectedToolCallCardWithResult = (card, result) =>
  updateUnprojectedToolCallCardWithResult(card, projectGiftToolCardResult(result));
const recordToolCallRequested: typeof recordUnprojectedToolCallRequested = (call, executionId, metadata, batch) =>
  recordUnprojectedToolCallRequested(visibleCall(call), executionId, metadata, batch);
const recordToolExecutionResult: typeof recordUnprojectedToolExecutionResult = (callId, result, executionId, batch) =>
  recordUnprojectedToolExecutionResult(callId, projectGiftToolCardResult(result), executionId, batch);

export type JunLuoToolExecutionOptions = JunLuoToolPermissionCheckOptions & {
  backendOverviewChat?: import('./toolTypes').JunLuoToolExecutorContext['backendOverviewChat'];
  appLaunchChat?: import('./toolTypes').JunLuoToolExecutorContext['appLaunchChat'];
  dialerChat?: import('./toolTypes').JunLuoToolExecutorContext['dialerChat'];
  chatReminder?: import('./toolTypes').JunLuoToolExecutorContext['chatReminder'];
  chatExpense?: import('./toolTypes').JunLuoToolExecutorContext['chatExpense'];
  chatSchedule?: import('./toolTypes').JunLuoToolExecutorContext['chatSchedule'];
  textFileChat?: import('./toolTypes').JunLuoToolExecutorContext['textFileChat'];
  chatImage?: import('./toolTypes').JunLuoToolExecutorContext['chatImage'];
  githubVoyageIsCurrent?: import('./toolTypes').JunLuoToolExecutorContext['githubVoyageIsCurrent'];
  sleepScheduleDecision?: import('./toolTypes').JunLuoToolExecutorContext['sleepScheduleDecision'];
  cameraObservation?: import('./toolTypes').JunLuoToolExecutorContext['cameraObservation'];
  memoryRead?: import('./toolTypes').JunLuoToolExecutorContext['memoryRead'];
  proactiveContact?: import('./toolTypes').JunLuoToolExecutorContext['proactiveContact'];
  readingControl?: import('./toolTypes').JunLuoToolExecutorContext['readingControl'];
  readingMaterial?: import('./toolTypes').JunLuoToolExecutorContext['readingMaterial'];
  mapSearch?: import('./toolTypes').JunLuoToolExecutorContext['mapSearch'];
  ownSchedule?: import('./toolTypes').JunLuoToolExecutorContext['ownSchedule'];
  userRoutine?: import('./toolTypes').JunLuoToolExecutorContext['userRoutine'];
  ownScheduleScope?: 'near-status';
  wishPool?: import('./toolTypes').JunLuoToolExecutorContext['wishPool'];
  giftCabinet?: import('./toolTypes').JunLuoToolExecutorContext['giftCabinet'];
  phoneLimit?: import('./toolTypes').JunLuoToolExecutorContext['phoneLimit'];
  bypassPermission?: boolean;
  backupRestoreLeaseHeld?: boolean;
  deferAuditPersistenceUntilFinal?: boolean;
  diagnosticParentToken?: number;
  executionId?: string;
  agentAuditMetadata?: JunLuoToolAgentAuditMetadata;
  permissionPreauthorization?: JunLuoToolPermissionPreauthorizationReceipt;
  toolAgentInputHash?: string;
  toolAgentHostExecutionId?: string;
  onStatusChange?: (event: JunLuoToolStatusChangeEvent) => void;
};

async function writeAuditLog(write: () => Promise<void>) {
  try {
    await write();
  } catch {
    // Audit logging must never block or alter tool execution.
  }
}

function emitStatusChange(options: JunLuoToolExecutionOptions, event: JunLuoToolStatusChangeEvent) {
  try {
    if (isGiftToolId(event.call.toolId)) {
      const result = event.result && projectGiftToolCardResult(event.result);
      const card = { ...event.card, inputPreview: {} };
      event = { ...event, call: visibleCall(event.call),
        card: result ? updateUnprojectedToolCallCardWithResult(card, result) : card,
        ...(result ? { result } : {}) };
    }
    options.onStatusChange?.(event);
  } catch {
    // UI status rendering must never block or alter tool execution.
  }
}

function createPermissionAuthorization(
  source: JunLuoToolPermissionAuthorizationSource,
  options: {
    grantId?: string;
    expiresAt?: number;
    silent?: boolean;
  } = {},
) {
  return {
    source,
    grantId: options.grantId,
    expiresAt: options.expiresAt,
    silent: options.silent ?? source !== 'prompt',
  };
}

function isValidPermissionPreauthorization(
  call: JunLuoToolCall,
  options: JunLuoToolExecutionOptions,
) {
  const receipt = options.permissionPreauthorization;
  if (!receipt) return false;
  const now = Date.now();
  return receipt.decision === 'allowed'
    && receipt.callId === call.callId
    && receipt.toolId === call.toolId
    && !!options.toolAgentInputHash
    && receipt.inputHash === options.toolAgentInputHash
    && receipt.issuedAt <= now
    && (receipt.expiresAt === undefined || receipt.expiresAt > now);
}

function createToolLifecycleEventId(eventType: JunLuoToolLifecycleEventType, callId: string) {
  return `${eventType}:${callId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

function createLifecycleError(error: unknown) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return { message: error.message };
  }
  if (typeof error === 'object' && 'message' in error) {
    const maybeError = error as { message?: unknown; code?: unknown; details?: unknown };
    return {
      message: typeof maybeError.message === 'string' ? maybeError.message : String(maybeError.message ?? error),
      code: typeof maybeError.code === 'string' ? maybeError.code : undefined,
      details: maybeError.details,
    };
  }
  return { message: String(error) };
}

function executionOutcomeFromToolResult(
  result: JunLuoToolResult,
): 'completed' | 'failed' | 'cancelled' {
  if (result.ok) return 'completed';
  return result.status === 'cancelled' ? 'cancelled' : 'failed';
}

function toolResultFromRemoteReceipt(
  call: JunLuoToolCall,
  outcome: 'completed' | 'failed' | 'cancelled',
): JunLuoToolResult {
  if (outcome === 'completed') {
    return createToolSuccessResult(
      call,
      '工具已在另一台设备完成，本机没有重复执行。',
    );
  }
  const error = createToolError(
    'DUPLICATE_TOOL_CALL',
    outcome === 'cancelled'
      ? '另一台设备已取消这次工具调用，本机没有重复执行。'
      : '另一台设备已完成这次工具调用，但结果为失败；本机没有重复执行。',
  );
  const result = createToolErrorResult(
    call,
    error,
    error.message,
  );
  return outcome === 'cancelled'
    ? { ...result, status: 'cancelled' }
    : result;
}

async function emitLifecycleEvent(
  eventType: JunLuoToolLifecycleEventType,
  call: JunLuoToolCall,
  options: JunLuoToolExecutionOptions,
  packageId: string,
  extra: Partial<Pick<JunLuoToolLifecycleEvent, 'permissionDecision' | 'result' | 'error'>> = {},
) {
  const stageByEvent: Record<JunLuoToolLifecycleEventType, RuntimeWorkloadStage> = {
    tool_call_requested: 'tools.lifecycle.requested',
    tool_permission_checked: 'tools.lifecycle.permission',
    tool_execution_started: 'tools.lifecycle.started',
    tool_execution_result: 'tools.lifecycle.result',
    tool_execution_error: 'tools.lifecycle.error',
    tool_execution_finished: 'tools.lifecycle.finished',
  };
  const emit = () => emitToolLifecycleEvent({
      eventId: createToolLifecycleEventId(eventType, call.callId),
      eventType,
      call: {
        callId: call.callId,
        toolId: call.toolId,
        requestedBy: call.requestedBy,
        createdAt: call.createdAt,
        sourceMessageId: call.sourceMessageId,
        inputPreview: buildToolInputPreview(visibleCall(call).input),
      },
      toolId: call.toolId,
      packageId,
      executionId: options.executionId,
      createdAt: Date.now(),
      ...extra,
      ...(extra.result && isGiftToolId(call.toolId) ? { result: projectGiftToolCardResult(extra.result) } : {}),
      ...(extra.error && isGiftToolId(call.toolId) ? { error: {
        message: extra.error.code ?? 'gift-tool-failed', code: extra.error.code,
      } } : {}),
    });
  if (!options.diagnosticParentToken) {
    await emit();
    return;
  }
  await observeRuntimeWorkload(
    stageByEvent[eventType],
    emit,
    undefined,
    { parentToken: options.diagnosticParentToken },
  );
}

async function emitResultLifecycleEvents(
  call: JunLuoToolCall,
  options: JunLuoToolExecutionOptions,
  packageId: string,
  result: JunLuoToolResult,
) {
  await emitLifecycleEvent('tool_execution_result', call, options, packageId, {
    result: Object.freeze({ ...result }),
  });
  if (!result.ok) {
    await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
      result: Object.freeze({ ...result }),
      error: createLifecycleError(result.error ?? result.summary),
    });
  }
  await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
    result: Object.freeze({ ...result }),
  });
}

export async function executeToolCall(
  call: JunLuoToolCall,
  options: JunLuoToolExecutionOptions = {},
): Promise<JunLuoToolResult> {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const executionId = options.executionId;
  const tool = getToolDefinition(call.toolId);
  const packageId = tool?.packageId ?? '';
  const auditBatch: ToolAuditWriteBatch | undefined = options.deferAuditPersistenceUntilFinal
    ? createToolAuditWriteBatch(call.callId)
    : undefined;
  const observeToolStage = <T>(stage: RuntimeWorkloadStage, operation: () => Promise<T>) => (
    options.diagnosticParentToken
      ? observeRuntimeWorkload(
      stage,
      operation,
      undefined,
      { parentToken: options.diagnosticParentToken },
      )
      : operation()
  );
  let card = createToolCallCard(call);
  const writeProtectedAuditLog = (
    stage: RuntimeWorkloadStage,
    write: () => Promise<void>,
    flushBatch = false,
  ) => {
    const writeStage = async (diagnosticParentToken?: number) => {
      await write();
      if (auditBatch && flushBatch) {
        await flushToolAuditWriteBatch(auditBatch, diagnosticParentToken);
      }
    };
    const observeStage = (operation: () => Promise<void>) => (
      options.diagnosticParentToken
        ? observeRuntimeWorkload(
            stage,
            operation,
            undefined,
            { parentToken: options.diagnosticParentToken },
          )
        : operation()
    );
    if (auditBatch && !flushBatch) {
      return observeStage(() => writeAuditLog(() => writeStage()));
    }
    const persist = (diagnosticParentToken?: number) => writeAuditLog(async () => {
        if (options.backupRestoreLeaseHeld) {
          await writeStage(diagnosticParentToken);
          return;
        }
        const commit = () => runBackupRestoreDataEpochCommit(
          dataEpoch,
          () => writeStage(diagnosticParentToken),
        );
        if (diagnosticParentToken) {
          await observeRuntimeWorkload(
            'tools.backup_epoch_lease',
            commit,
            undefined,
            { parentToken: diagnosticParentToken },
          );
          return;
        }
        await commit();
      });
    if (!options.diagnosticParentToken) return persist();
    return observeRuntimeWorkload(
      stage,
      (span) => persist(span?.token),
      undefined,
      { parentToken: options.diagnosticParentToken },
    );
  };
  emitStatusChange(options, { call, card, executionId });
  await writeProtectedAuditLog(
    'tools.audit.request',
    () => recordToolCallRequested(call, executionId, options.agentAuditMetadata, auditBatch),
  );
  await emitLifecycleEvent('tool_call_requested', call, options, packageId);
  if (!tool) {
    const result = createToolErrorResult(
      call,
      createToolError('TOOL_NOT_FOUND', `工具不存在：${call.toolId}`),
      '没有执行工具',
    );
    card = updateToolCallCardWithResult(card, result);
    emitStatusChange(options, { call, card, executionId, result });
    await writeProtectedAuditLog(
      'tools.audit.result_final',
      () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
      true,
    );
    await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
      result: Object.freeze({ ...result }),
      error: createLifecycleError(result.error),
    });
    await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
      result: Object.freeze({ ...result }),
    });
    return result;
  }

  if (!tool.executor) {
    const result = createToolErrorResult(
      call,
      createToolError('EXECUTION_FAILED', `工具没有执行器：${call.toolId}`),
      '没有执行工具',
    );
    card = updateToolCallCardWithResult(card, result);
    emitStatusChange(options, { call, card, executionId, result });
    await writeProtectedAuditLog(
      'tools.audit.result_final',
      () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
      true,
    );
    await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
      result: Object.freeze({ ...result }),
      error: createLifecycleError(result.error),
    });
    await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
      result: Object.freeze({ ...result }),
    });
    return result;
  }

  if (options.permissionPreauthorization) {
    if (!isValidPermissionPreauthorization(call, options)) {
      const authorization = createPermissionAuthorization(
        options.permissionPreauthorization.source,
        { silent: options.permissionPreauthorization.silent },
      );
      const result = createToolErrorResult(
        call,
        createToolError('PERMISSION_DENIED', '工具预授权收据无效或已过期'),
        '没有执行工具',
      );
      await writeProtectedAuditLog(
        'tools.audit.permission',
        () => recordToolPermissionDecision(call.callId, 'denied', executionId, authorization, auditBatch),
      );
      card = updateToolCallCardStatus(card, 'permission_denied', {
        permissionDecision: 'denied',
        permissionSource: authorization.source,
        permissionSilent: authorization.silent,
        result,
      });
      emitStatusChange(options, { call, card, executionId, result });
      await writeProtectedAuditLog(
        'tools.audit.result_final',
        () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
        true,
      );
      await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
        permissionDecision: 'denied',
      });
      await emitResultLifecycleEvents(call, options, packageId, result);
      return result;
    }
    const receipt = options.permissionPreauthorization;
    const authorization = createPermissionAuthorization(receipt.source, {
      grantId: receipt.grantId,
      expiresAt: receipt.expiresAt,
      silent: receipt.silent,
    });
    await writeProtectedAuditLog(
      'tools.audit.permission',
      () => recordToolPermissionDecision(call.callId, 'allowed', executionId, authorization, auditBatch),
    );
    card = updateToolCallCardStatus(card, card.status, {
      permissionDecision: 'allowed',
      permissionSource: authorization.source,
      permissionGrantId: authorization.grantId,
      permissionExpiresAt: authorization.expiresAt,
      permissionSilent: authorization.silent,
    });
    emitStatusChange(options, { call, card, executionId });
    await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
      permissionDecision: 'allowed',
    });
  } else if (options.bypassPermission) {
    const authorization = createPermissionAuthorization('bypass');
    await writeProtectedAuditLog(
      'tools.audit.permission',
      () => recordToolPermissionDecision(call.callId, 'allowed', executionId, authorization, auditBatch),
    );
    card = updateToolCallCardStatus(card, card.status, {
      permissionDecision: 'allowed',
      permissionSource: authorization.source,
      permissionGrantId: authorization.grantId,
      permissionExpiresAt: authorization.expiresAt,
      permissionSilent: authorization.silent,
    });
    emitStatusChange(options, { call, card, executionId });
    await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
      permissionDecision: 'allowed',
    });
  } else {
    let permission;
    try {
      permission = await checkToolPermission(tool, call, options);
    } catch (error) {
      const authorization = createPermissionAuthorization('prompt', { silent: false });
      const result = createToolErrorResult(
        call,
        createToolError('PERMISSION_DENIED', error instanceof Error ? error.message : '权限检查失败'),
        '没有执行工具',
      );
      await writeProtectedAuditLog(
        'tools.audit.permission',
        () => recordToolPermissionDecision(call.callId, 'denied', executionId, authorization, auditBatch),
      );
      card = updateToolCallCardStatus(card, 'permission_denied', {
        permissionDecision: 'denied',
        permissionSource: authorization.source,
        permissionSilent: authorization.silent,
        result,
      });
      emitStatusChange(options, { call, card, executionId, result });
      await writeProtectedAuditLog(
        'tools.audit.result_final',
        () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
        true,
      );
      await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
        permissionDecision: 'denied',
        error: createLifecycleError(error),
      });
      await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
        result: Object.freeze({ ...result }),
        error: createLifecycleError(result.error),
      });
      await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
        result: Object.freeze({ ...result }),
      });
      return result;
    }
    if (permission.decision === 'denied') {
      const authorization = createPermissionAuthorization(permission.source, {
        grantId: permission.grantId,
        expiresAt: permission.expiresAt,
        silent: permission.silent,
      });
      const result = createToolErrorResult(
        call,
        createToolError('PERMISSION_DENIED', permission.reason, {
          permission: permission.permission,
          source: permission.source,
          grantId: permission.grantId,
          expiresAt: permission.expiresAt,
          silent: permission.silent,
        }),
        '没有执行工具',
      );
      await writeProtectedAuditLog(
        'tools.audit.permission',
        () => recordToolPermissionDecision(call.callId, 'denied', executionId, authorization, auditBatch),
      );
      card = updateToolCallCardStatus(card, 'permission_denied', {
        permissionDecision: 'denied',
        permissionSource: authorization.source,
        permissionGrantId: authorization.grantId,
        permissionExpiresAt: authorization.expiresAt,
        permissionSilent: authorization.silent,
        result,
      });
      emitStatusChange(options, { call, card, executionId, result });
      await writeProtectedAuditLog(
        'tools.audit.result_final',
        () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
        true,
      );
      await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
        permissionDecision: 'denied',
      });
      await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
        result: Object.freeze({ ...result }),
        error: createLifecycleError(result.error),
      });
      await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
        result: Object.freeze({ ...result }),
      });
      return result;
    }
    if (permission.decision === 'cancelled') {
      const authorization = createPermissionAuthorization(permission.source, {
        grantId: permission.grantId,
        expiresAt: permission.expiresAt,
        silent: permission.silent,
      });
      const result = createToolErrorResult(
        call,
        createToolError('PERMISSION_DENIED', permission.reason, {
          permission: permission.permission,
          source: permission.source,
          grantId: permission.grantId,
          expiresAt: permission.expiresAt,
          silent: permission.silent,
        }),
        '已取消工具执行',
      );
      await writeProtectedAuditLog(
        'tools.audit.permission',
        () => recordToolPermissionDecision(call.callId, 'cancelled', executionId, authorization, auditBatch),
      );
      card = updateToolCallCardStatus(card, 'cancelled', {
        permissionDecision: 'cancelled',
        permissionSource: authorization.source,
        permissionGrantId: authorization.grantId,
        permissionExpiresAt: authorization.expiresAt,
        permissionSilent: authorization.silent,
        result,
      });
      emitStatusChange(options, { call, card, executionId, result });
      await writeProtectedAuditLog(
        'tools.audit.result_final',
        () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
        true,
      );
      await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
        permissionDecision: 'cancelled',
      });
      await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
        result: Object.freeze({ ...result }),
        error: createLifecycleError(result.error),
      });
      await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
        result: Object.freeze({ ...result }),
      });
      return result;
    }
    const authorization = createPermissionAuthorization(permission.source, {
      grantId: permission.grantId,
      expiresAt: permission.expiresAt,
      silent: permission.silent,
    });
    await writeProtectedAuditLog(
      'tools.audit.permission',
      () => recordToolPermissionDecision(call.callId, 'allowed', executionId, authorization, auditBatch),
    );
    card = updateToolCallCardStatus(card, card.status, {
      permissionDecision: 'allowed',
      permissionSource: authorization.source,
      permissionGrantId: authorization.grantId,
      permissionExpiresAt: authorization.expiresAt,
      permissionSilent: authorization.silent,
    });
    emitStatusChange(options, { call, card, executionId });
    await emitLifecycleEvent('tool_permission_checked', call, options, packageId, {
      permissionDecision: 'allowed',
    });
  }

  let localExecutionStarted = false;
  let locallyResolvedResult: JunLuoToolResult | undefined;
  try {
    const runToolExecutor = (
      backupRestoreLeaseHeld: boolean,
      diagnosticParentToken = options.diagnosticParentToken,
    ) => {
      const executorSpan = diagnosticParentToken
        ? beginRuntimeWorkload('tools.executor', { parentToken: diagnosticParentToken })
        : null;
      const execute = () => tool.executor!(call, {
        backendOverviewChat: options.backendOverviewChat,
        appLaunchChat: options.appLaunchChat,
        dialerChat: options.dialerChat,
        chatExpense: options.chatExpense,
        chatReminder: options.chatReminder,
        textFileChat: options.textFileChat,
        chatImage: options.chatImage,
        backupRestoreLeaseHeld,
        githubVoyageIsCurrent: options.githubVoyageIsCurrent,
        sleepScheduleDecision: options.sleepScheduleDecision,
        cameraObservation: options.cameraObservation,
        memoryRead: options.memoryRead,
        proactiveContact: options.proactiveContact,
        readingControl: options.readingControl,
        readingMaterial: options.readingMaterial,
        mapSearch: options.mapSearch,
        ownSchedule: options.ownSchedule,
        chatSchedule: options.chatSchedule,
        userRoutine: options.userRoutine,
        ownScheduleScope: options.ownScheduleScope,
        wishPool: options.wishPool,
        giftCabinet: options.giftCabinet,
        phoneLimit: options.phoneLimit,
        ...(executorSpan ? { diagnosticParentToken: executorSpan.token } : {}),
        runBackupRestoreDataEpochCommit: async <T>(work: () => Promise<T> | T) => {
          if (backupRestoreLeaseHeld) return Promise.resolve(work());
          const runCommit = () => runBackupRestoreDataEpochCommit(
            dataEpoch,
            () => Promise.resolve(work()),
          );
          const committed = executorSpan
            ? await observeRuntimeWorkload(
                'tools.backup_epoch_lease',
                runCommit,
                undefined,
                { parentToken: executorSpan.token },
              )
            : await runCommit();
          if (!committed.committed) {
            throw new Error('数据恢复期间没有保存这个工具的结果。');
          }
          return committed.value;
        },
      });
      if (!executorSpan) return execute();
      try {
        const result = execute();
        if (result && typeof (result as PromiseLike<JunLuoToolResult>).then === 'function') {
          return Promise.resolve(result).then(
            (value) => {
              executorSpan.finish('ok');
              return value;
            },
            (error) => {
              executorSpan.finish('failed');
              throw error;
            },
          );
        }
        executorSpan.finish('ok');
        return result;
      } catch (error) {
        executorSpan.finish('failed');
        throw error;
      }
    };
    const runRegisteredTool = async () => {
      if (
        options.backupRestoreLeaseHeld
        || tool.backupRestoreSafeOutsideLease === true
        // This bound read-only chat host checks its epoch before each GET and delivery.
        // Keep the old manual named-service lease; only its new empty chat route waits outside it.
        || (call.requestedBy === 'chat' && call.toolId === 'http.call_named_service'
          && Object.keys(call.input).length === 0 && typeof options.backendOverviewChat === 'function')
      ) {
        return runToolExecutor(!!options.backupRestoreLeaseHeld);
      }
      const runWithLease = (leaseParentToken?: number) => runBackupRestoreDataEpochCommit(
        dataEpoch,
        () => Promise.resolve(
          leaseParentToken
            ? runToolExecutor(true, leaseParentToken)
            : runToolExecutor(true),
        ),
      );
      const committed = options.diagnosticParentToken
        ? await observeRuntimeWorkload(
            'tools.backup_epoch_lease',
            (span) => runWithLease(span?.token),
            undefined,
            { parentToken: options.diagnosticParentToken },
          )
        : await runWithLease();
      return committed.committed
        ? committed.value
        : createToolErrorResult(
            call,
            createToolError(
              'EXECUTION_FAILED',
              '数据恢复期间没有执行这个工具。',
            ),
            '工具没有执行',
          );
    };
    const executeAndPersist = async () => {
      localExecutionStarted = true;
      await writeProtectedAuditLog(
        'tools.audit.started',
        () => recordToolExecutionStarted(call.callId, executionId, auditBatch),
      );
      card = updateToolCallCardStatus(card, 'running');
      emitStatusChange(options, { call, card, executionId });
      await emitLifecycleEvent(
        'tool_execution_started',
        call,
        options,
        packageId,
      );
      let localResult: JunLuoToolResult;
      try {
        localResult = await runRegisteredTool();
      } catch (error) {
        localResult = createToolErrorResult(
          call,
          createToolError(
            'EXECUTION_FAILED',
            error instanceof Error ? error.message : String(error),
          ),
          '工具执行失败',
        );
      }
      locallyResolvedResult = localResult;
      await writeProtectedAuditLog(
        'tools.audit.result_local',
        () => recordToolExecutionResult(
          call.callId,
          localResult,
          executionId,
          auditBatch,
        ),
      );
      return localResult;
    };

    let result: JunLuoToolResult;
    if (tool.readOnly || tool.executionScope === 'local_device') {
      result = await executeAndPersist();
    } else {
      let localResult: JunLuoToolResult | undefined;
      const once = await executeToolCallOnce(
        {
          callId: call.callId,
          createdAt: call.createdAt,
          toolId: call.toolId,
        },
        {
          reconcileLocally: () => loadToolExecutionOutcome(call.callId),
          hasUnresolvedAttempt: async () => {
            const pending = await localToolExecutionAttemptJournal
              .findPendingByConflict(tool.conflictGroup || tool.id);
            return !!pending
              && pending.hostExecutionId !== options.toolAgentHostExecutionId;
          },
          executeLocally: async () => {
            localResult = await executeAndPersist();
            return executionOutcomeFromToolResult(localResult);
          },
          applyReceipt: async () => undefined,
        },
      );
      result = once.executedNow && localResult
        ? localResult
        : toolResultFromRemoteReceipt(call, once.outcome);
    }
    card = updateToolCallCardWithResult(card, result);
    emitStatusChange(options, { call, card, executionId, result });
    await writeProtectedAuditLog(
      'tools.audit.result_final',
      () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
      true,
    );
    await emitResultLifecycleEvents(call, options, packageId, result);
    return result;
  } catch (error) {
    const result = locallyResolvedResult ?? createToolErrorResult(
        call,
        createToolError(
          'EXECUTION_FAILED',
          error instanceof Error ? error.message : String(error),
        ),
        '工具执行失败',
      );
    card = updateToolCallCardWithResult(card, result);
    emitStatusChange(options, { call, card, executionId, result });
    if (localExecutionStarted) {
      await writeProtectedAuditLog(
        'tools.audit.result_final',
        () => recordToolExecutionResult(call.callId, result, executionId, auditBatch),
        true,
      );
    }
    await emitLifecycleEvent('tool_execution_error', call, options, packageId, {
      result: Object.freeze({ ...result }),
      error: createLifecycleError(error),
    });
    await emitLifecycleEvent('tool_execution_finished', call, options, packageId, {
      result: Object.freeze({ ...result }),
    });
    return result;
  }
}
