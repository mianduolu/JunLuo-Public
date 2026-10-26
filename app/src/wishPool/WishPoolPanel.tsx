import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { colors } from '../theme/colors';
import { loadWishPoolSnapshot, type WishItem, type WishPoolSnapshot } from './wishPoolStore';
import { beginWishFromPool, drawWishFromPool, isWishChatBusy, subscribeWishChatChanges } from './wishPoolChatRuntime';
import type { WishDiscussionPurpose } from './wishPoolDiscussionState';
import { WishPoolPond, type WishPondMotion } from './WishPoolPond';
import { WishDiscussionCard } from './WishDiscussionCard';
import { visibleWishCoins, wishBookEntries, wishDate, wishOwnerLabel, WISH_BOOK_FILTERS, WISH_PURPOSE_LABELS, WISH_STATUS_LABELS, type WishBookFilter } from './wishPoolPresentation';

export function WishPoolPanel({ covered = false, onOpenChat }: { covered?: boolean; onOpenChat?: () => void }) {
  const insets = useSafeAreaInsets();
  const [snapshot, setSnapshot] = useState<WishPoolSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [tab, setTab] = useState<'pond' | 'book'>('pond');
  const [filter, setFilter] = useState<WishBookFilter>('全部');
  const [limit, setLimit] = useState(20);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState<WishPondMotion>('idle');
  const [now, setNow] = useState(Date.now());
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [draftSubmitted, setDraftSubmitted] = useState(false);
  const [drawn, setDrawn] = useState<WishItem | null>(null);
  const [drawSettled, setDrawSettled] = useState(false);
  const draftSource = useRef<string | null>(null);
  const operation = useRef(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const refresh = async () => {
    const request = ++version.current;
    const epoch = captureBackupRestoreDataEpoch();
    setLoading(true);
    if (epoch === null) { setSnapshot(null); setLoading(false); return; }
    try {
      const result = await loadWishPoolSnapshot();
      if (!mounted.current || request !== version.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      setSnapshot(result); setNow(Date.now()); setError(false);
    } catch {
      if (mounted.current && request === version.current && canCommitBackupRestoreDataEpoch(epoch)) setError(true);
    } finally {
      if (mounted.current && request === version.current) setLoading(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (!covered) void refresh();
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active' && !covered) void refresh(); });
    const unsubscribe = subscribeBackupRestoreRuntimeState((state) => {
      if (state.status !== 'ready') {
        version.current++; setSnapshot(null); setDraft(''); setPreview('idle'); setLoading(false); setError(false);
        draftSource.current = null; setDraftSubmitted(false); setDrawn(null); setDrawSettled(false); setActionError(null);
      } else if (!covered) void refresh();
    });
    const changes = subscribeWishChatChanges(() => { if (!covered) void refresh(); });
    return () => { mounted.current = false; version.current++; listener.remove(); unsubscribe(); changes(); };
  }, [covered]);

  const coins = snapshot ? visibleWishCoins(snapshot, now) : [];
  const discussion = snapshot?.collaboration?.discussions.find((item) => item.closedAt === undefined);
  const entries = snapshot ? wishBookEntries(snapshot, filter) : [];
  const total = snapshot?.wishes.length ?? 0;
  const pooled = snapshot?.wishes.filter((item) => ['active', 'in-progress', 'deferred'].includes(item.status)).length ?? 0;
  const hasCloudActive = snapshot?.wishes.some((item) => item.owner === 'I' && item.status === 'active');
  const draftLength = Array.from(draft.trim()).length;
  const busy = saving || loading || isWishChatBusy();
  const begin = async (purpose: WishDiscussionPurpose, wishId?: string) => {
    if (operation.current || busy || !onOpenChat || discussion || (!wishId && (!draftLength || draftLength > 160))) return;
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return;
    operation.current = true; setSaving(true); setActionError(null);
    if (!wishId) { draftSource.current ??= `wish-draft:${Date.now()}:${Math.random().toString(36).slice(2)}`; setDraftSubmitted(true); }
    const sourceId = wishId ? `wish-book:${wishId}:${purpose}:${Date.now()}` : draftSource.current!;
    try {
      await beginWishFromPool({ ...(wishId ? { wishId } : { content: draft.trim() }), purpose, sourceId });
      if (!mounted.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      if (!wishId) { setDraft(''); setDrafting(false); setDraftSubmitted(false); draftSource.current = null; }
      onOpenChat();
    } catch {
      if (mounted.current && canCommitBackupRestoreDataEpoch(epoch)) setActionError('未能进入愿望讨论，请重试；已经保存的愿望不会重复创建。');
    } finally {
      operation.current = false;
      if (mounted.current) { setSaving(false); void refresh(); }
    }
  };
  const draw = async (wishId?: string) => {
    if (operation.current || busy || drawn) return;
    const epoch = captureBackupRestoreDataEpoch();
    if (epoch === null) return;
    operation.current = true; setSaving(true); setActionError(null);
    try {
      const result = await drawWishFromPool(wishId);
      if (!mounted.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      if (result) { setDrawSettled(false); setDrawn(result); }
      else setActionError('池里暂时没有可以捞起的愿望。');
    } catch {
      if (mounted.current && canCommitBackupRestoreDataEpoch(epoch)) setActionError('本次捞取未完成，请刷新愿望记录后重试。');
    } finally {
      operation.current = false;
      if (mounted.current) { setSaving(false); void refresh(); }
    }
  };

  return <ScrollView testID="wish-pool-panel" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: Math.max(32, insets.bottom + 24) }]}>
    <View style={styles.heading}>
      <View><Text style={styles.kicker}>两小只的</Text><Text style={styles.title}>许愿池</Text></View>
      <Pressable onPress={() => void refresh()} disabled={loading} accessibilityRole="button" accessibilityLabel="刷新愿望记录" accessibilityState={{ disabled: loading }} style={styles.refresh}>
        {loading ? <ActivityIndicator color="#627C87" /> : <Text style={styles.muted}>刷新 ↻</Text>}
      </Pressable>
    </View>
    <Text style={styles.stageNote}>愿望带到聊天里商量，核对后再确认保存。</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>读取失败，请重试。已有显示未替换，不代表池中没有愿望。</Text> : null}
    {actionError ? <Text accessibilityRole="alert" style={styles.error}>{actionError}</Text> : null}
    <View style={styles.tabs}>
      {(['pond', 'book'] as const).map((key) => <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: tab === key }} onPress={() => setTab(key)} style={[styles.tab, tab === key && styles.tabSelected]}>
        <Text style={[styles.tabText, tab === key && styles.tabTextSelected]}>{key === 'pond' ? '池面' : `愿望簿${snapshot ? ` · ${total}` : ''}`}</Text>
      </Pressable>)}
    </View>
    {!snapshot ? <View style={styles.empty}><Text style={styles.muted}>{loading ? '正在读取愿望记录…' : '愿望记录暂未加载'}</Text></View> : <>
      {tab === 'pond' ? <>
        <View style={styles.pondCard}>
          <View style={styles.pondTop}><Text style={styles.kicker}>许愿币 · 不设余额</Text><Text style={styles.muted}>{pooled} 颗在池中</Text></View>
          <WishPoolPond />
          <Text style={styles.pondCaption}>{!pooled ? '池中还没有已投入的愿望' : coins.length ? `${coins.length} 颗白云的愿望可以捞起` : hasCloudActive ? '许愿币暂时沉底，七天后再浮起' : '暂无可捞取的白云愿望'}</Text>
          <View style={styles.actions}>
            <Pressable accessibilityRole="button" onPress={() => setDrafting(!drafting)} style={[styles.button, styles.primary]}><Text style={styles.buttonText}>提出愿望</Text></Pressable>
            <Pressable disabled={busy || !coins.length || !!drawn} onPress={() => void draw()} accessibilityRole="button" accessibilityState={{ disabled: busy || !coins.length || !!drawn }} style={[styles.button, busy || !coins.length || !!drawn ? styles.disabled : styles.primary]}><Text style={styles.buttonText}>捞一枚许愿币</Text></Pressable>
          </View>
          <Text style={styles.note}>冷却从上次捞取起算七天；翻愿望簿不算重捞。</Text>
        </View>
        {drafting ? <View style={styles.paper}>
          <Text style={styles.sectionTitle}>写一颗愿望</Text>
          <TextInput accessibilityLabel="愿望草稿" placeholder="想一起实现的愿望" multiline value={draft} onChangeText={setDraft} editable={!draftSubmitted && !saving} style={styles.input} textAlignVertical="top" />
          <Text style={draftLength > 160 ? styles.error : styles.note}>{draftLength} / 160 字符 · 可以写 emoji 或颜文字</Text>
          {draftLength > 160 ? <Text accessibilityRole="alert" style={styles.error}>正文需要是 1—160 个字符。</Text> : null}
          <Pressable disabled={busy || !!discussion || !onOpenChat || !draftLength || draftLength > 160} onPress={() => void begin('cast_coin')} accessibilityRole="button" accessibilityState={{ disabled: busy || !!discussion || !onOpenChat || !draftLength || draftLength > 160 }} style={[styles.button, styles.primary]}><Text style={styles.buttonText}>带去商量</Text></Pressable>
          <Text style={styles.note}>{discussion ? '已有一颗愿望正在商量，请先到聊天继续。' : draftSubmitted ? '这份草稿已经提交，失败时可重试同一份；保存后会进入聊天。' : '点击后保存为待商量愿望，不会直接投币。未提交的草稿离开页面后不保留。'}</Text>
        </View> : null}
        {coins.length ? <View style={styles.paper}>
          <Text style={styles.sectionTitle}>浮在池面的许愿币</Text>
          <Text style={styles.note}>只列可捞取项；查看不会触发捞取。</Text>
          {coins.slice(0, 12).map((wish) => <View key={wish.id}>
            <Pressable accessibilityRole="button" accessibilityLabel={`查看白云的愿望：${wish.content}`} onPress={() => { setTab('book'); setFilter('全部'); setLimit(total); setExpanded(wish.id); }} style={styles.coinRow}>
              <Text style={styles.smallCoin}>✦</Text><Text style={styles.coinText}>{wish.content}</Text><Text style={styles.muted}>›</Text>
            </Pressable>
            <Pressable disabled={busy || !!drawn} onPress={() => void draw(wish.id)} accessibilityRole="button" accessibilityLabel={`捞起这颗愿望：${wish.content}`} accessibilityState={{ disabled: busy || !!drawn }} style={styles.previewButton}><Text style={styles.previewText}>捞起这一颗</Text></Pressable>
          </View>)}
        </View> : null}
        <View style={styles.previewRow}>
          <Text style={styles.note}>独立动画预览 · 不写入记录</Text>
          <View style={styles.actions}>{(['cast', 'draw'] as const).map((motion) => <Pressable key={motion} accessibilityRole="button" onPress={() => setPreview(motion)} style={styles.previewButton}><Text style={styles.previewText}>{motion === 'cast' ? '投币动画' : '捞币动画'}</Text></Pressable>)}</View>
        </View>
      </> : <>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
          {WISH_BOOK_FILTERS.map((item) => <Pressable key={item} accessibilityRole="tab" accessibilityState={{ selected: filter === item }} onPress={() => { setFilter(item); setLimit(20); }} style={[styles.filter, filter === item && styles.filterSelected]}><Text style={styles.filterText}>{item}</Text></Pressable>)}
        </ScrollView>
        {!entries.length ? <View style={styles.empty}><Text style={styles.sectionTitle}>{total ? '这一页还没有记录' : '愿望簿还是空的'}</Text><Text style={styles.note}>这里展示实际保存的愿望和进展。</Text></View> : null}
        {entries.slice(0, limit).map((wish) => {
          const notes = snapshot.collaboration?.progressNotes.filter((item) => item.wishId === wish.id) ?? [];
          const facts = snapshot.collaboration?.confirmations.filter((item) => item.wishId === wish.id) ?? [];
          const open = expanded === wish.id;
          return <View key={wish.id} style={styles.paper}>
            <View style={styles.entryMeta}><Text style={styles.kicker}>{wishOwnerLabel(wish.owner)}的愿望</Text><Text style={styles.status}>{WISH_STATUS_LABELS[wish.status]}</Text></View>
            <Text selectable style={styles.wishBody}>{wish.content}</Text>
            <Text style={styles.note}>{wishDate(wish.createdAt)} 记录{wish.castAt !== undefined ? ` · ${wishDate(wish.castAt)} 投币` : ''}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel={`${open ? '收起' : '查看'}这颗愿望的记录`} accessibilityState={{ expanded: open }} onPress={() => setExpanded(open ? null : wish.id)} style={styles.recordButton}>
              <Text style={styles.previewText}>{open ? '收起记录' : `查看记录 · ${notes.length} 条进展`} {open ? '⌃' : '⌄'}</Text>
            </Pressable>
            {open ? <View style={styles.history}>
              {!notes.length && !facts.length ? <Text style={styles.note}>没有新版讨论或进展记录；旧记录未补造。</Text> : null}
              {notes.map((note) => <View key={note.id} style={styles.historyItem}><Text style={styles.kicker}>{wishDate(note.recordedAt)} · 进展</Text><Text selectable style={styles.historyText}>{note.content}</Text></View>)}
              {facts.filter((fact) => fact.purpose !== 'progress' || fact.decision === 'no').map((fact) => <View key={fact.id} style={styles.historyItem}><Text style={styles.kicker}>{wishDate(fact.confirmedAt)} · {WISH_PURPOSE_LABELS[fact.purpose]} · {fact.decision === 'yes' ? '确认' : '未采纳本次提议'}</Text><Text selectable style={styles.historyText}>{fact.pendingText}</Text></View>)}
              {wish.lastPulledAt !== undefined ? <Text style={styles.note}>上次捞取：{wishDate(wish.lastPulledAt)}</Text> : null}
              {wish.fulfilledAt !== undefined ? <Text style={styles.note}>完成记录：{wishDate(wish.fulfilledAt)}</Text> : null}
              {wish.releasedAt !== undefined ? <Text style={styles.note}>放下记录：{wishDate(wish.releasedAt)}</Text> : null}
              <View style={styles.actions}>
                {(wish.status === 'candidate' ? ['cast_coin'] as const : ['active', 'in-progress', 'deferred'].includes(wish.status) ? ['revise', 'progress', 'complete', 'release'] as const : []).map((purpose) =>
                  <Pressable key={purpose} disabled={busy || !!discussion || !onOpenChat} onPress={() => void begin(purpose, wish.id)} accessibilityRole="button" accessibilityState={{ disabled: busy || !!discussion || !onOpenChat }} style={[styles.button, styles.primary]}><Text style={styles.buttonText}>商量{WISH_PURPOSE_LABELS[purpose]}</Text></Pressable>)}
              </View>
            </View> : null}
          </View>;
        })}
        {entries.length > limit ? <Pressable accessibilityRole="button" onPress={() => setLimit(limit + 20)} style={styles.button}><Text style={styles.previewText}>再翻 20 条</Text></Pressable> : null}
      </>}
      {discussion ? <WishDiscussionCard discussion={discussion} busy={busy} onContinue={onOpenChat} /> : null}
    </>}
    <Modal visible={preview !== 'idle'} transparent animationType="fade" onRequestClose={() => setPreview('idle')}>
      <View style={[styles.modalBackdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <View style={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.sectionTitle}>动画预览</Text>
          <Text style={styles.note}>仅演示许愿币动作，不代表保存、投币或捞取成功。</Text>
          {preview !== 'idle' ? <WishPoolPond key={preview} motion={preview} /> : null}
          <Pressable accessibilityRole="button" onPress={() => setPreview('idle')} style={[styles.button, styles.primary]}><Text style={styles.buttonText}>关闭预览</Text></Pressable>
        </View>
      </View>
    </Modal>
    <Modal visible={!!drawn} transparent animationType="fade" onRequestClose={() => { setDrawn(null); setDrawSettled(false); }}>
      <View style={[styles.modalBackdrop, { paddingTop: insets.top + 16, paddingBottom: insets.bottom + 16 }]}>
        <ScrollView contentContainerStyle={styles.modalCard} accessibilityViewIsModal>
          <Text style={styles.sectionTitle}>{drawSettled ? '捞到一颗愿望' : '许愿币浮起来了'}</Text>
          {drawn ? <WishPoolPond key={`${drawn.id}:${drawn.lastPulledAt ?? now}`} motion="draw" onSettled={() => setDrawSettled(true)} /> : null}
          {drawSettled && drawn ? <Text testID="wish-drawn-content" selectable style={styles.wishBody}>{drawn.content}</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => { if (drawn) { setTab('book'); setFilter('全部'); setLimit(total); setExpanded(drawn.id); } setDrawn(null); setDrawSettled(false); }} style={[styles.button, styles.primary]}><Text style={styles.buttonText}>回到愿望簿</Text></Pressable>
        </ScrollView>
      </View>
    </Modal>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, gap: 16 },
  heading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 8 },
  kicker: { color: '#687E82', fontSize: 12, lineHeight: 19, letterSpacing: 1 },
  title: { color: colors.ink, fontSize: 32, fontWeight: '600', letterSpacing: 3, marginTop: 4 },
  refresh: { minWidth: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  muted: { color: colors.muted, fontSize: 13 },
  stageNote: { color: '#6B7883', fontSize: 12, lineHeight: 19 },
  tabs: { flexDirection: 'row', gap: 8, borderBottomWidth: 1, borderColor: '#DCE7EC' },
  tab: { minHeight: 48, paddingHorizontal: 18, justifyContent: 'center', borderBottomWidth: 2, borderColor: 'transparent' },
  tabSelected: { borderColor: '#B37663' },
  tabText: { color: colors.muted, fontSize: 16 },
  tabTextSelected: { color: '#98634F', fontWeight: '600' },
  pondCard: { backgroundColor: '#F9FCF7', borderRadius: 28, padding: 18, borderWidth: 1, borderColor: '#E1ECE7', gap: 12 },
  pondTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  pondCaption: { color: '#526E70', fontSize: 15, textAlign: 'center', lineHeight: 23, marginBottom: 6 },
  actions: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  primary: { backgroundColor: '#F3C4B2' },
  disabled: { backgroundColor: '#E9ECE8' },
  buttonText: { color: '#635D58', fontSize: 14, lineHeight: 21 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 20 },
  error: { color: '#9C443D', fontSize: 13, lineHeight: 21 },
  paper: { backgroundColor: '#FFFDFA', borderRadius: 22, padding: 20, borderWidth: 1, borderColor: '#E9E3D8', gap: 12 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '600', lineHeight: 27 },
  input: { color: colors.ink, minHeight: 110, backgroundColor: '#F5F4EF', borderRadius: 14, padding: 14, fontSize: 16, lineHeight: 26 },
  coinRow: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderColor: '#EEECE4', paddingVertical: 10 },
  smallCoin: { color: '#997432', fontSize: 20, backgroundColor: '#F9E7AF', borderRadius: 20, width: 36, height: 36, textAlign: 'center', textAlignVertical: 'center' },
  coinText: { flex: 1, fontSize: 14, lineHeight: 23, color: colors.ink },
  previewRow: { gap: 4, alignItems: 'center', marginVertical: 4 },
  previewButton: { minHeight: 48, paddingHorizontal: 16, justifyContent: 'center' },
  previewText: { color: '#687D88', fontSize: 14, lineHeight: 22 },
  filters: { gap: 8 },
  filter: { minHeight: 48, paddingHorizontal: 16, borderRadius: 16, justifyContent: 'center', backgroundColor: '#EAF0F3' },
  filterSelected: { backgroundColor: '#D6E8E5' },
  filterText: { color: '#52666C', fontSize: 13 },
  empty: { minHeight: 180, justifyContent: 'center', alignItems: 'center', gap: 12 },
  entryMeta: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' },
  status: { fontSize: 12, color: '#836C53', backgroundColor: '#F5ECDD', borderRadius: 8, paddingHorizontal: 8, paddingVertical: 3 },
  wishBody: { color: colors.ink, fontSize: 18, lineHeight: 29 },
  recordButton: { minHeight: 48, justifyContent: 'center' },
  history: { borderTopWidth: 1, borderColor: '#EAE4D9', paddingTop: 14, gap: 14 },
  historyItem: { borderLeftWidth: 2, borderColor: '#CCDCD6', paddingLeft: 12, gap: 5 },
  historyText: { color: colors.ink, fontSize: 14, lineHeight: 23 },
  modalBackdrop: { flex: 1, justifyContent: 'center', paddingHorizontal: 20, backgroundColor: 'rgba(40,55,64,0.35)' },
  modalCard: { backgroundColor: '#FFFDFA', padding: 20, borderRadius: 26, gap: 12 },
});
