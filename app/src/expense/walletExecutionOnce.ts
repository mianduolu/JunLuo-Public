import { loadBackendSettings } from '../backend/backendClient';
import {
  createAndroidSyncExecutionOnceController,
} from '../sync/syncExecutionOnceExpo';
import {
  loadCurrentSyncRelayEnrollment,
} from '../sync/syncRelayClientExpo';

import {
  approveWalletBuyDecision as approveWalletBuyDecisionLocally,
  loadWalletDecisionById,
  loadWalletTransactionByDecisionId,
  type WalletBuyExecution,
} from './walletStore';
import { runWalletBuyExecutionOnce } from './walletExecutionOnceCore';

export async function approveWalletBuyDecisionOnce(
  input: WalletBuyExecution,
) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runWalletBuyExecutionOnce(input, {
    syncEnrollmentReady: enrollment !== null,
    loadDecision: loadWalletDecisionById,
    loadTransaction: loadWalletTransactionByDecisionId,
    executeLocally: approveWalletBuyDecisionLocally,
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}
