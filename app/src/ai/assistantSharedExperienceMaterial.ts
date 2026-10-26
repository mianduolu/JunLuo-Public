import type { FocusLogEntry, FocusSession } from '../focus/focusStore';
import type { TheaterCoCreationSelection } from '../theater/theaterCoCreationMaterial';
import type { ReadingAnnotation, ReadingNote, ReadingSegmentSummary } from '../reading/readingTypes';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { innerMaterialKey } from '../chat/chatAfterglowState';
import { selectCrossPageCandidates, loadCrossPageSources, rebuildCrossPageCandidate, isCrossPageExperience,
  type CrossPageSource, type CrossPageDocument } from './assistantCrossPageExperience';

export type SharedExperienceRef = {
  kind: 'focus-log' | 'focus-end' | 'reading-summary' | 'reading-annotation' | 'reading-question' | 'post-exchange' | 'call-round' | 'letter-exchange' | 'theater-unit' | 'gift-event';
  id: string;
  createdAt: number;
  revision: string;
  ownerId: string;
};

export type SharedExperienceCandidate = {
  kind: 'focus' | 'reading' | 'post' | 'call' | 'letter' | 'theater' | 'gift';
  ownerId: string;
  refs: SharedExperienceRef[];
  fromAt: number;
  throughAt: number;
  fromElapsedSeconds?: number;
  throughElapsedSeconds?: number;
  focusEnded?: boolean;
  material: string;
  document?: CrossPageDocument;
  chatMessageIds?: string[];
  theaterSelection?: TheaterCoCreationSelection;
};

export type SharedExperienceProgress = {
  activatedAt: number;
  crossPageActivatedAt?: number;
  processed: Record<string, string>;
  theaterSelections?: Record<string, TheaterCoCreationSelection>;
  focus: Record<string, { throughAt: number; throughElapsedSeconds: number }>;
};

export type SharedFocusSnapshot = Pick<FocusSession,
  'id' | 'mode' | 'userActivity' | 'baiyunActivity' | 'startedAt'> & {
  endedAt?: number;
  elapsedSeconds: number;
  logs: Omit<FocusLogEntry, 'sessionId'>[];
};

export type SharedReadingSnapshot = {
  id: string;
  title: string;
  chapterTitles: Record<number, string>;
  summaries: ReadingSegmentSummary[];
  annotations?: ReadingAnnotation[];
  questions: ReadingNote[];
};

export type SharedExperienceSnapshot = {
  focus: SharedFocusSnapshot[];
  reading: SharedReadingSnapshot[];
  crossPages?: CrossPageSource[];
};

export type CandidateReference = Omit<SharedExperienceCandidate, 'material' | 'document'>;
export function sharedExperienceReference(candidate: SharedExperienceCandidate): CandidateReference {
  const { material: _material, document: _document, ...ref } = candidate;
  return ref;
}
const time = formatChatAfterglowMessageTime;
const byTime = <T extends { createdAt: number }>(a: T, b: T) => a.createdAt - b.createdAt;
const meaningful = (text: unknown): text is string => typeof text === 'string' && !!text.trim();
const actualTime = (at: number, now: number) => Number.isFinite(at) && at >= 0 && at <= now;
export const sharedExperienceRefKey = (ref: Pick<SharedExperienceRef, 'kind' | 'id'>) => `${ref.kind}:${ref.id}`;

function focusIdentity(source: SharedFocusSnapshot) {
  return [source.id, source.mode, source.startedAt, source.userActivity, source.baiyunActivity];
}

function focusLogRef(source: SharedFocusSnapshot, log: SharedFocusSnapshot['logs'][number]): SharedExperienceRef {
  return { kind: 'focus-log', id: log.id, ownerId: source.id, createdAt: log.createdAt,
    revision: innerMaterialKey([focusIdentity(source), log.id, log.createdAt, log.role,
      log.trigger, log.content, log.elapsedSeconds]) };
}

function focusEndRef(source: SharedFocusSnapshot): SharedExperienceRef {
  return { kind: 'focus-end', id: source.id, ownerId: source.id, createdAt: source.endedAt!,
    revision: innerMaterialKey([focusIdentity(source), source.endedAt, source.elapsedSeconds]) };
}

