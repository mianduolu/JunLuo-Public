/** Local cursor invalidation only; never part of the shared reading protocol. */
export function readingMaterialSource(chapter: {
  title?: string; sourceRevision?: string; htmlContent?: string; textContent?: string;
  paragraphs?: string[]; contentBlocks?: unknown; programmeCues?: unknown;
  images?: Array<{ id: string; contentVersion: string }>;
} | null): string {
  return JSON.stringify(chapter && [chapter.title, chapter.sourceRevision, chapter.htmlContent,
    chapter.textContent, chapter.paragraphs, chapter.contentBlocks, chapter.programmeCues,
    chapter.images?.map(image => [image.id, image.contentVersion])]);
}

export function nextReadingMaterialRevision(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function retainLocalReadingMaterialRevision<T extends { id: string; materialSourceRevision?: string }>(
  books: T[], current: Array<{ id: string; materialSourceRevision?: string }>,
): T[] {
  return books.map(book => {
    const revision = current.find(item => item.id === book.id)?.materialSourceRevision;
    return revision ? { ...book, materialSourceRevision: revision } : book;
  });
}
