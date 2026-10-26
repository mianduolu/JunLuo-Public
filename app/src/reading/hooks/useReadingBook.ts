import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, ScrollView } from 'react-native';
import { readingSourceParagraph } from '../readingSourceAnchor';

import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../../backup/backupRestoreCoordinator';
import type { ScreenMode } from '../readingUiTypes';
import {
  finishReadingSession,
  getReadingBookFileStatus,
  loadReadingAnnotations,
  loadReadingChapter,
  loadReadingNotes,
  markStaleReadingSegments,
  saveReadingProgress,
  startReadingSession,
} from '../readingStore';
import type {
  ReadingAnnotation,
  ReadingBook,
  ReadingChapter,
  ReadingNote,
  ReadingSegmentMeta,
  ReadingSegmentSummary,
  ReadingSession,
} from '../readingTypes';

type Options = {
  fontSize: number;
  refreshLibrary: (dataEpoch?: number | null) => Promise<boolean>;
  setBusy: (busy: boolean) => void;
  setMode: (mode: ScreenMode) => void;
};

export function useReadingBook({ fontSize, refreshLibrary, setBusy, setMode }: Options) {
  const scrollRef = useRef<ScrollView>(null);
  const sessionRef = useRef<ReadingSession | null>(null);
  const progressRef = useRef({ chapterIndex: 0, paragraphIndex: 0 });
  const lastProgressSaveAtRef = useRef(0);
  const activeSecondsRef = useRef(0);
  const lastActivityAtRef = useRef<number | null>(null);
  const [book, setBook] = useState<ReadingBook | null>(null);
  const [chapter, setChapter] = useState<ReadingChapter | null>(null);
  const [annotations, setAnnotations] = useState<ReadingAnnotation[]>([]);
  const [summaries, setSummaries] = useState<ReadingSegmentSummary[]>([]);
  const [notes, setNotes] = useState<ReadingNote[]>([]);
  const [progressParagraph, setProgressParagraphState] = useState(0);

  const markReadingActivity = () => {
    const now = Date.now();
    const lastActivityAt = lastActivityAtRef.current;
    if (lastActivityAt) {
      activeSecondsRef.current += Math.min(20, Math.max(0, Math.round((now - lastActivityAt) / 1000)));
    }
    lastActivityAtRef.current = now;
  };

  const resetReadingActivity = () => {
    activeSecondsRef.current = 0;
    lastActivityAtRef.current = Date.now();
  };

  useEffect(() => () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    const currentSession = sessionRef.current;
    if (currentSession && dataEpoch !== null) {
      markReadingActivity();
      const endPosition = { ...progressRef.current };
      const activeSeconds = activeSecondsRef.current;
      void runBackupRestoreDataEpochCommit(dataEpoch, () => finishReadingSession(
        currentSession.id,
        endPosition,
        activeSeconds,
      )).catch(() => undefined);
    }
  }, []);

  const reloadCurrentChapter = async (nextBook = book, chapterIndex = chapter?.index ?? 0) => {
    if (!nextBook) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const loaded = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const nextChapter = await markStaleReadingSegments(nextBook.id, chapterIndex);
      const [chapterAnnotations, nextNotes] = await Promise.all([
        loadReadingAnnotations(nextBook.id, chapterIndex),
        loadReadingNotes(nextBook.id),
      ]);
      return { chapterAnnotations, nextChapter, nextNotes };
    });
    if (!loaded.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (loaded.value.nextChapter) setChapter(loaded.value.nextChapter);
    setAnnotations(loaded.value.chapterAnnotations.annotations);
    setSummaries(loaded.value.chapterAnnotations.summaries);
    setNotes(loaded.value.nextNotes);
  };

  const openBook = async (nextBook: ReadingBook, chapterIndex = nextBook.currentChapter, paragraphIndex = nextBook.currentParagraph) => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    setBusy(true);
    try {
      const previousSession = sessionRef.current;
      if (previousSession) markReadingActivity();
      const activeSeconds = activeSecondsRef.current;
      const opened = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
        const nextChapter = await markStaleReadingSegments(nextBook.id, chapterIndex)
          ?? await loadReadingChapter(nextBook.id, chapterIndex);
        if (!nextChapter) {
          const fileStatus = await getReadingBookFileStatus(nextBook);
          throw new Error(
            fileStatus.sourceExists
              ? '这章暂时没有找到。'
              : '这本书的源文件和章节数据都不在了，需要重新放进书架。',
          );
        }
        const [chapterAnnotations, nextNotes, updatedBook] = await Promise.all([
          loadReadingAnnotations(nextBook.id, chapterIndex),
          loadReadingNotes(nextBook.id),
          saveReadingProgress(nextBook.id, chapterIndex, paragraphIndex),
        ]);
        const activeBook = updatedBook ?? nextBook;
        if (previousSession) {
          await finishReadingSession(
            previousSession.id,
            { chapterIndex, paragraphIndex },
            activeSeconds,
          ).catch(() => undefined);
        }
        const nextSession = await startReadingSession(activeBook.id, { chapterIndex, paragraphIndex });
        return { activeBook, chapterAnnotations, nextChapter, nextNotes, nextSession };
      });
      if (!opened.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
      const {
        activeBook,
        chapterAnnotations,
        nextChapter,
        nextNotes,
        nextSession,
      } = opened.value;
      setBook(activeBook);
      setChapter(nextChapter);
      setAnnotations(chapterAnnotations.annotations);
      setSummaries(chapterAnnotations.summaries);
      setNotes(nextNotes);
      progressRef.current = { chapterIndex, paragraphIndex };
      setProgressParagraphState(paragraphIndex);
      lastProgressSaveAtRef.current = Date.now();
      sessionRef.current = nextSession;
      resetReadingActivity();
      setMode('reader');
      setTimeout(() => {
        if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        scrollRef.current?.scrollTo({ y: Math.max(0, paragraphIndex * fontSize * 4.2), animated: false });
      }, 120);
      await refreshLibrary(dataEpoch);
    } catch (error) {
      if (canCommitBackupRestoreDataEpoch(dataEpoch)) {
        Alert.alert('打不开这本书', error instanceof Error ? error.message : '请稍后再试。');
      }
    } finally {
      setBusy(false);
    }
  };

  const closeReader = async () => {
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    markReadingActivity();
    const endPosition = { ...progressRef.current };
    const currentSession = sessionRef.current;
    const activeSeconds = activeSecondsRef.current;
    const closed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      if (book && chapter) {
        await saveReadingProgress(book.id, endPosition.chapterIndex, endPosition.paragraphIndex).catch(() => undefined);
      }
      if (currentSession) {
        await finishReadingSession(currentSession.id, endPosition, activeSeconds).catch(() => undefined);
      }
    });
    if (!closed.committed || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    sessionRef.current = null;
    activeSecondsRef.current = 0;
    lastActivityAtRef.current = null;
    await refreshLibrary(dataEpoch);
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    setMode('library');
  };

  const changeChapter = async (direction: -1 | 1) => {
    if (!book || !chapter) return;
    const nextIndex = chapter.index + direction;
    if (nextIndex < 0 || nextIndex >= book.totalChapters) return;
    await openBook({ ...book, currentChapter: nextIndex, currentParagraph: 0 }, nextIndex, 0);
  };

  const annotationsByP = useMemo(() => {
    const map = new Map<number, ReadingAnnotation[]>();
    annotations.forEach((annotation) => {
      const p = readingSourceParagraph(chapter, annotation, annotation.p);
      if (p !== undefined) map.set(p, [...(map.get(p) ?? []), annotation]);
    });
    return map;
  }, [annotations, chapter]);

  const summaryByEndP = useMemo(() => {
    const map = new Map<number, ReadingSegmentSummary>();
    if (!chapter) return map;
    summaries.forEach((summary) => {
      if (summary.sourceAnchor) return;
      const segment = chapter.segmentsMeta.find((item) => item.segmentIndex === summary.segmentIndex);
      if (segment) map.set(segment.endP, summary);
    });
    return map;
  }, [chapter, summaries]);

  const currentSegment = useMemo(() => {
    if (!chapter) return null;
    const currentP = progressParagraph;
    return (
      chapter.segmentsMeta.find((segment) => currentP >= segment.startP && currentP <= segment.endP && segment.status !== 'done') ??
      chapter.segmentsMeta.find((segment) => segment.status === 'pending' || segment.status === 'failed' || segment.status === 'stale') ??
      null
    );
  }, [chapter, progressParagraph]);

  const activeSegment: ReadingSegmentMeta | null = useMemo(() => {
    if (!chapter) return null;
    return chapter.segmentsMeta.find((segment) => progressParagraph >= segment.startP && progressParagraph <= segment.endP) ?? null;
  }, [chapter, progressParagraph]);

  const doneSegments = chapter?.segmentsMeta.filter((segment) => segment.status === 'done').length ?? 0;
  const setProgressParagraph = (paragraphIndex: number) => {
    if (!book || !chapter) return;
    const nextParagraph = Math.max(0, Math.min(chapter.paragraphs.length - 1, paragraphIndex));
    if (progressRef.current.chapterIndex === chapter.index && progressRef.current.paragraphIndex === nextParagraph) return;
    markReadingActivity();
    progressRef.current = { chapterIndex: chapter.index, paragraphIndex: nextParagraph };
    setProgressParagraphState(nextParagraph);

    const now = Date.now();
    if (now - lastProgressSaveAtRef.current < 1800) return;
    lastProgressSaveAtRef.current = now;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    void runBackupRestoreDataEpochCommit(dataEpoch, () => saveReadingProgress(
      book.id,
      chapter.index,
      nextParagraph,
    )).catch(() => undefined);
  };

  return {
    annotations,
    annotationsByP,
    activeSegment,
    book,
    changeChapter,
    chapter,
    closeReader,
    currentSegment,
    doneSegments,
    notes,
    openBook,
    progressRef,
    reloadCurrentChapter,
    scrollRef,
    setProgressParagraph,
    summaries,
    summaryByEndP,
  };
}
