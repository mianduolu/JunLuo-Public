import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  FlatList,
  type ListRenderItemInfo,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AppText as Text } from '../components/AppText';
import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { colors } from '../theme/colors';
import { ShiyingRecordsFeature, ShiyingRecordTabs, type ShiyingTab } from './ShiyingRecordsFeature';
import { ShiyingReviewsFeature } from './ShiyingReviewsFeature';
import { ShiyingBackfillFeature } from './ShiyingBackfillFeature';
import { isShiyingBackfillExecuting, subscribeShiyingBackfillExecution } from './shiyingBackfillState';
import { ShiyingEntryEditor } from './ShiyingEntryEditor';
import {
  checkShiyingEntrySources,
  SHIYING_ENTRY_SOURCE_STATUS_LABELS,
  type ShiyingEntrySourceCheck,
} from './shiyingEntrySources';
import {
  getOverlayTextStyle,
  type HomeBackgroundReadability,
} from '../theme/homeReadability';
import {
  addShiyingEntriesToLifeDateGroups,
  buildShiyingArchiveRows,
  excludeShiyingDeliveryFromArchiveGroups,
  formatShiyingLifeDateLabel,
  groupShiyingDeliveryEntries,
  removeShiyingEntryFromLifeDateGroups,
  toggleShiyingExpandedLifeDate,
  type ShiyingArchiveRow,
} from './shiyingArchive';
import type { ShiyingCategory, ShiyingEntryV1 } from './shiyingContract';
import {
  abandonManualShiyingPickup,
  getManualShiyingRunStatus,
  getShiyingPickupRecoveryState,
  retryShiyingPickupLocalSave,
  runManualShiyingPickup,
  subscribeShiyingPickupChanges,
  type ShiyingManualPickupResult,
  type ShiyingManualRunStatus,
} from './shiyingCoordinator';
import {
  createShiyingEntryEditorSave,
  listShiyingEntries,
  listShiyingLifeDateGroups,
  markShiyingEntriesPresented,
  rejectShiyingEntry,
  subscribeShiyingEntryChanges,
  type ShiyingLifeDateGroup,
} from './shiyingStore';
import { SHIYING_AUTOMATIC_EXPLANATION } from './shiyingAutomaticPolicy';
import {
  loadShiyingAutomaticState,
  setShiyingAutomaticEnabled,
  subscribeShiyingAutomaticState,
} from './shiyingAutomaticStore';
import type { ShiyingOpenRequest } from './shiyingNotificationPolicy';
import {
  getShiyingNotificationSettings, setShiyingNotificationsEnabled,
  setShiyingNotificationFeatureVisible, subscribeShiyingNotificationSettings,
} from './shiyingNotifications';

const CATEGORY_LABELS: Record<ShiyingCategory, string> = {
  anticipation: '期待',
  liking: '喜欢',
  accomplishment: '做到了',
  comfort: '舒服／放松',
  felt_seen: '被理解',
  creative_excitement: '新点子',
};

export function getShiyingVisualPalette(readability: HomeBackgroundReadability) {
  if (readability.exposedLabelText === 'light') {
    return {
      accent: '#F1CE73',
      actionSurface: 'rgba(174,210,226,0.12)',
      buttonSurface: '#D9BA7A',
      buttonText: '#302515',
      secondaryButtonSurface: 'rgba(217,186,122,0.16)',
      switchTrackOn: '#B18A47',
      switchThumbOn: '#F0D9A9',
      cardBorder: 'rgba(255,255,255,0.12)',
      cardSurface: 'rgba(22,33,50,0.82)',
      dateExpandedSurface: 'rgba(31,44,63,0.9)',
      dateSurface: 'rgba(22,33,50,0.7)',
      deliveryBorder: 'rgba(242,207,116,0.28)',
      deliveryCardSurface: 'rgba(30,41,57,0.88)',
      deliveryTagSurface: 'rgba(242,207,116,0.16)',
      emptySurface: 'rgba(22,33,50,0.68)',
      menuSurface: 'rgba(24,33,52,0.68)',
      menuText: '#FFFFFF',
      modalBackdrop: 'rgba(12,17,29,0.56)',
      panelBorder: 'rgba(255,255,255,0.13)',
      panelSurface: 'rgba(22,33,50,0.8)',
      primaryText: '#F5F2E9',
      secondaryText: 'rgba(235,237,239,0.7)',
      sheetHandle: 'rgba(255,255,255,0.2)',
      sheetSurface: '#202A3E',
      sourceCardSurface: 'rgba(255,255,255,0.07)',
      tagSurface: 'rgba(168,210,229,0.14)',
    };
  }
  return {
    accent: '#9D7D2F',
    actionSurface: 'rgba(115,158,177,0.13)',
    buttonSurface: '#DDC08A',
    buttonText: '#41301A',
    secondaryButtonSurface: 'rgba(196,153,72,0.18)',
    switchTrackOn: '#E8D2AA',
    switchThumbOn: '#C49948',
    cardBorder: 'rgba(56,64,82,0.08)',
    cardSurface: 'rgba(245,243,236,0.9)',
    dateExpandedSurface: 'rgba(238,236,226,0.94)',
    dateSurface: 'rgba(242,240,232,0.82)',
    deliveryBorder: 'rgba(155,124,47,0.2)',
    deliveryCardSurface: 'rgba(239,236,224,0.92)',
    deliveryTagSurface: 'rgba(179,145,62,0.16)',
    emptySurface: 'rgba(245,243,236,0.74)',
    menuSurface: 'rgba(255,255,255,0.72)',
    menuText: colors.ink,
    modalBackdrop: 'rgba(30,35,50,0.3)',
    panelBorder: 'rgba(56,64,82,0.08)',
    panelSurface: 'rgba(242,240,232,0.9)',
    primaryText: colors.ink,
    secondaryText: '#687080',
    sheetHandle: 'rgba(56,64,82,0.18)',
    sheetSurface: '#F3F0E8',
    sourceCardSurface: 'rgba(255,255,255,0.74)',
    tagSurface: 'rgba(115,158,177,0.14)',
  };
}

function formatSourceTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function resultStatus(result: ShiyingManualPickupResult) {
  if (result.kind === 'save_pending') return '结果已收到，等待本地保存；可以再存一次。';
  if (result.kind === 'retry_confirmation_required') return '上次没能捡完，继续捡可能会再次产生调用费用。';
  if (result.kind === 'recovery_stale') return '整理进度已变化，请重新操作。';
  if (result.kind === 'entries') return `本次已保存 ${result.entries.length} 条荧迹。`;
  if (result.kind === 'zero') return '本次整理完成，没有新的荧迹。';
  if (result.kind === 'no_material') return '没有新的聊天可以整理，本次没有调用模型。';
  if (result.kind === 'chat_busy') return '聊天回复正在进行，请稍后再试。';
  if (result.kind === 'model_config_missing') {
    return '还没有可用的模型连接，请先到 AI 设置中配置。';
  }
  if (result.kind === 'restore_busy') return '君落正在处理备份或恢复，请稍后再试。';
  if (result.kind === 'progress') {
    return `已经整理 ${result.completedChunks}/${result.totalChunks} 段，还剩 ${result.remainingChunks} 段。`;
  }
  if (result.kind === 'blocked') {
    if (result.code === 'input_too_large') {
      return '有一条完整消息超出当前模型连接容量，本次没有调用模型。';
    }
    if (result.code === 'model_output_invalid') {
      return '模型返回的内容无法使用；已完成的分段已经保留。';
    }
    if (result.code === 'interrupted_request') {
      return '上次整理在请求中中断；再次点击可以重试这一段。';
    }
    return '这次整理卡住了；已完成的分段已经保留。';
  }
  return '这次没有完成，这段聊天还没有被标成已整理。';
}

export function ShiyingFeature({
  backgroundReadability, onOpenFeatureDrawer, active = true, openRequest, onOpenRequestConsumed,
}: {
  backgroundReadability: HomeBackgroundReadability;
  onOpenFeatureDrawer?: () => void;
  active?: boolean;
  openRequest?: ShiyingOpenRequest | null;
  onOpenRequestConsumed?: (requestId: string) => void;
}) {
  const [tab, setTab] = useState<ShiyingTab>('entries');
  const [recordsVisited, setRecordsVisited] = useState(false);
  const [reviewsVisited, setReviewsVisited] = useState(false);
  const [recordEditorOpen, setRecordEditorOpen] = useState(false);
  const [reviewEditorOpen, setReviewEditorOpen] = useState(false);
  const [notificationOpenRequestId, setNotificationOpenRequestId] = useState<string>();
  const consumedRequest = useRef<string | null>(null);
  const visual = useMemo(() => getShiyingVisualPalette(backgroundReadability), [backgroundReadability]);
  const selectTab = (value: ShiyingTab) => {
    if (value === 'records') setRecordsVisited(true);
    if (value === 'reviews') setReviewsVisited(true);
    setTab(value);
  };
  useEffect(() => {
    setShiyingNotificationFeatureVisible(active);
    return () => { setShiyingNotificationFeatureVisible(false); };
  }, [active]);
  useEffect(() => {
    if (!active || !openRequest || recordEditorOpen || reviewEditorOpen || consumedRequest.current === openRequest.requestId
      || !canCommitBackupRestoreDataEpoch(openRequest.dataEpoch)) return;
    if (tab !== 'entries') { setTab('entries'); return; }
    consumedRequest.current = openRequest.requestId;
    setTab('entries');
    setNotificationOpenRequestId(openRequest.requestId);
    onOpenRequestConsumed?.(openRequest.requestId);
  }, [active, openRequest, recordEditorOpen, reviewEditorOpen, tab, onOpenRequestConsumed]);
  return <View style={styles.root}>
    <View style={{ flex: 1, display: tab === 'entries' ? 'flex' : 'none' }}>
      <ShiyingEntriesFeature backgroundReadability={backgroundReadability} onOpenFeatureDrawer={onOpenFeatureDrawer}
        active={active && tab === 'entries'} onChangeTab={selectTab} notificationOpenRequestId={notificationOpenRequestId} />
    </View>
    {recordsVisited ? <View style={{ flex: 1, display: tab === 'records' ? 'flex' : 'none' }}>
      <ShiyingRecordsFeature active={active && tab === 'records'} visual={visual} backgroundReadability={backgroundReadability}
        onOpenFeatureDrawer={onOpenFeatureDrawer} onChangeTab={selectTab}
        onEditorPresenceChange={setRecordEditorOpen} />
    </View> : null}
    {reviewsVisited ? <View style={{ flex: 1, display: tab === 'reviews' ? 'flex' : 'none' }}>
      <ShiyingReviewsFeature active={active && tab === 'reviews'} visual={visual} backgroundReadability={backgroundReadability}
          onOpenFeatureDrawer={onOpenFeatureDrawer} onChangeTab={selectTab} onEditorPresenceChange={setReviewEditorOpen}
          onEditorClosed={() => setReviewEditorOpen(false)} />
    </View> : null}
  </View>;
}

