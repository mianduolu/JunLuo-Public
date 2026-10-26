import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Dimensions, FlatList, Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text, AppTextInput } from '../components/AppText';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit,
  subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { getOverlayTextStyle, type HomeBackgroundReadability } from '../theme/homeReadability';
import type { getShiyingVisualPalette } from './ShiyingFeature';
import { ShiyingRecordTabs, type ShiyingTab } from './ShiyingRecordsFeature';
import type { ShiyingSummaryKind } from './shiyingContract';
import {
  createShiyingEntryFactContentHash, createShiyingRecordContentHash,
  type ShiyingFactSourceV1, type ShiyingRecordImageV1,
} from './shiyingJournalContract';
import { getShiyingRecordById } from './shiyingJournalStore';
import { getShiyingEntryById } from './shiyingStore';
import { createShiyingEventNodeInputHash, createShiyingSummaryContentHash, createShiyingSummaryStateHash,
  SHIYING_SUMMARY_TEXT_LIMITS,
  type ShiyingSummaryAnyV3, type ShiyingSummarySourceV3, type ShiyingSummaryInputV1 } from './shiyingSummaryContract';
import { editShiyingSummary, getShiyingSummaryAnyById, listShiyingReviewPreviews,
  markShiyingSummaryAnyPresented, rejectShiyingSummaryAny, shiyingSummaryOriginalSources,
  subscribeShiyingSummaryChanges } from './shiyingSummaryStore';
import { getShiyingRecordImageNote, isShiyingImageNoteSourceCurrent } from './shiyingImageNoteStore';
import { createShiyingImageNoteResultHash } from './shiyingImageNoteContract';
import { getShiyingRecordImageUri } from './shiyingRecordImages';
import type { ShiyingEventV2, ShiyingScopedSourceV1 } from './shiyingReviewContract';
import {
  getShiyingEventSnapshot, listShiyingEvents, moveShiyingEventNodes, removeShiyingEventNode,
} from './shiyingReviewStore';
import {
  abandonShiyingWeeklyReview, getShiyingReviewRecoveryState, retryShiyingReviewLocalSave,
  runShiyingPeriodReview, subscribeShiyingWeeklyReviews,
} from './shiyingReviewCoordinator';
import { isShiyingReviewKindEnabled, loadShiyingWeeklyReviewState, setShiyingWeeklyReviewEnabled,
  setShiyingPeriodReviewEnabled } from './shiyingReviewPolicy';
import { getShiyingLatestClosedPeriod, SHIYING_PERIOD_REVIEW_FLOOR } from './shiyingPeriodReview';
import { canDisplayShiyingReview, getShiyingReviewArticle, getShiyingReviewImageGaps,
  getShiyingReviewPeriodChoices, SHIYING_REVIEW_KIND_LABELS } from './shiyingReviewPageModel';
import {
  getShiyingReviewReadingPalette, isShiyingReadingRangeCurrent, parseShiyingReadingBlocks,
  getShiyingDisplayedAutomaticCalls, getShiyingReadingHighlights, parseShiyingReadingInline, shiyingReviewPeriodLabel,
} from './shiyingReviewPresentation';

type Visual = ReturnType<typeof getShiyingVisualPalette>;
type ReadingPalette = ReturnType<typeof getShiyingReviewReadingPalette>;
type Summary = ShiyingSummaryAnyV3;
type ReviewPage = Awaited<ReturnType<typeof listShiyingReviewPreviews>>;
type EventPage = Awaited<ReturnType<typeof listShiyingEvents>>;
type Recovery = Awaited<ReturnType<typeof getShiyingReviewRecoveryState>>;
type WeeklyState = Awaited<ReturnType<typeof loadShiyingWeeklyReviewState>>;
type Source = ShiyingFactSourceV1 | ShiyingScopedSourceV1 | ShiyingSummarySourceV3;
type SourceDisplay = { key: string; label: string; date: string; body: string; imageNote: string | null;
  noteLabel?: string;
  images: ShiyingRecordImageV1[]; unavailable: boolean; ranges: Array<{ start: number; end: number }>;
  noteRanges: Array<{ start: number; end: number }> };
type Detail = { kind: 'review'; summary: Summary } | { kind: 'event'; event: ShiyingEventV2 };
type ReviewEdit = { id: string; kind: ShiyingSummaryKind; expectedStateHash: string; title: string; body: string; heart: string; updatedAt: number };

function statusText(result: { kind: string; code?: string; progress?: { completed: number; total: number; stage: string } }, kind: ShiyingSummaryKind = 'week') {
  if (result.kind === 'save_pending') return '结果已收到，可以再存一次。本地保存不会调用模型。';
  if (result.kind === 'retry_confirmation_required') return '上次整理未完成，需要确认后重试。';
  if (result.kind === 'completed') return `${SHIYING_REVIEW_KIND_LABELS[kind]}已保存。`;
  if (result.kind === 'direct') return '材料较少，直接查看原荧迹；本次未调用模型。';
  if (result.kind === 'no_material') return '当前没有可整理的材料，本次未调用模型。';
  if (result.kind === 'busy') return '当前正在处理，请稍后再试。';
  if (result.code === 'shiying_review_waiting_higher') return '正在等待前面的周回顾或月回顾保存完成。';
  if (result.code === 'shiying_review_waiting_draft') return '这个周期还有可续写的草稿，等定稿后再整理。';
  if (result.code === 'shiying_review_waiting_images') return '目前只有尚未读完的图片，等图片记录完成后再整理。';
  if (result.kind === 'blocked') return result.code?.includes('capacity')
    ? '当前连接装不下剩余材料，已读进度保留。' : '整理暂停，已保存的进度保留。';
  if (result.progress) return `已完成 ${result.progress.completed}/${result.progress.total} 段${result.progress.stage === 'final' ? ' · 等待成篇' : ''}。`;
  if (result.kind === 'failed') return '本次未完成，已保存的进度保留。';
  return '';
}

function summarySources(summary: Summary): Source[] {
  return shiyingSummaryOriginalSources(summary);
}

