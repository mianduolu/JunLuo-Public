import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert } from 'react-native';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../../backup/backupRestoreCoordinator';
import { importEpubBook } from '../epubImport';
import { settleInterruptedProgrammePreparations } from '../readingProgrammeStore';
import { readingSourceParagraph } from '../readingSourceAnchor';
import { formatPercent, formatRelativeTime, todayStart } from '../readingFormat';
import { createTextReadingBook } from '../textImport';
import {
  deleteReadingBookRecord,
  getReadingBookFileStatus,
  loadReadingAnnotations,
  loadReadingChapter,
  loadReadingLibrary,
  loadReadingNotes,
  loadReadingSessions,
  migrateReadingStorageIfNeeded,
  repairReadingBookFiles,
  scanReadingBookKeys,
} from '../readingStore';
import type { ReadingBook, ReadingBookFileStatus, ReadingSession } from '../readingTypes';
import type { ReadingBookShelfMeta, ReadingLibraryPulse, ReadingLibraryStats } from '../readingUiTypes';

type Options = {
  busy: boolean;
  openBook: (book: ReadingBook, chapterIndex?: number, paragraphIndex?: number) => Promise<void>;
  setBusy: (busy: boolean) => void;
};

function comparePulseNewestFirst(left: ReadingLibraryPulse, right: ReadingLibraryPulse) {
  return (
    right.createdAt - left.createdAt ||
    right.chapterIndex - left.chapterIndex ||
    right.paragraphIndex - left.paragraphIndex ||
    right.label.localeCompare(left.label, 'zh-CN')
  );
}

