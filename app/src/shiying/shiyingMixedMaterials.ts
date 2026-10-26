import { assertShiyingLifeDate, type ShiyingEntryV1 } from './shiyingContract';
import {
  createShiyingEntryFactContentHash, createShiyingRecordContentHash, type ShiyingRecordV1,
} from './shiyingJournalContract';
import { loadShiyingRecordWithDatabase } from './shiyingJournalStore';
import { loadEntryWithDatabase } from './shiyingStore';
import { runShiyingDatabaseOperation } from './shiyingDatabase';
import { loadShiyingRecordImageNoteWithDatabase, loadShiyingRecordImageJobWithDatabase } from './shiyingImageNoteStore';
import { createShiyingImageNoteResultHash, hashShiyingJson as hash, type ShiyingRecordImageNoteV1 } from './shiyingImageNoteContract';

/** Read model only, not a model request, persisted payload or sync entity. */
export type ShiyingMixedMaterialV1 = {
  kind: 'entry' | 'record';
  id: string;
  date: string;
  dateKind: 'life_date' | 'record_date';
  createdAt: number;
  author: 'I' | 'you';
  body: string;
  sourceContentHash: string;
  materialHash: string;
  imageIds: string[];
  imageState: 'none' | 'pending' | 'ready' | 'skipped' | 'stale';
  imageNote: { id: string; author: 'I'; body: string; resultHash: string; editedAt: number | null } | null;
};

export function projectShiyingMixedEntry(entry: ShiyingEntryV1): ShiyingMixedMaterialV1 | null {
  if (entry.status !== 'active') return null;
  const sourceContentHash = createShiyingEntryFactContentHash(entry);
  return {
    kind: 'entry', id: entry.id, date: entry.lifeDate, dateKind: 'life_date', createdAt: entry.createdAt,
    author: 'I', body: entry.body, sourceContentHash,
    materialHash: hash({ kind: 'entry', id: entry.id, sourceContentHash }),
    imageIds: [], imageState: 'none', imageNote: null,
  };
}

export function projectShiyingMixedRecord(input: {
  record: ShiyingRecordV1;
  note: ShiyingRecordImageNoteV1 | null;
  jobSkipped?: boolean;
}): ShiyingMixedMaterialV1 | null {
  const { record, note } = input;
  if (record.status !== 'finalized') return null;
  const sourceContentHash = createShiyingRecordContentHash(record);
  const matching = !!note && note.recordContentHash === sourceContentHash && note.recordDate === record.recordDate
    && note.contractVersion === 1 && note.images.length === record.images.length
    && note.images.every((image, index) => image.id === record.images[index].id
      && image.ordinal === record.images[index].ordinal && image.contentHash === record.images[index].contentHash);
  const imageState = !record.images.length ? 'none' : note && !matching ? 'stale'
    : matching && note!.status === 'ready' ? 'ready'
      : matching && note!.status === 'skipped' || input.jobSkipped ? 'skipped' : 'pending';
  const resultHash = matching ? createShiyingImageNoteResultHash(note!) : null;
  const imageNote = matching && note!.status === 'ready' ? {
    id: note!.id, author: 'I' as const, body: note!.body!, resultHash: resultHash!, editedAt: note!.editedAt,
  } : null;
  return {
    kind: 'record', id: record.id, date: record.recordDate, dateKind: 'record_date', createdAt: record.createdAt,
    author: 'you', body: record.body, sourceContentHash,
    materialHash: hash({ kind: 'record', id: record.id, sourceContentHash, imageState, resultHash }),
    imageIds: record.images.map(image => image.id), imageState, imageNote,
  };
}

export async function loadShiyingMixedMaterials(options: { dateStart?: string; dateEnd?: string } = {}) {
  if (options.dateStart) assertShiyingLifeDate(options.dateStart, 'mixed_start_date');
  if (options.dateEnd) assertShiyingLifeDate(options.dateEnd, 'mixed_end_date');
  if (options.dateStart && options.dateEnd && options.dateStart > options.dateEnd) throw new Error('shiying_mixed_date_range');
  return runShiyingDatabaseOperation(async db => {
  const result: ShiyingMixedMaterialV1[] = [];
  const start = options.dateStart ?? '0001-01-01', end = options.dateEnd ?? '9999-12-31';
  const entries = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM shiying_entries WHERE status='active' AND life_date BETWEEN ? AND ? ORDER BY life_date,event_started_at,id;", start, end);
  for (const { id } of entries) {
    const entry = await loadEntryWithDatabase(db, id);
    if (entry) result.push(projectShiyingMixedEntry(entry)!);
  }
  const records = await db.getAllAsync<{ id: string }>(
    "SELECT id FROM shiying_records WHERE status='finalized' AND record_date BETWEEN ? AND ? ORDER BY record_date,created_at,id;", start, end);
  for (const { id } of records) {
    const record = await loadShiyingRecordWithDatabase(db, id);
    if (!record) continue;
    const note = record.images.length ? await loadShiyingRecordImageNoteWithDatabase(db, id) : null;
    const job = record.images.length ? await loadShiyingRecordImageJobWithDatabase(db, id) : null;
    result.push(projectShiyingMixedRecord({ record, note, jobSkipped: job?.status === 'skipped' })!);
  }
  const unique = [...new Map(result.map(material => [`${material.kind}:${material.id}`, material])).values()];
  return unique.sort((left, right) => left.date < right.date ? -1 : left.date > right.date ? 1
    : left.createdAt - right.createdAt || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1
      : left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  });
}
