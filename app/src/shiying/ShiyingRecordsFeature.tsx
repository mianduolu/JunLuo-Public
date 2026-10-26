import { useEffect, useRef, useState } from 'react';
import { Alert, Dimensions, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput } from '../components/AppText';
import { getOverlayTextStyle, type HomeBackgroundReadability } from '../theme/homeReadability';
import type { getShiyingVisualPalette } from './ShiyingFeature';
import type { ShiyingRecordImageV1 } from './shiyingJournalContract';
import { getShiyingRecordImageUri } from './shiyingRecordImages';
import { useShiyingRecords } from './useShiyingRecords';
import { ShiyingImagePreparationTools, ShiyingRecordImageNotePanel } from './ShiyingImageNotes';
import { ShiyingRecordTopics } from './ShiyingRecordTopics';

type Visual = ReturnType<typeof getShiyingVisualPalette>;
export type ShiyingTab = 'entries' | 'records' | 'reviews';
export function ShiyingRecordTabs({ value, onChange, visual }: {
  value: ShiyingTab; onChange: (value: ShiyingTab) => void; visual: Visual;
}) {
  return <View style={[styles.tabs, { backgroundColor: visual.actionSurface }]}>
    {(['entries', 'records', 'reviews'] as const).map(tab => <Pressable key={tab} accessibilityRole="tab"
      accessibilityState={{ selected: value === tab }} onPress={() => onChange(tab)}
      style={[styles.tab, value === tab && { backgroundColor: visual.cardSurface }]}>
      <Text style={[styles.tabText, { color: value === tab ? visual.primaryText : visual.secondaryText }]}>{tab === 'entries' ? '荧迹' : tab === 'records' ? '记录' : '回顾'}</Text>
    </Pressable>)}
  </View>;
}

