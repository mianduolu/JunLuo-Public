import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import type { SyncExecutionOnceCoordinatorV2 } from '../sync/syncExecutionOnceV2Controller';
import type { PhonePrimaryInternalExecutor } from '../runtime/phonePrimaryInternalExecution';

export type ToolCallExecutionIdentity = {
  callId: string;
  createdAt: number;
  toolId: string;
};

export type ToolCallExecutionOnceResult = {
  completedAt: number;
  executedNow: boolean;
  outcome: SyncExecutionOutcomeV2;
};

export type ToolCallExecutionOncePorts = {
  applyReceipt(
    outcome: SyncExecutionOutcomeV2,
    completedAt: number,
  ): Promise<void>;
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  executeLocally(): Promise<SyncExecutionOutcomeV2>;
  hasUnresolvedAttempt?(): Promise<boolean>;
  loadRelayBaseUrl(): Promise<string>;
  reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  syncEnrollmentReady: boolean;
  phonePrimaryExecute?: PhonePrimaryInternalExecutor;
};

export function createToolCallOperationId(
  identity: ToolCallExecutionIdentity,
) {
  return createSyncExecutionOperationId({
    category: 'tool-call',
    scope: `tool.${identity.toolId}`,
    entityId: identity.callId,
    action: 'execute:v1',
  });
}

export async function runToolCallExecutionOnce(
  identity: ToolCallExecutionIdentity,
  ports: ToolCallExecutionOncePorts,
): Promise<ToolCallExecutionOnceResult> {
  if (await ports.hasUnresolvedAttempt?.()) {
    throw new Error('tool-call-needs-reconciliation');
  }
  if (!ports.syncEnrollmentReady && !ports.phonePrimaryExecute) {
    const existingOutcome = await ports.reconcileLocally();
    const outcome = existingOutcome ?? await ports.executeLocally();
    const completedAt = Date.now();
    await ports.applyReceipt(outcome, completedAt);
    return {
      completedAt,
      executedNow: existingOutcome === null,
      outcome,
    };
  }

  const executeOnce = ports.phonePrimaryExecute ?? (async (input) => {
    const baseUrl = (await ports.loadRelayBaseUrl()).trim();
    if (!baseUrl) throw new Error('sync-relay-not-configured');
    return (await ports.createCoordinator(baseUrl)).execute(input);
  });
  let executedNow = false;
  const result = await executeOnce({
    operationId: createToolCallOperationId(identity),
    category: 'tool-call',
    createdAt: identity.createdAt,
    reconcile: ports.reconcileLocally,
    execute: async () => {
      const existingOutcome = await ports.reconcileLocally();
      if (existingOutcome) return existingOutcome;
      executedNow = true;
      return ports.executeLocally();
    },
  });

  if (result.state === 'deferred') {
    throw new Error('tool-call-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('tool-call-needs-reconciliation');
  }
  await ports.applyReceipt(result.outcome, result.completedAt);
  return {
    completedAt: result.completedAt,
    executedNow,
    outcome: result.outcome,
  };
}
