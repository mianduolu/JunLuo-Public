import { loadPendingOwnScheduleItems, loadScheduleItemById, schedulePlanVersion, type ScheduleItem } from '../schedule/scheduleStore';
import { loadReadingLibraryStrict, loadReadingChapter, loadReadingAnnotations } from '../reading/readingStore';
import { readingSegmentSourceVersion } from '../reading/readingDailyPolicy';
import { formatNearStatusReadingResult, formatNearStatusRecordedAt } from '../ai/nearStatusLifeMaterialFormat';
import type { ReadingBook, ReadingChapter, ReadingChapterAnnotations, ReadingSegmentMeta } from '../reading/readingTypes';
import type { ContactMaterialEntry } from './unifiedContactMaterials';

const PREFIX = 'contact-own:';
type Source = ['state' | 'plan', string] | ['result', string, number, number]
  | ['failure', string, number, number, string] | ['preparation', string, string];
// Opaque persisted identity, not a URL. Operation/activity identity belongs to the
// version; retaining it again here inflated legitimate source references.
const sourceId = (source: Source) => PREFIX + JSON.stringify(source);
const validAt = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
function version(value: unknown) {
  const text = JSON.stringify(value); let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
export function isContactOwnLifeId(id: string) { return id.startsWith(PREFIX); }

function active(item: ScheduleItem) {
  return item.owner === 'I' && item.status === 'pending' && !!item.execution?.activityId
    && validAt(item.execution.startedAt) && ['running', 'paused'].includes(item.execution.status)
    && !item.execution.adjustment?.pending;
}
function unstarted(item: ScheduleItem) {
  return item.owner === 'I' && item.status === 'pending'
    && (!item.execution || item.execution.status === 'planned' && item.execution.startedAt === undefined);
}
function scheduleEntry(item: ScheduleItem, kind: 'state' | 'plan'): ContactMaterialEntry | null {
  if (!(kind === 'state' ? active(item) : unstarted(item)) || !item.title.trim()) return null;
  if (kind === 'plan' && (!validAt(item.startAt) || !validAt(item.endAt) || item.endAt <= item.startAt)) return null;
  const execution = item.execution;
  const line = kind === 'state'
    ? `此刻正在做：${item.title}（${execution?.status === 'paused' ? '已暂停' : '进行中'}）`
    : `接下来计划：${item.title}，${formatNearStatusRecordedAt(item.startAt)}—${formatNearStatusRecordedAt(item.endAt!)}`;
  return { id: sourceId([kind, item.id]), version: version([schedulePlanVersion(item), execution?.activityId,
    execution?.status, execution?.startedAt, execution?.endedAt, execution?.readingChoice]), own: kind,
    occurredAt: kind === 'state' ? execution!.startedAt : item.startAt, sameSource: `schedule:${item.id}`,
    text: `【I 自己的安排】\n${line}\n未开始的只是计划，不算已经做过。` };
}

function notice(source: Source, book: ReadingBook, at: number | undefined, status: string, evidence: unknown): ContactMaterialEntry | null {
  if (!validAt(at)) return null;
  return { id: sourceId(source), version: version([book.title, evidence, status, at]), own: 'experience', occurredAt: at,
    sameSource: sourceId(source), text: `【I 最近的阅读情况】\n作品：${book.title}\n记录时间：${formatNearStatusRecordedAt(at)}\n${status}` };
}
function preparationEntry(book: ReadingBook, item: ScheduleItem): ContactMaterialEntry | null {
  if (item.owner !== 'I' || item.status !== 'pending' || book.programme?.preparation !== 'failed') return null;
  if (item.readingId !== book.id && !('version' in (item.execution?.readingChoice ?? {})
    && (item.execution!.readingChoice as { currentReadingId: string | null }).currentReadingId === book.id)) return null;
  const entry = notice(['preparation', book.id, item.id], book, book.programme.attemptedAt,
    '阅读材料暂时没备好', [book.programme.preparation, book.programme.sourceVersion, book.programme.attemptedAt,
      book.programme.errorCode, schedulePlanVersion(item)]);
  return entry ? { ...entry, sameSource: `reading-preparation:${book.id}` } : null;
}

function segmentEntries(book: ReadingBook, chapter: ReadingChapter, notes: ReadingChapterAnnotations,
  segment: ReadingSegmentMeta, currentIds: Set<string>, ownActivities: Map<string, string>): ContactMaterialEntry[] {
  const request = segment.request, sourceVersion = readingSegmentSourceVersion(chapter, segment);
  if (segment.sourceVersion && segment.sourceVersion !== sourceVersion || request && request.sourceVersion !== sourceVersion) return [];
  const operationId = segment.resultOperationId ?? request?.id;
  const activityId = segment.resultActivityId ?? request?.resultActivityId;
  const notesMatch = (note: { bookId: string; chapterIndex: number; segmentIndex: number; sourceVersion?: string; resultOperationId?: string; sourceAnchor?: { revision: string } }) =>
    note.bookId === book.id && note.chapterIndex === chapter.index && note.segmentIndex === segment.segmentIndex
    && (!note.sourceVersion || note.sourceVersion === sourceVersion)
    && (!note.sourceAnchor || note.sourceAnchor.revision === chapter.sourceRevision)
    && (!operationId || note.resultOperationId === operationId);
  const summaries = notes.summaries.filter(note => notesMatch(note) && note.summary.trim() && validAt(note.createdAt));
  const annotations = notes.annotations.filter(note => notesMatch(note) && note.text.trim() && validAt(note.createdAt));
  const done = segment.status === 'done' && (!request?.save || request.save.outcome === 'complete');
  if (done) {
    const summary = summaries.sort((a, b) => b.createdAt - a.createdAt)[0];
    // Legacy records have no operation identity; do not combine different saved batches.
    const latest = annotations.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))[0];
    const group = latest ? annotations.filter(note =>
      (note.resultOperationId ?? note.createdAt) === (latest.resultOperationId ?? latest.createdAt)
      && note.sourceVersion === latest.sourceVersion).sort((a, b) => a.p - b.p || a.id.localeCompare(b.id)) : [];
    if (!summary && !group.length) return [];
    const at = summary?.createdAt ?? Math.max(...group.map(note => note.createdAt));
    const op = operationId ?? summary?.resultOperationId ?? latest?.resultOperationId ?? `legacy:${at}`;
    const id = sourceId(['result', book.id, chapter.index, segment.segmentIndex]);
    const text = summary?.summary ?? group.map(note => note.text).join('\n\n');
    const fingerprint = version([book.title, sourceVersion, op, activityId, summary ?? group]);
    return [{ id, version: fingerprint, own: activityId && currentIds.has(activityId) ? 'progress' : 'experience', occurredAt: at,
      sameSource: `reading:${book.id}:${chapter.index}:${segment.segmentIndex}`,
      text: formatNearStatusReadingResult({ id, bookId: book.id, chapterIndex: chapter.index, title: book.title,
        kind: summary ? 'summary' : 'annotation', occurredAt: at, text, dayAge: 0, expiresAt: 0, fingerprintKey: fingerprint }) }];
  }
  // A request failure is I's activity only with a real activity binding, not a you note or a guessed book title.
  if (!operationId || !activityId || !ownActivities.has(activityId)) return [];
  const save = request?.save;
  const status = save?.outcome === 'unknown' ? '保存状态暂时无法确认'
    : save && (save.attempts >= 4 || save.outcome === 'exhausted') ? '自动补存已停止'
      : request?.result ? '阅读结果已保留，保存尚未完成'
        : save?.resultRetained || save?.attempts ? '保存状态暂时无法确认'
          : segment.status === 'failed' || segment.errorMessage === 'reading-request-failed' ? '这段暂时没读成' : null;
  if (!status) return [];
  const at = request?.result?.savedAt ?? request?.startedAt;
  const entry = notice(['failure', book.id, chapter.index, segment.segmentIndex, ownActivities.get(activityId)!], book, at, status,
    [sourceVersion, operationId, activityId, segment.status, segment.errorMessage, request?.result, save]);
  return entry ? [entry] : [];
}

