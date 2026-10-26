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
  const enrollment = await loadCurrentSyncRelayEnrollment();
  return runScheduleOccurrenceCompletionOnce(occurrenceId, {
    syncEnrollmentReady: enrollment !== null,
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
