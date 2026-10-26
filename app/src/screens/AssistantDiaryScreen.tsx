
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Linking, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import {
  loadBaiyunIntimacySafetySettings,
  saveBaiyunIntimacySafetySettings,
} from '../ai/behavior/actionBehaviorStore';
import type { BaiyunContinuityEvent } from '../ai/behavior/continuityEvent';
import {
  cancelBaiyunContinuityEvent,
  clearBaiyunContinuityAcceptanceEvents,
  createBaiyunContinuityAcceptanceEvents,
  forceBaiyunContinuityAcceptanceEventsDue,
} from '../ai/behavior/continuityLedger';
import { loadBaiyunContinuityEventsWithoutAdvancing } from '../ai/behavior/continuityLedgerAdapter';
import {
  loadBaiyunShareResponsePresentation,
} from '../ai/behavior/actionShareResponseStore';
import type { BaiyunPendingShareExchange } from '../ai/behavior/actionShareResponse';
import {
  presentBaiyunContinuityEvent,
} from '../ai/behavior/continuityLedgerPresentation';
import {
  loadAssistantLifeGenerationDiagnostics,
  type AssistantLifeGenerationDiagnostic,
} from '../ai/assistantLifeGenerationDiagnostics';
import {
  loadAssistantStatePersistenceDiagnostic,
  type AssistantStatePersistenceDiagnostic,
} from '../ai/assistantStatePersistenceDiagnostics';
import { refreshAssistantLifeState } from '../ai/assistantLife';
import { buildLifeMaterialSnapshot, type LifeMaterialSnapshot } from '../ai/lifeMaterialHub';
import {
  getLocalDateKey,
  loadAssistantLifeDay,
  type AssistantLifeDay,
} from '../ai/assistantLifeTimeline';
import { AssistantLifeMaterialDiagnosticsCard } from './AssistantLifeMaterialDiagnosticsCard';
import { AssistantDiaryContinuityReviewSection } from './AssistantDiaryContinuityReviewSection';
import { AssistantDiaryContinuitySource } from './AssistantDiaryContinuitySource';
import { loadContinuitySourceMessages, type ContinuitySourceMessages } from '../ai/behavior/continuitySourceMessages';
import { JunluoInnerStateDiaryCard } from './JunluoInnerStateDiaryCard';
import { JunluoThoughtDiaryCard } from './JunluoThoughtDiaryCard';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { BaiyunContinuityContextSummaryCard } from '../memory/BaiyunContinuityContextSummaryCard';
import type { JunluoThoughtStateV2 } from '../life/junluoInnerState';
import { loadJunluoThoughtState } from '../life/junluoInnerStateStore';
import { loadWebVoyageLog, type WebVoyageLogEntry } from '../life/webVoyage';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type Props = {
  navigate: Navigate;
};

