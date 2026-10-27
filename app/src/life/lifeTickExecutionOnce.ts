import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { ensurePhonePrimaryActivation, loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { createPhonePrimaryInternalExecutor, phonePrimaryExecutionScope } from '../runtime/phonePrimaryInternalExecution';
import { AndroidSyncExecutionFenceV2SqlitePort } from '../sync/syncExecutionFenceSqlitePort';
import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from
  '../sync/syncExecutionOnceExpo';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import { loadCurrentSyncRelayEnrollment } from
  '../sync/syncRelayClientExpo';

import {
  runLifeTickExecutionOnce,
  type LifeTickExecutionIdentity,
} from './lifeTickExecutionOnceCore';

export async function executeLifeTickOnce(
  identity: LifeTickExecutionIdentity,
  callbacks: {
    applyReceipt(
      outcome: SyncExecutionOutcomeV2,
      completedAt: number,
    ): Promise<void>;
    executeLocally(): Promise<SyncExecutionOutcomeV2>;
    reconcileLocally(): Promise<SyncExecutionOutcomeV2 | null>;
  },
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const activation = await ensurePhonePrimaryActivation();
  const identityScope = phonePrimaryExecutionScope(enrollment);
  const fence = enrollment ? new AndroidSyncExecutionFenceV2SqlitePort() : null;
  return runLifeTickExecutionOnce(identity, {
    ...callbacks,
    syncEnrollmentReady: enrollment !== null,
    phonePrimaryExecute: activation ? createPhonePrimaryInternalExecutor({
      activatedAt: activation.activatedAt,
      identityScope,
      dataEpoch,
      isCurrent: async () => {
        const current = await loadPhonePrimaryActivation();
        return current?.activatedAt === activation.activatedAt
          && phonePrimaryExecutionScope(await loadCurrentSyncRelayEnrollment()) === identityScope;
      },
      mode: 'new-life',
      loadFence: (operationId) => fence?.load(operationId) ?? Promise.resolve(null),
    }) : async (input) => ({ state: 'reconciliation-required', operationId: input.operationId }),
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}
