import { Alert } from 'react-native';
import { useRef, useState } from 'react';

import { useAiConfigPreferences } from '../../ai/AiConfigPreferences';
import { createNotebookEntry } from '../../chat/notebookStore';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../../backup/backupRestoreCoordinator';
import { askBaiyunAboutReadingSelection, requestReadingAnnotation } from '../readingAi';
import { exportReadingBookMarkdown } from '../readingExport';
import {
  buildReadingResultNotebookDraft,
} from '../readingMemoryBridge';
import {
  loadReadingResultActions,
  markReadingResultNotebookSaved,
} from '../readingResultActions';
import type { ReadingResultItem } from '../readingResults';
import type { ParagraphActionState } from '../readingUiTypes';
import {
  deleteReadingNote,
  upsertReadingNote,
  loadReadingChapter,
  loadReadingLibraryStrict,
  makeReadingId,
} from '../readingStore';
import type { ReadingBook, ReadingChapter, ReadingSegmentMeta } from '../readingTypes';
import { prepareReadingRegeneration, runReadingSegment } from '../readingSegmentRuntime';
import { beginReadingBudgetRequest } from '../../ai/aiCallBudget';
import { prepareReadingRequestSource } from '../readingIllustratedRequest';

type Options = {
  book: ReadingBook | null;
  busy: boolean;
  chapter: ReadingChapter | null;
  currentSegment: ReadingSegmentMeta | null;
  noteDraft: string;
  paragraphAction: ParagraphActionState | null;
  questionDraft: string;
  reloadCurrentChapter: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setNoteDraft: (value: string) => void;
  setParagraphAction: (value: ParagraphActionState | null) => void;
};

