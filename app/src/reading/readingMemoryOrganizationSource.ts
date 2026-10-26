import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { SQLiteDatabase } from 'expo-sqlite';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import type { MemorySourceRefInput } from '../memory/memoryStore';
import { loadReadingMemorySource, parseReadingMemorySourceIdentity, type ReadingMemoryBinding, type ReadingMemorySourceSnapshot } from './readingMemorySource';
import type { ReadingAnnotation, ReadingSegmentSummary } from './readingTypes';

export const READING_ORGANIZATION_SOURCE_PREFIX = 'reading-auto-v1:';
export type ReadingOrganizationIdentity = ReadingMemoryBinding & { activityId: string };
export type ReadingOrganizationBinding = ReadingOrganizationIdentity & {
  sessionId: string; messageId: string; sourceHash: string;
  bookRange: { start: number; end: number }; contentRange: { start: number; end: number };
  bookStart: number; contentStart: number; nextBookOffset: number; nextContentOffset: number; sentHash: string;
};
export type ReadingOrganizationSource = {
  identity: ReadingOrganizationIdentity; snapshot: ReadingMemorySourceSnapshot;
  sessionId: string; message: SubjectiveMessage; sourceHash: string;
};
export type ReadingOrganizationMessageInfo = { sessionId: string; activityId: string; sourceHash: string };
type SourceMessage = SubjectiveMessage & { readingOrganizationInfo: ReadingOrganizationMessageInfo };

export function isReadingOrganizationSource(sessionId: string) {
  return sessionId.startsWith(READING_ORGANIZATION_SOURCE_PREFIX);
}

export function parseReadingOrganizationSource(sessionId: string): ReadingOrganizationIdentity | null {
  if (!isReadingOrganizationSource(sessionId)) return null;
  try {
    const value: unknown = JSON.parse(decodeURIComponent(sessionId.slice(READING_ORGANIZATION_SOURCE_PREFIX.length)));
    if (!Array.isArray(value) || value.length !== 6) return null;
    const [bookId, kind, resultId, chapterIndex, version, activityId] = value;
    if (![bookId, resultId, version, activityId].every(item => typeof item === 'string' && !!item)
      || !['annotation', 'summary'].includes(kind) || !Number.isSafeInteger(chapterIndex) || chapterIndex < 0) return null;
    return { bookId, kind, resultId, chapterIndex, version, activityId };
  } catch { return null; }
}

export function readingOrganizationSourceKey(identity: ReadingOrganizationIdentity) {
  return JSON.stringify([identity.bookId, identity.kind, identity.resultId, identity.chapterIndex, identity.activityId]);
}

export function makeReadingOrganizationSource(snapshot: ReadingMemorySourceSnapshot): ReadingOrganizationSource | null {
  const record = (snapshot.item.annotation ?? snapshot.item.summary) as
    ((ReadingAnnotation | ReadingSegmentSummary) & { memoryIngestionVersion?: 1; resultActivityId?: string | null }) | undefined;
  if (record?.memoryIngestionVersion !== 1 || !record.resultActivityId || snapshot.messages.length !== 1) return null;
  const identity: ReadingOrganizationIdentity = { ...snapshot.binding, activityId: record.resultActivityId };
  const sessionId = READING_ORGANIZATION_SOURCE_PREFIX + encodeURIComponent(JSON.stringify([
    identity.bookId, identity.kind, identity.resultId, identity.chapterIndex, identity.version, identity.activityId,
  ]));
  // This is the canonical ID within the reading source, not a chat bubble or a model alias.
  const id = `reading-original-${stableMemoryHash(readingOrganizationSourceKey(identity))}`;
  const sourceHash = stableMemoryHash(JSON.stringify([sessionId, id, snapshot.messages[0].role,
    snapshot.messages[0].content, snapshot.messages[0].createdAt]));
  const message: SourceMessage = { ...snapshot.messages[0], id,
    readingOrganizationInfo: { sessionId, activityId: identity.activityId, sourceHash } };
  return { identity, snapshot, sessionId, sourceHash, message };
}

