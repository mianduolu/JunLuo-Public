import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ReadingLibraryView } from '../reading/components/ReadingLibraryView';
import { ReadingProgrammeView } from '../reading/components/ReadingProgrammeView';
import { ReadingModals } from '../reading/components/ReadingModals';
import { ReadingEpubRecoveryModal } from '../reading/components/ReadingEpubRecoveryModal';
import { previewLegacyEpubRecovery, recoverLegacyEpubReadingSource, type EpubRecoveryPreview } from '../reading/readingEpubUpgradeRuntime';
import { ReadingReaderView } from '../reading/components/ReadingReaderView';
import { ReadingResultsView } from '../reading/components/ReadingResultsView';
import { readingStyles as styles } from '../reading/components/readingStyles';
import { useReadingAiActions } from '../reading/hooks/useReadingAiActions';
import { useReadingBook } from '../reading/hooks/useReadingBook';
import { useReadingLibrary } from '../reading/hooks/useReadingLibrary';
import { loadReadingResultActions, type ReadingResultActionMap } from '../reading/readingResultActions';
import { loadReadingBookResults } from '../reading/readingResults';
import type { ParagraphActionState, ReaderThemeName, ScreenMode } from '../reading/readingUiTypes';
import type { ReadingBookResults } from '../reading/readingResults';
import type { ReadingAnnotation, ReadingBook, ReadingSegmentSummary } from '../reading/readingTypes';
import type { Navigate } from '../types/navigation';
import { confirmReadingStart } from '../reading/readingDailyRuntime';
import { loadReadingChapter, loadReadingLibraryStrict } from '../reading/readingStore';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';

type Props = {
  navigate: Navigate;
  onBringToChat?: (book: ReadingBook) => void;
};

