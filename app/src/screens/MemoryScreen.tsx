import { useEffect, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { useAiConfigPreferences } from '../ai/AiConfigPreferences';
import {
  MEMORY_ANCHOR_KINDS,
  MEMORY_DOMAINS,
  loadMemorySourceRefs,
  isWhisperMemory,
  type EventThread,
  type MemoryEdge,
  type MemoryAnchorKind,
  type MemoryDomain,
  type MemoryDraft,
  type MemoryEntry,
} from '../memory/memoryStore';
import type { MemoryHealthReport } from '../memory/memoryHealthReport';
import type { MemorySystemHealthSnapshot } from '../memory/memorySystemHealth';
import type { MemorySourceTraceResult } from '../memory/memorySourceTrace';
import { getMemorySourceStatus, memorySourceStatusLabel } from '../memory/memorySourceStatus';
import { loadGift } from '../gifts/giftStore';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import {
  createMemoryCurrentState,
  getMemoryCurrentStateKindLabel,
  loadActiveMemoryCurrentStates,
  resolveMemoryCurrentState,
  type MemoryCurrentState,
} from '../memory/memoryCurrentStateStore';
import { makeCurrentStateCandidateFromMemory } from '../memory/memoryCurrentStateCandidates';
import { MemoryCurrentStateBrowser } from '../memory/MemoryCurrentStateBrowser';
import { MemoryWeeklyBrowser } from '../memory/MemoryWeeklyBrowser';
import {
  hideMemoryTopic,
  loadMemoryTopicProfiles,
  renameMemoryTopic,
  restoreMemoryTopic,
  type MemoryTopicKind,
  type MemoryTopicProfile,
} from '../memory/memoryTopicProfiles';
import { MemoryStarMapView } from '../memory/MemoryStarMapView';
import { MemoryContinuityLinkPanel } from '../memory/MemoryContinuityLinkPanel';
import { MemoryWeeklyRefreshPanel } from '../memory/MemoryWeeklyRefreshPanel';
import { MemoryUnderstandingPanel } from '../memory/MemoryUnderstandingPanel';
import type { MemoryStarGraphMode } from '../memory/memoryStarGraph';
import { getAnchorKindLabel, inferAnchorKindFromDomain } from '../memory/memoryAnchorContext';
import type { MemoryDehydrationBlockReason } from '../memory/memoryDehydration';
import { formatMemoryLifecycleEventLabel } from '../memory/memoryLifecycle';
import {
  parseHistoryTextFile,
} from '../memory/memoryHistoryImport';
import {
  MEMORY_ABILITY_LAYERS,
  type MemoryAbilityLayer,
} from '../memory/memoryAbilityMap';
import {
  buildMemoryCatalogSnapshot,
  type MemoryCatalogLine,
  type MemoryCatalogSnapshot,
} from '../memory/memoryCatalog';
import {
  buildMemoryMaintenanceSnapshot,
  type MemoryMaintenanceItem,
  type MemoryMaintenanceSnapshot,
} from '../memory/memoryMaintenanceCenter';
import { notifyMemoryProcessingWorkAvailable } from '../memory/memoryProcessingSignals';
import { readMemoryBrowserPage, subscribeMemoryBrowserChanges } from '../memory/memoryBrowser';
import { reconcileAndRetryMemoryProcessing } from '../memory/memoryProcessingWorker';
import {
  pauseMemoryDuplicateCleanup,
  previewMemoryDuplicateCleanup,
  startOrResumeMemoryDuplicateCleanup,
  type MemoryDuplicateCleanupPreview,
} from '../memory/memoryDuplicateCleanup';
import {
  loadMemoryDuplicateCleanupJournal,
  subscribeMemoryDuplicateCleanupJournal,
  type MemoryDuplicateCleanupJournalV1,
} from '../memory/memoryDuplicateCleanupState';
import { useMemoryScreenController } from '../memory/useMemoryScreenController';
import { MemoryEditComparison } from '../memory/MemoryEditComparison';
import { useMemoryScreenTools, type HistoryImportCandidate } from '../memory/useMemoryScreenTools';
import { loadHistoryImportSource } from '../memory/memoryHistoryImportStore';
import {
  dateKey,
  getMemoryScreenTimeLabel,
  type MemoryScreenViewMode,
} from '../memory/memoryScreenSelectors';
import {
  MEMORY_ORGANIZER_CONFIG_MESSAGE,
  MEMORY_ORGANIZER_CONFIG_TITLE,
} from '../memory/memoryOrganizerConfigNotice';
import { TogetherWalkedScreen } from '../memory/TogetherWalkedScreen';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';

type ViewMode = MemoryScreenViewMode;

function getMaintenanceSeverityLabel(severity: MemoryMaintenanceItem['severity']) {
  if (severity === 'warning') return '需要看一眼';
  if (severity === 'notice') return '可以稍后处理';
  return '暂时正常';
}

function formatDate(timestamp: number) {
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
}

function formatShortDate(timestamp?: number) {
  if (!timestamp) return '还没有';
  return new Date(timestamp).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function formatLifecycleTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDehydrationReason(reason: MemoryDehydrationBlockReason) {
  const labels: Record<MemoryDehydrationBlockReason, string> = {
    not_timeline_eligible: '不进普通时间线',
    pinned_or_protected: '钉住或保护中',
    anchor: '长期锚点',
    permanent: '永久记忆',
    archived: '已归档',
    feel: '情绪类记忆',
    whisper: '悄悄话',
    daily_impression: '旧日印象',
    too_short: '正文还不够长',
    too_recent: '参考间隔不足',
    recent_dehydration_exists: '近期已经压缩过',
  };
  return labels[reason];
}

function formatAnchorCoordinate(kind?: MemoryAnchorKind) {
  return `${getAnchorKindLabel(kind)}坐标`;
}

function formatSurfacingMode(mode?: MemoryHealthReport['surfacing']['mode']) {
  if (mode === 'suggested_mention') return '可以自然关心';
  if (mode === 'quiet_context') return '只安静进上下文';
  return '不会主动提';
}

function formatReportList(items: string[], fallback: string) {
  return items.length ? items.join('、') : fallback;
}

function formatRelationType(relationType: MemoryEdge['relationType']) {
  const labels: Record<MemoryEdge['relationType'], string> = {
    belongs_to: '同属',
    blocks: '阻碍',
    causes: '因果',
    contradicts: '冲突',
    emotional_echo: '情绪回声',
    promises: '约定',
    supersedes: '替代',
    relates_to: '相关',
    supports: '支持',
    triggers: '触发',
    updates: '更新',
  };
  return labels[relationType];
}

function formatMemorySourceLabel(source?: string) {
  const labels: Record<string, string> = {
    'history-import': '历史导入',
    'episode-memory': '阶段记忆',
    'weekly-context': '周脉络',
    'small-note': '近况小纸条',
    'emotional-weather': '情绪天气',
    'baiyun-reflection': '白云动态',
    'baiyun-post': '白云动态',
    'memory-organizer': '记忆整理',
    'manual': '手动保存',
  };
  if (!source) {
    return '普通记忆';
  }
  return labels[source] ?? source;
}

function formatMemorySourceSummary(memory: MemoryEntry) {
  const label = formatMemorySourceLabel(memory.source);
  const hasSourceRange = Boolean(memory.sourceStartAt || memory.sourceEndAt);
  const rangeText = hasSourceRange ? '有来源时间' : '暂无来源时间';
  return '保存来源：' + label + ' · ' + rangeText;
}

function formatSourceTraceTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSourceTraceRole(role: 'you' | 'I') {
  return role === 'you' ? '小仓鼠' : '白云小姐';
}

function formatTopicKind(kind: MemoryTopicKind) {
  const labels: Record<MemoryTopicKind, string> = {
    event: '事件',
    interest: '兴趣',
    other: '其他',
    person: '人物',
    place: '地点',
    project: '项目',
    relationship: '关系',
    state: '状态',
  };
  return labels[kind];
}

function formatTopicTime(timestamp: number) {
  if (!timestamp) return '还没有更新时间';
  return '最近更新 ' + formatShortDate(timestamp);
}

function getMemorySourceTraceSummary(memory: MemoryEntry, trace: MemorySourceTraceResult | null) {
  const detail = trace?.details.find((item) => item.memoryId === memory.id);
  if (memory.source === 'history-import') return '历史导入 · 非聊天来源';
  if (detail) {
    if (!detail.messages.length) return memorySourceStatusLabel.missing;
    const statuses = detail.messages.map(message => getMemorySourceStatus({ ...message, mode: detail.mode }));
    return [...new Set(statuses)].map(status => `${memorySourceStatusLabel[status]} · ${statuses.filter(value => value === status).length} 句`).join('；');
  }
  if (!trace) return '暂未加载';
  if (memory.sourceTraceMode === 'none') return '非聊天来源';
  return memorySourceStatusLabel.missing;
}

function formatConfirmationLevel(memory: MemoryEntry) {
  if (memory.confirmationLevel === 'manual') return '手动创建';
  if (memory.confirmationLevel === 'reviewed') return '小仓鼠已确认';
  return '自动整理';
}

function calendarCells(month: Date) {
  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstWeekday = new Date(year, monthIndex, 1).getDay();
  const dayCount = new Date(year, monthIndex + 1, 0).getDate();
  const cells: Array<number | null> = Array.from({ length: firstWeekday }, () => null);
  for (let day = 1; day <= dayCount; day += 1) cells.push(day);
  while (cells.length % 7) cells.push(null);
  return cells;
}

export function MemoryScreen({ navigate }: { navigate: Navigate }) {
  const windowDimensions = useWindowDimensions();
  const { memoryOrganizerConnection, memoryOrganizerKey, memoryRerankerConnection, memoryRerankerKey } = useAiConfigPreferences();
  const memoryScreen = useMemoryScreenController({
    ai: {
      connection: memoryOrganizerConnection,
      key: memoryOrganizerKey,
      rerankerConnection: memoryRerankerConnection,
      rerankerKey: memoryRerankerKey,
    },
  });
  const {
    addComment,
    addMemoryToCurrentTimeline,
    beginEdit,
    beginNew,
    changeMonth,
    commentText,
    commentSaveError,
    commentSaving,
    comments,
    createTimeline,
    creating,
    dateMemories,
    deleteComment,
    deleteSelectedMemory,
    dehydrationDiagnostic,
    domain,
    draft,
    editing,
    embeddingStatus,
    filteredMemories,
    graphLinks,
    healthReport,
    healthSummary,
    hideCurrentTimelineAfterConfirm,
    loaded,
    lifecycleEvents,
    lifecycleSummary,
    markedDates,
    memories,
    mergeCandidates,
    mergeOpen,
    mergeQuery,
    mergeRecovery,
    mergeSelectedMemory,
    mergeUndoOutcome,
    mode,
    month,
    openMemory,
    openStarMap,
    openThread,
    qualitySignals,
    query,
    meaningSearching,
    searchNotice,
    searchByMeaning,
    cancelMeaningSearch,
    rebuildSelectedEmbedding,
    sourceTrace,
    sourceCorrectionCandidate,
    sourceSelectionGroups,
    sourceSelectionKeys,
    sourceSelectionLoading,
    sourceSelectionOpen,
    addSourceCorrection,
    archiveSelectedAsWrongSource,
    discardSourceCorrectionCandidate,
    makeCorrectionCandidateFromSource,
    markSourceOutdated,
    openSourceSelection,
    saveSourceCorrectionCandidateAsComment,
    saveSourceCorrectionCandidateAsUpdate,
    saveSourceSelection,
    closeSourceSelection,
    toggleSourceSelection,
    updateSourceCorrectionCandidate,

    recallCuesText,
    refresh,
    refreshSelectedMemory,
    refreshStarMap,
    removeMemoryFromCurrentTimeline,
    saveDraft,
    cancelEdit,
    editConflict,
    acceptEditComparison,
    draftSaveError,
    draftSaving,
    refreshNotice,
    refreshing,
    retryRefresh,
    saveTimelineTitle,
    selected,
    selectedDate,
    selectedStarEdgeId,
    selectedStarNodeId,
    setCommentText,
    setCreating,
    setDomain,
    setDraft,
    setEditing,
    setMergeOpen,
    setMergeQuery,
    setMode,
    setQuery,
    setRecallCuesText,
    setSelected,
    setSelectedDate,
    setSelectedStarEdgeId,
    setSelectedStarNodeId,
    setStarMapFilters,
    setStarMapOpen,
    setStarMapQuery,
    setTagsText,
    setThreadDetail,
    setTimelineCreating,
    setTimelineEditing,
    setTimelineSearch,
    setTimelineSelectedIds,
    setTimelineTitle,
    starMapFilters,
    starMapGraph,
    starMapLoading,
    starMapMode,
    starMapOpen,
    starMapQuery,
    systemHealth,
    tagsText,
    threadDetail,
    threads,
    timelineCandidates,
    timelineCreating,
    timelineEditing,
    timelineSearch,
    timelineSelectedIds,
    timelineTitle,
    toggleMemoryArchive,
    toggleSelectedArchive,
    toggleSelectedDigested,
    toggleSelectedSurfaceMuted,
  } = memoryScreen;
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [abilityMapOpen, setAbilityMapOpen] = useState(false);
  const [maintenanceCenterOpen, setMaintenanceCenterOpen] = useState(false);
  const [maintenanceSnapshot, setMaintenanceSnapshot] = useState<MemoryMaintenanceSnapshot | null>(null);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [duplicateCleanupLoading, setDuplicateCleanupLoading] = useState(false);
  const [duplicateCleanupPreview, setDuplicateCleanupPreview] = useState<MemoryDuplicateCleanupPreview | null>(null);
  const [duplicateCleanupJournal, setDuplicateCleanupJournal] = useState<MemoryDuplicateCleanupJournalV1 | null>(null);
  const [memoryCatalogOpen, setMemoryCatalogOpen] = useState(false);
  const [memoryCatalogSnapshot, setMemoryCatalogSnapshot] = useState<MemoryCatalogSnapshot | null>(null);
  const [memoryCatalogLoading, setMemoryCatalogLoading] = useState(false);
  const [togetherWalkedOpen, setTogetherWalkedOpen] = useState(false);
  const [detailAdvancedOpen, setDetailAdvancedOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [sourceTraceOpen, setSourceTraceOpen] = useState(false);
  const [deletedGiftSources, setDeletedGiftSources] = useState<Set<string>>(new Set());
  useEffect(() => {
    let current = true;
    const epoch = captureBackupRestoreDataEpoch();
    setDeletedGiftSources(new Set());
    if (!sourceTraceOpen) return () => { current = false; };
    const sources = [...new Set((sourceTrace?.details ?? []).flatMap(detail => detail.messages)
      .filter(message => !message.available).map(message => message.sessionId))];
    void Promise.all(sources.map(async sessionId => {
      const match = /^gift-source:(.+):([1-9]\d*)$/.exec(sessionId);
      if (!match || !Number.isSafeInteger(Number(match[2]))) return null;
      try { return await loadGift(match[1]) ? null : sessionId; }
      catch { return null; }
    })).then(deleted => { if (current && canCommitBackupRestoreDataEpoch(epoch)) setDeletedGiftSources(new Set(deleted.filter((id): id is string => !!id))); });
    return () => { current = false; };
  }, [sourceTrace, sourceTraceOpen]);
  const [historySource, setHistorySource] = useState<{ fileName: string; content: string } | null>(null);
  const [historySourcePage, setHistorySourcePage] = useState(0);
  const [sourceCorrectionOpen, setSourceCorrectionOpen] = useState(false);
  const [sourceCorrectionKind, setSourceCorrectionKind] = useState<'correction' | 'outdated'>('correction');
  const [sourceCorrectionText, setSourceCorrectionText] = useState('');
  const [currentStates, setCurrentStates] = useState<MemoryCurrentState[]>([]);
  const [topicProfilesOpen, setTopicProfilesOpen] = useState(false);
  const [topicProfiles, setTopicProfiles] = useState<MemoryTopicProfile[]>([]);
  const [topicProfilesLoading, setTopicProfilesLoading] = useState(false);
  const [selectedTopicKey, setSelectedTopicKey] = useState<string | null>(null);
  const [topicRenameText, setTopicRenameText] = useState('');
  const [topicShowHidden, setTopicShowHidden] = useState(false);

  const refreshCurrentStates = async () => {
    const states = await loadActiveMemoryCurrentStates({ limit: 8 }).catch(() => []);
    setCurrentStates(states);
  };

  const selectedTopicProfile = selectedTopicKey
    ? topicProfiles.find((profile) => profile.key === selectedTopicKey) ?? null
    : topicProfiles[0] ?? null;

  const refreshTopicProfiles = async (includeHidden = topicShowHidden) => {
    setTopicProfilesLoading(true);
    try {
      const profiles = await loadMemoryTopicProfiles({ includeHidden, limit: 80 });
      setTopicProfiles(profiles);
      if (selectedTopicKey && !profiles.some((profile) => profile.key === selectedTopicKey)) {
        setSelectedTopicKey(profiles[0]?.key ?? null);
      }
      if (!selectedTopicKey && profiles[0]) {
        setSelectedTopicKey(profiles[0].key);
      }
    } finally {
      setTopicProfilesLoading(false);
    }
  };

  const openTopicProfilesModal = (topicKey?: string) => {
    setDrawerVisible(false);
    setTopicProfilesOpen(true);
    if (topicKey) setSelectedTopicKey(topicKey);
    void refreshTopicProfiles(topicShowHidden || Boolean(topicKey));
  };

  const saveTopicRename = async () => {
    if (!selectedTopicProfile) return;
    await renameMemoryTopic(selectedTopicProfile.key, topicRenameText || selectedTopicProfile.label);
    await refreshTopicProfiles(topicShowHidden);
  };

  const toggleTopicHidden = async () => {
    if (!selectedTopicProfile) return;
    if (selectedTopicProfile.hidden) await restoreMemoryTopic(selectedTopicProfile.key);
    else await hideMemoryTopic(selectedTopicProfile.key);
    await refreshTopicProfiles(topicShowHidden || selectedTopicProfile.hidden);
    await refreshStarMap();
  };

  useEffect(() => {
    notifyMemoryProcessingWorkAvailable('memory_screen');
    void refreshCurrentStates();
  }, []);

  useEffect(() => {
    if (!topicProfilesOpen) return;
    void refreshTopicProfiles(topicShowHidden);
  }, [topicProfilesOpen, topicShowHidden]);

  useEffect(() => {
    setTopicRenameText(selectedTopicProfile?.displayName ?? '');
  }, [selectedTopicProfile?.key, selectedTopicProfile?.displayName]);

  useEffect(() => {
    setDetailAdvancedOpen(false);
    setLifecycleOpen(false);
    setSourceTraceOpen(false);
    setSourceCorrectionOpen(false);
    setSourceCorrectionText('');
    discardSourceCorrectionCandidate();
    setMergeOpen(false);
  }, [selected?.id, setMergeOpen]);

  const selectedSourceSummary = selected ? formatMemorySourceSummary(selected) : '';
  const selectedSourceTraceSummary = selected ? getMemorySourceTraceSummary(selected, sourceTrace) : '';
  const selectedQualitySignalCount = (qualitySignals?.correctedCount ?? 0)
    + (qualitySignals?.outdatedCount ?? 0)
    + (qualitySignals?.confirmedCount ?? 0);
  const selectedAdvancedSummary = selected
    ? [
      selectedSourceTraceSummary ? '来源 ' + selectedSourceTraceSummary : '',
      graphLinks.length ? '关系 ' + graphLinks.length + ' 条' : '',
      dehydrationDiagnostic?.eligible ? '可整理旧记忆' : '',
      selectedQualitySignalCount ? '质量信号 ' + selectedQualitySignalCount : '',
      healthReport?.graphWarnings.length ? '关系提醒 ' + healthReport.graphWarnings.length : '',
      embeddingStatus?.indexed ? '向量已建' : '向量未建',
    ].filter(Boolean).join(' / ') || '体检、关系和维护工具'
    : '';

  const memoryTools = useMemoryScreenTools({
    ai: {
      connection: memoryOrganizerConnection,
      key: memoryOrganizerKey,
    },
    refresh,
    refreshSelectedMemory,
    refreshStarMap,
  });
  const abilityMapPanelHeight = Math.max(420, Math.min(windowDimensions.height - 120, Math.round(windowDimensions.height * 0.74)));

  const refreshMaintenanceCenter = async () => {
    setMaintenanceLoading(true);
    try {
      const pendingPage = await readMemoryBrowserPage({ section: 'pending', limit: 1 });
      const snapshot = await buildMemoryMaintenanceSnapshot({
        activeCurrentStateCount: currentStates.length,
        memoryOrganizerLabel: memoryOrganizerConnection?.name,
        memoryOrganizerReady: Boolean(memoryOrganizerConnection && memoryOrganizerKey),
        memoryRerankerLabel: memoryRerankerConnection?.name,
        memoryRerankerReady: Boolean(memoryRerankerConnection && memoryRerankerKey),
        pendingCandidateCount: pendingPage.total,
        systemHealth,
      });
      setMaintenanceSnapshot(snapshot);
    } catch {
      Alert.alert('记忆检查读取失败', '待确认稿数量暂未核对；已显示的检查结果保留，请重试。');
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const retryMemoryProcessing = async () => {
    setMaintenanceLoading(true);
    try {
      await reconcileAndRetryMemoryProcessing();
      await refresh();
      await refreshMaintenanceCenter();
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const openMaintenanceCenter = () => {
    setDrawerVisible(false);
    setMaintenanceCenterOpen(true);
    void refreshMaintenanceCenter();
  };

  const refreshDuplicateCleanupPreview = async () => {
    setDuplicateCleanupLoading(true);
    try {
      const [preview, journal] = await Promise.all([
        previewMemoryDuplicateCleanup(),
        loadMemoryDuplicateCleanupJournal(),
      ]);
      setDuplicateCleanupPreview(preview);
      setDuplicateCleanupJournal(journal);
    } finally {
      setDuplicateCleanupLoading(false);
    }
  };

  const beginDuplicateCleanup = () => {
    const count = duplicateCleanupPreview?.candidates ?? 0;
    Alert.alert(
      '开始清理重复记忆？',
      `本次预计整理 ${count} 条精确重复的自动生活状态记忆。君落会先创建本机回退副本，再分批处理。`,
      [
        { text: '先不处理', style: 'cancel' },
        {
          text: '开始清理',
          onPress: () => {
            setDuplicateCleanupLoading(true);
            void startOrResumeMemoryDuplicateCleanup()
              .then(() => Promise.all([refresh(), refreshDuplicateCleanupPreview()]))
              .finally(() => setDuplicateCleanupLoading(false));
          },
        },
      ],
    );
  };

  useEffect(() => subscribeMemoryDuplicateCleanupJournal((journal) => {
    setDuplicateCleanupJournal(journal);
  }), []);

  useEffect(() => {
    if (!maintenanceCenterOpen) return;
    void refreshDuplicateCleanupPreview();
  }, [maintenanceCenterOpen]);

  const refreshMemoryCatalog = async () => {
    setMemoryCatalogLoading(true);
    try {
      const snapshot = await buildMemoryCatalogSnapshot({ limitPerGroup: 10 });
      setMemoryCatalogSnapshot(snapshot);
    } finally {
      setMemoryCatalogLoading(false);
    }
  };

  const openMemoryCatalog = () => {
    setMaintenanceCenterOpen(false);
    setMemoryCatalogOpen(true);
    void refreshMemoryCatalog();
  };

  const handleMemoryCatalogLinePress = (line: MemoryCatalogLine) => {
    if (line.memoryId) {
      const target = memories.find((memory) => memory.id === line.memoryId);
      if (target) {
        setMemoryCatalogOpen(false);
        void openMemory(target);
      }
      return;
    }
    if (line.topicKey) {
      setMemoryCatalogOpen(false);
      openTopicProfilesModal(line.topicKey);
    }
  };

  const handleMaintenanceAction = (item: MemoryMaintenanceItem) => {
    if (!item.actionTarget) return;
    if (item.actionTarget === 'memory_processing') {
      void retryMemoryProcessing();
      return;
    }
    if (item.actionTarget === 'memory_detail' && item.targetId) {
      const target = memories.find((memory) => memory.id === item.targetId);
      if (target) {
        setMaintenanceCenterOpen(false);
        void openMemory(target);
      }
      return;
    }
    if (item.actionTarget === 'star_graph') {
      setMaintenanceCenterOpen(false);
      openStarMap('overview');
      return;
    }
    if (item.actionTarget === 'topic_profiles') {
      setMaintenanceCenterOpen(false);
      openTopicProfilesModal();
      return;
    }
    if (item.actionTarget === 'memory_catalog') {
      openMemoryCatalog();
      return;
    }
    if (item.actionTarget === 'candidate_reviews') {
      setMaintenanceCenterOpen(false);
      setDrawerVisible(false);
      navigate('memory-pending');
      return;
    }
    if (item.actionTarget === 'current_states' || item.actionTarget === 'memory_health' || item.actionTarget === 'system_health') {
      setMaintenanceCenterOpen(false);
      setDrawerVisible(true);
    }
  };

  useEffect(() => {
    if (!maintenanceCenterOpen) return;
    void refreshMaintenanceCenter();
    return subscribeMemoryBrowserChanges(() => void refreshMaintenanceCenter());
  }, [maintenanceCenterOpen, currentStates.length, memoryTools.historyImport.candidates.length, systemHealth]);

  const handleAbilityLayerAction = (layer: MemoryAbilityLayer) => {
    if (!layer.action) return;
    setAbilityMapOpen(false);
    if (layer.action === 'anchors') {
      setMode('pinned');
      setDomain(undefined);
      setQuery('');
      return;
    }
    if (layer.action === 'heart') {
      navigate('letter');
      return;
    }
    openStarMap('overview');
  };

  const openSourceCorrectionDialog = (kind: 'correction' | 'outdated') => {
    setSourceCorrectionKind(kind);
    setSourceCorrectionText('');
    setSourceCorrectionOpen(true);
  };

  const submitSourceCorrection = async (makeCandidateAfterSave = false) => {
    const note = sourceCorrectionText.trim();
    if (sourceCorrectionKind === 'correction' && !note) {
      Alert.alert('先写一点正确理解', '这里会写进这条记忆的年轮，之后白云再想起它时会更谨慎。');
      return;
    }
    if (sourceCorrectionKind === 'correction') {
      await addSourceCorrection(note);
      if (makeCandidateAfterSave) makeCorrectionCandidateFromSource(note);
    } else {
      await markSourceOutdated(note);
    }
    setSourceCorrectionOpen(false);
    setSourceCorrectionText('');
  };

  const confirmArchiveWrongSource = () => {
    Alert.alert('把这条记忆归档？', '只会归档这条记忆，并留下来源纠错年轮；不会永久删除。', [
      { text: '取消', style: 'cancel' },
      {
        text: '确认归档',
        style: 'destructive',
        onPress: () => {
          void archiveSelectedAsWrongSource();
        },
      },
    ]);
  };

  const confirmUpdateMemoryFromSourceCandidate = () => {
    Alert.alert('用修正候选更新原记忆？', '保存后只留改好的卡，不另存这次错稿；真实聊天原话保留。', [
      { text: '取消', style: 'cancel' },
      {
        text: '更新原记忆',
        onPress: () => {
          void saveSourceCorrectionCandidateAsUpdate();
        },
      },
    ]);
  };
  const repairStarMapEdge = async (edgeId: string, action: 'reverse' | 'soften') => {
    if (action === 'reverse') await memoryTools.graphRepair.reverseEdge(edgeId, { refreshMap: true });
    else await memoryTools.graphRepair.softenEdge(edgeId, { refreshMap: true });
  };

  const deleteStarMapEdge = (edgeId: string) => {
    Alert.alert('隐藏这条关系？', '只会删除这条关系边，不会删除两边的记忆正文。', [
      { text: '取消', style: 'cancel' },
      {
        text: '隐藏关系',
        style: 'destructive',
        onPress: () => {
          void memoryTools.graphRepair.deleteEdge(edgeId, { refreshMap: true });
        },
      },
    ]);
  };

  const reverseGraphLink = async (edgeId: string) => {
    await memoryTools.graphRepair.reverseEdge(edgeId);
  };

  const softenGraphLink = async (edgeId: string) => {
    await memoryTools.graphRepair.softenEdge(edgeId);
  };

  const removeGraphLink = (edgeId: string) => {
    Alert.alert(
      '隐藏这条关系？',
      '只会删除这条关系边，不会删除两边的记忆正文。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '隐藏关系',
          style: 'destructive',
          onPress: () => {
            void memoryTools.graphRepair.deleteEdge(edgeId);
          },
        },
      ],
    );
  };

  const hideCurrentTimeline = () => {
    if (!threadDetail) return;
    Alert.alert(
      '从时间轴移除这件事？',
      '只会隐藏这条事件线，里面的原始记忆、年轮和聊天记录都不会删除。',
      [
        { text: '取消', style: 'cancel' },
        {
          text: '仅从时间轴移除',
          style: 'destructive',
          onPress: () => {
            void hideCurrentTimelineAfterConfirm();
          },
        },
      ],
    );
  };

  const showMemoryOrganizerConfigAlert = () => {
    Alert.alert(MEMORY_ORGANIZER_CONFIG_TITLE, MEMORY_ORGANIZER_CONFIG_MESSAGE, [
      { text: '稍后再说', style: 'cancel' },
      { text: '去配置 AI', onPress: () => navigate('ai-settings') },
    ]);
  };

  const runDehydrationMaintenance = async () => {
    const result = await memoryTools.dehydration.run();
    if (result.status === 'missing_config') {
      showMemoryOrganizerConfigAlert();
      return;
    }
    if ('alert' in result) {
      Alert.alert(result.alert.title, result.alert.message);
    }
  };

  const processHistoryImportPreview = async (preview: ReturnType<typeof parseHistoryTextFile>) => {
    const result = await memoryTools.historyImport.processPreview(preview);
    if (result.status === 'missing_config') {
      showMemoryOrganizerConfigAlert();
      return;
    }
    if ('alert' in result) {
      Alert.alert(result.alert.title, result.alert.message);
    }
  };

  const continueHistoryImport = async (importId: string) => {
    const result = await memoryTools.historyImport.continueImport(importId);
    if (result.status === 'missing_config') showMemoryOrganizerConfigAlert();
    else if ('alert' in result) Alert.alert(result.alert.title, result.alert.message);
  };

  const openHistorySource = async (query: { importId: string } | { memoryId: string }) => {
    try {
      const source = await loadHistoryImportSource(query);
      if (!source) { Alert.alert('原文件不可用', '这条旧导入记录没有保留原文件。'); return; }
      setHistorySourcePage(0);
      setHistorySource(source);
    } catch {
      Alert.alert('读取未完成', '原文件暂未读取成功，请稍后重试。');
    }
  };

  const pickHistoryImportFile = async () => {
    if (memoryTools.historyImport.importing) return;
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        type: ['text/plain', 'text/markdown', 'text/x-markdown', '*/*'],
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset?.uri) return;
      const fileName = asset.name || '历史文本';
      if (!/\.(txt|md|markdown)$/i.test(fileName)) {
        Alert.alert('暂时只支持文本', '第一版历史导入只支持 .txt、.md 或 .markdown 文件。');
        return;
      }
      const content = await FileSystem.readAsStringAsync(asset.uri, { encoding: FileSystem.EncodingType.UTF8 });
      const preview = parseHistoryTextFile({ content, name: fileName });
      if (!preview.chunks.length) {
        Alert.alert('没有可导入内容', '这份文本清理后没有足够内容可以整理。');
        return;
      }
      Alert.alert(
        '导入历史文本？',
        `文件：${preview.fileName}\n字数：${preview.totalChars}\n分块：${preview.chunks.length}\n预计候选：最多 ${preview.estimatedCandidates} 条\n\n原文件与进度会保存在本地。每次最多整理 24 块，剩余内容可继续。候选仍需手动保存，不会导入聊天记录。`,
        [
          { text: '取消', style: 'cancel' },
          { text: '开始整理', onPress: () => void processHistoryImportPreview(preview) },
        ],
      );
    } catch {
      Alert.alert('读取失败', '这份文件暂时没有读成功，换一份 .txt 或 .md 试试。');
    }
  };

  const saveHistoryImportCandidate = async (candidate: HistoryImportCandidate) => {
    await memoryTools.historyImport.saveCandidate(candidate);
  };

  const createCurrentStateFromSelectedMemory = async () => {
    if (!selected) return;
    const refs = (await loadMemorySourceRefs(selected.id)).map(({ memoryId: _memoryId, createdAt: _createdAt, ...ref }) => ref);
    const candidate = makeCurrentStateCandidateFromMemory(selected, refs);
    Alert.alert('保存为当前状态？', `${candidate.title}\n\n${candidate.content}\n\n这是一张近期便利贴，不会改写原记忆。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '保存',
        onPress: () => {
          void createMemoryCurrentState(candidate).then(() => refreshCurrentStates());
        },
      },
    ]);
  };

  const endCurrentStateFromDrawer = async (id: string) => {
    await resolveMemoryCurrentState(id, 'user_closed');
    await refreshCurrentStates();
  };

  const confirmMerge = (source: MemoryEntry) => {
    if (!selected) return;
    Alert.alert(
      '把这两页合在一起？',
      `保留「${selected.title}」作为主记忆，将「${source.title}」收进年轮。原有年轮、标签与想起词都会保留。`,
      [
        { text: '取消', style: 'cancel' },
        { text: '确认合并', onPress: () => void mergeSelectedMemory(source) },
      ],
    );
  };

  const memoryDrawer = (
    <Modal
      animationType="fade"
      transparent
      visible={drawerVisible}
      onRequestClose={() => setDrawerVisible(false)}
    >
      <View style={styles.drawerOverlay}>
        <Pressable style={styles.drawerBackdrop} onPress={() => setDrawerVisible(false)} />
        <View style={styles.drawerPanel}>
          <ScrollView
            contentContainerStyle={styles.drawerContent}
            showsVerticalScrollIndicator={false}
            style={styles.drawerScroll}
          >
            <Text style={styles.drawerTitle}>功能</Text>
            <View style={styles.drawerQuickNav}>
              <Pressable
                onPress={() => {
                  setDrawerVisible(false);
                  navigate('home');
                }}
                style={styles.drawerQuickNavButton}
              >
                <Text style={styles.drawerQuickNavIcon}>⌂</Text>
                <Text style={styles.drawerQuickNavText}>首页</Text>
              </Pressable>
              <Pressable
                onPress={() => {
                  setDrawerVisible(false);
                  navigate('chat');
                }}
                style={styles.drawerQuickNavButton}
              >
                <Text style={styles.drawerQuickNavIcon}>◌</Text>
                <Text style={styles.drawerQuickNavText}>聊天</Text>
              </Pressable>
            </View>

            <Text style={styles.drawerSectionTitle}>整理与导入</Text>
            <Pressable
              disabled={memoryTools.dehydration.running}
              onPress={() => void runDehydrationMaintenance()}
              style={[styles.drawerAction, memoryTools.dehydration.running && styles.disabledButton]}
            >
              <Text style={styles.drawerActionIcon}>整理</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>{memoryTools.dehydration.running ? '正在整理旧记忆' : '整理旧记忆'}</Text>
                <Text style={styles.drawerActionHint}>把旧长记忆压成年轮摘要</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Pressable
              disabled={memoryTools.historyImport.importing}
              onPress={() => void pickHistoryImportFile()}
              style={[styles.drawerAction, memoryTools.historyImport.importing && styles.disabledButton]}
            >
              <Text style={styles.drawerActionIcon}>导入</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>{memoryTools.historyImport.importing ? '正在导入历史文本' : '导入历史文本'}</Text>
                <Text style={styles.drawerActionHint}>从 txt 或 md 生成待确认候选</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Text style={styles.drawerSectionTitle}>查看与维护</Text>
            <Pressable
              onPress={() => openTopicProfilesModal()}
              style={styles.drawerAction}
            >
              <Text style={styles.drawerActionIcon}>主题</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>主题档案</Text>
                <Text style={styles.drawerActionHint}>按标签、想起词和当前状态看小档案</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDrawerVisible(false);
                openStarMap('overview');
              }}
              style={styles.drawerAction}
            >
              <Text style={styles.drawerActionIcon}>星图</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>关系概览</Text>
                <Text style={styles.drawerActionHint}>查看精选记忆和关系线</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setDrawerVisible(false);
                setTogetherWalkedOpen(true);
              }}
              style={styles.drawerAction}
            >
              <Text style={styles.drawerActionIcon}>走过</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>一起走过</Text>
                <Text style={styles.drawerActionHint}>记录出门、照片和地点</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Pressable onPress={() => { setDrawerVisible(false); navigate('memory-pending'); }} style={styles.drawerAction}>
              <Text style={styles.drawerActionIcon}>待审</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>待确认</Text>
                <Text style={styles.drawerActionHint}>查看全部已保存的整理草稿</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Pressable onPress={openMaintenanceCenter} style={styles.drawerAction}>
              <Text style={styles.drawerActionIcon}>维护</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>记忆检查</Text>
                <Text style={styles.drawerActionHint}>集中查看状态、候选、关系和当前便利贴</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            <Text style={styles.drawerSectionTitle}>当前状态</Text>
            <MemoryCurrentStateBrowser items={currentStates} onCloseState={endCurrentStateFromDrawer} />
            {memoryTools.dehydration.notice ? <Text style={styles.drawerNotice}>{memoryTools.dehydration.notice}</Text> : null}
            {memoryTools.historyImport.notice ? <Text style={styles.drawerNotice}>{memoryTools.historyImport.notice}</Text> : null}
            {memoryTools.historyImport.progress ? <Text style={styles.drawerNotice}>{memoryTools.historyImport.progress}</Text> : null}

            <View style={styles.drawerDivider} />
            <Text style={styles.drawerSectionTitle}>说明与状态</Text>
            <Pressable
              onPress={() => {
                setDrawerVisible(false);
                setAbilityMapOpen(true);
              }}
              style={styles.drawerAction}
            >
              <Text style={styles.drawerActionIcon}>地图</Text>
              <View style={styles.drawerActionCopy}>
                <Text style={styles.drawerActionTitle}>记忆能力地图</Text>
                <Text style={styles.drawerActionHint}>看懂短记忆、阶段记忆和惦记池怎么分工</Text>
              </View>
              <Text style={styles.drawerArrow}>›</Text>
            </Pressable>
            {systemHealth ? (
              <MemorySystemHealthCard
                health={systemHealth}
                onAction={(target) => {
                  if (target === 'ai-settings' || target === 'backup') {
                    setDrawerVisible(false);
                    navigate(target);
                    return;
                  }
                  Alert.alert('最近体检', '最近体检就在侧栏下方，点对应标签可以打开相关记忆。');
                }}
              />
            ) : null}

            <View style={styles.drawerDivider} />
            <View style={styles.healthSummaryPanel}>
              <View style={styles.healthHeader}>
                <Text style={styles.healthTitle}>最近体检</Text>
                <Text style={styles.healthMeta}>只读报告</Text>
              </View>
              {healthSummary?.actionItems.length ? (
                <View style={styles.tags}>
                  {healthSummary.actionItems.map((item) => {
                    const target = memories.find((memory) => item.memoryIds.includes(memory.id));
                    return (
                      <Pressable
                        disabled={!target}
                        key={item.kind}
                        onPress={() => {
                          if (!target) return;
                          setDrawerVisible(false);
                          void openMemory(target);
                        }}
                        style={styles.healthSummaryChip}
                      >
                        <Text style={styles.healthSummaryChipText}>{item.label} {item.count}</Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.healthHint}>最近没有需要特别处理的记忆问题。</Text>
              )}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  const starMapModal = (
    <Modal
      animationType="slide"
      visible={starMapOpen}
      onRequestClose={() => setStarMapOpen(false)}
    >
      <View style={styles.starMapPage}>
        <MemoryStarMapView
          graph={starMapGraph}
          loading={starMapLoading}
          modeLabel={starMapMode === 'local' ? '局部' : '概览'}
          onClose={() => setStarMapOpen(false)}
          onDeleteEdge={deleteStarMapEdge}
          onFilterChange={setStarMapFilters}
          onOpenMemory={(memory) => {
            setStarMapOpen(false);
            void openMemory(memory);
          }}
          onOpenTopic={(topicKey) => {
            setStarMapOpen(false);
            openTopicProfilesModal(topicKey);
          }}
          onReverseEdge={(edgeId) => void repairStarMapEdge(edgeId, 'reverse')}
          onSearchChange={setStarMapQuery}
          onSelectEdge={setSelectedStarEdgeId}
          onSelectNode={setSelectedStarNodeId}
          onSoftenEdge={(edgeId) => void repairStarMapEdge(edgeId, 'soften')}
          onToggleMode={() => {
            if (starMapMode === 'local') {
              openStarMap('overview');
              return;
            }
            const focusedNode = starMapGraph?.nodes.find((node) => node.id === selectedStarNodeId && node.kind === 'memory');
            const focusMemoryId = focusedNode?.id ?? selected?.id;
            if (!focusMemoryId) {
              Alert.alert('先点一条记忆', '从全局星图里点一张记忆小纸条，再切到局部，就会围绕它展开。');
              return;
            }
            openStarMap('local', focusMemoryId);
          }}
          query={starMapQuery}
          selectedEdgeId={selectedStarEdgeId}
          selectedFilters={starMapFilters}
          selectedNodeId={selectedStarNodeId}
        />
      </View>
    </Modal>
  );

  const togetherWalkedModal = (
    <Modal
      animationType="slide"
      visible={togetherWalkedOpen}
      onRequestClose={() => setTogetherWalkedOpen(false)}
    >
      <TogetherWalkedScreen onClose={() => setTogetherWalkedOpen(false)} />
    </Modal>
  );

  const topicProfilesModal = (
    <Modal
      animationType="fade"
      transparent
      visible={topicProfilesOpen}
      onRequestClose={() => setTopicProfilesOpen(false)}
    >
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={() => setTopicProfilesOpen(false)} />
        <View style={[styles.topicProfilePanel, { height: abilityMapPanelHeight }]}> 
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>主题档案</Text>
              <Text style={styles.abilityMapTitle}>把相近记忆收成可点的入口</Text>
            </View>
            <Pressable onPress={() => setTopicProfilesOpen(false)} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.abilityMapIntro}>
            主题档案只根据现有分类、标签、想起词、当前状态和关系整理索引；改名和隐藏不会改写记忆正文。
          </Text>
          <View style={styles.topicToolbar}>
            <Pressable onPress={() => setTopicShowHidden((value) => !value)} style={styles.topicToggleButton}>
              <Text style={styles.topicToggleText}>{topicShowHidden ? '只看可见主题' : '显示隐藏主题'}</Text>
            </Pressable>
            <Text style={styles.topicCountText}>{topicProfilesLoading ? '正在整理...' : topicProfiles.length + ' 个主题'}</Text>
          </View>
          <ScrollView
            contentContainerStyle={styles.topicProfileContent}
            showsVerticalScrollIndicator={false}
            style={styles.abilityMapScroll}
          >
            {topicProfiles.length ? (
              <View style={styles.topicCardGrid}>
                {topicProfiles.map((profile) => (
                  <Pressable
                    key={profile.key}
                    onPress={() => setSelectedTopicKey(profile.key)}
                    style={[
                      styles.topicCard,
                      selectedTopicProfile?.key === profile.key && styles.topicCardActive,
                      profile.hidden && styles.topicCardHidden,
                    ]}
                  >
                    <View style={styles.topicCardHeader}>
                      <Text numberOfLines={1} style={styles.topicCardTitle}>{profile.displayName}</Text>
                      <Text style={styles.topicKindBadge}>{formatTopicKind(profile.kind)}</Text>
                    </View>
                    <Text style={styles.topicCardMeta}>
                      记忆 {profile.memoryCount} · 当前 {profile.currentStateCount} · 关系 {profile.relationCount}
                    </Text>
                    <Text style={styles.topicCardMeta}>{formatTopicTime(profile.recentUpdatedAt)}</Text>
                    {profile.hidden ? <Text style={styles.topicHiddenBadge}>已隐藏</Text> : null}
                  </Pressable>
                ))}
              </View>
            ) : (
              <Text style={styles.empty}>还没有整理出主题。等记忆多一点，这里会长出小入口。</Text>
            )}

            {selectedTopicProfile ? (
              <View style={styles.topicDetailCard}>
                <View style={styles.topicDetailHeader}>
                  <View style={styles.topicDetailTitleWrap}>
                    <Text style={styles.topicDetailTitle}>{selectedTopicProfile.displayName}</Text>
                    <Text style={styles.topicCardMeta}>
                      {formatTopicKind(selectedTopicProfile.kind)} · 原始主题：{selectedTopicProfile.label}
                    </Text>
                  </View>
                  <Pressable onPress={toggleTopicHidden} style={[styles.topicSmallButton, selectedTopicProfile.hidden && styles.topicSmallButtonActive]}>
                    <Text style={[styles.topicSmallButtonText, selectedTopicProfile.hidden && styles.topicSmallButtonTextActive]}>
                      {selectedTopicProfile.hidden ? '恢复主题' : '隐藏主题'}
                    </Text>
                  </Pressable>
                </View>
                <TextInput
                  onChangeText={setTopicRenameText}
                  placeholder="给这个主题换个好懂的名字"
                  placeholderTextColor={colors.muted}
                  style={styles.topicRenameInput}
                  value={topicRenameText}
                />
                <View style={styles.topicActionRow}>
                  <Pressable onPress={() => void saveTopicRename()} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>保存改名</Text>
                  </Pressable>
                  <Pressable
                    onPress={() => {
                      setQuery(selectedTopicProfile.displayName);
                      setTopicProfilesOpen(false);
                    }}
                    style={styles.secondaryButton}
                  >
                    <Text style={styles.secondaryButtonText}>只看这个主题</Text>
                  </Pressable>
                </View>
                {selectedTopicProfile.tags.length ? (
                  <View style={styles.tags}>
                    {selectedTopicProfile.tags.map((tag) => <Text key={tag} style={styles.tag}>{tag}</Text>)}
                  </View>
                ) : null}
                <Text style={styles.topicSectionTitle}>关键记忆</Text>
                {selectedTopicProfile.keyMemories.length ? selectedTopicProfile.keyMemories.map((memory) => (
                  <Pressable
                    key={memory.id}
                    onPress={() => {
                      setTopicProfilesOpen(false);
                      void openMemory(memory);
                    }}
                    style={styles.topicMemoryRow}
                  >
                    <View style={styles.topicMemoryCopy}>
                      <Text numberOfLines={1} style={styles.topicMemoryTitle}>{memory.title || memory.domain}</Text>
                      <Text numberOfLines={2} style={styles.topicMemoryText}>{memory.content}</Text>
                    </View>
                    <Text style={styles.drawerArrow}>›</Text>
                  </Pressable>
                )) : <Text style={styles.healthHint}>这个主题暂时没有关键记忆。</Text>}

                <Text style={styles.topicSectionTitle}>当前状态</Text>
                {selectedTopicProfile.activeStates.length ? selectedTopicProfile.activeStates.map((state) => (
                  <View key={state.id} style={styles.currentStateRow}>
                    <View style={styles.currentStateCopy}>
                      <Text style={styles.currentStateTitle}>{state.title}</Text>
                      <Text numberOfLines={2} style={styles.currentStateMeta}>
                        {getMemoryCurrentStateKindLabel(state.kind)} · 得知时间：{state.knownAt === undefined ? '未记录' : formatShortDate(state.knownAt)}
                      </Text>
                      <MemoryContinuityLinkPanel
                        compact
                        target={{
                          relation: 'current_state',
                          targetKind: 'memory_current_state',
                          targetId: state.id,
                        }}
                      />
                    </View>
                  </View>
                )) : <Text style={styles.healthHint}>这个主题下面暂时没有生效中的当前状态。</Text>}

                {selectedTopicProfile.warningCount ? (
                  <Text style={styles.topicWarningText}>关系提醒 {selectedTopicProfile.warningCount} 条，可在关系图谱里继续精修。</Text>
                ) : null}
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  const memoryCatalogModal = (
    <Modal
      animationType="fade"
      transparent
      visible={memoryCatalogOpen}
      onRequestClose={() => setMemoryCatalogOpen(false)}
    >
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={() => setMemoryCatalogOpen(false)} />
        <View style={[styles.maintenancePanel, { height: abilityMapPanelHeight }]}>
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>记忆目录小抄</Text>
              <Text style={styles.abilityMapTitle}>{memoryCatalogSnapshot?.title ?? '看看白云记忆的大方向'}</Text>
            </View>
            <Pressable onPress={() => setMemoryCatalogOpen(false)} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.abilityMapIntro}>
            {memoryCatalogSnapshot?.summary ?? '这是一份只读索引，只看标题、主题和短核心；不会改写记忆，也不会进入正式聊天。'}
          </Text>
          <ScrollView
            contentContainerStyle={styles.catalogContent}
            showsVerticalScrollIndicator={false}
            style={styles.abilityMapScroll}
          >
            {memoryCatalogLoading && !memoryCatalogSnapshot ? (
              <View style={styles.maintenanceEmptyCard}>
                <Text style={styles.healthTitle}>正在整理目录小抄</Text>
                <Text style={styles.healthHint}>白云只看现有记忆的标题、主题和短核心，不调用 AI。</Text>
              </View>
            ) : null}
            {memoryCatalogSnapshot?.groups.map((group) => (
              <View key={group.id} style={styles.catalogGroupCard}>
                <View style={styles.catalogGroupHeader}>
                  <Text style={styles.maintenanceSectionTitle}>{group.title}</Text>
                  <Text style={styles.topicCountText}>{group.lines.length} 条</Text>
                </View>
                {group.lines.length ? group.lines.map((line) => {
                  const canOpenLine = Boolean(line.memoryId || line.topicKey);
                  return (
                    <Pressable
                      disabled={!canOpenLine}
                      key={line.id}
                      onPress={() => handleMemoryCatalogLinePress(line)}
                      style={[styles.catalogLineCard, !canOpenLine && styles.catalogLineCardDisabled]}
                    >
                      <Text numberOfLines={2} style={styles.catalogLineTitle}>{line.title}</Text>
                      <Text style={styles.catalogLineMeta}>{line.subtitle}</Text>
                      {line.tags.length ? (
                        <View style={styles.catalogTagRow}>
                          {line.tags.slice(0, 4).map((tag) => <Text key={tag} style={styles.catalogTag}>{tag}</Text>)}
                        </View>
                      ) : null}
                    </Pressable>
                  );
                }) : (
                  <Text style={styles.maintenanceItemDetail}>这一组暂时没有内容。</Text>
                )}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
  const maintenanceCenterModal = (
    <Modal
      animationType="fade"
      transparent
      visible={maintenanceCenterOpen}
      onRequestClose={() => setMaintenanceCenterOpen(false)}
    >
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={() => setMaintenanceCenterOpen(false)} />
        <View style={[styles.maintenancePanel, { height: abilityMapPanelHeight }]}>
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>记忆检查</Text>
              <Text style={styles.abilityMapTitle}>{maintenanceSnapshot?.title ?? '看看记忆本现在怎么样'}</Text>
            </View>
            <Pressable onPress={() => setMaintenanceCenterOpen(false)} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.abilityMapIntro}>
            {maintenanceSnapshot?.summary ?? '这里只做总览和入口，不会自动修库，也不会改写任何记忆。'}
          </Text>
          <ScrollView
            contentContainerStyle={styles.maintenanceContent}
            showsVerticalScrollIndicator={false}
            style={styles.abilityMapScroll}
          >
            <View style={styles.duplicateCleanupCard}>
              <View style={styles.maintenanceItemHeader}>
                <View style={styles.maintenanceItemTitleWrap}>
                  <Text style={styles.maintenanceItemTitle}>清理重复记忆</Text>
                  <Text style={styles.maintenanceItemDetail}>
                    君落会保留每种自动生活状态最早的一份，并整理其余重复记录。聊天、手写记忆和不同事件不会参与。
                  </Text>
                </View>
                <View style={styles.maintenanceBadge}>
                  <Text style={styles.maintenanceBadgeText}>
                    {duplicateCleanupLoading && !duplicateCleanupPreview
                      ? '检查中'
                      : `${duplicateCleanupPreview?.candidates ?? 0} 条`}
                  </Text>
                </View>
              </View>
              {duplicateCleanupJournal?.phase === 'cleaning' ? (
                <Text style={styles.duplicateCleanupProgress}>
                  正在整理重复记忆 · {duplicateCleanupJournal.processedCandidates}/{duplicateCleanupJournal.totalCandidates}
                </Text>
              ) : duplicateCleanupJournal?.phase === 'compacting' ? (
                <Text style={styles.duplicateCleanupProgress}>正在压缩记忆数据库</Text>
              ) : duplicateCleanupJournal?.phase === 'publishing'
                || duplicateCleanupJournal?.phase === 'waiting-windows' ? (
                <Text style={styles.duplicateCleanupProgress}>
                  本机重复记忆已经整理完成，删除结果正在分批送往电脑。
                </Text>
              ) : duplicateCleanupJournal?.phase === 'paused' ? (
                <Text style={styles.duplicateCleanupProgress}>
                  已经安全停在 {duplicateCleanupJournal.processedCandidates}/{duplicateCleanupJournal.totalCandidates}，可以继续。
                </Text>
              ) : duplicateCleanupJournal?.phase === 'recovery-blocked' ? (
                <Text style={styles.duplicateCleanupError}>回退没有完成，记忆写入和同步仍保持暂停。</Text>
              ) : (
                <Text style={styles.maintenanceSeverityText}>
                  {duplicateCleanupPreview
                    ? `预计同时整理 ${duplicateCleanupPreview.lifecycleEvents} 条孤立创建流水；跳过 ${duplicateCleanupPreview.skipped} 条受保护或有关联的记录。`
                    : '先只读检查，不会自动删除。'}
                </Text>
              )}
              <View style={styles.duplicateCleanupActions}>
                <Pressable
                  disabled={duplicateCleanupLoading}
                  onPress={() => void refreshDuplicateCleanupPreview()}
                  style={[styles.secondaryButton, duplicateCleanupLoading && styles.buttonDisabled]}
                >
                  <Text style={styles.secondaryButtonText}>重新检查</Text>
                </Pressable>
                {duplicateCleanupJournal?.phase === 'cleaning' ? (
                  <Pressable
                    onPress={() => void pauseMemoryDuplicateCleanup()}
                    style={styles.deleteButton}
                  >
                    <Text style={styles.deleteText}>先停一下</Text>
                  </Pressable>
                ) : duplicateCleanupJournal?.phase === 'paused' ? (
                  <Pressable onPress={beginDuplicateCleanup} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>继续清理</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    disabled={duplicateCleanupLoading || !duplicateCleanupPreview?.candidates}
                    onPress={beginDuplicateCleanup}
                    style={[
                      styles.primaryButton,
                      (duplicateCleanupLoading || !duplicateCleanupPreview?.candidates) && styles.buttonDisabled,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>开始清理</Text>
                  </Pressable>
                )}
              </View>
            </View>
            {maintenanceLoading && !maintenanceSnapshot ? (
              <View style={styles.maintenanceEmptyCard}>
                <Text style={styles.healthTitle}>正在翻维护小本</Text>
                <Text style={styles.healthHint}>白云在把系统状态、体检、候选和当前状态收拢到一起。</Text>
              </View>
            ) : null}
            {maintenanceSnapshot?.sections.map((section) => (
              <View key={section.id} style={styles.maintenanceSection}>
                <Text style={styles.maintenanceSectionTitle}>{section.title}</Text>
                {section.items.map((item) => (
                  <View key={item.id} style={styles.maintenanceItemCard}>
                    <View style={styles.maintenanceItemHeader}>
                      <View style={styles.maintenanceItemTitleWrap}>
                        <Text style={styles.maintenanceItemTitle}>{item.title}</Text>
                        <Text style={styles.maintenanceItemDetail}>{item.detail}</Text>
                      </View>
                      <View style={[
                        styles.maintenanceBadge,
                        item.severity === 'warning' ? styles.maintenanceBadgeWarning : null,
                        item.severity === 'notice' ? styles.maintenanceBadgeNotice : null,
                      ]}>
                        <Text style={[
                          styles.maintenanceBadgeText,
                          item.severity === 'warning' ? styles.maintenanceBadgeWarningText : null,
                          item.severity === 'notice' ? styles.maintenanceBadgeNoticeText : null,
                        ]}>
                          {item.count ? item.count : getMaintenanceSeverityLabel(item.severity)}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.maintenanceItemFooter}>
                      <Text style={styles.maintenanceSeverityText}>{getMaintenanceSeverityLabel(item.severity)}</Text>
                      {item.actionTarget && item.actionLabel ? (
                        <Pressable onPress={() => handleMaintenanceAction(item)} style={styles.maintenanceActionButton}>
                          <Text style={styles.maintenanceActionText}>{item.actionLabel}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  const historySourceModal = (
    <Modal animationType="fade" transparent visible={historySource !== null} onRequestClose={() => setHistorySource(null)}>
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={() => setHistorySource(null)} />
        <View style={[styles.abilityMapPanel, { height: abilityMapPanelHeight }]}>
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>历史导入原文件</Text>
              <Text style={styles.healthTitle}>{historySource?.fileName}</Text>
            </View>
            <Pressable onPress={() => setHistorySource(null)} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <ScrollView key={historySourcePage} style={styles.abilityMapScroll}>
            <Text selectable style={styles.sourceTraceContent}>
              {historySource?.content.slice(historySourcePage * 5000, (historySourcePage + 1) * 5000)}
            </Text>
          </ScrollView>
          <View style={styles.editorActions}>
            <Pressable disabled={historySourcePage === 0} onPress={() => setHistorySourcePage((page) => page - 1)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>上一页</Text>
            </Pressable>
            <Text style={styles.score}>{historySourcePage + 1}/{Math.max(1, Math.ceil((historySource?.content.length ?? 0) / 5000))}</Text>
            <Pressable disabled={(historySourcePage + 1) * 5000 >= (historySource?.content.length ?? 0)} onPress={() => setHistorySourcePage((page) => page + 1)} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>下一页</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );

  const sourceCorrectionModal = (
    <Modal
      animationType="fade"
      transparent
      visible={sourceCorrectionOpen}
      onRequestClose={() => setSourceCorrectionOpen(false)}
    >
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={() => setSourceCorrectionOpen(false)} />
        <View style={styles.sourceCorrectionModalPanel}>
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>来源纠错</Text>
              <Text style={styles.abilityMapTitle}>
                {sourceCorrectionKind === 'correction' ? '正确理解是什么？' : '哪里已经过期了？'}
              </Text>
            </View>
            <Pressable onPress={() => setSourceCorrectionOpen(false)} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.abilityMapIntro}>
            {sourceCorrectionKind === 'correction'
              ? '这会先写进年轮，让这条记忆以后被想起时更谨慎；不会自动覆盖正文。'
              : '这会留下过期说明，让后续召回别把旧背景当成现在。'}
          </Text>
          <TextInput
            multiline
            onChangeText={setSourceCorrectionText}
            placeholder={sourceCorrectionKind === 'correction' ? '写下正确理解...' : '写下过期原因，可以留空...'}
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.contentInput]}
            textAlignVertical="top"
            value={sourceCorrectionText}
          />
          <View style={styles.editorActions}>
            <Pressable onPress={() => void submitSourceCorrection(false)} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>写入年轮</Text>
            </Pressable>
            {sourceCorrectionKind === 'correction' ? (
              <Pressable onPress={() => void submitSourceCorrection(true)} style={styles.secondaryButton}>
                <Text style={styles.secondaryButtonText}>写入并做候选</Text>
              </Pressable>
            ) : null}
            <Pressable onPress={() => setSourceCorrectionOpen(false)} style={styles.deleteButton}>
              <Text style={styles.deleteText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
  const sourceSelectionModal = (
    <Modal
      animationType="fade"
      transparent
      visible={sourceSelectionOpen}
      onRequestClose={closeSourceSelection}
    >
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={closeSourceSelection} />
        <View style={styles.sourceCorrectionModalPanel}>
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>精确来源</Text>
              <Text style={styles.abilityMapTitle}>重选真正支撑这条记忆的消息</Text>
            </View>
            <Pressable onPress={closeSourceSelection} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.abilityMapIntro}>只会改来源，不会自动改写记忆正文。至少选择一条真实消息。</Text>
          <ScrollView style={styles.sourceSelectionList} contentContainerStyle={styles.sourceSelectionListContent}>
            {sourceSelectionLoading ? (
              <Text style={styles.healthHint}>正在读取可核对的原话…</Text>
            ) : sourceSelectionGroups.length ? (
              sourceSelectionGroups.map((group, groupIndex) => (
                <View key={group.sessionId} style={styles.sourceSelectionGroup}>
                  <Text style={styles.sourceTraceRange}>{group.sessionId.startsWith('letter:') ? '信件原文' : `会话 ${groupIndex + 1}`} · {group.messages.length} 条候选</Text>
                  {group.messages.map((message) => {
                    const selectedKey = `${group.sessionId}\u0000${message.id}`;
                    const checked = sourceSelectionKeys.includes(selectedKey);
                    return (
                      <Pressable
                        key={message.id}
                        onPress={() => toggleSourceSelection(group.sessionId, message.id)}
                        style={[styles.sourceSelectionMessage, checked && styles.sourceSelectionMessageChecked]}
                      >
                        <Text style={styles.sourceSelectionCheck}>{checked ? '✓' : '○'}</Text>
                        <View style={styles.sourceSelectionTextWrap}>
                          <Text style={styles.sourceTraceRole}>
                            {formatSourceTraceRole(message.role)} · {formatSourceTraceTime(message.createdAt)}
                          </Text>
                          <Text style={styles.sourceTraceContent}>{message.content}</Text>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              ))
            ) : (
              <Text style={styles.healthHint}>没有找到可供重选的原话。</Text>
            )}
          </ScrollView>
          <View style={styles.editorActions}>
            <Pressable
              disabled={!sourceSelectionKeys.length || sourceSelectionLoading}
              onPress={() => void saveSourceSelection()}
              style={[styles.primaryButton, (!sourceSelectionKeys.length || sourceSelectionLoading) && styles.disabledButton]}
            >
              <Text style={styles.primaryButtonText}>保存精确来源</Text>
            </Pressable>
            <Pressable onPress={closeSourceSelection} style={styles.deleteButton}>
              <Text style={styles.deleteText}>取消</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
  const abilityMapModal = (
    <Modal
      animationType="fade"
      transparent
      visible={abilityMapOpen}
      onRequestClose={() => setAbilityMapOpen(false)}
    >
      <View style={styles.abilityMapOverlay}>
        <Pressable style={styles.abilityMapBackdrop} onPress={() => setAbilityMapOpen(false)} />
        <View style={[styles.abilityMapPanel, { height: abilityMapPanelHeight }]}>
          <View style={styles.abilityMapHeader}>
            <View style={styles.abilityMapTitleWrap}>
              <Text style={styles.abilityMapEyebrow}>记忆能力地图</Text>
              <Text style={styles.abilityMapTitle}>白云怎么使用这些记忆工具</Text>
            </View>
            <Pressable onPress={() => setAbilityMapOpen(false)} style={styles.abilityMapClose}>
              <Text style={styles.abilityMapCloseText}>×</Text>
            </Pressable>
          </View>
          <Text style={styles.abilityMapIntro}>
            这不是新增功能，而是一张说明书：哪些记忆负责事实，哪些负责经历，哪些只放在白云心里，哪些可以说出口。
          </Text>
          <ScrollView
            contentContainerStyle={styles.abilityMapList}
            showsVerticalScrollIndicator={false}
            style={styles.abilityMapScroll}
          >
            {MEMORY_ABILITY_LAYERS.map((layer) => (
              <View key={layer.id} style={styles.abilityLayerCard}>
                <View style={styles.abilityLayerHeader}>
                  <Text style={styles.abilityLayerTitle}>{layer.title}</Text>
                  <Text style={styles.abilityLayerOwns}>{layer.owns}</Text>
                </View>
                <Text style={styles.abilityLayerSubtitle}>{layer.subtitle}</Text>
                <View style={styles.abilityLayerRows}>
                  <Text style={styles.abilityLayerRow}>
                    <Text style={styles.abilityLayerLabel}>能不能说出口：</Text>
                    {layer.canSpeak}
                  </Text>
                  <Text style={styles.abilityLayerRow}>
                    <Text style={styles.abilityLayerLabel}>不要打架：</Text>
                    {layer.guardrail}
                  </Text>
                </View>
                {layer.action && layer.actionLabel ? (
                  <Pressable onPress={() => handleAbilityLayerAction(layer)} style={styles.abilityLayerAction}>
                    <Text style={styles.abilityLayerActionText}>{layer.actionLabel}</Text>
                  </Pressable>
                ) : null}
              </View>
            ))}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );

  if (threadDetail) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => setThreadDetail(null)} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
          <View>
            <Text style={styles.title}>时间轴</Text>
            <Text style={styles.subtitle}>这件事后来怎样了</Text>
          </View>
          <Pressable onPress={() => setTimelineEditing((value) => !value)} style={styles.addButton}>
            <Text style={styles.editAction}>{timelineEditing ? '好' : '改'}</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          <View style={styles.threadHero}>
            <Text style={styles.threadTitle}>{threadDetail.thread.title}</Text>
            <Text style={styles.threadSummary}>{threadDetail.thread.summary}</Text>
            <Text style={styles.score}>事件时间：{threadDetail.thread.eventStartAt === undefined ? '日期未知' : formatDate(threadDetail.thread.eventStartAt)}</Text>
            <Text style={styles.score}>保存时间 {formatDate(threadDetail.thread.savedAt)} · 记录更新 {formatDate(threadDetail.thread.updatedAt)}</Text>
            {timelineEditing ? (
              <>
                <TextInput
                  onChangeText={setTimelineTitle}
                  placeholder="事件线标题"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  value={timelineTitle}
                />
                <View style={styles.editorActions}>
                  <Pressable onPress={() => void saveTimelineTitle()} style={styles.primaryButton}>
                    <Text style={styles.primaryButtonText}>保存标题</Text>
                  </Pressable>
                  <Pressable onPress={hideCurrentTimeline} style={styles.deleteButton}>
                    <Text style={styles.deleteText}>移出时间轴</Text>
                  </Pressable>
                </View>
              </>
            ) : null}
          </View>
          {threadDetail.memories.map((memory, index) => {
            const relatedEdge = threadDetail.edges.find((edge) => edge.sourceId === memory.id || edge.targetId === memory.id);
            return (
              <Pressable
                disabled={timelineEditing}
                key={memory.id}
                onPress={() => void openMemory(memory)}
                style={styles.timelineItem}
              >
                <View style={styles.timelineDot} />
                <View style={styles.timelineLine}>
                  <Text style={styles.timelineStep}>第 {index + 1} 条</Text>
                  <Text style={styles.cardTitle}>{memory.title}</Text>
                  <Text style={styles.memoryContent}>{memory.content}</Text>
                  {relatedEdge?.reason ? <Text style={styles.threadReason}>关联原因：{relatedEdge.reason}</Text> : null}
                  <Text style={styles.memoryDate}>{getMemoryScreenTimeLabel(memory)}</Text>
                  <Text style={styles.memoryDate}>保存 {formatDate(memory.createdAt)} · 记录更新 {formatDate(memory.updatedAt)}</Text>
                  {timelineEditing ? (
                    <Pressable
                      onPress={() => void removeMemoryFromCurrentTimeline(memory)}
                      style={styles.timelineRemoveButton}
                    >
                      <Text style={styles.deleteText}>仅从这条事件线移除</Text>
                    </Pressable>
                  ) : null}
                </View>
              </Pressable>
            );
          })}
          {timelineEditing ? (
            <View style={styles.timelineEditorPanel}>
              <Text style={styles.editorTitle}>拉入已有记忆</Text>
              <Text style={styles.mergeHint}>只调整时间轴编排，不会移动或修改原始记忆。</Text>
              <TextInput
                onChangeText={setTimelineSearch}
                placeholder="搜索要加入的记忆..."
                placeholderTextColor={colors.muted}
                style={styles.input}
                value={timelineSearch}
              />
              {timelineCandidates.map((memory) => (
                <Pressable
                  key={memory.id}
                  onPress={() => void addMemoryToCurrentTimeline(memory)}
                  style={styles.mergeCandidate}
                >
                  <Text style={styles.cardTitle}>{memory.title}</Text>
                  <Text numberOfLines={2} style={styles.memoryContent}>{memory.content}</Text>
                  <Text style={styles.mergePick}>加入这条事件线</Text>
                </Pressable>
              ))}
            </View>
          ) : null}
        </ScrollView>
      </View>
    );
  }

  if (selected) {
    return (
      <View style={styles.page}>
        <View style={styles.header}>
          <Pressable onPress={() => setSelected(null)} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
          <View>
            <Text style={styles.title}>记忆详情</Text>
            <Text style={styles.subtitle}>这一页后来长出的年轮</Text>
          </View>
          <Pressable disabled={draftSaving} onPress={() => beginEdit(selected)} style={styles.addButton}><Text style={styles.editAction}>改</Text></Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
          {refreshNotice ? <Pressable disabled={refreshing} onPress={() => void retryRefresh()}><Text accessibilityRole="alert" style={styles.operationNotice}>{refreshing ? '正在刷新…' : refreshNotice}</Text></Pressable> : null}
          {editing ? (
            <MemoryEditor
              draft={draft}
              editing
              saving={draftSaving}
              saveError={draftSaveError}
              conflict={editConflict}
              onReviewed={acceptEditComparison}
              onCancel={cancelEdit}
              onChange={setDraft}
              onSave={() => void saveDraft()}
              onRecallCuesChange={setRecallCuesText}
              onTagsChange={setTagsText}
              recallCuesText={recallCuesText}
              tagsText={tagsText}
            />
          ) : (
            <View style={styles.detailSheet}>
              <View style={styles.detailTop}>
                <Text style={styles.domainBadge}>
                  {selected.domain}
                </Text>
                <Text style={styles.memoryDate}>{getMemoryScreenTimeLabel(selected)}</Text>
              </View>
              <Text style={styles.detailTitle}>{selected.title}</Text>
              <Text style={styles.detailContent}>{selected.content}</Text>
              <View style={styles.tags}>
                {selected.pinned ? <Text style={styles.pinTag}>钉住</Text> : null}
                {selected.anchor ? <Text style={styles.anchorTag}>{formatAnchorCoordinate(selected.anchorKind)}</Text> : null}
                {selected.tags.map((tag) => <Text key={tag} style={styles.tag}>{tag}</Text>)}
              </View>
              {selected.recallCues.length ? (
                <View style={styles.cueSection}>
                  <Text style={styles.cueLabel}>想起词</Text>
                  <View style={styles.tags}>
                    {selected.recallCues.map((cue) => <Text key={cue} style={styles.cueTag}>{cue}</Text>)}
                  </View>
                </View>
              ) : null}
              <View style={styles.detailInfoBox}>
                <Text style={styles.detailInfoLabel}>为什么留下</Text>
                <Text style={styles.detailInfoText}>{selected.rememberedReason?.trim() || '还没有写下留下理由'}</Text>
              </View>
              <View style={styles.detailInfoBox}>
                <Text style={styles.detailInfoLabel}>保存来源</Text>
                <Text style={styles.detailInfoText}>{selectedSourceSummary}</Text>
              </View>
              {selected.source === 'weekly-context' ? (
                <MemoryWeeklyRefreshPanel key={selected.id} memory={selected} onSaved={refresh} />
              ) : null}
              {selected.understandingSubject ? <MemoryUnderstandingPanel key={selected.id} memory={selected} onSaved={refresh} /> : null}
              <MemoryContinuityLinkPanel
                target={{ relation: 'memory', targetKind: 'memory', targetId: selected.id }}
              />
              <View style={styles.statusStrip}>
                <Text style={selected.confirmationLevel === 'automatic' ? styles.coolTag : styles.activeTag}>
                  {formatConfirmationLevel(selected)}
                </Text>
                {selected.sourceTraceMode !== 'none' ? (
                  <Text style={styles.coolTag}>{selectedSourceTraceSummary}</Text>
                ) : null}
                {selected.surfaceMutedAt ? (
                  <Text style={styles.coolTag}>别主动提 {formatShortDate(selected.surfaceMutedAt)}</Text>
                ) : (
                  <Text style={styles.activeTag}>允许主动提</Text>
                )}
                {selected.digested ? <Text style={styles.coolTag}>已消化</Text> : null}
                {selected.anchor ? <Text style={styles.anchorTag}>{formatAnchorCoordinate(selected.anchorKind)}</Text> : null}
              </View>
              <View style={styles.commonActionPanel}>
                <Text style={styles.healthSectionTitle}>常用操作</Text>
                <View style={styles.actionGrid}>
                  <Pressable onPress={() => beginEdit(selected)} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>修改</Text>
                  </Pressable>
                  <Pressable onPress={toggleSelectedSurfaceMuted} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>{selected.surfaceMutedAt ? '允许主动提' : '别主动提'}</Text>
                  </Pressable>
                  <View style={styles.actionRowBreak} />
                  <Pressable onPress={() => void createCurrentStateFromSelectedMemory()} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>转当前状态</Text>
                  </Pressable>
                  <Pressable onPress={toggleSelectedArchive} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>
                      {selected.type === 'archived' ? mergeRecovery ? '撤销合并' : '恢复' : '归档'}
                    </Text>
                  </Pressable>
                </View>
              </View>
              <View style={styles.healthPanel}>
                <View style={styles.healthHeader}>
                  <View style={styles.advancedToggleText}>
                    <Text style={styles.healthTitle}>记忆足迹</Text>
                    <Text style={styles.healthHint}>{lifecycleSummary}</Text>
                  </View>
                  <Pressable onPress={() => setLifecycleOpen((value) => !value)} style={styles.sourceTraceToggle}>
                    <Text style={styles.sourceTraceToggleText}>{lifecycleOpen ? '收起' : '展开'}</Text>
                  </Pressable>
                </View>
                {mergeUndoOutcome === 'restored_source_preserved_target' ? (
                  <Text style={styles.healthHint}>目标页后来有变化：已恢复来源页，并保留目标页当前内容。</Text>
                ) : mergeUndoOutcome === 'restored_both' ? (
                  <Text style={styles.healthHint}>合并已经完整撤销，两页都回到合并前的状态。</Text>
                ) : null}
                {lifecycleOpen ? lifecycleEvents.map((event) => (
                  <View key={event.id} style={styles.sourceTraceMessage}>
                    <Text style={styles.healthSectionTitle}>{formatMemoryLifecycleEventLabel(event)}</Text>
                    <Text style={styles.healthMeta}>
                      {formatLifecycleTime(event.createdAt)}
                      {event.actor === 'manual' ? ' · 手动' : event.actor === 'maintenance' ? ' · 系统维护' : event.actor === 'migration' ? ' · 旧记录整理' : ' · 自动'}
                    </Text>
                  </View>
                )) : null}
              </View>
              <Pressable onPress={() => setDetailAdvancedOpen((value) => !value)} style={styles.advancedToggle}>
                <View style={styles.advancedToggleText}>
                  <Text style={styles.advancedToggleTitle}>高级信息</Text>
                  <Text style={styles.advancedToggleSummary}>{selectedAdvancedSummary}</Text>
                </View>
                <Text style={styles.advancedToggleIcon}>{detailAdvancedOpen ? '收起' : '展开'}</Text>
              </Pressable>
              {detailAdvancedOpen ? (
                <>
              <Text style={styles.score}>重要度 {selected.importance}</Text>
              <Text style={styles.score}>
                生命周期 {selected.tier === 'core' ? '核心' : selected.tier === 'working' ? '工作' : '外围'}
                {' · '}稳定度 {Math.round(selected.stability * 100)}%
                {' · '}{selected.semanticType}
              </Text>
              <Text style={styles.score}>{selected.activationCount > 0 ? `参考 ${selected.activationCount} 次` : '尚未参考'} · 上次参考 {selected.lastActiveAt > 0 ? formatDate(selected.lastActiveAt) : '未记录'}</Text>
              {selected.archiveReason ? <Text style={styles.archiveReason}>{selected.archiveReason}</Text> : null}
              <Text style={styles.score}>向量索引 {embeddingStatus?.indexed ? `已建立 · ${embeddingStatus.model}` : `未建立 · ${embeddingStatus?.model ?? ''}`}</Text>
              <View style={styles.sourceTracePanel}>
                <View style={styles.sourceTraceHeader}>
                  <View>
                    <Text style={styles.healthTitle}>来源片段</Text>
                    <Text style={styles.healthMeta}>{selectedSourceTraceSummary}</Text>
                  </View>
                  <Pressable onPress={() => setSourceTraceOpen((value) => !value)} style={styles.sourceTraceToggle}>
                    <Text style={styles.sourceTraceToggleText}>{sourceTraceOpen ? '收起' : '展开'}</Text>
                  </Pressable>
                </View>
                {sourceTraceOpen ? (
                  <View style={styles.sourceTraceBody}>
                    {sourceTrace?.details.length ? (
                      sourceTrace.details.map((detail) => (
                        <View key={detail.memoryId} style={styles.sourceTraceCard}>
                          <Text style={styles.sourceTraceRange}>
                            {detail.mode === 'exact'
                              ? `直接引用 · ${detail.directCount} 句 · 继承引用 · ${detail.derivedCount} 句`
                              : detail.mode === 'legacy_range'
                                ? memorySourceStatusLabel.legacy_range
                                : '非聊天来源'}
                            {typeof detail.sourceStartAt === 'number' && typeof detail.sourceEndAt === 'number'
                              ? ` · ${formatSourceTraceTime(detail.sourceStartAt)} - ${formatSourceTraceTime(detail.sourceEndAt)}` : ''}
                          </Text>
                          {!detail.messages.length ? <Text style={styles.sourceTraceMissingTag}>{memorySourceStatusLabel.missing}</Text> : null}
                          {detail.messages.map((message, messageIndex) => (
                            <View
                              key={`${detail.memoryId}-${message.sessionId}-${message.messageId}-${messageIndex}`}
                              style={[styles.sourceTraceMessage, !message.available && styles.sourceTraceMissingMessage]}
                            >
                              <View style={styles.sourceTraceMessageHeader}>
                                <Text style={styles.sourceTraceRole}>
                                  {message.sessionId.startsWith('letter:') ? '信件原文 · ' : ''}{formatSourceTraceRole(message.role)} · {formatSourceTraceTime(message.createdAt)}
                                </Text>
                                <Text style={message.available ? styles.sourceTraceMatched : styles.sourceTraceMissingTag}>
                                  {deletedGiftSources.has(message.sessionId) ? '礼物来源已删除'
                                    : memorySourceStatusLabel[getMemorySourceStatus({ ...message, mode: detail.mode })]}
                                </Text>
                              </View>
                              <Text style={styles.sourceTraceContent}>
                                {message.content || memorySourceStatusLabel.missing}
                              </Text>
                              {!message.available ? (
                                <Text style={styles.sourceTraceNote}>原消息已删除或不可用，不会改连到附近消息。</Text>
                              ) : null}
                            </View>
                          ))}
                        </View>
                      ))
                    ) : selected.source === 'history-import' ? (
                      <Pressable onPress={() => void openHistorySource({ memoryId: selected.id })} style={styles.sourceTraceToggle}>
                        <Text style={styles.sourceTraceToggleText}>查看导入原文件</Text>
                      </Pressable>
                    ) : selected.sourceTraceMode === 'none' ? (
                      <Text style={styles.healthHint}>这条记忆不是从聊天消息生成的，不会扫描聊天仓库或虚构原句。</Text>
                    ) : typeof selected.sourceStartAt !== 'number' || typeof selected.sourceEndAt !== 'number' ? (
                      <Text style={styles.healthHint}>旧数据暂无来源。这页可能是早期记忆、手动补记，或者保存时还没有来源时间。</Text>
                    ) : sourceTrace?.debug.missingMessages ? (
                      <Text style={styles.healthHint}>这页有来源时间，但本地聊天里暂时没有找到对应片段。</Text>
                    ) : !sourceTrace ? (
                      <Text style={styles.healthHint}>来源片段暂时没有加载成功，不影响记忆本身。</Text>
                    ) : (
                      <Text style={styles.healthHint}>暂时没有可展示的来源片段。</Text>
                    )}
                    <View style={styles.sourceCorrectionActions}>
                      <Pressable onPress={() => openSourceCorrectionDialog('correction')} style={styles.sourceCorrectionButton}>
                        <Text style={styles.sourceCorrectionButtonText}>AI理解错了</Text>
                      </Pressable>
                      <Pressable onPress={() => openSourceCorrectionDialog('outdated')} style={styles.sourceCorrectionButton}>
                        <Text style={styles.sourceCorrectionButtonText}>来源过期了</Text>
                      </Pressable>
                      <Pressable onPress={confirmArchiveWrongSource} style={styles.sourceCorrectionDangerButton}>
                        <Text style={styles.sourceCorrectionDangerText}>不该保存</Text>
                      </Pressable>
                      <Pressable onPress={() => makeCorrectionCandidateFromSource()} style={styles.sourceCorrectionButton}>
                        <Text style={styles.sourceCorrectionButtonText}>重新整理候选</Text>
                      </Pressable>
                      {selected.sourceTraceMode !== 'none' ? (
                        <Pressable onPress={() => void openSourceSelection()} style={styles.sourceCorrectionButton}>
                          <Text style={styles.sourceCorrectionButtonText}>重选来源</Text>
                        </Pressable>
                      ) : null}
                    </View>
                    {sourceCorrectionCandidate ? (
                      <View style={styles.sourceCorrectionCard} pointerEvents={draftSaving ? 'none' : 'auto'}>
                        {editConflict ? <MemoryEditComparison memory={editConflict} onReviewed={acceptEditComparison} /> : null}
                        {draftSaveError ? <Text accessibilityRole="alert" style={styles.operationNotice}>{draftSaveError}</Text> : null}
                        <Text style={styles.healthSectionTitle}>来源修正候选</Text>
                        <Text style={styles.healthHint}>这只是草稿，保存前不会改原记忆。</Text>
                        <TextInput
                          onChangeText={(value) => updateSourceCorrectionCandidate({ title: value })}
                          placeholder="候选标题"
                          placeholderTextColor={colors.muted}
                          style={styles.input}
                          value={sourceCorrectionCandidate.title}
                        />
                        <TextInput
                          multiline
                          onChangeText={(value) => updateSourceCorrectionCandidate({ content: value })}
                          placeholder="修正后的理解"
                          placeholderTextColor={colors.muted}
                          style={[styles.input, styles.reasonInput]}
                          value={sourceCorrectionCandidate.content}
                        />
                        <TextInput
                          multiline
                          onChangeText={(value) => updateSourceCorrectionCandidate({ rememberedReason: value })}
                          placeholder="为什么这样修正"
                          placeholderTextColor={colors.muted}
                          style={[styles.input, styles.reasonInput]}
                          value={sourceCorrectionCandidate.rememberedReason ?? ''}
                        />
                        <View style={styles.sourceCorrectionCandidateActions}>
                          <Pressable disabled={draftSaving || !!editConflict} onPress={confirmUpdateMemoryFromSourceCandidate} style={styles.primaryButton}>
                            <Text style={styles.primaryButtonText}>{draftSaving ? '正在保存…' : '更新原记忆'}</Text>
                          </Pressable>
                          <Pressable onPress={() => void saveSourceCorrectionCandidateAsComment()} style={styles.secondaryButton}>
                            <Text style={styles.secondaryButtonText}>只加年轮</Text>
                          </Pressable>
                          <Pressable onPress={discardSourceCorrectionCandidate} style={styles.deleteButton}>
                            <Text style={styles.deleteText}>舍弃草稿</Text>
                          </Pressable>
                        </View>
                      </View>
                    ) : null}
                    <Text style={styles.sourceTraceNote}>来源片段只用来查看和纠错，不会自动改写记忆正文，也不会增加参考次数。</Text>
                  </View>
                ) : (
                  <Text style={styles.healthHint}>展开后可以看这页记忆当初从哪段话摘下来。</Text>
                )}
              </View>
              <View style={styles.healthPanel}>
                <View style={styles.healthHeader}>
                  <Text style={styles.healthTitle}>记忆体检</Text>
                  <Text style={styles.healthMeta}>
                    {dehydrationDiagnostic?.eligible ? '可以整理' : '先不整理'}
                  </Text>
                </View>
                <Text style={styles.healthLine}>
                  正文 {dehydrationDiagnostic?.contentLength ?? selected.content.trim().length} 字
                  {' · '}{selected.lastActiveAt > 0 ? `距上次参考 ${dehydrationDiagnostic?.inactiveDays ?? 0} 天` : '尚未参考'}
                  {' · '}整理门槛 {dehydrationDiagnostic?.minContentLength ?? 180} 字 / {dehydrationDiagnostic?.minInactiveDays ?? 30} 天
                </Text>
                <Text style={styles.healthHint}>
                  为什么留下：{selected.rememberedReason?.trim() || '还没有写下留下理由'}
                </Text>
                <Text style={styles.healthHint}>
                  长期坐标：{selected.anchor ? formatAnchorCoordinate(selected.anchorKind) : '未设为长期坐标'}
                </Text>
                <View style={styles.tags}>
                  <Text style={dehydrationDiagnostic?.eligible ? styles.activeTag : styles.coolTag}>
                    {dehydrationDiagnostic?.eligible ? '旧长记忆候选' : '暂不进旧记忆整理'}
                  </Text>
                  {selected.digested ? <Text style={styles.coolTag}>已消化</Text> : null}
                  {selected.surfaceSuppressedUntil && selected.surfaceSuppressedUntil > Date.now() ? (
                    <Text style={styles.coolTag}>浮现冷却到 {formatShortDate(selected.surfaceSuppressedUntil)}</Text>
                  ) : null}
                  {selected.surfaceMutedAt ? <Text style={styles.coolTag}>别主动提 {formatShortDate(selected.surfaceMutedAt)}</Text> : null}
                  {dehydrationDiagnostic?.latestDehydrationAt ? (
                    <Text style={styles.warmTag}>压缩年轮 {formatShortDate(dehydrationDiagnostic.latestDehydrationAt)}</Text>
                  ) : null}
                  {qualitySignals?.lastConfirmedAt ? (
                    <Text style={styles.activeTag}>近期确认 {qualitySignals.confirmedCount} 次</Text>
                  ) : null}
                  {qualitySignals?.lastCorrectedAt ? (
                    <Text style={styles.warmTag}>最近被纠正 {formatShortDate(qualitySignals.lastCorrectedAt)}</Text>
                  ) : null}
                  {qualitySignals?.lastOutdatedAt ? (
                    <Text style={styles.coolTag}>历史背景 {formatShortDate(qualitySignals.lastOutdatedAt)}</Text>
                  ) : null}
                </View>
                {dehydrationDiagnostic && !dehydrationDiagnostic.eligible ? (
                  <Text style={styles.healthHint}>
                    原因：{dehydrationDiagnostic.reasons.map(formatDehydrationReason).join('、')}
                  </Text>
                ) : (
                  <Text style={styles.healthHint}>这类记忆会被“整理旧记忆”压成一圈年轮，原文仍然保留。</Text>
                )}
                <Text style={styles.healthHint}>
                  提起 {selected.surfaceCount ?? 0} 次 · 上次提起 {selected.lastMentionedAt ? formatShortDate(selected.lastMentionedAt) : '未记录'}
                </Text>
                {qualitySignals && (qualitySignals.correctedCount || qualitySignals.outdatedCount || qualitySignals.confirmedCount) ? (
                  <Text style={styles.healthHint}>
                    质量回路：确认 {qualitySignals.confirmedCount} 次 · 纠正 {qualitySignals.correctedCount} 次 · 过期 {qualitySignals.outdatedCount} 次
                  </Text>
                ) : null}
                {healthReport ? (
                  <View style={styles.healthReportBox}>
                    <Text style={styles.healthSectionTitle}>这条记忆怎么被使用</Text>
                    <Text style={styles.healthHint}>
                      平时会不会被白云想到：{healthReport.recall.eligible ? '可以在相关聊天里想起' : '普通聊天会先避开'}
                    </Text>
                    <Text style={styles.healthHint}>
                      容易想起的原因：{formatReportList(healthReport.recall.reasons, '暂时没有明显加分项')}
                    </Text>
                    {healthReport.recall.blockers.length ? (
                      <Text style={styles.healthHint}>
                        暂时想不起的原因：{formatReportList(healthReport.recall.blockers, '没有明显阻碍')}
                      </Text>
                    ) : null}
                    <Text style={styles.healthHint}>
                      会不会主动拿出来关心：{formatSurfacingMode(healthReport.surfacing.mode)}
                      {healthReport.surfacing.blockers.length ? ` · ${healthReport.surfacing.blockers.join('、')}` : ''}
                    </Text>
                    <Text style={styles.healthHint}>
                      最近有没有被确认或纠正：确认 {healthReport.quality.confirmedCount} 次 · 纠正 {healthReport.quality.correctedCount} 次 · 过期 {healthReport.quality.outdatedCount} 次
                    </Text>
                    <Text style={styles.healthHint}>
                      关系和整理状态：{healthReport.graphWarnings.length ? healthReport.graphWarnings.join('、') : '关系边安静'}
                      {' · '}
                      {healthReport.maintenance.dehydrationEligible
                        ? '可整理旧长记忆'
                        : `暂不整理：${healthReport.maintenance.blockers.map((reason) => formatDehydrationReason(reason as MemoryDehydrationBlockReason)).join('、') || '条件未满足'}`}
                    </Text>
                    {healthReport.queryFit ? (
                      <Text style={styles.healthHint}>
                        按当前搜索词会不会找到它：{healthReport.queryFit.matched
                          ? formatReportList(healthReport.queryFit.reasons, '匹配')
                          : formatReportList(healthReport.queryFit.blockers, '可能不会被这句搜到')}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View style={styles.graphPanel}>
                <View style={styles.healthHeader}>
                  <Text style={styles.healthTitle}>关系图谱</Text>
                  <View style={styles.graphHeaderActions}>
                    <Pressable onPress={() => openStarMap('local', selected.id)} style={styles.graphRepairButton}>
                      <Text style={styles.graphRepairText}>打开星图</Text>
                    </Pressable>
                    <Text style={styles.healthMeta}>{graphLinks.length ? `${graphLinks.length} 条` : '安静'}</Text>
                  </View>
                </View>
                {!graphLinks.length ? (
                  <Text style={styles.healthHint}>暂时没有明显关系。</Text>
                ) : graphLinks.map((link) => (
                  <View key={link.edge.id} style={styles.graphLinkCard}>
                    <View style={styles.memoryTop}>
                      <Text numberOfLines={1} style={styles.graphLinkTitle}>{link.memory.title}</Text>
                      <Text style={styles.graphConfidence}>{Math.round(link.edge.confidence * 100)}%</Text>
                    </View>
                    <View style={styles.tags}>
                      <Text style={link.diagnostic.severity === 'warning' ? styles.warmTag : link.diagnostic.severity === 'weak' ? styles.coolTag : styles.activeTag}>
                        {formatRelationType(link.edge.relationType)}
                      </Text>
                      <Text style={styles.cueTag}>{link.direction === 'outgoing' ? '从这页连出' : '连向这页'}</Text>
                      {link.diagnostic.tags.map((tag) => (
                        <Text key={`${link.edge.id}-${tag}`} style={tag === '强关系' ? styles.activeTag : tag === '弱关系' || tag === '目标已归档' || tag === '时间顺序可疑' ? styles.warmTag : styles.tag}>
                          {tag}
                        </Text>
                      ))}
                    </View>
                    {link.edge.reason ? <Text style={styles.healthHint}>原因：{link.edge.reason}</Text> : null}
                    {link.diagnostic.note ? <Text style={styles.healthHint}>{link.diagnostic.note}</Text> : null}
                    <View style={styles.graphRepairRow}>
                      <Pressable
                        onPress={() => void reverseGraphLink(link.edge.id)}
                        style={styles.graphRepairButton}
                      >
                        <Text style={styles.graphRepairText}>方向反了</Text>
                      </Pressable>
                      {link.edge.relationType !== 'relates_to' ? (
                        <Pressable
                          onPress={() => void softenGraphLink(link.edge.id)}
                          style={styles.graphRepairButton}
                        >
                          <Text style={styles.graphRepairText}>改为相关</Text>
                        </Pressable>
                      ) : null}
                      <Pressable
                        onPress={() => removeGraphLink(link.edge.id)}
                        style={styles.graphRepairButton}
                      >
                        <Text style={styles.graphRepairText}>隐藏关系</Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </View>
              <View style={styles.actionGrid}>
                <Pressable onPress={() => void rebuildSelectedEmbedding()} style={styles.mergeButton}>
                  <Text style={styles.mergeButtonText}>重建向量</Text>
                </Pressable>
                <Pressable onPress={() => void toggleSelectedDigested()} style={styles.mergeButton}>
                  <Text style={styles.mergeButtonText}>{selected.digested ? '取消消化' : '标记消化'}</Text>
                </Pressable>
                <Pressable onPress={() => void toggleSelectedSurfaceMuted()} style={styles.mergeButton}>
                  <Text style={styles.mergeButtonText}>{selected.surfaceMutedAt ? '允许主动提' : '别主动提'}</Text>
                </Pressable>
                <Pressable onPress={() => void createCurrentStateFromSelectedMemory()} style={styles.mergeButton}>
                  <Text style={styles.mergeButtonText}>转当前状态</Text>
                </Pressable>
                <Pressable onPress={() => void toggleSelectedArchive()} style={styles.mergeButton}>
                  <Text style={styles.mergeButtonText}>
                    {selected.type === 'archived' ? mergeRecovery ? '撤销合并' : '恢复' : '归档'}
                  </Text>
                </Pressable>
              </View>
              <Pressable onPress={() => setMergeOpen((value) => !value)} style={styles.mergeButton}>
                <Text style={styles.mergeButtonText}>{mergeOpen ? '收起合并选择' : '合并相似记忆'}</Text>
              </Pressable>
              </>
              ) : null}
            </View>
          )}

          {detailAdvancedOpen && mergeOpen && !editing ? (
            <View style={styles.mergePanel}>
              <Text style={styles.editorTitle}>把另一页收进这一页</Text>
              <Text style={styles.mergeHint}>当前这一页会留下，另一页会变成年轮，不会凭空消失。</Text>
              <TextInput
                onChangeText={setMergeQuery}
                placeholder="搜索准备合并的记忆..."
                placeholderTextColor={colors.muted}
                style={[styles.input, styles.searchInput]}
                value={mergeQuery}
              />
              {!mergeCandidates.length ? <Text style={styles.empty}>没有找到可以合并的另一页。</Text> : null}
              {mergeCandidates.map((memory) => (
                <Pressable key={memory.id} onPress={() => confirmMerge(memory)} style={styles.mergeCandidate}>
                  <View style={styles.memoryTop}>
                    <Text style={styles.domainBadge}>{memory.domain}</Text>
                    <Text style={styles.mergePick}>选它合并</Text>
                  </View>
                  <Text style={styles.cardTitle}>{memory.title}</Text>
                  <Text numberOfLines={2} style={styles.memoryContent}>{memory.content}</Text>
                </Pressable>
              ))}
            </View>
          ) : null}

          <View style={styles.ringsHeader}>
            <Text style={styles.listTitle}>年轮</Text>
            <Text style={styles.ringHint}>后来想补上的话</Text>
          </View>
          <View style={styles.commentComposer}>
            <TextInput
              multiline
              onChangeText={setCommentText}
              placeholder="今天又想起这一页时，补上一点什么..."
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.commentInput]}
              value={commentText}
            />
            {commentSaveError ? <Text accessibilityRole="alert" style={styles.operationNotice}>{commentSaveError}</Text> : null}
            <Pressable disabled={commentSaving || !commentText.trim()} onPress={() => void addComment()} style={[styles.saveButton, (commentSaving || !commentText.trim()) && styles.disabledButton]}>
              <Text style={styles.saveText}>{commentSaving ? '正在保存…' : '添上一圈年轮'}</Text>
            </Pressable>
          </View>
          {!comments.length ? <Text style={styles.empty}>这里还没有年轮，第一次回望会从这里开始。</Text> : null}
          {comments.map((comment) => (
            <View key={comment.id} style={styles.commentCard}>
              <View style={styles.memoryTop}>
                <Text style={styles.source}>
                  {comment.kind === 'dehydration'
                    ? '压缩年轮'
                    : comment.kind === 'correction'
                      ? '纠正年轮'
                      : comment.kind === 'update'
                        ? '更新年轮'
                        : comment.kind === 'confirmation'
                          ? '确认年轮'
                          : comment.sourceType === 'chat'
                            ? '聊天补充'
                            : '手动写下'}
                </Text>
                <Text style={styles.memoryDate}>{formatDate(comment.createdAt)}</Text>
              </View>
              <Text style={styles.memoryContent}>{comment.content}</Text>
              <Pressable
                onPress={() => Alert.alert('删掉这一圈年轮？', '主记忆会继续保留。', [
                  { text: '取消', style: 'cancel' },
                  { text: '删除', style: 'destructive', onPress: async () => {
                    await deleteComment(comment.id);
                  } },
                ])}
                style={styles.commentDelete}
              >
                <Text style={styles.deleteText}>删除年轮</Text>
              </Pressable>
            </View>
          ))}
          {detailAdvancedOpen && selected.type === 'archived' ? (
            <Pressable
            onPress={() => Alert.alert(
              '彻底删除这页？',
              '这项操作无法恢复，会清除这页记忆、来源、年轮、足迹和关系。聊天消息和已经独立保存的当前状态不会一起删除；已经成为另一条独立记忆的内容需要单独处理。',
              [
                { text: '取消', style: 'cancel' },
                { text: '彻底删除', style: 'destructive', onPress: () => void deleteSelectedMemory() },
              ],
            )}
            style={styles.removeMemory}
          >
            <Text style={styles.deleteText}>彻底删除这页</Text>
          </Pressable>
          ) : null}
        </ScrollView>
        {memoryDrawer}
        {starMapModal}
        {togetherWalkedModal}
        {topicProfilesModal}
        {memoryCatalogModal}
        {maintenanceCenterModal}
        {sourceCorrectionModal}
        {historySourceModal}
        {sourceSelectionModal}
        {abilityMapModal}
      </View>
    );
  }

  return (
    <View style={styles.page}>
      <View style={styles.header}>
        <Pressable onPress={() => setDrawerVisible(true)} style={styles.backButton}><Text style={styles.menuText}>☰</Text></Pressable>
        <View>
          <Text style={styles.title}>记忆</Text>
          <Text style={styles.subtitle}>被认真保存下来的事</Text>
        </View>
        <Pressable
          onPress={() => {
            if (mode === 'timeline') {
              setTimelineCreating((value) => !value);
              setTimelineTitle('');
              setTimelineSearch('');
              setTimelineSelectedIds([]);
            } else {
              beginNew();
            }
          }}
          style={styles.addButton}
        >
          <Text style={styles.addText}>+</Text>
        </Pressable>
      </View>

      <ScrollView horizontal contentContainerStyle={styles.modeBarContent} showsHorizontalScrollIndicator={false} style={styles.modeBar}>
        {([
          ['calendar', '日历'],
          ['pinned', '钉住'],
          ['active', '活跃'],
          ['all', '全部'],
          ['timeline', '时间轴'],
          ['weekly', '周回顾'],
          ['archived', '归档'],
        ] as Array<[ViewMode, string]>).map(([value, label]) => (
          <Pressable key={value} onPress={() => { setMode(value); setDomain(undefined); setQuery(''); }} style={[styles.modeButton, mode === value && styles.modeButtonActive]}>
            <Text style={[styles.modeText, mode === value && styles.modeTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        {mode === 'weekly' ? <MemoryWeeklyBrowser onSaved={refresh} /> : null}
        {refreshNotice ? <Pressable disabled={refreshing} onPress={() => void retryRefresh()}><Text accessibilityRole="alert" style={styles.operationNotice}>{refreshing ? '正在刷新…' : refreshNotice}</Text></Pressable> : null}
        {(creating || editing) ? (
          <MemoryEditor
            draft={draft}
            editing={editing}
            saving={draftSaving}
            saveError={draftSaveError}
            conflict={editConflict}
            onReviewed={acceptEditComparison}
            onCancel={cancelEdit}
            onChange={setDraft}
            onSave={() => void saveDraft()}
            onRecallCuesChange={setRecallCuesText}
            onTagsChange={setTagsText}
            recallCuesText={recallCuesText}
            tagsText={tagsText}
          />
        ) : null}

        {mode === 'calendar' ? (
          <CalendarView
            markedDates={markedDates}
            memories={dateMemories}
            month={month}
            onMonthChange={changeMonth}
            onOpenMemory={openMemory}
            onSelectDate={setSelectedDate}
            selectedDate={selectedDate}
          />
        ) : mode === 'timeline' ? (
          <>
            {timelineCreating ? (
              <View style={styles.timelineEditorPanel}>
                <Text style={styles.editorTitle}>新建事件线</Text>
                <Text style={styles.mergeHint}>给事件起一个名字，再从记忆库中挑选起点或已有进展。</Text>
                <TextInput
                  onChangeText={setTimelineTitle}
                  placeholder="例如：君落 App 的开发"
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  value={timelineTitle}
                />
                {timelineSelectedIds.length ? (
                  <View style={styles.timelineSelectedList}>
                    {timelineSelectedIds.map((id, index) => {
                      const memory = memories.find((item) => item.id === id);
                      if (!memory) return null;
                      return (
                        <Pressable
                          key={id}
                          onPress={() => setTimelineSelectedIds((current) => current.filter((item) => item !== id))}
                          style={styles.selectedMemoryChip}
                        >
                          <Text style={styles.selectedMemoryText}>{index + 1}. {memory.title} ×</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                <TextInput
                  onChangeText={setTimelineSearch}
                  placeholder="搜索要拉入的记忆..."
                  placeholderTextColor={colors.muted}
                  style={styles.input}
                  value={timelineSearch}
                />
                {timelineCandidates.map((memory) => (
                  <Pressable
                    key={memory.id}
                    onPress={() => setTimelineSelectedIds((current) => [...current, memory.id])}
                    style={styles.mergeCandidate}
                  >
                    <Text style={styles.cardTitle}>{memory.title}</Text>
                    <Text numberOfLines={2} style={styles.memoryContent}>{memory.content}</Text>
                    <Text style={styles.mergePick}>选作事件进展</Text>
                  </Pressable>
                ))}
                <View style={styles.editorActions}>
                  <Pressable
                    disabled={!timelineTitle.trim() || !timelineSelectedIds.length}
                    onPress={() => void createTimeline()}
                    style={[
                      styles.primaryButton,
                      (!timelineTitle.trim() || !timelineSelectedIds.length) && styles.disabledButton,
                    ]}
                  >
                    <Text style={styles.primaryButtonText}>建立时间轴</Text>
                  </Pressable>
                  <Pressable onPress={() => setTimelineCreating(false)} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>取消</Text>
                  </Pressable>
                </View>
              </View>
            ) : null}
            <TimelineView
              loaded={loaded}
              onOpenThread={openThread}
              threads={threads}
            />
          </>
        ) : (
          <>
            <TextInput
              onChangeText={setQuery}
              placeholder={mode === 'all' ? '搜索后展开全部记忆...' : '搜索一段话、一个标签...'}
              placeholderTextColor={colors.muted}
              style={[styles.input, styles.searchInput]}
              value={query}
            />
            {mode !== 'archived' && mode !== 'weekly' ? (
              <View style={styles.editorActions}>
                <Pressable accessibilityRole="button" disabled={!query.trim() || meaningSearching}
                  onPress={() => void searchByMeaning()}
                  style={[styles.secondaryButton, (!query.trim() || meaningSearching) && styles.disabledButton]}>
                  <Text style={styles.secondaryButtonText}>{meaningSearching ? '查找中…' : '找意思相近的记忆'}</Text>
                </Pressable>
                {meaningSearching ? (
                  <Pressable accessibilityRole="button" onPress={cancelMeaningSearch} style={styles.secondaryButton}>
                    <Text style={styles.secondaryButtonText}>停止查找</Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            <Text accessibilityLiveRegion="polite" style={styles.panelHint}>
              {searchNotice || (mode === 'archived' || mode === 'weekly' ? '此页按文字查找，保留历史查看。' : '输入时只按文字查找；点击按钮后，才查找意思相近的记忆。')}
            </Text>
            {mode === 'all' ? (
              <Text style={styles.panelHint}>全部页默认收起。点一个领域或搜索一句话，再翻开对应的记忆。</Text>
            ) : null}
            {mode !== 'archived' && memoryTools.historyImport.documents.length ? (
              <View style={styles.historyImportPanel}>
                <View style={styles.healthHeader}>
                  <Text style={styles.healthTitle}>历史导入候选</Text>
                  <Text style={styles.healthMeta}>{memoryTools.historyImport.candidates.length} 张待确认</Text>
                </View>
                <Text style={styles.healthHint}>这些还没有写入记忆。鼠可以改一改，确认后再保存。</Text>
                {memoryTools.historyImport.notice ? <Text style={styles.healthHint}>{memoryTools.historyImport.notice}</Text> : null}
                {memoryTools.historyImport.documents.map((document) => (
                  <View key={document.id} style={styles.historyCandidateCard}>
                    <Text style={styles.healthSectionTitle}>{document.fileName}</Text>
                    <Text style={styles.score}>
                      已整理 {document.completedChunks}/{document.chunkCount} 块 · 待处理 {document.remainingChunks} 块
                      {document.failedChunks ? ` · 失败待重试 ${document.failedChunks} 块` : ''}
                    </Text>
                    <View style={styles.editorActions}>
                      <Pressable onPress={() => void openHistorySource({ importId: document.id })} style={styles.secondaryButton}>
                        <Text style={styles.secondaryButtonText}>原文件</Text>
                      </Pressable>
                      {document.remainingChunks ? (
                        <Pressable disabled={memoryTools.historyImport.importing || document.running} onPress={() => void continueHistoryImport(document.id)} style={styles.primaryButton}>
                          <Text style={styles.primaryButtonText}>{document.running ? '整理中' : '继续整理'}</Text>
                        </Pressable>
                      ) : null}
                    </View>
                  </View>
                ))}
                {memoryTools.historyImport.candidates.map((candidate) => (
                  <View key={candidate.reviewId} style={styles.historyCandidateCard}>
                    <Text style={styles.healthSectionTitle}>{candidate.fileName} · 第 {candidate.historyChunkIndex + 1} 块</Text>
                    <TextInput
                      onChangeText={(text) => memoryTools.historyImport.updateCandidate(candidate.reviewId, { title: text })}
                      placeholder="标题"
                      placeholderTextColor={colors.muted}
                      style={[styles.input, styles.historyCandidateInput]}
                      value={candidate.title}
                    />
                    <TextInput
                      multiline
                      onChangeText={(text) => memoryTools.historyImport.updateCandidate(candidate.reviewId, { content: text })}
                      placeholder="候选记忆正文"
                      placeholderTextColor={colors.muted}
                      style={[styles.input, styles.contentInput, styles.historyCandidateInput]}
                      value={candidate.content}
                    />
                    <TextInput
                      multiline
                      onChangeText={(text) => memoryTools.historyImport.updateCandidate(candidate.reviewId, { rememberedReason: text })}
                      placeholder="为什么留下"
                      placeholderTextColor={colors.muted}
                      style={[styles.input, styles.reasonInput, styles.historyCandidateInput]}
                      value={candidate.rememberedReason ?? ''}
                    />
                    <View style={styles.tags}>
                      <Text style={styles.cueTag}>{candidate.domain}</Text>
                      <Text style={candidate.tags.includes('阶段记忆') ? styles.warmTag : styles.tag}>
                      {candidate.tags.includes('阶段记忆') ? '阶段记忆' : '短记忆'}
                      </Text>
                      {candidate.admission ? (
                        <Text style={candidate.admission.status === 'admit' ? styles.activeTag : styles.warmTag}>
                          {candidate.admission.label}
                        </Text>
                      ) : null}
                      {candidate.duplicateHint ? <Text style={styles.warmTag}>{candidate.duplicateHint}</Text> : null}
                      {candidate.admission?.reasons.slice(0, 2).map((reason) => (
                        <Text key={`${candidate.reviewId}-${reason}`} style={styles.coolTag}>{reason}</Text>
                      ))}
                    </View>
                    <View style={styles.historyCandidateFooter}>
                      <View style={styles.importanceGroup}>
                        <Text style={styles.miniLabel}>重要度</Text>
                        <Pressable
                          onPress={() => memoryTools.historyImport.updateCandidate(candidate.reviewId, { importance: Math.max(1, candidate.importance - 1) })}
                          style={styles.stepButton}
                        >
                          <Text style={styles.stepText}>-</Text>
                        </Pressable>
                        <Text style={styles.importance}>{candidate.importance}</Text>
                        <Pressable
                          onPress={() => memoryTools.historyImport.updateCandidate(candidate.reviewId, { importance: Math.min(10, candidate.importance + 1) })}
                          style={styles.stepButton}
                        >
                          <Text style={styles.stepText}>+</Text>
                        </Pressable>
                      </View>
                      <View style={styles.editorActions}>
                        <Pressable
                          onPress={() => void memoryTools.historyImport.discardCandidate(candidate.reviewId)}
                          style={styles.deleteButton}
                        >
                          <Text style={styles.secondaryButtonText}>舍弃</Text>
                        </Pressable>
                        <Pressable
                          disabled={!candidate.content.trim()}
                          onPress={() => void saveHistoryImportCandidate(candidate)}
                          style={[styles.primaryButton, !candidate.content.trim() && styles.disabledButton]}
                        >
                          <Text style={styles.primaryButtonText}>保存</Text>
                        </Pressable>
                      </View>
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
            {mode !== 'archived' ? <ScrollView horizontal contentContainerStyle={styles.domainRow} showsHorizontalScrollIndicator={false}>
              <Pressable onPress={() => setDomain(undefined)} style={[styles.filterPill, !domain && styles.filterPillActive]}>
                <Text style={[styles.filterText, !domain && styles.filterTextActive]}>全部</Text>
              </Pressable>
              {MEMORY_DOMAINS.map((item) => (
                <Pressable key={item} onPress={() => setDomain(item)} style={[styles.filterPill, domain === item && styles.filterPillActive]}>
                  <Text style={[styles.filterText, domain === item && styles.filterTextActive]}>{item}</Text>
                </Pressable>
              ))}
            </ScrollView> : null}
            <Text style={styles.listTitle}>{mode === 'pinned' ? '长期会想起的事' : mode === 'active' ? '最近参考过的记忆' : mode === 'archived' ? '已经归档的事' : '白云小姐记得的事'}</Text>
            {!loaded && !refreshNotice ? <Text style={styles.empty}>正在翻开记忆本...</Text> : null}
            {loaded && mode === 'all' && !query.trim() && !domain ? (
              <DomainEntryGrid memories={filteredMemories} onPick={setDomain} />
            ) : null}
            {loaded && (mode !== 'all' || query.trim() || domain) && !filteredMemories.length ? (
              <Text style={styles.empty}>
                这一页暂时还是空白的。
              </Text>
            ) : null}
            {(mode !== 'all' || query.trim() || domain) ? filteredMemories.map((memory) => (
              <MemoryCard
                key={memory.id}
                memory={memory}
                onArchiveToggle={async () => {
                  await toggleMemoryArchive(memory);
                }}
                onPress={() => void openMemory(memory)}
              />
            )) : null}
          </>
        )}
      </ScrollView>
      {memoryDrawer}
      {starMapModal}
      {togetherWalkedModal}
      {topicProfilesModal}
      {memoryCatalogModal}
      {maintenanceCenterModal}
      {sourceSelectionModal}
      {abilityMapModal}
      {historySourceModal}
    </View>
  );
}

function TimelineView({
  loaded,
  onOpenThread,
  threads,
}: {
  loaded: boolean;
  onOpenThread: (thread: EventThread) => Promise<void>;
  threads: EventThread[];
}) {
  if (!loaded) return <Text style={styles.empty}>正在整理时间轴...</Text>;
  if (!threads.length) return <Text style={styles.empty}>还没有形成连续事件。等白云小姐把同一件事的前后文连起来，这里就会长出时间轴。</Text>;
  return (
    <>
      <Text style={styles.listTitle}>正在展开的事件线</Text>
      {threads.map((thread) => (
        <Pressable key={thread.id} onPress={() => void onOpenThread(thread)} style={styles.threadCard}>
          <View style={styles.memoryTop}>
            <View style={styles.threadBadgeRow}>
              {thread.manual ? <Text style={styles.manualThreadTag}>手动整理</Text> : null}
            </View>
            <Text style={styles.memoryDate}>事件时间：{thread.eventStartAt === undefined ? '日期未知' : formatDate(thread.eventStartAt)}</Text>
          </View>
          <Text style={styles.cardTitle}>{thread.title}</Text>
          <Text numberOfLines={2} style={styles.memoryContent}>{thread.latestText}</Text>
          <Text style={styles.score}>{thread.memoryIds.length} 条记忆 · 保存 {formatDate(thread.savedAt)} · 记录更新 {formatDate(thread.updatedAt)}</Text>
        </Pressable>
      ))}
    </>
  );
}

function MemorySystemHealthCard({
  health,
  onAction,
}: {
  health: MemorySystemHealthSnapshot;
  onAction: (target: NonNullable<MemorySystemHealthSnapshot['items'][number]['actionTarget']>) => void;
}) {
  const visibleItems = health.items.slice(0, 3);
  return (
    <View style={[
      styles.systemHealthPanel,
      health.overall === 'blocked' && styles.systemHealthBlocked,
      health.overall === 'warning' && styles.systemHealthWarning,
    ]}>
      <View style={styles.healthHeader}>
        <View style={styles.systemHealthTitleWrap}>
          <Text style={styles.healthTitle}>记忆系统状态</Text>
          <Text style={styles.systemHealthTitle}>{health.title}</Text>
        </View>
        <Text style={[
          styles.systemHealthBadge,
          health.overall === 'blocked' && styles.systemHealthBadgeBlocked,
          health.overall === 'warning' && styles.systemHealthBadgeWarning,
        ]}>
          {health.overall === 'ok' ? '正常' : health.overall === 'warning' ? '提醒' : '需配置'}
        </Text>
      </View>
      <Text style={styles.healthHint}>{health.summary}</Text>
      <View style={styles.systemHealthItems}>
        {visibleItems.map((item) => (
          <View key={item.kind} style={styles.systemHealthItem}>
            <Text style={[
              styles.systemHealthDot,
              item.severity === 'blocked' && styles.systemHealthDotBlocked,
              item.severity === 'warning' && styles.systemHealthDotWarning,
            ]}>
              ●
            </Text>
            <View style={styles.systemHealthItemText}>
              <Text style={styles.systemHealthItemTitle}>{item.title}</Text>
              <Text style={styles.healthHint}>{item.detail}</Text>
              {item.actionLabel && item.actionTarget ? (
                <Pressable onPress={() => onAction(item.actionTarget!)} style={styles.systemHealthAction}>
                  <Text style={styles.systemHealthActionText}>{item.actionLabel}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function DomainEntryGrid({ memories, onPick }: { memories: MemoryEntry[]; onPick: (domain: MemoryDomain) => void }) {
  const counts = MEMORY_DOMAINS.map((domain) => ({
    domain,
    count: memories.filter((memory) => memory.domain === domain && !isWhisperMemory(memory)).length,
  })).filter((item) => item.count > 0);
  if (!counts.length) return <Text style={styles.empty}>还没有普通记忆可以展开。</Text>;
  return (
    <View style={styles.domainGrid}>
      {counts.map((item) => (
        <Pressable key={item.domain} onPress={() => onPick(item.domain)} style={styles.domainEntry}>
          <Text style={styles.domainEntryTitle}>{item.domain}</Text>
          <Text style={styles.score}>{item.count} 条</Text>
        </Pressable>
      ))}
    </View>
  );
}

function MemoryCard({
  memory,
  onArchiveToggle,
  onPress,
}: {
  memory: MemoryEntry;
  onArchiveToggle?: () => Promise<void>;
  onPress: () => void;
}) {
  const warm = memory.importance >= 8 || memory.pinned || memory.type === 'permanent';
  const valence = memory.modelValence ?? memory.valence;
  return (
    <Pressable onPress={onPress} style={[styles.memoryCard, warm && styles.memoryCardImportant, memory.domain === '边界' && styles.memoryCardBoundary]}>
      <View style={styles.memoryTop}>
        <Text style={styles.domainBadge}>{memory.domain}</Text>
        <Text style={styles.memoryDate}>{getMemoryScreenTimeLabel(memory)}</Text>
      </View>
      <Text style={styles.cardTitle}>{memory.title}</Text>
      <Text numberOfLines={2} style={styles.memoryContent}>{memory.content}</Text>
      <View style={styles.tags}>
        {memory.understandingSubject ? <Text style={styles.tag}>{memory.understandingSubject === 'I' ? '白云小姐对自己的认识' : '白云小姐对小仓鼠的认识'}</Text> : null}
        {memory.pinned ? <Text style={styles.pinTag}>钉住</Text> : null}
        {memory.anchor ? <Text style={styles.anchorTag}>{formatAnchorCoordinate(memory.anchorKind)}</Text> : null}
        <Text style={valence >= 0.7 ? styles.warmTag : valence <= 0.3 ? styles.coolTag : styles.tag}>情绪 {valence.toFixed(1)}</Text>
        {memory.tags.slice(0, 3).map((tag) => <Text key={tag} style={styles.tag}>{tag}</Text>)}
      </View>
      <View style={styles.cardFooter}>
        <Text style={styles.score}>重要度 {memory.importance} · {memory.activationCount > 0 ? `参考 ${memory.activationCount} 次` : '尚未参考'}</Text>
        {onArchiveToggle ? (
          <Pressable onPress={() => void onArchiveToggle()} style={styles.archiveChip}>
            <Text style={styles.archiveChipText}>
              {memory.type === 'archived'
                ? memory.archiveReason === '被另一条记忆替代' ? '撤销合并' : '恢复'
                : '归档'}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Pressable>
  );
}

function CalendarView({
  markedDates,
  memories,
  month,
  onMonthChange,
  onOpenMemory,
  onSelectDate,
  selectedDate,
}: {
  markedDates: Set<string>;
  memories: MemoryEntry[];
  month: Date;
  onMonthChange: (month: Date) => void;
  onOpenMemory: (memory: MemoryEntry) => Promise<void>;
  onSelectDate: (date: Date) => void;
  selectedDate: Date;
}) {
  return (
    <>
      <View style={styles.calendar}>
        <View style={styles.calendarHeader}>
          <Pressable onPress={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))} style={styles.monthArrow}><Text style={styles.monthArrowText}>‹</Text></Pressable>
          <Text style={styles.calendarTitle}>{month.getFullYear()}年 {month.getMonth() + 1}月</Text>
          <Pressable onPress={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))} style={styles.monthArrow}><Text style={styles.monthArrowText}>›</Text></Pressable>
        </View>
        <View style={styles.weekRow}>
          {['日', '一', '二', '三', '四', '五', '六'].map((weekday) => <Text key={weekday} style={styles.weekday}>{weekday}</Text>)}
        </View>
        <View style={styles.days}>
          {calendarCells(month).map((day, index) => {
            const dayDate = day ? new Date(month.getFullYear(), month.getMonth(), day) : null;
            const selectedDay = dayDate && dateKey(dayDate) === dateKey(selectedDate);
            const marked = dayDate && markedDates.has(dateKey(dayDate));
            return (
              <Pressable
                disabled={!dayDate}
                key={`${day ?? 'blank'}-${index}`}
                onPress={() => dayDate && onSelectDate(dayDate)}
                style={[styles.dayCell, selectedDay && styles.daySelected]}
              >
                <Text style={[styles.dayText, selectedDay && styles.dayTextSelected]}>{day ?? ''}</Text>
                {marked ? <View style={[styles.dayDot, selectedDay && styles.dayDotSelected]} /> : null}
              </Pressable>
            );
          })}
        </View>
      </View>
      <Text style={styles.listTitle}>{selectedDate.toLocaleDateString('zh-CN')} 的记忆</Text>
      {!memories.length ? <Text style={styles.empty}>这天还没有收进记忆本的内容。</Text> : null}
      {memories.map((memory) => <MemoryCard key={memory.id} memory={memory} onPress={() => void onOpenMemory(memory)} />)}
    </>
  );
}

function MemoryEditor({
  conflict,
  onReviewed,
  draft,
  editing,
  saving,
  saveError,
  onCancel,
  onChange,
  onSave,
  onRecallCuesChange,
  onTagsChange,
  recallCuesText,
  tagsText,
}: {
  conflict: MemoryEntry | null;
  onReviewed: () => void;
  draft: MemoryDraft;
  editing: boolean;
  saving: boolean;
  saveError: string;
  onCancel: () => void;
  onChange: (value: MemoryDraft) => void;
  onSave: () => void;
  onRecallCuesChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  recallCuesText: string;
  tagsText: string;
}) {
  return (
    <View style={styles.editor} pointerEvents={saving ? 'none' : 'auto'}>
      <View style={styles.editorHeading}>
        <Text style={styles.editorTitle}>{editing ? '修改这一页' : '写下一页记忆'}</Text>
        <Pressable onPress={onCancel}><Text style={styles.editText}>收起</Text></Pressable>
      </View>
      {conflict ? <MemoryEditComparison memory={conflict} onReviewed={onReviewed} /> : null}
      <TextInput editable={!saving} onChangeText={(value) => onChange({ ...draft, title: value })} placeholder="记忆标题" placeholderTextColor={colors.muted} style={styles.input} value={draft.title} />
      <TextInput
        editable={!saving}
        multiline
        onChangeText={(value) => onChange({ ...draft, content: value })}
        placeholder="写下希望白云小姐记得的事..."
        placeholderTextColor={colors.muted}
        style={[styles.input, styles.contentInput]}
        textAlignVertical="top"
        value={draft.content}
      />
      <ScrollView horizontal contentContainerStyle={styles.domainRow} showsHorizontalScrollIndicator={false}>
        {MEMORY_DOMAINS.map((item) => (
          <Pressable key={item} onPress={() => onChange({ ...draft, domain: item })} style={[styles.filterPill, draft.domain === item && styles.filterPillActive]}>
            <Text style={[styles.filterText, draft.domain === item && styles.filterTextActive]}>{item}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <TextInput editable={!saving} onChangeText={onTagsChange} placeholder="标签，例如：称呼、睡眠、偏好" placeholderTextColor={colors.muted} style={styles.input} value={tagsText} />
      <TextInput editable={!saving} onChangeText={onRecallCuesChange} placeholder="想起词，例如：鼻塞、打喷嚏、过敏" placeholderTextColor={colors.muted} style={styles.input} value={recallCuesText} />
      <TextInput
        editable={!saving}
        multiline
        onChangeText={(value) => onChange({ ...draft, rememberedReason: value })}
        placeholder="为什么留下这一页？可以留空"
        placeholderTextColor={colors.muted}
        style={[styles.input, styles.reasonInput]}
        textAlignVertical="top"
        value={draft.rememberedReason ?? ''}
      />
      <View style={styles.settingRow}>
        <View style={styles.importanceGroup}>
          <Text style={styles.miniLabel}>重要度</Text>
          <Pressable onPress={() => onChange({ ...draft, importance: Math.max(1, draft.importance - 1) })} style={styles.stepButton}><Text style={styles.stepText}>-</Text></Pressable>
          <Text style={styles.importance}>{draft.importance}</Text>
          <Pressable onPress={() => onChange({ ...draft, importance: Math.min(10, draft.importance + 1) })} style={styles.stepButton}><Text style={styles.stepText}>+</Text></Pressable>
        </View>
        <View style={styles.toggleRow}>
          <Pressable
            onPress={() => {
              const nextAnchor = !draft.anchor;
              onChange({
                ...draft,
                anchor: nextAnchor,
                anchorKind: nextAnchor ? draft.anchorKind ?? inferAnchorKindFromDomain(draft.domain) : undefined,
              });
            }}
            style={[styles.pinButton, draft.anchor && styles.anchorButtonActive]}
          >
            <Text style={[styles.pinText, draft.anchor && styles.pinTextActive]}>
              {draft.anchor ? formatAnchorCoordinate(draft.anchorKind) : '长期锚点'}
            </Text>
          </Pressable>
          <Pressable onPress={() => onChange({ ...draft, pinned: !draft.pinned })} style={[styles.pinButton, draft.pinned && styles.pinButtonActive]}>
            <Text style={[styles.pinText, draft.pinned && styles.pinTextActive]}>钉住</Text>
          </Pressable>
        </View>
      </View>
      {draft.anchor ? (
        <ScrollView horizontal contentContainerStyle={styles.anchorKindRow} showsHorizontalScrollIndicator={false}>
          {MEMORY_ANCHOR_KINDS.map((kind) => (
            <Pressable
              key={kind}
              onPress={() => onChange({ ...draft, anchor: true, anchorKind: kind })}
              style={[styles.anchorKindPill, (draft.anchorKind ?? 'other') === kind && styles.anchorKindPillActive]}
            >
              <Text style={[styles.anchorKindText, (draft.anchorKind ?? 'other') === kind && styles.anchorKindTextActive]}>
                {formatAnchorCoordinate(kind)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {saveError ? <Text accessibilityRole="alert" style={styles.operationNotice}>{saveError}</Text> : null}
      <Pressable disabled={saving || !!conflict || !draft.content.trim()} onPress={onSave} style={[styles.saveButton, (saving || !!conflict || !draft.content.trim()) && styles.disabledButton]}>
        <Text style={styles.saveText}>{saving ? '正在保存…' : editing ? '保存修改' : '保存记忆'}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  operationNotice: { color: '#B65F58', fontSize: 13, lineHeight: 19, paddingVertical: 6 },
  page: { flex: 1, backgroundColor: '#FFF9F4', paddingTop: 42, paddingHorizontal: 18 },
  starMapPage: { flex: 1, backgroundColor: '#F5FAFF' },
  header: { height: 57, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 },
  starMapHeader: { height: 57, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13 },
  backButton: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.cardStrong },
  backText: { color: colors.ink, fontSize: 29, lineHeight: 32 },
  menuText: { color: colors.ink, fontSize: 22, lineHeight: 25, fontWeight: '700' },
  title: { color: colors.ink, fontSize: 25, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: colors.muted, fontSize: 11, textAlign: 'center', marginTop: 2 },
  addButton: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFE3DB', alignItems: 'center', justifyContent: 'center' },
  addText: { color: '#D87767', fontSize: 25, lineHeight: 26 },
  editAction: { color: '#D87767', fontSize: 14, fontWeight: '700' },
  abilityMapOverlay: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(31, 34, 44, 0.26)', paddingHorizontal: 16 },
  abilityMapBackdrop: { ...StyleSheet.absoluteFillObject },
  abilityMapPanel: { width: '100%', maxWidth: 560, borderRadius: 22, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 15, shadowColor: '#2F3852', shadowOpacity: 0.16, shadowRadius: 18, elevation: 10 },
  abilityMapHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  abilityMapTitleWrap: { flex: 1, gap: 3 },
  abilityMapEyebrow: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  abilityMapTitle: { color: colors.ink, fontSize: 20, fontWeight: '700', lineHeight: 26 },
  abilityMapClose: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1 },
  abilityMapCloseText: { color: '#6B8BAA', fontSize: 22, lineHeight: 24 },
  abilityMapIntro: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 9, marginBottom: 10 },
  abilityMapScroll: { flex: 1 },
  abilityMapList: { gap: 9, paddingBottom: 18 },
  abilityLayerCard: { borderRadius: 17, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 12, gap: 8 },
  abilityLayerHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  abilityLayerTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  abilityLayerOwns: { flexShrink: 1, borderRadius: 10, backgroundColor: '#EEF6FF', color: '#5683A9', fontSize: 10.5, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4, textAlign: 'right' },
  abilityLayerSubtitle: { color: colors.ink, fontSize: 13, lineHeight: 19 },
  abilityLayerRows: { gap: 4 },
  abilityLayerRow: { color: '#5C7893', fontSize: 12, lineHeight: 18 },
  abilityLayerLabel: { color: '#476F92', fontWeight: '700' },
  abilityLayerAction: { alignSelf: 'flex-start', borderRadius: 12, backgroundColor: '#FFF0EA', paddingHorizontal: 10, paddingVertical: 7 },
  abilityLayerActionText: { color: '#C96E63', fontSize: 12, fontWeight: '700' },
  maintenancePanel: { width: '100%', maxWidth: 560, borderRadius: 22, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 15, shadowColor: '#2F3852', shadowOpacity: 0.16, shadowRadius: 18, elevation: 10 },
  maintenanceContent: { gap: 12, paddingBottom: 34 },
  maintenanceSection: { gap: 8 },
  maintenanceSectionTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  maintenanceItemCard: { borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 11, gap: 9 },
  maintenanceItemHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  maintenanceItemTitleWrap: { flex: 1, gap: 4 },
  maintenanceItemTitle: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  maintenanceItemDetail: { color: '#5C7893', fontSize: 11, lineHeight: 17 },
  maintenanceBadge: { maxWidth: 92, borderRadius: 12, backgroundColor: '#EFF8F3', paddingHorizontal: 8, paddingVertical: 5 },
  maintenanceBadgeNotice: { backgroundColor: '#EEF6FF' },
  maintenanceBadgeWarning: { backgroundColor: '#FFF1EA' },
  maintenanceBadgeText: { color: '#5FA883', fontSize: 10.5, fontWeight: '700', textAlign: 'center' },
  maintenanceBadgeNoticeText: { color: '#5683A9' },
  maintenanceBadgeWarningText: { color: '#C96E63' },
  maintenanceItemFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  maintenanceSeverityText: { color: '#7E97A8', fontSize: 10.5, fontWeight: '600' },
  maintenanceActionButton: { borderRadius: 11, backgroundColor: '#FFF0EA', paddingHorizontal: 9, paddingVertical: 6 },
  maintenanceActionText: { color: '#C96E63', fontSize: 11, fontWeight: '700' },
  maintenanceEmptyCard: { borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 12, gap: 5 },
  duplicateCleanupCard: { borderRadius: 18, backgroundColor: '#F3FBF8', borderColor: '#CDEBE1', borderWidth: 1, padding: 13, gap: 11 },
  duplicateCleanupProgress: { color: '#3E7E70', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  duplicateCleanupError: { color: '#B65F58', fontSize: 12, lineHeight: 18, fontWeight: '700' },
  duplicateCleanupActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 9 },
  buttonDisabled: { opacity: 0.45 },
  catalogContent: { gap: 12, paddingBottom: 34 },
  catalogGroupCard: { borderRadius: 18, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 12, gap: 9 },
  catalogGroupHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  catalogLineCard: { borderRadius: 14, backgroundColor: '#F7FBFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9, gap: 5 },
  catalogLineCardDisabled: { opacity: 0.86 },
  catalogLineTitle: { color: colors.ink, fontSize: 13.5, fontWeight: '700', lineHeight: 19 },
  catalogLineMeta: { color: '#6B8BAA', fontSize: 11.5, lineHeight: 16 },
  catalogTagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  catalogTag: { borderRadius: 10, backgroundColor: '#EEF6FF', color: '#5683A9', fontSize: 10.5, fontWeight: '700', paddingHorizontal: 7, paddingVertical: 3 },
  topicProfilePanel: { width: '100%', maxWidth: 560, borderRadius: 22, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 15, shadowColor: '#2F3852', shadowOpacity: 0.16, shadowRadius: 18, elevation: 10 },
  topicToolbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  topicToggleButton: { borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 11, paddingVertical: 8 },
  topicToggleText: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  topicCountText: { color: colors.muted, fontSize: 12 },
  topicProfileContent: { gap: 12, paddingBottom: 20 },
  topicCardGrid: { gap: 8 },
  topicCard: { borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 11, gap: 5 },
  topicCardActive: { backgroundColor: '#FFF8E8', borderColor: '#E5C673' },
  topicCardHidden: { opacity: 0.62 },
  topicCardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  topicCardTitle: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '700' },
  topicKindBadge: { borderRadius: 10, backgroundColor: '#EEF6FF', color: '#5683A9', fontSize: 10.5, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4 },
  topicCardMeta: { color: '#6B8BAA', fontSize: 11.5, lineHeight: 16 },
  topicHiddenBadge: { alignSelf: 'flex-start', borderRadius: 10, backgroundColor: '#FFF0EA', color: '#C96E63', fontSize: 10.5, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4 },
  topicDetailCard: { borderRadius: 18, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 13, gap: 10 },
  topicDetailHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  topicDetailTitleWrap: { flex: 1, gap: 3 },
  topicDetailTitle: { color: colors.ink, fontSize: 18, fontWeight: '800' },
  topicSmallButton: { borderRadius: 12, backgroundColor: '#FFF0EA', paddingHorizontal: 10, paddingVertical: 7 },
  topicSmallButtonActive: { backgroundColor: '#EEF6FF' },
  topicSmallButtonText: { color: '#C96E63', fontSize: 12, fontWeight: '700' },
  topicSmallButtonTextActive: { color: '#5683A9' },
  topicRenameInput: { minHeight: 42, borderRadius: 13, backgroundColor: '#F7FBFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, color: colors.ink, fontSize: 13 },
  topicActionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  topicSectionTitle: { color: '#476F92', fontSize: 13, fontWeight: '800', marginTop: 2 },
  topicMemoryRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, backgroundColor: '#F7FBFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  topicMemoryCopy: { flex: 1, gap: 3 },
  topicMemoryTitle: { color: colors.ink, fontSize: 13.5, fontWeight: '700' },
  topicMemoryText: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  topicWarningText: { color: '#C96E63', backgroundColor: '#FFF0EA', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, lineHeight: 18 },
  drawerOverlay: { flex: 1, backgroundColor: 'rgba(31, 34, 44, 0.22)' },
  drawerBackdrop: { ...StyleSheet.absoluteFillObject },
  drawerPanel: { position: 'absolute', left: 0, top: 0, bottom: 0, width: '76%', maxWidth: 360, backgroundColor: '#F5F7FF', paddingTop: 46, shadowColor: '#2F3852', shadowOpacity: 0.16, shadowRadius: 18, elevation: 10 },
  drawerScroll: { flex: 1 },
  drawerContent: { gap: 10, paddingHorizontal: 16, paddingBottom: 108 },
  drawerTitle: { color: colors.ink, fontSize: 25, fontWeight: '600', marginBottom: 2 },
  drawerQuickNav: { flexDirection: 'row', gap: 8, marginBottom: 5 },
  drawerQuickNavButton: { minHeight: 50, flex: 1, borderRadius: 15, backgroundColor: '#FFFFFF', borderColor: '#DEE7F6', borderWidth: 1, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8, paddingHorizontal: 8 },
  drawerQuickNavIcon: { color: '#6B8BAA', fontSize: 21, fontWeight: '500' },
  drawerQuickNavText: { color: colors.ink, fontSize: 15, fontWeight: '500' },
  drawerSectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '600', marginTop: 8 },
  drawerAction: { minHeight: 68, borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#DEE7F6', borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 10 },
  drawerActionIcon: { width: 42, height: 32, borderRadius: 12, backgroundColor: '#EEF6FF', color: '#5683A9', fontSize: 12, fontWeight: '600', lineHeight: 32, textAlign: 'center' },
  drawerActionCopy: { flex: 1, gap: 3 },
  drawerActionTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  drawerActionHint: { color: colors.muted, fontSize: 11, lineHeight: 16 },
  drawerArrow: { color: '#9BA9B8', fontSize: 24, lineHeight: 26 },
  drawerDivider: { height: 1, backgroundColor: '#DEE7F6', marginVertical: 5 },
  drawerNotice: { color: '#5C7893', backgroundColor: '#FFFFFF', borderColor: '#DEE7F6', borderWidth: 1, borderRadius: 13, paddingHorizontal: 10, paddingVertical: 8, fontSize: 12, lineHeight: 18 },
  currentStateRow: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 9 },
  currentStateCopy: { flex: 1, gap: 2 },
  currentStateTitle: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  currentStateMeta: { color: '#6B8BAA', fontSize: 11, lineHeight: 16 },
  currentStateEndButton: { borderRadius: 11, backgroundColor: '#FFF0EA', paddingHorizontal: 9, paddingVertical: 6 },
  currentStateEndText: { color: '#C96E63', fontSize: 11, fontWeight: '700' },
  modeBar: { backgroundColor: '#FFF0EA', borderRadius: 16, padding: 4, marginBottom: 13, maxHeight: 46 },
  modeBarContent: { gap: 4 },
  modeButton: { minWidth: 64, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 9 },
  modeButtonActive: { backgroundColor: '#FFFFFF' },
  modeText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  modeTextActive: { color: '#C96E63' },
  content: { paddingBottom: 30 },
  editor: { borderRadius: 18, padding: 14, backgroundColor: '#FFEFEA', borderColor: '#FFD8CD', borderWidth: 1, marginBottom: 15 },
  editorHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  editorTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  input: { minHeight: 44, borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#FFE0D7', borderWidth: 1, paddingHorizontal: 12, paddingVertical: 11, color: colors.ink, marginBottom: 9, fontSize: 14 },
  searchInput: { backgroundColor: '#FFFFFF', marginBottom: 10 },
  contentInput: { minHeight: 83, lineHeight: 21 },
  reasonInput: { minHeight: 58, lineHeight: 20 },
  domainRow: { gap: 7, paddingBottom: 11 },
  filterPill: { height: 33, borderRadius: 16, paddingHorizontal: 13, backgroundColor: '#FFEFEA', justifyContent: 'center' },
  filterPillActive: { backgroundColor: '#F09A8B' },
  filterText: { color: '#A76F67', fontSize: 12 },
  filterTextActive: { color: '#FFFFFF', fontWeight: '700' },
  settingRow: { gap: 10, marginTop: 2, marginBottom: 12 },
  importanceGroup: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  miniLabel: { color: colors.muted, fontSize: 12, marginRight: 2 },
  stepButton: { width: 27, height: 27, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFFFFF' },
  stepText: { color: '#C6786B', fontSize: 17 },
  importance: { color: colors.ink, fontWeight: '700', width: 19, textAlign: 'center' },
  toggleRow: { flexDirection: 'row', gap: 7 },
  pinButton: { borderRadius: 13, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: '#FFFFFF' },
  pinButtonActive: { backgroundColor: '#B2D9FF' },
  anchorButtonActive: { backgroundColor: '#FFE2A9' },
  anchorKindRow: { gap: 7, paddingBottom: 11 },
  anchorKindPill: { height: 31, borderRadius: 15, paddingHorizontal: 12, backgroundColor: '#FFFFFF', justifyContent: 'center', borderColor: '#FFE0B2', borderWidth: 1 },
  anchorKindPillActive: { backgroundColor: '#FFE2A9', borderColor: '#F4C66C' },
  anchorKindText: { color: '#A26B20', fontSize: 11, fontWeight: '700' },
  anchorKindTextActive: { color: '#775017' },
  pinText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  pinTextActive: { color: '#35678C' },
  saveButton: { height: 44, borderRadius: 14, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center' },
  primaryButton: { minHeight: 40, borderRadius: 13, backgroundColor: '#EE8D7D', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  primaryButtonText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
  secondaryButton: { minHeight: 40, borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  secondaryButtonText: { color: '#5683A9', fontSize: 13, fontWeight: '700' },
  deleteButton: { minHeight: 40, borderRadius: 13, backgroundColor: '#FFF0EA', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 },
  editorActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  maintenanceRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 10 },
  disabledButton: { opacity: 0.42 },
  saveText: { color: '#FFFFFF', fontSize: 14, fontWeight: '700' },
  listTitle: { color: colors.ink, fontSize: 18, fontWeight: '700', marginTop: 6, marginBottom: 10 },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 20, paddingVertical: 16 },
  memoryCard: { borderRadius: 17, padding: 13, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, marginBottom: 9 },
  memoryCardImportant: { backgroundColor: '#FFF8E6', borderColor: '#F3CC79', borderLeftWidth: 5 },
  memoryCardBoundary: { borderLeftWidth: 5, borderLeftColor: '#E7897D' },
  memoryTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 9 },
  domainBadge: { color: '#CF7769', backgroundColor: '#FFF0EA', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '700' },
  memoryDate: { color: colors.muted, fontSize: 11, flexShrink: 1, textAlign: 'right' },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: '700', marginBottom: 6 },
  memoryContent: { color: colors.ink, fontSize: 14, lineHeight: 21, marginBottom: 9 },
  tags: { flexDirection: 'row', flexWrap: 'wrap', gap: 5, marginBottom: 9 },
  tag: { color: '#5783AA', backgroundColor: '#EAF4FF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11 },
  pinTag: { color: '#39749B', backgroundColor: '#DBEDFF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '700' },
  anchorTag: { color: '#A26B20', backgroundColor: '#FFF0C9', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '700' },
  activeTag: { color: '#B75E48', backgroundColor: '#FFE1D7', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '700' },
  warmTag: { color: '#A86414', backgroundColor: '#FFF0C9', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11 },
  coolTag: { color: '#4C7199', backgroundColor: '#E6F3FF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11 },
  cardFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  archiveChip: { borderRadius: 11, backgroundColor: '#FFF0EA', paddingHorizontal: 10, paddingVertical: 6 },
  archiveChipText: { color: '#C96E63', fontSize: 11, fontWeight: '700' },
  archiveReason: { color: '#A66F67', backgroundColor: '#FFF4F0', borderRadius: 10, padding: 9, fontSize: 12, lineHeight: 18, marginTop: 7 },
  cueSection: { marginBottom: 5 },
  cueLabel: { color: colors.muted, fontSize: 11, marginBottom: 6 },
  cueTag: { color: '#5683A9', backgroundColor: '#E6F3FF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11 },
  mergeButton: { alignSelf: 'flex-start', marginTop: 7, borderRadius: 12, backgroundColor: '#F1F8FF', paddingHorizontal: 12, paddingVertical: 8 },
  mergeButtonText: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  actionGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 3, marginBottom: 6 },
  actionRowBreak: { width: '100%', height: 0 },
  mergePanel: { borderRadius: 18, padding: 14, backgroundColor: '#EFF8FF', borderColor: '#D3E8F8', borderWidth: 1, marginBottom: 15, gap: 8 },
  mergeHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 2 },
  mergeCandidate: { borderRadius: 14, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 11, marginBottom: 6 },
  mergePick: { color: '#5683A9', fontSize: 11 },
  score: { color: '#6790B2', fontSize: 11, fontWeight: '700' },
  sourceTracePanel: { borderRadius: 16, backgroundColor: '#FFFDFC', borderColor: '#F2E3D9', borderWidth: 1, padding: 12, marginTop: 10, gap: 7 },
  sourceTraceHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  sourceTraceToggle: { borderRadius: 999, backgroundColor: '#F3FAFE', borderColor: '#D8EAF8', borderWidth: 1, paddingHorizontal: 10, paddingVertical: 5 },
  sourceTraceToggleText: { color: '#5F8BA2', fontSize: 11, fontWeight: '600' },
  sourceTraceBody: { gap: 8 },
  sourceTraceCard: { borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#E5EEF5', borderWidth: 1, padding: 10, gap: 7 },
  sourceTraceRange: { color: '#6F91A1', fontSize: 11, fontWeight: '600' },
  sourceTraceMessage: { borderRadius: 12, backgroundColor: '#F7FBFF', padding: 9, gap: 4 },
  sourceTraceMissingMessage: { backgroundColor: '#FFF8F5', borderColor: '#F3D9D0', borderWidth: 1 },
  sourceTraceMessageHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  sourceTraceRole: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  sourceTraceMatched: { color: '#B86B5B', backgroundColor: '#FFF1EC', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, fontSize: 10, fontWeight: '600' },
  sourceTraceMissingTag: { color: '#A96A5F', backgroundColor: '#FCE8E2', borderRadius: 999, paddingHorizontal: 7, paddingVertical: 2, fontSize: 10, fontWeight: '600' },
  sourceTraceContent: { color: colors.ink, fontSize: 12, lineHeight: 18 },
  sourceTraceNote: { color: '#91A7B3', fontSize: 10, lineHeight: 15 },
  sourceCorrectionActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 2 },
  sourceCorrectionButton: { borderRadius: 10, backgroundColor: '#F3FAFE', borderColor: '#D8EAF8', borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  sourceCorrectionButtonText: { color: '#5683A9', fontSize: 11, fontWeight: '700' },
  sourceCorrectionDangerButton: { borderRadius: 10, backgroundColor: '#FFF0EA', borderColor: '#FFD8CD', borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  sourceCorrectionDangerText: { color: '#B75E48', fontSize: 11, fontWeight: '700' },
  sourceCorrectionCard: { borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#E5EEF5', borderWidth: 1, padding: 10, gap: 8 },
  sourceCorrectionCandidateActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  sourceCorrectionModalPanel: { width: '100%', maxWidth: 520, borderRadius: 22, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 15, shadowColor: '#2F3852', shadowOpacity: 0.16, shadowRadius: 18, elevation: 10 },
  sourceSelectionList: { maxHeight: 430, marginVertical: 10 },
  sourceSelectionListContent: { gap: 10, paddingBottom: 4 },
  sourceSelectionGroup: { gap: 7 },
  sourceSelectionMessage: { flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 13, borderColor: '#DDEAF2', borderWidth: 1, backgroundColor: '#FFFFFF', padding: 10 },
  sourceSelectionMessageChecked: { borderColor: '#8DBCD1', backgroundColor: '#EFF9FD' },
  sourceSelectionCheck: { color: '#5F8BA2', fontSize: 18, lineHeight: 22, fontWeight: '700' },
  sourceSelectionTextWrap: { flex: 1, gap: 4 },
  healthPanel: { borderRadius: 16, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 12, marginTop: 10, marginBottom: 2, gap: 6 },
  healthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  healthTitle: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  healthMeta: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  healthLine: { color: '#5C7893', fontSize: 11, lineHeight: 17 },
  healthHint: { color: colors.muted, fontSize: 11, lineHeight: 17 },
  healthReportBox: { borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 10, gap: 4 },
  healthSectionTitle: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  systemHealthPanel: { borderRadius: 16, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 12, marginBottom: 11, gap: 8 },
  systemHealthBlocked: { backgroundColor: '#FFF4F0', borderColor: '#FFD8CD' },
  systemHealthWarning: { backgroundColor: '#FFFBF0', borderColor: '#F3DDA1' },
  systemHealthTitleWrap: { flex: 1, gap: 2 },
  systemHealthTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  systemHealthBadge: { color: '#5683A9', backgroundColor: '#E6F3FF', borderRadius: 10, paddingHorizontal: 9, paddingVertical: 5, fontSize: 11, fontWeight: '600' },
  systemHealthBadgeBlocked: { color: '#B75E48', backgroundColor: '#FFE1D7' },
  systemHealthBadgeWarning: { color: '#9A6A16', backgroundColor: '#FFF0C9' },
  systemHealthItems: { gap: 8 },
  systemHealthItem: { flexDirection: 'row', gap: 8 },
  systemHealthDot: { color: '#8FC8A8', fontSize: 13, lineHeight: 18 },
  systemHealthDotBlocked: { color: '#D27A6D' },
  systemHealthDotWarning: { color: '#D49B31' },
  systemHealthItemText: { flex: 1, gap: 3 },
  systemHealthItemTitle: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  systemHealthAction: { alignSelf: 'flex-start', borderRadius: 10, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6, marginTop: 2 },
  systemHealthActionText: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  healthSummaryPanel: { borderRadius: 16, backgroundColor: '#F7FBFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 11, marginBottom: 11, gap: 7 },
  healthSummaryChip: { borderRadius: 11, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  healthSummaryChipText: { color: '#5683A9', fontSize: 11, fontWeight: '600' },
  historyImportPanel: { borderRadius: 17, backgroundColor: '#F8FCFF', borderColor: '#D8EAF8', borderWidth: 1, padding: 12, marginBottom: 12, gap: 9 },
  historyCandidateCard: { borderRadius: 14, backgroundColor: '#FFFFFF', borderColor: '#DDECF8', borderWidth: 1, padding: 11, gap: 6 },
  historyCandidateInput: { marginBottom: 0 },
  historyCandidateFooter: { gap: 8 },
  graphPanel: { borderRadius: 16, backgroundColor: '#FFFBF7', borderColor: '#FFE1D2', borderWidth: 1, padding: 12, marginTop: 10, marginBottom: 2, gap: 8 },
  graphHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  graphLinkCard: { borderRadius: 13, backgroundColor: '#FFFFFF', borderColor: '#FFE7DC', borderWidth: 1, padding: 10, gap: 4 },
  graphLinkTitle: { flex: 1, color: colors.ink, fontSize: 12.5, fontWeight: '700' },
  graphConfidence: { color: '#C8796D', fontSize: 11, fontWeight: '700' },
  graphRepairRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 3 },
  graphRepairButton: { borderRadius: 10, backgroundColor: '#FFF4EE', borderColor: '#FFE1D2', borderWidth: 1, paddingHorizontal: 9, paddingVertical: 6 },
  graphRepairText: { color: '#C8796D', fontSize: 11, fontWeight: '700' },
  detailInfoBox: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#e6f0f4',
    backgroundColor: '#f8fcfd',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 12,
    gap: 5,
  },
  detailInfoLabel: {
    fontSize: 13,
    color: '#6f91a1',
    fontWeight: '600',
  },
  detailInfoText: {
    fontSize: 15,
    color: '#385163',
    lineHeight: 22,
  },
  statusStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 12,
    marginBottom: 16,
  },
  commonActionPanel: {
    gap: 8,
    marginBottom: 8,
  },
  advancedToggle: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#dbe9ef',
    backgroundColor: '#f5fbfe',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  advancedToggleText: {
    flex: 1,
    gap: 4,
  },
  advancedToggleTitle: {
    fontSize: 16,
    color: '#2b3a4c',
    fontWeight: '600',
  },
  advancedToggleSummary: {
    fontSize: 13,
    color: '#6f91a1',
    lineHeight: 18,
  },
  advancedToggleIcon: {
    fontSize: 13,
    color: '#5f8ba2',
    fontWeight: '600',
  },
  detailSheet: { borderRadius: 20, padding: 16, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, marginBottom: 18 },
  detailTop: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 13 },
  detailTitle: { color: colors.ink, fontSize: 19, fontWeight: '700', marginBottom: 10 },
  detailContent: { color: colors.ink, fontSize: 15, lineHeight: 24, marginBottom: 13 },
  ringsHeader: { flexDirection: 'row', alignItems: 'baseline', gap: 9 },
  ringHint: { color: colors.muted, fontSize: 12 },
  commentComposer: { backgroundColor: '#FFF0EA', borderRadius: 18, padding: 12, marginBottom: 10 },
  commentInput: { minHeight: 66, lineHeight: 20 },
  commentCard: { borderRadius: 16, backgroundColor: '#FFFFFF', padding: 13, borderColor: '#FFE5DD', borderWidth: 1, marginBottom: 9 },
  source: { color: '#D07B6D', fontSize: 11, fontWeight: '700' },
  commentDelete: { alignSelf: 'flex-end' },
  deleteText: { color: '#D27A6D', fontSize: 12, fontWeight: '700' },
  removeMemory: { alignItems: 'center', paddingVertical: 17, marginTop: 6 },
  panelHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 10 },
  domainGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginBottom: 13 },
  domainEntry: { width: '48%', minHeight: 72, borderRadius: 15, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, padding: 12, justifyContent: 'space-between' },
  domainEntryTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  threadCard: { borderRadius: 17, padding: 14, backgroundColor: '#F6FBFF', borderColor: '#D7EAF7', borderWidth: 1, marginBottom: 10 },
  threadHero: { borderRadius: 19, padding: 16, backgroundColor: '#F6FBFF', borderColor: '#D7EAF7', borderWidth: 1, marginBottom: 14 },
  threadTitle: { color: colors.ink, fontSize: 20, fontWeight: '700', marginTop: 8, marginBottom: 8 },
  threadSummary: { color: colors.ink, fontSize: 14, lineHeight: 21, marginBottom: 9 },
  threadStatus: { alignSelf: 'flex-start', color: '#5683A9', backgroundColor: '#E6F3FF', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '700' },
  threadBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  manualThreadTag: { color: '#A26B20', backgroundColor: '#FFF0C9', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4, fontSize: 11, fontWeight: '700' },
  timelineItem: { flexDirection: 'row', gap: 10, marginBottom: 10 },
  timelineDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#EE8D7D', marginTop: 18 },
  timelineLine: { flex: 1, borderRadius: 16, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, padding: 13 },
  timelineStep: { color: '#C96E63', fontSize: 12, fontWeight: '700', marginBottom: 6 },
  timelineEditorPanel: { borderRadius: 18, padding: 14, backgroundColor: '#EFF8FF', borderColor: '#D3E8F8', borderWidth: 1, marginBottom: 15 },
  timelineRemoveButton: { alignSelf: 'flex-start', borderRadius: 11, backgroundColor: '#FFF0EA', paddingHorizontal: 10, paddingVertical: 7, marginTop: 3 },
  timelineSelectedList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 9 },
  selectedMemoryChip: { borderRadius: 12, backgroundColor: '#E6F3FF', paddingHorizontal: 10, paddingVertical: 7 },
  selectedMemoryText: { color: '#5683A9', fontSize: 12, fontWeight: '700' },
  threadReason: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: 8 },
  calendar: { borderRadius: 19, backgroundColor: '#FFFFFF', borderColor: '#FFE3DC', borderWidth: 1, padding: 12, marginBottom: 16 },
  calendarHeader: { height: 40, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  calendarTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  monthArrow: { height: 35, width: 35, borderRadius: 17, backgroundColor: '#FFF0EA', alignItems: 'center', justifyContent: 'center' },
  monthArrowText: { color: '#C6786B', fontSize: 25, lineHeight: 28 },
  weekRow: { flexDirection: 'row', marginBottom: 5 },
  weekday: { width: '14.2857%', textAlign: 'center', fontSize: 11, color: colors.muted },
  days: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.2857%', height: 45, alignItems: 'center', justifyContent: 'center', borderRadius: 12 },
  daySelected: { backgroundColor: '#F09A8B' },
  dayText: { color: colors.ink, fontSize: 13 },
  dayTextSelected: { color: '#FFFFFF', fontWeight: '700' },
  dayDot: { width: 4, height: 4, borderRadius: 2, backgroundColor: '#EE8D7D', marginTop: 3 },
  dayDotSelected: { backgroundColor: '#FFFFFF' },
  editText: { color: '#C6786B', fontSize: 12, fontWeight: '700' },
});
