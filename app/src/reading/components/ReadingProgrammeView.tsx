import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import type { EdgeInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../../components/AppText';
import { addProgrammeToLibrary, canDownloadProgramme, importProgrammeTranscript, prepareProgramme, refreshProgrammeCatalog } from '../readingProgrammeStore';
import { programmePreparationText, readingProgressText } from '../readingProgrammePolicy';
import type { ReadingBook } from '../readingTypes';
import type { Navigate } from '../../types/navigation';
import { ReadingShelfTabs } from './ReadingShelfTabs';
import { readingStyles as shared } from './readingStyles';
import { ReadingProgrammeCollectionImport } from './ReadingProgrammeCollectionImport';

type Props = {
  books: ReadingBook[]; busy: boolean; setBusy: (busy: boolean) => void; insets: EdgeInsets;
  navigate: Navigate; onBooks: () => void; onOpenBook: (book: ReadingBook) => Promise<void>;
  refreshLibrary: () => Promise<boolean>;
  onBringToChat?: (book: ReadingBook) => void;
};
type ImportDraft = { book: ReadingBook; name?: string; text?: string; format?: 'srt' | 'vtt' | 'txt'; minutes: string };

export function ReadingProgrammeView({ books, busy, setBusy, insets, navigate, onBooks, onOpenBook, onBringToChat, refreshLibrary }: Props) {
  const [nextPage, setNextPage] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [newProgramme, setNewProgramme] = useState<{ title: string; sourceUrl: string; series: string; language: string } | null>(null);
  const [showSources, setShowSources] = useState(() => !books.some(book => book.contentType === 'programme'));
  const [selecting, setSelecting] = useState(false);
  const [collectionImport, setCollectionImport] = useState(false);
  const working = useRef(false);
  const listRef = useRef<FlatList<ReadingBook>>(null);
  const episodes = useMemo(() => books.filter(book => book.contentType === 'programme'), [books]);
  const preparableIds = useMemo(() => new Set(episodes.filter(book => book.programme?.preparation !== 'ready' && canDownloadProgramme(book)).map(book => book.id)), [episodes]);
  const selectedIds = useMemo(() => selected.filter(id => preparableIds.has(id)), [selected, preparableIds]);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const report = (title: string, error: unknown) => Alert.alert(title, error instanceof Error ? error.message : '操作未完成，请稍后重试。');
  const resumeSavedSelection = async (saved: ReadingBook) => {
    if (Platform.OS !== 'android' || saved.programme?.preparation !== 'ready') return;
    try {
      await (await import('../../life/readingActivityRuntime')).runReadingActivityTick(Date.now(), false);
      await (await import('../../life/sleepPlanRuntime')).reconcileSleepPlanLocally();
    } catch (error) {
      // A local scheduling failure must not turn successfully saved subtitles
      // into a failed download or cause them to be downloaded again.
      report('字幕已保存，阅读计时尚未接续', error);
    }
  };

  const updateCatalog = async (page: number | string) => {
    if (busy || working.current) return;
    working.current = true; setBusy(true);
    try {
      const result = await refreshProgrammeCatalog(page);
      setNextPage(result.nextPage);
      await refreshLibrary();
    } catch (error) { report('节目目录未更新', error); }
    finally { working.current = false; setBusy(false); }
  };

  const prepareSelected = async (ids: string[]) => {
    if (busy || working.current || !ids.length) return;
    working.current = true; setBusy(true);
    const incomplete: string[] = [];
    try {
      // This finite batch exists only after the user's explicit selection; it is
      // not a persisted job or an automatic download queue.
      for (const id of ids) {
        setActiveId(id);
        try {
          const saved = await prepareProgramme(id);
          if (saved.programme?.preparation !== 'ready') incomplete.push(id);
          else await resumeSavedSelection(saved);
        } catch { incomplete.push(id); }
        await refreshLibrary();
      }
      setSelected(current => current.filter(id => !ids.includes(id) || incomplete.includes(id)));
      if (incomplete.length) Alert.alert('部分字幕尚未备齐', `${incomplete.length} 期未准备完成。原有资料保留，可查看对应状态后重试或导入字幕。`);
    } catch (error) { report('节目列表未刷新', error); }
    finally { setActiveId(undefined); working.current = false; setBusy(false); }
  };

  const chooseFile = async () => {
    if (!draft || busy || working.current) return;
    working.current = true; setBusy(true);
    try {
      const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false,
        type: ['text/plain', 'text/vtt', 'application/x-subrip', 'application/octet-stream'] });
      if (picked.canceled || !picked.assets[0]) return;
      const asset = picked.assets[0];
      const extension = asset.name.split('.').at(-1)?.toLowerCase();
      if (extension !== 'srt' && extension !== 'vtt' && extension !== 'txt') throw new Error('请选择 SRT、VTT 或 TXT 文件。');
      const text = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      if (!text.trim()) throw new Error('所选文件没有可导入的文字。');
      setDraft(current => current?.book.id === draft.book.id
        ? { ...current, name: asset.name, format: extension, text } : current);
    } catch (error) { report('字幕文件未读取', error); }
    finally { working.current = false; setBusy(false); }
  };

  const saveImported = async () => {
    if (!draft?.format || draft.text === undefined || busy || working.current) return;
    const minutes = draft.minutes.trim() ? Number(draft.minutes) : undefined;
    if ((minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) || (draft.format === 'txt' && minutes === undefined)) {
      Alert.alert('需要真实总时长', '请填写来源标明的节目总分钟数；不知道时长时，先保留文件，不猜测填写。'); return;
    }
    working.current = true; setBusy(true);
    try {
      const saved = await importProgrammeTranscript(draft.book.id, draft.text, draft.format, minutes === undefined ? undefined : minutes * 60_000);
      await refreshLibrary();
      if (saved.programme?.preparation !== 'ready') throw new Error(saved.programme?.errorCode ?? 'programme-not-ready');
      setDraft(null);
      await resumeSavedSelection(saved);
      await refreshLibrary();
    } catch (error) { report('字幕未导入', error); }
    finally { working.current = false; setBusy(false); }
  };

  const openEpisodeOptions = (book: ReadingBook) => book.programme?.episodes ? Alert.alert(book.title,
    book.programme.episodes.map((e, i) => `${i + 1}. ${e.title}`).join('\n'),
    [{ text: '重新导入合集', onPress: () => setCollectionImport(true) }, { text: '关闭', style: 'cancel' }]) : Alert.alert(book.title,
    book.programme?.errorCode ? `技术状态：${book.programme.errorCode}` : undefined,
    [{ text: '导入字幕', onPress: () => setDraft({ book, minutes: book.programme?.durationMs ? String(book.programme.durationMs / 60_000) : '' }) },
      { text: '取消', style: 'cancel' }]);

  const saveNewProgramme = async () => {
    if (!newProgramme || busy || working.current) return;
    working.current = true; setBusy(true);
    try {
      const book = await addProgrammeToLibrary(newProgramme);
      setNewProgramme(null);
      await refreshLibrary();
      setDraft({ book, minutes: book.programme?.durationMs ? String(book.programme.durationMs / 60_000) : '' });
    } catch (error) { report('节目未添加', error); }
    finally { working.current = false; setBusy(false); }
  };

  return <View style={[shared.page, { paddingTop: Math.max(insets.top + 16, 40) }]}>
    <View style={shared.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回首页" onPress={() => navigate('home')} style={shared.iconButton}><Text style={shared.backText}>‹</Text></Pressable>
      <View style={shared.headerCopy}><Text style={[shared.title, styles.pageTitle]}>共读</Text><Text style={shared.subtitle}>和白云小姐一起慢慢读</Text></View>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: showSources }} onPress={() => {
        setShowSources(current => !current);
        if (!showSources) listRef.current?.scrollToOffset({ offset: 0, animated: true });
      }}
        style={({ pressed }) => [styles.headerAction, pressed && styles.pressed]}>
        <Text style={styles.secondaryText}>栏目</Text>
      </Pressable>
    </View>
    <ReadingShelfTabs active="programmes" onBooks={onBooks} onProgrammes={() => undefined} />
    <FlatList ref={listRef} style={styles.list} data={episodes} keyExtractor={book => book.id} initialNumToRender={6} maxToRenderPerBatch={6} windowSize={7}
      contentContainerStyle={styles.listContent} ItemSeparatorComponent={() => <View style={styles.separator} />}
      ListHeaderComponent={<View style={styles.listHeader}>
        <View style={styles.menuHeading}><Text style={styles.sourceTitle}>小云节目单</Text><Text style={styles.count}>{episodes.length} 项</Text></View>
        <Text style={styles.caption}>先备好文字稿，再慢慢读。</Text>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setNewProgramme({ title: '', sourceUrl: '', series: '', language: 'zh-CN' })}
          style={[styles.secondaryButton, busy && shared.disabled]}><Text style={styles.secondaryText}>＋ 添加节目</Text></Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => setCollectionImport(true)}
          style={[styles.secondaryButton, busy && shared.disabled]}><Text style={styles.secondaryText}>导入节目合集</Text></Pressable>
        {showSources ? <View style={styles.sourceCard}>
          <Text style={styles.eyebrow}>已接入栏目</Text>
          <Text style={styles.sourceName}>NASA / Curious Universe</Text>
          <Text style={styles.caption}>这个栏目支持自动准备文字稿；其它节目可手动添加并导入字幕。</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void updateCatalog(1)}
            style={({ pressed }) => [styles.sourceButton, busy && shared.disabled, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{episodes.length ? '刷新此栏目目录' : '读取栏目目录'}　↓</Text>
          </Pressable>
        </View> : null}
        {episodes.length ? <View style={styles.batchRow}>
          <Text style={styles.caption}>{selecting ? '勾选想提前备好的节目' : '节目与阅读进度'}</Text>
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => { setSelecting(current => !current); setSelected([]); }}
            style={({ pressed }) => [styles.headerAction, busy && shared.disabled, pressed && styles.pressed]}>
            <Text style={styles.secondaryText}>{selecting ? '完成' : '多选准备'}</Text>
          </Pressable>
        </View> : null}
        {busy ? <View style={styles.busyRow} accessibilityLiveRegion="polite"><ActivityIndicator color="#6F98BB" /><Text style={styles.caption}>{activeId ? '正在准备所选字幕' : '正在处理'}</Text></View> : null}
      </View>}
      renderItem={({ item: book }) => {
        const ready = book.programme?.preparation === 'ready';
        const checked = selectedSet.has(book.id);
        return <View style={[styles.episodeCard, checked && styles.selectedCard]}>
          <View style={styles.episodeHeading}>
            <View style={styles.episodeCopy}>
              <Text style={styles.eyebrow}>{book.programme?.series}</Text>
              <Text style={styles.episodeTitle}>{book.title}</Text>
              {book.programme?.episodes ? <Text style={styles.caption}>合集 · {book.programme.episodes.length} 集 · 按目录顺序接读</Text> : null}
            </View>
            {selecting && !ready && canDownloadProgramme(book) ? <Pressable accessibilityRole="checkbox" accessibilityLabel={`提前准备 ${book.title}`} accessibilityState={{ checked: checked, disabled: busy }}
              disabled={busy} onPress={() => setSelected(current => current.includes(book.id) ? current.filter(id => id !== book.id) : [...current, book.id])}
              style={({ pressed }) => [styles.checkboxTouch, pressed && styles.pressed]}>
              <View style={[styles.checkbox, checked && styles.checked]}><Text style={styles.checkText}>{checked ? '✓' : ''}</Text></View>
            </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel={`${book.title}：导入字幕或查看详情`} disabled={busy}
              onPress={() => openEpisodeOptions(book)} style={({ pressed }) => [styles.checkboxTouch, busy && shared.disabled, pressed && styles.pressed]}>
              <Text style={styles.moreText}>···</Text>
            </Pressable>}
          </View>
          <View style={styles.statusRow}><View style={[styles.statusDot, ready && styles.readyDot]} /><Text style={[styles.statusText, ready && styles.ready]}>{activeId === book.id ? '字幕正在准备。' : programmePreparationText(book)}</Text></View>
          <Text style={styles.progress}>云的进度 · {readingProgressText(book)}</Text>
          {book.programme?.preparedAt ? <Text style={styles.date}>资料保存于 {new Date(book.programme.preparedAt).toLocaleString('zh-CN')}</Text> : null}
          {onBringToChat ? <Pressable accessibilityRole="button" accessibilityLabel={`带进聊天：${book.title}`}
            onPress={(event) => { event.stopPropagation(); onBringToChat(book); }} style={styles.episodeButton}>
            <Text style={styles.secondaryText}>带进聊天 ↗</Text>
          </Pressable> : null}
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => ready ? void onOpenBook(book) : book.programme?.episodes ? setCollectionImport(true) : canDownloadProgramme(book) ? void prepareSelected([book.id]) : setDraft({ book, minutes: book.programme?.durationMs ? String(book.programme.durationMs / 60_000) : '' })}
              style={({ pressed }) => [styles.episodeButton, busy && shared.disabled, pressed && styles.pressed]}>
              <Text style={styles.secondaryText}>{ready ? '原文与笔记' : book.programme?.episodes ? '重新导入合集' : !canDownloadProgramme(book) ? '导入字幕' : book.programme?.preparation === 'failed' ? '重试准备' : '准备文字稿'}　→</Text>
            </Pressable>
          </View>
        </View>;
      }}
      ListFooterComponent={<View style={{ paddingBottom: Math.max(insets.bottom + 24, 40) }}>
        {nextPage ? <Pressable accessibilityRole="button" disabled={busy} onPress={() => void updateCatalog(nextPage)} style={({ pressed }) => [styles.nextButton, busy && shared.disabled, pressed && styles.pressed]}><Text style={styles.secondaryText}>加载下一页</Text></Pressable> : null}
      </View>} />
    {selecting ? <View style={[styles.selectionBar, { paddingBottom: Math.max(insets.bottom + 12, 20) }]}>
      <Text style={styles.caption}>已选 {selectedIds.length} 期</Text>
      <Pressable accessibilityRole="button" disabled={busy || !selectedIds.length} onPress={() => void prepareSelected(selectedIds)}
        style={({ pressed }) => [styles.primaryButton, (busy || !selectedIds.length) && shared.disabled, pressed && styles.pressed]}>
        <Text style={styles.primaryText}>提前准备所选</Text>
      </Pressable>
    </View> : null}
    <ReadingProgrammeCollectionImport visible={collectionImport} busy={busy} setBusy={setBusy} insets={insets}
      onClose={() => setCollectionImport(false)} refreshLibrary={refreshLibrary} />
    <Modal animationType="slide" transparent visible={!!newProgramme} onRequestClose={() => { if (!busy) setNewProgramme(null); }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[shared.pasteModalOverlay, { paddingTop: Math.max(insets.top + 16, 40), paddingBottom: Math.max(insets.bottom + 24, 40) }]}>
        <View style={shared.pasteModalCard}><ScrollView keyboardShouldPersistTaps="handled">
          <Text style={shared.sheetTitle}>添加节目</Text>
          <Text style={styles.caption}>保存节目资料后选择字幕文件。添加不会下载视频或启动阅读；同一来源重复添加会保留已有记录。</Text>
          {([{ key: 'title', label: '完整节目标题' }, { key: 'sourceUrl', label: '这期节目的网页链接' },
            { key: 'series', label: '所属栏目' }, { key: 'language', label: '文字稿语言（如 zh-CN / en）' }] as const).map(({ key, label }) => <View key={key}>
            <Text style={styles.inputLabel}>{label}</Text>
            <TextInput accessibilityLabel={label} editable={!busy} value={newProgramme?.[key] ?? ''}
              autoCapitalize="none" keyboardType={key === 'sourceUrl' ? 'url' : 'default'}
              onChangeText={value => setNewProgramme(current => current ? { ...current, [key]: value } : current)} style={shared.sheetSingleInput} />
          </View>)}
          <View style={shared.sheetActions}>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => setNewProgramme(null)} style={shared.sheetButton}><Text style={shared.sheetButtonText}>取消</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy || !newProgramme || Object.values(newProgramme).some(value => !value.trim())}
              onPress={() => void saveNewProgramme()} style={shared.sheetButtonPrimary}><Text style={shared.sheetButtonPrimaryText}>保存并选字幕</Text></Pressable>
          </View>
        </ScrollView></View>
      </KeyboardAvoidingView>
    </Modal>
    <Modal animationType="slide" transparent visible={!!draft} onRequestClose={() => { if (!busy) setDraft(null); }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={[shared.pasteModalOverlay, { paddingTop: Math.max(insets.top + 16, 40), paddingBottom: Math.max(insets.bottom + 24, 40) }]}>
        <View style={shared.pasteModalCard}>
          <ScrollView keyboardShouldPersistTaps="handled">
            <Text style={shared.sheetTitle}>导入这期文字稿</Text>
            <Text style={shared.sheetText}>{draft?.book.title}</Text>
            <Pressable accessibilityRole="button" disabled={busy} onPress={() => void chooseFile()} style={[styles.secondaryButton, styles.fileButton]}><Text style={styles.secondaryText}>{draft?.name ?? '选择 SRT / VTT / TXT 文件'}</Text></Pressable>
            <Text style={styles.inputLabel}>节目真实总时长（分钟）{draft?.format === 'txt' ? ' · 必填' : ' · 有时间码时可留空'}</Text>
            <TextInput accessibilityLabel="节目真实总时长，分钟" editable={!busy} keyboardType="decimal-pad" value={draft?.minutes ?? ''}
              onChangeText={minutes => setDraft(current => current ? { ...current, minutes } : current)} placeholder="填写来源标明的分钟数" placeholderTextColor="#9AA8A0" style={shared.sheetSingleInput} />
            <Text style={styles.caption}>TXT 按真实总时长粗分。导入不请求模型；已有有效阅读安排会在准备完成后开始计时。</Text>
            <View style={shared.sheetActions}>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => setDraft(null)} style={shared.sheetButton}><Text style={shared.sheetButtonText}>取消</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={busy || !draft?.format} onPress={() => void saveImported()} style={[shared.sheetButtonPrimary, (busy || !draft?.format) && shared.disabled]}><Text style={shared.sheetButtonPrimaryText}>{busy ? '保存中' : '保存资料'}</Text></Pressable>
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  pageTitle: { fontSize: 24, fontWeight: '500' },
  list: { flex: 1 },
  listContent: { paddingHorizontal: 20 },
  listHeader: { gap: 8, paddingTop: 10, paddingBottom: 16 },
  menuHeading: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  count: { color: '#81919B', fontSize: 12 },
  separator: { height: 14 },
  sourceCard: { backgroundColor: '#EBF3F8', borderRadius: 16, padding: 18, gap: 8, marginTop: 14 },
  sourceName: { color: '#476579', fontSize: 15, lineHeight: 23, fontWeight: '500' },
  sourceButton: { alignSelf: 'flex-start', minHeight: 44, justifyContent: 'center', paddingRight: 12 },
  eyebrow: { color: '#788B97', fontSize: 12, lineHeight: 19, fontWeight: '400' },
  sourceTitle: { color: '#304B61', fontSize: 22, fontWeight: '500' },
  caption: { color: '#728598', fontSize: 13, lineHeight: 21 },
  batchRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  headerAction: { minHeight: 44, minWidth: 52, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  episodeCard: { padding: 18, gap: 8, backgroundColor: '#FFFFFF', borderColor: '#E2EBEF', borderWidth: 1, borderRadius: 18 },
  selectedCard: { borderColor: '#9DBBCD', backgroundColor: '#F4F9FC' },
  episodeHeading: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  episodeCopy: { flex: 1, gap: 7 },
  episodeTitle: { color: '#344451', fontSize: 18, lineHeight: 27, fontWeight: '500' },
  checkboxTouch: { minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  checkbox: { width: 25, height: 25, borderRadius: 8, borderWidth: 1.5, borderColor: '#C3D5DF', alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: '#6F98BB', borderColor: '#6F98BB' },
  checkText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
  moreText: { fontSize: 24, color: '#708997', lineHeight: 28 },
  statusRow: { flexDirection: 'row', gap: 8, alignItems: 'center', marginTop: 8 },
  statusDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#A9B9C3' },
  readyDot: { backgroundColor: '#7C9D83' },
  statusText: { flex: 1, color: '#536975', fontSize: 13, lineHeight: 20 },
  ready: { color: '#5A825F' },
  progress: { color: '#687D8A', fontSize: 13, lineHeight: 21 },
  date: { color: '#8B9990', fontSize: 11, lineHeight: 17 },
  actions: { flexDirection: 'row', marginTop: 6 },
  episodeButton: { flex: 1, minHeight: 44, justifyContent: 'center', borderTopWidth: 1, borderTopColor: '#EDF2F4', paddingTop: 8 },
  selectionBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingTop: 12, borderTopWidth: 1, borderTopColor: '#DCE7ED', backgroundColor: '#F7FAF8' },
  primaryButton: { alignSelf: 'flex-start', backgroundColor: '#6F98BB', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '500' },
  secondaryButton: { alignSelf: 'flex-start', backgroundColor: '#EFF4F0', borderRadius: 12, paddingHorizontal: 15, paddingVertical: 11, minHeight: 44, justifyContent: 'center' },
  secondaryText: { color: '#476B82', fontSize: 14, lineHeight: 21, fontWeight: '500' },
  pressed: { opacity: 0.65 },
  nextButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderRadius: 14, borderColor: '#DCE9E4', borderWidth: 1, backgroundColor: '#FFFFFF' },
  fileButton: { alignSelf: 'stretch', marginVertical: 12 },
  inputLabel: { color: '#536975', fontSize: 13, lineHeight: 21, marginTop: 6 },
});