export async function loadReadingOrganizationSource(sessionId: string, currentVersion = false) {
  const identity = parseReadingOrganizationSource(sessionId);
  if (!identity) return null;
  const snapshot = await loadReadingMemorySource(identity);
  const source = snapshot && makeReadingOrganizationSource(snapshot);
  return source && source.identity.activityId === identity.activityId
    && (currentVersion || source.identity.version === identity.version) ? source : null;
}

export function getReadingOrganizationMessageInfo(message: SubjectiveMessage) {
  return (message as Partial<SourceMessage>).readingOrganizationInfo;
}

export async function loadReadingOrganizationMessage(sessionId: string, messageId: string) {
  const source = await loadReadingOrganizationSource(sessionId);
  return source?.message.id === messageId ? source.message : null;
}

function validRange(text: string, range: { start: number; end: number }, empty = false) {
  return Number.isSafeInteger(range?.start) && Number.isSafeInteger(range?.end)
    && range.start >= 0 && range.end >= range.start && (empty || range.end > range.start) && range.end <= text.length;
}

export function readingOrganizationSentHash(bookText: string, content: string) {
  return stableMemoryHash(JSON.stringify([bookText, content]));
}

export function wholeReadingOrganizationBinding(source: ReadingOrganizationSource): ReadingOrganizationBinding {
  return { ...source.identity, sessionId: source.sessionId, messageId: source.message.id, sourceHash: source.sourceHash,
    bookRange: { start: 0, end: source.snapshot.bookText.length }, contentRange: { start: 0, end: source.message.content.length },
    bookStart: 0, contentStart: 0, nextBookOffset: source.snapshot.bookText.length, nextContentOffset: source.message.content.length,
    sentHash: readingOrganizationSentHash(source.snapshot.bookText, source.message.content) };
}

export async function validateReadingOrganizationBinding(binding: ReadingOrganizationBinding, sent?: SubjectiveMessage) {
  const source = await loadReadingOrganizationSource(binding.sessionId);
  if (!source || source.message.id !== binding.messageId || source.sourceHash !== binding.sourceHash
    || (['bookId', 'kind', 'resultId', 'chapterIndex', 'version', 'activityId'] as const)
      .some(key => source.identity[key] !== binding[key])
    || !validRange(source.snapshot.bookText, binding.bookRange, true)
    || !validRange(source.message.content, binding.contentRange)) return false;
  const bookText = source.snapshot.bookText.slice(binding.bookRange.start, binding.bookRange.end);
  const content = source.message.content.slice(binding.contentRange.start, binding.contentRange.end);
  return readingOrganizationSentHash(bookText, content) === binding.sentHash
    && (!sent || sent.id === binding.messageId && sent.content === content
      && getReadingOrganizationMessageInfo(sent)?.sourceHash === binding.sourceHash);
}

export async function validateReadingOrganizationCandidate(candidate: {
  readingBindings?: ReadingOrganizationBinding[]; sourceRefs?: MemorySourceRefInput[];
}) {
  const bindings = candidate.readingBindings ?? [];
  for (const ref of candidate.sourceRefs ?? []) {
    if (isReadingOrganizationSource(ref.sessionId) && (ref.relation ?? 'direct') === 'direct'
      && !bindings.some(binding => binding.sessionId === ref.sessionId && binding.messageId === ref.messageId)) return false;
  }
  for (const binding of bindings) if (!(await validateReadingOrganizationBinding(binding))) return false;
  return true;
}