async function loadSource(source: Source): Promise<SourceDisplay> {
  const missing: SourceDisplay = { key: `${source.kind}:${source.id}`, label: source.kind === 'entry' ? '荧迹' : '小纸条',
    date: '', body: '', imageNote: null, images: [], unavailable: true, ranges: [], noteRanges: [] };
  if (source.kind === 'entry') {
    const entry = await getShiyingEntryById(source.id);
    if (!entry || entry.status !== 'active' || source.contentHash && createShiyingEntryFactContentHash(entry) !== source.contentHash) return missing;
    const ranges = 'textRanges' in source ? source.textRanges ?? [] : [];
    if (ranges.some(range => !isShiyingReadingRangeCurrent(range, entry.body))) return missing;
    return { ...missing, date: entry.lifeDate, body: entry.body, unavailable: false, ranges };
  }
  const record = await getShiyingRecordById(source.id);
  if (!record || record.status !== 'finalized' || source.contentHash && createShiyingRecordContentHash(record) !== source.contentHash) return missing;
  const ranges = 'textRanges' in source ? source.textRanges ?? [] : [];
  if (ranges.some(range => !isShiyingReadingRangeCurrent(range, record.body))) return missing;
  const note = record.images.length ? await getShiyingRecordImageNote(record.id) : null;
  const ready = note?.status === 'ready' && isShiyingImageNoteSourceCurrent(record, note);
  const noteRanges = 'imageNoteRanges' in source ? source.imageNoteRanges ?? [] : [];
  if ('imageNoteHash' in source && source.imageNoteHash !== null
    && (!ready || createShiyingImageNoteResultHash(note!) !== source.imageNoteHash)) return missing;
  if (noteRanges.length && (!ready || noteRanges.some(range => !isShiyingReadingRangeCurrent(range, note!.body!)))) return missing;
  return { ...missing, date: record.recordDate, body: record.body, images: record.images.filter(image => !source.imageIds.length || source.imageIds.includes(image.id)),
    imageNote: ready ? note!.body : null, unavailable: false, ranges, noteRanges };
}

function ReadingText({ body, palette }: { body: string; palette: ReadingPalette }) {
  return <>{parseShiyingReadingBlocks(body).map((block, index) => <View key={index}
    style={block.kind === 'heading' ? styles.readingHeadingRow : styles.readingParagraph}>
    {block.kind === 'heading' ? <View style={[styles.headingDot, { backgroundColor: palette.dot }]} /> : null}
    <Text selectable style={[block.kind === 'heading' ? styles.readingHeading : styles.readingBody, { color: palette.text }]}>
      {parseShiyingReadingInline(block.text).map((part, at) => <Text key={at} style={part.strong ? styles.medium : undefined}>{part.text}</Text>)}
    </Text>
  </View>)}</>;
}

function SourceImage({ image, palette }: { image: ShiyingRecordImageV1; palette: ReadingPalette }) {
  const [failed, setFailed] = useState(false);
  return <View style={[styles.sourceImage, { backgroundColor: palette.action }]}>
    {failed ? <Text style={{ color: palette.secondary, textAlign: 'center' }}>图片不可用</Text>
      : <Image source={{ uri: getShiyingRecordImageUri(image.contentHash) }} resizeMode="contain"
        style={{ width: '100%', height: '100%' }} onError={() => setFailed(true)} />}
  </View>;
}

