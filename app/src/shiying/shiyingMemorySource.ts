import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { MemorySourceRefInput } from '../memory/memoryStore';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { createShiyingRecordContentHash, parseShiyingRecordV1, type ShiyingRecordV1 } from './shiyingJournalContract';
import type { ShiyingRecordImageNoteV1 } from './shiyingImageNoteContract';
import { createShiyingImageNoteResultHash, deserializeShiyingRecordImageNoteV1 } from './shiyingImageNoteContract';

export const SHIYING_MEMORY_SOURCE_PREFIX = 'shiying-source-v1:';
export type ShiyingMemoryPart = 'body' | 'image_note';
export type ShiyingMemoryRange = { start: number; end: number };
export type ShiyingMemoryIdentity = { recordId: string; part: ShiyingMemoryPart; version: string };
export type ShiyingMemorySnapshot = {
  recordId: string; recordDate: string; createdAt: number; finalizedAt: number; updatedAt: number;
  recordContentHash: string; materialHash: string; body: string; bodyVersion: string;
  imageNote: { id: string; body: string; version: string; createdAt: number } | null;
};
type ShiyingMemoryOriginal = { record: ShiyingRecordV1; note: ShiyingRecordImageNoteV1 | null; jobSkipped?: boolean };
export type ShiyingMemoryOriginalReader = {
  readRecord(id: string): Promise<ShiyingMemoryOriginal | null>;
  readRecords?(ids: readonly string[], options?: { signal?: AbortSignal }): Promise<ReadonlyMap<string, ShiyingMemoryOriginal>>;
  listFinalizedRecordIds(): Promise<string[]>;
};
export type ShiyingMemoryBinding = ShiyingMemoryIdentity & {
  sessionId: string; messageId: string; sourceHash: string; recordContentHash: string;
  range: ShiyingMemoryRange; start: number; nextOffset: number; sentHash: string;
};
export type ShiyingMemoryMessageInfo = ShiyingMemoryIdentity & { sessionId: string; sourceHash: string };
type SourceMessage = SubjectiveMessage & { shiyingMemoryInfo: ShiyingMemoryMessageInfo };
export type ShiyingMemoryIndexSource = {
  id: string; recordDate: string; materialHash: string; sourceContentHash: string; indexText: string; updatedAt: number;
};
let originalReader: ShiyingMemoryOriginalReader | null | undefined;
export function bindShiyingMemoryOriginalReader(reader: ShiyingMemoryOriginalReader | null) { originalReader = reader; }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const versionHash = /^(?:[0-9a-f]{8}|sha256:[0-9a-f]{64})$/u;
export function isShiyingMemorySource(sessionId: string) { return sessionId.startsWith(SHIYING_MEMORY_SOURCE_PREFIX); }
export function shiyingMemorySourceSessionId(identity: ShiyingMemoryIdentity) {
  return SHIYING_MEMORY_SOURCE_PREFIX + encodeURIComponent(JSON.stringify([identity.recordId, identity.part, identity.version]));
}
export function parseShiyingMemorySource(sessionId: string): ShiyingMemoryIdentity | null {
  if (!isShiyingMemorySource(sessionId)) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(sessionId.slice(SHIYING_MEMORY_SOURCE_PREFIX.length)));
    if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== 'string' || !uuid.test(value[0])
      || !['body', 'image_note'].includes(value[1]) || typeof value[2] !== 'string' || !versionHash.test(value[2])) return null;
    const identity = { recordId: value[0], part: value[1] as ShiyingMemoryPart, version: value[2] };
    return shiyingMemorySourceSessionId(identity) === sessionId ? identity : null;
  } catch { return null; }
}
export function shiyingMemoryOccurrenceKey(value: { recordId: string } | string) {
  const identity = typeof value === 'string' ? parseShiyingMemorySource(value) : value;
  return identity ? `shiying-record:${identity.recordId}` : null;
}
async function nativeReader(): Promise<ShiyingMemoryOriginalReader> {
  const { runShiyingDatabaseOperation } = await import('./shiyingDatabase');
  const { loadShiyingRecordWithDatabase, shiyingRecordFromDatabaseRows } = await import('./shiyingJournalStore');
  const { loadShiyingRecordImageNoteWithDatabase } = await import('./shiyingImageNoteStore');
  return {
    readRecord: id => runShiyingDatabaseOperation(async db => {
      const record = await loadShiyingRecordWithDatabase(db, id);
      if (!record) return null;
      return { record, note: await loadShiyingRecordImageNoteWithDatabase(db, id) };
    }),
    readRecords: (ids, options) => runShiyingDatabaseOperation(async db => {
      assertIndexReadCurrent(options?.signal);
      const keys = JSON.stringify(ids);
      const rows = await db.getAllAsync<Record<string, unknown> & { id: string }>(
        'SELECT * FROM shiying_records WHERE id IN (SELECT value FROM json_each(?));', keys);
      assertIndexReadCurrent(options?.signal);
      const images = await db.getAllAsync<Record<string, unknown> & { record_id: string }>(
        'SELECT * FROM shiying_record_images WHERE record_id IN (SELECT value FROM json_each(?)) ORDER BY record_id, ordinal;', keys);
      assertIndexReadCurrent(options?.signal);
      const notes = await db.getAllAsync<{ record_id: string; payload_json: string }>(
        'SELECT record_id,payload_json FROM shiying_record_image_notes WHERE record_id IN (SELECT value FROM json_each(?));', keys);
      assertIndexReadCurrent(options?.signal);
      const recordsById = new Map(rows.map(row => [row.id, row]));
      const imagesById = new Map<string, typeof images>();
      for (const image of images) {
        const group = imagesById.get(image.record_id) ?? [];
        group.push(image); imagesById.set(image.record_id, group);
      }
      const notesById = new Map(notes.map(note => [note.record_id, note.payload_json]));
      const originals = new Map<string, ShiyingMemoryOriginal>();
      for (const id of ids) {
        const row = recordsById.get(id);
        if (!row) continue;
        const record = shiyingRecordFromDatabaseRows(row, imagesById.get(id) ?? []);
        const note = notesById.get(id);
        originals.set(id, { record, note: note === undefined ? null : deserializeShiyingRecordImageNoteV1(note) });
      }
      return originals;
    }),
    listFinalizedRecordIds: () => runShiyingDatabaseOperation(async db => (await db.getAllAsync<{ id: string }>(
      "SELECT id FROM shiying_records WHERE status='finalized' ORDER BY finalized_at,created_at,id")).map(row => row.id)),
  };
}
async function reader() {
  if (originalReader === null) throw new Error('SHIYING_MEMORY_SOURCE_UNAVAILABLE');
  return originalReader ?? await nativeReader();
}
export async function loadShiyingMemorySnapshot(recordId: string): Promise<ShiyingMemorySnapshot | null> {
  if (!uuid.test(recordId)) return null;
  const original = await (await reader()).readRecord(recordId);
  return snapshotFromOriginal(recordId, original);
}
async function snapshotFromOriginal(recordId: string, original: ShiyingMemoryOriginal | null): Promise<ShiyingMemorySnapshot | null> {
  if (!original) return null;
  const record = parseShiyingRecordV1(original.record);
  if (record.id !== recordId || record.status !== 'finalized') return null;
  const { projectShiyingMixedRecord } = await import('./shiyingMixedMaterials');
  const material = projectShiyingMixedRecord(original);
  if (!material) return null;
  const note = material.imageNote;
  const imageNote = note ? { id: note.id, body: note.body,
    version: createShiyingImageNoteResultHash(original.note!), createdAt: original.note!.createdAt } : null;
  const bodyVersion = stableMemoryHash(JSON.stringify([record.id, record.recordDate, record.body]));
  return { recordId, recordDate: record.recordDate, createdAt: record.createdAt, finalizedAt: record.finalizedAt!,
    updatedAt: Math.max(record.updatedAt, original.note?.updatedAt ?? 0),
    recordContentHash: createShiyingRecordContentHash(record), body: record.body, bodyVersion, imageNote,
    materialHash: stableMemoryHash(JSON.stringify([record.id, createShiyingRecordContentHash(record), bodyVersion, imageNote?.version ?? null])) };
}
export async function listShiyingMemorySnapshots() {
  const ids = await (await reader()).listFinalizedRecordIds();
  const result: ShiyingMemorySnapshot[] = [];
  for (const id of [...new Set(ids)]) { const snapshot = await loadShiyingMemorySnapshot(id); if (snapshot) result.push(snapshot); }
  return result;
}
export function shiyingMemoryPartIdentity(snapshot: ShiyingMemorySnapshot, part: ShiyingMemoryPart): ShiyingMemoryIdentity | null {
  const version = part === 'body' ? snapshot.bodyVersion : snapshot.imageNote?.version;
  return version ? { recordId: snapshot.recordId, part, version } : null;
}
export function makeShiyingMemoryMessage(snapshot: ShiyingMemorySnapshot, part: ShiyingMemoryPart,
  range?: ShiyingMemoryRange): SubjectiveMessage | null {
  const identity = shiyingMemoryPartIdentity(snapshot, part);
  const text = part === 'body' ? snapshot.body : snapshot.imageNote?.body;
  if (!identity || !text?.trim()) return null;
  const sessionId = shiyingMemorySourceSessionId(identity);
  return { id: `shiying-original-${part}-${snapshot.recordId}`, role: part === 'body' ? 'you' : 'I',
    content: range ? text.slice(range.start, range.end) : text,
    createdAt: part === 'body' ? snapshot.createdAt : snapshot.imageNote!.createdAt,
    shiyingMemoryInfo: { ...identity, sessionId, sourceHash: stableMemoryHash(JSON.stringify([sessionId, text])) } } as SourceMessage;
}
export function getShiyingMemoryMessageInfo(message: SubjectiveMessage) {
  return (message as Partial<SourceMessage>).shiyingMemoryInfo;
}
export async function loadShiyingMemoryMessage(sessionId: string, messageId: string) {
  const identity = parseShiyingMemorySource(sessionId);
  const snapshot = identity && await loadShiyingMemorySnapshot(identity.recordId);
  const message = snapshot && makeShiyingMemoryMessage(snapshot, identity!.part);
  return message && message.id === messageId && getShiyingMemoryMessageInfo(message)?.sessionId === sessionId ? message : null;
}
export async function loadShiyingMemoryMessages(sessionId: string) {
  const identity = parseShiyingMemorySource(sessionId);
  if (!identity) return [];
  const message = await loadShiyingMemoryMessage(sessionId, `shiying-original-${identity.part}-${identity.recordId}`);
  return message ? [message] : [];
}
export function makeShiyingMemoryBinding(snapshot: ShiyingMemorySnapshot, part: ShiyingMemoryPart,
  range: ShiyingMemoryRange, start = range.start): ShiyingMemoryBinding {
  const message = makeShiyingMemoryMessage(snapshot, part, range);
  if (!message) throw new Error('SHIYING_MEMORY_SOURCE_INVALID');
  const info = getShiyingMemoryMessageInfo(message)!;
  return { ...info, messageId: message.id, recordContentHash: snapshot.recordContentHash,
    range, start, nextOffset: range.end, sentHash: stableMemoryHash(message.content) };
}
export async function validateShiyingMemoryBinding(binding: ShiyingMemoryBinding, sent?: SubjectiveMessage) {
  if (!binding || !parseShiyingMemorySource(binding.sessionId)) return false;
  const snapshot = await loadShiyingMemorySnapshot(binding.recordId);
  const text = binding.part === 'body' ? snapshot?.body : snapshot?.imageNote?.body;
  const range = binding.range;
  if (!snapshot || snapshot.recordContentHash !== binding.recordContentHash || !text
    || ![range?.start, range?.end, binding.start, binding.nextOffset].every(Number.isSafeInteger)
    || range.start < 0 || range.end <= range.start || range.end > text.length
    || binding.start !== range.start || binding.nextOffset !== range.end) return false;
  const message = makeShiyingMemoryMessage(snapshot, binding.part, range);
  const info = message && getShiyingMemoryMessageInfo(message);
  return !!message && info?.sessionId === binding.sessionId && info.sourceHash === binding.sourceHash
    && info.version === binding.version && message.id === binding.messageId
    && stableMemoryHash(message.content) === binding.sentHash
    && (!sent || sent.id === message.id && sent.role === message.role && sent.content === message.content
      && getShiyingMemoryMessageInfo(sent)?.sessionId === binding.sessionId);
}
export async function validateShiyingMemoryCandidate(candidate: {
  shiyingBindings?: ShiyingMemoryBinding[]; sourceRefs?: MemorySourceRefInput[];
}) {
  const bindings = candidate.shiyingBindings ?? [];
  if ((candidate.sourceRefs ?? []).some(ref => isShiyingMemorySource(ref.sessionId) && (ref.relation ?? 'direct') === 'direct'
    && !bindings.some(binding => binding.sessionId === ref.sessionId && binding.messageId === ref.messageId))) return false;
  for (const binding of bindings) if (!(await validateShiyingMemoryBinding(binding))) return false;
  return true;
}
export function replaceShiyingMemorySourceRefs(previous: readonly MemorySourceRefInput[],
  next: readonly MemorySourceRefInput[], bindings: readonly ShiyingMemoryBinding[]) {
  const keys = new Set(bindings.map(binding => JSON.stringify([binding.recordId, binding.part])));
  return [...new Map([...previous.filter(ref => {
    const identity = parseShiyingMemorySource(ref.sessionId);
    return !identity || !keys.has(JSON.stringify([identity.recordId, identity.part]));
  }), ...next].map(ref => [JSON.stringify([ref.sessionId, ref.messageId, ref.relation ?? 'direct']), ref])).values()];
}
export async function loadShiyingMemoryIndexSource(id: string): Promise<ShiyingMemoryIndexSource | null> {
  const snapshot = await loadShiyingMemorySnapshot(id);
  return indexSourceFromSnapshot(id, snapshot);
}
function indexSourceFromSnapshot(id: string, snapshot: ShiyingMemorySnapshot | null): ShiyingMemoryIndexSource | null {
  if (!snapshot) return null;
  return { id, recordDate: snapshot.recordDate, materialHash: snapshot.materialHash,
    sourceContentHash: snapshot.recordContentHash, updatedAt: snapshot.updatedAt,
    indexText: [snapshot.body, snapshot.imageNote?.body].filter(Boolean).join('\n\n') };
}
function assertIndexReadCurrent(signal?: AbortSignal) {
  if (signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
}
export async function loadShiyingMemoryIndexSources(ids: readonly string[], options: { signal?: AbortSignal } = {}) {
  assertIndexReadCurrent(options.signal);
  const result = new Map<string, ShiyingMemoryIndexSource>();
  const keys = [...new Set(ids)].filter(id => uuid.test(id));
  if (!keys.length) return result;
  const currentReader = await reader();
  assertIndexReadCurrent(options.signal);
  const originals = currentReader.readRecords ? await currentReader.readRecords(keys, options) : undefined;
  assertIndexReadCurrent(options.signal);
  for (const id of keys) {
    assertIndexReadCurrent(options.signal);
    const source = originals
      ? indexSourceFromSnapshot(id, await snapshotFromOriginal(id, originals.get(id) ?? null))
      : await loadShiyingMemoryIndexSource(id);
    assertIndexReadCurrent(options.signal);
    if (source) result.set(id, source);
  }
  return result;
}
export async function listShiyingMemoryIndexSourceKeys(options: { after?: { id: string; updatedAt: number }; limit?: number } = {}) {
  const snapshots = await listShiyingMemorySnapshots();
  return snapshots.map(source => ({ id: source.recordId, updatedAt: source.updatedAt }))
    .filter(key => !options.after || key.updatedAt > options.after.updatedAt
      || key.updatedAt === options.after.updatedAt && key.id > options.after.id)
    .sort((a, b) => a.updatedAt - b.updatedAt || a.id.localeCompare(b.id))
    .slice(0, Math.max(1, Math.min(1000, options.limit ?? 100)));
}

/** Saved ordinary cards survive missing originals; a known replaced version stays stale. */
export async function currentShiyingOrganizationMemoryIds(
  database: Pick<import('expo-sqlite').SQLiteDatabase, 'getAllAsync'>, memories: readonly { id: string }[],
  refs?: ReadonlyMap<string, readonly Pick<MemorySourceRefInput, 'sessionId' | 'relation'>[]>) {
  const byId = new Map(memories.map(memory => [memory.id, [...(refs?.get(memory.id) ?? [])].map(ref => ref.sessionId).filter(isShiyingMemorySource)]));
  const missing = memories.filter(memory => !refs?.has(memory.id)).map(memory => memory.id);
  if (missing.length) {
    const rows = await database.getAllAsync<{ memory_id: string; session_id: string }>(
      "SELECT memory_id,session_id FROM memory_source_refs WHERE memory_id IN (SELECT value FROM json_each(?)) AND session_id LIKE 'shiying-source-v1:%'", JSON.stringify(missing));
    for (const row of rows) byId.get(row.memory_id)!.push(row.session_id);
  }
  if (![...byId.values()].some(sessions => sessions.length)) return new Set(memories.map(memory => memory.id));
  const registrations = await database.getAllAsync<{ work_metadata_json: string }>(
    "SELECT work_metadata_json FROM memory_ingestion_batches WHERE scope_key='shiying-record' AND json_type(work_metadata_json,'$.shiyingRegistration') IS NOT NULL");
  const replaced = new Set(registrations.flatMap(row => (JSON.parse(row.work_metadata_json) as { shiyingRegistration?: { replacedSources?: string[] } }).shiyingRegistration?.replacedSources ?? []));
  const current = new Map<string, boolean>(), snapshots = new Map<string, ShiyingMemorySnapshot | null>();
  for (const session of new Set([...byId.values()].flat())) {
    const identity = parseShiyingMemorySource(session);
    if (!identity || replaced.has(session)) { current.set(session, false); continue; }
    if (!snapshots.has(identity.recordId)) snapshots.set(identity.recordId, await loadShiyingMemorySnapshot(identity.recordId));
    const snapshot = snapshots.get(identity.recordId);
    current.set(session, !snapshot || identity.version === (identity.part === 'body' ? snapshot.bodyVersion : snapshot.imageNote?.version));
  }
  return new Set(memories.filter(memory => byId.get(memory.id)!.every(session => current.get(session))).map(memory => memory.id));
}
export async function isShiyingOrganizationMemoryCurrent(database: Pick<import('expo-sqlite').SQLiteDatabase, 'getAllAsync'>,
  memoryId: string, refs?: readonly Pick<MemorySourceRefInput, 'sessionId' | 'relation'>[]) {
  return (await currentShiyingOrganizationMemoryIds(database, [{ id: memoryId }], refs ? new Map([[memoryId, refs]]) : undefined)).has(memoryId);
}
/** Call only after the owning Shiying operation has committed and left its queue. */
export function notifyShiyingMemorySourceChanged(recordId: string) {
  void (async () => {
    await (await import('./shiyingMemoryIngestion')).rememberShiyingMemorySourceVersions(recordId);
    await (await import('../memory/memoryProcessingWorker')).queueShiyingRecordEmbedding(recordId);
    (await import('../memory/memoryProcessingSignals')).notifyMemoryProcessingWorkAvailable('memory_changed');
  })().catch(() => {
    // Existing reconciliation retries current originals; a notification is not the source commit.
    void import('../memory/memoryProcessingSignals').then(module => module.notifyMemoryProcessingWorkAvailable('memory_changed')).catch(() => undefined);
  });
}