/** Current cards linked by exact original identity, including an exact-version manual reference. */
export async function readingOrganizationTargetIds(database: Pick<SQLiteDatabase, 'getAllAsync'>,
  binding: ReadingOrganizationBinding) {
  const refs = await database.getAllAsync<{ memory_id: string; session_id: string }>(
    `SELECT r.memory_id,r.session_id FROM memory_source_refs r JOIN memories m ON m.id=r.memory_id
     WHERE r.relation='direct' AND (r.session_id LIKE 'reading-auto-v1:%' OR r.session_id LIKE 'reading-v2:%')`);
  const key = readingOrganizationSourceKey(binding);
  return [...new Set(refs.flatMap(ref => {
    const automatic = parseReadingOrganizationSource(ref.session_id);
    if (automatic) return readingOrganizationSourceKey(automatic) === key ? [ref.memory_id] : [];
    const manual = parseReadingMemorySourceIdentity(ref.session_id);
    return manual && manual.bookId === binding.bookId && manual.kind === binding.kind && manual.resultId === binding.resultId
      && manual.chapterIndex === binding.chapterIndex && manual.version === binding.version ? [ref.memory_id] : [];
  }))];
}

export async function isReadingOrganizationMemoryCurrent(database: Pick<SQLiteDatabase, 'getAllAsync'>,
  memoryId: string, sourceRefs?: readonly Pick<MemorySourceRefInput, 'sessionId' | 'relation'>[]) {
  const refs = sourceRefs ? new Map([[memoryId, sourceRefs]]) : undefined;
  return (await currentReadingOrganizationMemoryIds(database, [{ id: memoryId }], refs)).has(memoryId);
}

/** One material pass shares only this pass's original reads; nothing survives into the next check. */
export async function currentReadingOrganizationMemoryIds(database: Pick<SQLiteDatabase, 'getAllAsync'>,
  memories: readonly { id: string }[],
  sourceRefs?: ReadonlyMap<string, readonly Pick<MemorySourceRefInput, 'sessionId' | 'relation'>[]>) {
  const byId = new Map(memories.map(memory => [memory.id, (sourceRefs?.get(memory.id) ?? []).map(ref => ref.sessionId).filter(isReadingOrganizationSource)]));
  const missing = memories.filter(memory => !sourceRefs?.has(memory.id)).map(memory => memory.id);
  if (missing.length) {
    const rows = await database.getAllAsync<{ memory_id: string; session_id: string }>(
      `SELECT memory_id,session_id FROM memory_source_refs WHERE memory_id IN (SELECT value FROM json_each(?))
       AND session_id LIKE 'reading-auto-v1:%'`, JSON.stringify(missing));
    for (const row of rows) byId.get(row.memory_id)!.push(row.session_id);
  }
  const sessions = new Map<string, boolean>();
  for (const session of new Set([...byId.values()].flat())) sessions.set(session, !!(await loadReadingOrganizationSource(session)));
  return new Set(memories.filter(memory => byId.get(memory.id)!.every(session => sessions.get(session))).map(memory => memory.id));
}

/** Keep unrelated provenance while replacing only the same reading original's old version. */
export function replaceReadingOrganizationSourceRefs(previous: readonly MemorySourceRefInput[],
  next: readonly MemorySourceRefInput[], bindings: readonly ReadingOrganizationBinding[]) {
  const keys = new Set(bindings.map(readingOrganizationSourceKey));
  const retained = previous.filter(ref => {
    const identity = parseReadingOrganizationSource(ref.sessionId);
    if (identity) return !keys.has(readingOrganizationSourceKey(identity));
    const manual = ref.sessionId.startsWith('reading-v2:') ? parseReadingMemorySourceIdentity(ref.sessionId) : null;
    return !manual || !bindings.some(binding => binding.bookId === manual.bookId && binding.kind === manual.kind
      && binding.resultId === manual.resultId && binding.chapterIndex === manual.chapterIndex && binding.version === manual.version);
  });
  return [...new Map([...retained, ...next].map(ref =>
    [JSON.stringify([ref.sessionId, ref.messageId, ref.relation ?? 'direct']), ref])).values()];
}