function focusVisible(log: SharedFocusSnapshot['logs'][number]) {
  return meaningful(log.content) && (log.role === 'you' && log.trigger === 'user-chat'
    || log.role === 'I' && ['chat-reply', 'timed-log', 'opening'].includes(log.trigger));
}

/** Timed notes and openings are material, never answers to an unanswered you message. */
function focusRounds(logs: SharedFocusSnapshot['logs']) {
  const rounds: SharedFocusSnapshot['logs'][] = [];
  let current: SharedFocusSnapshot['logs'] = [];
  let replied = false;
  for (const log of logs) {
    if (log.role === 'you' && log.trigger === 'user-chat') {
      if (replied) { rounds.push(current); current = []; replied = false; }
      current.push(log);
    } else if (log.role === 'I' && log.trigger === 'chat-reply' && current.length) {
      current.push(log); replied = true;
    }
  }
  if (replied) rounds.push(current);
  return rounds;
}

function durationText(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return total >= 60 ? `${Math.floor(total / 60)}分${total % 60}秒` : `${total}秒`;
}

function formatFocus(source: SharedFocusSnapshot, candidate: CandidateReference) {
  const selected = new Set(candidate.refs.filter(ref => ref.kind === 'focus-log').map(ref => ref.id));
  const records = source.logs.filter(log => selected.has(log.id)).sort(byTime).map(log => ({
    role: log.role, time: time(log.createdAt), kind: log.trigger === 'timed-log' ? '专注小记' : '聊天', content: log.content,
  }));
  return `【这段共同专注】\n\n开始时间：${time(source.startedAt)}\nyou 的事情：${source.userActivity}`
    + `\nI 的事情：${source.baiyunActivity}\n本次读到的时段：${time(candidate.fromAt)} 至 ${time(candidate.throughAt)}`
    + `\n这段实际专注时长：${durationText((candidate.throughElapsedSeconds ?? 0) - (candidate.fromElapsedSeconds ?? 0))}`
    + (candidate.focusEnded ? `\n结束时间：${time(source.endedAt!)}` : '')
    + (records.length ? `\n\n${records.map(record => JSON.stringify(record)).join('\n')}` : '');
}

function selectFocus(source: SharedFocusSnapshot, progress: SharedExperienceProgress, now: number, maxUnits: number) {
  if (source.mode !== 'cowork' || !meaningful(source.baiyunActivity)
    || source.startedAt < progress.activatedAt || !actualTime(source.startedAt, now)
    || !Number.isFinite(source.elapsedSeconds) || source.elapsedSeconds < 0
    || source.endedAt !== undefined && source.endedAt < source.startedAt) return null;
  const cursor = progress.focus[source.id];
  const logs = source.logs.filter(log => focusVisible(log) && actualTime(log.createdAt, now)
    && log.createdAt >= source.startedAt && Number.isFinite(log.elapsedSeconds) && log.elapsedSeconds >= 0
    && log.createdAt >= progress.activatedAt && progress.processed[sharedExperienceRefKey(focusLogRef(source, log))] === undefined)
    .sort(byTime);
  const rounds = focusRounds(logs);
  const ended = source.endedAt !== undefined && actualTime(source.endedAt, now);
  const unseenEnd = ended && progress.processed[sharedExperienceRefKey(focusEndRef(source))] === undefined;
  if (rounds.length < 6 && !unseenEnd) return null;
  const final = !!unseenEnd && rounds.length <= maxUnits;
  const selectedEnd = rounds.slice(0, maxUnits).at(-1)?.at(-1);
  const throughAt = final ? source.endedAt! : selectedEnd?.createdAt;
  if (throughAt === undefined) return null;
  const endIndex = selectedEnd ? logs.findIndex(log => log.id === selectedEnd.id) : -1;
  const selectedLogs = final ? logs : logs.slice(0, endIndex + 1);
  // A start/stop tap is stored as one second by the old completion writer. It is not an experience.
  const realDuration = Math.min(source.elapsedSeconds, Math.floor((throughAt - source.startedAt) / 1000));
  if (!selectedLogs.length && (!final || realDuration <= (cursor?.throughElapsedSeconds ?? 0))) return null;
  const throughElapsedSeconds = final ? Math.max(0, realDuration) : Math.max(cursor?.throughElapsedSeconds ?? 0,
    ...selectedLogs.map(log => log.elapsedSeconds));
  const candidate: SharedExperienceCandidate = {
    kind: 'focus', ownerId: source.id,
    refs: [...selectedLogs.map(log => focusLogRef(source, log)), ...(final ? [focusEndRef(source)] : [])],
    fromAt: cursor?.throughAt ?? source.startedAt, throughAt,
    fromElapsedSeconds: cursor?.throughElapsedSeconds ?? 0, throughElapsedSeconds,
    focusEnded: final, material: '',
  };
  candidate.material = formatFocus(source, candidate);
  return candidate;
}

