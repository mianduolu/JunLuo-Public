import { loadReadingResultActions, type ReadingResultActionMap } from './readingResultActions';
import { readingSourceParagraph } from './readingSourceAnchor';
import { loadReadingAnnotations, loadReadingChapter, loadReadingNotes } from './readingStore';
import type {
  ReadingAnnotation,
  ReadingBook,
  ReadingChapter,
  ReadingNote,
  ReadingResultActionMeta,
  ReadingSegmentSummary,
} from './readingTypes';

export type ReadingResultKind = 'summary' | 'annotation' | 'my-note' | 'question';

export type ReadingResultItem = {
  sourceAvailable?: boolean;
  historicalSource?: boolean;
  id: string;
  kind: ReadingResultKind;
  chapterIndex: number;
  chapterTitle: string;
  createdAt: number;
  positionLabel: string;
  sortP: number;
  sourceExcerpt: string;
  title: string;
  text: string;
  annotation?: ReadingAnnotation;
  note?: ReadingNote;
  summary?: ReadingSegmentSummary;
  actions?: ReadingResultActionMeta;
};

export type ReadingResultSection = {
  chapterIndex: number;
  chapterTitle: string;
  summaries: ReadingResultItem[];
  annotations: ReadingResultItem[];
  myNotes: ReadingResultItem[];
  questions: ReadingResultItem[];
};

export type ReadingResultsStats = {
  annotations: number;
  myNotes: number;
  questions: number;
  summaries: number;
};

export type ReadingBookResults = {
  sections: ReadingResultSection[];
  stats: ReadingResultsStats;
};

function truncateExcerpt(value: string, maxLength = 180) {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function getSegmentEndParagraph(chapter: ReadingChapter | null, summary: ReadingSegmentSummary) {
  const segment = chapter?.segmentsMeta.find((item) => item.segmentIndex === summary.segmentIndex);
  return segment?.endP ?? summary.segmentIndex;
}

function getParagraphExcerpt(chapter: ReadingChapter | null, p: number, fallback = '') {
  return truncateExcerpt(chapter?.paragraphs[p] ?? fallback);
}

function withActions(item: ReadingResultItem, actionMap: ReadingResultActionMap, chapter: ReadingChapter | null): ReadingResultItem {
  const record = item.annotation ?? item.note ?? item.summary;
  const anchor = record?.sourceAnchor;
  const p = record ? readingSourceParagraph(chapter, record, item.sortP) : item.sortP;
  return {
    ...item,
    ...(anchor ? { historicalSource: true, sourceAvailable: p !== undefined,
      chapterTitle: anchor.originalChapterTitle, sortP: p ?? item.sortP,
      sourceExcerpt: p === undefined ? item.note?.selectedText ?? '' : getParagraphExcerpt(chapter, p) } : {}),
    actions: actionMap[item.id],
  };
}

export function buildReadingSummaryResultItem(
  chapter: ReadingChapter | null,
  summary: ReadingSegmentSummary,
  actionMap: ReadingResultActionMap = {},
): ReadingResultItem {
  const chapterIndex = summary.chapterIndex;
  const chapterTitle = chapter?.title?.trim() || `第 ${chapterIndex + 1} 章`;
  const p = getSegmentEndParagraph(chapter, summary);
  return withActions({
    id: `summary-${chapterIndex}-${summary.segmentIndex}`,
    kind: 'summary',
    chapterIndex,
    chapterTitle,
    createdAt: summary.createdAt,
    positionLabel: `第 ${summary.segmentIndex + 1} 段`,
    sortP: p,
    sourceExcerpt: getParagraphExcerpt(chapter, p),
    title: '白云读后感',
    text: summary.summary,
    summary,
  }, actionMap, chapter);
}

export function buildReadingAnnotationResultItem(
  chapter: ReadingChapter | null,
  annotation: ReadingAnnotation,
  actionMap: ReadingResultActionMap = {},
): ReadingResultItem {
  const chapterIndex = annotation.chapterIndex;
  const chapterTitle = chapter?.title?.trim() || `第 ${chapterIndex + 1} 章`;
  return withActions({
    id: annotation.id,
    kind: 'annotation',
    chapterIndex,
    chapterTitle,
    createdAt: annotation.createdAt,
    positionLabel: `P${annotation.p}`,
    sortP: annotation.p,
    sourceExcerpt: getParagraphExcerpt(chapter, annotation.p),
    title: '白云批注',
    text: annotation.text,
    annotation,
  }, actionMap, chapter);
}

function sortResultItems(left: ReadingResultItem, right: ReadingResultItem) {
  return left.sortP - right.sortP || left.createdAt - right.createdAt || left.id.localeCompare(right.id);
}

function hasSectionContent(section: ReadingResultSection) {
  return section.summaries.length || section.annotations.length || section.myNotes.length || section.questions.length;
}

export async function loadReadingBookResults(book: ReadingBook): Promise<ReadingBookResults> {
  const [notes, actionMap] = await Promise.all([
    loadReadingNotes(book.id),
    loadReadingResultActions(book.id),
  ]);
  const sections: ReadingResultSection[] = [];
  const stats: ReadingResultsStats = {
    annotations: 0,
    myNotes: 0,
    questions: 0,
    summaries: 0,
  };

  for (let chapterIndex = 0; chapterIndex < book.totalChapters; chapterIndex += 1) {
    const [chapter, chapterAnnotations] = await Promise.all([
      loadReadingChapter(book.id, chapterIndex),
      loadReadingAnnotations(book.id, chapterIndex),
    ]);
    const chapterTitle = chapter?.title?.trim() || `第 ${chapterIndex + 1} 章`;
    const chapterNotes = notes.filter((note) => note.chapterIndex === chapterIndex);
    const section: ReadingResultSection = {
      chapterIndex,
      chapterTitle,
      summaries: chapterAnnotations.summaries
        .map((summary) => buildReadingSummaryResultItem(chapter, summary, actionMap))
        .sort(sortResultItems),
      annotations: chapterAnnotations.annotations
        .map((annotation) => buildReadingAnnotationResultItem(chapter, annotation, actionMap))
        .sort(sortResultItems),
      myNotes: chapterNotes
        .filter((note) => note.kind === 'my-note')
        .map((note) => withActions({
          id: note.id,
          kind: 'my-note',
          chapterIndex,
          chapterTitle,
          createdAt: note.createdAt,
          positionLabel: note.endP > note.startP ? `P${note.startP}-P${note.endP}` : `P${note.startP}`,
          sortP: note.startP,
          sourceExcerpt: getParagraphExcerpt(chapter, note.startP, note.selectedText),
          title: '我的笔记',
          text: note.note ?? '',
          note,
        }, actionMap, chapter))
        .sort(sortResultItems),
      questions: chapterNotes
        .filter((note) => note.kind === 'question')
        .map((note) => withActions({
          id: note.id,
          kind: 'question',
          chapterIndex,
          chapterTitle,
          createdAt: note.createdAt,
          positionLabel: note.endP > note.startP ? `P${note.startP}-P${note.endP}` : `P${note.startP}`,
          sortP: note.startP,
          sourceExcerpt: getParagraphExcerpt(chapter, note.startP, note.selectedText),
          title: '问白云',
          text: note.answer ?? '',
          note,
        }, actionMap, chapter))
        .sort(sortResultItems),
    };

    stats.summaries += section.summaries.length;
    stats.annotations += section.annotations.length;
    stats.myNotes += section.myNotes.length;
    stats.questions += section.questions.length;
    if (hasSectionContent(section)) sections.push(section);
  }

  return { sections, stats };
}
