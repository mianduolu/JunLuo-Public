import {
  loadReadingAnnotations,
  loadReadingLibrary,
  loadReadingNotes,
  loadReadingSessions,
  scanReadingBookKeys,
} from './readingStore';
import {
  buildReadingLifeMaterialSnapshot,
  type CoReadingResultCandidate,
} from './readingLifeMaterialPolicy';

export async function loadReadingLifeMaterialSnapshot(now = Date.now()) {
  const [books, sessions, keyIndex] = await Promise.all([
    loadReadingLibrary(),
    loadReadingSessions(),
    scanReadingBookKeys(),
  ]);
  const booksById = new Map(books.map((book) => [book.id, book]));
  const resultGroups = await Promise.all(keyIndex.map(async (entry) => {
    if (!booksById.has(entry.bookId)) return [];
    const [annotationGroups, notes] = await Promise.all([
      Promise.all(entry.annotationChapterIndexes.map(async (chapterIndex) => ({
        chapterIndex,
        value: await loadReadingAnnotations(entry.bookId, chapterIndex),
      }))),
      entry.notesKey ? loadReadingNotes(entry.bookId) : Promise.resolve([]),
    ]);
    const candidates: CoReadingResultCandidate[] = [];
    annotationGroups.forEach(({ chapterIndex, value }) => {
      value.summaries.forEach((summary) => {
        candidates.push({
          id: `summary:${chapterIndex}:${summary.segmentIndex}`,
          bookId: entry.bookId,
          chapterIndex,
          kind: 'summary',
          segmentIndex: summary.segmentIndex,
          occurredAt: summary.updatedAt ?? summary.createdAt,
          text: summary.summary,
        });
      });
      value.annotations.forEach((annotation) => {
        candidates.push({
          id: annotation.id,
          bookId: entry.bookId,
          chapterIndex,
          kind: 'annotation',
          segmentIndex: annotation.segmentIndex,
          paragraphIndex: annotation.p,
          occurredAt: annotation.updatedAt ?? annotation.createdAt,
          text: annotation.text,
        });
      });
    });
    notes.forEach((note) => {
      if (note.kind === 'question') {
        candidates.push({
          id: note.id,
          bookId: entry.bookId,
          chapterIndex: note.chapterIndex,
          kind: 'question',
          occurredAt: note.createdAt,
          question: note.question,
          answer: note.answer,
        });
        return;
      }
      if (note.note) {
        candidates.push({
          id: note.id,
          bookId: entry.bookId,
          chapterIndex: note.chapterIndex,
          kind: 'my-note',
          occurredAt: note.createdAt,
          text: note.note,
        });
      }
    });
    return candidates;
  }));

  return buildReadingLifeMaterialSnapshot({
    books,
    sessions,
    results: resultGroups.flat(),
    now,
  });
}
