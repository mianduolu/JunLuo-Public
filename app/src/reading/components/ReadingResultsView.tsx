import { Pressable, ScrollView, View } from 'react-native';
import { useState } from 'react';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../../components/AppText';
import { ReadingMemoryConfirmation } from './ReadingMemoryConfirmation';
import type { ReadingBookResults, ReadingResultItem, ReadingResultSection } from '../readingResults';
import type { ReadingBook, ReadingNote } from '../readingTypes';
import { readingStyles as styles } from './readingStyles';

type Props = {
  book: ReadingBook;
  insets: EdgeInsets;
  results: ReadingBookResults;
  onBack: () => void;
  onDeleteNote: (note: ReadingNote) => void;
  onExport: () => void;
  onOpenSource: (chapterIndex: number, paragraphIndex: number) => void;
  onMemorySaved: () => Promise<void>;
  onSaveToNotebook: (item: ReadingResultItem) => void;
};

function ResultCard({
  item,
  onDeleteNote,
  onOpenSource,
  onRememberResult,
  onSaveToNotebook,
}: {
  item: ReadingResultItem;
  onDeleteNote: (note: ReadingNote) => void;
  onOpenSource: (chapterIndex: number, paragraphIndex: number) => void;
  onRememberResult: (item: ReadingResultItem) => void;
  onSaveToNotebook: (item: ReadingResultItem) => void;
}) {
  const note = item.note;
  const savedToNotebook = !!item.actions?.notebookEntryId;
  const savedToMemory = !!item.actions?.memoryId;
  return (
    <View style={styles.resultCard}>
      <Text style={styles.resultEyebrow}>{item.title} · {item.positionLabel}</Text>
      {item.historicalSource ? <Text style={styles.resultMeta}>旧版记录 · {item.chapterTitle}{item.sourceAvailable === false ? ' · 未对应新版原文' : ''}</Text> : null}
      {Number.isFinite(item.createdAt) && item.createdAt > 0 ? <Text style={styles.resultMeta}>{new Date(item.createdAt).toLocaleString('zh-CN')}</Text> : null}
      {item.sourceExcerpt ? <Text style={styles.resultQuote}>{item.sourceExcerpt}</Text> : null}
      {note?.question ? <Text style={styles.resultText}>问：{note.question}</Text> : null}
      {item.text ? <Text style={styles.resultText}>{item.kind === 'question' ? `白云：${item.text}` : item.text}</Text> : null}
      {item.kind === 'annotation' && !item.historicalSource ? <Text style={styles.resultMeta}>白云批注不能在这里单条删除；回到原文后可以重新生成这一段。</Text> : null}
      <View style={styles.resultActionRow}>
        {item.sourceAvailable !== false ? <Pressable onPress={() => onOpenSource(item.chapterIndex, item.sortP)} style={styles.resultAction}><Text style={styles.resultActionText}>回到原文</Text></Pressable> : null}
        <Pressable onPress={() => onSaveToNotebook(item)} style={[styles.resultAction, savedToNotebook && styles.resultActionSaved]}>
          <Text style={[styles.resultActionText, savedToNotebook && styles.resultActionSavedText]}>{savedToNotebook ? '已记到小本本' : '记到小本本'}</Text>
        </Pressable>
        <Pressable onPress={() => onRememberResult(item)} style={[styles.resultAction, savedToMemory && styles.resultActionSaved]}>
          <Text style={[styles.resultActionText, savedToMemory && styles.resultActionSavedText]}>{savedToMemory ? '已放进长期记忆' : '我想把共读的这段记住'}</Text>
        </Pressable>
        {note ? (
          <Pressable onPress={() => onDeleteNote(note)} style={styles.deleteAction}><Text style={styles.deleteActionText}>删除</Text></Pressable>
        ) : null}
      </View>
    </View>
  );
}

function ResultGroup({
  items,
  title,
  onDeleteNote,
  onOpenSource,
  onRememberResult,
  onSaveToNotebook,
}: {
  items: ReadingResultItem[];
  title: string;
  onDeleteNote: (note: ReadingNote) => void;
  onOpenSource: (chapterIndex: number, paragraphIndex: number) => void;
  onRememberResult: (item: ReadingResultItem) => void;
  onSaveToNotebook: (item: ReadingResultItem) => void;
}) {
  if (!items.length) return null;
  return (
    <View style={styles.resultGroup}>
      <Text style={styles.resultGroupTitle}>{title}</Text>
      {items.map((item) => (
        <ResultCard
          key={item.id}
          item={item}
          onDeleteNote={onDeleteNote}
          onOpenSource={onOpenSource}
          onRememberResult={onRememberResult}
          onSaveToNotebook={onSaveToNotebook}
        />
      ))}
    </View>
  );
}

