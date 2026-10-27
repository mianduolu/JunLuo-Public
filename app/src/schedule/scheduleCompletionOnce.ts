import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { ensurePhonePrimaryActivation, loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { createPhonePrimaryInternalExecutor, phonePrimaryExecutionScope } from '../runtime/phonePrimaryInternalExecution';
import { AndroidSyncExecutionFenceV2SqlitePort } from '../sync/syncExecutionFenceSqlitePort';
import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';

import { runScheduleOccurrenceCompletionOnce } from './scheduleCompletionOnceCore';
import {
  applyOccurrenceCompletionReceipt,
  completeOccurrenceOnce,
  loadScheduleItemById,
  loadScheduleOccurrence,
} from './scheduleStore';

export async function completeScheduleOccurrenceOnce(occurrenceId: string, completedAt?: number, isCurrent?: () => boolean | Promise<boolean>) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const activation = await ensurePhonePrimaryActivation();
  const identityScope = phonePrimaryExecutionScope(enrollment);
  const fence = enrollment ? new AndroidSyncExecutionFenceV2SqlitePort() : null;
  return runScheduleOccurrenceCompletionOnce(occurrenceId, {
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
      mode: 'local-completion',
      loadFence: (operationId) => fence?.load(operationId) ?? Promise.resolve(null),
    }) : async (input) => ({ state: 'reconciliation-required', operationId: input.operationId }),
    loadOccurrence: loadScheduleOccurrence,
    loadItemCreatedAt: async (itemId) => (
      await loadScheduleItemById(itemId)
    )?.createdAt ?? null,
    completeLocally: async (id, round) => {
      if (isCurrent && !await isCurrent()) throw new Error('schedule-completion-source-changed');
      return completeOccurrenceOnce(id, completedAt, round);
    },
    applyCompletionReceipt: async (id, time, round) => {
      if (isCurrent && !await isCurrent()) throw new Error('schedule-completion-source-changed');
      return applyOccurrenceCompletionReceipt(id, time, round);
    },
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}