function activitySets(items: ScheduleItem[], books: ReadingBook[]) {
  const current = new Set<string>(), own = new Map<string, string>();
  for (const item of items) {
    if (item.owner !== 'I') continue;
    if (item.execution?.activityId) { own.set(item.execution.activityId, item.id); if (active(item)) current.add(item.execution.activityId); }
    if (item.execution?.completionId) own.set(item.execution.completionId, item.id);
    for (const book of books) {
      const activity = book.iReading?.activity;
      if (activity?.schedule?.itemId !== item.id) continue;
      own.set(activity.id, item.id);
      if (activity.schedule.previousActivityId) own.set(activity.schedule.previousActivityId, item.id);
      if (active(item) && item.execution?.activityId === activity.id) current.add(activity.id);
    }
  }
  return { current, own };
}

/** Only saved sources: no materialization, clock settlement, reading preparation or model work. */
export async function prepareContactOwnLife(now: number): Promise<ContactMaterialEntry[]> {
  // Initial selection may omit an unavailable source, but cannot turn it into a failure fact.
  // Revalidation below deliberately keeps strict reads for sources already handed to the model.
  const items = await loadPendingOwnScheduleItems().catch(() => [] as ScheduleItem[]);
  const books = await loadReadingLibraryStrict().catch(() => [] as ReadingBook[]);
  const { current, own } = activitySets(items, books);
  const entries: ContactMaterialEntry[] = [];
  const currentItem = items.filter(active).sort((a, b) => (b.execution!.startedAt ?? 0) - (a.execution!.startedAt ?? 0))[0];
  const nextItem = items.filter(item => unstarted(item) && item.startAt >= now)
    .sort((a, b) => a.startAt - b.startAt || a.id.localeCompare(b.id))[0];
  for (const [item, kind] of [[currentItem, 'state'], [nextItem, 'plan']] as const) {
    const entry = item && scheduleEntry(item, kind); if (entry) entries.push(entry);
  }
  for (const book of books) {
    for (const item of items) { const entry = preparationEntry(book, item); if (entry) entries.push(entry); }
    for (let index = 0; index < book.totalChapters; index++) {
      try {
        const chapter = await loadReadingChapter(book.id, index, true);
        if (!chapter) continue;
        const notes = await loadReadingAnnotations(book.id, index, true);
        for (const segment of chapter.segmentsMeta) entries.push(...segmentEntries(book, chapter, notes, segment, current, own));
      } catch { /* This chapter is unavailable; already verified schedule/other chapter facts remain usable. */ }
    }
  }
  return entries.filter(entry => !entry.occurredAt || entry.occurredAt <= now || entry.own === 'plan');
}

