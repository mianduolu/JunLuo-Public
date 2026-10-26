import type { NotebookEntryDraft } from '../chat/notebookStore';
import type { MemoryDraft } from '../memory/memoryStore';
import type { ReadingResultItem } from './readingResults';
import type { ReadingBook } from './readingTypes';

const MAX_CONTENT = 420;
const MAX_EXCERPT = 180;

function compact(value: string | undefined, maxLength: number) {
  const text = (value ?? '').trim().replace(/\s+/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function uniqueTexts(values: Array<string | undefined>, limit: number) {
  return Array.from(new Set(values.map((value) => compact(value, 32)).filter(Boolean))).slice(0, limit);
}

export function getReadingResultSource(book: Pick<ReadingBook, 'id'>, item: ReadingResultItem) {
  return `reading:${book.id}:${item.id}`;
}

export function buildReadingResultNotebookDraft(book: ReadingBook, item: ReadingResultItem): NotebookEntryDraft {
  const title = `《${compact(book.title, 28)}》共读：${compact(item.chapterTitle, 18)}`;
  const lines = [
    `${item.title} · ${item.positionLabel}`,
    item.sourceExcerpt ? `原文：${compact(item.sourceExcerpt, MAX_EXCERPT)}` : '',
    item.note?.question ? `you 问：\n${compact(item.note.question, 120)}` : '',
    item.text ? `${item.kind === 'my-note' ? 'you' : 'I'} 写下：\n${compact(item.text, MAX_CONTENT)}` : '',
  ].filter(Boolean);

  return {
    title,
    content: lines.join('\n'),
    keywords: uniqueTexts(['共读', book.title, item.chapterTitle], 8),
    sourceExcerpt: compact(item.sourceExcerpt, MAX_EXCERPT) || undefined,
    sourceId: getReadingResultSource(book, item),
    sourceType: 'interaction',
  };
}

export function buildReadingResultMemoryDraft(book: ReadingBook, item: ReadingResultItem): MemoryDraft {
  const sourceExcerpt = item.sourceExcerpt;
  const resultText = item.text;
  const questionText = item.note?.question;
  const resultLabel = item.kind === 'question' ? 'I 的回答' : item.kind === 'my-note' ? 'you 的笔记'
    : item.kind === 'annotation' ? 'I 的批注' : 'I 的读后感';
  const content = [
    [`《${book.title}》`, item.chapterTitle, item.positionLabel].filter(Boolean).join(' · '),
    sourceExcerpt ? `书中文字：\n${sourceExcerpt}` : '',
    questionText ? `you 的问题：\n${questionText}` : '',
    resultText ? `${resultLabel}：\n${resultText}` : '',
  ].filter(Boolean).join('\n\n');

  return {
    title: `《${book.title}》 · ${item.title}`,
    content,
    domain: '经历',
    tags: uniqueTexts(['共读', book.title, item.chapterTitle, item.kind === 'question' ? '问白云' : item.title], 8),
    recallCues: uniqueTexts([book.title, item.chapterTitle, item.positionLabel, sourceExcerpt, '共读'], 8),
    importance: 6,
    valence: 0.68,
    arousal: 0.32,
    pinned: false,
    anchor: false,
    type: 'dynamic',
    resolved: false,
    digested: false,
    protected: false,
    eventAt: item.createdAt,
    source: getReadingResultSource(book, item),
    sourceType: 'manual',
    rememberedReason: 'you 选择留下这段阅读。',
  };
}