export function useReadingAiActions({
  book,
  busy,
  chapter,
  currentSegment,
  noteDraft,
  paragraphAction,
  questionDraft,
  reloadCurrentChapter,
  setBusy,
  setNoteDraft,
  setParagraphAction,
}: Options) {
  const { chatConnection, chatKey, profile, visionConnection, visionKey } = useAiConfigPreferences();
  const configured = !!chatConnection?.baseUrl.trim() && !!chatConnection.model.trim() && !!chatKey.trim();
  const [batchProgressLabel, setBatchProgressLabel] = useState<string | null>(null);
  const questionInFlight = useRef(false);
  const pendingQuestion = useRef<{
    basis: string;
    dataEpoch: number;
    note: Parameters<typeof upsertReadingNote>[0] & { id: string; createdAt: number };
  } | null>(null);
  const questionBasis = JSON.stringify([book?.id, chapter?.index, paragraphAction?.mode, paragraphAction?.p,
    paragraphAction ? chapter?.paragraphs[paragraphAction.p] ?? '' : '', questionDraft.trim()]);
  if (pendingQuestion.current && (pendingQuestion.current.basis !== questionBasis
    || pendingQuestion.current.dataEpoch !== captureBackupRestoreDataEpoch())) pendingQuestion.current = null;

  const canRunSegment = (segment: ReadingSegmentMeta) =>
    segment.status === 'pending' || segment.status === 'failed' || segment.status === 'stale';

  const runSegmentAnnotation = async (
    segment: ReadingSegmentMeta,
    options: { alertOnFailure: boolean; label?: string },
    dataEpoch: number | null,
  ) => {
    if (!book || !chapter || dataEpoch === null) return false;
    if (!canRunSegment(segment)) {
      if (segment.status === 'annotating' && options.alertOnFailure) {
        Alert.alert('白云正在读', '这一段已经在共读里了，等她读完再继续。');
      }
      return false;
    }
    try {
      if (options.label) setBatchProgressLabel(options.label);
      const latest = await loadReadingChapter(book.id, chapter.index);
      const target = latest?.segmentsMeta.find(s => s.segmentIndex === segment.segmentIndex);
      if (!latest || !target) throw new Error('reading-source-changed');
      const initialActivity = (await loadReadingLibraryStrict()).find(b => b.id === book.id)?.iReading?.activity;
      const prepared = await prepareReadingRequestSource({ apiKey: chatKey, connection: chatConnection, profile, book, chapter: latest, segment: target });
      const result = await runReadingSegment({
        book, ...prepared, kind: 'manual', dataEpoch,
        beforeTransport: async (requestId, transport) => {
          if (transport) await beginReadingBudgetRequest({ connection: transport.connection, requestId, dataEpoch,
            batch: { connections: transport.connections, index: transport.index }, beforeTransport: async () => {
              if (transport.index > 0) {
                if (initialActivity?.status === 'reading') {
                  const current = (await loadReadingLibraryStrict()).find(b => b.id === book.id)?.iReading?.activity;
                  if (current?.id !== initialActivity.id || current.status !== 'reading') throw new Error('reading-activity-paused');
                }
                const { isReadingTransportHostAvailable } = await import('../../life/readingActivityRuntime');
                if (!await isReadingTransportHostAvailable(initialActivity?.status === 'reading' ? initialActivity.focusId : undefined)) {
                  throw new Error('reading-host-deferred');
                }
              }
            } });
        },
        request: beforeTransport => requestReadingAnnotation({
          apiKey: chatKey, book, ...prepared, connection: chatConnection, profile, beforeTransport, visionConnection, visionKey,
        }),
      });
      await reloadCurrentChapter();
      return result.status === 'saved';
    } catch (error) {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
      const message = error instanceof Error ? error.message : '稍后可以重试。';
      await reloadCurrentChapter();
      if (options.alertOnFailure) Alert.alert('白云读这一段失败了', message);
      throw error;
    } finally {
      if (options.label) setBatchProgressLabel(null);
    }
  };

  const inviteBaiyun = async () => {
    if (!book || !chapter || !currentSegment || busy) return;
    if (!configured) {
      Alert.alert('还不能共读', '请先在“白云与连接”里配置并测试模型连接。');
      return;
    }
    setBusy(true);
    try {
      await runSegmentAnnotation(
        currentSegment,
        { alertOnFailure: true },
        captureBackupRestoreDataEpoch(),
      );
    } catch {
      // The segment runner has already saved failed status and shown the retry hint.
    } finally {
      setBusy(false);
    }
  };

  const inviteCurrentChapter = async () => {
    if (!book || !chapter || busy) return;
    if (!configured) {
      Alert.alert('还不能共读', '请先在“白云与连接”里配置并测试模型连接。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    const startIndex = currentSegment?.segmentIndex ?? 0;
    const runnableSegments = chapter.segmentsMeta
      .filter((segment) => segment.segmentIndex >= startIndex)
      .filter(canRunSegment);
    if (!runnableSegments.length) {
      Alert.alert('这一章已经读过啦', '没有需要继续共读的段落。如果想重写某一段，可以点“重新生成这一段”。');
      return;
    }
    setBusy(true);
    try {
      let nextIndex = startIndex;
      while (true) {
        const latest = await loadReadingChapter(book.id, chapter.index);
        const segment = latest?.segmentsMeta.find(s => s.segmentIndex >= nextIndex && canRunSegment(s));
        if (!segment) break;
        try {
          const saved = await runSegmentAnnotation(segment, {
            alertOnFailure: false,
            label: `白云正在读 ${segment.segmentIndex + 1}/${latest!.segmentsMeta.length}`,
          }, dataEpoch);
          if (!saved) return;
          nextIndex = segment.segmentIndex + 1;
        } catch (error) {
          Alert.alert(
            '本章共读停在这里了',
            error instanceof Error ? `${error.message}\n\n前面读完的内容已经保存，可以从失败段继续。` : '前面读完的内容已经保存，可以从失败段继续。',
          );
          return;
        }
      }
      Alert.alert('本章共读完成', '白云已经把这一章能读的段落都读完啦。');
    } finally {
      setBatchProgressLabel(null);
      setBusy(false);
    }
  };

  const regenerateSegment = async (segment: ReadingSegmentMeta) => {
    if (!book || !chapter || busy) return;
    if (!configured) {
      Alert.alert('还不能共读', '请先在“白云与连接”里配置并测试模型连接。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    Alert.alert(
      '重新生成这一段？',
      segment.status === 'done' ? '这会覆盖这一段旧的白云批注和读后感。'
        : '旧请求尚未完成保存。重新生成会再次调用模型，可能再次计费，并覆盖这一段已有的批注和读后感。取消不会更改记录。',
      [
        { text: '先不改', style: 'cancel' },
        {
          text: '重新生成',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setBusy(true);
              let prepared = false;
              try {
                const reset = await prepareReadingRegeneration(book.id, chapter, segment, dataEpoch);
                prepared = true;
                await runSegmentAnnotation(
                  reset.segmentsMeta.find(s => s.segmentIndex === segment.segmentIndex)!,
                  { alertOnFailure: true },
                  dataEpoch,
                );
              } catch {
                // Execution reports its own failure; preparation previously failed silently.
                if (!prepared && canCommitBackupRestoreDataEpoch(dataEpoch)) {
                  Alert.alert('暂未重新生成', '请重新打开这一章核对状态。此次未发起新的模型请求。');
                }
              } finally {
                await reloadCurrentChapter().catch(() => undefined);
                setBusy(false);
              }
            })();
          },
        },
      ],
    );
  };

  const saveQuestion = async () => {
    if (!book || !chapter || paragraphAction?.mode !== 'question' || busy) return;
    const question = questionDraft.trim();
    const selectedText = chapter.paragraphs[paragraphAction.p] ?? '';
    if (!question || !selectedText) return;
    if (!configured) {
      Alert.alert('还不能追问', '请先在“白云与连接”里配置并测试模型连接。');
      return;
    }
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) { pendingQuestion.current = null; return; }
    if (questionInFlight.current) return;
    questionInFlight.current = true;
    setBusy(true);
    let draft = pendingQuestion.current;
    try {
      if (!draft || draft.basis !== questionBasis || draft.dataEpoch !== dataEpoch) {
        draft = { basis: questionBasis, dataEpoch, note: {
          id: makeReadingId('reading-note'),
          createdAt: Date.now(),
          bookId: book.id,
          chapterIndex: chapter.index,
          startP: paragraphAction.p,
          endP: paragraphAction.p,
          selectedText,
          kind: 'question',
          question,
        } };
        pendingQuestion.current = draft;
      }
      if (draft.note.answer === undefined) {
        draft.note.answer = await askBaiyunAboutReadingSelection({
          apiKey: chatKey, book, chapter, connection: chatConnection,
          paragraphIndex: paragraphAction.p, profile, question, selectedText,
        });
      }
      if (pendingQuestion.current !== draft || captureBackupRestoreDataEpoch() !== dataEpoch) {
        if (pendingQuestion.current === draft) pendingQuestion.current = null;
        return;
      }
      const saved = await runBackupRestoreDataEpochCommit(dataEpoch, () => upsertReadingNote(draft!.note));
      if (!saved.committed) { pendingQuestion.current = null; return; }
      await reloadCurrentChapter();
      if (pendingQuestion.current === draft) {
        pendingQuestion.current = null;
        setParagraphAction(null);
      }
    } catch (error) {
      if (pendingQuestion.current === draft && (draft?.note.answer === undefined
        || captureBackupRestoreDataEpoch() !== dataEpoch)) pendingQuestion.current = null;
      Alert.alert('追问失败', error instanceof Error ? error.message : '稍后可以重试。');
    } finally {
      questionInFlight.current = false;
      setBusy(false);
    }
  };

  const saveUserNote = async () => {
    if (!book || !chapter || paragraphAction?.mode !== 'note') return;
    const note = noteDraft.trim();
    const selectedText = chapter.paragraphs[paragraphAction.p] ?? '';
    if (!note || !selectedText) return;
    const saved = await runBackupRestoreDataEpochCommit(
      captureBackupRestoreDataEpoch(),
      () => upsertReadingNote({
        bookId: book.id,
        chapterIndex: chapter.index,
        startP: paragraphAction.p,
        endP: paragraphAction.p,
        selectedText,
        kind: 'my-note',
        note,
      }),
    );
    if (!saved.committed) return;
    await reloadCurrentChapter();
    setNoteDraft('');
    setParagraphAction(null);
  };

  const saveResultToNotebook = async (item: ReadingResultItem) => {
    if (!book) return;
    const saved = await runBackupRestoreDataEpochCommit(captureBackupRestoreDataEpoch(), async () => {
      const actions = await loadReadingResultActions(book.id);
      if (item.actions?.notebookEntryId || actions[item.id]?.notebookEntryId) {
        return { status: 'exists' as const };
      }
      const entry = await createNotebookEntry(buildReadingResultNotebookDraft(book, item));
      if (entry) {
        await markReadingResultNotebookSaved(book.id, item.id, entry.id);
      }
      return { status: entry ? 'saved' as const : 'failed' as const };
    });
    if (!saved.committed) return;
    if (saved.value.status === 'exists') {
      Alert.alert('已经记到小本本', '这条共读小纸条已经在白云小本本里啦。');
      return;
    }
    Alert.alert(
      saved.value.status === 'saved' ? '已记到小本本' : '这条没写进去',
      saved.value.status === 'saved' ? '白云小本本多了一页共读小纸条。' : '内容太短或格式不适合小本本。',
    );
  };

  const exportNotes = async () => {
    if (!book || busy) return;
    setBusy(true);
    try {
      await exportReadingBookMarkdown(book);
    } catch (error) {
      Alert.alert('导出失败', error instanceof Error ? error.message : '这本书的共读笔记暂时导不出来。');
    } finally {
      setBusy(false);
    }
  };

  const removeNote = async (noteId: string) => {
    if (!book) return;
    const removed = await runBackupRestoreDataEpochCommit(
      captureBackupRestoreDataEpoch(),
      () => deleteReadingNote(book.id, noteId),
    );
    if (!removed.committed) return;
    await reloadCurrentChapter();
  };

  return {
    batchProgressLabel,
    exportNotes,
    inviteCurrentChapter,
    inviteBaiyun,
    regenerateSegment,
    removeNote,
    saveQuestion,
    saveResultToNotebook,
    saveUserNote,
  };
}
