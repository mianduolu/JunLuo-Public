import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Image, Pressable, ScrollView, View } from 'react-native';
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../../components/AppText';
import type { ParagraphActionState, ReaderThemeName, ScreenMode } from '../readingUiTypes';
import type {
  ReadingAnnotation,
  ReadingBook,
  ReadingChapter,
  ReadingContentBlock,
  ReadingImage,
  ReadingSegmentMeta,
  ReadingSegmentSummary,
} from '../readingTypes';
import { readingStyles as styles } from './readingStyles';
import { canRegenerateReadingSegment } from '../readingSegmentRuntime';

type ReaderTheme = {
  annotationChip: string;
  annotationText: string;
  border: string;
  chip: string;
  chipText: string;
  label: string;
  meta: string;
  page: string;
  primary: string;
  primaryText: string;
  quote: string;
  surface: string;
  text: string;
  tool: string;
  toolText: string;
};

const readerThemes: Record<ReaderThemeName, ReaderTheme> = {
  paper: {
    annotationChip: '#E6F1E6',
    annotationText: '#5A825F',
    border: '#E8DEC9',
    chip: '#EEE6D8',
    chipText: '#8A765F',
    label: '纸页',
    meta: '#8A765F',
    page: '#FBF8F1',
    primary: '#7BA882',
    primaryText: '#FFFFFF',
    quote: '#FFF0D7',
    surface: '#FBF8F1',
    text: '#2C2A25',
    tool: '#EFE6D5',
    toolText: '#735E44',
  },
  green: {
    annotationChip: '#DDEDDD',
    annotationText: '#456D4B',
    border: '#D3E3D2',
    chip: '#E2ECD8',
    chipText: '#64764A',
    label: '护眼',
    meta: '#70816C',
    page: '#F1F7EF',
    primary: '#6F9D78',
    primaryText: '#FFFFFF',
    quote: '#F3E9C9',
    surface: '#F7FBF5',
    text: '#273426',
    tool: '#E1EBD9',
    toolText: '#566B42',
  },
  night: {
    annotationChip: '#263F35',
    annotationText: '#AAD4B4',
    border: '#2E3B46',
    chip: '#2E3540',
    chipText: '#C9BFAE',
    label: '夜间',
    meta: '#AFA496',
    page: '#161D24',
    primary: '#5D8768',
    primaryText: '#F7FAF8',
    quote: '#3A3127',
    surface: '#1E2730',
    text: '#ECE7DD',
    tool: '#2A3440',
    toolText: '#E2D9C8',
  },
};

const lineHeightOptions = [1.55, 1.75, 1.95];
const paragraphSpacingOptions = [12, 18, 24];
const themeOptions: ReaderThemeName[] = ['paper', 'green', 'night'];

type Props = {
  annotationsByP: Map<number, ReadingAnnotation[]>;
  book: ReadingBook;
  batchProgressLabel: string | null;
  busy: boolean;
  chapter: ReadingChapter;
  activeSegment: ReadingSegmentMeta | null;
  currentSegment: ReadingSegmentMeta | null;
  doneSegments: number;
  fontSize: number;
  insets: EdgeInsets;
  lineHeightMultiplier: number;
  paragraphSpacing: number;
  readerTheme: ReaderThemeName;
  scrollRef: RefObject<ScrollView | null>;
  setAnnotationDetail: (annotation: ReadingAnnotation) => void;
  setFontSize: (updater: (size: number) => number) => void;
  setLineHeightMultiplier: (updater: (value: number) => number) => void;
  setMode: (mode: ScreenMode) => void;
  setParagraphAction: (action: ParagraphActionState) => void;
  setParagraphSpacing: (updater: (value: number) => number) => void;
  setReaderTheme: (updater: (theme: ReaderThemeName) => ReaderThemeName) => void;
  setShowToc: (value: boolean) => void;
  setSummaryDetail: (summary: ReadingSegmentSummary) => void;
  summaryByEndP: Map<number, ReadingSegmentSummary>;
  onChangeChapter: (direction: -1 | 1) => void;
  onCloseReader: () => void;
  onInviteChapter: () => void;
  onInviteBaiyun: () => void;
  onConfirmReadingStart: () => void;
  onProgressParagraphChange: (paragraphIndex: number) => void;
  onRegenerateSegment: (segment: ReadingSegmentMeta) => void;
};

function nextOption<T>(options: T[], current: T) {
  const index = options.findIndex((item) => item === current);
  return options[(index + 1) % options.length] ?? options[0];
}

function ReadingInlineImage({ image, color }: { image?: ReadingImage; color: string }) {
  const [failed, setFailed] = useState(false);
  if (!image || failed) return <Text style={{ color, paddingVertical: 16 }}>插图暂时无法显示。</Text>;
  return <Image source={{ uri: image.uri }} resizeMode="contain" accessibilityLabel="原书插图"
    onError={() => setFailed(true)} style={{ width: '100%', aspectRatio: image.width / image.height }} />;
}

