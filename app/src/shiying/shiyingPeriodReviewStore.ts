import type * as SQLite from 'expo-sqlite';
import { runShiyingDatabaseOperation } from './shiyingDatabase';
import { loadEntryWithDatabase } from './shiyingStore';
import { loadShiyingRecordWithDatabase } from './shiyingJournalStore';
import { loadShiyingRecordImageJobWithDatabase, loadShiyingRecordImageNoteWithDatabase } from './shiyingImageNoteStore';
import { projectShiyingMixedEntry, projectShiyingMixedRecord, type ShiyingMixedMaterialV1 } from './shiyingMixedMaterials';
import { createShiyingImageNoteResultHash } from './shiyingImageNoteContract';
import { createShiyingRecordContentHash } from './shiyingJournalContract';
import { loadShiyingSummaryAnyWithDatabase, validateShiyingSummaryRootSourcesWithDatabase } from './shiyingSummaryStore';
import { createShiyingSummaryContentHash, createShiyingEventNodeInputHash, projectShiyingSummarySources, type ShiyingSummaryImageCoverageV1 } from './shiyingSummaryContract';
import { splitShiyingReviewTitle } from './shiyingReviewPresentation';
import { type PeriodReviewInputs, type PeriodReviewPlan, type PeriodReviewEvent } from './shiyingPeriodReview';

type Database = SQLite.SQLiteDatabase;
type Row = Record<string, unknown>;
export async function loadShiyingReviewFactsWithDatabase(db: Database, start: string, end: string) {
  const facts: ShiyingMixedMaterialV1[] = [];
  const ids = await db.getAllAsync<{ kind: 'entry' | 'record'; id: string }>(`SELECT 'entry' AS kind,id FROM shiying_entries
    WHERE status='active' AND life_date BETWEEN ? AND ? UNION ALL SELECT 'record' AS kind,id FROM shiying_records
    WHERE status='finalized' AND record_date BETWEEN ? AND ?;`, start, end, start, end);
  for (const item of ids) {
    if (item.kind === 'entry') { const entry = await loadEntryWithDatabase(db, item.id); if (entry) facts.push(projectShiyingMixedEntry(entry)!); }
    else {
      const record = await loadShiyingRecordWithDatabase(db, item.id); if (!record) continue;
      const note = record.images.length ? await loadShiyingRecordImageNoteWithDatabase(db, item.id) : null;
      const job = record.images.length ? await loadShiyingRecordImageJobWithDatabase(db, item.id) : null;
      facts.push(projectShiyingMixedRecord({ record, note, jobSkipped: job?.status === 'skipped' })!);
    }
  }
  return facts.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}
