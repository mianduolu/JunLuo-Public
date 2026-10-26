import { insertMemoryLifecycleEventWithDatabase } from './memoryLifecycle';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { getMemoryDatabase } from './memoryStore';
import { loadCurrentSyncDevice } from '../sync/syncCurrentDevice';
import { activateMemoryRecordsCapture } from '../sync/syncMemoryRecordsSqlitePort';

export const MEMORY_DUPLICATE_CLEANUP_MARKER_REASON_CODE =
  'memory_duplicate_cleanup_complete_v1' as const;

export function memoryDuplicateCleanupMarkerId(startedAt: number) {
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
    throw new Error('memory cleanup marker startedAt 无效。');
  }
  return `memory-cleanup-complete-${startedAt}`;
}

export async function ensureMemoryDuplicateCleanupCompletionMarker(input: {
  startedAt: number;
  createdAt: number;
}) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const markerId = memoryDuplicateCleanupMarkerId(input.startedAt);
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) {
      throw new Error('memory-cleanup-current-sync-device-unavailable');
    }
    await activateMemoryRecordsCapture(currentDevice.identity, input.createdAt);
    const database = await getMemoryDatabase('store');
    await database.withExclusiveTransactionAsync(async (transaction) => {
      const existing = await transaction.getFirstAsync<{ created_at: number }>(
        `SELECT created_at
         FROM memory_lifecycle_events
         WHERE id = ?`,
        markerId,
      );
      const captured = await transaction.getFirstAsync<{ revision_id: string }>(
        `SELECT revision_id
         FROM memory_sync_entity_heads
         WHERE entity_type = 'lifecycle-event'
           AND entity_id = ?
         LIMIT 1`,
        markerId,
      );
      // A previous publishing attempt may have inserted the marker while
      // memory.records capture was disabled. Reinsert that one orphaned row
      // after binding capture so the normal trigger durably emits a delete
      // followed by the marker append. Once a sync head exists this remains
      // idempotent across every later retry.
      if (existing && !captured) {
        await transaction.runAsync(
          'DELETE FROM memory_lifecycle_events WHERE id = ?',
          markerId,
        );
      }
      await insertMemoryLifecycleEventWithDatabase(transaction, {
        id: markerId,
        memoryId: markerId,
        eventType: 'organized',
        actor: 'maintenance',
        operationId: markerId,
        reasonCode: MEMORY_DUPLICATE_CLEANUP_MARKER_REASON_CODE,
        changedFields: [],
        createdAt: existing?.created_at ?? input.createdAt,
      });
    });
    return markerId;
  });
}