export function ReadingReaderView({
  annotationsByP,
  activeSegment,
  batchProgressLabel,
  book,
  busy,
  chapter,
  currentSegment,
  doneSegments,
  fontSize,
  insets,
  lineHeightMultiplier,
  paragraphSpacing,
  readerTheme,
  scrollRef,
  setAnnotationDetail,
  setFontSize,
  setLineHeightMultiplier,
  setMode,
  setParagraphAction,
  setParagraphSpacing,
  setReaderTheme,
  setShowToc,
  setSummaryDetail,
  summaryByEndP,
  onChangeChapter,
  onCloseReader,
  onInviteChapter,
  onInviteBaiyun,
  onConfirmReadingStart,
  onProgressParagraphChange,
  onRegenerateSegment,
}: Props) {
  const paragraphOffsetsRef = useRef<Record<number, number>>({});
  const lastProgressParagraphRef = useRef(book.currentParagraph);
  const restoreParagraphRef = useRef(book.currentParagraph);
  const restoredAnchorRef = useRef('');
  const restoreTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const theme = readerThemes[readerTheme];
  const contentBlocks: ReadingContentBlock[] = chapter.contentBlocks?.length ? chapter.contentBlocks
    : chapter.paragraphs.map((paragraph, paragraphIndex) => ({ kind: 'text', paragraphIndex, startOffset: 0, endOffset: paragraph.length }));
  const firstTextBlock = new Map<number, number>();
  const lastTextBlock = new Map<number, number>();
  contentBlocks.forEach((block, position) => {
    if (block.kind !== 'text') return;
    if (!firstTextBlock.has(block.paragraphIndex)) firstTextBlock.set(block.paragraphIndex, position);
    lastTextBlock.set(block.paragraphIndex, position);
  });

  useEffect(() => {
    const restoreParagraph = Math.max(0, Math.min(chapter.paragraphs.length - 1, book.currentParagraph));
    paragraphOffsetsRef.current = {};
    lastProgressParagraphRef.current = restoreParagraph;
    restoreParagraphRef.current = restoreParagraph;
    restoredAnchorRef.current = '';
    return () => {
      if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
    };
  }, [book.currentParagraph, book.id, chapter.index, chapter.paragraphs.length]);

  useEffect(() => {
    restoreParagraphRef.current = lastProgressParagraphRef.current;
    restoredAnchorRef.current = '';
  }, [fontSize, lineHeightMultiplier, paragraphSpacing]);

  const scrollToParagraph = (paragraphIndex: number, animated = false) => {
    const y = paragraphOffsetsRef.current[paragraphIndex];
    if (typeof y !== 'number') return;
    scrollRef.current?.scrollTo({ y: Math.max(0, y - 18), animated });
  };

  const handleParagraphLayout = (index: number, event: LayoutChangeEvent) => {
    paragraphOffsetsRef.current[index] = event.nativeEvent.layout.y;
    const restoreParagraph = restoreParagraphRef.current;
    const restoreKey = `${book.id}:${chapter.index}:${restoreParagraph}:${fontSize}:${lineHeightMultiplier}:${paragraphSpacing}`;
    if (index !== restoreParagraph || restoredAnchorRef.current === restoreKey) return;
    restoredAnchorRef.current = restoreKey;
    if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
    restoreTimeoutRef.current = setTimeout(() => scrollToParagraph(restoreParagraph), 80);
  };

  const paragraphFromScroll = (scrollY: number) => {
    const targetY = scrollY + 24;
    let current = lastProgressParagraphRef.current;
    for (let index = 0; index < chapter.paragraphs.length; index += 1) {
      const offset = paragraphOffsetsRef.current[index];
      if (typeof offset !== 'number') continue;
      if (offset <= targetY) current = index;
      if (offset > targetY) break;
    }
    return current;
  };

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const paragraphIndex = paragraphFromScroll(event.nativeEvent.contentOffset.y);
    if (paragraphIndex === lastProgressParagraphRef.current) return;
    lastProgressParagraphRef.current = paragraphIndex;
    onProgressParagraphChange(paragraphIndex);
  };

  const cycleLineHeight = () => {
    setLineHeightMultiplier((current) => nextOption(lineHeightOptions, current));
  };

  const cycleParagraphSpacing = () => {
    setParagraphSpacing((current) => nextOption(paragraphSpacingOptions, current));
  };

  const cycleTheme = () => {
    setReaderTheme((current) => nextOption(themeOptions, current));
  };
  const currentSegmentBusy = currentSegment?.status === 'annotating';
  const regenerationAvailable = canRegenerateReadingSegment(book.id, chapter.index, activeSegment);
  const inviteDisabled = !currentSegment || busy || currentSegmentBusy;
  const currentStatusLabel = regenerationAvailable && activeSegment?.status !== 'done' ? '保存待处理' : activeSegment
    ? {
      annotating: '正在读',
      done: '已共读',
      failed: '失败可重试',
      pending: '待共读',
      stale: '上次中断',
    }[activeSegment.status]
    : '无段落';
  const currentStatusDetail = activeSegment
    ? `第 ${activeSegment.segmentIndex + 1}/${chapter.segmentsMeta.length} 段 · P${activeSegment.startP}-P${activeSegment.endP}`
    : '这一章暂时没有可共读的段落';
  const inviteLabel = batchProgressLabel ??
    (busy
      ? '白云正在读'
      : currentSegment?.status === 'failed' || currentSegment?.status === 'stale'
        ? '重试这一段'
        : currentSegment
          ? '邀请共读'
          : '本章已共读');

  return (
    <View style={[styles.readerPage, { backgroundColor: theme.page, paddingTop: Math.max(insets.top + 10, 34) }]}>
      <View style={[styles.readerTopbar, { backgroundColor: theme.page }]}>
        <Pressable onPress={onCloseReader} style={styles.iconButton}>
          <Text style={[styles.backText, { color: theme.text }]}>‹</Text>
        </Pressable>
        <View style={styles.readerTitleBlock}>
          <Text numberOfLines={1} style={[styles.readerTitle, { color: theme.text }]}>{chapter.title}</Text>
          <Text style={[styles.readerMeta, { color: theme.meta }]}>{doneSegments}/{chapter.segmentsMeta.length} 段已共读</Text>
        </View>
        <Pressable onPress={() => setMode('notes')} style={[styles.smallGhostButton, { backgroundColor: theme.tool }]}><Text style={[styles.smallGhostText, { color: theme.toolText }]}>成果</Text></Pressable>
        <Pressable onPress={() => setShowToc(true)} style={[styles.smallGhostButton, { backgroundColor: theme.tool }]}><Text style={[styles.smallGhostText, { color: theme.toolText }]}>目录</Text></Pressable>
      </View>

      <View style={[styles.readerToolbarStack, { backgroundColor: theme.page }]}>
        {!book.iReading || book.iReading.needsSourceConfirmation ? (
          <Pressable disabled={busy || !currentSegment} onPress={onConfirmReadingStart}
            style={[styles.smallGhostButton, { backgroundColor: theme.chip }]}>
            <Text style={[styles.toolButtonText, { color: theme.toolText }]}>设为云的接读起点</Text>
          </Pressable>
        ) : null}
        <View style={styles.segmentStatusRow}>
          <View style={[styles.segmentStatusChip, { backgroundColor: theme.chip }]}>
            <Text style={[styles.segmentStatusText, { color: theme.chipText }]}>{currentStatusLabel}</Text>
            <Text style={[styles.segmentStatusMeta, { color: theme.meta }]}>{currentStatusDetail}</Text>
          </View>
          {activeSegment && regenerationAvailable ? (
            <Pressable disabled={busy} onPress={() => onRegenerateSegment(activeSegment)} style={[styles.regenerateButton, { backgroundColor: theme.tool }, busy && styles.disabled]}>
              <Text style={[styles.regenerateButtonText, { color: theme.toolText }]}>重新生成</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.readerInviteRow}>
          <Pressable disabled={inviteDisabled} onPress={onInviteBaiyun} style={[styles.readTogetherFullButton, { backgroundColor: theme.primary }, inviteDisabled && styles.disabled]}>
            <Text style={[styles.readTogetherText, { color: theme.primaryText }]}>{inviteLabel}</Text>
          </Pressable>
          <Pressable disabled={busy || !currentSegment} onPress={onInviteChapter} style={[styles.readChapterButton, { backgroundColor: theme.tool }, (busy || !currentSegment) && styles.disabled]}>
            <Text style={[styles.readChapterButtonText, { color: theme.toolText }]}>本章共读</Text>
          </Pressable>
        </View>
        <View style={styles.readerControlsRow}>
          <Pressable onPress={() => setFontSize((size) => Math.max(15, size - 1))} style={[styles.toolButton, { backgroundColor: theme.tool }]}><Text style={[styles.toolButtonText, { color: theme.toolText }]}>A-</Text></Pressable>
          <Pressable onPress={() => setFontSize((size) => Math.min(26, size + 1))} style={[styles.toolButton, { backgroundColor: theme.tool }]}><Text style={[styles.toolButtonText, { color: theme.toolText }]}>A+</Text></Pressable>
          <Pressable onPress={cycleLineHeight} style={[styles.toolButtonWide, { backgroundColor: theme.tool }]}><Text style={[styles.toolButtonText, { color: theme.toolText }]}>行距</Text></Pressable>
          <Pressable onPress={cycleParagraphSpacing} style={[styles.toolButtonWide, { backgroundColor: theme.tool }]}><Text style={[styles.toolButtonText, { color: theme.toolText }]}>段距</Text></Pressable>
          <Pressable onPress={cycleTheme} style={[styles.toolButtonWide, { backgroundColor: theme.tool }]}><Text style={[styles.toolButtonText, { color: theme.toolText }]}>{theme.label}</Text></Pressable>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.readerContent,
          { backgroundColor: theme.page, paddingBottom: Math.max(insets.bottom + 118, 148) },
        ]}
        onScroll={handleScroll}
        scrollEventThrottle={80}
      >
        {contentBlocks.map((block, position) => {
          if (block.kind === 'image') {
            const image = chapter.images?.find(item => item.id === block.imageId);
            return <View key={`image-${block.imageId}-${position}`} style={{ marginBottom: paragraphSpacing }}>
              <ReadingInlineImage key={`${image?.uri}:${image?.contentVersion}`} image={image} color={theme.meta} />
            </View>;
          }
          const index = block.paragraphIndex;
          const paragraph = (chapter.paragraphs[index] ?? '').slice(block.startOffset, block.endOffset);
          const lastPiece = lastTextBlock.get(index) === position;
          const paragraphAnnotations = lastPiece ? annotationsByP.get(index) ?? [] : [];
          const paragraphSummary = lastPiece ? summaryByEndP.get(index) : undefined;
          return (
            <View
              key={`${book.id}-${chapter.index}-${index}-${position}`}
              onLayout={firstTextBlock.get(index) === position ? (event) => handleParagraphLayout(index, event) : undefined}
              style={[styles.paragraphBlock, { marginBottom: paragraphSpacing }]}
            >
              <Pressable onLongPress={() => setParagraphAction({ p: index, mode: 'menu' })}>
                <Text
                  style={[
                    styles.paragraphText,
                    {
                      color: theme.text,
                      fontSize,
                      lineHeight: Math.round(fontSize * lineHeightMultiplier),
                    },
                  ]}
                >
                  {paragraph}
                </Text>
              </Pressable>
              {lastPiece ? <View style={styles.paragraphActions}>
                <Pressable onPress={() => setParagraphAction({ p: index, mode: 'menu' })} style={[styles.paragraphChip, { backgroundColor: theme.chip }]}>
                  <Text style={[styles.paragraphChipText, { color: theme.chipText }]}>P{index}</Text>
                </Pressable>
                {paragraphSummary ? (
                  <Pressable onPress={() => setSummaryDetail(paragraphSummary)} style={[styles.summaryChip, { backgroundColor: theme.quote }]}>
                    <Text style={styles.summaryChipText}>白云读后感</Text>
                  </Pressable>
                ) : null}
              </View> : null}
              {paragraphAnnotations.map((annotation) => (
                <Pressable key={annotation.id} onPress={() => setAnnotationDetail(annotation)} style={[styles.annotationChip, { backgroundColor: theme.annotationChip }]}>
                  <Text style={[styles.annotationChipText, { color: theme.annotationText }]}>{annotation.text}</Text>
                </Pressable>
              ))}
            </View>
          );
        })}
        {!chapter.paragraphs.length ? [...summaryByEndP.values()].map(summary => <Pressable
          key={`image-summary-${summary.segmentIndex}`} onPress={() => setSummaryDetail(summary)} style={[styles.summaryChip, { backgroundColor: theme.quote }]}>
          <Text style={styles.summaryChipText}>白云读后感</Text>
        </Pressable>) : null}
      </ScrollView>

      <View style={[styles.readerBottom, { backgroundColor: theme.surface, borderTopColor: theme.border, paddingBottom: Math.max(insets.bottom + 14, 28) }]}>
        <Pressable disabled={chapter.index <= 0 || busy} onPress={() => onChangeChapter(-1)} style={[styles.navButton, { backgroundColor: theme.tool }, chapter.index <= 0 && styles.disabled]}><Text style={[styles.navButtonText, { color: theme.toolText }]}>上一章</Text></Pressable>
        <Text style={[styles.chapterProgress, { color: theme.meta }]}>第 {chapter.index + 1} / {book.totalChapters} 章</Text>
        <Pressable disabled={chapter.index >= book.totalChapters - 1 || busy} onPress={() => onChangeChapter(1)} style={[styles.navButton, { backgroundColor: theme.tool }, chapter.index >= book.totalChapters - 1 && styles.disabled]}><Text style={[styles.navButtonText, { color: theme.toolText }]}>下一章</Text></Pressable>
      </View>
    </View>
  );
}
