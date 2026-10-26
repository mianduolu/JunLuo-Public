import type { ReadingBook } from './readingTypes';

/** A saved message attachment, not proof of reading or a copied content store. */
export type ReadingReference = {
  readingId: string;
  contentType: 'book' | 'programme';
  title: string;
};

export function isReadingReference(value: unknown): value is ReadingReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => ['readingId', 'contentType', 'title'].includes(key))
    && typeof item.readingId === 'string' && item.readingId.trim().length > 0
    && (item.contentType === 'book' || item.contentType === 'programme')
    && typeof item.title === 'string' && item.title.trim().length > 0;
}

export function referenceFromBook(book: ReadingBook): ReadingReference {
  return { readingId: book.id, contentType: book.contentType === 'programme' ? 'programme' : 'book', title: book.title };
}

export function formatReadingReference(reference?: ReadingReference): string {
  if (!isReadingReference(reference)) return '';
  return ['【you 带进聊天的作品】',
    `类型：${reference.contentType === 'programme' ? '节目' : '书籍'}`,
    `标题：${reference.title}`,
    `作品编号：${reference.readingId}`].join('\n');
}
