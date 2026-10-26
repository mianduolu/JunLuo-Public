import {
  createSyncExecutionOperationId,
} from '../sync/syncExecutionOperationId';
import type { SyncExecutionOnceCoordinatorV2 } from '../sync/syncExecutionOnceV2Controller';

import type {
  WalletBuyExecution,
  WalletDecision,
  WalletTransaction,
} from './walletStore';

export type WalletBuyExecutionOncePorts = {
  createCoordinator(
    baseUrl: string,
  ): Promise<Pick<SyncExecutionOnceCoordinatorV2, 'execute'>>;
  executeLocally(input: WalletBuyExecution): Promise<WalletTransaction>;
  loadDecision(decisionId: string): Promise<WalletDecision | null>;
  loadRelayBaseUrl(): Promise<string>;
  loadTransaction(decisionId: string): Promise<WalletTransaction | null>;
  syncEnrollmentReady: boolean;
};

export async function runWalletBuyExecutionOnce(
  input: WalletBuyExecution,
  ports: WalletBuyExecutionOncePorts,
) {
  const existing = await ports.loadTransaction(input.decisionId);
  if (existing) return existing;

  const decision = await ports.loadDecision(input.decisionId);
  if (!decision) throw new Error('decision-not-found');
  if (decision.action !== 'buy') throw new Error('decision-not-buy');
  if (
    decision.status !== 'proposed'
    && decision.status !== 'approved'
  ) {
    throw new Error('decision-not-proposed');
  }

  if (!ports.syncEnrollmentReady) {
    return ports.executeLocally(input);
  }

  const baseUrl = (await ports.loadRelayBaseUrl()).trim();
  if (!baseUrl) throw new Error('sync-relay-not-configured');
  const coordinator = await ports.createCoordinator(baseUrl);
  const result = await coordinator.execute({
    operationId: createSyncExecutionOperationId({
      category: 'wallet-transaction',
      scope: 'wallet.decision',
      entityId: decision.id,
      action: 'execute-buy:v1',
    }),
    category: 'wallet-transaction',
    createdAt: decision.createdAt,
    reconcile: async () => (
      await ports.loadTransaction(decision.id) ? 'completed' : null
    ),
    execute: async () => {
      await ports.executeLocally(input);
      return 'completed';
    },
  });

  if (result.state === 'deferred') {
    throw new Error('wallet-execution-owned-by-another-device');
  }
  if (result.state === 'reconciliation-required') {
    throw new Error('wallet-execution-needs-reconciliation');
  }
  if (result.outcome !== 'completed') {
    throw new Error('wallet-execution-failed');
  }
  const transaction = await ports.loadTransaction(decision.id);
  if (!transaction) {
    throw new Error('wallet-executed-on-another-device');
  }
  return transaction;
}