function dateLabel(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return `${year === new Date().getFullYear() ? '' : `${year}年`}${month}月${day}日`;
}
function clockLabel(at: number) {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function countRecordCharacters(body: string) {
  return Array.from(body.replace(/\s/g, '')).length;
}
function RecordImage({ image, onPress, visual, large = false }: {
  image: ShiyingRecordImageV1; onPress?: () => void; visual: Visual; large?: boolean;
}) {
  const [missing, setMissing] = useState(false);
  useEffect(() => { setMissing(false); }, [image.contentHash]);
  return <Pressable accessibilityLabel="查看图片" onPress={onPress}
    style={large ? styles.largeImageHost : [styles.thumbnail, { backgroundColor: visual.actionSurface }]}>
    {missing ? <Text style={{ color: large ? '#FFFFFF' : visual.secondaryText, textAlign: 'center' }}>图片不可用</Text>
      : <Image source={{ uri: getShiyingRecordImageUri(image.contentHash) }}
        onError={() => setMissing(true)} resizeMode={large ? 'contain' : 'cover'} style={large ? styles.largeImage : styles.thumbnailImage} />}
  </Pressable>;
}

export function ShiyingRecordsFeature({ active, visual, backgroundReadability, onOpenFeatureDrawer, onChangeTab,
  onEditorPresenceChange, onEditorClosed }: {
  active: boolean; visual: Visual; backgroundReadability: HomeBackgroundReadability;
  onOpenFeatureDrawer?: () => void; onChangeTab: (value: ShiyingTab) => void;
  onEditorPresenceChange?: (open: boolean) => void; onEditorClosed?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const records = useShiyingRecords(active, { onEditorPresenceChange, onEditorClosed });
  const [enlarged, setEnlarged] = useState<ShiyingRecordImageV1 | null>(null);
  const editorScroll = useRef<ScrollView>(null);
  const readonlyTop = useRef(0);
  const headerText = getOverlayTextStyle(backgroundReadability.headerText);
  const selected = records.selected;
  const content = records.draft ?? selected;
  const blocked = records.busy || !!records.draft?.closing || !!records.draft?.mediaBusy;
  const close = () => { if (enlarged) setEnlarged(null); else void records.close(); };
  const confirmDelete = () => {
    if (blocked) return;
    Alert.alert('删除这条记录？', '删除后无法恢复。', [
      { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => void records.removeSelected() },
    ]);
  };
  const menu = () => Alert.alert('记录', undefined, [
    { text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: confirmDelete },
  ]);
  const saveText = records.draft?.status === 'saving' ? '正在保存…'
    : records.draft?.status === 'failed' ? '保存失败，点此重试'
      : records.draft?.status === 'conflict' ? '草稿已变化，当前输入未覆盖。' : '草稿已保存';
  const images = <View style={[styles.images, records.draft && styles.writingImagesRow]}>{content?.images.map(image => <View key={image.id}>
    <RecordImage image={image} visual={visual} onPress={() => setEnlarged(image)} />
    {records.draft ? <Pressable disabled={blocked} onPress={() => records.removeImage(image.id)} style={styles.removeImage}>
      <Text style={{ color: visual.secondaryText, fontSize: 12 }}>移除</Text>
    </Pressable> : null}
  </View>)}</View>;

  return <View style={styles.root}>
    <FlatList data={records.records} keyExtractor={record => record.id} initialNumToRender={8} windowSize={7}
      showsVerticalScrollIndicator={false}
      contentContainerStyle={{ paddingHorizontal: 18, paddingTop: Math.max(18, insets.top + 8), paddingBottom: Math.max(30, insets.bottom + 22) }}
      ListHeaderComponent={<>
        <View style={styles.header}>
          <Pressable accessibilityLabel="功能" onPress={onOpenFeatureDrawer} style={[styles.menu, { backgroundColor: visual.menuSurface }]}>
            <Text style={{ color: visual.menuText, fontSize: 21 }}>☰</Text>
          </Pressable>
          <Text style={[styles.title, headerText]}>拾荧</Text>
        </View>
        <ShiyingRecordTabs value="records" onChange={onChangeTab} visual={visual} />
        <View style={styles.tools}>
          <Text style={[styles.hint, headerText]}>自己写的小纸条</Text>
          <View style={styles.headerActions}>
            <Pressable disabled={records.busy} onPress={() => void records.createYesterday()} style={[styles.action, { backgroundColor: visual.actionSurface }]}>
              <Text style={{ color: visual.primaryText, fontSize: 15 }}>补写昨天</Text>
            </Pressable>
            <Pressable disabled={records.busy} onPress={() => void records.create()} style={[styles.action, { backgroundColor: visual.buttonSurface }]}>
              <Text style={{ color: visual.buttonText, fontSize: 15 }}>＋ 写一条</Text>
            </Pressable>
          </View>
        </View>
        {records.error ? <Pressable onPress={() => void records.refresh()}><Text style={[styles.error, headerText]}>{records.error}</Text></Pressable> : null}
        <ShiyingImagePreparationTools active={active} visual={visual} />
      </>}
      renderItem={({ item, index }) => <>
        {(index === 0 || records.records[index - 1].recordDate !== item.recordDate) ?
          <Text style={[styles.date, headerText]}>{dateLabel(item.recordDate)}</Text> : null}
        <Pressable onPress={() => void records.open(item.id)} disabled={records.busy}
          style={[styles.paper, { backgroundColor: visual.cardSurface, borderColor: visual.cardBorder }]}>
          <View style={styles.metadata}><Text style={{ color: visual.secondaryText, fontSize: 12 }}>{clockLabel(item.createdAt)}</Text>
            <Text style={{ color: item.status === 'draft' ? visual.accent : visual.secondaryText, fontSize: 12 }}>{item.status === 'draft' ? '草稿' : '已定稿'}</Text></View>
          {item.bodyPreview ? <Text numberOfLines={4} style={[styles.body, { color: visual.primaryText }]}>{item.bodyPreview}</Text> : null}
          {item.images.length ? <View style={styles.images}>{item.images.slice(0, 3).map(image => <RecordImage key={image.id} image={image} visual={visual} onPress={() => void records.open(item.id)} />)}</View> : null}
          {item.images.length > 3 ? <Text style={[styles.hint, { color: visual.secondaryText, marginTop: 8 }]}>{item.images.length} 张图片</Text> : null}
        </Pressable>
        {item.status === 'finalized' && item.images.length ? <ShiyingRecordImageNotePanel recordId={item.id} visual={visual} active={active} /> : null}
      </>}
      ListEmptyComponent={records.loading ? <Text style={[styles.date, headerText]}>正在读取记录…</Text> : null}
      ListFooterComponent={<>
        {records.nextBefore ? <Pressable disabled={records.loading} onPress={() => void records.more()} style={styles.more}>
          <Text style={headerText}>{records.loading ? '正在读取…' : '加载更早记录'}</Text>
        </Pressable> : null}
        <View style={styles.feather} accessibilityLabel="羽毛笔">
          <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
            <Path d="M20.2 3.8a5.6 5.6 0 0 0-7.9 0L3 13.1V21h7.9l9.3-9.3a5.6 5.6 0 0 0 0-7.9ZM16 8 2 22M9 15h6" stroke={visual.secondaryText} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </View>
      </>}
    />
    <Modal visible={active && !!selected} animationType="slide" onRequestClose={close} statusBarTranslucent
      backdropColor={visual.sheetSurface}>
      {/* Edge-to-edge Android can leave the modal unresized; bound its root before applying IME overlap padding. */}
      <KeyboardAvoidingView style={[styles.editor, { backgroundColor: visual.sheetSurface },
        Platform.OS === 'android' && { flex: 0, height: Dimensions.get('screen').height }]}
        enabled behavior="padding">
        <View style={[styles.editorHeader, { paddingTop: Math.max(14, insets.top + 8) }]}>
          <Pressable disabled={blocked} onPress={close} style={styles.back}><Text style={{ color: visual.primaryText, fontSize: 16 }}>‹ 记录</Text></Pressable>
          <View style={styles.headerActions}>
            <Pressable accessibilityLabel="更多操作" disabled={blocked} onPress={menu} style={styles.back}><Text style={{ color: visual.secondaryText, fontSize: 24 }}>⋯</Text></Pressable>
            {selected?.status === 'draft' ? <Pressable disabled={blocked} onPress={() => void records.close()} style={[styles.action, { backgroundColor: visual.buttonSurface, opacity: blocked ? 0.5 : 1 }]}>
              <Text style={{ color: visual.buttonText }}>写好了</Text>
            </Pressable> : null}
          </View>
        </View>
        {records.draft ? <View style={[styles.writingArea, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <Text style={[styles.editorDate, { color: visual.primaryText }]}>{selected ? dateLabel(selected.recordDate) : ''}</Text>
          <Pressable disabled={blocked} onPress={records.retry} style={styles.saveStatus}>
            <Text accessibilityLiveRegion="polite" style={{ color: visual.secondaryText, fontSize: 12 }}>{saveText}</Text>
          </Pressable>
          {/* A bounded native input scrolls its own caret; an ever-growing input cannot keep it above the IME. */}
          <View style={styles.writingViewport}>
            <AppTextInput key={selected?.id} value={records.draft.body} onChangeText={records.setBody} multiline scrollEnabled
              editable={!blocked} placeholder="随便写一点……" placeholderTextColor={visual.secondaryText}
              textAlignVertical="top" style={[styles.input, { color: visual.primaryText, borderColor: visual.cardBorder }]} />
          </View>
          {content?.images.length ? <ScrollView horizontal style={styles.writingImages} keyboardShouldPersistTaps="handled">
            {images}
          </ScrollView> : null}
          <View style={styles.tools}>
            <Pressable disabled={blocked || records.draft.images.length >= 9} onPress={() => void records.addImage()} style={styles.back}>
              <Text style={{ color: visual.accent, opacity: records.draft.images.length >= 9 ? 0.5 : 1 }}>＋ 添图片</Text>
            </Pressable>
            <Text style={{ color: visual.secondaryText, fontSize: 12 }}>{countRecordCharacters(records.draft.body)} 字</Text>
          </View>
          {records.error ? <Text style={[styles.error, { color: visual.secondaryText }]}>{records.error}</Text> : null}
        </View> : <ScrollView key={selected?.id} ref={editorScroll} style={styles.readingViewport} scrollEnabled
          removeClippedSubviews={false} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: Math.max(26, insets.bottom + 18) }}>
          <Text style={[styles.editorDate, { color: visual.primaryText }]}>{selected ? dateLabel(selected.recordDate) : ''}</Text>
          <View style={[styles.tools, styles.saveStatus]}>
            <Text style={{ color: visual.secondaryText, fontSize: 12 }}>已定稿</Text>
            <Text style={{ color: visual.secondaryText, fontSize: 12 }}>{countRecordCharacters(selected?.body ?? '')} 字</Text>
          </View>
          {selected ? <View onLayout={event => { readonlyTop.current = event.nativeEvent.layout.y; }}>
            <ShiyingRecordTopics key={selected.id} record={selected} active={active} visual={visual}
              onJump={y => editorScroll.current?.scrollTo({ y: Math.max(0, readonlyTop.current + y - 12), animated: true })} />
          </View> : null}
          {images}
          {selected?.status === 'finalized' && selected.images.length ? <ShiyingRecordImageNotePanel key={selected.id} recordId={selected.id} visual={visual} active={active} /> : null}
          {records.error ? <Text style={[styles.error, { color: visual.secondaryText }]}>{records.error}</Text> : null}
        </ScrollView>}
        {enlarged ? <View style={[styles.imageOverlay, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
          <Pressable onPress={() => setEnlarged(null)} style={styles.imageClose}><Text style={{ color: '#FFFFFF', fontSize: 16 }}>关闭</Text></Pressable>
          <RecordImage image={enlarged} visual={visual} large />
        </View> : null}
      </KeyboardAvoidingView>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 22 },
  title: { fontSize: 29, fontWeight: '700', letterSpacing: 2 },
  menu: { width: 42, height: 42, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  tabs: { flexDirection: 'row', padding: 4, borderRadius: 16, marginBottom: 18 },
  tab: { flex: 1, paddingVertical: 11, borderRadius: 12, alignItems: 'center' },
  tabText: { fontSize: 15, fontWeight: '600' },
  tools: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginBottom: 8 },
  hint: { fontSize: 13 },
  action: { paddingVertical: 12, paddingHorizontal: 16, borderRadius: 13, minHeight: 44, justifyContent: 'center' },
  date: { fontSize: 14, marginTop: 23, marginBottom: 12 },
  paper: { padding: 18, borderRadius: 16, borderWidth: 1, marginBottom: 12 },
  metadata: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  body: { fontSize: 16, lineHeight: 29 },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  thumbnail: { width: 86, height: 86, borderRadius: 10, overflow: 'hidden', justifyContent: 'center' },
  thumbnailImage: { width: '100%', height: '100%' },
  more: { alignItems: 'center', padding: 16 },
  feather: { alignItems: 'center', paddingVertical: 24 },
  editor: { flex: 1 },
  editorHeader: { paddingHorizontal: 20, paddingBottom: 24, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  back: { minHeight: 44, minWidth: 44, justifyContent: 'center', paddingVertical: 10, paddingHorizontal: 4 },
  editorDate: { fontSize: 25, letterSpacing: 1, marginBottom: 8 },
  saveStatus: { marginBottom: 20, minHeight: 20 },
  writingArea: { flex: 1, minHeight: 0, paddingHorizontal: 24 },
  writingViewport: { flex: 1, minHeight: 0, overflow: 'hidden' },
  input: { flex: 1, minHeight: 0, fontSize: 17, lineHeight: 31, paddingTop: 17, paddingBottom: 32, borderTopWidth: 1, borderBottomWidth: 1 },
  writingImages: { flexGrow: 0, maxHeight: 144 },
  writingImagesRow: { flexWrap: 'nowrap' },
  readingViewport: { flex: 1, minHeight: 0 },
  removeImage: { alignItems: 'center', paddingVertical: 12, minHeight: 44 },
  error: { fontSize: 13, lineHeight: 21, paddingVertical: 10 },
  imageOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: '#111723' },
  imageClose: { alignSelf: 'flex-end', padding: 20, minHeight: 44 },
  largeImageHost: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  largeImage: { width: '100%', height: '100%' },
});