function summaryRef(source: SharedReadingSnapshot, item: ReadingSegmentSummary): SharedExperienceRef {
  return { kind: 'reading-summary', id: `${source.id}:${item.chapterIndex}:${item.segmentIndex}`,
    ownerId: source.id, createdAt: item.createdAt,
    revision: innerMaterialKey([source.title, source.chapterTitles[item.chapterIndex], item.chapterIndex,
      item.segmentIndex, item.createdAt, item.updatedAt, item.summary]) };
}

function questionRef(source: SharedReadingSnapshot, item: ReadingNote): SharedExperienceRef {
  return { kind: 'reading-question', id: item.id, ownerId: source.id, createdAt: item.createdAt,
    revision: innerMaterialKey([source.title, source.chapterTitles[item.chapterIndex], item.chapterIndex,
      item.createdAt, item.question, item.answer]) };
}

function readingEntries(source: SharedReadingSnapshot) {
  // One segment is one experience, regardless of which saved result represents it.
  const groups = new Map<string, ReadingAnnotation[]>();
  const summarized = new Set(source.summaries.filter(item => item.bookId === source.id && meaningful(item.summary))
    .map(item => `${item.chapterIndex}:${item.segmentIndex}`));
  for (const item of source.annotations ?? []) {
    const key = `${item.chapterIndex}:${item.segmentIndex}`;
    if (item.bookId !== source.id || !meaningful(item.text) || summarized.has(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  const annotations = [...groups].map(([key, records]) => {
    // Sync merges annotation IDs, so older results for the same segment may still coexist.
    const savedResults = new Map<string, ReadingAnnotation[]>();
    for (const item of records) {
      const identity = JSON.stringify([item.resultOperationId ?? item.createdAt, item.sourceVersion]);
      savedResults.set(identity, [...(savedResults.get(identity) ?? []), item]);
    }
    const savedAt = (items: ReadingAnnotation[]) => Math.max(...items.map(item => item.updatedAt ?? item.createdAt));
    const latest = [...savedResults].sort(([a, left], [b, right]) => savedAt(right) - savedAt(left) || a.localeCompare(b))[0][1];
    const items = latest.sort((a, b) => a.p - b.p || a.id.localeCompare(b.id));
    const createdAt = Math.max(...items.map(item => item.createdAt));
    const ref: SharedExperienceRef = { kind: 'reading-annotation', id: `${source.id}:${key}`,
      ownerId: source.id, createdAt,
      revision: innerMaterialKey([source.title, source.chapterTitles[items[0].chapterIndex],
        items.map(item => [item.id, item.chapterIndex, item.segmentIndex, item.p, item.createdAt, item.updatedAt,
          item.sourceVersion, item.resultOperationId, item.text])]) };
    return { ref, chapterIndex: items[0].chapterIndex,
      text: `批注｜记录时间：${time(createdAt)}\n\nI 写的批注：\n${items.map(item => item.text).join('\n\n')}` };
  });
  return [
    ...source.summaries.filter(item => item.bookId === source.id && meaningful(item.summary))
      .map(item => ({ ref: summaryRef(source, item), chapterIndex: item.chapterIndex,
        text: `读后感｜记录时间：${time(item.createdAt)}\n\nI 的读后感：\n${item.summary}` })),
    ...annotations,
    ...source.questions.filter(item => item.bookId === source.id && item.kind === 'question'
      && meaningful(item.question) && meaningful(item.answer))
      .map(item => ({ ref: questionRef(source, item), chapterIndex: item.chapterIndex,
        text: `问答｜记录时间：${time(item.createdAt)}\n\nyou：${item.question}\nI：${item.answer}` })),
  ].sort((a, b) => byTime(a.ref, b.ref) || a.ref.id.localeCompare(b.ref.id));
}

function readingProcessed(progress: SharedExperienceProgress, ref: Pick<SharedExperienceRef, 'kind' | 'id'>) {
  if (progress.processed[sharedExperienceRefKey(ref)] !== undefined) return true;
  const other = ref.kind === 'reading-summary' ? 'reading-annotation'
    : ref.kind === 'reading-annotation' ? 'reading-summary' : undefined;
  return other !== undefined && progress.processed[`${other}:${ref.id}`] !== undefined;
}

function formatReading(source: SharedReadingSnapshot, refs: readonly SharedExperienceRef[]) {
  const selected = new Set(refs.map(sharedExperienceRefKey));
  let previousChapter: number | undefined;
  const entries = readingEntries(source).filter(item => selected.has(sharedExperienceRefKey(item.ref)));
  return `【这段共读】\n\n作品：${source.title}` + entries.map(item => {
    const title = source.chapterTitles[item.chapterIndex];
    const chapter = previousChapter !== item.chapterIndex && meaningful(title) ? `\n章节：${title}` : '';
    previousChapter = item.chapterIndex;
    return `${chapter}\n\n${item.text}`;
  }).join('');
}

export function selectSharedExperienceCandidates(snapshot: SharedExperienceSnapshot,
  progress: SharedExperienceProgress, now: number, maxUnits = 6): SharedExperienceCandidate[] {
  const limit = Math.max(1, Math.min(6, Math.floor(maxUnits)));
  const focus = snapshot.focus.map(source => selectFocus(source, progress, now, limit))
    .filter((item): item is SharedExperienceCandidate => !!item);
  const reading = snapshot.reading.flatMap(source => {
    const refs = readingEntries(source).map(item => item.ref).filter(ref => ref.createdAt > progress.activatedAt
      && actualTime(ref.createdAt, now) && !readingProcessed(progress, ref)).slice(0, limit);
    return refs.length ? [{ kind: 'reading' as const, ownerId: source.id, refs, fromAt: refs[0].createdAt,
      throughAt: refs.at(-1)!.createdAt, material: formatReading(source, refs) }] : [];
  });
  return [...focus, ...reading, ...selectCrossPageCandidates(snapshot.crossPages ?? [], progress, now, limit)]
    .sort((a, b) => a.refs[0].createdAt - b.refs[0].createdAt || a.ownerId.localeCompare(b.ownerId));
}

export function rebuildSharedExperienceCandidate(snapshot: SharedExperienceSnapshot,
  candidate: CandidateReference): SharedExperienceCandidate | null {
  if (candidate.kind === 'theater') return null; // Loaded from the original story DB by the async path below.
  if (!candidate.refs.length || candidate.refs.some(ref => ref.ownerId !== candidate.ownerId)) return null;
  if (isCrossPageExperience(candidate.kind)) return rebuildCrossPageCandidate(snapshot.crossPages ?? [], candidate);
  if (candidate.kind === 'focus') {
    const source = snapshot.focus.find(item => item.id === candidate.ownerId);
    if (!source) return null;
    const current = new Map(source.logs.filter(focusVisible).map(log => {
      const ref = focusLogRef(source, log); return [sharedExperienceRefKey(ref), ref];
    }));
    if (source.endedAt !== undefined) {
      const ref = focusEndRef(source); current.set(sharedExperienceRefKey(ref), ref);
    }
    if (!candidate.refs.every(ref => {
      const actual = current.get(sharedExperienceRefKey(ref));
      return actual?.revision === ref.revision && actual.createdAt === ref.createdAt;
    })) return null;
    return { ...candidate, material: formatFocus(source, candidate) };
  }
  const source = snapshot.reading.find(item => item.id === candidate.ownerId);
  if (!source) return null;
  const current = new Map(readingEntries(source).map(item => [sharedExperienceRefKey(item.ref), item.ref]));
  if (!candidate.refs.every(ref => {
    const actual = current.get(sharedExperienceRefKey(ref));
    return actual?.revision === ref.revision && actual.createdAt === ref.createdAt;
  })) return null;
  return { ...candidate, material: formatReading(source, candidate.refs) };
}

/** Retry only the original source IDs, using their current text; never append a later experience. */
export function rebuildCurrentSharedExperienceCandidate(snapshot: SharedExperienceSnapshot,
  candidate: CandidateReference): SharedExperienceCandidate | null {
  if (candidate.kind === 'theater') return null;
  if (!candidate.refs.length || candidate.refs.some(ref => ref.ownerId !== candidate.ownerId)) return null;
  if (isCrossPageExperience(candidate.kind)) return rebuildCrossPageCandidate(snapshot.crossPages ?? [], candidate, true);
  const inRange = (ref: SharedExperienceRef) => ref.createdAt >= candidate.fromAt && ref.createdAt <= candidate.throughAt;
  if (candidate.kind === 'focus') {
    const source = snapshot.focus.find(item => item.id === candidate.ownerId);
    if (!source || source.mode !== 'cowork' || !meaningful(source.baiyunActivity)) return null;
    const current = new Map(source.logs.filter(focusVisible).map(log => {
      const ref = focusLogRef(source, log); return [sharedExperienceRefKey(ref), ref];
    }));
    if (source.endedAt !== undefined) {
      const ref = focusEndRef(source); current.set(sharedExperienceRefKey(ref), ref);
    }
    const refs = candidate.refs.map(ref => current.get(sharedExperienceRefKey(ref)))
      .filter((ref): ref is SharedExperienceRef => !!ref && inRange(ref));
    if (!refs.length) return null;
    const focusEnded = refs.some(ref => ref.kind === 'focus-end');
    const next = { ...candidate, refs, focusEnded,
      ...(focusEnded ? { throughElapsedSeconds: Math.max(0,
        Math.min(source.elapsedSeconds, Math.floor((source.endedAt! - source.startedAt) / 1000))) } : {}),
    };
    return { ...next, material: formatFocus(source, next) };
  }
  const source = snapshot.reading.find(item => item.id === candidate.ownerId);
  if (!source) return null;
  const current = new Map(readingEntries(source).map(item => [sharedExperienceRefKey(item.ref), item.ref]));
  const refs = candidate.refs.map(ref => current.get(sharedExperienceRefKey(ref)))
    .filter((ref): ref is SharedExperienceRef => !!ref && inRange(ref));
  return refs.length ? { ...candidate, refs, material: formatReading(source, refs) } : null;
}

async function loadFocusSnapshot(ownerId?: string, activatedAt = 0,
  processed: Readonly<Record<string, string>> = {}): Promise<SharedFocusSnapshot[]> {
  const store = await import('../focus/focusStore');
  const { makeFocusSessionId } = await import('../focus/focusIdentity');
  const active = await store.loadActiveFocusSession(true);
  let sessions: FocusSession[];
  if (ownerId) {
    const session = await store.loadFocusSessionById(ownerId);
    sessions = session ? [session] : [];
  } else {
    const database = await (await import('../focus/focusDatabase')).getFocusDatabase();
    const ids = await database.getAllAsync<{ id: string }>(
      'SELECT id FROM focus_sessions WHERE started_at >= ? AND mode = ? ORDER BY started_at ASC, id ASC', activatedAt, 'cowork');
    sessions = (await Promise.all(ids.filter(item => processed[`focus-end:${item.id}`] === undefined)
      .map(item => store.loadFocusSessionById(item.id))))
      .filter((item): item is FocusSession => !!item);
  }
  const result: SharedFocusSnapshot[] = await Promise.all(sessions.map(async session => ({ ...session,
    elapsedSeconds: session.durationSeconds, logs: await store.loadFocusLogs(session.id) })));
  if (active && active.startedAt >= activatedAt && (!ownerId || makeFocusSessionId(active) === ownerId)) {
    const id = makeFocusSessionId(active);
    if (!result.some(item => item.id === id)) result.push({ ...active, id });
  }
  return result;
}

async function loadReadingSnapshot(ownerId?: string, progress?: SharedExperienceProgress): Promise<SharedReadingSnapshot[]> {
  const store = await import('../reading/readingStore');
  const [books, index] = await Promise.all([store.loadReadingLibrary(), store.scanReadingBookKeys()]);
  return Promise.all(books.filter(book => !ownerId || book.id === ownerId).map(async book => {
    const entry = index.find(item => item.bookId === book.id);
    const questions = (await store.loadReadingNotes(book.id)).filter(item => item.kind === 'question'
      && meaningful(item.question) && meaningful(item.answer));
    const results = await Promise.all((entry?.annotationChapterIndexes ?? [])
      .map(chapterIndex => store.loadReadingAnnotations(book.id, chapterIndex)));
    const summaries = results.flatMap(item => item.summaries);
    const annotations = results.flatMap(item => item.annotations ?? []);
    const source = { id: book.id, title: book.title, chapterTitles: {}, summaries, annotations, questions };
    // Titles are only needed for eligible experiences. Do not load every old chapter's original text.
    // Filter complete entries, not individual annotation rows, to match pending-batch reloads.
    const chapterIndexes = [...new Set(readingEntries(source).filter(({ ref }) => !progress
      || ref.createdAt > progress.activatedAt && !readingProcessed(progress, ref)).map(item => item.chapterIndex))];
    const chapters = await Promise.all(chapterIndexes.map(async chapterIndex => ({ chapterIndex,
      chapter: await store.loadReadingChapter(book.id, chapterIndex) })));
    return { id: book.id, title: book.title,
      chapterTitles: Object.fromEntries(chapters.map(item => [item.chapterIndex, item.chapter?.title ?? ''])),
      summaries, annotations, questions };
  }));
}

export async function loadSharedExperienceCandidates(progress: SharedExperienceProgress, now: number, maxUnits = 6) {
  const [focus, reading, crossPages] = await Promise.all([
    loadFocusSnapshot(undefined, progress.activatedAt, progress.processed), loadReadingSnapshot(undefined, progress), loadCrossPageSources(progress),
  ]);
  const theater = await (await import('../theater/theaterCoCreationRuntime')).loadTheaterExperienceCandidates(progress, now);
  return [...selectSharedExperienceCandidates({ focus, reading, crossPages }, progress, now, maxUnits), ...theater]
    .sort((a, b) => a.fromAt - b.fromAt || a.ownerId.localeCompare(b.ownerId));
}

export async function reloadSharedExperienceCandidate(candidate: CandidateReference) {
  if (candidate.kind === 'theater') return (await import('../theater/theaterCoCreationRuntime')).reloadTheaterExperienceCandidate(candidate);
  if (isCrossPageExperience(candidate.kind)) return rebuildCrossPageCandidate(await loadCrossPageSources(undefined, candidate), candidate);
  const snapshot = candidate.kind === 'focus'
    ? { focus: await loadFocusSnapshot(candidate.ownerId), reading: [] }
    : { focus: [], reading: await loadReadingSnapshot(candidate.ownerId) };
  return rebuildSharedExperienceCandidate(snapshot, candidate);
}

export async function reloadCurrentSharedExperienceCandidate(candidate: CandidateReference) {
  if (candidate.kind === 'theater') return (await import('../theater/theaterCoCreationRuntime')).reloadTheaterExperienceCandidate(candidate, true);
  if (isCrossPageExperience(candidate.kind)) return rebuildCrossPageCandidate(await loadCrossPageSources(undefined, candidate), candidate, true);
  const snapshot = candidate.kind === 'focus'
    ? { focus: await loadFocusSnapshot(candidate.ownerId), reading: [] }
    : { focus: [], reading: await loadReadingSnapshot(candidate.ownerId) };
  return rebuildCurrentSharedExperienceCandidate(snapshot, candidate);
}

export async function validateSharedExperienceCandidate(candidate: CandidateReference) {
  return !!await reloadSharedExperienceCandidate(candidate);
}