/** Re-read the referenced source itself. A newly selected latest item must never substitute for it. */
export async function loadContactOwnLife(ref: { id: string; version: string }): Promise<ContactMaterialEntry | null> {
  if (!isContactOwnLifeId(ref.id)) return null;
  let source: Source;
  try { source = JSON.parse(ref.id.slice(PREFIX.length)); } catch { return null; }
  if (!Array.isArray(source) || typeof source[1] !== 'string') return null;
  if (source[0] === 'state' || source[0] === 'plan') {
    const item = await loadScheduleItemById(source[1]);
    return item ? scheduleEntry(item, source[0]) : null;
  }
  const books = await loadReadingLibraryStrict();
  const book = books.find(item => item.id === source[1]); if (!book) return null;
  if (source[0] === 'preparation') {
    const item = await loadScheduleItemById(source[2]); return item ? preparationEntry(book, item) : null;
  }
  if (!['result', 'failure'].includes(source[0]) || !Number.isInteger(source[2]) || !Number.isInteger(source[3])) return null;
  const chapter = await loadReadingChapter(book.id, source[2] as number, true); if (!chapter) return null;
  const segment = chapter.segmentsMeta.find(item => item.segmentIndex === source[3]); if (!segment) return null;
  const notes = await loadReadingAnnotations(book.id, chapter.index, true);
  // The host fixed this binding when selecting the source. The book may now be in
  // a later activity, which must not replace the original failure's ownership.
  const itemId = source[0] === 'failure' ? source[4] : book.iReading?.activity?.schedule?.itemId;
  const item = itemId ? await loadScheduleItemById(itemId) : null;
  const { current, own } = activitySets(item ? [item] : [], books);
  if (source[0] === 'failure') {
    const activityId = segment.resultActivityId ?? segment.request?.resultActivityId;
    if (item?.owner !== 'I' || !activityId) return null;
    own.set(activityId, item.id);
  }
  // A later operation on this same segment cannot stand in for the original
  // result/failure. The version includes original operation and activity identity.
  return segmentEntries(book, chapter, notes, segment, current, own)
    .find(entry => entry.id === ref.id && entry.version === ref.version) ?? null;
}
