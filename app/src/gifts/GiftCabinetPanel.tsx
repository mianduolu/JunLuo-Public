import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, Image, Linking, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { cancelGiftSchedule, createGiftDraft, deleteGift, deleteGiftDraft, listGiftViews, recordGiftOpening, withdrawGiftDelivery } from './giftStore';
import type { GiftDeletionMode } from './giftDeletion';
import { subscribeGiftChanges } from './giftEvents';
import { giftOriginalUri } from './giftFiles';
import { GIFT_FILTERS, giftByteSize, giftDate, giftErrorText, giftKindLabel, giftStatusLabel } from './giftPresentation';
import { GiftEditor } from './GiftEditor';
import { GiftSupplementEditor } from './GiftSupplementEditor';
import { GiftAttachmentViewer } from './GiftAttachmentViewer';
import { GiftEchoPanel } from './GiftEchoPanel';
import { openGiftAttachment } from './giftAttachmentStore';
import { GiftIcon } from './GiftIcon';
import { giftStyles as s } from './giftStyles';
import type { GiftRecord, GiftVersion, GiftView } from './giftTypes';

function GiftCover({ view, large = false, resourceVersion = 0 }: { view: GiftView; large?: boolean; resourceVersion?: number }) {
  const [failed, setFailed] = useState(false);
  const uri = view.gift.cover ? giftOriginalUri(view.gift.cover) : null;
  useEffect(() => { setFailed(false); }, [uri, resourceVersion]);
  return <View style={[large ? s.detailCover : s.cover, { backgroundColor: view.gift.sender === 'you' ? '#FFE2D7' : '#E5F2FF' }]}>
    {uri && !failed ? <Image key={resourceVersion} accessibilityLabel="礼物包装" source={{ uri }} style={s.image} resizeMode="cover" onError={() => setFailed(true)} />
      : <View style={s.token}><GiftIcon size={large ? 36 : 29} /></View>}
  </View>;
}