export async function loadShiyingReviewImageCoverageWithDatabase(db: Database, facts: ShiyingMixedMaterialV1[]) {
  const records: ShiyingSummaryImageCoverageV1['records'] = [];
  for (const fact of facts.filter(value => value.kind === 'record' && value.imageIds.length)) {
    const record = await loadShiyingRecordWithDatabase(db, fact.id); if (!record) throw new Error('shiying_review_source_changed');
    const job = await loadShiyingRecordImageJobWithDatabase(db, fact.id);
    const note = await loadShiyingRecordImageNoteWithDatabase(db, fact.id);
    records.push({ recordId: fact.id, recordDate: fact.date, recordContentHash: createShiyingRecordContentHash(record),
      images: record.images.map(({ id, ordinal, contentHash }) => ({ id, ordinal, contentHash })),
      state: fact.imageState === 'ready' ? 'ready' : fact.imageState === 'skipped' ? 'skipped' : fact.imageState === 'stale' ? 'stale' : 'unfinished',
      imageNoteHash: note && fact.imageState === 'ready' ? createShiyingImageNoteResultHash(note) : null,
      units: job?.units.map(unit => ({ id: unit.id, captionStart: unit.captionStart, captionEnd: unit.captionEnd,
        imageIds: unit.imageIds, completed: unit.status === 'completed' })) ?? [] });
  }
  return { records, legacyUnknownSummaryIds: [] } satisfies ShiyingSummaryImageCoverageV1;
}
export function createShiyingReviewEventNodeContentHash(input: { eventId: string; title: string; id: string; date: string; body: string; sources: unknown[] }) {
  return createShiyingEventNodeInputHash({ id: input.id, eventId: input.eventId, title: input.title, body: input.body, eventDate: input.date,
    sources: input.sources as Parameters<typeof createShiyingEventNodeInputHash>[0]['sources'] });
}
export async function loadShiyingPeriodReviewInputsWithDatabase(db: Database, kind: 'month' | 'year', start: string, end: string): Promise<PeriodReviewInputs> {
  const facts = await loadShiyingReviewFactsWithDatabase(db, start, end);
  const lowerReviews: PeriodReviewInputs['lowerReviews'] = [];
  const lowerRows = await db.getAllAsync<{ id: string; source_invalidated: number }>(`SELECT id,source_invalidated FROM shiying_summaries WHERE kind=?
    AND period_end_life_date>=? AND period_start_life_date<=? ORDER BY period_start_life_date,id;`, kind === 'month' ? 'week' : 'month', start, end);
  for (const { id, source_invalidated } of lowerRows) {
    const summary = await loadShiyingSummaryAnyWithDatabase(db, id); if (!summary) continue;
    const sources = projectShiyingSummarySources(summary);
    let unavailable = false;
    try { await validateShiyingSummaryRootSourcesWithDatabase(db, sources); }
    catch (error) {
      if (error instanceof Error && /^shiying_summary_store_source_/u.test(error.message)) unavailable = true;
      else throw error;
    }
    const title = summary.payloadVersion === 3 ? { title: summary.title, body: summary.factSummary } : splitShiyingReviewTitle(summary.factSummary);
    lowerReviews.push({ id, kind: summary.kind, periodStart: summary.periodStartLifeDate, periodEnd: summary.periodEndLifeDate,
      title: title.title, factSummary: summary.factSummary, baiyunNote: summary.baiyunNote, status: summary.status,
      dirty: summary.dirty, editedAt: summary.payloadVersion === 3 ? summary.editedAt : null,
      sourceInvalidated: unavailable || (summary.payloadVersion === 3 ? summary.sourceInvalidated : source_invalidated === 1),
      contentHash: createShiyingSummaryContentHash(summary), sources,
      ...(summary.payloadVersion === 3 ? { imageCoverage: summary.imageCoverage } : {}) });
  }
  // Select by original fixed dates. Paging covers every qualifying development, not just the latest five.
  const events = new Map<string, PeriodReviewEvent>();
  let after = '';
  while (true) {
    const nodes = await db.getAllAsync<Row>(`SELECT n.*,e.title FROM shiying_event_nodes n JOIN shiying_events e ON e.id=n.event_id
      WHERE n.id>? AND EXISTS (SELECT 1 FROM shiying_event_node_sources s WHERE s.node_id=n.id AND
        ((s.source_kind='entry' AND EXISTS(SELECT 1 FROM shiying_entries l WHERE l.id=s.source_id AND l.life_date BETWEEN ? AND ?))
        OR (s.source_kind='record' AND EXISTS(SELECT 1 FROM shiying_records r WHERE r.id=s.source_id AND r.record_date BETWEEN ? AND ?))))
      ORDER BY n.id LIMIT 100;`, after, start, end, start, end);
    if (!nodes.length) break;
    for (const row of nodes) {
      const rows = await db.getAllAsync<Row>('SELECT * FROM shiying_event_node_sources WHERE node_id=? ORDER BY ordinal;', row.id as string);
      const sources: PeriodReviewEvent['nodes'][number]['sources'] = [];
      const sourceDates: PeriodReviewEvent['nodes'][number]['sourceDates'] = [];
      let valid = true;
      for (const source of rows) {
        const item = source.source_kind === 'entry' ? await loadEntryWithDatabase(db, source.source_id as string)
          : await loadShiyingRecordWithDatabase(db, source.source_id as string);
        if (!item || ('status' in item && item.status !== 'active' && item.status !== 'finalized')) { valid = false; break; }
        const date = 'lifeDate' in item ? item.lifeDate : item.recordDate;
        const fact = facts.find(value => value.kind === source.source_kind && value.id === source.source_id);
        const currentHash = fact?.sourceContentHash ?? (source.source_kind === 'entry'
          ? projectShiyingMixedEntry(item as Parameters<typeof projectShiyingMixedEntry>[0])!.sourceContentHash
          : createShiyingRecordContentHash(item as Parameters<typeof createShiyingRecordContentHash>[0]));
        if (source.content_hash !== currentHash) { valid = false; break; }
        if (source.image_note_hash && fact?.imageNote?.resultHash !== source.image_note_hash) { valid = false; break; }
        sources.push({ kind: source.source_kind as 'entry' | 'record', id: source.source_id as string, contentHash: source.content_hash as string,
          imageIds: JSON.parse(source.image_ids_json as string), textRanges: source.text_ranges_json ? JSON.parse(source.text_ranges_json as string) : null,
          imageNoteRanges: source.image_note_ranges_json ? JSON.parse(source.image_note_ranges_json as string) : null,
          imageNoteHash: source.image_note_hash as string | null });
        sourceDates.push({ kind: source.source_kind as 'entry' | 'record', id: source.source_id as string, date });
      }
      if (!valid || !sources.length) continue;
      const eventId = row.event_id as string, event = events.get(eventId) ?? { id: eventId, title: row.title as string, nodes: [] };
      const node = { id: row.id as string, date: row.event_date as string, body: row.body as string, sources, sourceDates, contentHash: '' };
      node.contentHash = createShiyingReviewEventNodeContentHash({ eventId, title: event.title, id: node.id, date: node.date, body: node.body, sources });
      event.nodes.push(node); events.set(eventId, event);
    }
    after = nodes[nodes.length - 1].id as string;
  }
  return { facts, lowerReviews, events: [...events.values()], imageCoverage: await loadShiyingReviewImageCoverageWithDatabase(db, facts) };
}
export function loadShiyingPeriodReviewInputs(kind: 'month' | 'year', start: string, end: string) {
  return runShiyingDatabaseOperation(db => loadShiyingPeriodReviewInputsWithDatabase(db, kind, start, end));
}
export function assertShiyingPeriodReviewFrozenSources(plan: PeriodReviewPlan, input: PeriodReviewInputs) {
  for (const saved of plan.materials) {
    if (saved.kind === 'summary') {
      const article = input.lowerReviews.find(value => value.id === saved.id);
      if (!article || article.status !== 'active' || article.sourceInvalidated) throw new Error('shiying_review_source_changed');
    }
    const current = saved.kind === 'summary' ? input.lowerReviews.find(value => value.id === saved.id)?.contentHash
      : saved.kind === 'event_node' ? input.events.flatMap(event => event.nodes).find(value => value.id === saved.id)?.contentHash
        : input.facts.find(value => value.kind === saved.kind && value.id === saved.id)?.materialHash;
    if (current !== saved.materialHash) throw new Error('shiying_review_source_changed');
  }
}
