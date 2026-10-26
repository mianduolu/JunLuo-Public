import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { selectedReadingBlocks } from './readingContent';
import { readingSegmentSourceVersion } from './readingDailyPolicy';
import type { ReadingResultItem, ReadingResultKind } from './readingResults';
import { readingSourceParagraph } from './readingSourceAnchor';
import { loadReadingAnnotations, loadReadingChapter, loadReadingLibraryStrict, loadReadingNotes } from './readingStore';
import type { ReadingAnnotation, ReadingBook, ReadingChapter, ReadingNote, ReadingSegmentSummary } from './readingTypes';

export type ReadingMemoryBinding = {
  bookId: string;
  resultId: string;
  kind: ReadingResultKind;
  chapterIndex: number;
  version: string;
};

export type ReadingMemorySourceSnapshot = {
  binding: ReadingMemoryBinding;
  book: ReadingBook;
  item: ReadingResultItem;
  bookText: string;
  sourceVersion: string;
  messages: SubjectiveMessage[];
};

export type ReadingMemorySourceInfo = {
  bookTitle: string;
  chapterTitle: string;
  positionLabel: string;
  bookText: string;
  version: string;
};

type ReadingMemoryMessage = SubjectiveMessage & { readingMemorySourceInfo: ReadingMemorySourceInfo };
type Locator = Omit<ReadingMemoryBinding, 'version'>;
const SOURCE_PREFIX = 'reading-v2:';
const LEGACY_SOURCE_PREFIX = 'reading-source:';

export type ReadingMemorySourceIdentity = ReadingMemoryBinding & { legacy: boolean };

function validLocator(value: Locator) {
  return typeof value?.bookId === 'string' && !!value.bookId
    && typeof value.resultId === 'string' && !!value.resultId
    && ['summary', 'annotation', 'my-note', 'question'].includes(value.kind)
    && Number.isSafeInteger(value.chapterIndex) && value.chapterIndex >= 0;
}

function recordVersion(locator: Locator, record: ReadingAnnotation | ReadingSegmentSummary | ReadingNote) {
  const anchor = record.sourceAnchor;
  const common = [locator.bookId, locator.kind, locator.resultId, locator.chapterIndex, record.createdAt,
    anchor ? [anchor.revision, anchor.originalChapterTitle, anchor.p, anchor.endP] : null];
  const data = 'selectedText' in record
    ? [record.kind, record.startP, record.endP, record.selectedText, record.note, record.question, record.answer]
    : [record.segmentIndex, record.updatedAt, record.sourceVersion, record.resultOperationId,
      ...('text' in record ? [record.p, record.type, record.text] : [record.summary])];
  return stableMemoryHash(JSON.stringify([...common, data]));
}

function resultBookText(chapter: ReadingChapter | null, record: ReadingAnnotation | ReadingSegmentSummary) {
  if (!chapter) return '';
  if (record.sourceAnchor) {
    const p = readingSourceParagraph(chapter, record, 'p' in record ? record.p : record.segmentIndex);
    const endP = record.sourceAnchor.endP ?? p;
    return p !== undefined && endP !== undefined && chapter.paragraphs[endP] !== undefined
      ? chapter.paragraphs.slice(p, endP + 1).join('\n') : '';
  }
  const segment = chapter.segmentsMeta.find(item => item.segmentIndex === record.segmentIndex);
  if (!segment || !record.sourceVersion || record.sourceVersion !== readingSegmentSourceVersion(chapter, segment)) return '';
  if (segment.contentRange && chapter.contentBlocks) {
    return selectedReadingBlocks(chapter, segment)
      .filter(item => item.block.kind === 'text' && (!('p' in record) || item.block.paragraphIndex === record.p))
      .map(item => item.text).join('\n');
  }
  return 'p' in record
    ? (record.p >= segment.startP && record.p <= segment.endP ? chapter.paragraphs[record.p] ?? '' : '')
    : chapter.paragraphs.slice(segment.startP, segment.endP + 1).join('\n');
}

