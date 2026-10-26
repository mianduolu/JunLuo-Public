import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SQLiteDatabase } from 'expo-sqlite';
import { CONTINUITY_PENDING_OPERATION_STORAGE_KEY } from '../../sync/syncContinuityPendingOperation';
import { HEART_CARE_RECORD_PREDICATE, isHeartCareMatter } from './heartCareMatter';

export const CHAT_CARE_CLEANUP_KEY = 'junluo.chatCare.v3.cleaned';
export const RETIRED_CARE_APPOINTMENTS_KEY = 'junluo.careAppointments.v1';

export function restoredCareCleanupScope(storage: Record<string, string>) {
  // A pre-migration backup still needs its one-time legacy-card cleanup.
  return storage[CHAT_CARE_CLEANUP_KEY] === '3' ? 'restored-chat' as const : 'all-existing' as const;
}

/** Restore discards chat care, not future system-generated body/schedule care. */
export const CHAT_CARE_RECORD_PREDICATE = `kind = 'care_process' AND (schema_version = 3
  OR id LIKE 'care:%' OR idempotency_key LIKE 'care-update:%'
  OR (source_kind = 'real_care' AND NOT ${HEART_CARE_RECORD_PREDICATE} AND EXISTS (SELECT 1 FROM continuity_event_links l
    WHERE l.event_id = continuity_events.id AND l.target_kind = 'chat_session'))) `;

export function isChatCarePendingOperation(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const operation = value as Record<string, any>;
  return operation.type === 'care_matter'
    || (operation.type === 'create' && operation.event?.kind === 'care_process'
      && (operation.event.schemaVersion === 3 || operation.event.id?.startsWith('care:')
        || operation.event.idempotencyKey?.startsWith('care-update:')
        || operation.event.source?.kind === 'real_care' && !isHeartCareMatter(operation.event) && Array.isArray(operation.links)
          && operation.links.some((link: any) => link.targetKind === 'chat_session')));
}

export async function clearCareRecords(database: SQLiteDatabase, scope: 'all-existing' | 'restored-chat') {
  const predicate = scope === 'all-existing' ? "kind = 'care_process'" : CHAT_CARE_RECORD_PREDICATE;
  let before = 0;
  let after = 0;
  const ids = new Set<string>();
  await database.withExclusiveTransactionAsync(async transaction => {
    const rows = await transaction.getAllAsync<{ id: string }>(`SELECT id FROM continuity_events WHERE ${predicate}`);
    rows.forEach(row => ids.add(row.id));
    before = rows.length;
    // Legacy composite link IDs can exceed the sync transport's 256-character limit.
    // Delete only those owned child rows locally; the captured parent deletion
    // already cascades them on peers. Keep normal links and parent capture intact.
    const oversizedLinks = `event_id IN (SELECT id FROM continuity_events WHERE ${predicate})
      AND length(json_array(event_id, relation, target_kind, target_id)) > 256`;
    if (await transaction.getFirstAsync(`SELECT 1 FROM continuity_event_links WHERE ${oversizedLinks} LIMIT 1`)) {
      const runtime = await transaction.getFirstAsync<{ suppress_capture: number }>('SELECT suppress_capture FROM memory_sync_runtime WHERE singleton_id = 1');
      if (runtime?.suppress_capture === 0) await transaction.runAsync('UPDATE memory_sync_runtime SET suppress_capture = 1 WHERE singleton_id = 1');
      try {
        await transaction.runAsync(`DELETE FROM continuity_event_links WHERE ${oversizedLinks}`);
      } finally {
        if (runtime?.suppress_capture === 0) await transaction.runAsync('UPDATE memory_sync_runtime SET suppress_capture = 0 WHERE singleton_id = 1');
      }
    }
    for (const { id } of rows) {
      await transaction.runAsync('DELETE FROM continuity_event_candidates WHERE target_event_id = ? OR result_event_id = ?', id, id);
      await transaction.runAsync("DELETE FROM continuity_event_links WHERE event_id = ? OR (target_kind = 'continuity_event' AND target_id = ?)", id, id);
      await transaction.runAsync('DELETE FROM continuity_event_transitions WHERE event_id = ?', id);
      await transaction.runAsync('DELETE FROM continuity_events WHERE id = ?', id);
    }
    await transaction.runAsync("DELETE FROM continuity_event_candidates WHERE event_kind = 'care_process'");
    after = (await transaction.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n FROM continuity_events WHERE ${predicate}`))?.n ?? 0;
    if (after !== 0) throw new Error('chat_care_cleanup_incomplete');
  });
  const raw = await AsyncStorage.getItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
  if (raw) {
    let operation: any;
    try { const parsed = JSON.parse(raw); operation = parsed.logicalMutation ?? parsed; } catch { operation = null; }
    if (isChatCarePendingOperation(operation) || ids.has(operation?.eventId) || ids.has(operation?.event?.id)
      || scope === 'all-existing' && operation?.event?.kind === 'care_process'
      || operation?.candidate?.eventKind === 'care_process') {
      await AsyncStorage.removeItem(CONTINUITY_PENDING_OPERATION_STORAGE_KEY);
    }
  }
  await AsyncStorage.removeItem(RETIRED_CARE_APPOINTMENTS_KEY);
  await AsyncStorage.setItem(CHAT_CARE_CLEANUP_KEY, '3');
  console.info('[chat-care-cleanup]', { scope, before, after });
  return { before, after };
}

let cleanupFlight: Promise<unknown> | undefined;
export async function ensureChatCareCleanup(database: SQLiteDatabase) {
  if (await AsyncStorage.getItem(CHAT_CARE_CLEANUP_KEY) === '3') return;
  if (!cleanupFlight) cleanupFlight = clearCareRecords(database, 'all-existing').finally(() => { cleanupFlight = undefined; });
  await cleanupFlight;
}
