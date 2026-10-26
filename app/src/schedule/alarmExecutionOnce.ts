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
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runAlarmHandlingOnce(alarmId, {
    syncEnrollmentReady: enrollment !== null,
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
