import { useMemo, useRef, useState } from 'react';
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from 'react-native';
import type { EdgeInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../../components/AppText';
import type { Navigate } from '../../types/navigation';
import { filterReadingBooks, truncate } from '../readingFormat';
import type { ReadingBook } from '../readingTypes';
import type { ReadingBookShelfMeta, ReadingLibraryPulse, ReadingLibraryStats } from '../readingUiTypes';
import { readingStyles as shared } from './readingStyles';
import { ReadingShelfTabs } from './ReadingShelfTabs';

type Props = {
  books: ReadingBook[];
  busy: boolean;
  continueBook?: ReadingBook;
  getBookShelfMeta: (book: ReadingBook) => ReadingBookShelfMeta;
  insets: EdgeInsets;
  navigate: Navigate;
  onDeleteBook: (book: ReadingBook) => void;
  onCreateTextBook: (title: string, text: string) => Promise<boolean>;
  onImportBook: () => void;
  onOpenBook: (book: ReadingBook) => void;
  onBringToChat?: (book: ReadingBook) => void;
  onOpenPulse: (pulse: ReadingLibraryPulse) => void;
  onShowProgrammes: () => void;
  stats: ReadingLibraryStats;
};

export function ReadingLibraryView({
  books,
  busy,
  continueBook,
  getBookShelfMeta,
  insets,
  navigate,
  onDeleteBook,
  onCreateTextBook,
  onImportBook,
  onOpenBook,
  onBringToChat,
  onOpenPulse,
  onShowProgrammes,
  stats,
}: Props) {
  const windowDimensions = useWindowDimensions();
  const [showPasteModal, setShowPasteModal] = useState(false);
  const [activeCollection, setActiveCollection] = useState<'annotations' | 'notes' | null>(null);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteText, setPasteText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const shelfScroll = useRef<ScrollView>(null);
  const updateSearch = (query: string) => {
    setSearchQuery(query);
    shelfScroll.current?.scrollTo({ y: 0, animated: false });
  };
  const visibleBooks = useMemo(() => filterReadingBooks(books, searchQuery), [books, searchQuery]);
  const isSearching = searchQuery.trim().length > 0;
  const canSavePaste = pasteText.trim().length > 0 && !busy;
  const collectionItems = activeCollection === 'annotations' ? stats.annotationItems : stats.noteItems;
  const collectionTitle = activeCollection === 'annotations' ? '累计批注' : '累计笔记';
  const collectionEmptyText = activeCollection === 'annotations'
    ? '还没有白云批注。读一段之后邀请白云共读，这里就会慢慢长出来。'
    : '还没有书内笔记。问白云或记一笔之后，这里就会留下痕迹。';
  const collectionVerticalPadding = Math.max(insets.top, 24) + Math.max(insets.bottom, 24) + 32;
  const collectionPanelHeight = Math.max(
    320,
    Math.min(windowDimensions.height * 0.72, windowDimensions.height - collectionVerticalPadding),
  );

  const closePasteModal = () => {
    setShowPasteModal(false);
    setPasteTitle('');
    setPasteText('');
  };

  const savePastedText = async () => {
    if (!canSavePaste) return;
    const saved = await onCreateTextBook(pasteTitle, pasteText);
    if (saved) closePasteModal();
  };
  const continueMeta = continueBook ? getBookShelfMeta(continueBook) : null;

  return (
    <View style={[styles.page, { paddingTop: Math.max(insets.top + 16, 40) }]}>
      <View style={styles.header}>
        <Pressable onPress={() => navigate('home')} style={styles.iconButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>共读</Text>
          <Text style={styles.subtitle}>和白云小姐一起慢慢读</Text>
        </View>
        <Pressable disabled={busy} onPress={onImportBook} style={styles.headerButton}>
          <Text style={styles.headerButtonText}>{busy ? '导入中' : '导入'}</Text>
        </Pressable>
      </View>

      <ReadingShelfTabs active="books" onBooks={() => undefined} onProgrammes={onShowProgrammes} />
      <View style={styles.searchBar}>
        <TextInput accessibilityLabel="搜索书名或作者" placeholder="搜索书名或作者" placeholderTextColor="#8A989E"
          value={searchQuery} onChangeText={updateSearch} autoCorrect={false} autoCapitalize="none"
          returnKeyType="search" style={styles.searchInput} />
        {searchQuery ? <Pressable accessibilityRole="button" accessibilityLabel="清除书架搜索" onPress={() => updateSearch('')} style={styles.clearSearch}>
          <Text style={styles.clearSearchText}>清除</Text>
        </Pressable> : null}
      </View>
      <ScrollView ref={shelfScroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={[styles.libraryContent, { paddingBottom: Math.max(insets.bottom + 24, 40) }]}>
        {!isSearching ? <>
        {continueBook ? (
          <Pressable onPress={() => onOpenBook(continueBook)} style={styles.continueCard}>
            {continueBook.coverUri ? (
              <Image source={{ uri: continueBook.coverUri }} style={styles.continueCover} />
            ) : (
              <View style={styles.coverFallback}>
                <Text style={styles.coverFallbackText}>书</Text>
              </View>
            )}
            <View style={styles.continueCopy}>
              <Text style={styles.cardEyebrow}>继续阅读</Text>
              <Text numberOfLines={2} style={styles.continueTitle}>{continueBook.title}</Text>
              <Text style={styles.continueMeta}>
                {continueBook.author} · {continueMeta?.chapterLabel} · {continueMeta?.paragraphLabel}
              </Text>
              <Text style={styles.continueSubMeta}>{continueMeta?.lastOpenedLabel}</Text>
              {continueMeta?.fileWarning ? <Text style={styles.warningText}>{continueMeta.fileWarning}</Text> : null}
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: continueMeta?.progressLabel ?? '0%' }]} />
              </View>
            </View>
          </Pressable>
        ) : (
          <View style={styles.emptyPanel}>
            <Text style={styles.emptyTitle}>书架还空着</Text>
            <Text style={styles.emptyText}>先放一本 EPUB，或粘贴一段文字，白云小姐就能陪你读。</Text>
            <View style={styles.emptyActions}>
              <Pressable disabled={busy} onPress={onImportBook} style={styles.emptyPrimaryButton}>
                <Text style={styles.emptyPrimaryText}>{busy ? '导入中' : '导入 EPUB'}</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={() => setShowPasteModal(true)} style={styles.emptySecondaryButton}>
                <Text style={styles.emptySecondaryText}>粘贴文字</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.metricsRow}>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>{stats.minutesToday}</Text>
            <Text style={styles.metricLabel}>今日分钟</Text>
          </View>
          <Pressable onPress={() => setActiveCollection('annotations')} style={styles.metricCard}>
            <Text style={styles.metricValue}>{stats.annotationItems.length}</Text>
            <Text style={styles.metricLabel}>累计批注</Text>
          </Pressable>
          <Pressable onPress={() => setActiveCollection('notes')} style={styles.metricCard}>
            <Text style={styles.metricValue}>{stats.noteItems.length}</Text>
            <Text style={styles.metricLabel}>累计笔记</Text>
          </Pressable>
          <View style={styles.metricCard}>
            <Text style={styles.metricValue}>{stats.bookCount}</Text>
            <Text style={styles.metricLabel}>书架藏书</Text>
          </View>
        </View>

        {stats.recentPulse ? (
          <Pressable onPress={() => onOpenPulse(stats.recentPulse!)} style={styles.pulseCard}>
            <Text style={styles.pulseEyebrow}>最近留下的东西 · {stats.recentPulse.bookTitle}</Text>
            <Text style={styles.pulseLabel}>{stats.recentPulse.label}</Text>
            <Text numberOfLines={3} style={styles.pulseText}>{truncate(stats.recentPulse.text, 96)}</Text>
          </Pressable>
        ) : null}
        </> : null}

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>{isSearching ? `找到 ${visibleBooks.length} 本书` : '小仓鼠和白云小姐的书架'}</Text>
        </View>
        {isSearching && !visibleBooks.length ? <Text style={styles.searchEmpty}>没有匹配的书名或作者。</Text> : null}
        <View style={styles.bookGrid}>
          {!isSearching ? <>
          <Pressable disabled={busy} onPress={onImportBook} style={styles.bookCell}>
            <View style={styles.importCoverCell}>
              <Text style={styles.importPlus}>＋</Text>
            </View>
            <Text numberOfLines={2} style={styles.importBookTitle}>导入 EPUB</Text>
            <Text numberOfLines={1} style={styles.importBookMeta}>放一本新书</Text>
            <Text style={styles.importBookProgress}>{busy ? '导入中' : '选择文件'}</Text>
            <Text numberOfLines={1} style={styles.importBookSubMeta}>EPUB</Text>
          </Pressable>
          <Pressable disabled={busy} onPress={() => setShowPasteModal(true)} style={styles.bookCell}>
            <View style={styles.importCoverCell}>
              <Text style={styles.importPlus}>文</Text>
            </View>
            <Text numberOfLines={2} style={styles.importBookTitle}>粘贴文字</Text>
            <Text numberOfLines={1} style={styles.importBookMeta}>存成文本书</Text>
            <Text style={styles.importBookProgress}>立即粘贴</Text>
            <Text numberOfLines={1} style={styles.importBookSubMeta}>TXT</Text>
          </Pressable>
          </> : null}
          {visibleBooks.map((item) => {
            const shelfMeta = getBookShelfMeta(item);
            return (
              <Pressable key={item.id} onPress={() => onOpenBook(item)} onLongPress={() => onDeleteBook(item)} style={styles.bookCell}>
                {item.coverUri ? (
                  <Image source={{ uri: item.coverUri }} style={styles.bookCover} />
                ) : (
                  <View style={styles.bookCoverFallback}>
                    <Text style={styles.bookCoverFallbackText}>{item.title.slice(0, 1)}</Text>
                  </View>
                )}
                <Text numberOfLines={2} style={styles.bookTitle}>{item.title}</Text>
                <Text numberOfLines={1} style={styles.bookAuthor}>{item.author}</Text>
                <Text style={styles.bookProgress}>{shelfMeta.progressLabel} · {shelfMeta.chapterLabel}</Text>
                <Text numberOfLines={1} style={styles.bookMeta}>{shelfMeta.paragraphLabel} · {shelfMeta.lastOpenedLabel}</Text>
                {shelfMeta.fileWarning ? <Text numberOfLines={2} style={styles.bookWarning}>{shelfMeta.fileWarning}</Text> : null}
                {onBringToChat ? <Pressable accessibilityRole="button" accessibilityLabel={`带进聊天：${item.title}`}
                  onPress={(event) => { event.stopPropagation(); onBringToChat(item); }}
                  onLongPress={(event) => event.stopPropagation()} style={{ minHeight: 40, justifyContent: 'center' }}>
                  <Text style={{ color: '#567A90', fontSize: 13 }}>带进聊天 ↗</Text>
                </Pressable> : null}
              </Pressable>
            );
          })}
        </View>
      </ScrollView>

      <Modal animationType="slide" onRequestClose={closePasteModal} transparent visible={showPasteModal}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.pasteModalOverlay, { paddingBottom: Math.max(insets.bottom + 34, 72) }]}
        >
          <View style={styles.pasteModalCard}>
            <Text style={styles.sheetTitle}>粘贴文字共读</Text>
            <Text style={styles.sheetText}>把想一起看的文字放进来，会作为一本文本书留在书架里。</Text>
            <TextInput
              editable={!busy}
              onChangeText={setPasteTitle}
              placeholder="给这段文字起个名字"
              placeholderTextColor="#9AA8A0"
              style={styles.sheetSingleInput}
              value={pasteTitle}
            />
            <TextInput
              editable={!busy}
              multiline
              onChangeText={setPasteText}
              placeholder="在这里粘贴正文"
              placeholderTextColor="#9AA8A0"
              scrollEnabled
              style={styles.sheetLargeInput}
              textAlignVertical="top"
              value={pasteText}
            />
            <View style={styles.sheetActions}>
              <Pressable disabled={busy} onPress={closePasteModal} style={styles.sheetButton}>
                <Text style={styles.sheetButtonText}>先不放</Text>
              </Pressable>
              <Pressable
                disabled={!canSavePaste}
                onPress={() => void savePastedText()}
                style={[styles.sheetButtonPrimary, !canSavePaste ? styles.disabled : null]}
              >
                <Text style={styles.sheetButtonPrimaryText}>{busy ? '保存中' : '放到书架'}</Text>
              </Pressable>
            </View>
          </View>
        </KeyboardAvoidingView>
      </Modal>

      <Modal animationType="fade" onRequestClose={() => setActiveCollection(null)} transparent visible={!!activeCollection}>
        <View
          style={[
            styles.collectionModalLayer,
            {
              paddingBottom: Math.max(insets.bottom, 24),
              paddingTop: Math.max(insets.top, 24),
            },
          ]}
        >
          <Pressable onPress={() => setActiveCollection(null)} style={styles.collectionScrim} />
          <View style={[styles.collectionSheet, { height: collectionPanelHeight }]}>
            <Text style={styles.sheetTitle}>{collectionTitle}</Text>
            <Text style={styles.sheetText}>
              {activeCollection === 'annotations' ? '白云留在书里的批注和读后感，最新的在最上面。' : '书内留下的笔记和问白云记录，最新的在最上面。'}
            </Text>
            <ScrollView contentContainerStyle={styles.collectionList} showsVerticalScrollIndicator={false} style={styles.collectionScroll}>
              {collectionItems.map((item, index) => (
                <Pressable
                  key={`${item.kind}-${item.bookId}-${item.chapterIndex}-${item.paragraphIndex}-${item.createdAt}-${index}`}
                  onPress={() => {
                    setActiveCollection(null);
                    onOpenPulse(item);
                  }}
                  style={styles.collectionItem}
                >
                  <Text style={styles.pulseEyebrow}>{item.bookTitle}</Text>
                  <Text style={styles.pulseLabel}>{item.label}</Text>
                  <Text numberOfLines={4} style={styles.pulseText}>{truncate(item.text, 140)}</Text>
                </Pressable>
              ))}
              {!collectionItems.length ? (
                <View style={styles.emptyPanel}>
                  <Text style={styles.emptyText}>{collectionEmptyText}</Text>
                </View>
              ) : null}
            </ScrollView>
            <Pressable onPress={() => setActiveCollection(null)} style={[styles.sheetButton, styles.collectionCloseButton]}>
              <Text style={styles.sheetButtonText}>收起来</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// Shelf-only typography: reader text and its controls keep their existing styles.
const styles = { ...shared, ...StyleSheet.create({
  title: { ...shared.title, fontWeight: '500' },
  headerButtonText: { ...shared.headerButtonText, fontWeight: '500' },
  coverFallbackText: { ...shared.coverFallbackText, fontWeight: '400' },
  cardEyebrow: { ...shared.cardEyebrow, fontWeight: '400' },
  continueTitle: { ...shared.continueTitle, fontSize: 19, fontWeight: '500' },
  metricCard: { ...shared.metricCard, flexBasis: '20%', padding: 8, backgroundColor: 'transparent', borderWidth: 0 },
  metricValue: { ...shared.metricValue, fontSize: 21, fontWeight: '400' },
  metricLabel: { ...shared.metricLabel, fontSize: 11, fontWeight: '400' },
  pulseEyebrow: { ...shared.pulseEyebrow, fontWeight: '400' },
  pulseLabel: { ...shared.pulseLabel, fontWeight: '500' },
  sectionTitle: { ...shared.sectionTitle, fontSize: 16, fontWeight: '500' },
  bookCoverFallbackText: { ...shared.bookCoverFallbackText, fontWeight: '400' },
  bookTitle: { ...shared.bookTitle, fontWeight: '500' },
  bookProgress: { ...shared.bookProgress, fontWeight: '400' },
  importBookTitle: { ...shared.importBookTitle, fontWeight: '500' },
  importBookProgress: { ...shared.importBookProgress, fontWeight: '400' },
  searchBar: { marginHorizontal: 16, marginBottom: 16, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: '#DCE7E2', borderRadius: 14, backgroundColor: '#FFFFFF' },
  searchInput: { flex: 1, minWidth: 0, minHeight: 46, paddingHorizontal: 14, paddingVertical: 10, color: '#344451', fontSize: 14 },
  clearSearch: { minHeight: 44, paddingHorizontal: 14, justifyContent: 'center' },
  clearSearchText: { color: '#587482', fontSize: 13 },
  searchEmpty: { color: '#728598', fontSize: 14, lineHeight: 22, paddingVertical: 16 },
}) };
