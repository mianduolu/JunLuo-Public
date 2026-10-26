import type * as SQLite from 'expo-sqlite';
import { assertShiyingDeterministicId, assertShiyingHash, assertShiyingLifeDate, canonicalJsonV1, type ShiyingSummaryKind } from './shiyingContract';
import { parseShiyingSummaryV2, createShiyingEntryFactContentHash, createShiyingRecordContentHash } from './shiyingJournalContract';
import { loadSummaryWithDatabase, loadEntryWithDatabase } from './shiyingStore';
import { loadShiyingRecordWithDatabase } from './shiyingJournalStore';
import { loadShiyingRecordImageNoteWithDatabase } from './shiyingImageNoteStore';
import { createShiyingImageNoteResultHash } from './shiyingImageNoteContract';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import {
  createShiyingEventNodeInputHash, createShiyingSummaryContentHash, createShiyingSummaryStateHash,
  parseShiyingSummaryInputV1, parseShiyingSummarySourceV3, parseShiyingSummaryV3,
  type ShiyingSummaryAnyV3, type ShiyingSummarySourceV3, type ShiyingSummaryV3,
} from './shiyingSummaryContract';
import type { ShiyingTextRange } from './shiyingReviewContract';

type Database = SQLite.SQLiteDatabase;
type Row = Record<string, unknown>;
const listeners = new Set<() => void>();
export function subscribeShiyingSummaryChanges(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function publishShiyingSummaryChanges() { for (const listener of listeners) try { listener(); } catch { /* Committed data stays successful. */ } }
function fail(code: string, id?: string): never { throw new Error(`shiying_summary_store_${code}${id ? `:${id}` : ''}`); }
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) fail('invalid_time'); }
function json(value: unknown): unknown { if (typeof value !== 'string') fail('invalid_json'); try { return JSON.parse(value); } catch { return fail('invalid_json'); } }
async function safe<T>(work: () => Promise<T>) {
  try { return await work(); } catch (error) {
    if (error instanceof Error && /^shiying_[a-z_]+(?::[a-zA-Z0-9_.-]+)?$/u.test(error.message)) throw error;
    return fail('database_operation_failed');
  }
}
export function assertShiyingSummaryRangeBounds(body: string, ranges: ShiyingTextRange[], id: string) {
  for (const { start, end } of ranges) {
    if (start < 0 || end > body.length || end <= start) fail('source_range_bounds', id);
    for (const offset of [start, end]) {
      const left = body.charCodeAt(offset - 1), right = body.charCodeAt(offset);
      if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff) fail('source_range_unicode', id);
    }
  }
}
function rowSource(row: Row): ShiyingSummarySourceV3 {
  return parseShiyingSummarySourceV3({ kind: row.source_kind, id: row.source_id, contentHash: row.content_hash,
    imageIds: json(row.image_ids_json), textRanges: row.text_ranges_json === null ? null : json(row.text_ranges_json),
    imageNoteRanges: row.image_note_ranges_json === null ? null : json(row.image_note_ranges_json), imageNoteHash: row.image_note_hash });
}
export async function loadShiyingSummaryAnyWithDatabase(db: Database, id: string): Promise<ShiyingSummaryAnyV3 | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_summaries WHERE id=?;', id);
  if (!row) return null;
  if (row.payload_version === 1) return loadSummaryWithDatabase(db, id);
  const rows = await db.getAllAsync<Row>('SELECT * FROM shiying_summary_sources WHERE summary_id=? ORDER BY ordinal;', id);
  if (rows.some((source, index) => source.ordinal !== index)) fail('source_order', id);
  const base = { payloadVersion: row.payload_version, id: row.id, kind: row.kind,
    periodStartLifeDate: row.period_start_life_date, periodEndLifeDate: row.period_end_life_date,
    factSummary: row.fact_summary, baiyunNote: row.baiyun_note, inputHash: row.input_hash, contractVersion: row.contract_version,
    status: row.status, dirty: row.dirty === 1, rejectedAt: row.rejected_at, presentedAt: row.presented_at, createdAt: row.created_at, updatedAt: row.updated_at };
  if (row.payload_version === 2) return parseShiyingSummaryV2({ ...base, sources: rows.map(source => ({ kind: source.source_kind,
    id: source.source_id, contentHash: source.content_hash, imageIds: json(source.image_ids_json) })) });
  const inputs = await db.getAllAsync<Row>('SELECT * FROM shiying_summary_inputs WHERE summary_id=? ORDER BY ordinal;', id);
  if (inputs.some((input, index) => input.ordinal !== index)) fail('input_order', id);
  return parseShiyingSummaryV3({ ...base, title: row.title, editedAt: row.edited_at, sourceInvalidated: row.source_invalidated === 1,
    sources: rows.map(rowSource), inputSources: inputs.map(input => {
      const parsed = parseShiyingSummaryInputV1(json(input.payload_json));
      if (parsed.kind !== input.source_kind || parsed.id !== input.source_id || parsed.contentHash !== input.content_hash) fail('input_payload_conflict', id);
      return parsed;
    }), imageCoverage: json(row.image_coverage_json) });
}
export function getShiyingSummaryAnyById(id: string) {
  assertShiyingDeterministicId(id, 'summary');
  return safe(() => runShiyingDatabaseOperation(db => loadShiyingSummaryAnyWithDatabase(db, id)));
}
export function shiyingSummaryOriginalSources(summary: ShiyingSummaryAnyV3): ShiyingSummarySourceV3[] {
  if (summary.payloadVersion === 3) return summary.sources;
  if (summary.payloadVersion === 1) return summary.sourceEntryIds.map(id => ({ kind: 'entry', id, contentHash: null,
    imageIds: [], textRanges: null, imageNoteRanges: null, imageNoteHash: null }));
  return summary.sources.map(source => ({ ...source, textRanges: null, imageNoteRanges: null, imageNoteHash: null }));
}
function rangesContained(inner: ShiyingTextRange[] | null, outer: ShiyingTextRange[] | null) {
  if (inner === null || outer === null) return inner === outer;
  return inner.every(range => outer.some(parent => range.start >= parent.start && range.end <= parent.end));
}
function rootContained(source: ShiyingSummarySourceV3, originals: ShiyingSummarySourceV3[]) {
  return originals.some(original => original.kind === source.kind && original.id === source.id && original.contentHash === source.contentHash
    && canonicalJsonV1(original.imageIds) === canonicalJsonV1(source.imageIds) && original.imageNoteHash === source.imageNoteHash
    && rangesContained(source.textRanges, original.textRanges) && rangesContained(source.imageNoteRanges, original.imageNoteRanges));
}
export async function validateShiyingSummaryV3SourcesWithDatabase(db: Database, summary: ShiyingSummaryV3) {
  for (const input of summary.inputSources) {
    if (input.kind === 'summary') {
      const original = await loadShiyingSummaryAnyWithDatabase(db, input.id);
      const state = await db.getFirstAsync<{ source_invalidated: number }>('SELECT source_invalidated FROM shiying_summaries WHERE id=?;', input.id);
      if (!original || original.status !== 'active' || original.kind !== input.summaryKind
        || original.periodStartLifeDate !== input.periodStartLifeDate || original.periodEndLifeDate !== input.periodEndLifeDate
        || createShiyingSummaryContentHash(original) !== input.contentHash
        || state?.source_invalidated === 1) fail('input_summary_stale', input.id);
      assertShiyingSummaryRangeBounds(original.factSummary, input.textRanges, input.id);
      assertShiyingSummaryRangeBounds(original.baiyunNote, input.noteRanges, input.id);
      if (input.sources.some(root => !rootContained(root, shiyingSummaryOriginalSources(original)))) fail('input_root_conflict', input.id);
    } else {
      const node = await db.getFirstAsync<Row>(`SELECT n.*,e.title FROM shiying_event_nodes n
        JOIN shiying_events e ON e.id=n.event_id WHERE n.id=?;`, input.id);
      if (!node || node.event_id !== input.eventId || node.event_date !== input.eventDate || node.title !== input.title) fail('input_node_stale', input.id);
      const rows = await db.getAllAsync<Row>('SELECT * FROM shiying_event_node_sources WHERE node_id=? ORDER BY ordinal;', input.id);
      const originals = rows.map(rowSource);
      const contentHash = createShiyingEventNodeInputHash({ id: input.id, eventId: input.eventId, eventDate: input.eventDate,
        title: input.title, body: node.body as string, sources: originals });
      if (contentHash !== input.contentHash || input.sources.some(root => !rootContained(root, originals))) fail('input_node_stale', input.id);
      assertShiyingSummaryRangeBounds(node.body as string, input.textRanges, input.id);
    }
  }
  await validateShiyingSummaryRootSourcesWithDatabase(db, summary.sources);
}
export async function validateShiyingSummaryRootSourcesWithDatabase(db: Database, sources: ShiyingSummarySourceV3[]) {
  for (const source of sources) {
    // Legacy hashes/ranges remain unknown, but a deleted or rejected root is still unavailable.
    if (source.kind === 'entry') {
      const entry = await loadEntryWithDatabase(db, source.id);
      if (!entry || entry.status !== 'active' || source.contentHash !== null && createShiyingEntryFactContentHash(entry) !== source.contentHash) fail('source_entry_stale', source.id);
      if (source.textRanges !== null) assertShiyingSummaryRangeBounds(entry.body, source.textRanges, source.id);
    } else {
      const record = await loadShiyingRecordWithDatabase(db, source.id);
      if (!record || record.status !== 'finalized' || source.contentHash !== null && createShiyingRecordContentHash(record) !== source.contentHash) fail('source_record_stale', source.id);
      const positions = source.imageIds.map(id => record.images.findIndex(image => image.id === id));
      if (positions.some((position, index) => position < 0 || index > 0 && position <= positions[index - 1])) fail('source_image_order', source.id);
      if (source.textRanges !== null) assertShiyingSummaryRangeBounds(record.body, source.textRanges, source.id);
      if (source.imageNoteHash !== null) {
        const note = await loadShiyingRecordImageNoteWithDatabase(db, source.id);
        if (!note || note.status !== 'ready' || note.body === null || note.recordContentHash !== source.contentHash
          || createShiyingImageNoteResultHash(note) !== source.imageNoteHash) fail('source_image_note_stale', source.id);
        if (source.imageNoteRanges !== null) assertShiyingSummaryRangeBounds(note.body, source.imageNoteRanges, source.id);
      }
    }
  }
}
export type ShiyingSummarySaveOptions = {
  expectedStateHash?: string | null; allowHumanReplacement?: boolean; validateSources?: boolean;
};
async function writeSummary(db: Database, summary: ShiyingSummaryV3) {
  await db.runAsync(`INSERT INTO shiying_summaries
    (id,kind,period_start_life_date,period_end_life_date,fact_summary,baiyun_note,input_hash,contract_version,status,dirty,
     rejected_at,presented_at,created_at,updated_at,payload_version,title,edited_at,source_invalidated,image_coverage_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,3,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
    fact_summary=excluded.fact_summary,baiyun_note=excluded.baiyun_note,input_hash=excluded.input_hash,
    contract_version=excluded.contract_version,status=excluded.status,dirty=excluded.dirty,rejected_at=excluded.rejected_at,
    presented_at=excluded.presented_at,updated_at=excluded.updated_at,payload_version=3,title=excluded.title,
    edited_at=excluded.edited_at,source_invalidated=excluded.source_invalidated,image_coverage_json=excluded.image_coverage_json;`,
  summary.id, summary.kind, summary.periodStartLifeDate, summary.periodEndLifeDate, summary.factSummary, summary.baiyunNote,
  summary.inputHash, summary.contractVersion, summary.status, summary.dirty ? 1 : 0, summary.rejectedAt, summary.presentedAt,
  summary.createdAt, summary.updatedAt, summary.title, summary.editedAt, summary.sourceInvalidated ? 1 : 0, canonicalJsonV1(summary.imageCoverage));
  await db.runAsync('DELETE FROM shiying_summary_sources WHERE summary_id=?;', summary.id);
  await db.runAsync('DELETE FROM shiying_summary_inputs WHERE summary_id=?;', summary.id);
  for (const [ordinal, source] of summary.sources.entries()) await db.runAsync(`INSERT INTO shiying_summary_sources
    (summary_id,ordinal,source_kind,source_id,content_hash,image_ids_json,text_ranges_json,image_note_ranges_json,image_note_hash)
    VALUES (?,?,?,?,?,?,?,?,?);`, summary.id, ordinal, source.kind, source.id, source.contentHash, canonicalJsonV1(source.imageIds),
  source.textRanges === null ? null : canonicalJsonV1(source.textRanges), source.imageNoteRanges === null ? null : canonicalJsonV1(source.imageNoteRanges), source.imageNoteHash);
  for (const [ordinal, input] of summary.inputSources.entries()) await db.runAsync(`INSERT INTO shiying_summary_inputs
    (summary_id,ordinal,source_kind,source_id,content_hash,payload_json) VALUES (?,?,?,?,?,?);`,
  summary.id, ordinal, input.kind, input.id, input.contentHash, canonicalJsonV1(input));
}
export async function saveShiyingSummaryV3WithDatabase(db: Database, raw: ShiyingSummaryV3, options: ShiyingSummarySaveOptions = {}) {
  const input = parseShiyingSummaryV3(raw), previous = await loadShiyingSummaryAnyWithDatabase(db, input.id);
  if (Object.hasOwn(options, 'expectedStateHash')
    && options.expectedStateHash !== (previous ? createShiyingSummaryStateHash(previous) : null)) fail('summary_content_conflict', input.id);
  if (previous?.status === 'rejected' && input.status !== 'rejected') fail('summary_rejected', input.id);
  if (previous && input.updatedAt < previous.updatedAt && !Object.hasOwn(options, 'expectedStateHash')) fail('stale_time', input.id);
  const editedAt = previous?.payloadVersion === 3 ? previous.editedAt : null;
  if (editedAt !== null && !options.allowHumanReplacement) fail('summary_human_edited', input.id);
  if (!input.baiyunNote.trim()) fail('generated_note_empty', input.id);
  const next = parseShiyingSummaryV3({ ...input, createdAt: previous?.createdAt ?? input.createdAt,
    presentedAt: previous?.presentedAt ?? input.presentedAt, rejectedAt: previous?.rejectedAt ?? input.rejectedAt,
    editedAt: editedAt ?? input.editedAt, updatedAt: Math.max(input.updatedAt, previous?.updatedAt ?? 0) });
  if (options.validateSources !== false) await validateShiyingSummaryV3SourcesWithDatabase(db, next);
  await writeSummary(db, next);
  await markShiyingSummaryDependentsDirtyWithDatabase(db, 'summary', next.id, next.updatedAt, { invalidated: previous !== null });
  return next;
}
export async function saveShiyingSummaryV3(input: ShiyingSummaryV3, options: ShiyingSummarySaveOptions = {}) {
  const next = await safe(() => runShiyingTransaction(db => saveShiyingSummaryV3WithDatabase(db, input, options)));
  publishShiyingSummaryChanges(); return next;
}
export async function editShiyingSummary(input: {
  id: string; expectedStateHash: string; title: string; factSummary: string; baiyunNote: string; editedAt: number;
}) {
  assertShiyingDeterministicId(input.id, 'summary'); assertShiyingHash(input.expectedStateHash, 'summary_state_hash'); time(input.editedAt);
  const next = await safe(() => runShiyingTransaction(async db => {
    const previous = await loadShiyingSummaryAnyWithDatabase(db, input.id);
    if (!previous) fail('summary_missing', input.id);
    if (previous.status !== 'active') fail('summary_rejected', input.id);
    if (input.expectedStateHash !== createShiyingSummaryStateHash(previous)) fail('summary_content_conflict', input.id);
    if (input.editedAt < previous.updatedAt) fail('stale_time', input.id);
    let upgraded: ShiyingSummaryV3;
    if (previous.payloadVersion === 3) upgraded = previous;
    else {
      // The legacy article itself proves where its unknown-range roots came from.
      const roots = shiyingSummaryOriginalSources(previous);
      const legacyState = await db.getFirstAsync<{ source_invalidated: number }>('SELECT source_invalidated FROM shiying_summaries WHERE id=?;', previous.id);
      const { payloadVersion: _version, ...base } = previous;
      if ('sourceEntryIds' in base) delete (base as Partial<typeof base>).sourceEntryIds;
      upgraded = { ...base, payloadVersion: 3, sources: roots, title: input.title, editedAt: input.editedAt,
        sourceInvalidated: legacyState?.source_invalidated === 1, imageCoverage: { records: [], legacyUnknownSummaryIds: [previous.id] },
        inputSources: [], updatedAt: input.editedAt };
      // Old direct articles retain legacy roots without pretending the new body read the originals.
      // Their provenance input is the old stored article, not an extra body snapshot.
      upgraded.inputSources = [{ kind: 'summary', id: previous.id, summaryKind: previous.kind,
        periodStartLifeDate: previous.periodStartLifeDate, periodEndLifeDate: previous.periodEndLifeDate,
        contentHash: createShiyingSummaryContentHash(previous), textRanges: [{ start: 0, end: previous.factSummary.length }],
        noteRanges: previous.baiyunNote ? [{ start: 0, end: previous.baiyunNote.length }] : [], sources: roots }];
    }
    const updated = { ...upgraded, title: input.title, factSummary: input.factSummary, baiyunNote: input.baiyunNote,
      editedAt: input.editedAt, updatedAt: input.editedAt };
    const parsed = parseShiyingSummaryV3(updated);
    await writeSummary(db, parsed);
    await markShiyingSummaryDependentsDirtyWithDatabase(db, 'summary', input.id, input.editedAt, { invalidated: true });
    return parsed;
  }));
  publishShiyingSummaryChanges(); return next;
}
export async function markShiyingSummaryDependentsDirtyWithDatabase(db: Database,
  sourceKind: 'entry' | 'record' | 'summary' | 'event_node', sourceId: string, at: number,
  options: { invalidated: boolean; sourceDate?: string } = { invalidated: true }) {
  time(at); if (options.sourceDate !== undefined) assertShiyingLifeDate(options.sourceDate, 'summary_source_date');
  const seeds = sourceKind === 'entry' || sourceKind === 'record'
    ? await db.getAllAsync<{ id: string }>(`SELECT DISTINCT s.id FROM shiying_summaries s
       WHERE s.id IN (SELECT summary_id FROM shiying_summary_sources WHERE source_kind=? AND source_id=?)
         ${options.sourceDate ? 'OR (? BETWEEN s.period_start_life_date AND s.period_end_life_date)' : ''};`,
    sourceKind, sourceId, ...(options.sourceDate ? [options.sourceDate] : []))
    : await db.getAllAsync<{ id: string }>('SELECT summary_id AS id FROM shiying_summary_inputs WHERE source_kind=? AND source_id=?;', sourceKind, sourceId);
  const pending = seeds.map(row => row.id), visited = new Set<string>(sourceKind === 'summary' ? [sourceId] : []);
  while (pending.length) {
    const id = pending.shift()!; if (visited.has(id)) continue; visited.add(id);
    await db.runAsync(`UPDATE shiying_summaries SET dirty=1,source_invalidated=CASE WHEN ?=1 THEN 1 ELSE source_invalidated END,
      updated_at=MAX(updated_at,?) WHERE id=?;`, options.invalidated ? 1 : 0, at, id);
    await db.runAsync('UPDATE shiying_review_receipts SET dirty=1 WHERE summary_id=?;', id);
    const parents = await db.getAllAsync<{ id: string }>("SELECT summary_id AS id FROM shiying_summary_inputs WHERE source_kind='summary' AND source_id=?;", id);
    pending.push(...parents.map(parent => parent.id));
  }
  if (options.sourceDate) await db.runAsync('UPDATE shiying_review_receipts SET dirty=1 WHERE ? BETWEEN period_start AND period_end;', options.sourceDate);
}
export function listShiyingSummarySnapshots(options: { kind: ShiyingSummaryKind; beforePeriodStart?: string | null; limit?: number }) {
  if (!['week', 'month', 'year'].includes(options.kind)) fail('kind');
  const count = options.limit ?? 30;
  if (!Number.isSafeInteger(count) || count < 1 || count > 100) fail('limit');
  if (options.beforePeriodStart) assertShiyingLifeDate(options.beforePeriodStart, 'summary_cursor');
  return safe(() => runShiyingDatabaseOperation(async db => {
    const rows = await db.getAllAsync<{ id: string; period_start_life_date: string }>(`SELECT id,period_start_life_date FROM shiying_summaries
      WHERE kind=? AND status='active' ${options.beforePeriodStart ? 'AND period_start_life_date<?' : ''}
      ORDER BY period_start_life_date DESC,id DESC LIMIT ?;`, options.kind, ...(options.beforePeriodStart ? [options.beforePeriodStart] : []), count + 1);
    const summaries: ShiyingSummaryAnyV3[] = [];
    for (const row of rows.slice(0, count)) { const value = await loadShiyingSummaryAnyWithDatabase(db, row.id); if (!value) fail('summary_missing', row.id); summaries.push(value); }
    return { summaries, nextBeforePeriodStart: rows.length > count ? rows[count - 1].period_start_life_date : null };
  }));
}
export type ShiyingReviewPreview = {
  id: string; periodStartLifeDate: string; periodEndLifeDate: string; title: string; dirty: boolean; editedAt: number | null;
};
export function listShiyingReviewPreviews(options: { kind: ShiyingSummaryKind; before?: string | null; limit?: number }) {
  if (!['week', 'month', 'year'].includes(options.kind)) fail('kind');
  const limit = options.limit ?? 30;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('limit');
  if (options.before) assertShiyingLifeDate(options.before, 'summary_cursor');
  return safe(() => runShiyingDatabaseOperation(async db => {
    const rows = await db.getAllAsync<{ id: string; period_start_life_date: string; period_end_life_date: string;
      title: string | null; legacy_title: string; dirty: number; edited_at: number | null }>(`SELECT s.id,s.period_start_life_date,
      s.period_end_life_date,s.title,substr(s.fact_summary,1,240) AS legacy_title,s.dirty,s.edited_at
      FROM shiying_summaries s WHERE s.kind=? AND s.status='active' ${options.before ? 'AND s.period_start_life_date<?' : ''}
      AND (s.edited_at IS NOT NULL OR EXISTS (SELECT 1 FROM shiying_summary_sources x WHERE x.summary_id=s.id AND
        (x.source_kind='entry' AND EXISTS(SELECT 1 FROM shiying_entries e WHERE e.id=x.source_id AND e.status='active')
        OR x.source_kind='record' AND EXISTS(SELECT 1 FROM shiying_records r WHERE r.id=x.source_id AND r.status='finalized'))))
      ORDER BY s.period_start_life_date DESC,s.id DESC LIMIT ?;`, options.kind, ...(options.before ? [options.before] : []), limit + 1);
    const items: ShiyingReviewPreview[] = rows.slice(0, limit).map(row => ({ id: row.id,
      periodStartLifeDate: row.period_start_life_date, periodEndLifeDate: row.period_end_life_date,
      title: row.title ?? /^#\s+([^\r\n]+)/u.exec(row.legacy_title)?.[1].trim() ?? `${options.kind === 'week' ? '周' : options.kind === 'month' ? '月' : '年'}回顾`,
      dirty: row.dirty === 1, editedAt: row.edited_at }));
    return { items, nextBefore: rows.length > limit ? rows[limit - 1].period_start_life_date : null };
  }));
}
async function mutateSummary(input: { id: string; at: number }, operation: 'reject' | 'present') {
  assertShiyingDeterministicId(input.id, 'summary'); time(input.at);
  const result = await safe(() => runShiyingTransaction(async db => {
    const previous = await loadShiyingSummaryAnyWithDatabase(db, input.id);
    if (!previous) fail('summary_missing', input.id);
    if (operation === 'reject' && previous.status === 'rejected' || operation === 'present' && previous.presentedAt !== null) return previous;
    if (previous.status === 'rejected') fail('summary_rejected', input.id);
    if (input.at < previous.updatedAt) fail('stale_time', input.id);
    if (operation === 'reject') {
      await db.runAsync("UPDATE shiying_summaries SET status='rejected',rejected_at=?,updated_at=? WHERE id=?;", input.at, input.at, input.id);
      await markShiyingSummaryDependentsDirtyWithDatabase(db, 'summary', input.id, input.at, { invalidated: true });
    } else await db.runAsync('UPDATE shiying_summaries SET presented_at=?,updated_at=? WHERE id=?;', input.at, input.at, input.id);
    return (await loadShiyingSummaryAnyWithDatabase(db, input.id))!;
  }));
  publishShiyingSummaryChanges(); return result;
}
export function rejectShiyingSummaryAny(input: { id: string; rejectedAt: number }) { return mutateSummary({ id: input.id, at: input.rejectedAt }, 'reject'); }
export function markShiyingSummaryAnyPresented(input: { id: string; presentedAt: number }) { return mutateSummary({ id: input.id, at: input.presentedAt }, 'present'); }
