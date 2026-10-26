import type * as SQLite from 'expo-sqlite';
import {
  assertShiyingHash, assertShiyingLifeDate, assertShiyingUuidV4, canonicalJsonV1, createShiyingEntryId, createShiyingSummaryId,
  type ShiyingSummaryV1,
} from './shiyingContract';
import {
  createShiyingEntryFactContentHash, createShiyingRecordContentHash, parseShiyingEventNodeV1,
  parseShiyingEventExclusionV1, parseShiyingSummaryV2, type ShiyingSummaryV2,
} from './shiyingJournalContract';
import {
  loadShiyingRecordWithDatabase, loadShiyingSummarySnapshotWithDatabase,
  saveShiyingSummaryV2WithDatabase, validateShiyingFactSourcesWithDatabase,
} from './shiyingJournalStore';
import { loadEntryWithDatabase } from './shiyingStore';
import { runShiyingDatabaseOperation, runShiyingTransaction } from './shiyingDatabase';
import { loadShiyingRecordImageNoteWithDatabase, loadShiyingRecordImageJobWithDatabase } from './shiyingImageNoteStore';
import { createShiyingImageNoteResultHash, hashShiyingJson } from './shiyingImageNoteContract';
import { projectShiyingMixedEntry, projectShiyingMixedRecord } from './shiyingMixedMaterials';
import { parseShiyingSummaryV3, type ShiyingSummaryV3 } from './shiyingSummaryContract';
import { saveShiyingSummaryV3WithDatabase, loadShiyingSummaryAnyWithDatabase, markShiyingSummaryDependentsDirtyWithDatabase, publishShiyingSummaryChanges } from './shiyingSummaryStore';
import {
  parseShiyingEventAssociationFeedbackV1, parseShiyingEventNodeV2, parseShiyingEventV2,
  parseShiyingReviewReceipt, parseShiyingReviewRun, parseShiyingScopedSourceV1, parseShiyingTopicV1,
  type ShiyingEventPatch, type ShiyingEventV2, type ShiyingReviewReceipt, type ShiyingReviewRun,
  type ShiyingScopedSourceV1, type ShiyingTextRange, type ShiyingTopicV1,
} from './shiyingReviewContract';

