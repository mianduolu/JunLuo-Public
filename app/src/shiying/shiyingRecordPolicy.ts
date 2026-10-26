import { createShiyingDraftRecord, parseShiyingRecordV1, type ShiyingRecordV1 } from './shiyingJournalContract';

export const SHIYING_RECORD_IMAGE_LIMIT = 9;
export const SHIYING_RECORD_PREVIEW_LENGTH = 240;

export function getShiyingYesterdayRecordDate(createdAt: number): string {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('shiying_record_invalid_time');
  const yesterday = new Date(createdAt);
  yesterday.setDate(yesterday.getDate() - 1);
  return [String(yesterday.getFullYear()).padStart(4, '0'),
    String(yesterday.getMonth() + 1).padStart(2, '0'), String(yesterday.getDate()).padStart(2, '0')].join('-');
}

/** Backfill only yesterday; creation and mutation times still describe the real write. */
export function createShiyingYesterdayDraftRecord(createdAt: number,
  recordDate = getShiyingYesterdayRecordDate(createdAt)): ShiyingRecordV1 {
  const record = createShiyingDraftRecord({ createdAt });
  // V1 requires the saved cutoff to be later than creation. Backfill is eligible
  // after that first millisecond, not at another midnight; the live-editor and
  // interrupted-writing markers still protect autosaved drafts until finishing.
  return parseShiyingRecordV1({ ...record, recordDate, nominalFinalizeAt: createdAt + 1 });
}

export function getShiyingRecordResumeUntilAt(createdAt: number): number {
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error('shiying_record_invalid_time');
  const date = new Date(createdAt);
  const end = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 2).getTime();
  if (!Number.isSafeInteger(end)) throw new Error('shiying_record_invalid_time');
  return end;
}

export type ShiyingRecordCreationBasis = Pick<ShiyingRecordV1, 'recordDate' | 'nominalFinalizeAt'> & { resumeUntilAt: number };
/** Freeze the existing calendar calculations when the date action is clicked, before its queue. */
export function getShiyingRecordCreationBasis(now: number, date: 'today' | 'yesterday'): ShiyingRecordCreationBasis {
  const record = date === 'yesterday' ? createShiyingYesterdayDraftRecord(now) : createShiyingDraftRecord({ createdAt: now });
  return { recordDate: record.recordDate, nominalFinalizeAt: record.nominalFinalizeAt, resumeUntilAt: getShiyingRecordResumeUntilAt(now) };
}

export function isShiyingRecordBlank(record: Pick<ShiyingRecordV1, 'body' | 'images'>): boolean {
  return record.body.trim().length === 0 && record.images.length === 0;
}

export type ShiyingRecordLocalState = { recordId: string; resumeUntilAt: number; editing: boolean };

export function getShiyingRecordEffectiveDeadline(
  record: Pick<ShiyingRecordV1, 'id' | 'status' | 'nominalFinalizeAt'>,
  local: ShiyingRecordLocalState | null,
  liveEditorId: string | null,
): number | null {
  if (record.status === 'finalized' || record.id === liveEditorId) return null;
  return local?.editing ? local.resumeUntilAt : record.nominalFinalizeAt;
}
