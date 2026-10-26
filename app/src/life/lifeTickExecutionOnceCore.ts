import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import type { SyncExecutionOnceCoordinatorV2 } from '../sync/syncExecutionOnceV2Controller';

export const LIFE_TICK_EXECUTION_BUCKET_MS = 4 * 60 * 1000;

export type LifeTickExecutionIdentity = {
  bucketStartedAt: number;
};

export type LifeTickExecutionOnceResult = {
  completedAt: number;
  executedNow: boolean;
  outcome: SyncExecutionOutcomeV2;
};

export type LifeTickExecutionOncePorts = {
  applyReceipt(
    outcome: SyncExecutionOutcomeV2,
    completedAt: number,
  ): Promise<void>;
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  executeLocally(): Promise<SyncExecutionOutcomeV2>;
  loadRelayBaseUrl(): Promise<string>;
  reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  syncEnrollmentReady: boolean;
};

export function createLifeTickExecutionIdentity(
  now: number,
): LifeTickExecutionIdentity {
  return {
    bucketStartedAt:
      Math.floor(now / LIFE_TICK_EXECUTION_BUCKET_MS)
      * LIFE_TICK_EXECUTION_BUCKET_MS,
  };
}

export function createLifeTickOperationId(
  identity: LifeTickExecutionIdentity,
) {
  return createSyncExecutionOperationId({
    category: 'life-tick',
    scope: 'life-engine.tick',
    entityId: `bucket:${identity.bucketStartedAt}`,
    action: 'run:v1',
  });
}

export async function runLifeTickExecutionOnce(
  identity: LifeTickExecutionIdentity,
  ports: LifeTickExecutionOncePorts,
): Promise<LifeTickExecutionOnceResult> {
  if (!ports.syncEnrollmentReady) {
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

  const baseUrl = (await ports.loadRelayBaseUrl()).trim();
  if (!baseUrl) throw new Error('sync-relay-not-configured');
  const coordinator = await ports.createCoordinator(baseUrl);
  let executedNow = false;
  const result = await coordinator.execute({
    operationId: createLifeTickOperationId(identity),
    category: 'life-tick',
    createdAt: identity.bucketStartedAt,
    reconcile: ports.reconcileLocally,
    execute: async () => {
      const existingOutcome = await ports.reconcileLocally();
      if (existingOutcome) return existingOutcome;
      executedNow = true;
      return ports.executeLocally();
    },
  });

  if (result.state === 'deferred') {
    throw new Error('life-tick-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('life-tick-needs-reconciliation');
  }
  await ports.applyReceipt(result.outcome, result.completedAt);
  return {
    completedAt: result.completedAt,
    executedNow,
    outcome: result.outcome,
  };
}
