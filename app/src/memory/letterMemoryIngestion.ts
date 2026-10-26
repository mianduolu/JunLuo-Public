import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getLetterMemoryParts, loadLetterMemoryPart, type LetterMemoryPart } from '../letters/letterMemorySource';
import type { LetterEntry } from '../letters/letterStore';
import { stableMemoryHash } from './memoryAtomicity';
import { beginMemoryIngestionBatch, loadMemoryIngestionBatch } from './memoryIngestionService';
import { getMemoryDatabase } from './memoryStore';
import { takeWeeklySentencePrefix } from './memoryWeeklyMaterialText';
import type { MemoryIngestionBatchInput } from './memoryIngestionLedger';

/** Full-source identity and the precise range sent in this request. No source text is persisted here. */
export type LetterMaterialBinding = {
  sessionId: string; messageId: string; sourceHash: string; start: number; end: number;
  sentHash: string; title: string; label: LetterMemoryPart['label']; full?: boolean;
};
export type PreparedLetterMaterial = {
  binding: LetterMaterialBinding; message: SubjectiveMessage; batch: MemoryIngestionBatchInput;
};
export const LETTER_MATERIAL_LIMIT = 6000;
export function renderLetterMaterial(message: SubjectiveMessage, binding: LetterMaterialBinding, full = !!binding.full) {
  return `【信件原文｜${binding.title}｜${binding.label}】\n[messageId=${message.id}][time=${new Date(message.createdAt).toISOString()}] ${message.role}：\n正文（${full ? '全文' : '片段'}）：${message.content}`;
}
export async function registerLetterMemoryParts(letter: LetterEntry, dataEpoch = captureBackupRestoreDataEpoch()) {
  for (const part of getLetterMemoryParts(letter)) {
    const id = `memory-letter-source-${stableMemoryHash(`${part.sessionId}:${part.messageId}:${part.sourceHash}`)}`;
    if (await loadMemoryIngestionBatch(id)) continue;
    await runBackupRestoreDataEpochCommit(dataEpoch, () => beginMemoryIngestionBatch({
      id, stream: 'letter', scopeKey: part.sessionId, sourceHash: part.sourceHash, advancesCursor: false,
      workMetadata: { version: 1, workId: id, messageIds: [], letterRegistration: {
        sessionId: part.sessionId, messageId: part.messageId, sourceHash: part.sourceHash, availableAt: part.availableAt,
      } },
    }));
  }
}
export function prepareLetterFragment(part: LetterMemoryPart, start: number): Omit<PreparedLetterMaterial, 'batch'> | null {
  const message: SubjectiveMessage = { id: part.messageId, role: part.role, createdAt: part.createdAt, content: '', source: 'letter' };
  const binding: LetterMaterialBinding = { sessionId: part.sessionId, messageId: part.messageId,
    sourceHash: part.sourceHash, start, end: start, sentHash: '', title: part.title, label: part.label };
  // Reserve the final separator as part of the letter's own budget.
  const available = LETTER_MATERIAL_LIMIT - renderLetterMaterial(message, binding).length - 2;
  const content = takeWeeklySentencePrefix(part.content.slice(start), available);
  if (!content.trim()) return null;
  binding.end = start + content.length;
  binding.full = start === 0 && binding.end === part.content.length;
  binding.sentHash = stableMemoryHash(content);
  return { message: { ...message, content }, binding };
}
export async function validateLetterBinding(binding: LetterMaterialBinding, sent?: SubjectiveMessage) {
  const part = await loadLetterMemoryPart(binding.sessionId, binding.messageId);
  if (!part || part.sourceHash !== binding.sourceHash || binding.start < 0 || binding.end <= binding.start
    || binding.end > part.content.length) return false;
  const content = part.content.slice(binding.start, binding.end);
  return stableMemoryHash(content) === binding.sentHash && (!sent || (sent.id === part.messageId
    && sent.role === part.role && sent.createdAt === part.createdAt && sent.content === content));
}
export async function restoreLetterMaterial(binding: LetterMaterialBinding, sessionId: string): Promise<PreparedLetterMaterial> {
  const part = await loadLetterMemoryPart(binding.sessionId, binding.messageId);
  if (!part || !(await validateLetterBinding(binding))) throw new Error('MEMORY_SOURCE_CHANGED');
  const id = `memory-letter-range-${stableMemoryHash(JSON.stringify([part.sessionId, part.messageId, part.sourceHash, binding.start, binding.end]))}`;
  const batch = await loadMemoryIngestionBatch(id);
  return { binding, message: { id: part.messageId, role: part.role, createdAt: part.createdAt,
    content: part.content.slice(binding.start, binding.end), source: 'letter' },
    batch: batch ?? { id, stream: 'letter', scopeKey: part.sessionId, sessionId, advancesCursor: false, sourceHash: part.sourceHash,
      workMetadata: { version: 1, workId: id, messageIds: [], letter: binding } } };
}
export async function nextLetterMaterial(sessionId: string): Promise<{ material?: PreparedLetterMaterial; blockedSentence: boolean }> {
  const db = await getMemoryDatabase();
  const rows = await db.getAllAsync<{ id: string; status: string; work_metadata_json: string | null }>(
    "SELECT id, status, work_metadata_json FROM memory_ingestion_batches WHERE stream = 'letter' OR json_type(work_metadata_json, '$.letter') IS NOT NULL ORDER BY created_at, id");
  const records = rows.map(row => ({ ...row, work: row.work_metadata_json ? JSON.parse(row.work_metadata_json) : {} }));
  const registrations = records.filter(row => row.work.letterRegistration)
    .sort((a, b) => a.work.letterRegistration.availableAt - b.work.letterRegistration.availableAt || a.id.localeCompare(b.id));
  let blockedSentence = false;
  for (const registration of registrations) {
    const ref = registration.work.letterRegistration;
    const part = await loadLetterMemoryPart(ref.sessionId, ref.messageId);
    if (!part || part.sourceHash !== ref.sourceHash) continue;
    const ranges = records.filter(row => row.work.letter?.sessionId === part.sessionId);
    // Includes stale pending drafts: never replace edits or start the next part behind them.
    if (ranges.some(row => ['ready', 'waiting'].includes(row.status))) continue;
    let start = 0;
    for (const row of ranges.filter(row => row.work.letter.messageId === part.messageId
      && row.work.letter.sourceHash === part.sourceHash).sort((a, b) => a.work.letter.start - b.work.letter.start)) {
      if (['resolved', 'no_value'].includes(row.status) && row.work.letter.start === start) start = row.work.letter.end;
    }
    if (start >= part.content.length || !part.content.slice(start).trim()) continue;
    const fragment = prepareLetterFragment(part, start);
    if (!fragment) { blockedSentence = true; continue; }
    const id = `memory-letter-range-${stableMemoryHash(JSON.stringify([part.sessionId, part.messageId, part.sourceHash, start, fragment.binding.end]))}`;
    const existing = await loadMemoryIngestionBatch(id);
    const batch: MemoryIngestionBatchInput = existing ?? { id, stream: 'letter', scopeKey: part.sessionId, sessionId,
      advancesCursor: false, sourceHash: part.sourceHash,
      workMetadata: { version: 1, workId: id, messageIds: [], letter: fragment.binding } };
    return { material: { ...fragment, batch }, blockedSentence };
  }
  return { blockedSentence };
}
export function isLetterChatCopy(message: SubjectiveMessage) {
  return message.source === 'letter' || /^letter-.+-(original|reply)$/.test(message.id);
}
