import type { ReadingBook } from '../reading/readingTypes';
import { loadReadingChapter } from '../reading/readingStore';
import type { ScheduleItem } from './scheduleStore';
import { loadOwnReadingChoice } from './ownedDayPlanStore';
import { selectedReadingImages } from '../reading/readingImageMaterial';

/** Read-only evidence. Preparing a catalogue must never download, upgrade, or start a book. */
export async function ownReadingAvailability(books: ReadingBook[], verifyFiles = false) {
  const values: Record<string, { ready: boolean; title: string; reachedEnd: boolean }> = {};
  for (const book of books) {
    let ready = !!book.iReading && !book.iReading.reachedEnd && !book.iReading.needsSourceConfirmation
      && (!book.programme || book.programme.preparation === 'ready');
    if (ready) {
      try {
        const chapter = await loadReadingChapter(book.id, book.iReading!.cursor.chapterIndex, true);
        ready = !!chapter && chapter.segmentsMeta.some(segment => segment.segmentIndex >= book.iReading!.cursor.segmentIndex)
          && (!!chapter.paragraphs.length || !!chapter.images?.length);
        if (ready && chapter && verifyFiles) {
          const images = selectedReadingImages(chapter, chapter.segmentsMeta.find(part => part.segmentIndex === book.iReading!.cursor.segmentIndex)!);
          if (images.length) {
            const fs = await import('expo-file-system/legacy');
            const { Buffer } = await import('buffer');
            const { sha256 } = await import('@noble/hashes/sha2.js');
            const { bytesToHex } = await import('@noble/hashes/utils.js');
            for (const image of images) {
              const encoded = await fs.readAsStringAsync(image.uri, { encoding: fs.EncodingType.Base64 });
              if (bytesToHex(sha256(Buffer.from(encoded, 'base64'))) !== image.contentVersion) { ready = false; break; }
            }
          }
        }
      } catch { ready = false; }
    }
    values[book.id] = { ready, title: book.title, reachedEnd: !!book.iReading?.reachedEnd };
  }
  return values;
}

export async function ownReadingLabels(items: ScheduleItem[], availability: Record<string, { ready: boolean; reachedEnd?: boolean }>,
  previous: Record<string, string> = {}) {
  const readingLabels = { ...previous };
  const expectedChoiceVersions: Record<string, number> = {};
  const facts: Record<string, { localId: string; currentReadingId: string; nextReadingId: string | null }> = {};
  for (const item of items) {
    if (item.owner !== 'I' || item.status !== 'pending') continue;
    const resolved = await loadOwnReadingChoice(item);
    if (!resolved?.choice.currentReadingId) continue;
    const completed = availability[resolved.choice.currentReadingId]?.reachedEnd;
    const currentReadingId = completed ? resolved.choice.nextReadingId : resolved.choice.currentReadingId;
    if (!currentReadingId || !availability[currentReadingId]?.ready) continue;
    let label = Object.keys(readingLabels).find(key => readingLabels[key] === item.id);
    if (!label) {
      let index = 1;
      while (readingLabels[`r${index}`]) index += 1;
      label = `r${index}`;
      readingLabels[label] = item.id;
    }
    expectedChoiceVersions[resolved.root.id] = resolved.choice.version;
    facts[item.id] = { localId: label, currentReadingId, nextReadingId: completed ? null : resolved.choice.nextReadingId };
  }
  return { readingLabels, expectedChoiceVersions, facts };
}
