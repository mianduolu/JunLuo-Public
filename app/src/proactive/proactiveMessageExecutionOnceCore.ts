import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import type { SyncExecutionOnceCoordinatorV2 } from '../sync/syncExecutionOnceV2Controller';

export type ProactiveAgentTaskExecutionState = {
  id: string;
  createdAt: number;
  updatedAt: number;
  status: 'pending' | 'delivered' | 'cancelled' | 'expired';
};

export type ProactiveAgentTaskHandlingOnceResult = {
  outcome: SyncExecutionOutcomeV2;
  executedNow: boolean;
  completedAt: number;
};

export type ProactiveMessageDeliveryIdentity = {
  scope: string;
  entityId: string;
  createdAt: number;
};

export type ProactiveMessageDeliveryOncePorts = {
  applyReceipt(
    outcome: SyncExecutionOutcomeV2,
    completedAt: number,
  ): Promise<void>;
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  executeLocally(): Promise<SyncExecutionOutcomeV2>;
  hasDeliveryEvidence(): Promise<boolean>;
  loadRelayBaseUrl(): Promise<string>;
  reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  syncEnrollmentReady: boolean;
};

export type ProactiveAgentTaskHandlingOncePorts = {
  applyReceipt(
    taskId: string,
    outcome: SyncExecutionOutcomeV2,
    completedAt: number,
  ): Promise<void>;
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  executeLocally(): Promise<SyncExecutionOutcomeV2>;
  hasDeliveryEvidence(taskId: string): Promise<boolean>;
  loadRelayBaseUrl(): Promise<string>;
  loadTask(taskId: string): Promise<ProactiveAgentTaskExecutionState | null>;
  syncEnrollmentReady: boolean;
};

export function createProactiveAgentTaskOperationId(taskId: string) {
  return createSyncExecutionOperationId({
    category: 'proactive-message',
    scope: 'proactive.agent-task',
    entityId: taskId,
    action: 'handle:v1',
  });
}

export function createProactiveAgentTaskMessageIdPrefix(taskId: string) {
  return `I-agent-task-${createProactiveAgentTaskOperationId(taskId)}`;
}

export function createProactiveMessageDeliveryOperationId(
  identity: ProactiveMessageDeliveryIdentity,
) {
  return createSyncExecutionOperationId({
    category: 'proactive-message',
    scope: identity.scope,
    entityId: identity.entityId,
    action: 'deliver:v1',
  });
}

export function createProactiveMessageDeliveryMessageIdPrefix(
  identity: ProactiveMessageDeliveryIdentity,
) {
  return `I-proactive-${createProactiveMessageDeliveryOperationId(identity)}`;
}

export async function runProactiveMessageDeliveryOnce(
  identity: ProactiveMessageDeliveryIdentity,
  ports: ProactiveMessageDeliveryOncePorts,
): Promise<ProactiveAgentTaskHandlingOnceResult> {
  const reconcile = async () => (
    await ports.reconcileLocally()
    ?? (await ports.hasDeliveryEvidence() ? 'completed' as const : null)
  );

  if (!ports.syncEnrollmentReady) {
    const existingOutcome = await reconcile();
    const outcome = existingOutcome ?? await ports.executeLocally();
    const completedAt = Date.now();
    await ports.applyReceipt(outcome, completedAt);
    return {
      outcome,
      executedNow: existingOutcome === null,
      completedAt,
    };
  }

  const baseUrl = (await ports.loadRelayBaseUrl()).trim();
  if (!baseUrl) throw new Error('sync-relay-not-configured');
  const coordinator = await ports.createCoordinator(baseUrl);
  let executedNow = false;
  const result = await coordinator.execute({
    operationId: createProactiveMessageDeliveryOperationId(identity),
    category: 'proactive-message',
    createdAt: identity.createdAt,
    reconcile,
    execute: async () => {
      const existingOutcome = await reconcile();
      if (existingOutcome) return existingOutcome;
      executedNow = true;
      return ports.executeLocally();
    },
  });

  if (result.state === 'deferred') {
    throw new Error('proactive-message-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('proactive-message-needs-reconciliation');
  }
  await ports.applyReceipt(result.outcome, result.completedAt);
  return {
    outcome: result.outcome,
    executedNow,
    completedAt: result.completedAt,
  };
}

export function proactiveAgentTaskOutcomeFromState(
  task: ProactiveAgentTaskExecutionState | null,
): SyncExecutionOutcomeV2 | null {
  if (!task || task.status === 'pending') return null;
  if (task.status === 'delivered') return 'completed';
  return 'cancelled';
}

export async function runProactiveAgentTaskHandlingOnce(
  taskId: string,
  ports: ProactiveAgentTaskHandlingOncePorts,
): Promise<ProactiveAgentTaskHandlingOnceResult> {
  const task = await ports.loadTask(taskId);
  if (!task) throw new Error('proactive-agent-task-not-found');

  const reconcile = async () => {
    const stateOutcome = proactiveAgentTaskOutcomeFromState(
      await ports.loadTask(task.id),
    );
    if (stateOutcome) return stateOutcome;
    return await ports.hasDeliveryEvidence(task.id) ? 'completed' as const : null;
  };

  if (!ports.syncEnrollmentReady) {
    const existingOutcome = await reconcile();
    const outcome = existingOutcome ?? await ports.executeLocally();
    const current = await ports.loadTask(task.id);
    const completedAt = current && current.updatedAt > task.updatedAt
      ? current.updatedAt
      : Date.now();
    await ports.applyReceipt(task.id, outcome, completedAt);
    return {
      outcome,
      executedNow: existingOutcome === null,
      completedAt,
    };
  }

  const baseUrl = (await ports.loadRelayBaseUrl()).trim();
  if (!baseUrl) throw new Error('sync-relay-not-configured');
  const coordinator = await ports.createCoordinator(baseUrl);
  let executedNow = false;
  const result = await coordinator.execute({
    operationId: createProactiveAgentTaskOperationId(task.id),
    category: 'proactive-message',
    createdAt: task.createdAt,
    reconcile,
    execute: async () => {
      const existingOutcome = await reconcile();
      if (existingOutcome) return existingOutcome;
      executedNow = true;
      return ports.executeLocally();
    },
  });

  if (result.state === 'deferred') {
    throw new Error('proactive-agent-task-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('proactive-agent-task-needs-reconciliation');
  }
  await ports.applyReceipt(task.id, result.outcome, result.completedAt);
  return {
    outcome: result.outcome,
    executedNow,
    completedAt: result.completedAt,
  };
}