function ResultSection({
  section,
  onDeleteNote,
  onOpenSource,
  onRememberResult,
  onSaveToNotebook,
}: {
  section: ReadingResultSection;
  onDeleteNote: (note: ReadingNote) => void;
  onOpenSource: (chapterIndex: number, paragraphIndex: number) => void;
  onRememberResult: (item: ReadingResultItem) => void;
  onSaveToNotebook: (item: ReadingResultItem) => void;
}) {
  return (
    <View style={styles.resultSection}>
      <Text style={styles.resultChapterTitle}>第 {section.chapterIndex + 1} 章 · {section.chapterTitle}</Text>
      <ResultGroup title="白云读后感" items={section.summaries} onDeleteNote={onDeleteNote} onOpenSource={onOpenSource} onRememberResult={onRememberResult} onSaveToNotebook={onSaveToNotebook} />
      <ResultGroup title="白云批注" items={section.annotations} onDeleteNote={onDeleteNote} onOpenSource={onOpenSource} onRememberResult={onRememberResult} onSaveToNotebook={onSaveToNotebook} />
      <ResultGroup title="我的笔记" items={section.myNotes} onDeleteNote={onDeleteNote} onOpenSource={onOpenSource} onRememberResult={onRememberResult} onSaveToNotebook={onSaveToNotebook} />
      <ResultGroup title="问白云" items={section.questions} onDeleteNote={onDeleteNote} onOpenSource={onOpenSource} onRememberResult={onRememberResult} onSaveToNotebook={onSaveToNotebook} />
    </View>
  );
}

export function ReadingResultsView({
  book,
  insets,
  results,
  onBack,
  onDeleteNote,
  onExport,
  onOpenSource,
  onMemorySaved,
  onSaveToNotebook,
}: Props) {
  const hasResults = results.sections.length > 0;
  const [rememberCandidate, setRememberCandidate] = useState<ReadingResultItem | null>(null);
  const handleRememberPress = (item: ReadingResultItem) => {
    setRememberCandidate(item);
  };

  return (
    <View style={[styles.page, { paddingTop: Math.max(insets.top + 16, 40) }]}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.iconButton}><Text style={styles.backText}>‹</Text></Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>共读成果</Text>
          <Text style={styles.subtitle}>{book.title}</Text>
        </View>
        <Pressable onPress={onExport} style={styles.headerButton}><Text style={styles.headerButtonText}>导出</Text></Pressable>
      </View>
      <ScrollView contentContainerStyle={[styles.notesContent, { paddingBottom: Math.max(insets.bottom + 96, 128) }]}>
        <View style={styles.resultStatsRow}>
          <View style={styles.resultStatPill}><Text style={styles.resultStatValue}>{results.stats.annotations}</Text><Text style={styles.resultStatLabel}>白云批注</Text></View>
          <View style={styles.resultStatPill}><Text style={styles.resultStatValue}>{results.stats.summaries}</Text><Text style={styles.resultStatLabel}>读后感</Text></View>
          <View style={styles.resultStatPill}><Text style={styles.resultStatValue}>{results.stats.myNotes}</Text><Text style={styles.resultStatLabel}>我的笔记</Text></View>
          <View style={styles.resultStatPill}><Text style={styles.resultStatValue}>{results.stats.questions}</Text><Text style={styles.resultStatLabel}>问白云</Text></View>
        </View>
        {results.sections.map((section) => (
          <ResultSection
            key={section.chapterIndex}
            section={section}
            onDeleteNote={onDeleteNote}
            onOpenSource={onOpenSource}
            onRememberResult={handleRememberPress}
            onSaveToNotebook={onSaveToNotebook}
          />
        ))}
        {!hasResults ? (
          <View style={styles.emptyPanel}>
            <Text style={styles.emptyTitle}>这里还很安静</Text>
            <Text style={styles.emptyText}>读几段、问几句，白云和你的痕迹就会慢慢留在这里。</Text>
          </View>
        ) : null}
      </ScrollView>
      {rememberCandidate ? <ReadingMemoryConfirmation key={`${book.id}:${rememberCandidate.id}`} bookId={book.id} item={rememberCandidate}
        insets={insets} onClose={() => setRememberCandidate(null)} onSaved={onMemorySaved} /> : null}
    </View>
  );
}
