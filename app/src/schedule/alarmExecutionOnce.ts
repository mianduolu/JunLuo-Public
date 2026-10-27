import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { ensurePhonePrimaryActivation, loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { createPhonePrimaryInternalExecutor, phonePrimaryExecutionScope } from '../runtime/phonePrimaryInternalExecution';
import { AndroidSyncExecutionFenceV2SqlitePort } from '../sync/syncExecutionFenceSqlitePort';
import { loadBackendSettings } from '../backend/backendClient';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import type {
  SyncExecutionOutcomeV2,
} from '../sync/syncExecutionClaimV2Protocol';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';

import {
  runAlarmHandlingOnce,
} from './alarmExecutionOnceCore';
import {
  applyAlarmExecutionReceipt,
  cancelAlarmRecord,
  loadAlarmRecordById,
} from './alarmStore';

export async function executeAlarmHandlingOnce(
  alarmId: string,
  executeLocally: () => Promise<SyncExecutionOutcomeV2>,
) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const activation = Platform.OS === 'android' ? await ensurePhonePrimaryActivation() : undefined;
  const identityScope = phonePrimaryExecutionScope(enrollment);
  const fence = new AndroidSyncExecutionFenceV2SqlitePort();
  return runAlarmHandlingOnce(alarmId, {
    syncEnrollmentReady: enrollment !== null,
    phonePrimaryExecute: Platform.OS !== 'android' ? undefined : activation ? createPhonePrimaryInternalExecutor({
      activatedAt: activation.activatedAt,
      identityScope,
      dataEpoch,
      isCurrent: async () => {
        const current = await loadPhonePrimaryActivation();
        return current?.activatedAt === activation.activatedAt
          && phonePrimaryExecutionScope(await loadCurrentSyncRelayEnrollment()) === identityScope;
      },
      mode: 'new-side-effect',
      sideEffectStorage: AsyncStorage,
      loadFence: (operationId) => fence.load(operationId),
    }) : async (input) => ({ state: 'reconciliation-required', operationId: input.operationId }),
    loadAlarm: loadAlarmRecordById,
    executeLocally,
    applyReceipt: async (id, outcome, completedAt) => {
      await applyAlarmExecutionReceipt(id, outcome, completedAt);
    },
    loadRelayBaseUrl: async () => (await loadBackendSettings()).baseUrl,
    createCoordinator: async (baseUrl) => (
      await createAndroidSyncExecutionOnceController({ baseUrl })
    ).coordinator,
  });
}

export async function cancelAlarmRecordOnce(alarmId: string) {
  const result = await executeAlarmHandlingOnce(
    alarmId,
    async () => (
      await cancelAlarmRecord(alarmId) ? 'cancelled' : 'failed'
    ),
  );
  return result.outcome === 'cancelled';
}