export function ShiyingReviewsFeature({ active, visual, backgroundReadability, onOpenFeatureDrawer, onChangeTab,
  onEditorPresenceChange, onEditorClosed }: {
  active: boolean; visual: Visual; backgroundReadability: HomeBackgroundReadability;
  onOpenFeatureDrawer?: () => void; onChangeTab: (value: ShiyingTab) => void;
  onEditorPresenceChange?: (open: boolean) => void; onEditorClosed?: () => void;
}) {
  const insets = useSafeAreaInsets();
  const palette = useMemo(() => getShiyingReviewReadingPalette(backgroundReadability.exposedLabelText === 'light'), [backgroundReadability]);
  const headerText = getOverlayTextStyle(backgroundReadability.headerText);
  const [section, setSection] = useState<'reviews' | 'events'>('reviews');
  const [reviewKind, setReviewKind] = useState<ShiyingSummaryKind>('week');
  const [reviews, setReviews] = useState<ReviewPage['items']>([]);
  const [events, setEvents] = useState<EventPage['items']>([]);
  const [before, setBefore] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [weekly, setWeekly] = useState<WeeklyState | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [sources, setSources] = useState<SourceDisplay[]>([]);
  const [reviewSources, setReviewSources] = useState<SourceDisplay[]>([]);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [detailReady, setDetailReady] = useState(false);
  const [selectedNodes, setSelectedNodes] = useState<string[]>([]);
  const [splitTitle, setSplitTitle] = useState('');
  const [splitting, setSplitting] = useState(false);
  const [periodPicker, setPeriodPicker] = useState(false);
  const [editing, setEditing] = useState<ReviewEdit | null>(null);
  const [editField, setEditField] = useState<'title' | 'body' | 'heart'>('body');
  const [routeWarning, setRouteWarning] = useState('');
  const editorPresence = useRef(onEditorPresenceChange); editorPresence.current = onEditorPresenceChange;
  const mounted = useRef(true);
  const activeRef = useRef(active);
  const busyRef = useRef(false);
  const request = useRef(0);
  const detailRequest = useRef(0);
  const actionVersion = useRef(0);
  activeRef.current = active;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { editorPresence.current?.(editing !== null); return () => editorPresence.current?.(false); }, [editing !== null]);
  useEffect(() => { if (!active) { actionVersion.current += 1; detailRequest.current += 1; } }, [active]);

  const refresh = useCallback(async (more = false) => {
    if (!mounted.current || !activeRef.current) return;
    const id = ++request.current, epoch = captureBackupRestoreDataEpoch();
    setLoading(true);
    try {
      const [page, nextRecovery, state] = await Promise.all([
        section === 'reviews' ? listShiyingReviewPreviews({ kind: reviewKind, before: more ? before : null, limit: 30 })
          : listShiyingEvents({ before: more ? before : null, limit: 30 }),
        getShiyingReviewRecoveryState(reviewKind), loadShiyingWeeklyReviewState(),
      ]);
      if (!mounted.current || !activeRef.current || id !== request.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      if (section === 'reviews') {
        const items = page.items as ReviewPage['items'];
        setReviews(previous => more ? [...previous, ...items.filter(item => !previous.some(old => old.id === item.id))] : items);
      } else {
        const items = page.items as EventPage['items'];
        setEvents(previous => more ? [...previous, ...items.filter(item => !previous.some(old => old.id === item.id))] : items);
      }
      setBefore(page.nextBefore); setRecovery(nextRecovery); setWeekly(state);
    } catch { if (mounted.current && id === request.current) setStatus('读取回顾失败，请重试。'); }
    finally { if (mounted.current && id === request.current) setLoading(false); }
  }, [section, before, reviewKind]);
  const refreshRef = useRef(refresh); refreshRef.current = refresh;
  useEffect(() => subscribeBackupRestoreRuntimeState(state => {
    if (!mounted.current) return;
    if (state.status !== 'ready') {
      request.current += 1; detailRequest.current += 1; actionVersion.current += 1;
      setDetail(null); setSources([]); setReviewSources([]); setSourceOpen(false); setRecovery(null);
      setEditing(null); setPeriodPicker(false); setRouteWarning('');
      setReviews([]); setEvents([]); setBefore(null);
      setStatus('数据恢复中，整理暂停。');
    } else if (activeRef.current) void refreshRef.current();
  }), []);
  useEffect(() => {
    if (active) void refreshRef.current();
    const update = () => { if (activeRef.current) void refreshRef.current(); };
    const unsubscribe = subscribeShiyingWeeklyReviews(update), unsubscribeSummary = subscribeShiyingSummaryChanges(update);
    return () => { unsubscribe(); unsubscribeSummary(); };
  }, [active, section, reviewKind]);

  const openDetail = async (kind: 'review' | 'event', id: string) => {
    const version = ++detailRequest.current, epoch = captureBackupRestoreDataEpoch();
    setDetailReady(false); setSources([]); setReviewSources([]); setSourceOpen(false); setSplitting(false); setSelectedNodes([]); setSplitTitle(''); setRouteWarning('');
    try {
      const value = kind === 'review' ? await getShiyingSummaryAnyById(id) : await getShiyingEventSnapshot(id);
      if (!mounted.current || !activeRef.current || version !== detailRequest.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      if (!value || kind === 'review' && (value as Summary).status !== 'active') { setStatus('内容已不可用。'); return; }
      const next: Detail = kind === 'review' ? { kind, summary: value as Summary } : { kind, event: value as ShiyingEventV2 };
      setDetail(next);
      if (next.kind === 'review') {
        const loaded = await Promise.all(summarySources(next.summary).map(loadSource));
        if (mounted.current && activeRef.current && version === detailRequest.current && canCommitBackupRestoreDataEpoch(epoch)) {
          setSources(loaded); setReviewSources(loaded); setDetailReady(true);
        }
      } else setDetailReady(true);
    } catch { if (mounted.current && version === detailRequest.current) setStatus('读取详情失败，请重试。'); }
  };

  const markPresented = () => {
    if (!active || !detailReady || detail?.kind !== 'review' || detail.summary.presentedAt !== null
      || !canDisplayShiyingReview(detail.summary, reviewSources.some(source => !source.unavailable))) return;
    const summary = detail.summary, epoch = captureBackupRestoreDataEpoch();
    const at = Math.max(Date.now(), summary.updatedAt);
    const write = runBackupRestoreDataEpochCommit<Summary>(epoch, () => markShiyingSummaryAnyPresented({ id: summary.id, presentedAt: at }));
    void write.then(result => {
      if (mounted.current && result.committed && canCommitBackupRestoreDataEpoch(epoch)) {
        setDetail(current => current?.kind === 'review' && current.summary.id === summary.id ? { kind: 'review', summary: result.value } : current);
      }
    }).catch(() => { if (mounted.current) setStatus('领取标记未保存，内容仍保留。'); });
  };

  const execute = async (periodStart?: string, kind: ShiyingSummaryKind = reviewKind, regenerate = false) => {
    if (busyRef.current || !activeRef.current) return;
    busyRef.current = true; setBusy(true);
    const version = ++actionVersion.current, epoch = captureBackupRestoreDataEpoch();
    const current = () => mounted.current && activeRef.current && version === actionVersion.current && canCommitBackupRestoreDataEpoch(epoch);
    try {
      const state = await getShiyingReviewRecoveryState(kind);
      if (!current()) return;
      if (periodStart && state.kind !== 'none') { setStatus('先继续或放弃此类未完成任务，再整理选中的周期。'); return; }
      let confirmation: NonNullable<Parameters<typeof runShiyingPeriodReview>[0]>['retryConfirmation'];
      if (state.kind === 'retry_confirmation_required') {
        const allowed = await new Promise<boolean>(resolve => Alert.alert('继续整理', '上次没能捡完，继续捡可能会再次产生调用费用。', [
          { text: '先放一放', style: 'cancel', onPress: () => resolve(false) },
          { text: '继续捡', onPress: () => resolve(true) },
        ], { cancelable: true, onDismiss: () => resolve(false) }));
        if (!allowed || !current()) return;
        confirmation = state.retryConfirmation;
      }
      const result = state.kind === 'save_pending' ? await retryShiyingReviewLocalSave(kind)
        : await runShiyingPeriodReview({ kind, periodStart, regenerate, retryConfirmation: confirmation,
          onProgress: progress => { if (current()) setStatus(statusText(progress, kind)); } });
      if (!current()) return;
      setStatus(statusText(result, kind));
      if (result.kind === 'completed') setDetail(null);
      await refreshRef.current();
      if (result.kind === 'direct' && result.entryId) {
        const source = await loadSource({ kind: 'entry', id: result.entryId, contentHash: '', imageIds: [] });
        if (current()) { setSources([source]); setSourceOpen(true); }
      }
    } catch { if (current()) setStatus('整理未完成，已保存的进度保留。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };

  const localAction = async <T,>(operation: () => Promise<T>, onSaved?: (value: T) => void) => {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true);
    const epoch = captureBackupRestoreDataEpoch();
    try {
      const result = await runBackupRestoreDataEpochCommit(epoch, operation);
      if (!mounted.current || !result.committed || !canCommitBackupRestoreDataEpoch(epoch)) return;
      onSaved?.(result.value);
      await refreshRef.current();
    } catch { if (mounted.current) setStatus('本地操作失败，请重试。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const reject = () => {
    if (detail?.kind !== 'review' || busy) return;
    const summary = detail.summary;
    Alert.alert('这篇不算？', '回顾将不再展示，原小纸条和荧迹保留。', [
      { text: '取消', style: 'cancel' }, { text: '这篇不算', onPress: () => void localAction(async () => {
        const at = Math.max(Date.now(), summary.updatedAt);
        await rejectShiyingSummaryAny({ id: summary.id, rejectedAt: at });
      }, () => setDetail(null)) },
    ]);
  };
  const showNodeSources = async (values: Source[]) => {
    const version = ++detailRequest.current, epoch = captureBackupRestoreDataEpoch();
    try {
      const loaded = await Promise.all(values.map(loadSource));
      if (mounted.current && activeRef.current && version === detailRequest.current && canCommitBackupRestoreDataEpoch(epoch)) { setSources(loaded); setSourceOpen(true); }
    } catch { if (mounted.current && activeRef.current && version === detailRequest.current) setStatus('读取来源失败，请重试。'); }
  };
  const removeNode = (nodeId: string) => {
    if (detail?.kind !== 'event' || busy) return;
    const event = detail.event;
    Alert.alert('移出这段经过？', '只纠正事件关联，不删除原记录。', [
      { text: '取消', style: 'cancel' }, { text: '移出', onPress: () => void localAction(() =>
        removeShiyingEventNode({ eventId: event.id, nodeId, updatedAt: Math.max(Date.now(), event.updatedAt) }), saved => {
          setDetail(current => current?.kind === 'event' && current.event.id === event.id ? { kind: 'event', event: saved } : current);
        }) },
    ]);
  };
  const splitNodes = () => {
    if (detail?.kind !== 'event' || !selectedNodes.length || !splitTitle.trim()) return;
    const event = detail.event;
    void localAction(() => moveShiyingEventNodes({ eventId: event.id, nodeIds: selectedNodes, targetTitle: splitTitle.trim(),
      updatedAt: Math.max(Date.now(), event.updatedAt) }), saved => {
      setDetail({ kind: 'event', event: saved.target }); setSplitting(false); setSelectedNodes([]); setSplitTitle('');
    });
  };
  const openInputSource = async (input: ShiyingSummaryInputV1) => {
    const version = ++detailRequest.current, epoch = captureBackupRestoreDataEpoch();
    try {
      if (input.kind === 'summary') {
        const summary = await getShiyingSummaryAnyById(input.id);
        if (!mounted.current || !activeRef.current || version !== detailRequest.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
        const unchanged = summary && summary.status === 'active' && createShiyingSummaryContentHash(summary) === input.contentHash;
        setSources([{ key: `summary:${input.id}`, label: summary ? getShiyingReviewArticle(summary).title : SHIYING_REVIEW_KIND_LABELS[input.summaryKind],
          date: shiyingReviewPeriodLabel(input.periodStartLifeDate, input.periodEndLifeDate),
          body: summary?.status === 'active' ? summary.factSummary : '', imageNote: summary?.status === 'active' ? summary.baiyunNote : null,
          noteLabel: '心里话', images: [], unavailable: !summary || summary.status !== 'active',
          ranges: unchanged ? input.textRanges : [], noteRanges: unchanged ? input.noteRanges : [] }]);
        setRouteWarning(unchanged ? '' : summary?.status === 'active' ? '这篇回顾后来改过，当前显示的是最新内容，不是当时读到的版本。' : '当时读过的回顾已经不可用。');
        setSourceOpen(true); return;
      }
      const event = await getShiyingEventSnapshot(input.eventId), node = event?.nodes.find(value => value.id === input.id);
      if (!mounted.current || !activeRef.current || version !== detailRequest.current || !canCommitBackupRestoreDataEpoch(epoch)) return;
      if (!event || !node) {
        setSources([{ key: `event_node:${input.id}`, label: '事件经过', date: input.eventDate, body: '', imageNote: null,
          images: [], unavailable: true, ranges: [], noteRanges: [] }]);
      } else {
        const unchanged = createShiyingEventNodeInputHash({ id: node.id, eventId: event.id, eventDate: node.eventDate,
          title: event.title, body: node.body, sources: node.sources.map(source => ({ ...source,
            textRanges: 'textRanges' in source ? source.textRanges : null,
            imageNoteRanges: 'imageNoteRanges' in source ? source.imageNoteRanges : null,
            imageNoteHash: 'imageNoteHash' in source ? source.imageNoteHash : null,
          })) }) === input.contentHash;
        setSources([{ key: `event_node:${input.id}`, label: event.title, date: node.eventDate, body: node.body, imageNote: null,
          images: [], unavailable: false, ranges: unchanged ? input.textRanges : [], noteRanges: [] }]);
        setRouteWarning(unchanged ? '' : '这段经过后来改过，当前显示的是最新内容，不是当时读到的版本。');
      }
      setSourceOpen(true);
    } catch { if (mounted.current && activeRef.current && version === detailRequest.current) setStatus('读取来源失败，请重试。'); }
  };
  const startEditing = () => {
    if (busy || detail?.kind !== 'review') return;
    const summary = detail.summary, article = getShiyingReviewArticle(summary);
    setEditing({ id: summary.id, kind: summary.kind, expectedStateHash: createShiyingSummaryStateHash(summary),
      title: article.title, body: article.body, heart: summary.baiyunNote, updatedAt: summary.updatedAt });
    setStatus(''); setEditField('body');
  };
  const finishEditing = () => { setEditing(null); onEditorClosed?.(); };
  const saveEditedReview = async () => {
    if (!editing || busyRef.current || !activeRef.current) return;
    const draft = editing, epoch = captureBackupRestoreDataEpoch(), version = ++actionVersion.current;
    busyRef.current = true; setBusy(true);
    const current = () => mounted.current && activeRef.current && version === actionVersion.current && canCommitBackupRestoreDataEpoch(epoch);
    try {
      const result = await runBackupRestoreDataEpochCommit(epoch, () => editShiyingSummary({ id: draft.id,
        expectedStateHash: draft.expectedStateHash, title: draft.title, factSummary: draft.body, baiyunNote: draft.heart,
        editedAt: Math.max(Date.now(), draft.updatedAt) }));
      if (!result.committed || !current()) return;
      setDetail({ kind: 'review', summary: result.value }); setStatus('修改已保存。'); finishEditing();
      await refreshRef.current();
    } catch { if (current()) setStatus('修改未保存，文字仍在这里。请重试；若内容已有变化，需要重新核对。'); }
    finally { busyRef.current = false; if (mounted.current) setBusy(false); }
  };
  const regenerateReview = () => {
    if (busy || detail?.kind !== 'review') return;
    const summary = detail.summary, epoch = captureBackupRestoreDataEpoch(), version = actionVersion.current;
    Alert.alert('重新整理这篇？', '会重新请求模型，成功后替换当前回顾；没有保存成功时，当前内容保留。', [
      { text: '取消', style: 'cancel' }, { text: '重新整理', onPress: () => {
        if (mounted.current && activeRef.current && version === actionVersion.current && canCommitBackupRestoreDataEpoch(epoch))
          void execute(summary.periodStartLifeDate, summary.kind, true);
      } },
    ]);
  };
  const abandon = () => Alert.alert('放弃这次整理？', '未完成的阅读进度会清除，小纸条和已有回顾不会删除。以后整理可能重新调用模型。', [
    { text: '取消', style: 'cancel' }, { text: '放弃', style: 'destructive', onPress: () => void localAction(() => abandonShiyingWeeklyReview(reviewKind)) },
  ]);
  const closeDetail = () => {
    if (busy) return;
    if (editing) {
      const epoch = captureBackupRestoreDataEpoch();
      Alert.alert('放下这次修改？', '尚未保存的修改会清除，已保存的回顾不会改变。', [
        { text: '继续修改', style: 'cancel' }, { text: '放下修改', onPress: () => {
          if (mounted.current && activeRef.current && canCommitBackupRestoreDataEpoch(epoch)) finishEditing();
        } },
      ]);
    } else if (sourceOpen) { setSourceOpen(false); setRouteWarning(''); }
    else if (splitting) { setSplitting(false); setSelectedNodes([]); }
    else { detailRequest.current += 1; actionVersion.current += 1; setDetail(null); }
  };

  const toolbar = <View style={[styles.toolbar, { backgroundColor: palette.surface, borderColor: palette.divider }]}>
    {(['week', 'month', 'year'] as const).map(kind => <View key={kind} style={styles.toolbarRow}>
      <Text style={[styles.label, { color: palette.text }]}>{`自动${SHIYING_REVIEW_KIND_LABELS[kind]}`}</Text>
      <Switch accessibilityLabel={`自动${SHIYING_REVIEW_KIND_LABELS[kind]}`} disabled={busy || !weekly}
        value={weekly ? isShiyingReviewKindEnabled(weekly, kind) : false} onValueChange={enabled =>
          void localAction(() => kind === 'week' ? setShiyingWeeklyReviewEnabled(enabled)
            : setShiyingPeriodReviewEnabled(kind, enabled, getShiyingLatestClosedPeriod(kind)?.start ?? SHIYING_PERIOD_REVIEW_FLOOR), setWeekly)}
        trackColor={{ false: palette.divider, true: palette.dot }} />
    </View>)}
    <Text style={[styles.hint, { color: palette.secondary }]}>周、月、年共用自动额度，每天最多调用 2 次；手动每次最多 2 次。先存好周回顾，再读月回顾，最后读年回顾。</Text>
    {weekly ? <Text style={[styles.hint, { color: palette.secondary }]}>今日自动共用额度：{getShiyingDisplayedAutomaticCalls(weekly)}/2</Text> : null}
    <View style={styles.actions}><Pressable disabled={busy || loading || recovery?.kind === 'none' && reviewKind !== 'week' && !getShiyingLatestClosedPeriod(reviewKind)} onPress={() => void execute()}
      style={[styles.button, { backgroundColor: palette.action, opacity: busy ? 0.5 : 1 }]}>
      <Text style={{ color: palette.text }}>{busy ? '正在处理…' : recovery?.kind === 'save_pending' ? '再存一次'
        : recovery && recovery.kind !== 'none' ? '继续整理' : reviewKind === 'week' ? '整理上周' : reviewKind === 'month' ? '整理上月' : '整理上年'}</Text>
    </Pressable>
      <Pressable disabled={busy || recovery?.kind !== 'none'} onPress={() => setPeriodPicker(true)} style={styles.button}>
        <Text style={{ color: palette.secondary, opacity: busy || recovery?.kind !== 'none' ? 0.5 : 1 }}>选择已结束的周期</Text>
      </Pressable>
      {(recovery?.kind === 'blocked' || recovery?.kind === 'retry_confirmation_required') ? <Pressable disabled={busy} onPress={abandon} style={styles.button}>
        <Text style={{ color: palette.secondary }}>放弃这次整理</Text>
      </Pressable> : null}
    </View>
    {status || recovery?.progress ? <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: palette.secondary }]}>
      {status || (recovery ? statusText(recovery, reviewKind) : '')}
    </Text> : null}
  </View>;
  const header = <>
    <View style={styles.header}><Pressable accessibilityLabel="功能" onPress={onOpenFeatureDrawer} style={[styles.menu, { backgroundColor: visual.menuSurface }]}>
      <Text style={{ color: visual.menuText, fontSize: 21 }}>☰</Text>
    </Pressable><Text style={[styles.pageTitle, headerText]}>拾荧</Text></View>
    <ShiyingRecordTabs value="reviews" onChange={onChangeTab} visual={visual} />
    {toolbar}
    <View style={styles.sections}>{(['reviews', 'events'] as const).map(value => <Pressable key={value} onPress={() => {
      if (section !== value) { setSection(value); setBefore(null); }
    }} style={[styles.section, section === value && { borderBottomColor: palette.dot, borderBottomWidth: 2 }]}>
      <Text style={[styles.label, headerText]}>{value === 'reviews' ? '回顾文章' : '事件脉络'}</Text>
    </Pressable>)}</View>
    {section === 'reviews' ? <View style={styles.kindChoices}>{(['week', 'month', 'year'] as const).map(kind =>
      <Pressable key={kind} accessibilityRole="tab" accessibilityState={{ selected: reviewKind === kind }} disabled={busy}
        onPress={() => { if (kind !== reviewKind) { request.current += 1; actionVersion.current += 1;
          setReviewKind(kind); setReviews([]); setBefore(null); setRecovery(null); setStatus(''); } }}
        style={[styles.button, reviewKind === kind && { backgroundColor: palette.action }]}>
        <Text style={[styles.label, headerText]}>{SHIYING_REVIEW_KIND_LABELS[kind]}</Text>
      </Pressable>)}</View> : null}
  </>;
  const footer = before ? <Pressable disabled={loading} onPress={() => void refresh(true)} style={styles.more}>
    <Text style={headerText}>{loading ? '正在读取…' : '加载更早内容'}</Text>
  </Pressable> : null;
  const contentStyle = { paddingHorizontal: 18, paddingTop: Math.max(18, insets.top + 8), paddingBottom: Math.max(30, insets.bottom + 22) };
  const reviewTitle = detail?.kind === 'review' ? getShiyingReviewArticle(detail.summary) : null;
  const periodChoices = periodPicker ? getShiyingReviewPeriodChoices(reviewKind) : [];

  return <View style={styles.root}>
    {section === 'reviews' ? <FlatList data={reviews} keyExtractor={item => item.id} initialNumToRender={8} windowSize={7}
      contentContainerStyle={contentStyle} ListHeaderComponent={header} ListFooterComponent={footer}
      ListEmptyComponent={<Text style={[styles.empty, headerText]}>{loading ? '正在读取回顾…' : `还没有${SHIYING_REVIEW_KIND_LABELS[reviewKind]}`}</Text>}
      renderItem={({ item }) => <Pressable onPress={() => void openDetail('review', item.id)} style={[styles.preview, { backgroundColor: palette.surface, borderColor: palette.divider }]}>
        <Text style={[styles.hint, { color: palette.secondary }]}>{shiyingReviewPeriodLabel(item.periodStartLifeDate, item.periodEndLifeDate)}</Text>
        <Text style={[styles.previewTitle, { color: palette.text }]}>{item.title}</Text>
        {item.dirty ? <Text style={[styles.hint, { color: palette.secondary }]}>待更新</Text> : null}
        {item.editedAt != null ? <Text style={[styles.hint, { color: palette.secondary }]}>自己改过</Text> : null}
      </Pressable>} />
      : <FlatList data={events} keyExtractor={item => item.id} initialNumToRender={8} windowSize={7}
        contentContainerStyle={contentStyle} ListHeaderComponent={header} ListFooterComponent={footer}
        ListEmptyComponent={<Text style={[styles.empty, headerText]}>{loading ? '正在读取事件…' : '还没有事件脉络'}</Text>}
        renderItem={({ item }) => <Pressable onPress={() => void openDetail('event', item.id)} style={[styles.preview, { backgroundColor: palette.surface, borderColor: palette.divider }]}>
          <Text style={[styles.previewTitle, { color: palette.text }]}>{item.title}</Text>
          <Text numberOfLines={3} style={[styles.previewBody, { color: palette.secondary }]}>{item.overview}</Text>
          {item.dirty ? <Text style={[styles.hint, { color: palette.secondary }]}>概述待更新</Text> : null}
        </Pressable>} />}
    <Modal visible={active && (!!detail || sourceOpen)} animationType="slide" statusBarTranslucent
      backdropColor={palette.surface} onRequestClose={closeDetail}>
      <KeyboardAvoidingView style={[styles.root, { backgroundColor: palette.surface },
        Platform.OS === 'android' && { flex: 0, height: Dimensions.get('screen').height }]} enabled behavior="padding">
        <View style={[styles.detailHeader, { paddingTop: Math.max(14, insets.top + 8), borderBottomColor: palette.divider }]}>
          <Pressable disabled={busy} onPress={closeDetail} style={styles.back}><Text style={{ color: palette.text }}>‹ {editing ? '修改回顾' : sourceOpen ? '来源' : '回顾'}</Text></Pressable>
          {editing ? <Pressable disabled={busy || !editing.title.trim() || !editing.body.trim()} onPress={() => void saveEditedReview()} style={styles.back}>
            <Text style={{ color: palette.text }}>{busy ? '正在保存…' : '保存修改'}</Text>
          </Pressable> : detail?.kind === 'review' && !sourceOpen ? <Pressable disabled={busy} onPress={reject} style={styles.back}>
            <Text style={{ color: palette.secondary }}>这篇不算</Text>
          </Pressable> : null}
        </View>
        {editing ? <View style={[styles.editArea, { paddingBottom: Math.max(16, insets.bottom) }]}>
          <View style={styles.kindChoices}>{(['title', 'body', 'heart'] as const).map(field =>
            <Pressable key={field} accessibilityRole="tab" accessibilityState={{ selected: editField === field }} disabled={busy}
              onPress={() => setEditField(field)} style={[styles.button, editField === field && { backgroundColor: palette.action }]}>
              <Text style={[styles.label, { color: palette.text }]}>{field === 'title' ? '标题' : field === 'body' ? '正文' : '心里话'}</Text>
            </Pressable>)}</View>
          <View style={styles.editViewport}>
            <AppTextInput key={editField} accessibilityLabel={`回顾${editField === 'title' ? '标题' : editField === 'body' ? '正文' : '心里话'}`}
              value={editing[editField]} onChangeText={value => setEditing(draft => draft ? { ...draft, [editField]: value } : draft)}
              maxLength={editField === 'title' ? 200 : SHIYING_SUMMARY_TEXT_LIMITS[editing.kind]} multiline scrollEnabled editable={!busy}
              textAlignVertical="top" style={[styles.editInput, editField === 'title' && styles.editTitle, { color: palette.text }]} />
          </View>
          {status ? <Text accessibilityLiveRegion="polite" style={[styles.hint, { color: palette.secondary }]}>{status}</Text> : null}
        </View> : <ScrollView style={styles.root} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.article, { paddingBottom: Math.max(30, insets.bottom + 22) }]}>
          {routeWarning ? <Text style={[styles.hint, { color: palette.secondary }]}>{routeWarning}</Text> : null}
          {sourceOpen ? sources.map(source => <View key={source.key} style={styles.sourceBlock}>
            <Text style={[styles.label, { color: palette.secondary }]}>{source.label}{source.date ? ` · ${source.date}` : ''}</Text>
            {source.unavailable ? <Text style={[styles.readingBody, { color: palette.secondary }]}>来源已不可用或内容已变化</Text>
              : <>
                <Text selectable style={[styles.readingBody, { color: palette.text, marginTop: 16 }]}>
                  {getShiyingReadingHighlights(source.body, source.ranges).map(part => <Text key={part.start}
                    style={part.highlighted ? { backgroundColor: palette.action } : undefined}>{part.text}</Text>)}
                </Text>
                {source.images.map(image => <View key={image.id}><Text style={[styles.hint, { color: palette.secondary }]}>附图 {image.ordinal + 1}</Text>
                  <SourceImage image={image} palette={palette} /></View>)}
                {source.imageNote ? <View style={styles.sourceNote}><Text style={[styles.label, { color: palette.secondary }]}>{source.noteLabel ?? '图片记录'}</Text>
                  <Text selectable style={[styles.readingBody, { color: palette.text, marginTop: 16 }]}>
                    {getShiyingReadingHighlights(source.imageNote, source.noteRanges).map(part => <Text key={part.start}
                      style={part.highlighted ? { backgroundColor: palette.action } : undefined}>{part.text}</Text>)}
                  </Text></View> : null}
              </>}
          </View>) : detail?.kind === 'review' && reviewTitle ? <>
            <Text style={[styles.period, { color: palette.secondary }]}>{shiyingReviewPeriodLabel(detail.summary.periodStartLifeDate, detail.summary.periodEndLifeDate)}</Text>
            <Text style={[styles.articleTitle, { color: palette.text }]}>{reviewTitle.title}</Text>
            {detail.summary.dirty ? <Text style={[styles.hint, { color: palette.secondary }]}>待更新</Text> : null}
            {detail.summary.payloadVersion === 3 && detail.summary.editedAt !== null ? <Text style={[styles.hint, { color: palette.secondary }]}>自己改过</Text> : null}
            {detail.summary.payloadVersion === 3 && detail.summary.sourceInvalidated ? <Text style={[styles.hint, { color: palette.secondary }]}>来源已变化，后续整理暂不使用这篇。</Text> : null}
            {!detailReady ? <Text style={[styles.empty, { color: palette.secondary }]}>正在核对来源…</Text>
              : !canDisplayShiyingReview(detail.summary, reviewSources.some(source => !source.unavailable)) ? <Text style={[styles.empty, { color: palette.secondary }]}>原来源已不可用，此回顾暂不展示。</Text>
                : <View onLayout={markPresented} style={styles.readingContent}>
                  {!reviewSources.some(source => !source.unavailable) ? <Text style={[styles.hint, { color: palette.secondary }]}>原来源已不可用，保留你修改后的文章。</Text> : null}
                  <ReadingText body={reviewTitle.body} palette={palette} />
                  <ReadingText body={detail.summary.baiyunNote} palette={palette} />
                </View>}
            <View style={[styles.articleActions, { borderTopColor: palette.divider }]}>
              <Pressable onPress={() => { setSources(reviewSources); setSourceOpen(true); }} style={[styles.button, { backgroundColor: palette.action }]}>
                <Text style={{ color: palette.text }}>看来源</Text>
              </Pressable>
              <Pressable disabled={busy} onPress={startEditing} style={styles.button}><Text style={{ color: palette.text }}>改一改</Text></Pressable>
              <Pressable disabled={busy} onPress={regenerateReview} style={styles.button}><Text style={{ color: palette.secondary }}>重新整理</Text></Pressable>
            </View>
            {detail.summary.payloadVersion === 3 ? <>
              {detail.summary.inputSources.length ? <View style={styles.sourceNote}>
                <Text style={[styles.label, { color: palette.secondary }]}>这篇实际读过</Text>
                {detail.summary.inputSources.map(input => <Pressable key={`${input.kind}:${input.id}`} disabled={busy}
                  onPress={() => void openInputSource(input)} style={styles.back}>
                  <Text style={{ color: palette.text }}>{input.kind === 'summary'
                    ? `${SHIYING_REVIEW_KIND_LABELS[input.summaryKind]} · ${shiyingReviewPeriodLabel(input.periodStartLifeDate, input.periodEndLifeDate)}`
                    : `${input.title} · 记录于 ${input.eventDate}`}</Text>
                </Pressable>)}
              </View> : null}
              {getShiyingReviewImageGaps(detail.summary.imageCoverage).map(gap => <View key={gap.recordId} style={styles.sourceNote}>
                <Text style={[styles.label, { color: palette.secondary }]}>{gap.date} · {gap.state}</Text>
                {gap.total ? <Text style={[styles.hint, { color: palette.secondary }]}>图片整理已完成 {gap.completed}/{gap.total} 段</Text> : null}
                {gap.imageNumbers.length ? <Text style={[styles.hint, { color: palette.secondary }]}>未读完的附图：{gap.imageNumbers.join('、')}</Text> : null}
                {gap.captionRanges.filter(range => range.end > range.start).map((range, index) => <Text key={index}
                  style={[styles.hint, { color: palette.secondary }]}>未读完的配文位置：第 {range.start + 1}～{range.end} 位</Text>)}
                <Pressable onPress={() => void showNodeSources([{ kind: 'record', id: gap.recordId, contentHash: null,
                  imageIds: [], textRanges: gap.captionRanges, imageNoteRanges: [], imageNoteHash: null }])} style={styles.back}>
                  <Text style={{ color: palette.text }}>查看这张小纸条</Text>
                </Pressable>
              </View>)}
              {detail.summary.imageCoverage.legacyUnknownSummaryIds.length ? <Text style={[styles.hint, { color: palette.secondary }]}>部分旧回顾没有保存图片阅读范围，不能确认当时哪些图片读完了。</Text> : null}
              {detail.summary.imageCoverage.legacyUnknownSummaryIds.map((id, index) => <Pressable key={id} disabled={busy}
                onPress={() => void openDetail('review', id)} style={styles.back}>
                <Text style={{ color: palette.text }}>查看缺少阅读范围的旧回顾 {index + 1}</Text>
              </Pressable>)}
            </> : null}
            <View style={styles.feather}><Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
              <Path d="M20.2 3.8a5.6 5.6 0 0 0-7.9 0L3 13.1V21h7.9l9.3-9.3a5.6 5.6 0 0 0 0-7.9ZM16 8 2 22M9 15h6" stroke={palette.secondary} strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" />
            </Svg></View>
          </> : detail?.kind === 'event' ? <>
            <Text style={[styles.articleTitle, { color: palette.text }]}>{detail.event.title}</Text>
            {detail.event.dirty ? <Text style={[styles.hint, { color: palette.secondary }]}>概述待更新</Text> : null}
            <View style={styles.readingContent}><ReadingText body={detail.event.overview} palette={palette} /></View>
            <Pressable disabled={busy} onPress={() => { setSplitting(!splitting); setSelectedNodes([]); }} style={styles.back}>
              <Text style={{ color: palette.secondary }}>{splitting ? '取消拆分' : '选择经过，拆成另一个主题'}</Text>
            </Pressable>
            {detail.event.nodes.map(node => <View key={node.id} style={[styles.node, { borderLeftColor: palette.dot }]}>
              {splitting ? <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selectedNodes.includes(node.id) }}
                onPress={() => setSelectedNodes(previous => previous.includes(node.id) ? previous.filter(id => id !== node.id) : [...previous, node.id])} style={styles.back}>
                <Text style={{ color: palette.text }}>{selectedNodes.includes(node.id) ? '☑ 已选择' : '□ 选择这段'}</Text>
              </Pressable> : null}
              <Text style={[styles.period, { color: palette.secondary }]}>记录于 {node.eventDate}</Text>
              <ReadingText body={node.body} palette={palette} />
              <View style={styles.actions}><Pressable onPress={() => void showNodeSources(node.sources)} style={[styles.button, { backgroundColor: palette.action }]}>
                <Text style={{ color: palette.text }}>看来源</Text>
              </Pressable><Pressable disabled={busy} onPress={() => removeNode(node.id)} style={styles.button}>
                <Text style={{ color: palette.secondary }}>移出这段经过</Text>
              </Pressable></View>
            </View>)}
            {splitting ? <View style={[styles.splitTools, { backgroundColor: palette.action }]}>
              <AppTextInput value={splitTitle} onChangeText={setSplitTitle} placeholder="新主题的名字" placeholderTextColor={palette.secondary}
                editable={!busy} style={[styles.titleInput, { color: palette.text, borderColor: palette.divider }]} />
              <Pressable disabled={busy || !selectedNodes.length || !splitTitle.trim()} onPress={splitNodes} style={styles.button}>
                <Text style={{ color: palette.text, opacity: selectedNodes.length && splitTitle.trim() ? 1 : 0.5 }}>拆成新主题</Text>
              </Pressable>
            </View> : null}
          </> : null}
          {status ? <Text style={[styles.hint, { color: palette.secondary }]}>{status}</Text> : null}
        </ScrollView>}
      </KeyboardAvoidingView>
    </Modal>
    <Modal visible={active && periodPicker} animationType="slide" statusBarTranslucent backdropColor={palette.surface}
      onRequestClose={() => setPeriodPicker(false)}>
      <View style={[styles.root, { backgroundColor: palette.surface }]}>
        <View style={[styles.detailHeader, { paddingTop: Math.max(14, insets.top + 8), borderBottomColor: palette.divider }]}>
          <Pressable onPress={() => setPeriodPicker(false)} style={styles.back}><Text style={{ color: palette.text }}>‹ 已结束的周期</Text></Pressable>
        </View>
        <FlatList data={periodChoices} keyExtractor={item => item.start} initialNumToRender={10} windowSize={5}
          contentContainerStyle={styles.article} ListEmptyComponent={<Text style={[styles.empty, { color: palette.secondary }]}>从 2026 年 10 月开始，目前没有已结束的周期。</Text>}
          renderItem={({ item }) => <Pressable disabled={busy} style={[styles.preview, { borderColor: palette.divider }]}
            onPress={() => { setPeriodPicker(false); void execute(item.start); }}>
            <Text style={[styles.label, { color: palette.text }]}>{shiyingReviewPeriodLabel(item.start, item.end)}</Text>
          </Pressable>} />
      </View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', marginBottom: 22 },
  menu: { width: 42, height: 42, borderRadius: 18, alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  pageTitle: { fontSize: 29, fontWeight: '500', letterSpacing: 2 },
  medium: { fontWeight: '500' },
  label: { fontSize: 15, fontWeight: '500' },
  hint: { fontSize: 12, lineHeight: 20, marginTop: 7 },
  toolbar: { borderRadius: 16, borderWidth: 1, padding: 16 },
  toolbarRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  button: { minHeight: 44, paddingHorizontal: 13, paddingVertical: 11, borderRadius: 12, justifyContent: 'center' },
  sections: { flexDirection: 'row', gap: 22, marginTop: 22, marginBottom: 16 },
  kindChoices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 16 },
  section: { paddingVertical: 12 },
  preview: { borderWidth: 1, borderRadius: 17, padding: 18, marginBottom: 12 },
  previewTitle: { fontSize: 21, lineHeight: 31, fontWeight: '500', marginTop: 8 },
  previewBody: { fontSize: 15, lineHeight: 24, marginTop: 10 },
  empty: { fontSize: 14, lineHeight: 23, paddingVertical: 30 },
  more: { minHeight: 44, alignItems: 'center', justifyContent: 'center', padding: 16 },
  detailHeader: { paddingHorizontal: 22, paddingBottom: 10, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth },
  back: { minHeight: 44, minWidth: 44, paddingVertical: 12, justifyContent: 'center' },
  article: { paddingHorizontal: 25, paddingTop: 30 },
  period: { fontSize: 12, lineHeight: 20, marginBottom: 12 },
  articleTitle: { fontSize: 28, lineHeight: 40, fontWeight: '500' },
  readingContent: { marginTop: 30 },
  readingParagraph: { marginBottom: 24 },
  readingBody: { fontSize: 17, lineHeight: 31, fontWeight: '400' },
  readingHeadingRow: { flexDirection: 'row', alignItems: 'flex-start', marginTop: 10, marginBottom: 17 },
  headingDot: { width: 9, height: 9, borderRadius: 4.5, marginTop: 12, marginRight: 12 },
  readingHeading: { flex: 1, fontSize: 21, lineHeight: 32, fontWeight: '500' },
  articleActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 20, marginTop: 12 },
  feather: { alignItems: 'center', paddingVertical: 30 },
  sourceBlock: { marginBottom: 36 },
  sourceImage: { width: '100%', height: 240, justifyContent: 'center', borderRadius: 10, overflow: 'hidden', marginTop: 18 },
  sourceNote: { marginTop: 24 },
  node: { borderLeftWidth: 2, paddingLeft: 18, marginTop: 22, paddingTop: 8, paddingBottom: 12 },
  splitTools: { borderRadius: 14, padding: 16, marginTop: 20 },
  titleInput: { fontSize: 17, minHeight: 48, borderBottomWidth: 1, paddingBottom: 10 },
  editArea: { flex: 1, minHeight: 0, paddingHorizontal: 24, paddingTop: 16 },
  editViewport: { flex: 1, minHeight: 0, overflow: 'hidden' },
  editInput: { flex: 1, minHeight: 0, fontSize: 17, lineHeight: 31, textAlignVertical: 'top', paddingTop: 14 },
  editTitle: { fontSize: 25, lineHeight: 36, fontWeight: '500' },
});