export function CoReadingScreen({ navigate, onBringToChat }: Props) {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState<ScreenMode>('library');
  const [libraryTab, setLibraryTab] = useState<'books' | 'programmes'>('books');
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ bookId: string; preview: EpubRecoveryPreview } | null>(null);
  const [fontSize, setFontSize] = useState(18);
  const [lineHeightMultiplier, setLineHeightMultiplier] = useState(1.75);
  const [paragraphSpacing, setParagraphSpacing] = useState(18);
  const [readerTheme, setReaderTheme] = useState<ReaderThemeName>('paper');
  const [annotationDetail, setAnnotationDetail] = useState<ReadingAnnotation | null>(null);
  const [summaryDetail, setSummaryDetail] = useState<ReadingSegmentSummary | null>(null);
  const [showToc, setShowToc] = useState(false);
  const [paragraphAction, setParagraphAction] = useState<ParagraphActionState | null>(null);
  const [questionDraft, setQuestionDraft] = useState('这里是什么意思？');
  const [noteDraft, setNoteDraft] = useState('');
  const [bookResults, setBookResults] = useState<ReadingBookResults>({
    sections: [],
    stats: { annotations: 0, myNotes: 0, questions: 0, summaries: 0 },
  });
  const [resultActions, setResultActions] = useState<ReadingResultActionMap>({});

  const readingBook = useReadingBook({
    fontSize,
    refreshLibrary: async (dataEpoch) => readingLibrary.refreshLibrary(dataEpoch),
    setBusy,
    setMode,
  });

  const openReadingEntry = async (book: ReadingBook, chapterIndex?: number, paragraphIndex?: number) => {
    if (book.fileType === 'epub' && book.iReading && !book.iReading.reachedEnd) {
      setBusy(true);
      try {
        const result = await (await import('../reading/readingEpubUpgradeRuntime')).ensureLegacyEpubReadingSource(book.id);
        const current = (await loadReadingLibraryStrict()).find(item => item.id === book.id);
        if (!current) return;
        if (result.status === 'needs-confirmation') Alert.alert('旧书接读位置需要确认',
          '旧笔记和日期已保留。请在阅读页从原文选择接读起点；不能对应新版原文的旧记录仍可在笔记页查看。');
        if (result.status === 'unavailable') Alert.alert('旧书图文暂未接好', '原资料保留，请检查源文件后重试。');
        return await readingBook.openBook(current, chapterIndex, paragraphIndex);
      } catch (error) {
        Alert.alert('旧书暂未打开', error instanceof Error ? error.message : '读取失败，请稍后重试。');
      } finally { setBusy(false); }
    }
    if (book.contentType !== 'programme') return readingBook.openBook(book, chapterIndex, paragraphIndex);
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return;
    try {
      const current = (await loadReadingLibraryStrict()).find(item => item.id === book.id);
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      if (!current || current.programme?.preparation !== 'ready') {
        setLibraryTab('programmes'); setMode('library');
        await readingLibrary.refreshLibrary();
        return;
      }
      await readingBook.openBook(current, chapterIndex, paragraphIndex);
    } catch { Alert.alert('节目暂时未打开', '当前资料状态未能读取，请稍后重试。'); }
  };

  const readingLibrary = useReadingLibrary({
    busy,
    openBook: openReadingEntry,
    setBusy,
  });

  const readingActions = useReadingAiActions({
    book: readingBook.book,
    busy,
    chapter: readingBook.chapter,
    currentSegment: readingBook.currentSegment,
    noteDraft,
    paragraphAction,
    questionDraft,
    reloadCurrentChapter: readingBook.reloadCurrentChapter,
    setBusy,
    setNoteDraft,
    setParagraphAction,
  });

  const refreshBookResults = async () => {
    if (!readingBook.book) {
      setBookResults({ sections: [], stats: { annotations: 0, myNotes: 0, questions: 0, summaries: 0 } });
      setResultActions({});
      return;
    }
    const [results, actions] = await Promise.all([
      loadReadingBookResults(readingBook.book),
      loadReadingResultActions(readingBook.book.id),
    ]);
    setBookResults(results);
    setResultActions(actions);
  };

  const refreshResultActions = async () => {
    setResultActions(readingBook.book ? await loadReadingResultActions(readingBook.book.id) : {});
  };

  useEffect(() => {
    if (mode !== 'notes') return;
    void refreshBookResults();
  }, [mode, readingBook.book?.id]);

  useEffect(() => {
    void refreshResultActions();
  }, [readingBook.book?.id]);

  if (readingLibrary.loading) {
    return (
      <View style={styles.loadingPage}>
        <ActivityIndicator color="#6F98BB" />
      </View>
    );
  }

  return (
    <>
      {mode === 'library' && libraryTab === 'books' ? (
        <ReadingLibraryView
          books={readingLibrary.books.filter(book => book.contentType !== 'programme')}
          busy={busy}
          continueBook={readingLibrary.books.find(book => book.contentType !== 'programme' && !!book.lastOpenedAt)
            ?? readingLibrary.books.find(book => book.contentType !== 'programme')}
          getBookShelfMeta={readingLibrary.getBookShelfMeta}
          insets={insets}
          navigate={navigate}
          onCreateTextBook={readingLibrary.createTextBook}
          onDeleteBook={readingLibrary.confirmDeleteBook}
          onImportBook={readingLibrary.importBook}
          onOpenBook={openReadingEntry}
          onBringToChat={onBringToChat}
          onOpenPulse={(pulse) => void readingLibrary.openRecentPulse(pulse)}
          onShowProgrammes={() => setLibraryTab('programmes')}
          stats={{ ...readingLibrary.stats, bookCount: readingLibrary.books.filter(book => book.contentType !== 'programme').length }}
        />
      ) : null}
      {mode === 'library' && libraryTab === 'programmes' ? (
        <ReadingProgrammeView books={readingLibrary.books} busy={busy} setBusy={setBusy} insets={insets} navigate={navigate}
          onBooks={() => setLibraryTab('books')} onOpenBook={openReadingEntry} onBringToChat={onBringToChat} refreshLibrary={readingLibrary.refreshLibrary} />
      ) : null}

      {mode === 'reader' && readingBook.book && readingBook.chapter ? (
        <ReadingReaderView
          activeSegment={readingBook.activeSegment}
          annotationsByP={readingBook.annotationsByP}
          batchProgressLabel={readingActions.batchProgressLabel}
          book={readingBook.book}
          busy={busy}
          chapter={readingBook.chapter}
          currentSegment={readingBook.currentSegment}
          doneSegments={readingBook.doneSegments}
          fontSize={fontSize}
          insets={insets}
          lineHeightMultiplier={lineHeightMultiplier}
          paragraphSpacing={paragraphSpacing}
          readerTheme={readerTheme}
          scrollRef={readingBook.scrollRef}
          setAnnotationDetail={setAnnotationDetail}
          setFontSize={setFontSize}
          setLineHeightMultiplier={setLineHeightMultiplier}
          setMode={setMode}
          setParagraphSpacing={setParagraphSpacing}
          setParagraphAction={setParagraphAction}
          setReaderTheme={setReaderTheme}
          setShowToc={setShowToc}
          setSummaryDetail={setSummaryDetail}
          summaryByEndP={readingBook.summaryByEndP}
          onChangeChapter={readingBook.changeChapter}
          onCloseReader={readingBook.closeReader}
          onInviteBaiyun={readingActions.inviteBaiyun}
          onConfirmReadingStart={() => {
            const book = readingBook.book, chapter = readingBook.chapter, segment = readingBook.currentSegment;
            if (!book || !chapter || !segment || (book.iReading && !book.iReading.needsSourceConfirmation) || busy) return;
            if (book.fileType === 'epub' && (!chapter.contentBlocks || chapter.sourceRevision)) {
              setBusy(true);
              void previewLegacyEpubRecovery(book.id).then(preview => setRecovery({ bookId: book.id, preview }))
                .catch(error => Alert.alert('原文暂未打开', error instanceof Error ? error.message : '读取失败，请重试。'))
                .finally(() => setBusy(false));
              return;
            }
            Alert.alert('确认云的接读起点',
              `从第 ${chapter.index + 1} 章·第 ${segment.segmentIndex + 1} 段接读。保留旧笔记，不将前文标为已读；确认不会发起模型请求。`,
              [{ text: '取消', style: 'cancel' }, { text: '确认起点', onPress: () => {
                setBusy(true);
                void confirmReadingStart(book.id, { chapterIndex: chapter.index, segmentIndex: segment.segmentIndex })
                  .then(async saved => {
                    if (!saved) throw new Error('reading-start-not-saved');
                    await readingBook.openBook(book, chapter.index, segment.startP);
                  }).catch(() => Alert.alert('未确认接读起点', '位置尚不能可靠对应原图文，或保存失败。旧笔记和进度保留，本次没有请求模型。'))
                  .finally(() => setBusy(false));
              } }]);
          }}
          onInviteChapter={readingActions.inviteCurrentChapter}
          onProgressParagraphChange={readingBook.setProgressParagraph}
          onRegenerateSegment={readingActions.regenerateSegment}
        />
      ) : null}

      {mode === 'notes' && readingBook.book ? (
        <ReadingResultsView
          book={readingBook.book}
          insets={insets}
          results={bookResults}
          onBack={() => setMode('reader')}
          onDeleteNote={(note) => void readingActions.removeNote(note.id).then(refreshBookResults)}
          onExport={readingActions.exportNotes}
          onOpenSource={(chapterIndex, paragraphIndex) => void readingBook.openBook(readingBook.book!, chapterIndex, paragraphIndex)}
          onMemorySaved={refreshBookResults}
          onSaveToNotebook={(item) => void readingActions.saveResultToNotebook(item).then(refreshBookResults)}
        />
      ) : null}

      {recovery ? <ReadingEpubRecoveryModal preview={recovery.preview} busy={busy} insets={insets}
        onClose={() => setRecovery(null)} onConfirm={choice => {
          if (busy) return;
          setBusy(true);
          void recoverLegacyEpubReadingSource(recovery.bookId, choice).then(async saved => {
            if (!saved) throw new Error('reading-start-not-saved');
            const fresh = (await loadReadingLibraryStrict()).find(item => item.id === recovery.bookId);
            const chapter = await loadReadingChapter(recovery.bookId, choice.chapterIndex);
            if (!fresh || !chapter) throw new Error('reading-source-missing');
            const p = chapter.segmentsMeta.find(s => s.segmentIndex === fresh.iReading?.cursor.segmentIndex)?.startP ?? 0;
            setRecovery(null);
            await readingBook.openBook(fresh, chapter.index, p);
          }).catch(error => Alert.alert('尚未完成接读确认', error instanceof Error ? error.message : '保存失败，请重试。'))
            .finally(() => setBusy(false));
        }} /> : null}
      <ReadingModals
        annotationDetail={annotationDetail}
        book={readingBook.book}
        busy={busy}
        chapter={readingBook.chapter}
        insets={insets}
        noteDraft={noteDraft}
        paragraphAction={paragraphAction}
        questionDraft={questionDraft}
        resultActions={resultActions}
        showToc={showToc}
        summaryDetail={summaryDetail}
        onCloseAnnotation={() => setAnnotationDetail(null)}
        onCloseParagraphAction={() => setParagraphAction(null)}
        onCloseSummary={() => setSummaryDetail(null)}
        onCloseToc={() => setShowToc(false)}
        onOpenChapter={(chapterIndex) => {
          setShowToc(false);
          if (readingBook.book) void readingBook.openBook(readingBook.book, chapterIndex, 0);
        }}
        onSaveQuestion={readingActions.saveQuestion}
        onSaveToNotebook={(item) => void readingActions.saveResultToNotebook(item).then(refreshResultActions)}
        onSaveUserNote={readingActions.saveUserNote}
        setNoteDraft={setNoteDraft}
        setParagraphAction={setParagraphAction}
        setQuestionDraft={setQuestionDraft}
      />
    </>
  );
}