function formatClock(time: number) {
  return new Date(time).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function formatFullLocalDateTime(time: number) {
  const date = new Date(time);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-') + ` ${formatClock(time)}`;
}

function formatLogTimestamp(timestamp?: number) {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '生成时间未知';
  const date = new Date(timestamp);
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const datePart = date.toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  const timePart = date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `生成于 ${datePart} ${timePart}`;
}


function webVoyageStatusLabel(entry: WebVoyageLogEntry) {
  if (entry.status === 'skipped' && entry.stage === 'waiting') return '未出门';
  if (entry.status === 'skipped' && entry.stage === 'query') return '未形成';
  switch (entry.status) {
    case 'completed': return '完成';
    case 'skipped': return '跳过';
    case 'blocked': return '被挡住';
    case 'failed': return '失败';
    case 'searching': return '搜索中';
    default: return status;
  }
}

function webVoyageStageLabel(entry: WebVoyageLogEntry) {
  if (entry.sourceType === 'github') {
    switch (entry.stage) {
      case 'waiting': return '还没去 GitHub';
      case 'query': return '挑开发者街区';
      case 'search': return '搜索 GitHub 仓库';
      case 'fetch': return '读取 README';
      case 'summarize': return '整理项目见闻';
      case 'completed': return '逛街回来';
      default: return 'GitHub 逛街';
    }
  }
  switch (entry.stage) {
    case 'waiting': return '没有出门';
    case 'query': return '生成搜索词';
    case 'search': return '搜索公开网页';
    case 'fetch': return '读取页面';
    case 'summarize': return '整理摘要';
    case 'completed': return '完成远游';
    default: return '公开网页远游';
  }
}
function webVoyageShareStatusLabel(entry: WebVoyageLogEntry) {
  if (entry.shareStatus === 'delivered') return '已回来';
  if (entry.shareStatus === 'failed') return '等下次回来';
  if (entry.shareStatus === 'pending') return '等待回来';
  return '';
}

function webVoyageFetchModeLabel(entry: WebVoyageLogEntry) {
  if (entry.fetchMode === 'browser') return '浏览器兜底';
  if (entry.fetchMode === 'http') return '普通读取';
  return '';
}

function webVoyageEvidenceLabel(entry: WebVoyageLogEntry) {
  if (!entry.evidenceStatus) return '';
  if (entry.evidenceStatus === 'completed') {
    return `考证：${entry.evidenceVerdict || '未知'} · ${entry.evidenceConfidence || 'unknown'}`;
  }
  if (entry.evidenceStatus === 'skipped') return '考证：未进行';
  if (entry.evidenceStatus === 'failed') return '考证：失败';
  return `考证：${entry.evidenceStatus}`;
}

function webVoyageEvidenceSummaryText(entry: WebVoyageLogEntry) {
  const summary = entry.evidenceSummary?.trim();
  if (!summary) return '';
  if (
    entry.evidenceVerdict === 'insufficient_evidence' ||
    entry.evidenceConfidence === 'low' ||
    /Evidence report|Used \d+ source|provider\(s\)|domain\(s\)|Snippet-only|Configure .*SearXNG/i.test(summary)
  ) {
    return '证据不足：没有拿到足够独立来源交叉验证；这次只作为网页见闻，不当成定论。';
  }
  return summary;
}

function webVoyageEvidenceWarningsText(entry: WebVoyageLogEntry) {
  const warnings = entry.evidenceWarnings ?? [];
  if (!warnings.length) return '';
  const localized = warnings.map((warning) => {
    if (/backend_unavailable/.test(warning)) return '电脑后端不可用';
    if (/Snippet-only/i.test(warning)) return '只基于搜索摘要';
    if (/Low domain diversity|second independent domain/i.test(warning)) return '缺少第二个独立来源';
    if (/Only 0 source|Used 0 source|0 provider|0 domain/i.test(warning)) return '没有拿到可验证来源';
    if (/Configure .*SearXNG|Bright Data|provider/i.test(warning)) return '可配置更多后端来源增强考证';
    return warning;
  });
  return Array.from(new Set(localized)).slice(0, 3).join(' · ');
}

function shouldShowWebVoyageLogEntry(entry: WebVoyageLogEntry) {
  if (entry.status !== 'skipped' || entry.stage !== 'waiting') return true;
  return entry.failureReason !== 'daily-cap' &&
    entry.failureReason !== 'cooldown' &&
    entry.failureReason !== 'failure-stop';
}

export function AssistantDiaryScreen({ navigate }: Props) {
  const { chatConnection, chatKey, lifeCreativeConnection, lifeCreativeKey, profile } = useAiConfigPreferences();
  const lifeCreativeConnectionForUse = lifeCreativeConnection ?? chatConnection;
  const lifeCreativeKeyForUse = lifeCreativeConnection ? lifeCreativeKey : chatKey;
  const insets = useSafeAreaInsets();
  const [diaryDateKey, setDiaryDateKey] = useState(getLocalDateKey());
  const [day, setDay] = useState<AssistantLifeDay | null>(null);
  const [thoughtState, setThoughtState] = useState<JunluoThoughtStateV2 | null>(null);
  const [webVoyageLog, setWebVoyageLog] = useState<WebVoyageLogEntry[]>([]);
  const [lifeMaterialSnapshot, setLifeMaterialSnapshot] = useState<LifeMaterialSnapshot | null>(null);
  const [generationDiagnostics, setGenerationDiagnostics] = useState<AssistantLifeGenerationDiagnostic[]>([]);
  const [persistenceDiagnostic, setPersistenceDiagnostic] = useState<AssistantStatePersistenceDiagnostic | null>(null);
  const [isMaterialRefreshing, setIsMaterialRefreshing] = useState(false);
  const [shareExchanges, setShareExchanges] = useState<{
    active: BaiyunPendingShareExchange[];
    recentEnded: BaiyunPendingShareExchange[];
  }>({ active: [], recentEnded: [] });
  const [continuityEvents, setContinuityEvents] = useState<BaiyunContinuityEvent[]>([]);
  const [continuitySources, setContinuitySources] = useState<Record<string, ContinuitySourceMessages>>({});
  const [intimacySafeWordDraft, setIntimacySafeWordDraft] = useState('');
  const [savedIntimacySafeWord, setSavedIntimacySafeWord] = useState('');
  const [intimacySafetyNotice, setIntimacySafetyNotice] = useState('');
  const [isSavingIntimacySafety, setIsSavingIntimacySafety] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isContinuityActionRunning, setIsContinuityActionRunning] = useState(false);
  const [innerStateRefreshVersion, setInnerStateRefreshVersion] = useState(0);
  const continuityLoadGenerationRef = useRef(0);
  const continuityMountedRef = useRef(true);
  const observedTodayRef = useRef(getLocalDateKey());

  useEffect(() => {
    continuityMountedRef.current = true;
    return () => {
      continuityMountedRef.current = false;
      continuityLoadGenerationRef.current += 1;
    };
  }, []);

  const refreshContinuityEvents = useCallback(async () => {
    if (!continuityMountedRef.current) return [];
    const generation = ++continuityLoadGenerationRef.current;
    const events = await loadBaiyunContinuityEventsWithoutAdvancing();
    if (generation !== continuityLoadGenerationRef.current) return events;
    setContinuityEvents(events);
    setContinuitySources({});
    const sources = await loadContinuitySourceMessages(events);
    if (generation === continuityLoadGenerationRef.current) {
      setContinuitySources(sources);
    }
    return events;
  }, []);

  const loadLocalDiary = useCallback(async () => {
    const [
      nextDay,
      nextThoughtState,
      nextWebVoyageLog,
      nextLifeMaterialSnapshot,
      nextGenerationDiagnostics,
      nextPersistenceDiagnostic,
      nextShareExchanges,
    ] = await Promise.all([
      loadAssistantLifeDay(diaryDateKey),
      loadJunluoThoughtState(),
      loadWebVoyageLog(),
      buildLifeMaterialSnapshot(),
      loadAssistantLifeGenerationDiagnostics(),
      loadAssistantStatePersistenceDiagnostic(),
      loadBaiyunShareResponsePresentation(),
    ]);
    setDay(nextDay);
    setThoughtState(nextThoughtState);
    setWebVoyageLog(nextWebVoyageLog);
    setLifeMaterialSnapshot(nextLifeMaterialSnapshot);
    setGenerationDiagnostics(nextGenerationDiagnostics);
    setPersistenceDiagnostic(nextPersistenceDiagnostic);
    setShareExchanges(nextShareExchanges);
    setInnerStateRefreshVersion((current) => current + 1);
    void refreshContinuityEvents().catch(() => undefined);
  }, [diaryDateKey, refreshContinuityEvents]);

  const reload = useCallback(
    async () => {
      setIsRefreshing(true);
      await loadLocalDiary()
        .finally(() => setIsRefreshing(false));
      void refreshAssistantLifeState({ apiKey: lifeCreativeKeyForUse, connection: lifeCreativeConnectionForUse, profile })
        .then(() => loadLocalDiary())
        .catch(() => undefined);
    },
    [lifeCreativeConnectionForUse, lifeCreativeKeyForUse, loadLocalDiary, profile],
  );

  const refreshLifeMaterialDiagnostics = useCallback(async () => {
    if (isMaterialRefreshing) return;
    setIsMaterialRefreshing(true);
    try {
      const [nextSnapshot, nextDiagnostics, nextPersistenceDiagnostic] = await Promise.all([
        buildLifeMaterialSnapshot(),
        loadAssistantLifeGenerationDiagnostics(),
        loadAssistantStatePersistenceDiagnostic(),
      ]);
      setLifeMaterialSnapshot(nextSnapshot);
      setGenerationDiagnostics(nextDiagnostics);
      setPersistenceDiagnostic(nextPersistenceDiagnostic);
    } finally {
      setIsMaterialRefreshing(false);
    }
  }, [isMaterialRefreshing]);

  const openProjectSource = useCallback(async (url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    if (await Linking.canOpenURL(url)) await Linking.openURL(url);
  }, []);

  const saveIntimacySafety = useCallback(async () => {
    if (isSavingIntimacySafety) return;
    setIsSavingIntimacySafety(true);
    try {
      const saved = await saveBaiyunIntimacySafetySettings({ safeWord: intimacySafeWordDraft });
      setIntimacySafeWordDraft(saved.safeWord);
      setSavedIntimacySafeWord(saved.safeWord);
      setIntimacySafetyNotice(saved.safeWord ? '安全词已保存在本机。' : '安全词已清空。');
    } catch {
      setIntimacySafetyNotice('安全词保存失败，本次没有写入。');
    } finally {
      setIsSavingIntimacySafety(false);
    }
  }, [intimacySafeWordDraft, isSavingIntimacySafety]);

  const cancelContinuityEvent = useCallback((event: BaiyunContinuityEvent) => {
    Alert.alert(
      '取消这一次？',
      event.schemaVersion === 3 && event.careEvidence
        ? '这会删除这件聊天牵挂及其关联记录，两个栏目一起撤下；原聊天和其他牵挂保留。'
        : '只会把这一次事件标为被取消，不会取消长期关系，也不会影响其他牵挂。',
      [
        { text: '返回', style: 'cancel' },
        {
          text: '取消这一次',
          style: 'destructive',
          onPress: () => {
            void cancelBaiyunContinuityEvent({
              eventId: event.id,
              expectedRevision: event.revision,
              reasonCode: 'cancelled_from_baiyun_diary',
            })
              .then(async () => {
                await loadLocalDiary();
              })
              .catch(() => Alert.alert('取消失败', '这一次牵挂没有被改动，请刷新后再试。'));
          },
        },
      ],
    );
  }, [loadLocalDiary]);

  const correctFalseRelationshipHurt = useCallback(async (event: BaiyunContinuityEvent) => {
    if (isContinuityActionRunning) return;
    setIsContinuityActionRunning(true);
    try {
      await cancelBaiyunContinuityEvent({
        eventId: event.id,
        expectedRevision: event.revision,
        reasonCode: 'user_corrected_false_relationship_hurt',
      });
      await loadLocalDiary();
    } catch {
      Alert.alert('纠正失败', '这条关系受伤记录没有被改动，请刷新后再试。');
    } finally {
      setIsContinuityActionRunning(false);
    }
  }, [isContinuityActionRunning, loadLocalDiary]);

  const runContinuityAcceptanceAction = useCallback(async (
    action: 'create' | 'due' | 'clear',
  ) => {
    if (isContinuityActionRunning) return;
    setIsContinuityActionRunning(true);
    try {
      if (action === 'create') await createBaiyunContinuityAcceptanceEvents();
      else if (action === 'due') await forceBaiyunContinuityAcceptanceEventsDue();
      else await clearBaiyunContinuityAcceptanceEvents();
      await refreshContinuityEvents();
    } catch {
      Alert.alert('账本验收操作失败', '本次开发验收操作没有完成，请刷新后再试。');
    } finally {
      setIsContinuityActionRunning(false);
    }
  }, [isContinuityActionRunning, refreshContinuityEvents]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    const syncLocalDate = () => {
      const today = getLocalDateKey();
      if (today === observedTodayRef.current) return;
      observedTodayRef.current = today;
      setDiaryDateKey(today);
    };
    const scheduleMidnightSync = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 1, 0);
      midnightTimer = setTimeout(() => {
        syncLocalDate();
        scheduleMidnightSync();
      }, Math.max(1_000, nextMidnight.getTime() - Date.now()));
    };
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') syncLocalDate();
    });
    syncLocalDate();
    scheduleMidnightSync();
    return () => {
      if (midnightTimer) clearTimeout(midnightTimer);
      appStateSubscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;
    void loadBaiyunIntimacySafetySettings().then((settings) => {
      if (!active) return;
      setIntimacySafeWordDraft(settings.safeWord);
      setSavedIntimacySafeWord(settings.safeWord);
    });
    return () => {
      active = false;
    };
  }, []);

  const visibleWebVoyageLog = webVoyageLog.filter(shouldShowWebVoyageLogEntry).slice(0, 3);
  return (
    <View style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <Pressable onPress={() => navigate('home')} style={styles.backButton}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerCopy}>
          <Text style={styles.title}>白云日记</Text>
        </View>
        <Pressable disabled={isRefreshing} onPress={() => void reload()} style={styles.refreshButton}>
          <Text style={styles.refreshText}>{isRefreshing ? '刷新中' : '刷新'}</Text>
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 72, 96) }]}
        showsVerticalScrollIndicator={false}
      >
        <JunluoInnerStateDiaryCard refreshVersion={innerStateRefreshVersion} />

        <AssistantLifeMaterialDiagnosticsCard
          connection={lifeCreativeConnectionForUse ?? undefined}
          day={day}
          diagnostics={generationDiagnostics}
          isRefreshing={isMaterialRefreshing}
          onRefresh={() => void refreshLifeMaterialDiagnostics()}
          persistenceDiagnostic={persistenceDiagnostic}
          profile={profile}
          snapshot={lifeMaterialSnapshot}
        />

        <View style={styles.continuityLedgerCard}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.sectionTitle}>分享与回应</Text>
              <Text style={styles.continuityLedgerCount}>{shareExchanges.active.length}</Text>
            </View>
            <Text style={styles.continuityLedgerHint}>
              这里记的是白云已经分享、正在等回应的内容，不是小仓鼠的待办。
            </Text>
            {[...shareExchanges.active, ...shareExchanges.recentEnded].map((exchange) => (
              <View key={exchange.id} style={styles.continuityEventCard}>
                <Text style={styles.continuityEventKind} numberOfLines={3}>
                  {exchange.excerpt || '这次分享没有保存摘录'}
                </Text>
                <View style={styles.shareExchangeFooter}>
                  <Text style={styles.continuityEventMeta}>
                    {formatClock(exchange.resolvedAt ?? exchange.createdAt)}
                  </Text>
                  <Text style={styles.continuityEventStatus}>
                    {exchange.state === 'waiting'
                      ? '已分享·等你回应'
                      : exchange.state === 'engaged'
                        ? '被回应啦'
                        : '这次没等到回应'}
                  </Text>
                </View>
              </View>
            ))}
            {!shareExchanges.active.length && !shareExchanges.recentEnded.length ? (
              <Text style={styles.continuityLedgerEmpty}>现在没有分享回应记录。</Text>
            ) : null}
        </View>

        {(
          <View style={styles.continuityLedgerCard}>
            <View style={styles.cardTitleRow}>
              <Text style={styles.sectionTitle}>还没做完的牵挂</Text>
              <Text style={styles.continuityLedgerCount}>{continuityEvents.length}</Text>
            </View>
            <Text style={styles.continuityLedgerHint}>这里记的是仍要继续的事，不是聊天记录。</Text>
            {continuityEvents.length ? continuityEvents.map((event) => {
              const presentation = presentBaiyunContinuityEvent(event);
              return (
                <View key={event.id} style={styles.continuityEventCard}>
                  <View style={styles.continuityEventHeader}>
                    <View style={styles.currentActionCopy}>
                      <Text style={styles.continuityEventKind}>
                        {presentation.kindLabel}｜{presentation.sourceLabel}{presentation.itemName ? `｜${presentation.itemName}` : ''}
                      </Text>
                      <Text style={styles.continuityEventStage}>{presentation.stageLabel}</Text>
                    </View>
                    <Text style={styles.continuityEventStatus}>{presentation.statusLabel}</Text>
                  </View>
                  {presentation.focusExcerpt ? (
                    <Text style={styles.continuityEventFocus} numberOfLines={2}>
                      {presentation.focusExcerpt}
                    </Text>
                  ) : null}
                  <View style={styles.continuityEventMetaRow}>
                    <Text style={styles.continuityEventMeta}>
                      建立于 {formatFullLocalDateTime(presentation.openedAt)}
                    </Text>
                    <Text style={styles.continuityEventMeta}>
                      最近更新 {formatFullLocalDateTime(presentation.updatedAt)}
                    </Text>
                    {presentation.nextActionLabel ? (
                      <Text style={styles.continuityEventMeta}>
                        继续时间 {presentation.nextActionLabel}
                      </Text>
                    ) : null}
                  </View>
                  <AssistantDiaryContinuitySource source={continuitySources[event.id]} />
                  <BaiyunContinuityContextSummaryCard eventId={event.id} />
                  {event.kind === 'relationship_rupture' ? (
                    <Pressable
                      disabled={isContinuityActionRunning}
                      onPress={() => void correctFalseRelationshipHurt(event)}
                      style={({ pressed }) => [
                        styles.continuityCorrectionButton,
                        pressed && styles.continuityCancelButtonPressed,
                      ]}
                    >
                      <Text style={styles.continuityCorrectionText}>这不是关系受伤</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    onPress={() => cancelContinuityEvent(event)}
                    style={({ pressed }) => [
                      styles.continuityCancelButton,
                      pressed && styles.continuityCancelButtonPressed,
                    ]}
                  >
                    <Text style={styles.continuityCancelText}>取消这一次</Text>
                  </Pressable>
                </View>
              );
            }) : (
              <Text style={styles.continuityLedgerEmpty}>现在没有没做完的牵挂。</Text>
            )}
            {__DEV__ ? (
              <View style={styles.continuityDevTools}>
                <Text style={styles.continuityDevTitle}>开发验收</Text>
                <View style={styles.continuityDevActions}>
                  <Pressable
                    disabled={isContinuityActionRunning}
                    onPress={() => void runContinuityAcceptanceAction('create')}
                    style={styles.continuityDevButton}
                  >
                    <Text style={styles.continuityDevButtonText}>生成账本验收记录</Text>
                  </Pressable>
                  <Pressable
                    disabled={isContinuityActionRunning}
                    onPress={() => void runContinuityAcceptanceAction('due')}
                    style={styles.continuityDevButton}
                  >
                    <Text style={styles.continuityDevButtonText}>让等待事件到期</Text>
                  </Pressable>
                  <Pressable
                    disabled={isContinuityActionRunning}
                    onPress={() => void runContinuityAcceptanceAction('clear')}
                    style={styles.continuityDevButton}
                  >
                    <Text style={styles.continuityDevButtonText}>清理验收记录</Text>
                  </Pressable>
                </View>
                {isContinuityActionRunning ? (
                  <Text style={styles.continuityEventMeta}>账本处理中…</Text>
                ) : null}
              </View>
            ) : null}
          </View>
        )}

        <AssistantDiaryContinuityReviewSection
          events={continuityEvents}
          sources={continuitySources}
          onChanged={async () => {
            await refreshContinuityEvents();
          }}
          showManualCompletion
        />

        <View style={styles.intimacySafetyCard}>
          <View style={styles.cardTitleRow}>
            <Text style={styles.sectionTitle}>亲密互动安全词</Text>
            <Text style={[
              styles.intimacySafetyBadge,
              Boolean(savedIntimacySafeWord) && styles.intimacySafetyBadgeConfigured,
            ]}
            >
              {savedIntimacySafeWord ? '已设置' : '暂未设置'}
            </Text>
          </View>
          <Text style={styles.intimacySafetyDescription}>
            安全词用来明确结束正在进行的亲密拉扯。普通阻拦会结合完整语境理解；说出安全词时，只能按真正停止处理。
          </Text>
          <View style={styles.intimacySafetyInputRow}>
            <TextInput
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={24}
              onChangeText={(value) => {
                setIntimacySafeWordDraft(value);
                setIntimacySafetyNotice('');
              }}
              placeholder="由仓鼠自己设置"
              placeholderTextColor="#A998B2"
              style={styles.intimacySafetyInput}
              value={intimacySafeWordDraft}
            />
            <Pressable
              disabled={isSavingIntimacySafety}
              onPress={() => void saveIntimacySafety()}
              style={({ pressed }) => [
                styles.intimacySafetySaveButton,
                pressed && styles.intimacySafetySaveButtonPressed,
                isSavingIntimacySafety && styles.intimacySafetySaveButtonDisabled,
              ]}
            >
              <Text style={styles.intimacySafetySaveText}>
                {isSavingIntimacySafety ? '保存中' : '保存'}
              </Text>
            </Pressable>
          </View>
          <Text style={styles.intimacySafetyLocalHint}>
            只保存在本机；留空后保存即可清除。
          </Text>
          {intimacySafetyNotice ? (
            <Text style={styles.intimacySafetyNotice}>{intimacySafetyNotice}</Text>
          ) : null}
          <View style={styles.intimacySafetyWiringBox}>
            <Text style={styles.intimacySafetyWiringTitle}>当前接线状态</Text>
            <Text style={styles.intimacySafetyWiringText}>
              第三章现在只保存这项约定，尚未接入聊天与设备执行。后续接线要单独验收；未设置安全词时，真实设备亲密互动不得启动。
            </Text>
          </View>
        </View>

        <JunluoThoughtDiaryCard state={thoughtState} />

        <View style={styles.webVoyageCard}>
            <Text style={styles.sectionTitle}>她带回的远方</Text>
            {visibleWebVoyageLog.length ? visibleWebVoyageLog.map((entry) => (
              <View key={entry.id} style={styles.webVoyageRow}>
                <View style={styles.socialMetaRow}>
                  <Text style={styles.webVoyageQuery}>{entry.query ? `${entry.sourceType === 'github' ? 'GitHub' : '公开网页'} · ${entry.query}` : (entry.sourceType === 'github' ? 'GitHub 逛街' : '公开网页远游')}</Text>
                  <Text style={[styles.socialStatus, entry.status === 'blocked' && styles.socialStatusBlocked]}>
                    {webVoyageStatusLabel(entry)}
                  </Text>
                </View>
                <Text style={styles.socialTime}>{formatLogTimestamp(entry.at)}</Text>
                {webVoyageShareStatusLabel(entry) ? (
                  <Text style={[
                    styles.webVoyageShareStatus,
                    entry.shareStatus === 'delivered' && styles.webVoyageShareDelivered,
                    entry.shareStatus === 'failed' && styles.webVoyageFailure,
                  ]}>
                    {webVoyageShareStatusLabel(entry)}
                    {entry.sharedAt ? ` · ${formatLogTimestamp(entry.sharedAt)}` : ''}
                  </Text>
                ) : null}
                <Text style={styles.webVoyageStage}>
                  {webVoyageStageLabel(entry)}
                  {entry.driveLabel ? ` · ${entry.driveLabel}` : ''}
                  {entry.providerLabel ? ` · 来源：${entry.providerLabel}` : ''}
                  {webVoyageFetchModeLabel(entry) ? ` · 读取：${webVoyageFetchModeLabel(entry)}` : ''}
                </Text>
                <Text style={styles.socialReason}>{entry.title ?? entry.failureReason ?? entry.reason}</Text>
                {entry.summary ? (
                  <Text style={styles.socialDetail}>{entry.summary}</Text>
                ) : (
                  <Text style={styles.socialDetail}>{entry.detail}</Text>
                )}
                {webVoyageEvidenceLabel(entry) ? (
                  <Text style={[
                    styles.webVoyageEvidence,
                    entry.evidenceStatus !== 'completed' && styles.webVoyageEvidenceMuted,
                  ]}>
                    {webVoyageEvidenceLabel(entry)}
                  </Text>
                ) : null}
                {webVoyageEvidenceSummaryText(entry) ? (
                  <Text style={styles.webVoyageEvidenceText}>{webVoyageEvidenceSummaryText(entry)}</Text>
                ) : null}
                {webVoyageEvidenceWarningsText(entry) ? (
                  <Text style={styles.webVoyageEvidenceText}>提示：{webVoyageEvidenceWarningsText(entry)}</Text>
                ) : null}
                {entry.failureReason ? (
                  <Text style={styles.webVoyageFailure}>原因：{entry.failureReason}</Text>
                ) : null}
                {entry.shareError ? (
                  <Text style={styles.webVoyageFailure}>回来受阻：{entry.shareError}</Text>
                ) : null}
                {entry.url ? (
                  <Pressable onPress={() => void openProjectSource(entry.url!)}>
                    <Text style={styles.webVoyageUrl} numberOfLines={1}>{entry.url}</Text>
                  </Pressable>
                ) : null}
              </View>
            )) : (
              <Text style={styles.emptyInline}>她还没有从公开网页或 GitHub 带回新的远方。</Text>
            )}
        </View>

        {day?.deviations.length ? (
          <View style={styles.deviationCard}>
            <Text style={styles.sectionTitle}>今天的小偏移</Text>
            {day.deviations.map((deviation) => (
              <Text key={deviation.id} style={styles.deviationText}>
                {formatClock(deviation.startsAt)}-{formatClock(deviation.endsAt)} · {deviation.description}
              </Text>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#F6F0FF',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  backButton: {
    alignItems: 'center',
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  backText: {
    color: colors.ink,
    fontSize: 38,
    lineHeight: 40,
  },
  headerCopy: {
    flex: 1,
  },
  title: {
    color: colors.ink,
    fontSize: 24,

    fontWeight: '700',
    lineHeight: 30,
  },
  refreshButton: {
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.72)',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  refreshText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '500',
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 34,
  },
  currentActionCopy: {
    flex: 1,
  },
  actionContinuityBox: {
    borderTopColor: 'rgba(62,116,119,0.18)',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 13,
    paddingTop: 10,
  },
  actionContinuityTitle: {
    color: '#4A7477',
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 4,
  },
  actionContinuityText: {
    color: '#637F82',
    fontSize: 11,
    lineHeight: 17,
  },
  actionContinuityEmpty: {
    color: '#789294',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 11,
  },
  continuityLedgerCard: {
    backgroundColor: 'rgba(255, 247, 238, 0.9)',
    borderColor: '#F1CDBF',
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,
  },
  continuityLedgerCount: {
    backgroundColor: '#FFE1D4',
    borderRadius: 12,
    color: '#8B584D',
    fontSize: 11,
    fontWeight: '800',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  continuityLedgerHint: {
    color: '#8F756E',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 10,
  },
  continuityEventCard: {
    backgroundColor: 'rgba(255,255,255,0.76)',
    borderColor: '#F0D8CE',
    borderRadius: 18,
    borderWidth: 1,
    marginTop: 8,
    padding: 13,
  },
  continuityEventHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    gap: 10,
  },
  continuityEventKind: {
    color: '#6F4F48',
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 21,
  },
  continuityEventStage: {
    color: '#8A6D66',
    fontSize: 12,
    lineHeight: 18,
    marginTop: 3,
  },
  continuityEventFocus: {
    color: '#6F5B56',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
  continuityEventStatus: {
    backgroundColor: '#FFE8DC',
    borderRadius: 11,
    color: '#9A5E50',
    fontSize: 10,
    fontWeight: '600',
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 5,
  },
  shareExchangeFooter: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 8,
  },
  continuityEventMetaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 8,
  },
  continuityEventMeta: {
    color: '#A0837C',
    fontSize: 10,
    lineHeight: 15,
  },
  continuityCancelButton: {
    alignSelf: 'flex-start',
    borderColor: '#EAC8BC',
    borderRadius: 12,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  continuityCorrectionButton: {
    alignItems: 'center',
    borderColor: colors.secondary,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 9,
  },
  continuityCorrectionText: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '600',
  },
  continuityCancelButtonPressed: {
    backgroundColor: '#FFE8E0',
  },
  continuityCancelText: {
    color: '#98665B',
    fontSize: 11,
    fontWeight: '700',
  },
  continuityLedgerEmpty: {
    color: '#9B817A',
    fontSize: 12,
    lineHeight: 18,
    paddingVertical: 8,
  },
  continuityDevTools: {
    borderTopColor: '#EBCFC5',
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: 14,
    paddingTop: 12,
  },
  continuityDevTitle: {
    color: '#9C7C73',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1,
    marginBottom: 8,
  },
  continuityDevActions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
  },
  continuityDevButton: {
    backgroundColor: '#F8E8E1',
    borderRadius: 12,
    paddingHorizontal: 9,
    paddingVertical: 7,
  },
  continuityDevButtonText: {
    color: '#835E55',
    fontSize: 10,
    fontWeight: '700',
  },
  intimacySafetyCard: {
    backgroundColor: 'rgba(255, 247, 251, 0.84)',
    borderColor: '#EBC7D7',
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,
  },
  intimacySafetyBadge: {
    backgroundColor: '#F3E6EC',
    borderRadius: 12,
    color: '#8A6E7B',
    fontSize: 11,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  intimacySafetyBadgeConfigured: {
    backgroundColor: '#F7D9E5',
    color: '#9A536E',
  },
  intimacySafetyDescription: {
    color: '#765F6B',
    fontSize: 12,
    lineHeight: 19,
    marginTop: 9,
  },
  intimacySafetyInputRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    marginTop: 13,
  },
  intimacySafetyInput: {
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderColor: '#E8CCD8',
    borderRadius: 14,
    borderWidth: 1,
    color: colors.ink,
    flex: 1,
    fontSize: 14,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  intimacySafetySaveButton: {
    alignItems: 'center',
    backgroundColor: '#EBAEC4',
    borderRadius: 14,
    justifyContent: 'center',
    minHeight: 44,
    paddingHorizontal: 15,
  },
  intimacySafetySaveButtonPressed: {
    opacity: 0.82,
  },
  intimacySafetySaveButtonDisabled: {
    opacity: 0.58,
  },
  intimacySafetySaveText: {
    color: '#713D51',
    fontSize: 13,
    fontWeight: '800',
  },
  intimacySafetyLocalHint: {
    color: '#9A808C',
    fontSize: 10,
    lineHeight: 15,
    marginTop: 6,
  },
  intimacySafetyNotice: {
    color: '#9A536E',
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 17,
    marginTop: 7,
  },
  intimacySafetyWiringBox: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderRadius: 13,
    marginTop: 11,
    paddingHorizontal: 11,
    paddingVertical: 9,
  },
  intimacySafetyWiringTitle: {
    color: '#8C5268',
    fontSize: 11,
    fontWeight: '800',
  },
  intimacySafetyWiringText: {
    color: '#806A74',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 3,
  },
  desireCard: {
    backgroundColor: 'rgba(255,255,255,0.76)',
    borderColor: '#DCD7F5',
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,

  },
  socialCard: {
    backgroundColor: 'rgba(246, 252, 255, 0.78)',
    borderColor: '#CDE5F0',
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,
  },
  webVoyageCard: {
    backgroundColor: 'rgba(245, 251, 246, 0.8)',
    borderColor: '#CFE8D4',
    borderRadius: 24,
    borderWidth: 1,
    marginTop: 14,
    padding: 18,
  },
  cardTitleRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
  },
  intentReason: {
    color: colors.ink,
    fontSize: 15,
    fontWeight: '500',
    lineHeight: 22,
    marginBottom: 14,
  },
  driveList: {
    gap: 9,
  },
  selfDriveBox: {
    backgroundColor: 'rgba(255,255,255,0.62)',
    borderRadius: 16,
    marginBottom: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  selfDriveTitle: {
    color: '#7C5B9F',
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
    marginBottom: 3,
  },
  selfDriveText: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '500',
    lineHeight: 18,
  },
  driveRow: {
    gap: 6,
  },
  driveHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  driveLabel: {
    color: colors.ink,
    fontSize: 12,
    fontWeight: '600',
  },
  driveValue: {
    color: colors.muted,
    fontSize: 11,
    fontWeight: '500',
  },
  driveTrack: {
    backgroundColor: '#EEF2FA',
    borderRadius: 6,
    height: 10,
    overflow: 'hidden',
  },
  driveBaseMark: {
    backgroundColor: 'rgba(56,64,82,0.52)',
    bottom: 0,
    position: 'absolute',
    top: 0,
    width: 2,
  },
  driveFill: {
    backgroundColor: '#D989AE',
    borderRadius: 6,
    height: 10,
  },
  thoughtTitle: {
    color: colors.ink,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 20,
    marginTop: 16,
    marginBottom: 8,
  },
  thoughtRow: {
    alignItems: 'center',
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 8,
  },
  thoughtKind: {
    backgroundColor: '#F0E9FF',
    borderRadius: 9,
    color: '#7C5B9F',
    fontSize: 10,
    fontWeight: '600',
    overflow: 'hidden',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  thoughtText: {
    color: colors.ink,
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 17,
  },
  thoughtStrength: {
    color: colors.muted,
    fontSize: 10,
    fontWeight: '500',
  },
  emptyInline: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 20,
  },
  socialRow: {
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  socialMetaRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    justifyContent: 'space-between',
  },
  socialPlatform: {
    color: '#4A8198',
    fontSize: 12,
    fontWeight: '600',
  },
  socialStatus: {
    color: '#4F8D61',
    fontSize: 11,
    fontWeight: '600',
  },
  socialStatusBlocked: {
    color: '#B76658',
  },
  socialTime: {
    color: '#8A96A6',
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 16,
    marginTop: 3,
  },
  socialReason: {
    color: colors.ink,
    fontSize: 13,
    fontWeight: '500',
    lineHeight: 19,
    marginTop: 5,
  },
  socialDetail: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    lineHeight: 18,
    marginTop: 4,
  },
  webVoyageRow: {
    borderTopColor: 'rgba(56,64,82,0.08)',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  webVoyageQuery: {
    color: '#527D60',
    flex: 1,
    fontSize: 12,
    fontWeight: '600',
  },
  webVoyageStage: {
    color: '#6F8775',
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    marginTop: 4,
  },
  webVoyageShareStatus: {
    color: '#7E9470',
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    marginTop: 4,
  },
  webVoyageShareDelivered: {
    color: '#4F8D61',
  },
  webVoyageEvidence: {
    color: '#527D60',
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 16,
    marginTop: 5,
  },
  webVoyageEvidenceMuted: {
    color: '#9A8A68',
  },
  webVoyageEvidenceText: {
    color: '#6F8775',
    fontSize: 11,
    fontWeight: '400',
    lineHeight: 17,
    marginTop: 3,
  },
  webVoyageFailure: {
    color: '#B76658',
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    marginTop: 4,
  },
  webVoyageUrl: {
    color: '#5E8D6A',
    fontSize: 11,
    fontWeight: '500',
    lineHeight: 16,
    marginTop: 5,
  },
  sectionTitle: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: '600',
    lineHeight: 24,
    marginBottom: 12,
  },
  emptyBlock: {
    alignItems: 'center',
    paddingVertical: 28,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: '600',
    lineHeight: 22,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    fontWeight: '600',
    lineHeight: 20,
    marginTop: 6,
    textAlign: 'center',
  },
  deviationCard: {
    backgroundColor: 'rgba(255,255,255,0.68)',
    borderRadius: 24,
    marginTop: 14,
    padding: 18,
  },
  deviationText: {
    color: colors.muted,
    fontSize: 14,
    fontWeight: '600',
    lineHeight: 22,
    marginTop: 4,
  },
});