type Database = SQLite.SQLiteDatabase;
type Row = Record<string, unknown>;
const listeners = new Set<() => void>();
export function subscribeShiyingReviewChanges(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
function notify() { for (const listener of listeners) { try { listener(); } catch { /* A page cannot fail a committed transaction. */ } } }
function fail(code: string, id?: string): never { throw new Error(`shiying_review_store_${code}${id ? `:${id}` : ''}`); }
async function safe<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof Error && /^shiying_[a-z_]+(?::[a-zA-Z0-9_.-]+)?$/u.test(error.message)) throw error;
    return fail('database_operation_failed');
  }
}
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) fail('invalid_time'); }
function technicalCode(value: string) { if (!/^[a-z][a-z0-9_]{0,119}$/u.test(value)) fail('invalid_error_code'); }
function json(value: unknown): unknown { if (typeof value !== 'string') fail('invalid_json'); try { return JSON.parse(value); } catch { return fail('invalid_json'); } }
function limit(value = 30) { if (!Number.isSafeInteger(value) || value < 1 || value > 100) fail('invalid_limit'); return value; }
function cursor(value: string | null | undefined): { updatedAt: number; id: string } | null {
  if (!value) return null;
  const parsed = json(value) as { updatedAt?: unknown; id?: unknown };
  if (!parsed || Object.keys(parsed).sort().join(',') !== 'id,updatedAt' || typeof parsed.id !== 'string') fail('invalid_cursor');
  time(parsed.updatedAt as number); assertShiyingUuidV4(parsed.id, 'review_cursor_id');
  return { updatedAt: parsed.updatedAt as number, id: parsed.id };
}
function inRange(body: string, ranges: ShiyingTextRange[], id: string) {
  for (const range of ranges) {
    if (range.end > body.length) fail('source_range_bounds', id);
    for (const offset of [range.start, range.end]) {
      const before = body.charCodeAt(offset - 1), after = body.charCodeAt(offset);
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) fail('source_range_unicode', id);
    }
  }
}
export async function validateShiyingScopedSourcesWithDatabase(db: Database, sources: ShiyingScopedSourceV1[]) {
  for (const raw of sources) {
    const source = parseShiyingScopedSourceV1(raw);
    await validateShiyingFactSourcesWithDatabase(db, [{ kind: source.kind, id: source.id, contentHash: source.contentHash, imageIds: source.imageIds }]);
    if (source.kind === 'entry') {
      const entry = await loadEntryWithDatabase(db, source.id);
      if (!entry || createShiyingEntryFactContentHash(entry) !== source.contentHash) fail('source_unavailable', source.id);
      inRange(entry.body, source.textRanges, source.id);
    } else {
      const record = await loadShiyingRecordWithDatabase(db, source.id);
      if (!record || createShiyingRecordContentHash(record) !== source.contentHash) fail('source_unavailable', source.id);
      inRange(record.body, source.textRanges, source.id);
      if (source.imageNoteHash !== null) {
        const note = await loadShiyingRecordImageNoteWithDatabase(db, source.id);
        if (!note || note.status !== 'ready' || note.recordContentHash !== source.contentHash || note.body === null
          || createShiyingImageNoteResultHash(note) !== source.imageNoteHash) fail('image_note_source_stale', source.id);
        inRange(note.body, source.imageNoteRanges, source.id);
      }
    }
  }
}
async function loadScopedSources(db: Database, table: 'shiying_event_node_sources' | 'shiying_topic_sources', ownerId: string, legacy = false) {
  const column = table === 'shiying_event_node_sources' ? 'node_id' : 'topic_id';
  const rows = await db.getAllAsync<Row>(`SELECT * FROM ${table} WHERE ${column}=? ORDER BY ordinal;`, ownerId);
  return rows.map((row, index) => {
    if (row.ordinal !== index) fail('source_order', ownerId);
    const base = { kind: row.source_kind, id: row.source_id, contentHash: row.content_hash, imageIds: json(row.image_ids_json) };
    if (legacy) return base;
    return parseShiyingScopedSourceV1({ ...base, textRanges: json(row.text_ranges_json),
      imageNoteRanges: json(row.image_note_ranges_json), imageNoteHash: row.image_note_hash });
  });
}
async function insertScopedSources(db: Database, table: 'shiying_event_node_sources' | 'shiying_topic_sources', id: string, sources: ShiyingScopedSourceV1[]) {
  const column = table === 'shiying_event_node_sources' ? 'node_id' : 'topic_id';
  for (const [ordinal, source] of sources.entries()) await db.runAsync(`INSERT INTO ${table}
    (${column},ordinal,source_kind,source_id,content_hash,image_ids_json,text_ranges_json,image_note_ranges_json,image_note_hash)
    VALUES (?,?,?,?,?,?,?,?,?);`, id, ordinal, source.kind, source.id, source.contentHash,
  canonicalJsonV1(source.imageIds), canonicalJsonV1(source.textRanges), canonicalJsonV1(source.imageNoteRanges), source.imageNoteHash);
}
export async function loadShiyingEventSnapshotWithDatabase(db: Database, id: string): Promise<ShiyingEventV2 | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_events WHERE id=?;', id);
  if (!row) return null;
  const nodeRows = await db.getAllAsync<Row>('SELECT * FROM shiying_event_nodes WHERE event_id=? ORDER BY event_date,ordinal,id;', id);
  const nodes = [];
  for (const node of nodeRows) {
    const value = { payloadVersion: node.payload_version, id: node.id, eventId: node.event_id, eventDate: node.event_date,
      ordinal: node.ordinal, body: node.body, createdAt: node.created_at, updatedAt: node.updated_at,
      sources: await loadScopedSources(db, 'shiying_event_node_sources', node.id as string, node.payload_version === 1) };
    nodes.push(node.payload_version === 1 ? parseShiyingEventNodeV1(value) : parseShiyingEventNodeV2(value));
  }
  const excluded = await db.getAllAsync<Row>('SELECT * FROM shiying_event_exclusions WHERE event_id=? ORDER BY source_kind,source_id;', id);
  return parseShiyingEventV2({ payloadVersion: 2, id: row.id, title: row.title, overview: row.overview,
    dirty: row.dirty === 1, createdAt: row.created_at, updatedAt: row.updated_at, nodes,
    exclusions: excluded.map(item => parseShiyingEventExclusionV1({ kind: item.source_kind, id: item.source_id, updatedAt: item.updated_at })),
    associationFeedback: json(row.association_feedback_json) });
}
export function getShiyingEventSnapshot(id: string) { assertShiyingUuidV4(id, 'event_id'); return safe(() => runShiyingDatabaseOperation(db => loadShiyingEventSnapshotWithDatabase(db, id))); }
/** A bounded read model; node ordinals remain their real stored values. */
export type ShiyingEventContextSnapshot = Omit<ShiyingEventV2, 'exclusions'>;
export function getShiyingEventContextSnapshot(id: string, sources: Array<{ kind: 'entry' | 'record'; id: string }> = []): Promise<ShiyingEventContextSnapshot | null> {
  assertShiyingUuidV4(id, 'event_id');
  sources.forEach(source => { assertShiyingUuidV4(source.id, 'source_id'); if (!['entry', 'record'].includes(source.kind)) fail('source_kind'); });
  return safe(() => runShiyingDatabaseOperation(async db => {
    const row = await db.getFirstAsync<Row>('SELECT id,title,overview,dirty,created_at,updated_at,association_feedback_json FROM shiying_events WHERE id=?;', id);
    if (!row) return null;
    const metadata = parseShiyingEventV2({ payloadVersion: 2, id: row.id, title: row.title, overview: row.overview,
      dirty: row.dirty === 1, createdAt: row.created_at, updatedAt: row.updated_at, nodes: [], exclusions: [],
      associationFeedback: json(row.association_feedback_json) });
    const nodeRows = await db.getAllAsync<Row>(`SELECT n.id,n.event_date,n.ordinal FROM shiying_event_nodes n WHERE n.event_id=?
      ORDER BY EXISTS (SELECT 1 FROM shiying_event_node_sources s JOIN json_each(?) supplied
        ON s.source_kind=json_extract(supplied.value,'$.kind') AND s.source_id=json_extract(supplied.value,'$.id') WHERE s.node_id=n.id) DESC,
      n.event_date DESC,n.ordinal DESC,n.id DESC LIMIT 5;`, id, canonicalJsonV1(sources));
    const nodes: ShiyingEventV2['nodes'] = [];
    nodeRows.sort((left, right) => (left.event_date as string) < (right.event_date as string) ? -1 : (left.event_date as string) > (right.event_date as string) ? 1
      : (left.ordinal as number) - (right.ordinal as number) || ((left.id as string) < (right.id as string) ? -1 : 1));
    for (const selected of nodeRows) {
      const node = await db.getFirstAsync<Row>('SELECT * FROM shiying_event_nodes WHERE id=? AND event_id=?;', selected.id as string, id);
      if (!node) fail('event_node_missing', selected.id as string);
      const value = { payloadVersion: node.payload_version, id: node.id, eventId: node.event_id, eventDate: node.event_date,
        ordinal: node.ordinal, body: node.body, createdAt: node.created_at, updatedAt: node.updated_at,
        sources: await loadScopedSources(db, 'shiying_event_node_sources', node.id as string, node.payload_version === 1) };
      nodes.push(node.payload_version === 1 ? parseShiyingEventNodeV1(value) : parseShiyingEventNodeV2(value));
    }
    const { exclusions: _exclusions, ...snapshot } = metadata;
    return { ...snapshot, nodes };
  }));
}
export function getRelatedShiyingEventIdsForSources(sources: Array<{ kind: 'entry' | 'record'; id: string }>) {
  sources.forEach(source => { assertShiyingUuidV4(source.id, 'source_id'); if (!['entry', 'record'].includes(source.kind)) fail('source_kind'); });
  return safe(() => runShiyingDatabaseOperation(async db => {
    const ids = new Set<string>();
    for (const source of sources) {
      const rows = await db.getAllAsync<{ event_id: string }>(`SELECT DISTINCT n.event_id FROM shiying_event_nodes n
        JOIN shiying_event_node_sources s ON s.node_id=n.id WHERE s.source_kind=? AND s.source_id=?;`, source.kind, source.id);
      rows.forEach(row => ids.add(row.event_id));
    }
    const corrected = await db.getAllAsync<{ event_id: string }>(`SELECT DISTINCT e.id AS event_id FROM shiying_events e
      JOIN json_each(e.association_feedback_json) feedback JOIN json_each(json_extract(feedback.value,'$.sources')) evidence
      JOIN json_each(?) supplied ON json_extract(evidence.value,'$.kind')=json_extract(supplied.value,'$.kind')
        AND json_extract(evidence.value,'$.id')=json_extract(supplied.value,'$.id');`, canonicalJsonV1(sources));
    corrected.forEach(row => ids.add(row.event_id));
    return [...ids].sort();
  }));
}
async function reorderNodes(db: Database, eventId: string, preferredOrdinals?: Map<string, number>) {
  const rows = await db.getAllAsync<{ id: string; event_date: string; ordinal: number }>(
    'SELECT id,event_date,ordinal FROM shiying_event_nodes WHERE event_id=? ORDER BY event_date,ordinal,id;', eventId);
  if (preferredOrdinals) rows.sort((left, right) => left.event_date < right.event_date ? -1 : left.event_date > right.event_date ? 1
    : (preferredOrdinals.get(left.id) ?? left.ordinal) - (preferredOrdinals.get(right.id) ?? right.ordinal)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const maximum = rows.reduce((current, row) => Math.max(current, row.ordinal), 0) + rows.length + 1;
  for (const [index, row] of rows.entries()) await db.runAsync('UPDATE shiying_event_nodes SET ordinal=? WHERE id=?;', maximum + index, row.id);
  const next = new Map<string, number>();
  for (const row of rows) { const ordinal = next.get(row.event_date) ?? 0; next.set(row.event_date, ordinal + 1);
    await db.runAsync('UPDATE shiying_event_nodes SET ordinal=? WHERE id=?;', ordinal, row.id); }
}
function sameCorrectedNode(feedback: ShiyingEventV2['associationFeedback'][number], node: ShiyingEventPatch['nodes'][number]) {
  const normalized = (body: string) => body.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
  if (normalized(feedback.nodeBody) !== normalized(node.body) || feedback.sources.length !== node.sources.length) return false;
  return feedback.sources.every(previous => node.sources.some(current => previous.kind === current.kind && previous.id === current.id
    && (!('textRanges' in previous) || canonicalJsonV1({ textRanges: previous.textRanges, imageNoteRanges: previous.imageNoteRanges,
      imageIds: previous.imageIds }) === canonicalJsonV1({ textRanges: current.textRanges, imageNoteRanges: current.imageNoteRanges, imageIds: current.imageIds }))));
}
function refersToPriorNode(previous: ShiyingEventV2['nodes'][number], sources: ShiyingScopedSourceV1[]) {
  const overlaps = (left: ShiyingTextRange[], right: ShiyingTextRange[]) => left.some(a => right.some(b => a.start < b.end && b.start < a.end));
  if (previous.payloadVersion === 1) return previous.sources.some(old => sources.some(source => old.kind === source.kind && old.id === source.id));
  return previous.sources.some(old => sources.some(source => old.kind === source.kind && old.id === source.id
    && (overlaps(old.textRanges, source.textRanges)
      || old.imageNoteHash === source.imageNoteHash && overlaps(old.imageNoteRanges, source.imageNoteRanges))));
}
async function saveEventPatch(db: Database, patch: ShiyingEventPatch, at: number) {
  assertShiyingUuidV4(patch.id, 'event_id'); time(at);
  if (!patch.title.trim() || !patch.overview.trim()) fail('event_text', patch.id);
  const previous = await loadShiyingEventSnapshotWithDatabase(db, patch.id);
  if (previous ? patch.expectedUpdatedAt !== previous.updatedAt : patch.expectedUpdatedAt !== null) fail('event_input_conflict', patch.id);
  if (previous && at < previous.updatedAt) fail('event_time', patch.id);
  const excluded = new Set(previous?.exclusions.map(source => `${source.kind}:${source.id}`) ?? []);
  if (new Set(patch.nodes.map(node => node.id)).size !== patch.nodes.length) fail('event_node_duplicate', patch.id);
  for (const raw of patch.nodes) {
    const node = parseShiyingEventNodeV2(raw);
    if (node.eventId !== patch.id || node.updatedAt > at) fail('event_node_parent_or_time', node.id);
    const priorNode = previous?.nodes.find(prior => prior.id === node.id);
    if (priorNode && (node.eventDate !== priorNode.eventDate || node.createdAt !== priorNode.createdAt
      || !refersToPriorNode(priorNode, node.sources))) fail('event_node_original_source', node.id);
    if (node.sources.some(source => excluded.has(`${source.kind}:${source.id}`))) fail('event_source_excluded', node.id);
    if (previous?.associationFeedback.some(feedback => feedback.nodeId === node.id || sameCorrectedNode(feedback, node))) fail('event_node_excluded', node.id);
    await validateShiyingScopedSourcesWithDatabase(db, node.sources);
    const old = await db.getFirstAsync<Row>('SELECT event_id,created_at,updated_at FROM shiying_event_nodes WHERE id=?;', node.id);
    if (old && (old.event_id !== patch.id || node.updatedAt < (old.updated_at as number))) fail('event_node_conflict', node.id);
  }
  await db.runAsync(`INSERT INTO shiying_events (id,title,overview,dirty,created_at,updated_at,payload_version,association_feedback_json)
    VALUES (?,?,?,0,?,?,2,'[]') ON CONFLICT(id) DO UPDATE SET title=excluded.title,overview=excluded.overview,
    dirty=0,updated_at=excluded.updated_at,payload_version=2;`, patch.id, patch.title, patch.overview, previous?.createdAt ?? at, at);
  if (previous && previous.title !== patch.title) for (const node of previous.nodes)
    await markShiyingSummaryDependentsDirtyWithDatabase(db, 'event_node', node.id, at, { invalidated: true });
  const max = (await db.getFirstAsync<{ maximum: number }>('SELECT COALESCE(MAX(ordinal),-1) AS maximum FROM shiying_event_nodes WHERE event_id=?;', patch.id))?.maximum ?? -1;
  for (const [index, raw] of patch.nodes.entries()) {
    const node = parseShiyingEventNodeV2(raw), old = previous?.nodes.find(item => item.id === node.id);
    await db.runAsync(`INSERT INTO shiying_event_nodes (id,event_id,event_date,ordinal,body,created_at,updated_at,payload_version)
      VALUES (?,?,?,?,?,?,?,2) ON CONFLICT(id) DO UPDATE SET event_date=excluded.event_date,ordinal=excluded.ordinal,
      body=excluded.body,updated_at=excluded.updated_at,payload_version=2;`, node.id, patch.id, node.eventDate,
    max + index + 1, node.body, old?.createdAt ?? node.createdAt, node.updatedAt);
    await db.runAsync('DELETE FROM shiying_event_node_sources WHERE node_id=?;', node.id);
    await insertScopedSources(db, 'shiying_event_node_sources', node.id, node.sources);
    if (old && (old.body !== node.body || canonicalJsonV1(old.sources) !== canonicalJsonV1(node.sources)))
      await markShiyingSummaryDependentsDirtyWithDatabase(db, 'event_node', node.id, at, { invalidated: true });
    // Higher reviews include all developments, not only ones already in their source lists.
    // Do not dirty the week currently being atomically committed with these nodes.
    for (const source of node.sources) {
      const row = source.kind === 'entry'
        ? await db.getFirstAsync<{ date: string }>('SELECT life_date AS date FROM shiying_entries WHERE id=?;', source.id)
        : await db.getFirstAsync<{ date: string }>('SELECT record_date AS date FROM shiying_records WHERE id=?;', source.id);
      if (row) {
        await db.runAsync("UPDATE shiying_summaries SET dirty=1 WHERE kind IN ('month','year') AND status='active' AND ? BETWEEN period_start_life_date AND period_end_life_date;", row.date);
        await db.runAsync("UPDATE shiying_review_receipts SET dirty=1 WHERE kind IN ('month','year') AND ? BETWEEN period_start AND period_end;", row.date);
      }
    }
  }
  await reorderNodes(db, patch.id, new Map(previous?.nodes.map(node => [node.id, node.ordinal]) ?? []));
  return (await loadShiyingEventSnapshotWithDatabase(db, patch.id))!;
}
async function recordFeedback(db: Database, event: ShiyingEventV2, nodeId: string, toEventId: string | null, at: number) {
  const node = event.nodes.find(item => item.id === nodeId); if (!node) fail('event_node_missing', nodeId);
  const feedback = parseShiyingEventAssociationFeedbackV1({ nodeId, nodeBody: node.body, fromEventId: event.id,
    toEventId, sources: node.sources, updatedAt: at });
  const current = [...event.associationFeedback.filter(item => item.nodeId !== nodeId), feedback].sort((left, right) => left.nodeId < right.nodeId ? -1 : 1);
  await db.runAsync('UPDATE shiying_events SET association_feedback_json=?,payload_version=2,dirty=1,updated_at=? WHERE id=?;', canonicalJsonV1(current), at, event.id);
  event.associationFeedback = current;
}
export function removeShiyingEventNode(input: { eventId: string; nodeId: string; updatedAt: number }) {
  assertShiyingUuidV4(input.eventId, 'event_id'); assertShiyingUuidV4(input.nodeId, 'node_id'); time(input.updatedAt);
  return safe(() => runShiyingTransaction(async db => {
    const event = await loadShiyingEventSnapshotWithDatabase(db, input.eventId); if (!event) fail('event_missing', input.eventId);
    if (!event.nodes.some(node => node.id === input.nodeId) && event.associationFeedback.some(item => item.nodeId === input.nodeId && item.toEventId === null)) return event;
    if (input.updatedAt < event.updatedAt) fail('event_time', input.eventId);
    await recordFeedback(db, event, input.nodeId, null, input.updatedAt);
    await db.runAsync('DELETE FROM shiying_event_nodes WHERE id=? AND event_id=?;', input.nodeId, input.eventId);
    await reorderNodes(db, input.eventId);
    const removed = event.nodes.find(node => node.id === input.nodeId)!;
    await markEventRelatedSummariesDirty(db, removed.sources, input.updatedAt);
    return (await loadShiyingEventSnapshotWithDatabase(db, input.eventId))!;
  })).then(result => { notify(); return result; });
}
export function moveShiyingEventNodes(input: { eventId: string; nodeIds: string[]; targetEventId?: string; targetTitle?: string; updatedAt: number }) {
  assertShiyingUuidV4(input.eventId, 'event_id'); time(input.updatedAt);
  if (!input.nodeIds.length || new Set(input.nodeIds).size !== input.nodeIds.length) fail('move_nodes');
  input.nodeIds.forEach(id => assertShiyingUuidV4(id, 'node_id'));
  if (input.targetEventId) assertShiyingUuidV4(input.targetEventId, 'event_id');
  if (input.targetEventId === input.eventId || !input.targetEventId && !input.targetTitle?.trim()) fail('move_target');
  const targetId = input.targetEventId ?? createShiyingEntryId();
  return safe(() => runShiyingTransaction(async db => {
    const source = await loadShiyingEventSnapshotWithDatabase(db, input.eventId); if (!source) fail('event_missing', input.eventId);
    let target = await loadShiyingEventSnapshotWithDatabase(db, targetId);
    if (input.targetEventId && !target) fail('event_missing', targetId);
    if (input.updatedAt < source.updatedAt || target && input.updatedAt < target.updatedAt) fail('event_time', input.eventId);
    const moved = input.nodeIds.map(id => { const node = source.nodes.find(item => item.id === id); if (!node) fail('event_node_missing', id); return node; });
    if (!target) { await db.runAsync(`INSERT INTO shiying_events (id,title,overview,dirty,created_at,updated_at,payload_version,association_feedback_json)
      VALUES (?,?,?,1,?,?,2,'[]');`, targetId, input.targetTitle!.trim(), moved.map(node => node.body).join('\n\n'), input.updatedAt, input.updatedAt);
      target = (await loadShiyingEventSnapshotWithDatabase(db, targetId))!; }
    const max = target.nodes.reduce((current, node) => Math.max(current, node.ordinal), -1);
    for (const [index, node] of moved.entries()) {
      await recordFeedback(db, source, node.id, targetId, input.updatedAt);
      await db.runAsync('UPDATE shiying_event_nodes SET event_id=?,ordinal=?,updated_at=? WHERE id=?;', targetId, max + index + 1, input.updatedAt, node.id);
    }
    const targetFeedback = target.associationFeedback.filter(feedback => !input.nodeIds.includes(feedback.nodeId));
    await db.runAsync('UPDATE shiying_events SET dirty=1,updated_at=?,payload_version=2,association_feedback_json=? WHERE id=?;',
      input.updatedAt, canonicalJsonV1(targetFeedback), targetId);
    await reorderNodes(db, source.id); await reorderNodes(db, targetId); await markEventRelatedSummariesDirty(db, moved.flatMap(node => node.sources), input.updatedAt);
    return { source: (await loadShiyingEventSnapshotWithDatabase(db, source.id))!, target: (await loadShiyingEventSnapshotWithDatabase(db, targetId))! };
  })).then(result => { notify(); return result; });
}
async function markEventRelatedSummariesDirty(db: Database, sources: Array<{ kind: 'entry' | 'record'; id: string }>, at: number) {
  for (const source of sources) {
    await markShiyingSummaryDependentsDirtyWithDatabase(db, source.kind, source.id, at, { invalidated: true });
    await db.runAsync(`UPDATE shiying_summaries SET dirty=1,updated_at=MAX(updated_at,?) WHERE status='active'
      AND id IN (SELECT summary_id FROM shiying_summary_sources WHERE source_kind=? AND source_id=?);`, at, source.kind, source.id);
    await db.runAsync(`UPDATE shiying_review_receipts SET dirty=1 WHERE summary_id IN
      (SELECT summary_id FROM shiying_summary_sources WHERE source_kind=? AND source_id=?);`, source.kind, source.id);
    const row = source.kind === 'entry'
      ? await db.getFirstAsync<{ date: string }>('SELECT life_date AS date FROM shiying_entries WHERE id=?;', source.id)
      : await db.getFirstAsync<{ date: string }>('SELECT record_date AS date FROM shiying_records WHERE id=?;', source.id);
    if (row) await markShiyingReviewPeriodDirtyWithDatabase(db, source.kind, source.id, row.date);
  }
}
export async function loadTopic(db: Database, id: string): Promise<ShiyingTopicV1 | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_topics WHERE id=?;', id); if (!row) return null;
  return parseShiyingTopicV1({ payloadVersion: row.payload_version, id: row.id, summaryId: row.summary_id,
    title: row.title, dirty: row.dirty === 1, createdAt: row.created_at, updatedAt: row.updated_at,
    sources: await loadScopedSources(db, 'shiying_topic_sources', id) });
}
export function getShiyingTopicsForSource(kind: 'entry' | 'record', id: string) {
  assertShiyingUuidV4(id, 'source_id'); if (!['entry', 'record'].includes(kind)) fail('source_kind');
  return safe(() => runShiyingDatabaseOperation(async db => {
    const rows = await db.getAllAsync<{ id: string }>(`SELECT t.id FROM shiying_topics t JOIN shiying_topic_sources s ON s.topic_id=t.id
      WHERE s.source_kind=? AND s.source_id=? ORDER BY t.created_at,t.id;`, kind, id);
    const topics = []; for (const row of rows) topics.push((await loadTopic(db, row.id))!); return topics;
  }));
}
export function queryShiyingTopics(query: string, count = 30) {
  const size = limit(count); if (!query.trim()) return Promise.resolve([] as ShiyingTopicV1[]);
  return safe(() => runShiyingDatabaseOperation(async db => {
    const rows = await db.getAllAsync<{ id: string }>("SELECT id FROM shiying_topics WHERE instr(lower(title),lower(?))>0 ORDER BY updated_at DESC,id DESC LIMIT ?;", query.trim(), size);
    const topics = []; for (const row of rows) topics.push((await loadTopic(db, row.id))!); return topics;
  }));
}
export type ShiyingWeeklyReviewPreview = {
  id: string; payloadVersion: 1 | 2; periodStartLifeDate: string; periodEndLifeDate: string; title: string;
  dirty: boolean; presentedAt: number | null; status: 'active'; updatedAt: number; inputHash: string;
};
export function listShiyingWeeklyReviews(options: { before?: string | null; limit?: number } = {}) {
  const size = limit(options.limit); if (options.before) assertShiyingLifeDate(options.before, 'review_before');
  return safe(() => runShiyingDatabaseOperation(async db => {
    const rows = await db.getAllAsync<Row>(`SELECT id,payload_version,period_start_life_date,period_end_life_date,
      substr(fact_summary,1,min(300,instr(fact_summary||char(10),char(10))-1)) AS title,dirty,presented_at,updated_at,input_hash
      FROM shiying_summaries WHERE kind='week' AND status='active' AND (? IS NULL OR period_start_life_date<?)
      AND EXISTS (SELECT 1 FROM shiying_summary_sources s WHERE s.summary_id=shiying_summaries.id
        AND ((s.source_kind='entry' AND EXISTS (SELECT 1 FROM shiying_entries e WHERE e.id=s.source_id AND e.status='active'))
          OR (s.source_kind='record' AND EXISTS (SELECT 1 FROM shiying_records r WHERE r.id=s.source_id AND r.status='finalized'))))
      ORDER BY period_start_life_date DESC LIMIT ?;`, options.before ?? null, options.before ?? null, size + 1);
    const selected = rows.slice(0, size), items = selected.map(row => ({ id: row.id as string, payloadVersion: row.payload_version as 1 | 2,
      periodStartLifeDate: row.period_start_life_date as string, periodEndLifeDate: row.period_end_life_date as string,
      title: (row.title as string).replace(/^#{1,6}\s+/u, ''), dirty: row.dirty === 1, presentedAt: row.presented_at as number | null,
      status: 'active' as const, updatedAt: row.updated_at as number, inputHash: row.input_hash as string }));
    return { items, nextBefore: rows.length > size ? items[items.length - 1].periodStartLifeDate : null };
  }));
}
export type ShiyingEventPreview = { id: string; title: string; overview: string; dirty: boolean; updatedAt: number; nodeCount: number };
export function listShiyingEvents(options: { before?: string | null; limit?: number } = {}) {
  const size = limit(options.limit), before = cursor(options.before);
  return safe(() => runShiyingDatabaseOperation(async db => {
    const rows = await db.getAllAsync<Row>(`SELECT e.id,e.title,e.overview,e.dirty,e.updated_at,
      (SELECT COUNT(*) FROM shiying_event_nodes n WHERE n.event_id=e.id) AS node_count FROM shiying_events e
      WHERE (? IS NULL OR e.updated_at<? OR (e.updated_at=? AND e.id<?)) ORDER BY e.updated_at DESC,e.id DESC LIMIT ?;`,
    before?.updatedAt ?? null, before?.updatedAt ?? null, before?.updatedAt ?? null, before?.id ?? null, size + 1);
    const items = rows.slice(0, size).map(row => ({ id: row.id as string, title: row.title as string, overview: row.overview as string,
      dirty: row.dirty === 1, updatedAt: row.updated_at as number, nodeCount: row.node_count as number }));
    const last = items[items.length - 1];
    return { items, nextBefore: rows.length > size && last ? canonicalJsonV1({ updatedAt: last.updatedAt, id: last.id }) : null };
  }));
}
export async function markShiyingReviewPeriodDirtyWithDatabase(db: Database, kind: 'entry' | 'record', id: string, date: string) {
  assertShiyingLifeDate(date, 'review_dirty_date'); assertShiyingUuidV4(id, 'review_dirty_id');
  await markShiyingSummaryDependentsDirtyWithDatabase(db, kind, id, 0, { invalidated: false, sourceDate: date });
  await db.runAsync("UPDATE shiying_summaries SET dirty=1 WHERE status='active' AND period_start_life_date<=? AND period_end_life_date>=?;", date, date);
  await db.runAsync('UPDATE shiying_review_receipts SET dirty=1 WHERE period_start<=? AND period_end>=?;', date, date);
  await db.runAsync(`UPDATE shiying_topics SET dirty=1 WHERE summary_id IN (SELECT id FROM shiying_summaries WHERE kind='week'
    AND period_start_life_date<=? AND period_end_life_date>=?) OR id IN (SELECT topic_id FROM shiying_topic_sources WHERE source_kind=? AND source_id=?);`, date, date, kind, id);
}
export async function loadRun(db: Database, kind: 'week' | 'month' | 'year' = 'week', id?: string): Promise<ShiyingReviewRun | null> {
  const row = id ? await db.getFirstAsync<Row>('SELECT * FROM shiying_review_runs WHERE id=?;', id)
    : await db.getFirstAsync<Row>('SELECT * FROM shiying_review_runs WHERE kind=?;', kind); if (!row) return null;
  const chunks = await db.getAllAsync<Row>('SELECT * FROM shiying_review_chunks WHERE run_id=? ORDER BY chunk_index;', row.id as string);
  return parseShiyingReviewRun({ id: row.id, ...(row.contract_version === 2 ? { kind: row.kind, contractVersion: 2 } : {}), periodStart: row.period_start, periodEnd: row.period_end,
    inputHash: row.input_hash, promptHash: row.prompt_hash, status: row.status, lastErrorCode: row.last_error_code,
    planJson: row.plan_json, createdAt: row.created_at, updatedAt: row.updated_at,
    chunks: chunks.map(chunk => ({ id: chunk.id, runId: chunk.run_id, index: chunk.chunk_index, stage: chunk.stage,
      status: chunk.status, payloadJson: chunk.payload_json, resultJson: chunk.result_json, attempts: chunk.attempts,
      startedAt: chunk.started_at, completedAt: chunk.completed_at, lastErrorCode: chunk.last_error_code })) });
}
export function getShiyingReviewRun(kind: 'week' | 'month' | 'year' = 'week') { return safe(() => runShiyingDatabaseOperation(db => loadRun(db, kind))); }
export function getShiyingReviewRunById(id: string) { return safe(() => runShiyingDatabaseOperation(db => loadRun(db, 'week', id))); }
export async function listShiyingReviewRuns() {
  return runShiyingDatabaseOperation(async db => {
    const result: ShiyingReviewRun[] = [];
    for (const kind of ['week', 'month', 'year'] as const) { const run = await loadRun(db, kind); if (run) result.push(run); }
    return result;
  });
}
export function createShiyingReviewRun(input: ShiyingReviewRun) {
  const run = parseShiyingReviewRun(input);
  if (run.status !== 'pending' || run.chunks.some(chunk => chunk.status !== 'pending' || chunk.attempts !== 0 || chunk.startedAt !== null)) fail('run_initial_state');
  return safe(() => runShiyingTransaction(async db => {
    const existing = await loadRun(db, run.kind ?? 'week'); if (existing) { if (canonicalJsonV1(existing) === canonicalJsonV1(run)) return existing; fail('run_exists', existing.id); }
    await db.runAsync(`INSERT INTO shiying_review_runs (id,kind,contract_version,period_start,period_end,input_hash,prompt_hash,status,last_error_code,plan_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?);`, run.id, run.kind ?? 'week', run.contractVersion ?? 1, run.periodStart, run.periodEnd, run.inputHash, run.promptHash, run.status, run.lastErrorCode, run.planJson, run.createdAt, run.updatedAt);
    for (const chunk of run.chunks) await db.runAsync(`INSERT INTO shiying_review_chunks
      (id,run_id,chunk_index,stage,status,payload_json,result_json,attempts,started_at,completed_at,last_error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?);`,
    chunk.id, run.id, chunk.index, chunk.stage, chunk.status, chunk.payloadJson, chunk.resultJson, chunk.attempts, chunk.startedAt, chunk.completedAt, chunk.lastErrorCode);
    return run;
  }));
}
async function requireRun(db: Database, runId: string) { const run = await loadRun(db, 'week', runId); if (!run) fail('run_missing', runId); return run; }
export function beginShiyingReviewChunk(input: { runId: string; chunkId: string; at: number }) {
  time(input.at);
  return safe(() => runShiyingTransaction(async db => {
    const run = await requireRun(db, input.runId), chunk = run.chunks.find(item => item.id === input.chunkId);
    if (!chunk || run.status !== 'pending' || chunk.status !== 'pending' || run.chunks.some(item => item.index < chunk.index && item.status !== 'completed')) fail('chunk_not_ready', input.chunkId);
    if (input.at < run.updatedAt || run.chunks.some(item => item.id !== chunk.id && item.status === 'in_flight')) fail('chunk_busy_or_time', input.chunkId);
    await db.runAsync("UPDATE shiying_review_chunks SET status='in_flight',attempts=attempts+1,started_at=?,last_error_code=NULL WHERE id=?;", input.at, chunk.id);
    await db.runAsync("UPDATE shiying_review_runs SET status='pending',last_error_code=NULL,updated_at=? WHERE id=?;", input.at, run.id);
    return (await loadRun(db, 'week', run.id))!;
  }));
}
export function completeShiyingReviewChunk(input: { runId: string; chunkId: string; attempts: number; startedAt: number; resultJson: string; completedAt: number }) {
  time(input.startedAt); time(input.completedAt); json(input.resultJson);
  return safe(() => runShiyingTransaction(async db => {
    const run = await requireRun(db, input.runId), chunk = run.chunks.find(item => item.id === input.chunkId);
    if (!chunk || chunk.attempts !== input.attempts || chunk.startedAt !== input.startedAt) fail('chunk_attempt_conflict', input.chunkId);
    if (chunk.status === 'completed') {
      if (chunk.completedAt !== input.completedAt || canonicalJsonV1(json(chunk.resultJson)) !== canonicalJsonV1(json(input.resultJson))) fail('chunk_result_conflict', chunk.id);
      return run;
    }
    if (chunk.status !== 'in_flight' || input.completedAt < input.startedAt) fail('chunk_attempt_state', chunk.id);
    await db.runAsync("UPDATE shiying_review_chunks SET status='completed',result_json=?,completed_at=?,last_error_code=NULL WHERE id=?;", input.resultJson, input.completedAt, chunk.id);
    await db.runAsync('UPDATE shiying_review_runs SET updated_at=MAX(updated_at,?) WHERE id=?;', input.completedAt, run.id);
    return (await loadRun(db, 'week', run.id))!;
  }));
}
export function blockShiyingReviewRun(input: { runId: string; errorCode: string; at: number }) {
  time(input.at); technicalCode(input.errorCode);
  return safe(() => runShiyingTransaction(async db => {
    const run = await requireRun(db, input.runId);
    await db.runAsync("UPDATE shiying_review_runs SET status='blocked',last_error_code=?,updated_at=MAX(updated_at,?) WHERE id=?;", input.errorCode, input.at, run.id);
    await db.runAsync("UPDATE shiying_review_chunks SET last_error_code=? WHERE run_id=? AND status='in_flight';", input.errorCode, run.id);
    return (await loadRun(db, 'week', run.id))!;
  }));
}
export function resumeShiyingReviewRun(input: { runId: string; at: number }) {
  time(input.at);
  return safe(() => runShiyingTransaction(async db => {
    const run = await requireRun(db, input.runId);
    await db.runAsync("UPDATE shiying_review_runs SET status='pending',last_error_code=NULL,updated_at=MAX(updated_at,?) WHERE id=?;", input.at, run.id);
    await db.runAsync("UPDATE shiying_review_chunks SET status='pending',last_error_code=NULL WHERE run_id=? AND status='in_flight';", run.id);
    return (await loadRun(db, 'week', run.id))!;
  }));
}
export function abandonShiyingReviewRun(runId: string) {
  return safe(() => runShiyingTransaction(async db => { const run = await loadRun(db, 'week', runId); if (!run) return false;
    await db.runAsync('DELETE FROM shiying_review_runs WHERE id=?;', runId); return true; }));
}
async function loadReceipt(db: Database, id: string): Promise<ShiyingReviewReceipt | null> {
  const row = await db.getFirstAsync<Row>('SELECT * FROM shiying_review_receipts WHERE id=?;', id); if (!row) return null;
  return parseShiyingReviewReceipt({ id: row.id, ...(row.contract_version === 2 ? { kind: row.kind, contractVersion: 2,
    regenerationIntentId: row.regeneration_intent_id ?? null } : {}), periodStart: row.period_start, periodEnd: row.period_end, inputHash: row.input_hash, basisHash: row.basis_hash,
    promptHash: row.prompt_hash, outcome: row.outcome, summaryId: row.summary_id, completedAt: row.completed_at });
}
export function getShiyingReviewReceipt(id: string) { return safe(() => runShiyingDatabaseOperation(db => loadReceipt(db, id))); }
export function getLatestShiyingReviewReceipt(periodStart: string, kind: 'week' | 'month' | 'year' = 'week') {
  assertShiyingLifeDate(periodStart, 'review_period_start');
  return safe(() => runShiyingDatabaseOperation(async db => {
    const row = await db.getFirstAsync<{ id: string }>('SELECT id FROM shiying_review_receipts WHERE period_start=? AND kind=? ORDER BY completed_at DESC,id DESC LIMIT 1;', periodStart, kind);
    return row ? loadReceipt(db, row.id) : null;
  }));
}
export function getShiyingReviewPeriodState(periodStart: string, periodEnd: string, kind: 'week' | 'month' | 'year' = 'week') {
  assertShiyingLifeDate(periodStart, 'review_period_start'); assertShiyingLifeDate(periodEnd, 'review_period_end');
  return safe(() => runShiyingDatabaseOperation(async db => {
    const row = await db.getFirstAsync<{ id: string; dirty: number }>('SELECT id,dirty FROM shiying_review_receipts WHERE period_start=? AND period_end=? AND kind=? ORDER BY completed_at DESC,id DESC LIMIT 1;', periodStart, periodEnd, kind);
    return row ? { receipt: (await loadReceipt(db, row.id))!, dirty: row.dirty === 1 } : null;
  }));
}
export function reconcileShiyingUnchangedPeriodReview(input: { kind: 'month' | 'year'; periodStart: string; periodEnd: string;
  basisHash: string; validateWithDatabase: (db: Database) => Promise<void> }) {
  return safe(() => runShiyingTransaction(async db => {
    await input.validateWithDatabase(db);
    const row = await db.getFirstAsync<{ id: string }>('SELECT id FROM shiying_review_receipts WHERE kind=? AND period_start=? AND period_end=? ORDER BY completed_at DESC,id DESC LIMIT 1;', input.kind, input.periodStart, input.periodEnd);
    const receipt = row ? await loadReceipt(db, row.id) : null;
    if (!receipt || receipt.basisHash !== input.basisHash) fail('receipt_basis_conflict');
    if (receipt.summaryId) {
      const summary = await loadShiyingSummaryAnyWithDatabase(db, receipt.summaryId);
      if (summary?.status === 'rejected' || summary?.payloadVersion === 3 && summary.editedAt !== null) fail('summary_changed');
      await db.runAsync('UPDATE shiying_summaries SET dirty=0,source_invalidated=0 WHERE id=?;', receipt.summaryId);
    }
    await db.runAsync('UPDATE shiying_review_receipts SET dirty=0 WHERE id=?;', receipt.id);
    return receipt;
  }));
}
export function reconcileShiyingUnchangedReview(input: { periodStart: string; periodEnd: string; basisHash: string;
  expectedMaterials: Array<{ kind: 'entry' | 'record'; id: string; materialHash: string }>;
  expectedEvents: Array<{ id: string; updatedAt: number }> }) {
  assertShiyingLifeDate(input.periodStart, 'review_period_start'); assertShiyingLifeDate(input.periodEnd, 'review_period_end');
  assertShiyingHash(input.basisHash, 'review_basis_hash');
  if (input.periodStart > input.periodEnd) fail('period_range');
  for (const source of input.expectedMaterials) {
    if (!['entry', 'record'].includes(source.kind)) fail('source_kind');
    assertShiyingUuidV4(source.id, 'source_id'); assertShiyingHash(source.materialHash, 'review_material_hash');
  }
  const key = (source: { kind: string; id: string }) => `${source.kind}:${source.id}`;
  const expected = new Map(input.expectedMaterials.map(source => [key(source), source.materialHash]));
  if (expected.size !== input.expectedMaterials.length) fail('source_duplicate');
  for (const event of input.expectedEvents) { assertShiyingUuidV4(event.id, 'event_id'); time(event.updatedAt); }
  if (new Set(input.expectedEvents.map(event => event.id)).size !== input.expectedEvents.length) fail('event_duplicate');
  return safe(() => runShiyingTransaction(async db => {
    const current = new Map<string, string>();
    const entries = await db.getAllAsync<{ id: string }>("SELECT id FROM shiying_entries WHERE status='active' AND life_date BETWEEN ? AND ?;", input.periodStart, input.periodEnd);
    for (const { id } of entries) {
      const entry = await loadEntryWithDatabase(db, id); if (!entry) fail('source_unavailable', id);
      const material = projectShiyingMixedEntry(entry); if (!material) fail('source_unavailable', id);
      current.set(key(material), material.materialHash);
    }
    const records = await db.getAllAsync<{ id: string }>("SELECT id FROM shiying_records WHERE status='finalized' AND record_date BETWEEN ? AND ?;", input.periodStart, input.periodEnd);
    for (const { id } of records) {
      const record = await loadShiyingRecordWithDatabase(db, id); if (!record) fail('source_unavailable', id);
      const note = record.images.length ? await loadShiyingRecordImageNoteWithDatabase(db, id) : null;
      const job = record.images.length ? await loadShiyingRecordImageJobWithDatabase(db, id) : null;
      const material = projectShiyingMixedRecord({ record, note, jobSkipped: job?.status === 'skipped' });
      if (!material) fail('source_unavailable', id); current.set(key(material), material.materialHash);
    }
    if (current.size !== expected.size || [...current].some(([id, materialHash]) => expected.get(id) !== materialHash)) fail('source_changed');
    for (const event of input.expectedEvents) {
      const row = await db.getFirstAsync<{ updated_at: number }>('SELECT updated_at FROM shiying_events WHERE id=?;', event.id);
      if (!row || row.updated_at !== event.updatedAt) fail('event_changed', event.id);
    }
    const latest = await db.getFirstAsync<{ id: string }>('SELECT id FROM shiying_review_receipts WHERE period_start=? AND period_end=? ORDER BY completed_at DESC,id DESC LIMIT 1;', input.periodStart, input.periodEnd);
    const receipt = latest ? await loadReceipt(db, latest.id) : null;
    if (!receipt || receipt.basisHash !== input.basisHash) fail('receipt_basis_conflict');
    const summaryId = createShiyingSummaryId({ kind: 'week', periodStartLifeDate: input.periodStart, periodEndLifeDate: input.periodEnd });
    await db.runAsync('UPDATE shiying_review_receipts SET dirty=0 WHERE id=?;', receipt.id);
    await db.runAsync('UPDATE shiying_summaries SET dirty=0 WHERE id=?;', summaryId);
    await db.runAsync('UPDATE shiying_topics SET dirty=0 WHERE summary_id=?;', summaryId);
    return { receipt, summary: await loadShiyingSummarySnapshotWithDatabase(db, summaryId) };
  })).then(result => { notify(); return result; });
}
export function commitShiyingWeeklyReview(input: { runId: string | null; summary: ShiyingSummaryV2 | ShiyingSummaryV3 | null;
  events: ShiyingEventPatch[]; topics: ShiyingTopicV1[]; receipt: ShiyingReviewReceipt;
  expectedSummaryStateHash?: string | null; allowHumanReplacement?: boolean;
  validateBeforeCommit?: (db: Database) => Promise<boolean> }) {
  const receipt = parseShiyingReviewReceipt(input.receipt), summary = input.summary === null ? null
    : input.summary.payloadVersion === 3 ? parseShiyingSummaryV3(input.summary) : parseShiyingSummaryV2(input.summary), topics = input.topics.map(parseShiyingTopicV1);
  const kind = receipt.kind ?? 'week';
  if (summary ? summary.id !== receipt.summaryId || summary.inputHash !== receipt.inputHash || summary.kind !== kind : receipt.outcome === 'review') fail('commit_summary_identity');
  if (kind !== 'week' && (topics.length || input.events.length)) fail('period_output_shape');
  if (topics.some(topic => topic.summaryId !== receipt.summaryId) || new Set(topics.map(topic => topic.id)).size !== topics.length) fail('commit_topic_identity');
  if (new Set(input.events.map(event => event.id)).size !== input.events.length) fail('commit_event_duplicate');
  const commitHash = hashShiyingJson({ summary, events: input.events, topics, receipt });
  return safe(() => runShiyingTransaction(async db => {
    const previous = await loadReceipt(db, receipt.id);
    if (previous) {
      if (canonicalJsonV1(previous) !== canonicalJsonV1(receipt)) fail('receipt_conflict', receipt.id);
      const saved = await db.getFirstAsync<{ commit_hash: string }>('SELECT commit_hash FROM shiying_review_receipts WHERE id=?;', receipt.id);
      if (saved?.commit_hash !== commitHash) fail('receipt_commit_conflict', receipt.id);
      const currentSummary = receipt.summaryId ? await loadShiyingSummaryAnyWithDatabase(db, receipt.summaryId) : null;
      const currentEvents = []; for (const event of input.events) { const current = await loadShiyingEventSnapshotWithDatabase(db, event.id); if (current) currentEvents.push(current); }
      const currentTopics = []; for (const topic of topics) { const current = await loadTopic(db, topic.id); if (current) currentTopics.push(current); }
      return { summary: currentSummary, events: currentEvents, topics: currentTopics, receipt: previous, replayed: true };
    }
    if (input.runId !== null) {
      const run = await requireRun(db, input.runId);
      if ((run.kind ?? 'week') !== kind || (run.contractVersion ?? 1) !== (receipt.contractVersion ?? 1)
        || run.inputHash !== receipt.inputHash || run.promptHash !== receipt.promptHash || run.periodStart !== receipt.periodStart
        || run.periodEnd !== receipt.periodEnd || run.chunks.some(chunk => chunk.status !== 'completed')) fail('commit_run_identity', run.id);
    } else if (receipt.outcome === 'review') fail('commit_run_missing');
    const hasAdditions = input.validateBeforeCommit ? await input.validateBeforeCommit(db) : false;
    const savedSummary = summary ? summary.payloadVersion === 3
      ? await saveShiyingSummaryV3WithDatabase(db, { ...summary, dirty: summary.dirty || hasAdditions },
        { ...(Object.hasOwn(input, 'expectedSummaryStateHash') ? { expectedStateHash: input.expectedSummaryStateHash } : {}), allowHumanReplacement: input.allowHumanReplacement })
      : await saveShiyingSummaryV2WithDatabase(db, summary) : null;
    if (receipt.outcome === 'empty') await db.runAsync("UPDATE shiying_summaries SET dirty=0 WHERE kind=? AND period_start_life_date=? AND period_end_life_date=?;", kind, receipt.periodStart, receipt.periodEnd);
    const savedEvents = []; for (const patch of input.events) savedEvents.push(await saveEventPatch(db, patch, receipt.completedAt));
    if (receipt.summaryId) await db.runAsync('DELETE FROM shiying_topics WHERE summary_id=?;', receipt.summaryId);
    for (const topic of topics) {
      await validateShiyingScopedSourcesWithDatabase(db, topic.sources);
      await db.runAsync('INSERT INTO shiying_topics (id,summary_id,title,dirty,created_at,updated_at,payload_version) VALUES (?,?,?,?,?,?,1);', topic.id, topic.summaryId, topic.title, topic.dirty ? 1 : 0, topic.createdAt, topic.updatedAt);
      await insertScopedSources(db, 'shiying_topic_sources', topic.id, topic.sources);
    }
    await db.runAsync(`INSERT INTO shiying_review_receipts (id,kind,contract_version,regeneration_intent_id,period_start,period_end,input_hash,basis_hash,prompt_hash,outcome,summary_id,completed_at,dirty,commit_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?);`, receipt.id, kind, receipt.contractVersion ?? 1, receipt.regenerationIntentId ?? null,
    receipt.periodStart, receipt.periodEnd, receipt.inputHash, receipt.basisHash, receipt.promptHash,
    receipt.outcome, receipt.summaryId, receipt.completedAt, savedSummary?.dirty ? 1 : 0, commitHash);
    if (input.runId !== null) await db.runAsync('DELETE FROM shiying_review_runs WHERE id=?;', input.runId);
    return { summary: savedSummary, events: savedEvents, topics, receipt, replayed: false };
  })).then(result => { notify(); publishShiyingSummaryChanges(); return result; });
}