export function useReadingLibrary({ busy, openBook, setBusy }: Options) {
  const reportedMaintenanceError = useRef(false);
  const [books, setBooks] = useState<ReadingBook[]>([]);
  const [sessions, setSessions] = useState<ReadingSession[]>([]);
  const [fileStatuses, setFileStatuses] = useState<Record<string, ReadingBookFileStatus>>({});
  const [recentPulse, setRecentPulse] = useState<ReadingLibraryPulse | undefined>();
  const [annotationItems, setAnnotationItems] = useState<ReadingLibraryPulse[]>([]);
  const [noteItems, setNoteItems] = useState<ReadingLibraryPulse[]>([]);
  const [loading, setLoading] = useState(true);

  const collectLibraryPulse = async (libraryBooks: ReadingBook[]) => {
    const booksById = new Map(libraryBooks.map((book) => [book.id, book]));
    const pulses: ReadingLibraryPulse[] = [];
    const annotationPulses: ReadingLibraryPulse[] = [];
    const notePulses: ReadingLibraryPulse[] = [];
    const keyIndex = await scanReadingBookKeys();

    await Promise.all(keyIndex.map(async (entry) => {
      const targetBook = booksById.get(entry.bookId);
      if (!targetBook) return;
      await Promise.all(entry.annotationChapterIndexes.map(async (chapterIndex) => {
        const chapterAnnotations = await loadReadingAnnotations(entry.bookId, chapterIndex);
        chapterAnnotations.annotations.forEach((annotation) => {
          const createdAt = annotation.updatedAt ?? annotation.createdAt;
          const pulse: ReadingLibraryPulse = {
            kind: 'annotation',
            sourceAnchor: annotation.sourceAnchor,
            bookId: entry.bookId,
            bookTitle: targetBook.title,
            chapterIndex,
            paragraphIndex: annotation.p,
            label: `白云批注 · P${annotation.p}`,
            text: annotation.text,
            createdAt,
          };
          pulses.push(pulse);
          annotationPulses.push(pulse);
        });
        chapterAnnotations.summaries.forEach((summary) => {
          const createdAt = summary.updatedAt ?? summary.createdAt;
          const pulse: ReadingLibraryPulse = {
            kind: 'summary',
            sourceAnchor: summary.sourceAnchor,
            bookId: entry.bookId,
            bookTitle: targetBook.title,
            chapterIndex,
            paragraphIndex: 0,
            label: `白云读后感 · 第 ${summary.segmentIndex + 1} 段`,
            text: summary.summary,
            createdAt,
          };
          pulses.push(pulse);
          annotationPulses.push(pulse);
        });
      }));

      const notes = await loadReadingNotes(entry.bookId);
      notes.forEach((note) => {
        const pulse: ReadingLibraryPulse = {
          kind: 'note',
          sourceAnchor: note.sourceAnchor,
          bookId: entry.bookId,
          bookTitle: targetBook.title,
          chapterIndex: note.chapterIndex,
          paragraphIndex: note.startP,
          label: note.kind === 'question' ? `问白云 · P${note.startP}` : `我的笔记 · P${note.startP}`,
          text: note.note ?? note.answer ?? note.question ?? note.selectedText,
          createdAt: note.createdAt,
        };
        pulses.push(pulse);
        notePulses.push(pulse);
      });
    }));

    pulses.sort(comparePulseNewestFirst);
    annotationPulses.sort(comparePulseNewestFirst);
    notePulses.sort(comparePulseNewestFirst);
    return {
      annotationItems: annotationPulses,
      noteItems: notePulses,
      recentPulse: pulses[0],
    };
  };

  const refreshLibrary = async (dataEpoch = captureBackupRestoreDataEpoch()) => {
    if (dataEpoch === null) return false;
    const refreshed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      let maintenanceError: unknown = null;
      try {
        await migrateReadingStorageIfNeeded();
        await settleInterruptedProgrammePreparations();
        await repairReadingBookFiles();
      } catch (error) {
        maintenanceError = error;
      }
      const [nextBooks, nextSessions] = await Promise.all([loadReadingLibrary(), loadReadingSessions()]);
      let detailError: unknown = null;
      let nextFileStatuses: Record<string, ReadingBookFileStatus> = {};
      let nextAnnotationItems: ReadingLibraryPulse[] = [];
      let nextNoteItems: ReadingLibraryPulse[] = [];
      let nextRecentPulse: ReadingLibraryPulse | undefined;
      try {
        const [statuses, pulse] = await Promise.all([
          Promise.all(nextBooks.map(getReadingBookFileStatus)),
          collectLibraryPulse(nextBooks),
        ]);
        nextFileStatuses = Object.fromEntries(statuses.map((status) => [status.bookId, status]));
        nextAnnotationItems = pulse.annotationItems;
        nextNoteItems = pulse.noteItems;
        nextRecentPulse = pulse.recentPulse;
      } catch (error) {
        detailError = error;
      }
      return {
        detailError,
        maintenanceError,
        nextAnnotationItems,
        nextBooks,
        nextFileStatuses,
        nextNoteItems,
        nextRecentPulse,
        nextSessions,
      };
    });
    if (!refreshed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
    const result = refreshed.value;
    setBooks(result.nextBooks);
    setSessions(result.nextSessions);
    setFileStatuses(result.nextFileStatuses);
    setAnnotationItems(result.nextAnnotationItems);
    setNoteItems(result.nextNoteItems);
    setRecentPulse(result.nextRecentPulse);
    if (result.maintenanceError && !reportedMaintenanceError.current) {
      reportedMaintenanceError.current = true;
      Alert.alert(
        '书架整理失败',
        result.maintenanceError instanceof Error
          ? result.maintenanceError.message
          : '共读数据暂时没整理好，但原有书架会尽量保留。',
      );
    }
    if (result.detailError && !reportedMaintenanceError.current) {
      reportedMaintenanceError.current = true;
      Alert.alert(
        '书架信息整理失败',
        result.detailError instanceof Error
          ? result.detailError.message
          : '书架能继续用，但今日伴读信息暂时没算出来。',
      );
    }
    return true;
  };

  useEffect(() => {
    let mounted = true;
    void refreshLibrary().finally(() => {
      if (mounted) setLoading(false);
    });
    return () => {
      mounted = false;
    };
  }, []);

  const continueBook = books.find((item) => item.lastOpenedAt) ?? books[0];
  const minutesToday = useMemo(() => {
    const todaySessions = sessions.filter((session) => (session.endedAt ?? session.startedAt) >= todayStart());
    return Math.round(todaySessions.reduce((total, session) => total + (session.activeSeconds ?? 0), 0) / 60);
  }, [sessions]);
  const stats: ReadingLibraryStats = useMemo(() => ({
    minutesToday,
    annotationItems,
    noteItems,
    bookCount: books.length,
    recentPulse,
  }), [annotationItems, books.length, minutesToday, noteItems, recentPulse]);

  const getBookShelfMeta = (book: ReadingBook): ReadingBookShelfMeta => {
    const fileStatus = fileStatuses[book.id];
    const fileWarning = fileStatus && !fileStatus.sourceExists
      ? '源文件缺失，仍可读已保存内容'
      : fileStatus && !fileStatus.coverExists
        ? '封面缺失'
        : undefined;
    return {
      chapterLabel: `第 ${book.currentChapter + 1} 章`,
      paragraphLabel: `P${book.currentParagraph}`,
      progressLabel: formatPercent(book.progressFraction),
      lastOpenedLabel: formatRelativeTime(book.lastOpenedAt ?? book.importedAt),
      fileWarning,
    };
  };

  const openRecentPulse = async (pulse: ReadingLibraryPulse) => {
    const targetBook = books.find((item) => item.id === pulse.bookId);
    if (!targetBook) return;
    const p = pulse.sourceAnchor ? readingSourceParagraph(await loadReadingChapter(pulse.bookId, pulse.chapterIndex), pulse, pulse.paragraphIndex) : pulse.paragraphIndex;
    if (p === undefined) {
      Alert.alert('旧阅读记录', `${pulse.sourceAnchor?.originalChapterTitle ?? ''}\n${new Date(pulse.createdAt).toLocaleString('zh-CN')}\n\n${pulse.text}`);
      return;
    }
    await openBook(targetBook, pulse.chapterIndex, p);
  };

  const importBook = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const imported = await importEpubBook();
      await refreshLibrary();
      if (imported) await openBook(imported, 0, 0);
    } catch (error) {
      Alert.alert('导入失败', error instanceof Error ? error.message : '这本 EPUB 暂时读不了。');
    } finally {
      setBusy(false);
    }
  };

  const createTextBook = async (title: string, text: string) => {
    if (busy) return false;
    setBusy(true);
    try {
      const imported = await createTextReadingBook(title, text);
      await refreshLibrary();
      await openBook(imported, 0, 0);
      return true;
    } catch (error) {
      Alert.alert('放进书架失败', error instanceof Error ? error.message : '这段文字暂时放不进书架。');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const confirmDeleteBook = (target: ReadingBook) => {
    Alert.alert('把这本书从书架拿走吗？', `“${target.title}”的章节、白云批注、读后感、我的笔记、阅读记录和本地书籍文件都会一起删除。`, [
      { text: '先留着', style: 'cancel' },
      {
        text: '删除',
        style: 'destructive',
        onPress: () => {
          void deleteReadingBookRecord(target.id).then((deleted) => {
            if (deleted) return refreshLibrary();
          }).catch(() => undefined);
        },
      },
    ]);
  };

  return {
    books,
    confirmDeleteBook,
    continueBook,
    createTextBook,
    fileStatuses,
    getBookShelfMeta,
    importBook,
    loading,
    minutesToday,
    openRecentPulse,
    refreshLibrary,
    sessions,
    stats,
  };
}
