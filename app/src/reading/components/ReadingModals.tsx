import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { AppText as Text, AppTextInput as TextInput } from '../../components/AppText';
import { truncate } from '../readingFormat';
import type { ReadingResultActionMap } from '../readingResultActions';
import { buildReadingAnnotationResultItem, buildReadingSummaryResultItem } from '../readingResults';
import { loadReadingChapter } from '../readingStore';
import type { ReadingResultItem } from '../readingResults';
import type { ParagraphActionState } from '../readingUiTypes';
import type {
  ReadingAnnotation,
  ReadingBook,
  ReadingChapter,
  ReadingSegmentSummary,
} from '../readingTypes';
import { readingStyles as styles } from './readingStyles';

type Props = {
  annotationDetail: ReadingAnnotation | null;
  book: ReadingBook | null;
  busy: boolean;
  chapter: ReadingChapter | null;
  insets: EdgeInsets;
  noteDraft: string;
  paragraphAction: ParagraphActionState | null;
  questionDraft: string;
  resultActions: ReadingResultActionMap;
  showToc: boolean;
  summaryDetail: ReadingSegmentSummary | null;
  onCloseAnnotation: () => void;
  onCloseParagraphAction: () => void;
  onCloseSummary: () => void;
  onCloseToc: () => void;
  onOpenChapter: (chapterIndex: number) => void;
  onSaveQuestion: () => void;
  onSaveToNotebook: (item: ReadingResultItem) => void;
  onSaveUserNote: () => void;
  setNoteDraft: (value: string) => void;
  setParagraphAction: (action: ParagraphActionState | null) => void;
  setQuestionDraft: (value: string) => void;
};

type TocItem = {
  index: number;
  status: string;
  title: string;
};

export function ReadingCenteredModal({
  children,
  insets,
  onRequestClose,
  visible,
}: {
  children: ReactNode;
  insets: EdgeInsets;
  onRequestClose: () => void;
  visible: boolean;
}) {
  const windowDimensions = useWindowDimensions();
  const verticalPadding = Math.max(insets.top, 24) + Math.max(insets.bottom, 24) + 32;
  const panelHeight = Math.max(
    320,
    Math.min(windowDimensions.height * 0.72, windowDimensions.height - verticalPadding),
  );

  return (
    <Modal transparent visible={visible} animationType="fade" onRequestClose={onRequestClose}>
      <View
        style={[
          styles.readingModalLayer,
          {
            paddingBottom: Math.max(insets.bottom, 24),
            paddingTop: Math.max(insets.top, 24),
          },
        ]}
      >
        <Pressable onPress={onRequestClose} style={styles.readingModalScrim} />
        <View style={[styles.readingModalPanel, { height: panelHeight }]}>
          {children}
        </View>
      </View>
    </Modal>
  );
}

