import * as FileSystem from 'expo-file-system/legacy';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { writeStringFileSafely } from '../storage/safeFileWrite';

import {
  computeReadingSegments,
  getReadingBookDirectory,
  makeReadingId,
  saveReadingChapter,
  upsertReadingBook,
} from './readingStore';
import type { ReadingBook, ReadingChapter } from './readingTypes';

const DEFAULT_TEXT_TITLE = '粘贴文字共读';
const DEFAULT_TEXT_AUTHOR = '小仓鼠粘贴的文字';
const MAX_PARAGRAPH_CHARS = 1800;

function normalizePlainText(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function splitLongParagraph(paragraph: string) {
  if (paragraph.length <= MAX_PARAGRAPH_CHARS) return [paragraph];

  const sentences = paragraph
    .split(/(?<=[。！？.!?；;])\s*/)
    .map((item) => item.trim())
    .filter(Boolean);
  if (sentences.length <= 1) {
    const chunks: string[] = [];
    for (let index = 0; index < paragraph.length; index += MAX_PARAGRAPH_CHARS) {
      chunks.push(paragraph.slice(index, index + MAX_PARAGRAPH_CHARS).trim());
    }
    return chunks.filter(Boolean);
  }

  const chunks: string[] = [];
  let current = '';
  sentences.forEach((sentence) => {
    if (current && current.length + sentence.length > MAX_PARAGRAPH_CHARS) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current = `${current}${sentence}`;
    }
  });
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

export function splitPastedTextIntoParagraphs(text: string) {
  const normalized = normalizePlainText(text);
  if (!normalized) return [];

  const roughParagraphs = normalized.includes('\n\n')
    ? normalized.split(/\n{2,}/)
    : normalized.split(/\n/);

  return roughParagraphs
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .flatMap(splitLongParagraph);
}

export async function createTextReadingBook(titleInput: string, textInput: string) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) throw new Error('backup-restore-not-ready');
  const paragraphs = splitPastedTextIntoParagraphs(textInput);
  if (!paragraphs.length) {
    throw new Error('先粘贴一点想共读的文字。');
  }

  const now = Date.now();
  const bookId = makeReadingId('text-book', now);
  const title = normalizePlainText(titleInput).slice(0, 80) || DEFAULT_TEXT_TITLE;
  const textContent = paragraphs.join('\n\n');
  const bookDirectory = getReadingBookDirectory(bookId);
  const sourceUri = `${bookDirectory}source.txt`;
  let commitAttempted = false;
  try {
    await writeStringFileSafely(sourceUri, textContent);
    const chapter: ReadingChapter = {
      bookId,
      index: 0,
      title,
      textContent,
      paragraphs,
      charCount: textContent.length,
      segmentsMeta: computeReadingSegments(paragraphs),
    };
    const book: ReadingBook = {
      id: bookId,
      title,
      author: DEFAULT_TEXT_AUTHOR,
      language: 'zh',
      fileType: 'txt',
      fileUri: sourceUri,
      totalChapters: 1,
      currentChapter: 0,
      currentParagraph: 0,
      progressFraction: 0,
      importedAt: now,
      lastOpenedAt: now,
    };
    commitAttempted = true;
    const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      await saveReadingChapter(chapter);
      await upsertReadingBook(book);
      return book;
    });
    if (!committed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) {
      throw new Error('backup-restore-data-epoch-changed');
    }
    return committed.value;
  } catch (error) {
    if (!commitAttempted) {
      await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        FileSystem.deleteAsync(bookDirectory, { idempotent: true })
      )).catch(() => undefined);
    }
    throw error;
  }
}