function buildSnapshot(book: ReadingBook, chapter: ReadingChapter | null, locator: Locator,
  record: ReadingAnnotation | ReadingSegmentSummary | ReadingNote): ReadingMemorySourceSnapshot {
  const isNote = 'selectedText' in record;
  const startP = isNote ? record.startP : 'p' in record ? record.p
    : chapter?.segmentsMeta.find(item => item.segmentIndex === record.segmentIndex)?.endP ?? record.segmentIndex;
  const chapterTitle = record.sourceAnchor?.originalChapterTitle ?? chapter?.title ?? '';
  const bookText = isNote ? record.selectedText : resultBookText(chapter, record);
  // Historical anchors may point somewhere other than the record's original P.
  // Keep their confirmed text, without presenting an old coordinate as current.
  const positionLabel = record.sourceAnchor ? ''
    : isNote ? (record.endP > record.startP ? `P${record.startP}-P${record.endP}` : `P${record.startP}`)
    : !bookText ? '' : 'p' in record ? `P${record.p}` : `第 ${record.segmentIndex + 1} 段`;
  const item: ReadingResultItem = {
    id: locator.resultId, kind: locator.kind, chapterIndex: locator.chapterIndex, chapterTitle,
    createdAt: record.createdAt, positionLabel, sortP: startP, sourceExcerpt: bookText,
    sourceAvailable: !!bookText, historicalSource: !!record.sourceAnchor,
    title: isNote ? record.kind === 'my-note' ? '我的笔记' : '问白云' : 'p' in record ? '白云批注' : '白云读后感',
    text: isNote ? record.kind === 'my-note' ? record.note ?? '' : record.answer ?? ''
      : 'p' in record ? record.text : record.summary,
    ...(isNote ? { note: record } : 'p' in record ? { annotation: record } : { summary: record }),
  };
  const sourceVersion = recordVersion(locator, record);
  const version = stableMemoryHash(JSON.stringify([sourceVersion, book.title, chapterTitle, positionLabel, bookText]));
  const info: ReadingMemorySourceInfo = { bookTitle: book.title, chapterTitle, positionLabel, bookText, version };
  const messages: ReadingMemoryMessage[] = [];
  const add = (id: string, role: 'I' | 'you', content: string | undefined) => {
    if (content?.trim()) messages.push({ id, role, content, createdAt: record.createdAt, readingMemorySourceInfo: info });
  };
  if (isNote) {
    if (record.kind === 'my-note') add('note', 'you', record.note);
    else { add('question', 'you', record.question); add('answer', 'I', record.answer); }
  } else if ('p' in record) add('annotation', 'I', record.text);
  else add('summary', 'I', record.summary);
  return { binding: { ...locator, version }, book, item, bookText, sourceVersion, messages };
}

/** Strict reads distinguish an absent source from storage/normalization failure. */
export async function loadReadingMemorySource(locator: Locator): Promise<ReadingMemorySourceSnapshot | null> {
  if (!validLocator(locator)) return null;
  const book = (await loadReadingLibraryStrict()).find(item => item.id === locator.bookId);
  if (!book) return null;
  const chapterPromise = loadReadingChapter(locator.bookId, locator.chapterIndex, true);
  if (locator.kind === 'my-note' || locator.kind === 'question') {
    const [chapter, notes] = await Promise.all([chapterPromise, loadReadingNotes(locator.bookId, true)]);
    const note = notes.find(item => item.id === locator.resultId && item.kind === locator.kind
      && item.bookId === locator.bookId && item.chapterIndex === locator.chapterIndex);
    return note ? buildSnapshot(book, chapter, locator, note) : null;
  }
  const [chapter, results] = await Promise.all([chapterPromise, loadReadingAnnotations(locator.bookId, locator.chapterIndex, true)]);
  const record = locator.kind === 'annotation'
    ? results.annotations.find(item => item.id === locator.resultId && item.bookId === locator.bookId
      && item.chapterIndex === locator.chapterIndex)
    : results.summaries.find(item => `summary-${item.chapterIndex}-${item.segmentIndex}` === locator.resultId
      && item.bookId === locator.bookId && item.chapterIndex === locator.chapterIndex);
  return record ? buildSnapshot(book, chapter, locator, record) : null;
}

