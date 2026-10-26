import type { SQLiteDatabase } from 'expo-sqlite';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { beginMemoryIngestionBatchWithDatabase } from './memoryIngestionLedger';

export type WeeklyTaskTarget = { memoryId: string; targetKind?: string };
export type WeeklyTaskIntent = { token: string; replacingCandidate?: MemoryCandidateReview };
export function weeklyTaskMetadataId(target: WeeklyTaskTarget) {
  return `weekly-task:${target.targetKind ?? 'memory'}:${target.memoryId}`;
}
export async function loadWeeklyTaskIntent(database: Pick<SQLiteDatabase, 'getFirstAsync'>, target: WeeklyTaskTarget) {
  const row = await database.getFirstAsync<{ work_metadata_json: string | null }>(
    'SELECT work_metadata_json FROM memory_ingestion_batches WHERE id = ?', weeklyTaskMetadataId(target));
  if (!row?.work_metadata_json) return null;
  const parsed = JSON.parse(row.work_metadata_json) as WeeklyTaskIntent;
  return typeof parsed.token === 'string' ? parsed : null;
}
export async function saveWeeklyTaskIntent(database: SQLiteDatabase, target: WeeklyTaskTarget, intent: WeeklyTaskIntent) {
  const id = weeklyTaskMetadataId(target);
  await beginMemoryIngestionBatchWithDatabase(database, { id, scopeKey: id, sourceHash: 'manual-intent', stream: 'weekly', advancesCursor: false });
  await database.runAsync('UPDATE memory_ingestion_batches SET work_metadata_json = ? WHERE id = ?', JSON.stringify(intent), id);
}
export async function clearWeeklyTaskIntent(database: SQLiteDatabase, target: WeeklyTaskTarget, intent: WeeklyTaskIntent | null) {
  if (intent) await database.runAsync(
    "UPDATE memory_ingestion_batches SET work_metadata_json = NULL WHERE id = ? AND json_extract(work_metadata_json, '$.token') = ?",
    weeklyTaskMetadataId(target), intent.token);
}