export function GiftCabinetPanel({ covered = false, onOpenDrawer }: { covered?: boolean; onOpenDrawer: () => void }) {
  const insets = useSafeAreaInsets();
  const [views, setViews] = useState<GiftView[]>([]);
  const [resourceVersion, setResourceVersion] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [info, setInfo] = useState('');
  const [preparing, setPreparing] = useState(false);
  const [filter, setFilter] = useState<'all' | 'mine' | 'received'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ gift: GiftRecord; newDraft: boolean } | null>(null);
  const [supplementing, setSupplementing] = useState<GiftRecord | null>(null);
  const [menu, setMenu] = useState(false);
  const [attachmentTarget, setAttachmentTarget] = useState<(GiftVersion & { attachmentId: string }) | null>(null);
  const alive = useRef(true), generation = useRef(0), reads = useRef(0), action = useRef(false);
  const echoGuard = useRef<(() => Promise<boolean>) | null>(null), selectedRef = useRef(selectedId); selectedRef.current = selectedId;
  const leaveSelected = async () => {
    const id = selectedRef.current, ownGeneration = generation.current;
    if (echoGuard.current && !await echoGuard.current()) return;
    if (alive.current && generation.current === ownGeneration && selectedRef.current === id) { setSelectedId(null); setMenu(false); setError(''); }
  };
  const fresh = (epoch: number | null, ownGeneration: number) => alive.current
    && generation.current === ownGeneration && canCommitBackupRestoreDataEpoch(epoch);
  const refresh = async () => {
    const serial = ++reads.current, ownGeneration = generation.current, epoch = captureBackupRestoreDataEpoch();
    try {
      const next = await listGiftViews('you');
      if (serial === reads.current && fresh(epoch, ownGeneration)) { setViews(next); setResourceVersion(value => value + 1); setError(''); }
    } catch (cause) {
      if (serial === reads.current && fresh(epoch, ownGeneration)) setError(giftErrorText(cause));
    } finally { if (serial === reads.current && alive.current) setLoading(false); }
  };
  useEffect(() => {
    alive.current = true;
    if (!covered) void refresh();
    const foreground = AppState.addEventListener('change', state => { if (state === 'active' && !covered) void refresh(); });
    const gifts = subscribeGiftChanges(() => { if (!covered) void refresh(); });
    const restore = subscribeBackupRestoreRuntimeState(state => {
      if (state.status !== 'ready') {
        generation.current++; reads.current++; action.current = false;
        setViews([]); setEditing(null); setSupplementing(null); setAttachmentTarget(null); setSelectedId(null); setLoading(false); setBusy(false); setError(''); setInfo('');
      } else if (!covered) { setLoading(true); void refresh(); }
    });
    return () => { alive.current = false; generation.current++; reads.current++; foreground.remove(); restore(); gifts(); };
  }, [covered]);

  async function perform<T>(work: () => Promise<T>, complete: (result: T) => void, discard?: (result: T) => Promise<unknown>) {
    if (action.current) return;
    action.current = true; setBusy(true); setError(''); setInfo('');
    const epoch = captureBackupRestoreDataEpoch(), ownGeneration = generation.current;
    try {
      const result = await work();
      if (fresh(epoch, ownGeneration)) { complete(result); void refresh(); }
      else if (canCommitBackupRestoreDataEpoch(epoch)) await discard?.(result);
    } catch (cause) {
      if (fresh(epoch, ownGeneration)) {
        await refresh();
        if (fresh(epoch, ownGeneration)) setError(giftErrorText(cause));
      }
    } finally {
      if (generation.current === ownGeneration) { action.current = false; if (alive.current) setBusy(false); }
    }
  }
  const create = () => {
    void perform(() => createGiftDraft('you'), gift => { setEditing({ gift, newDraft: true }); setMenu(false); }, deleteGiftDraft);
  };
  const selected = views.find(view => view.gift.id === selectedId);
  const visible = views.filter(view => preparing
    ? view.gift.sender === 'you' && view.gift.deliveryStatus !== 'delivered'
    : view.gift.deliveryStatus === 'delivered' && (filter === 'all' || view.gift.sender === (filter === 'mine' ? 'you' : 'I')));
  const drafts = views.filter(view => view.gift.sender === 'you' && view.gift.deliveryStatus !== 'delivered').length;
  const deleteDraft = (gift: GiftRecord) => Alert.alert('删除这份草稿？', '原件和准备内容会一起删除。', [
    { text: '保留', style: 'cancel' },
    { text: '删除草稿', style: 'destructive', onPress: () => { void perform(() => deleteGiftDraft(gift), collection => {
      setSelectedId(null); setMenu(false); if (collection.failed) setInfo('草稿已删除，部分原件稍后再清理。');
    }); } },
  ]);
  const deleteSelected = async (gift: GiftVersion, mode: GiftDeletionMode) => {
    const ownGeneration = generation.current;
    if (echoGuard.current && !await echoGuard.current()) return;
    if (!alive.current || generation.current !== ownGeneration || selectedRef.current !== gift.id) return;
    const label = mode === 'keep-memory' ? '删除礼物，保留记忆' : '删除礼物及相关记忆';
    Alert.alert(label + '？', mode === 'keep-memory'
      ? '原件、进度、回音及待处理工作会删除；已有记忆保留。'
      : '原件、进度、回音及待处理工作会删除，并清理完全来自这份礼物的记忆；混合来源正文保留。', [
      { text: '保留', style: 'cancel' },
      { text: label, style: 'destructive', onPress: () => {
        if (!alive.current || generation.current !== ownGeneration || selectedRef.current !== gift.id) return;
        void perform(() => deleteGift(gift, mode), result => {
          setSelectedId(null); setAttachmentTarget(null); setMenu(false);
          if (result.collection.failed) setInfo('礼物已删除，部分原件稍后再清理。');
        }); } },
    ]);
  };

  return <View style={s.page}>
    <ScrollView contentContainerStyle={[s.content, { paddingBottom: Math.max(32, insets.bottom + 20) }]} keyboardShouldPersistTaps="handled">
      {selected ? <>
        <View style={s.between}>
          <Pressable accessibilityRole="button" style={s.smallButton} onPress={() => { void leaveSelected(); }}><Text style={s.link}>‹ 返回柜子</Text></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="礼物操作" disabled={busy} style={s.smallButton} onPress={() => setMenu(value => !value)}><Text style={s.ink}>···</Text></Pressable>
        </View>
        <Text style={s.heading}>{selected.gift.title || '未命名的礼物'}</Text>
        <Text style={s.muted}>{selected.gift.sender === 'you' ? '小仓鼠 → 白云小姐' : '白云小姐 → 小仓鼠'} · {giftStatusLabel(selected.gift)} · 本机保存</Text>
        <GiftCover view={selected} large resourceVersion={resourceVersion} />
        {menu && <View style={s.menu}>
          {selected.revealed && selected.gift.sender === 'you' && selected.gift.deliveryStatus === 'scheduled' &&
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => {
              void perform(() => cancelGiftSchedule(selected.gift), () => setMenu(false));
            }}><Text style={s.ink}>取消定时</Text></Pressable>}
          {selected.revealed && selected.gift.sender === 'you' && !['delivered', 'scheduled'].includes(selected.gift.deliveryStatus) && selected.gift.openedAt === null && <>
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => { setEditing({ gift: selected.gift, newDraft: false }); setMenu(false); }}><Text style={s.ink}>继续准备</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => deleteDraft(selected.gift)}><Text style={s.ink}>删除草稿</Text></Pressable>
          </>}
          {selected.revealed && selected.gift.sender === 'you' && selected.gift.deliveryStatus === 'delivered' && selected.gift.openedAt === null &&
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => { void perform(() => withdrawGiftDelivery(selected.gift), gift => {
              setEditing({ gift, newDraft: false }); setMenu(false);
            }); }}><Text style={s.ink}>撤回并修改</Text></Pressable>}
          {selected.revealed && selected.gift.sender === 'you' && selected.gift.deliveryStatus === 'delivered'
            && selected.gift.receptionStatus === 'opened' && selected.gift.openedAt !== null &&
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => {
              setSupplementing(selected.gift); setMenu(false);
            }}><Text style={s.ink}>补充附件</Text></Pressable>}
          {['delivered', 'scheduled'].includes(selected.gift.deliveryStatus) && <>
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => { void deleteSelected(selected.gift, 'keep-memory'); }}><Text style={s.ink}>删除礼物，保留记忆</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={busy} style={s.button} onPress={() => { void deleteSelected(selected.gift, 'delete-related-memory'); }}><Text style={s.ink}>删除礼物及相关记忆</Text></Pressable>
          </>}
        </View>}
        {!selected.revealed ? <>
          <Pressable accessibilityRole="button" disabled={busy} style={[s.button, s.primary, { marginTop: 20 }, busy && s.disabled]} onPress={() => { void perform(() => recordGiftOpening(selected.gift), () => setMenu(false)); }}><Text style={s.ink}>打开礼物</Text></Pressable>
          <Pressable accessibilityRole="button" style={[s.button, { marginTop: 10 }]} onPress={() => setSelectedId(null)}><Text style={s.link}>先放回柜子</Text></Pressable>
          <Text style={s.info}>打开后可继续聊。</Text>
        </> : <>
          {selected.gift.scheduledAt !== null && <Text style={s.info}>{selected.gift.deliveryStatus === 'delivered' ? '原定送达' : selected.gift.deliveryStatus === 'scheduled' ? '计划送达' : '准备时间'}：{giftDate(selected.gift.scheduledAt)}</Text>}
          {selected.gift.deliveredAt !== null && <Text style={s.info}>实际送达：{giftDate(selected.gift.deliveredAt)}</Text>}
          {selected.gift.receptionStatus === 'deferred' && selected.gift.receptionNextAt != null &&
            <Text style={s.info}>稍后再看：{giftDate(selected.gift.receptionNextAt)}</Text>}
          <View style={s.section}><Text style={s.ink}>赠送留言</Text><Text style={s.ink}>{selected.gift.note || '没有附加留言'}</Text></View>
          <View style={s.section}>
            <Text style={s.ink}>礼物里的原件</Text>
            {selected.gift.attachments.map((item, index) => <View key={item.id} style={s.attachment}>
              <Text style={s.muted}>{index + 1} · {giftKindLabel(item.kind)}{selected.gift.supplementalAttachmentIds?.includes(item.id) ? ' · 后来补充' : ''}{item.kind !== 'url' ? ' · ' + giftByteSize(item.original.byteSize) : ''}</Text>
              <Text selectable style={s.ink}>{item.kind === 'url' ? item.url : item.original.originalName}</Text>
              {item.kind === 'image' && <Image key={`${item.original.id}:${resourceVersion}`} source={{ uri: giftOriginalUri(item.original) }} resizeMode="contain" style={{ width: '100%', height: 160 }} accessibilityLabel="礼物图片" />}
              <Pressable accessibilityRole="button" disabled={busy} style={s.button} accessibilityLabel={'打开礼物原件：' + (item.kind === 'url' ? item.url : item.original.originalName)} onPress={() => {
                if (item.kind !== 'url') { setAttachmentTarget({ id: selected.gift.id, revision: selected.gift.revision, attachmentId: item.id }); return; }
                void perform(async () => {
                  const access = await openGiftAttachment(selected.gift, item.id, 'you');
                  if (access.attachment.kind !== 'url') return;
                  const protocol = new URL(access.attachment.url).protocol;
                  if (!['http:', 'https:'].includes(protocol)) throw Error('gift-invalid-url');
                  await Linking.openURL(access.attachment.url);
                }, () => undefined);
              }}><Text style={s.link}>{item.kind === 'image' ? '查看大图' : item.kind === 'audio' ? '打开播放器' : item.kind === 'html' ? '打开小网页' : '打开网页链接'}</Text></Pressable>
            </View>)}
          </View>
          {selected.gift.deliveryStatus === 'delivered' && selected.gift.openedAt !== null
            ? <GiftEchoPanel key={selected.gift.id + ':' + selected.gift.revision} gift={selected.gift} onGuardChange={guard => { echoGuard.current = guard; }} />
            : <Text style={s.info}>打开后可继续聊。</Text>}
        </>}
      </> : <>
        <Text style={s.breadcrumb}>往来</Text>
        <View style={s.between}>
          <View style={s.row}>
            <Pressable accessibilityRole="button" accessibilityLabel="打开往来侧边栏" style={s.smallButton} onPress={onOpenDrawer}><Text style={s.ink}>☰</Text></Pressable>
            <Text style={s.title}>{preparing ? '准备中' : '礼物柜'}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="准备新礼物" disabled={busy} style={s.round} onPress={create}><Text style={s.plus}>＋</Text></Pressable>
        </View>
        <Text style={s.muted}>本机保存</Text>
        <View style={s.between}>
          {preparing ? <Pressable accessibilityRole="button" style={s.smallButton} onPress={() => { setPreparing(false); setError(''); }}><Text style={s.link}>‹ 返回柜子</Text></Pressable>
            : <View style={s.filters}>{GIFT_FILTERS.map(item => <Pressable key={item.key} accessibilityRole="tab" accessibilityState={{ selected: filter === item.key }} style={[s.chip, filter === item.key && s.chipActive]} onPress={() => setFilter(item.key)}><Text style={filter === item.key ? s.ink : s.link}>{item.label}</Text></Pressable>)}</View>}
          {!preparing && <Pressable accessibilityRole="button" style={s.smallButton} onPress={() => { setPreparing(true); setError(''); }}><Text style={s.link}>准备中{drafts ? ' ' + drafts : ''}</Text></Pressable>}
        </View>
        {loading && <ActivityIndicator accessibilityLabel="正在读取礼物" color="#697184" />}
        {!loading && !visible.length && <View style={s.empty}><GiftIcon size={38} /><Text style={s.muted}>{preparing ? '还没有准备中的礼物。' : '柜子里还没有礼物。'}</Text></View>}
        <View style={s.grid}>
          {visible.map(view => <Pressable key={view.gift.id} accessibilityRole="button" accessibilityLabel={'查看礼物：' + (view.gift.title || '未命名的礼物')} style={s.tile} onPress={() => { setSelectedId(view.gift.id); setMenu(false); setError(''); }}>
            <GiftCover view={view} resourceVersion={resourceVersion} />
            <Text style={s.giftName}>{view.gift.title || '未命名的礼物'}</Text>
            <Text style={s.muted}>{view.gift.sender === 'you' ? '我送的' : '她送的'} · {giftStatusLabel(view.gift)}</Text>
            <Text style={s.muted}>{giftDate(view.gift.deliveredAt ?? view.gift.updatedAt)}</Text>
          </Pressable>)}
        </View>
        <View style={s.footer}><GiftIcon /></View>
      </>}
      {busy && <ActivityIndicator accessibilityLabel="正在保存礼物状态" color="#697184" />}
      {!!error && <View><Text accessibilityRole="alert" style={s.error}>{error}</Text><Pressable accessibilityRole="button" style={s.button} onPress={() => { void refresh(); }}><Text style={s.link}>重新读取</Text></Pressable></View>}
      {!!info && <Text style={s.info}>{info}</Text>}
    </ScrollView>
    {supplementing && <GiftSupplementEditor key={supplementing.id} gift={supplementing} onClose={() => setSupplementing(null)} onSaved={gift => {
      setSupplementing(null); setViews(value => [{ revealed: true, gift }, ...value.filter(view => view.gift.id !== gift.id)]); void refresh();
    }} />}
    {attachmentTarget && <GiftAttachmentViewer key={attachmentTarget.id + ':' + attachmentTarget.revision + ':' + attachmentTarget.attachmentId} target={attachmentTarget} onClose={() => setAttachmentTarget(null)} />}
    {editing && <GiftEditor key={editing.gift.id} gift={editing.gift} newDraft={editing.newDraft} onClose={() => { setEditing(null); void refresh(); }} onSaved={(gift, notice) => {
      setEditing(null); setViews(value => [{ revealed: true, gift }, ...value.filter(view => view.gift.id !== gift.id)]);
      setSelectedId(gift.id); setPreparing(gift.deliveryStatus !== 'delivered'); setInfo(notice ?? ''); void refresh();
    }} />}
  </View>;
}