function ShiyingEntriesFeature({
  backgroundReadability,
  onOpenFeatureDrawer,
  active = true,
  onChangeTab,
  notificationOpenRequestId,
}: {
  backgroundReadability: HomeBackgroundReadability;
  onOpenFeatureDrawer?: () => void;
  active?: boolean;
  onChangeTab: (value: ShiyingTab) => void;
  notificationOpenRequestId?: string;
}) {
  const insets = useSafeAreaInsets();
  const listRef = useRef<FlatList<ShiyingArchiveRow>>(null);
  const notificationLoadRef = useRef(0);
  const notificationSavingRef = useRef(false);
  const [notificationSettings, setNotificationSettings] = useState<Awaited<ReturnType<typeof getShiyingNotificationSettings>> | null>(null);
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationStatus, setNotificationStatus] = useState('');
  const [backfillExecuting, setBackfillExecuting] = useState(isShiyingBackfillExecuting);
  const visual = useMemo(
    () => getShiyingVisualPalette(backgroundReadability),
    [backgroundReadability],
  );
  const headerTextStyle = useMemo(
    () => getOverlayTextStyle(backgroundReadability.headerText),
    [backgroundReadability.headerText],
  );
  const exposedTextStyle = useMemo(
    () => getOverlayTextStyle(backgroundReadability.exposedLabelText),
    [backgroundReadability.exposedLabelText],
  );
  const currentYear = new Date().getFullYear();
  const mountedRef = useRef(true);
  const activeRef = useRef(active);
  activeRef.current = active;
  const pickupActionRef = useRef(0);
  const pickupActionBusyRef = useRef(false);
  const [recoveryState, setRecoveryState] = useState<Awaited<ReturnType<typeof getShiyingPickupRecoveryState>>>(null);
  const archiveRequestRef = useRef(0);
  const archiveCursorRef = useRef<string | null>(null);
  const deliveryRegionVisibleRef = useRef(false);
  const presentationFlightsRef = useRef(new Set<string>());
  const entryRejectionsRef = useRef(new Set<string>());
  const deliveryEntriesRef = useRef<ShiyingEntryV1[]>([]);
  const pickupBootedRef = useRef(false);
  const pickupRefreshFlightRef = useRef(false);
  const pickupRefreshNeededRef = useRef(false);
  const automaticLoadRequestRef = useRef(0);
  const automaticSavingRef = useRef(false);
  const [deliveryEntries, setDeliveryEntriesState] = useState<ShiyingEntryV1[]>([]);
  const setDeliveryEntries = (
    next: ShiyingEntryV1[] | ((current: ShiyingEntryV1[]) => ShiyingEntryV1[]),
  ) => {
    const entries = typeof next === 'function' ? next(deliveryEntriesRef.current) : next;
    deliveryEntriesRef.current = entries;
    setDeliveryEntriesState(entries);
  };
  const [lifeDateGroups, setLifeDateGroups] = useState<ShiyingLifeDateGroup[]>([]);
  const [nextBeforeLifeDate, setNextBeforeLifeDate] = useState<string | null>(null);
  const [expandedLifeDate, setExpandedLifeDate] = useState<string | null>(null);
  const [expandedEntries, setExpandedEntries] = useState<ShiyingEntryV1[]>([]);
  const [loadingArchive, setLoadingArchive] = useState(true);
  const [loadingExpandedLifeDate, setLoadingExpandedLifeDate] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selectedEntry, setSelectedEntry] = useState<ShiyingEntryV1 | null>(null);
  const [sourceChecks, setSourceChecks] = useState<{
    entry: ShiyingEntryV1;
    checks: ShiyingEntrySourceCheck[];
  } | null>(null);
  const [editingEntry, setEditingEntry] = useState<{
    entry: ShiyingEntryV1;
    save: (body: string) => Promise<ShiyingEntryV1>;
  } | null>(null);
  const [running, setRunning] = useState(false);
  const [runState, setRunState] = useState<ShiyingManualRunStatus | null>(null);
  const [status, setStatus] = useState('');
  const [automaticEnabled, setAutomaticEnabled] = useState(false);
  const [automaticStateReady, setAutomaticStateReady] = useState(false);
  const [automaticSaving, setAutomaticSaving] = useState(false);
  const [automaticStatus, setAutomaticStatus] = useState('');
  const [automaticErrorCode, setAutomaticErrorCode] = useState<string | null>(null);

  const mergePickupEntries = (entries: readonly ShiyingEntryV1[]) => {
    const knownIds = new Set(deliveryEntriesRef.current.map((entry) => entry.id));
    const added = entries.filter((entry) => entry.status === 'active' && !knownIds.has(entry.id));
    if (!added.length) return;
    setDeliveryEntries((current) => [...current, ...added]);
    const beforeLifeDate = archiveCursorRef.current;
    setLifeDateGroups((current) => {
      const knownDates = new Set(current.map((group) => group.lifeDate));
      const counted = added.filter((entry) => beforeLifeDate === null
        || entry.lifeDate >= beforeLifeDate || knownDates.has(entry.lifeDate));
      return addShiyingEntriesToLifeDateGroups(current, counted);
    });
  };

  const refreshPickupPage = async () => {
    pickupRefreshNeededRef.current = true;
    if (!mountedRef.current || !activeRef.current || !pickupBootedRef.current || pickupRefreshFlightRef.current) return;
    pickupRefreshFlightRef.current = true;
    try {
      do {
        pickupRefreshNeededRef.current = false;
        const [pendingEntries, nextRunState, nextRecoveryState] = await Promise.all([
          listShiyingEntries({ status: 'active', pendingOnly: true }),
          getManualShiyingRunStatus(),
          getShiyingPickupRecoveryState(),
        ]);
        if (!mountedRef.current) return;
        if (!activeRef.current) {
          pickupRefreshNeededRef.current = true;
          return;
        }
        setRunState(nextRunState);
        setRecoveryState(nextRecoveryState);
        mergePickupEntries(pendingEntries);
      } while (pickupRefreshNeededRef.current);
    } catch {
      if (mountedRef.current && activeRef.current) setStatus('荧迹暂时无法读取。');
    } finally {
      pickupRefreshFlightRef.current = false;
    }
  };

  const refreshAutomaticState = async () => {
    const requestId = ++automaticLoadRequestRef.current;
    try {
      const state = await loadShiyingAutomaticState();
      if (!mountedRef.current || requestId !== automaticLoadRequestRef.current) return;
      setAutomaticEnabled(state.enabled);
      setAutomaticErrorCode(state.lastErrorCode ?? null);
      setAutomaticStateReady(true);
    } catch {
      // A failed first read leaves the switch disabled until a later successful read.
    }
  };

  const refreshNotificationSettings = async () => {
    const requestId = ++notificationLoadRef.current;
    try {
      const settings = await getShiyingNotificationSettings();
      if (mountedRef.current && requestId === notificationLoadRef.current) setNotificationSettings(settings);
    } catch {
      if (mountedRef.current && requestId === notificationLoadRef.current) setNotificationStatus('拾荧通知设置暂时无法读取。');
    }
  };
  const saveNotificationEnabled = async (enabled: boolean) => {
    if (!notificationSettings || notificationSavingRef.current) return;
    notificationSavingRef.current = true; setNotificationSaving(true); setNotificationStatus('');
    try {
      const settings = await setShiyingNotificationsEnabled(enabled);
      if (!mountedRef.current) return;
      notificationLoadRef.current += 1;
      setNotificationSettings(settings);
      if (enabled && !settings.enabled) setNotificationStatus('系统未允许拾荧通知，开关仍然关闭。');
    } catch { if (mountedRef.current) setNotificationStatus('拾荧通知设置暂时无法保存。'); }
    finally { notificationSavingRef.current = false; if (mountedRef.current) setNotificationSaving(false); }
  };

  const saveAutomaticEnabled = async (enabled: boolean) => {
    if (!mountedRef.current || !automaticStateReady || automaticSavingRef.current || enabled === automaticEnabled) return;
    automaticSavingRef.current = true;
    setAutomaticSaving(true);
    setAutomaticStatus('');
    try {
      const result = await runBackupRestoreDataEpochCommit(
        captureBackupRestoreDataEpoch(),
        () => setShiyingAutomaticEnabled(enabled),
      );
      if (!result.committed) throw new Error('shiying_automatic_restore_changed');
      if (!mountedRef.current) return;
      automaticLoadRequestRef.current += 1;
      setAutomaticEnabled(result.value.enabled);
    } catch {
      if (mountedRef.current) setAutomaticStatus('自动拾荧设置暂时无法保存。');
    } finally {
      automaticSavingRef.current = false;
      if (mountedRef.current) setAutomaticSaving(false);
    }
  };

  useEffect(() => {
    setSourceChecks(null);
    if (!selectedEntry) return;
    let cancelled = false;
    void checkShiyingEntrySources(selectedEntry.sources).then((checks) => {
      if (!cancelled && mountedRef.current) setSourceChecks({ entry: selectedEntry, checks });
    });
    return () => { cancelled = true; };
  }, [selectedEntry]);

  const openEntryEditor = (entry: ShiyingEntryV1) => {
    setSelectedEntry(null);
    setEditingEntry({ entry, save: createShiyingEntryEditorSave(entry) });
  };
  const applyEditedEntry = (entry: ShiyingEntryV1) => {
    if (!mountedRef.current) return;
    setDeliveryEntries((current) => current.map((item) => item.id === entry.id ? entry : item));
    setExpandedEntries((current) => current.map((item) => item.id === entry.id ? entry : item));
    setEditingEntry(null);
  };

  const deliveryGroups = useMemo(
    () => groupShiyingDeliveryEntries(deliveryEntries),
    [deliveryEntries],
  );
  const deliveryIds = useMemo(
    () => new Set(deliveryEntries.map((entry) => entry.id)),
    [deliveryEntries],
  );
  const archiveGroups = useMemo(
    () => excludeShiyingDeliveryFromArchiveGroups(lifeDateGroups, deliveryEntries),
    [deliveryEntries, lifeDateGroups],
  );
  const visibleExpandedEntries = useMemo(
    () => expandedEntries.filter((entry) => (
      entry.status === 'active' && !deliveryIds.has(entry.id)
    )),
    [deliveryIds, expandedEntries],
  );
  const rows = useMemo(() => buildShiyingArchiveRows({
    deliveryGroups,
    archiveGroups,
    expandedLifeDate,
    expandedEntries: visibleExpandedEntries,
    loadingArchive,
    loadingExpandedLifeDate,
    hasMoreArchiveGroups: nextBeforeLifeDate !== null,
  }), [
    archiveGroups,
    deliveryGroups,
    expandedLifeDate,
    loadingArchive,
    loadingExpandedLifeDate,
    nextBeforeLifeDate,
    visibleExpandedEntries,
  ]);

  const loadArchiveLifeDate = async (lifeDate: string) => {
    const requestId = archiveRequestRef.current + 1;
    archiveRequestRef.current = requestId;
    setExpandedLifeDate(lifeDate);
    setExpandedEntries([]);
    setLoadingExpandedLifeDate(lifeDate);
    try {
      const entries = await listShiyingEntries({ lifeDate, status: 'active' });
      if (!mountedRef.current || archiveRequestRef.current !== requestId) return;
      setExpandedEntries(entries);
    } catch {
      if (mountedRef.current && archiveRequestRef.current === requestId) {
        setStatus('这一天的荧迹暂时无法读取。');
      }
    } finally {
      if (mountedRef.current && archiveRequestRef.current === requestId) {
        setLoadingExpandedLifeDate(null);
      }
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    async function boot() {
      const [pendingEntries, datePage, nextRunState, nextRecoveryState] = await Promise.all([
        listShiyingEntries({ status: 'active', pendingOnly: true }),
        listShiyingLifeDateGroups(),
        getManualShiyingRunStatus(),
        getShiyingPickupRecoveryState(),
      ]);
      if (!mountedRef.current) return;
      const nextArchiveGroups = excludeShiyingDeliveryFromArchiveGroups(
        datePage.groups,
        pendingEntries,
      );
      setDeliveryEntries(pendingEntries);
      setLifeDateGroups(datePage.groups);
      archiveCursorRef.current = datePage.nextBeforeLifeDate;
      setNextBeforeLifeDate(datePage.nextBeforeLifeDate);
      setRunState(nextRunState);
      setRecoveryState(nextRecoveryState);
      setLoadingArchive(false);
      const defaultLifeDate = nextArchiveGroups[0]?.lifeDate ?? null;
      if (defaultLifeDate) await loadArchiveLifeDate(defaultLifeDate);
      pickupBootedRef.current = true;
      if (pickupRefreshNeededRef.current) void refreshPickupPage();
    }
    void boot().catch(() => {
      if (!mountedRef.current) return;
      setLoadingArchive(false);
      setStatus('荧迹暂时无法读取。');
      pickupBootedRef.current = true;
    });
    return () => {
      mountedRef.current = false;
      archiveRequestRef.current += 1;
      automaticLoadRequestRef.current += 1;
      notificationLoadRef.current += 1;
      pickupActionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    void refreshAutomaticState();
    void refreshNotificationSettings();
    const unsubscribeNotification = subscribeShiyingNotificationSettings(() => void refreshNotificationSettings());
    const unsubscribeAutomatic = subscribeShiyingAutomaticState(() => void refreshAutomaticState());
    const unsubscribePickup = subscribeShiyingPickupChanges(() => void refreshPickupPage());
    const unsubscribeEntries = subscribeShiyingEntryChanges(() => void refreshPickupPage());
    const unsubscribeBackfill = subscribeShiyingBackfillExecution(() => setBackfillExecuting(isShiyingBackfillExecuting()));
    return () => {
      unsubscribeAutomatic();
      unsubscribeNotification();
      unsubscribePickup();
      unsubscribeEntries();
      unsubscribeBackfill();
    };
  }, []);

  useEffect(() => {
    pickupActionRef.current += 1;
    if (active && pickupBootedRef.current) {
      void refreshPickupPage();
      void refreshAutomaticState();
      void refreshNotificationSettings();
    }
  }, [active]);

  useEffect(() => {
    if (!active || !notificationOpenRequestId) return;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
    void refreshPickupPage();
  }, [active, notificationOpenRequestId]);

  useEffect(() => {
    if (
      loadingArchive
      || expandedLifeDate === null
      || archiveGroups.some((group) => group.lifeDate === expandedLifeDate)
    ) return;
    const nextLifeDate = archiveGroups[0]?.lifeDate ?? null;
    if (nextLifeDate) {
      void loadArchiveLifeDate(nextLifeDate);
    } else {
      archiveRequestRef.current += 1;
      setExpandedLifeDate(null);
      setExpandedEntries([]);
      setLoadingExpandedLifeDate(null);
    }
  }, [archiveGroups, expandedLifeDate, loadingArchive]);

  const refreshRunState = async () => {
    const [nextRunState, nextRecoveryState] = await Promise.all([
      getManualShiyingRunStatus(), getShiyingPickupRecoveryState(),
    ]);
    if (mountedRef.current) { setRunState(nextRunState); setRecoveryState(nextRecoveryState); }
  };

  const pickNow = async () => {
    if (pickupActionBusyRef.current || !activeRef.current) return;
    pickupActionBusyRef.current = true;
    const action = ++pickupActionRef.current;
    const epoch = captureBackupRestoreDataEpoch();
    const current = () => mountedRef.current && activeRef.current
      && action === pickupActionRef.current && epoch === captureBackupRestoreDataEpoch();
    setRunning(true);
    setStatus('正在检查整理进度…');
    try {
      const recovery = await getShiyingPickupRecoveryState();
      if (!current()) return;
      if (recovery?.kind === 'recovery_stale' || epoch === null) {
        setStatus(resultStatus(recovery?.kind === 'recovery_stale' ? recovery : { kind: 'restore_busy' }));
        await refreshRunState();
        return;
      }
      const dependencies = {
        onPhase: (phase, progress) => {
          if (mountedRef.current && phase === 'calling') {
            setStatus(
              progress
                ? `正在整理第 ${progress.chunkIndex + 1}/${progress.totalChunks} 段…本次最多调用 2 次模型。`
                : '正在整理…本次最多调用 2 次模型。',
            );
          }
        },
      } satisfies Parameters<typeof runManualShiyingPickup>[0];
      let result: ShiyingManualPickupResult;
      if (recovery?.kind === 'save_pending') {
        result = await retryShiyingPickupLocalSave({}, { batchId: recovery.batchId, epoch });
      } else {
        if (recovery?.kind === 'retry_confirmation_required') {
          const confirmed = await new Promise<boolean>(resolve => Alert.alert('',
            '上次没能捡完，继续捡可能会再次产生调用费用。', [
              { text: '先放一放', style: 'cancel', onPress: () => resolve(false) },
              { text: '继续捡', onPress: () => resolve(true) },
            ], { cancelable: true, onDismiss: () => resolve(false) }));
          if (!confirmed || !current()) return;
        }
        result = await runManualShiyingPickup(dependencies, recovery?.kind === 'retry_confirmation_required'
          ? { retryConfirmation: recovery.confirmation } : undefined);
      }
      if (!mountedRef.current || epoch !== captureBackupRestoreDataEpoch()) return;
      setStatus(resultStatus(result));
      await refreshRunState();
      if (result.kind === 'entries') {
        mergePickupEntries(result.entries);
      }
    } catch {
      if (mountedRef.current) {
        setStatus('这次没有完成，这段聊天还没有被标成已整理。');
      }
      await refreshRunState().catch(() => undefined);
    } finally {
      pickupActionBusyRef.current = false;
      if (mountedRef.current) setRunning(false);
    }
  };

  const confirmAbandon = () => {
    if (running || runState?.kind !== 'blocked') return;
    Alert.alert(
      '放弃这次整理？',
      '未完成的临时材料会被清除，聊天和已有荧迹不会删除。以后再次整理时，已经调用过的部分可能会重新调用模型。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '放弃这次整理',
          style: 'destructive',
          onPress: () => {
            setRunning(true);
            void abandonManualShiyingPickup().then(async (abandoned) => {
              if (!mountedRef.current) return;
              await refreshRunState();
              setStatus(abandoned
                ? '已清除这次未完成的临时材料。'
                : '当前没有可以放弃的未完成整理。');
            }).catch(() => {
              if (mountedRef.current) setStatus('暂时无法放弃这次整理。');
            }).finally(() => {
              if (mountedRef.current) setRunning(false);
            });
          },
        },
      ],
    );
  };

  const markDeliveryPresented = () => {
    const pending = deliveryEntries.filter((entry) => entry.presentedAt === null);
    if (!activeRef.current || !deliveryRegionVisibleRef.current || !pending.length) return;
    const flightKey = pending.map((entry) => entry.id).sort().join('|');
    if (presentationFlightsRef.current.has(flightKey)) return;
    presentationFlightsRef.current.add(flightKey);
    const presentedAt = Math.max(Date.now(), ...pending.map((entry) => entry.updatedAt));
    void markShiyingEntriesPresented({
      entryIds: pending.map((entry) => entry.id),
      presentedAt,
    }).then((updated) => {
      presentationFlightsRef.current.delete(flightKey);
      if (!mountedRef.current) return;
      const updatedById = new Map(updated.map((entry) => [entry.id, entry]));
      setDeliveryEntries((current) => current.map(
        (entry) => updatedById.get(entry.id) ?? entry,
      ));
    }).catch(() => {
      presentationFlightsRef.current.delete(flightKey);
      if (mountedRef.current) {
        setStatus('荧迹已经保存，显示状态会在下次打开时再确认。');
      }
    });
  };

  const pendingDeliveryKey = deliveryEntries
    .filter((entry) => entry.presentedAt === null)
    .map((entry) => entry.id)
    .sort()
    .join('|');
  useEffect(() => {
    if (pendingDeliveryKey) markDeliveryPresented();
  }, [pendingDeliveryKey, active]);

  const rejectEntry = (entry: ShiyingEntryV1) => {
    if (entryRejectionsRef.current.has(entry.id)) return;
    Alert.alert(
      '确定这条不算吗？',
      '确认后，这条会从荧迹中隐藏，不能恢复；原聊天不会被删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '这条不算',
          style: 'destructive',
          onPress: () => {
            if (entryRejectionsRef.current.has(entry.id)) return;
            entryRejectionsRef.current.add(entry.id);
            const rejectedAt = Math.max(Date.now(), entry.updatedAt);
            void rejectShiyingEntry({ id: entry.id, rejectedAt }).then(() => {
              if (!mountedRef.current) return;
              setDeliveryEntries((current) => current.filter((item) => item.id !== entry.id));
              setExpandedEntries((current) => current.filter((item) => item.id !== entry.id));
              setLifeDateGroups((current) => removeShiyingEntryFromLifeDateGroups(current, entry));
              setSelectedEntry((current) => current?.id === entry.id ? null : current);
            }).catch(() => {
              if (mountedRef.current) setStatus('这条荧迹暂时无法隐藏。');
            }).finally(() => { entryRejectionsRef.current.delete(entry.id); });
          },
        },
      ],
    );
  };

  const toggleArchiveDate = (lifeDate: string) => {
    const nextLifeDate = toggleShiyingExpandedLifeDate(expandedLifeDate, lifeDate);
    if (nextLifeDate === null) {
      archiveRequestRef.current += 1;
      setExpandedLifeDate(null);
      setExpandedEntries([]);
      setLoadingExpandedLifeDate(null);
      return;
    }
    void loadArchiveLifeDate(nextLifeDate);
  };

  const loadMoreArchive = async () => {
    if (loadingMore || nextBeforeLifeDate === null) return;
    setLoadingMore(true);
    try {
      const page = await listShiyingLifeDateGroups({ beforeLifeDate: nextBeforeLifeDate });
      if (!mountedRef.current) return;
      setLifeDateGroups((current) => {
        const known = new Set(current.map((group) => group.lifeDate));
        return [...current, ...page.groups.filter((group) => !known.has(group.lifeDate))];
      });
      archiveCursorRef.current = page.nextBeforeLifeDate;
      setNextBeforeLifeDate(page.nextBeforeLifeDate);
    } catch {
      if (mountedRef.current) setStatus('更早的荧迹暂时无法读取。');
    } finally {
      if (mountedRef.current) setLoadingMore(false);
    }
  };

  const renderEntry = (entry: ShiyingEntryV1, delivery = false) => (
    <View
      style={[
        styles.entryCard,
        { backgroundColor: visual.cardSurface, borderColor: visual.cardBorder },
        delivery && styles.deliveryCard,
        delivery && {
          backgroundColor: visual.deliveryCardSurface,
          borderColor: visual.deliveryBorder,
        },
      ]}
    >
      <Text
        style={[
          styles.category,
          { backgroundColor: visual.tagSurface, color: visual.primaryText },
          delivery && { backgroundColor: visual.deliveryTagSurface },
        ]}
      >
        {CATEGORY_LABELS[entry.category]}
      </Text>
      <Text style={[styles.entryBody, { color: visual.primaryText }]}>{entry.body}</Text>
      <View style={styles.entryActions}>
        <Pressable
          onPress={() => setSelectedEntry(entry)}
          style={[styles.secondaryAction, { backgroundColor: visual.actionSurface }]}
        >
          <Text style={[styles.secondaryActionText, { color: visual.primaryText }]}>看来源·{entry.sources.length}</Text>
        </Pressable>
        <Pressable
          onPress={() => openEntryEditor(entry)}
          style={[styles.secondaryAction, { backgroundColor: visual.actionSurface }]}
        >
          <Text style={[styles.secondaryActionText, { color: visual.primaryText }]}>改一改</Text>
        </Pressable>
        <Pressable onPress={() => rejectEntry(entry)} style={styles.rejectAction}>
          <Text style={[styles.rejectActionText, { color: visual.secondaryText }]}>这条不算</Text>
        </Pressable>
      </View>
    </View>
  );

  const renderRow = ({ item }: ListRenderItemInfo<ShiyingArchiveRow>) => {
    if (item.kind === 'delivery_intro') {
      return (
        <View
          onLayout={() => {
            deliveryRegionVisibleRef.current = true;
            markDeliveryPresented();
          }}
          style={styles.deliveryIntro}
        >
          <View style={[styles.fireflyDot, { backgroundColor: visual.accent }]} />
          <Text style={[styles.deliverySentence, exposedTextStyle]}>
            我捡到了一点小仓鼠散落的荧光噢！
          </Text>
        </View>
      );
    }
    if (item.kind === 'delivery_date') {
      return (
        <View style={styles.deliveryDateRow}>
          <Text style={[styles.deliveryDate, exposedTextStyle]}>
            {formatShiyingLifeDateLabel(item.lifeDate, currentYear)}
          </Text>
          <Text style={[styles.deliveryCount, exposedTextStyle]}>{item.count} 条</Text>
        </View>
      );
    }
    if (item.kind === 'entry') return renderEntry(item.entry, item.placement === 'delivery');
    if (item.kind === 'pickup_toolbar') {
      return (
        <View
          style={[
            styles.pickToolbar,
            { backgroundColor: visual.panelSurface, borderColor: visual.panelBorder },
          ]}
        >
          <View style={styles.pickToolbarMain}>
            <View style={styles.pickToolbarCopy}>
              <Text style={[styles.pickTitle, { color: visual.primaryText }]}>现在回头看看</Text>
              <Text style={[styles.pickHint, { color: visual.secondaryText }]}>
                每次最多调用 2 次模型；材料较多时会分几次继续，不会截断消息。
              </Text>
            </View>
            <Pressable
              disabled={running || backfillExecuting}
              onPress={() => void pickNow()}
              style={[
                styles.pickButton,
                { backgroundColor: visual.buttonSurface },
                running && styles.pickButtonDisabled,
              ]}
            >
              <Text style={[styles.pickButtonText, { color: visual.buttonText }]}>
                {running ? '正在整理…' : recoveryState?.kind === 'save_pending' ? '再存一次' : runState ? '继续捡一捡' : '现在捡一捡'}
              </Text>
            </Pressable>
          </View>
          <View style={styles.automaticRow}>
            <Text style={[styles.automaticLabel, { color: visual.primaryText }]}>自动拾荧</Text>
            <Switch
              accessibilityLabel="自动拾荧"
              disabled={!automaticStateReady || automaticSaving}
              value={automaticEnabled}
              onValueChange={(enabled) => void saveAutomaticEnabled(enabled)}
              trackColor={{ false: visual.actionSurface, true: visual.switchTrackOn }}
              thumbColor={automaticEnabled ? visual.switchThumbOn : visual.primaryText}
            />
          </View>
          <Text style={[styles.pickHint, { color: visual.secondaryText }]}>{SHIYING_AUTOMATIC_EXPLANATION}</Text>
          <View style={styles.automaticRow}>
            <Text style={[styles.automaticLabel, { color: visual.primaryText }]}>拾荧通知</Text>
            <Switch accessibilityLabel="拾荧通知" disabled={!notificationSettings || notificationSaving}
              value={notificationSettings?.enabled ?? false}
              onValueChange={enabled => void saveNotificationEnabled(enabled)}
              trackColor={{ false: visual.actionSurface, true: visual.switchTrackOn }}
              thumbColor={notificationSettings?.enabled ? visual.switchThumbOn : visual.primaryText} />
          </View>
          {notificationStatus ? <Text style={[styles.status, { color: visual.primaryText }]}>{notificationStatus}</Text> : null}
          {notificationSettings?.enabled && !notificationSettings.permissionGranted
            ? <Text style={[styles.status, { color: visual.primaryText }]}>系统通知权限未开启。</Text> : null}
          {automaticStatus ? <Text style={[styles.status, { color: visual.primaryText }]}>{automaticStatus}</Text> : null}
          {automaticErrorCode ? (
            <Text style={[styles.status, { color: visual.primaryText }]}>
              {`自动拾荧已暂停：${automaticErrorCode}。可以手动捡一捡。`}
            </Text>
          ) : null}
          {runState?.kind === 'blocked' ? (
            <Pressable disabled={running} onPress={confirmAbandon} style={styles.abandonAction}>
              <Text style={[styles.abandonActionText, { color: visual.secondaryText }]}>放弃这次整理</Text>
            </Pressable>
          ) : null}
          {status ? <Text style={[styles.status, { color: visual.primaryText }]}>{status}</Text> : null}
          <ShiyingBackfillFeature visual={visual} active={active} />
        </View>
      );
    }
    if (item.kind === 'archive_title') {
      return <Text style={[styles.archiveTitle, exposedTextStyle]}>荧迹</Text>;
    }
    if (item.kind === 'archive_date') {
      return (
        <Pressable
          accessibilityLabel={`${formatShiyingLifeDateLabel(item.group.lifeDate, currentYear)}，${item.group.activeCount}条荧迹`}
          accessibilityRole="button"
          onPress={() => toggleArchiveDate(item.group.lifeDate)}
          style={[
            styles.archiveDateButton,
            {
              backgroundColor: item.expanded ? visual.dateExpandedSurface : visual.dateSurface,
              borderColor: visual.cardBorder,
            },
          ]}
        >
          <View>
            <Text style={[styles.archiveDateText, { color: visual.primaryText }]}>
              {formatShiyingLifeDateLabel(item.group.lifeDate, currentYear)}
            </Text>
            <Text style={[styles.archiveDateCount, { color: visual.secondaryText }]}>
              {item.group.activeCount} 条荧迹
            </Text>
          </View>
          <Text style={[styles.archiveDateChevron, { color: visual.secondaryText }]}>
            {item.expanded ? '⌄' : '›'}
          </Text>
        </Pressable>
      );
    }
    if (item.kind === 'archive_loading') {
      return (
        <Text style={[styles.emptyText, { backgroundColor: visual.emptySurface, color: visual.secondaryText }]}>
          {item.lifeDate ? '正在读取这一天的荧迹…' : '正在读取荧迹…'}
        </Text>
      );
    }
    if (item.kind === 'archive_load_more') {
      return (
        <Pressable
          disabled={loadingMore}
          onPress={() => void loadMoreArchive()}
          style={[styles.loadMoreButton, { backgroundColor: visual.dateSurface }]}
        >
          <Text style={[styles.loadMoreText, { color: visual.primaryText }]}>
            {loadingMore ? '正在读取…' : '加载更早日期'}
          </Text>
        </Pressable>
      );
    }
    return (
      <Text style={[styles.emptyText, { backgroundColor: visual.emptySurface, color: visual.secondaryText }]}>
        还没有保存的荧迹。
      </Text>
    );
  };

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: Math.max(18, insets.top + 8),
            paddingBottom: Math.max(30, insets.bottom + 22),
          },
        ]}
        data={rows}
        initialNumToRender={12}
        keyExtractor={(item) => item.key}
        ListHeaderComponent={(
          <>
          <View style={styles.header}>
            <Pressable
              onPress={onOpenFeatureDrawer}
              style={[styles.menuButton, { backgroundColor: visual.menuSurface }]}
            >
              <Text style={[styles.menuText, { color: visual.menuText }]}>☰</Text>
            </Pressable>
            <View style={styles.headerCopy}>
              <Text style={[styles.title, headerTextStyle]}>拾荧</Text>
              <Text style={[styles.subtitle, headerTextStyle]}>把已经发生过的小小正向经历收好</Text>
            </View>
          </View>
          <ShiyingRecordTabs value="entries" onChange={onChangeTab} visual={visual} />
          </>
        )}
        renderItem={renderRow}
        showsVerticalScrollIndicator={false}
        windowSize={7}
      />

      {editingEntry ? (
        <ShiyingEntryEditor
          key={editingEntry.entry.id}
          entry={editingEntry.entry}
          visual={visual}
          save={editingEntry.save}
          onCancel={() => setEditingEntry(null)}
          onSaved={applyEditedEntry}
        />
      ) : null}

      <Modal
        animationType="slide"
        onRequestClose={() => setSelectedEntry(null)}
        transparent
        visible={!!selectedEntry}
      >
        <View style={styles.modalOverlay}>
          <Pressable
            style={[styles.modalBackdrop, { backgroundColor: visual.modalBackdrop }]}
            onPress={() => setSelectedEntry(null)}
          />
          <View
            style={[
              styles.sourceSheet,
              {
                backgroundColor: visual.sheetSurface,
                paddingBottom: Math.max(24, insets.bottom + 16),
              },
            ]}
          >
            <View style={[styles.sheetHandle, { backgroundColor: visual.sheetHandle }]} />
            <View style={styles.sheetHeader}>
              <Text style={[styles.sheetTitle, { color: visual.primaryText }]}>来源</Text>
              <Pressable onPress={() => setSelectedEntry(null)} style={styles.closeButton}>
                <Text style={[styles.closeText, { color: visual.secondaryText }]}>关闭</Text>
              </Pressable>
            </View>
            <ScrollView showsVerticalScrollIndicator={false}>
              <Text style={[styles.sourceTime, { color: visual.secondaryText, marginBottom: 12 }]}>
                以下为拾取时保存的文字。
              </Text>
              {selectedEntry?.sources.map((source, index) => (
                <View
                  key={`${source.sessionId}:${source.messageId}`}
                  style={[styles.sourceCard, { backgroundColor: visual.sourceCardSurface }]}
                >
                  <View style={styles.sourceHeader}>
                    <Text style={[styles.sourceRole, { color: visual.primaryText }]}>
                      {source.role === 'you' ? '小仓鼠 · 主要依据' : '白云小姐 · 上下文'}
                    </Text>
                    <Text style={[styles.sourceTime, { color: visual.secondaryText }]}>
                      {formatSourceTime(source.messageCreatedAt)}
                    </Text>
                  </View>
                  <Text style={[styles.sourceTime, { color: visual.secondaryText, marginBottom: 8 }]}>
                    {sourceChecks?.entry === selectedEntry
                      ? SHIYING_ENTRY_SOURCE_STATUS_LABELS[sourceChecks.checks[index].status]
                      : '正在核对…'}
                  </Text>
                  <Text selectable style={[styles.sourceText, { color: visual.primaryText }]}>
                    {source.excerptSnapshot}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { paddingHorizontal: 18 },
  header: { alignItems: 'center', flexDirection: 'row', marginBottom: 22 },
  menuButton: {
    alignItems: 'center',
    borderRadius: 18,
    height: 42,
    justifyContent: 'center',
    marginRight: 12,
    width: 42,
  },
  menuText: { fontSize: 21 },
  headerCopy: { flex: 1 },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 13, marginTop: 3, opacity: 0.82 },
  deliveryIntro: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    marginBottom: 14,
    paddingHorizontal: 4,
  },
  fireflyDot: {
    borderRadius: 5,
    height: 9,
    marginRight: 10,
    marginTop: 8,
    shadowColor: '#F1CE73',
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.55,
    shadowRadius: 7,
    width: 9,
  },
  deliverySentence: { flex: 1, fontSize: 18, fontWeight: '600', lineHeight: 27 },
  deliveryDateRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
    marginTop: 6,
    paddingHorizontal: 4,
  },
  deliveryDate: { fontSize: 14, fontWeight: '700' },
  deliveryCount: { fontSize: 11, opacity: 0.78 },
  pickToolbar: {
    borderRadius: 20,
    borderWidth: 1,
    marginTop: 12,
    overflow: 'hidden',
    padding: 15,
  },
  pickToolbarMain: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 13,
  },
  pickToolbarCopy: { flex: 1, minWidth: 190 },
  pickTitle: { fontSize: 16, fontWeight: '700' },
  pickHint: { fontSize: 12, lineHeight: 18, marginTop: 5 },
  pickButton: {
    alignItems: 'center',
    borderRadius: 16,
    minWidth: 126,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  pickButtonDisabled: { opacity: 0.58 },
  pickButtonText: { fontSize: 14, fontWeight: '700' },
  automaticRow: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12 },
  automaticLabel: { fontSize: 13, fontWeight: '600' },
  abandonAction: { alignSelf: 'flex-start', marginTop: 10, paddingVertical: 4 },
  abandonActionText: { fontSize: 12 },
  status: { fontSize: 12, lineHeight: 18, marginTop: 10 },
  archiveTitle: { fontSize: 19, fontWeight: '700', marginBottom: 10, marginTop: 24 },
  archiveDateButton: {
    alignItems: 'center',
    borderRadius: 18,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 9,
    minHeight: 62,
    paddingHorizontal: 16,
    paddingVertical: 11,
  },
  archiveDateText: { fontSize: 15, fontWeight: '700' },
  archiveDateCount: { fontSize: 11, marginTop: 4 },
  archiveDateChevron: { fontSize: 24, marginLeft: 12 },
  entryCard: {
    borderRadius: 20,
    borderWidth: 1,
    marginBottom: 11,
    padding: 16,
  },
  deliveryCard: { borderLeftWidth: 2 },
  category: {
    alignSelf: 'flex-start',
    borderRadius: 12,
    fontSize: 12,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 4,
  },
  entryBody: { fontSize: 16, lineHeight: 24, marginTop: 13 },
  entryActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 15 },
  secondaryAction: { borderRadius: 14, paddingHorizontal: 12, paddingVertical: 8 },
  secondaryActionText: { fontSize: 12, fontWeight: '600' },
  rejectAction: { borderRadius: 14, paddingHorizontal: 8, paddingVertical: 8 },
  rejectActionText: { fontSize: 12 },
  loadMoreButton: {
    alignItems: 'center',
    borderRadius: 16,
    marginTop: 3,
    paddingHorizontal: 16,
    paddingVertical: 13,
  },
  loadMoreText: { fontSize: 13, fontWeight: '600' },
  emptyText: {
    borderRadius: 18,
    fontSize: 14,
    marginBottom: 9,
    padding: 18,
    textAlign: 'center',
  },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  modalBackdrop: { ...StyleSheet.absoluteFillObject },
  sourceSheet: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    maxHeight: '76%',
    paddingHorizontal: 18,
    paddingTop: 10,
  },
  sheetHandle: {
    alignSelf: 'center',
    borderRadius: 2,
    height: 4,
    marginBottom: 12,
    width: 42,
  },
  sheetHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  sheetTitle: { fontSize: 20, fontWeight: '700' },
  closeButton: { paddingHorizontal: 4, paddingVertical: 6 },
  closeText: { fontSize: 14 },
  sourceCard: { borderRadius: 18, marginBottom: 10, padding: 14 },
  sourceHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  sourceRole: { fontSize: 13, fontWeight: '700' },
  sourceTime: { fontSize: 11 },
  sourceText: { fontSize: 14, lineHeight: 22, marginTop: 9 },
});