export function ReadingModals({
  annotationDetail,
  book,
  busy,
  chapter,
  insets,
  noteDraft,
  paragraphAction,
  questionDraft,
  resultActions,
  showToc,
  summaryDetail,
  onCloseAnnotation,
  onCloseParagraphAction,
  onCloseSummary,
  onCloseToc,
  onOpenChapter,
  onSaveQuestion,
  onSaveToNotebook,
  onSaveUserNote,
  setNoteDraft,
  setParagraphAction,
  setQuestionDraft,
}: Props) {
  const [tocItems, setTocItems] = useState<TocItem[]>([]);
  const annotationResult = annotationDetail
    ? buildReadingAnnotationResultItem(chapter, annotationDetail, resultActions)
    : null;
  const summaryResult = summaryDetail
    ? buildReadingSummaryResultItem(chapter, summaryDetail, resultActions)
    : null;

  useEffect(() => {
    let cancelled = false;
    if (!showToc || !book) {
      setTocItems([]);
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(
      Array.from({ length: book.totalChapters }, async (_item, index) => {
        const tocChapter = await loadReadingChapter(book.id, index);
        const totalSegments = tocChapter?.segmentsMeta.length ?? 0;
        const doneSegments = tocChapter?.segmentsMeta.filter((segment) => segment.status === 'done').length ?? 0;
        const failedSegments = tocChapter?.segmentsMeta.filter((segment) => segment.status === 'failed').length ?? 0;
        const staleSegments = tocChapter?.segmentsMeta.filter((segment) => segment.status === 'stale').length ?? 0;
        const statusSuffix = failedSegments
          ? ` · ${failedSegments} 段失败`
          : staleSegments
            ? ` · ${staleSegments} 段中断`
            : '';
        return {
          index,
          status: tocChapter ? `${doneSegments}/${totalSegments} 段${statusSuffix}` : '未加载',
          title: tocChapter?.title?.trim() || `第 ${index + 1} 章`,
        };
      }),
    )
      .then((items) => {
        if (!cancelled) setTocItems(items);
      })
      .catch(() => {
        if (!cancelled) {
          setTocItems(Array.from({ length: book.totalChapters }, (_item, index) => ({
            index,
            status: '未加载',
            title: `第 ${index + 1} 章`,
          })));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [book, showToc]);

  return (
    <>
      <ReadingCenteredModal visible={!!annotationDetail} insets={insets} onRequestClose={onCloseAnnotation}>
        <ScrollView style={styles.readingModalScroll} contentContainerStyle={styles.readingModalContent}>
          <Text style={styles.sheetTitle}>白云批注</Text>
          {annotationDetail?.createdAt ? <Text style={styles.resultMeta}>{new Date(annotationDetail.createdAt).toLocaleString('zh-CN')}</Text> : null}
          <Text style={styles.sheetQuote}>{annotationResult?.sourceExcerpt ?? ''}</Text>
          <Text style={styles.sheetText}>{annotationDetail?.text}</Text>
        </ScrollView>
        <View style={styles.sheetActions}>
          <Pressable onPress={() => annotationResult && onSaveToNotebook(annotationResult)} style={styles.sheetButton}>
            <Text style={styles.sheetButtonText}>{annotationResult?.actions?.notebookEntryId ? '已记到小本本' : '记到小本本'}</Text>
          </Pressable>
          <Pressable onPress={onCloseAnnotation} style={styles.sheetButtonPrimary}><Text style={styles.sheetButtonPrimaryText}>收起</Text></Pressable>
        </View>
      </ReadingCenteredModal>

      <ReadingCenteredModal visible={!!summaryDetail} insets={insets} onRequestClose={onCloseSummary}>
        <ScrollView style={styles.readingModalScroll} contentContainerStyle={styles.readingModalContent}>
          <Text style={styles.sheetTitle}>白云读后感</Text>
          {summaryDetail?.createdAt ? <Text style={styles.resultMeta}>{new Date(summaryDetail.createdAt).toLocaleString('zh-CN')}</Text> : null}
          <Text style={styles.sheetText}>{summaryDetail?.summary}</Text>
        </ScrollView>
        <View style={styles.sheetActions}>
          <Pressable onPress={() => summaryResult && onSaveToNotebook(summaryResult)} style={styles.sheetButton}>
            <Text style={styles.sheetButtonText}>{summaryResult?.actions?.notebookEntryId ? '已记到小本本' : '记到小本本'}</Text>
          </Pressable>
          <Pressable onPress={onCloseSummary} style={styles.sheetButtonPrimary}><Text style={styles.sheetButtonPrimaryText}>收起</Text></Pressable>
        </View>
      </ReadingCenteredModal>

      <ReadingCenteredModal visible={showToc} insets={insets} onRequestClose={onCloseToc}>
        <Text style={styles.sheetTitle}>目录</Text>
        <ScrollView style={styles.readingModalScroll} contentContainerStyle={styles.readingModalContent}>
          {tocItems.map((item) => {
            const active = chapter?.index === item.index;
            return (
              <Pressable key={item.index} onPress={() => onOpenChapter(item.index)} style={[styles.tocRow, active && styles.tocRowActive]}>
                <Text style={[styles.tocText, active && styles.tocTextActive]} numberOfLines={1}>{item.title}</Text>
                <Text style={styles.tocMeta}>{item.status}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
        <Pressable onPress={onCloseToc} style={[styles.sheetButtonPrimary, styles.readingModalFooterButton]}><Text style={styles.sheetButtonPrimaryText}>收起</Text></Pressable>
      </ReadingCenteredModal>

      <ReadingCenteredModal visible={!!paragraphAction} insets={insets} onRequestClose={onCloseParagraphAction}>
        <ScrollView style={styles.readingModalScroll} contentContainerStyle={styles.readingModalContent}>
          <Text style={styles.sheetTitle}>P{paragraphAction?.p ?? ''}</Text>
          <Text style={styles.sheetQuote}>{paragraphAction && chapter ? truncate(chapter.paragraphs[paragraphAction.p] ?? '', 240) : ''}</Text>
          {paragraphAction?.mode === 'question' ? (
            <>
              <Text style={styles.sheetHint}>白云只看你读到这里以前的内容。</Text>
              <TextInput value={questionDraft} onChangeText={setQuestionDraft} multiline style={styles.sheetInput} placeholder="想问白云什么？" placeholderTextColor="#8AA0B4" />
            </>
          ) : null}
          {paragraphAction?.mode === 'note' ? (
            <TextInput value={noteDraft} onChangeText={setNoteDraft} multiline style={styles.sheetInput} placeholder="写下你的读书笔记..." placeholderTextColor="#8AA0B4" />
          ) : null}
        </ScrollView>
        {paragraphAction?.mode === 'menu' ? (
          <View style={styles.sheetActionsVertical}>
            <Pressable onPress={() => setParagraphAction(paragraphAction ? { ...paragraphAction, mode: 'question' } : null)} style={[styles.sheetButtonPrimary, styles.readingModalFooterButton]}><Text style={styles.sheetButtonPrimaryText}>问白云</Text></Pressable>
            <Pressable onPress={() => setParagraphAction(paragraphAction ? { ...paragraphAction, mode: 'note' } : null)} style={[styles.sheetButton, styles.readingModalFooterButton]}><Text style={styles.sheetButtonText}>记笔记</Text></Pressable>
            <Pressable onPress={onCloseParagraphAction} style={[styles.sheetButton, styles.readingModalFooterButton]}><Text style={styles.sheetButtonText}>取消</Text></Pressable>
          </View>
        ) : null}
        {paragraphAction?.mode === 'question' ? (
          <Pressable disabled={busy || !questionDraft.trim()} onPress={onSaveQuestion} style={[styles.sheetButtonPrimary, styles.readingModalFooterButton, (busy || !questionDraft.trim()) && styles.disabled]}><Text style={styles.sheetButtonPrimaryText}>{busy ? '正在问' : '保存问答'}</Text></Pressable>
        ) : null}
        {paragraphAction?.mode === 'note' ? (
          <Pressable disabled={!noteDraft.trim()} onPress={onSaveUserNote} style={[styles.sheetButtonPrimary, styles.readingModalFooterButton, !noteDraft.trim() && styles.disabled]}><Text style={styles.sheetButtonPrimaryText}>保存笔记</Text></Pressable>
        ) : null}
      </ReadingCenteredModal>
    </>
  );
}