export async function validateReadingMemoryBinding(binding: ReadingMemoryBinding): Promise<boolean> {
  const current = await loadReadingMemorySource(binding);
  return !!current && current.binding.version === binding.version;
}

export function readingMemorySourceSession(snapshot: ReadingMemorySourceSnapshot): string {
  const { bookId, kind, resultId, chapterIndex } = snapshot.binding;
  return SOURCE_PREFIX + encodeURIComponent(JSON.stringify([bookId, kind, resultId, chapterIndex, snapshot.binding.version]));
}

export function isReadingMemorySource(sessionId: string): boolean {
  return typeof sessionId === 'string' && (sessionId.startsWith(SOURCE_PREFIX) || sessionId.startsWith(LEGACY_SOURCE_PREFIX) || sessionId.startsWith('reading-auto-v1:'));
}

export function parseReadingMemorySourceIdentity(sessionId: string): ReadingMemorySourceIdentity | null {
  if (!isReadingMemorySource(sessionId)) return null;
  const legacy = sessionId.startsWith(LEGACY_SOURCE_PREFIX);
  const automatic = sessionId.startsWith('reading-auto-v1:');
  const prefix = automatic ? 'reading-auto-v1:' : legacy ? LEGACY_SOURCE_PREFIX : SOURCE_PREFIX;
  let data: unknown;
  try { data = JSON.parse(decodeURIComponent(sessionId.slice(prefix.length))); } catch { return null; }
  if (!Array.isArray(data) || data.length !== (automatic ? 6 : 5) || typeof data[4] !== 'string' || !data[4]
    || automatic && (typeof data[5] !== 'string' || !data[5] || !['annotation', 'summary'].includes(data[1]))) return null;
  const [bookId, kind, resultId, chapterIndex, version] = data;
  const locator = { bookId, kind, resultId, chapterIndex } as Locator;
  if (!validLocator(locator)) return null;
  return { ...locator, version, legacy };
}

export function readingMemoryOccurrenceKey(sessionId: string): string | null {
  if (sessionId.startsWith('reading-auto-v1:')) {
    try {
      const value = JSON.parse(decodeURIComponent(sessionId.slice('reading-auto-v1:'.length)));
      return Array.isArray(value) && value.length === 6 && typeof value[5] === 'string' && value[5]
        ? JSON.stringify(['reading-activity', value[0], value[5]]) : null;
    } catch { return null; }
  }
  const identity = parseReadingMemorySourceIdentity(sessionId);
  return identity ? JSON.stringify([identity.bookId, identity.kind, identity.resultId, identity.chapterIndex]) : null;
}

async function loadSession(sessionId: string) {
  if (sessionId.startsWith('reading-auto-v1:')) {
    const source = await (await import('./readingMemoryOrganizationSource')).loadReadingOrganizationSource(sessionId);
    return source ? { ...source.snapshot, messages: [source.message] } : null;
  }
  const identity = parseReadingMemorySourceIdentity(sessionId);
  if (!identity) return null;
  const snapshot = await loadReadingMemorySource(identity);
  const version = identity.legacy ? snapshot?.sourceVersion : snapshot?.binding.version;
  return version === identity.version ? snapshot : null;
}

export async function loadReadingMemoryMessage(sessionId: string, messageId: string): Promise<SubjectiveMessage | null> {
  return (await loadSession(sessionId))?.messages.find(item => item.id === messageId) ?? null;
}

export async function loadReadingMemoryMessages(sessionId: string): Promise<SubjectiveMessage[]> {
  return (await loadSession(sessionId))?.messages ?? [];
}

export function getReadingMemorySourceInfo(message: SubjectiveMessage): ReadingMemorySourceInfo | undefined {
  return (message as Partial<ReadingMemoryMessage>).readingMemorySourceInfo;
}
