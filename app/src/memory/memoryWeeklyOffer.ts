import { getMemoryDatabase, memoryFromRow, type MemoryEntry } from './memoryStore';
import { getWeeklyContextStatus, weeklyTargetHash } from './memoryWeeklyBasis';
import { takeWeeklySentencePrefix } from './memoryWeeklyMaterialText';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';

export type WeeklyOfferRef = { id: string; version: string };
type ReceiptRow = { memory_id: string; candidate_json: string; resolved_at: number };
type WeeklyReceipt = { savedWeeklyVersion?: string; weeklyProvided?: {
  opportunityId: string; sessionId: string; messageId: string; savedAt: number;
} };

/** Only a confirmed candidate saved by this version creates an invitation receipt. */
export async function loadWeeklyOffer(ref: WeeklyOfferRef): Promise<MemoryEntry | null> {
  const db = await getMemoryDatabase('ingestion');
  const receipt = await db.getFirstAsync<ReceiptRow>(
    `SELECT memory_id, candidate_json, resolved_at FROM memory_ingestion_items
     WHERE status = 'saved' AND memory_id = ? AND json_extract(candidate_json, '$.savedWeeklyVersion') = ? LIMIT 1`, ref.id, ref.version);
  if (!receipt) return null;
  const row = await db.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', ref.id);
  if (!row) return null;
  const memory = memoryFromRow(row);
  if (memory.type === 'archived' || memory.source !== 'weekly-context' || weeklyTargetHash(memory) !== ref.version
    || await getWeeklyContextStatus(db, memory) !== 'current') return null;
  const latest = await db.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', ref.id);
  if (!latest) return null;
  const current = memoryFromRow(latest);
  return current.type !== 'archived' && weeklyTargetHash(current) === ref.version ? current : null;
}

export async function loadUnprovidedWeeklyOffers(): Promise<Array<{ memory: MemoryEntry; version: string; savedAt: number }>> {
  const db = await getMemoryDatabase('ingestion');
  const rows = await db.getAllAsync<ReceiptRow>(
    `SELECT memory_id, candidate_json, resolved_at FROM memory_ingestion_items
     WHERE status = 'saved' AND memory_id IS NOT NULL
       AND json_type(candidate_json, '$.savedWeeklyVersion') = 'text'
     ORDER BY resolved_at DESC, batch_id, item_key`);
  const provided = new Set(rows.flatMap(row => {
    const receipt = JSON.parse(row.candidate_json) as WeeklyReceipt;
    return receipt.weeklyProvided ? [`${row.memory_id}\0${receipt.savedWeeklyVersion}`] : [];
  }));
  const seen = new Set<string>();
  const result: Array<{ memory: MemoryEntry; version: string; savedAt: number }> = [];
  for (const row of rows) {
    const receipt = JSON.parse(row.candidate_json) as WeeklyReceipt;
    const version = receipt.savedWeeklyVersion!; const key = `${row.memory_id}\0${version}`;
    if (seen.has(key) || provided.has(key)) continue;
    seen.add(key);
    const memory = await loadWeeklyOffer({ id: row.memory_id, version });
    if (memory) result.push({ memory, version, savedAt: row.resolved_at });
  }
  return result;
}

function day(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatWeeklyOffer(memory: MemoryEntry, maxChars = 1000): string {
  const basis = memory.weeklyContextBasis;
  if (!basis) return '';
  const header = `【已确认的周回顾】\n时间：${day(basis.startAt)}—${day(basis.endAt - 1)}\n标题：${memory.title}\n`;
  const footer = '\n有合适的机会，I 想邀 you 一起看看这一周的回顾。';
  const available = maxChars - header.length - footer.length - '正文（全文）：'.length;
  const content = takeWeeklySentencePrefix(memory.content, available);
  if (!content) return '';
  return `${header}正文（${content === memory.content ? '全文' : '片段'}）：${content}${footer}`;
}

/** The caller has verified the fixed ID and exact model bubble in its real session. */
export async function recordWeeklyOfferProvided(ref: WeeklyOfferRef, provided: NonNullable<WeeklyReceipt['weeklyProvided']>, epoch: number) {
  await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const db = await getMemoryDatabase('ingestion');
    await db.withExclusiveTransactionAsync(async transaction => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      // Retain the old receipt if the card changed after delivery; never credit a newer version.
      await transaction.runAsync(`UPDATE memory_ingestion_items
        SET candidate_json = json_set(candidate_json, '$.weeklyProvided', json(?))
        WHERE status = 'saved' AND memory_id = ?
          AND json_extract(candidate_json, '$.savedWeeklyVersion') = ?
          AND json_type(candidate_json, '$.weeklyProvided') IS NULL`, JSON.stringify(provided), ref.id, ref.version);
    });
  }));
}
