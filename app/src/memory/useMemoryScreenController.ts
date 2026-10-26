import { useEffect, useMemo, useRef, useState } from 'react';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { weeklyTargetHash } from './memoryWeeklyBasis';

import type { AiConnection } from '../ai/types';
import { buildMemoryThreads, loadMemoryThread } from './memoryContinuation';
import {
  buildRecentMemoryHealthSummary,
  type MemoryHealthReport,
  type MemoryHealthSummary,
} from './memoryHealthReport';
import {
  buildMemorySystemHealthSnapshot,
  type MemorySystemHealthSnapshot,
} from './memorySystemHealth';
import type { MemoryGraphLink } from './memoryGraphMaintenance';
import type { MemoryQualitySignals } from './memoryCalibration';
import type { MemorySourceTraceResult } from './memorySourceTrace';
import { loadMemorySourceSelectionCandidates } from './memorySourceTrace';
import {
  type MemoryDehydrationDiagnostic,
} from './memoryDehydration';
import {
  buildMemoryStarGraph,
  type MemoryStarGraph,
  type MemoryStarGraphFilter,
  type MemoryStarGraphMode,
} from './memoryStarGraph';
import { generateMemoryEmbedding } from './memoryEmbedding';
import { useMemoryScreenSearch } from './useMemoryScreenSearch';
import { subscribeMemoryProcessingUpdates } from './memoryProcessingSignals';
import {
  dateKey,
  filterMemoryScreenMemories,
  getMemoryMergeCandidates,
  getMemoryScreenDateMemories,
  getMemoryScreenMarkedDates,
  getMemoryTimelineCandidates,
  type MemoryScreenViewMode,
} from './memoryScreenSelectors';
import {
  loadMemoryScreenDetailSnapshot,
  loadMemoryScreenHealthSnapshot,
} from './memoryScreenDetail';
import {
  buildSourceCorrectionComment,
  buildSourceCorrectionDraft,
  buildSourceCorrectionQuery,
} from './memorySourceCorrection';
import {
  archiveMemory,
  createManualTimeline,
  createMemory,
  createMemoryComment,
  createMemoryRecallFeedback,
  deleteMemoryComment,
  deriveMemoryTitle,
  hardDeleteMemory,
  loadMemories,
  loadMemory,
  loadMemorySourceRefs,
  mergeMemoryInto,
  replaceMemorySourceRefs,
  restoreMemory,
  runMemoryMaintenance,
  setTimelineHidden,
  setTimelineMemoryIncluded,
  updateMemory,
  updateMemoryState,
  updateTimelineTitle,
  undoMemoryMerge,
  type EventThread,
  type MemoryComment,
  type MemoryDomain,
  type MemoryDraft,
  type MemoryEdge,
  type MemoryEntry,
  type MemoryLifecycleEvent,
  type MemoryMergeRecoverySnapshot,
  type MemoryMergeUndoOutcome,
  type MemorySourceRefInput,
} from './memoryStore';

export type MemoryScreenThreadDetail = {
  edges: MemoryEdge[];
  memories: MemoryEntry[];
  thread: EventThread;
};

export function makeBlankMemoryDraft(): MemoryDraft {
  return {
    arousal: 0.3,
    anchor: false,
    content: '',
    digested: false,
    domain: '其他',
    importance: 5,
    pinned: false,
    protected: false,
    recallCues: [],
    resolved: false,
    sourceType: 'manual',
    tags: [],
    title: '',
    type: 'dynamic',
    valence: 0.5,
  };
}

type MemoryScreenControllerAi = {
  connection?: AiConnection;
  key: string;
  rerankerConnection?: AiConnection;
  rerankerKey?: string;
};

export function useMemoryScreenController({
  ai,
}: {
  ai: MemoryScreenControllerAi;
}) {
  const [memories, setMemories] = useState<MemoryEntry[]>([]);
  const [threads, setThreads] = useState<EventThread[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [mode, setMode] = useState<MemoryScreenViewMode>('pinned');
  const [query, setQuery] = useState('');
  const [domain, setDomain] = useState<MemoryDomain | undefined>();
  const [month, setMonth] = useState(() => new Date());
  const [selectedDate, setSelectedDate] = useState(() => new Date());
  const [selected, setSelectedState] = useState<MemoryEntry | null>(null);
  const selectedIdRef = useRef(selected?.id);
  const selectionRevisionRef = useRef(0);
  const mountedRef = useRef(true);
  const refreshRevisionRef = useRef(0);
  const detailReadRevisionRef = useRef(0);
  const draftSaveRef = useRef<number | null>(null);
  const commentSaveRef = useRef<number | null>(null);
  const [draftSavingRevision, setDraftSavingRevision] = useState<number | null>(null);
  const [commentSavingRevision, setCommentSavingRevision] = useState<number | null>(null);
  const [draftSaveError, setDraftSaveError] = useState('');
  const editBaseRef = useRef<{ memory: MemoryEntry; epoch: number | null; source: boolean } | null>(null);
  const [editConflict, setEditConflict] = useState<MemoryEntry | null>(null);
  const [commentSaveError, setCommentSaveError] = useState('');
  const [refreshNotice, setRefreshNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [comments, setComments] = useState<MemoryComment[]>([]);
  const [commentText, setCommentText] = useState('');
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<MemoryDraft>(makeBlankMemoryDraft());
  const [tagsText, setTagsText] = useState('');
  const [recallCuesText, setRecallCuesText] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeQuery, setMergeQuery] = useState('');
  const { searchResults, meaningSearching, searchNotice, searchByMeaning, cancelMeaningSearch } = useMemoryScreenSearch(query, mode, memories);
  const [embeddingStatus, setEmbeddingStatus] = useState<{ indexed: boolean; model: string; updatedAt?: number } | null>(null);
  const [threadDetail, setThreadDetail] = useState<MemoryScreenThreadDetail | null>(null);
  const [timelineCreating, setTimelineCreating] = useState(false);
  const [timelineEditing, setTimelineEditing] = useState(false);
  const [timelineTitle, setTimelineTitle] = useState('');
  const [timelineSearch, setTimelineSearch] = useState('');
  const [timelineSelectedIds, setTimelineSelectedIds] = useState<string[]>([]);
  const [dehydrationDiagnostic, setDehydrationDiagnostic] = useState<MemoryDehydrationDiagnostic | null>(null);
  const [graphLinks, setGraphLinks] = useState<MemoryGraphLink[]>([]);
  const [qualitySignals, setQualitySignals] = useState<MemoryQualitySignals | null>(null);
  const [healthReport, setHealthReport] = useState<MemoryHealthReport | null>(null);
  const [sourceTrace, setSourceTrace] = useState<MemorySourceTraceResult | null>(null);
  const [lifecycleEvents, setLifecycleEvents] = useState<MemoryLifecycleEvent[]>([]);
  const [lifecycleSummary, setLifecycleSummary] = useState('还没有足迹');
  const [mergeRecovery, setMergeRecovery] = useState<MemoryMergeRecoverySnapshot | null>(null);
  const [mergeUndoOutcome, setMergeUndoOutcome] = useState<MemoryMergeUndoOutcome | null>(null);
  const [healthSummary, setHealthSummary] = useState<MemoryHealthSummary | null>(null);
  const [systemHealth, setSystemHealth] = useState<MemorySystemHealthSnapshot | null>(null);
  const [starMapOpen, setStarMapOpen] = useState(false);
  const [starMapMode, setStarMapMode] = useState<MemoryStarGraphMode>('overview');
  const [starMapCenterId, setStarMapCenterId] = useState<string | undefined>();
  const [starMapGraph, setStarMapGraph] = useState<MemoryStarGraph | null>(null);
  const [starMapLoading, setStarMapLoading] = useState(false);
  const [starMapQuery, setStarMapQuery] = useState('');
  const [starMapFilters, setStarMapFilters] = useState<MemoryStarGraphFilter[]>([]);
  const [selectedStarNodeId, setSelectedStarNodeId] = useState<string | null>(null);
  const [selectedStarEdgeId, setSelectedStarEdgeId] = useState<string | null>(null);
  const [sourceCorrectionCandidate, setSourceCorrectionCandidate] = useState<MemoryDraft | null>(null);
  const [sourceSelectionGroups, setSourceSelectionGroups] = useState<Array<{
    messages: import('../ai/subjectiveMessages').SubjectiveMessage[];
    sessionId: string;
  }>>([]);
  const [sourceSelectionKeys, setSourceSelectionKeys] = useState<string[]>([]);
  const [sourceSelectionLoading, setSourceSelectionLoading] = useState(false);
  const [sourceSelectionOpen, setSourceSelectionOpen] = useState(false);

  const resetSelectedDiagnostics = () => {
    setDehydrationDiagnostic(null);
    setGraphLinks([]);
    setQualitySignals(null);
    setHealthReport(null);
    setSourceTrace(null);
    setLifecycleEvents([]);
    setLifecycleSummary('还没有足迹');
    setMergeRecovery(null);
    setMergeUndoOutcome(null);
  };

  const resetSelectedDetail = () => {
    editBaseRef.current = null;
    setEditConflict(null);
    setDraftSaveError('');
    setCommentSaveError('');
    setComments([]);
    setEmbeddingStatus(null);
    resetSelectedDiagnostics();
    setCommentText('');
    setMergeOpen(false);
    setMergeQuery('');
    setSourceCorrectionCandidate(null);
    setSourceSelectionOpen(false);
    setSourceSelectionLoading(false);
    setSourceSelectionGroups([]);
    setSourceSelectionKeys([]);
  };

  const setSelected = (memory: MemoryEntry | null) => {
    if (selectedIdRef.current !== memory?.id) {
      selectionRevisionRef.current += 1;
      resetSelectedDetail();
    }
    selectedIdRef.current = memory?.id;
    setSelectedState(memory);
  };

  const selectionIsCurrent = (memory: MemoryEntry, revision: number) => (
    selectedIdRef.current === memory.id && selectionRevisionRef.current === revision
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      selectionRevisionRef.current += 1;
      refreshRevisionRef.current += 1;
    };
  }, []);

  const readSelectedDetail = async (memory: MemoryEntry, revision: number) => {
    const request = ++detailReadRevisionRef.current;
    const detail = await loadMemoryScreenDetailSnapshot(memory, { query });
    if (!selectionIsCurrent(memory, revision) || request !== detailReadRevisionRef.current) return;
    setComments(detail.comments);
    setEmbeddingStatus(detail.embeddingStatus);
    setDehydrationDiagnostic(detail.dehydrationDiagnostic);
    setGraphLinks(detail.graphLinks);
    setQualitySignals(detail.qualitySignals);
    setHealthReport(detail.healthReport);
    setSourceTrace(detail.sourceTrace);
    setLifecycleEvents(detail.lifecycleEvents);
    setLifecycleSummary(detail.lifecycleSummary);
    setMergeRecovery(detail.mergeRecovery);
  };

  const applyHealthSnapshot = async (memory: MemoryEntry) => {
    const revision = selectionRevisionRef.current;
    const detail = await loadMemoryScreenHealthSnapshot(memory, { query });
    if (!selectionIsCurrent(memory, revision)) return;
    setDehydrationDiagnostic(detail.dehydrationDiagnostic);
    setGraphLinks(detail.graphLinks);
    setQualitySignals(detail.qualitySignals);
    setHealthReport(detail.healthReport);
  };

  const refresh = async (maintain = true) => {
    if (!mountedRef.current) return;
    const request = ++refreshRevisionRef.current;
    const revision = selectionRevisionRef.current;
    const failedParts: string[] = [];
    const noteFailure = (part: string, error: unknown) => {
      failedParts.push(part);
      console.warn('[memory-screen-refresh]', part, error instanceof Error ? error.message : String(error));
    };
    setRefreshing(true);
    try {
      if (maintain) {
        try { await runMemoryMaintenance(); }
        catch (error) { noteFailure('维护', error); }
      }
      const records = await loadMemories({ includeArchived: true });
      if (!mountedRef.current || request !== refreshRevisionRef.current) return;
      setMemories(records);
      setLoaded(true);
      let nextSelected: MemoryEntry | null = null;
      if (selected && selectionIsCurrent(selected, revision)) {
        nextSelected = records.find((memory) => memory.id === selected.id) ?? null;
        if (nextSelected || !editBaseRef.current) setSelected(nextSelected);
      }
      const memoryOrganizerReady = !!ai.connection && !!ai.key.trim();
      const memoryRerankerReady = !!ai.rerankerConnection && !!ai.rerankerKey?.trim();
      const [nextThreads, nextHealthSummary, nextSystemHealth, nextDetail] = await Promise.allSettled([
        buildMemoryThreads(),
        buildRecentMemoryHealthSummary(),
        buildMemorySystemHealthSnapshot({
          memoryOrganizerLabel: ai.connection?.name,
          memoryOrganizerReady,
          memoryRerankerLabel: ai.rerankerConnection?.name,
          memoryRerankerReady,
        }),
        nextSelected ? readSelectedDetail(nextSelected, revision) : Promise.resolve(),
      ]);
      if (!mountedRef.current || request !== refreshRevisionRef.current) return;
      if (nextThreads.status === 'fulfilled') setThreads(nextThreads.value);
      else noteFailure('时间轴', nextThreads.reason);
      if (nextHealthSummary.status === 'fulfilled') setHealthSummary(nextHealthSummary.value);
      else noteFailure('体检', nextHealthSummary.reason);
      if (nextSystemHealth.status === 'fulfilled') setSystemHealth(nextSystemHealth.value);
      else noteFailure('系统状态', nextSystemHealth.reason);
      if (nextDetail.status === 'rejected' && nextSelected && selectionIsCurrent(nextSelected, revision)) {
        noteFailure('详情', nextDetail.reason);
      }
      setRefreshNotice(failedParts.length ? `记忆已显示；${failedParts.join('、')}暂未刷新，点此重试。` : '');
    } catch (error) {
      if (mountedRef.current && request === refreshRevisionRef.current) {
        noteFailure('列表', error);
        setRefreshNotice('页面刷新失败，请重试。');
      }
    } finally {
      if (mountedRef.current && request === refreshRevisionRef.current) {
        setRefreshing(false);
      }
    }
  };

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => subscribeMemoryProcessingUpdates(() => {
    void refreshRef.current(false);
  }), []);

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    const memoryOrganizerReady = !!ai.connection && !!ai.key.trim();
    const memoryRerankerReady = !!ai.rerankerConnection && !!ai.rerankerKey?.trim();
    void buildMemorySystemHealthSnapshot({
      memoryOrganizerLabel: ai.connection?.name,
      memoryOrganizerReady,
      memoryRerankerLabel: ai.rerankerConnection?.name,
      memoryRerankerReady,
    }).then(setSystemHealth).catch(() => undefined);
  }, [ai.connection, ai.key, ai.rerankerConnection, ai.rerankerKey]);

  useEffect(() => {
    if (!starMapOpen) return;
    let active = true;
    setStarMapLoading(true);
    void buildMemoryStarGraph({
      centerMemoryId: starMapCenterId,
      filters: starMapFilters,
      maxNodes: starMapMode === 'local' ? 18 : 28,
      mode: starMapMode,
      query: starMapQuery,
    }).then((graph) => {
      if (!active) return;
      setStarMapGraph(graph);
      setSelectedStarNodeId((current) => current && graph.nodes.some((node) => node.id === current) ? current : graph.centerNodeId ?? null);
      setSelectedStarEdgeId((current) => current && graph.edges.some((edge) => edge.id === current) ? current : null);
    }).catch(() => {
      if (!active) return;
      setStarMapGraph({ edges: [], nodes: [], stats: { edgeCount: 0, memoryCount: 0, topicCount: 0, warningCount: 0 } });
      setSelectedStarNodeId(null);
      setSelectedStarEdgeId(null);
    }).finally(() => {
      if (active) setStarMapLoading(false);
    });
    return () => {
      active = false;
    };
  }, [starMapCenterId, starMapFilters, starMapMode, starMapOpen, starMapQuery]);

  useEffect(() => {
    let active = true;
    const revision = selectionRevisionRef.current;
    const detailReadRevision = detailReadRevisionRef.current;
    async function refreshHealthReport() {
      if (!selected) {
        setHealthReport(null);
        return;
      }
      const detail = await loadMemoryScreenHealthSnapshot(selected, { query });
      if (!active || !selectionIsCurrent(selected, revision) || detailReadRevision !== detailReadRevisionRef.current) return;
      setDehydrationDiagnostic(detail.dehydrationDiagnostic);
      setGraphLinks(detail.graphLinks);
      setQualitySignals(detail.qualitySignals);
      setHealthReport(detail.healthReport);
    }
    void refreshHealthReport().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [query, selected]);

  const openMemory = async (memory: MemoryEntry) => {
    setSelected(memory);
    const revision = ++selectionRevisionRef.current;
    resetSelectedDetail();
    setEditing(false);
    setCreating(false);
    await readSelectedDetail(memory, revision);
  };

  const beginNew = () => {
    setDraftSaveError('');
    setSelected(null);
    selectionRevisionRef.current += 1;
    setCreating(true);
    setEditing(false);
    resetSelectedDiagnostics();
    setDraft(makeBlankMemoryDraft());
    setTagsText('');
    setRecallCuesText('');
  };

  const beginEdit = (memory: MemoryEntry) => {
    setDraftSaveError('');
    setEditConflict(null);
    editBaseRef.current = { memory, epoch: captureBackupRestoreDataEpoch(), source: false };
    setEditing(true);
    setDraft({
      ...memory,
      anchor: memory.anchor,
      anchorKind: memory.anchorKind,
      archivedAt: memory.archivedAt,
      arousal: memory.arousal,
      confidence: memory.confidence,
      content: memory.content,
      date: memory.date,
      digested: memory.digested,
      domain: memory.domain,
      importance: memory.importance,
      modelValence: memory.modelValence,
      period: memory.period,
      pinned: memory.pinned,
      protected: memory.protected,
      recallCues: memory.recallCues,
      rememberedReason: memory.rememberedReason,
      resolved: memory.resolved,
      source: memory.source,
      sourceEndAt: memory.sourceEndAt,
      sourceStartAt: memory.sourceStartAt,
      sourceType: memory.sourceType,
      surfaceMutedAt: memory.surfaceMutedAt,
      tags: memory.tags,
      title: memory.title,
      type: memory.type,
      valence: memory.valence,
    });
    setTagsText(memory.tags.join('、'));
    setRecallCuesText(memory.recallCues.join('、'));
  };

  const reloadSelectedMemory = async (revision = selectionRevisionRef.current) => {
    const current = selected;
    if (!current || !selectionIsCurrent(current, revision)) return;
    const latest = await loadMemories({ includeArchived: true }).then((records) => records.find((memory) => memory.id === current.id));
    if (!selectionIsCurrent(current, revision)) return;
    if (latest) {
      const opening = openMemory(latest);
      const openedRevision = selectionRevisionRef.current;
      await opening;
      if (!selectionIsCurrent(latest, openedRevision)) return;
    } else setSelected(null);
    await refresh();
  };

  const refreshStarMapNow = async () => {
    if (!starMapOpen) return;
    setStarMapLoading(true);
    try {
      const graph = await buildMemoryStarGraph({
        centerMemoryId: starMapCenterId,
        filters: starMapFilters,
        maxNodes: starMapMode === 'local' ? 18 : 28,
        mode: starMapMode,
        query: starMapQuery,
      });
      setStarMapGraph(graph);
      setSelectedStarNodeId((current) => current && graph.nodes.some((node) => node.id === current) ? current : graph.centerNodeId ?? null);
      setSelectedStarEdgeId((current) => current && graph.edges.some((edge) => edge.id === current) ? current : null);
    } finally {
      setStarMapLoading(false);
    }
  };

  const openStarMap = (mode: MemoryStarGraphMode, centerMemoryId?: string) => {
    setStarMapMode(mode);
    setStarMapCenterId(centerMemoryId);
    setStarMapQuery('');
    setStarMapFilters([]);
    setSelectedStarNodeId(centerMemoryId ?? null);
    setSelectedStarEdgeId(null);
    setStarMapOpen(true);
  };

  const saveDraft = async () => {
    if (!draft.content.trim() || editConflict) return;
    const revision = selectionRevisionRef.current;
    if (draftSaveRef.current === revision) return;
    draftSaveRef.current = revision;
    setDraftSavingRevision(revision);
    setDraftSaveError('');
    const nextDraft: MemoryDraft = {
      ...draft,
      recallCues: recallCuesText.split(/[，,、\s]+/).map((cue) => cue.trim()).filter(Boolean),
      tags: tagsText.split(/[，,、\s]+/).map((tag) => tag.trim()).filter(Boolean),
      title: draft.title.trim() || deriveMemoryTitle(draft.content),
    };
    try {
      if (editing && selected) {
        const base = editBaseRef.current;
        if (!base || base.memory.id !== selected.id) throw new Error('MEMORY_EDIT_CONFLICT');
        await updateMemory(selected.id, nextDraft, {
          confirmationLevel: 'manual',
          expectedEditableHash: weeklyTargetHash(base.memory),
          dataEpoch: base.epoch,
          writeIntent: 'correction',
          continuationAi: ai.connection && ai.key.trim()
            ? { apiKey: ai.key, connection: ai.connection }
            : undefined,
        });
        if (!selectionIsCurrent(selected, revision)) return;
        editBaseRef.current = null;
        setEditing(false);
      } else {
        await createMemory(nextDraft, {
          confirmationLevel: 'manual',
          continuationAi: ai.connection && ai.key.trim()
            ? { apiKey: ai.key, connection: ai.connection }
            : undefined,
        });
        if (selectionRevisionRef.current !== revision) return;
        setCreating(false);
      }
    } catch (error) {
      if (mountedRef.current && selectionRevisionRef.current === revision) {
        await showEditFailure(error, revision);
      }
      return;
    } finally {
      if (draftSaveRef.current === revision) {
        draftSaveRef.current = null;
        if (mountedRef.current) setDraftSavingRevision(null);
      }
    }
    await refresh(false);
  };

  const showEditFailure = async (error: unknown, revision: number) => {
    const code = error instanceof Error ? error.message : '';
    const base = editBaseRef.current;
    let latest: MemoryEntry | null = null;
    if (base && code === 'MEMORY_EDIT_CONFLICT') {
      try { latest = await loadMemory(base.memory.id); } catch { /* Keep the draft when the comparison cannot be loaded. */ }
    }
    if (!mountedRef.current || revision !== selectionRevisionRef.current) return;
    setEditConflict(latest?.type !== 'archived' ? latest : null);
    setDraftSaveError(latest?.type === 'archived' || code === 'MEMORY_ARCHIVED'
      ? '原卡已归档，输入已保留；不会自动恢复原卡。'
      : code === 'MEMORY_NOT_FOUND' ? '原卡已删除，输入已保留；不会另存一张卡。'
        : code === 'MEMORY_DATA_CHANGED' ? '数据已恢复或切换，输入已保留；请重新打开原卡核对。'
          : latest ? '原卡有了变化，请对照最新原卡与下方编辑稿，再保存。'
            : '保存失败，输入内容已保留，请重试。');
  };

  const acceptEditComparison = () => {
    const base = editBaseRef.current;
    if (!base || !editConflict || draftSaveRef.current !== null) return;
    const latest = editConflict;
    // Keep only fields actually offered by this editor; hidden evidence and time remain current.
    if (base.source) setSourceCorrectionCandidate(current => current ? { ...latest,
      title: current.title, content: current.content, rememberedReason: current.rememberedReason } : current);
    else setDraft(current => ({ ...latest, title: current.title, content: current.content, domain: current.domain,
      tags: current.tags, recallCues: current.recallCues, rememberedReason: current.rememberedReason,
      importance: current.importance, pinned: current.pinned, anchor: current.anchor, anchorKind: current.anchorKind }));
    editBaseRef.current = { ...base, memory: latest };
    setSelected(latest);
    setEditConflict(null);
    setDraftSaveError('已核对最新原卡，请检查编辑稿后保存。');
  };

  const cancelEdit = () => {
    if (draftSaveRef.current !== null) return;
    editBaseRef.current = null;
    setEditConflict(null);
    setDraftSaveError('');
    setCreating(false);
    setEditing(false);
  };

  const openThread = async (thread: EventThread) => {
    const detail = await loadMemoryThread(thread.id);
    if (detail) {
      setThreadDetail(detail);
      setTimelineTitle(detail.thread.title);
      setTimelineSearch('');
      setTimelineEditing(false);
    }
  };

  const createTimeline = async () => {
    if (!timelineTitle.trim() || !timelineSelectedIds.length) return;
    const id = await createManualTimeline(timelineTitle, timelineSelectedIds);
    setTimelineCreating(false);
    setTimelineTitle('');
    setTimelineSearch('');
    setTimelineSelectedIds([]);
    await refresh();
    const created = (await buildMemoryThreads()).find((thread) => thread.id === id);
    if (created) await openThread(created);
  };

  const addMemoryToCurrentTimeline = async (memory: MemoryEntry) => {
    if (!threadDetail) return;
    await setTimelineMemoryIncluded(threadDetail.thread.id, memory.id, true);
    await refresh();
    const detail = await loadMemoryThread(threadDetail.thread.id);
    if (detail) setThreadDetail(detail);
    setTimelineSearch('');
  };

  const removeMemoryFromCurrentTimeline = async (memory: MemoryEntry) => {
    if (!threadDetail) return;
    await setTimelineMemoryIncluded(threadDetail.thread.id, memory.id, false);
    const detail = await loadMemoryThread(threadDetail.thread.id);
    setThreadDetail(detail ?? null);
    await refresh();
  };

  const saveTimelineTitle = async () => {
    if (!threadDetail || !timelineTitle.trim()) return;
    await updateTimelineTitle(threadDetail.thread.id, timelineTitle, threadDetail.thread.manual === true);
    const detail = await loadMemoryThread(threadDetail.thread.id);
    if (detail) setThreadDetail(detail);
    setTimelineEditing(false);
    await refresh();
  };

  const hideCurrentTimelineAfterConfirm = async () => {
    if (!threadDetail) return;
    await setTimelineHidden(threadDetail.thread.id, true, threadDetail.thread.manual === true);
    setThreadDetail(null);
    setTimelineEditing(false);
    await refresh();
  };

  const addComment = async () => {
    if (!selected || !commentText.trim()) return;
    const revision = selectionRevisionRef.current;
    if (commentSaveRef.current === revision) return;
    commentSaveRef.current = revision;
    setCommentSavingRevision(revision);
    setCommentSaveError('');
    try {
      await createMemoryComment(selected.id, commentText.trim());
    } catch {
      if (selectionIsCurrent(selected, revision)) {
        setCommentSaveError('补记保存失败，输入内容已保留，请重试。');
      }
      return;
    } finally {
      if (commentSaveRef.current === revision) {
        commentSaveRef.current = null;
        if (mountedRef.current) setCommentSavingRevision(null);
      }
    }
    if (!selectionIsCurrent(selected, revision)) return;
    setCommentText((current) => current === commentText ? '' : current);
    await refresh(false);
  };

  const addSourceCorrection = async (note: string) => {
    if (!selected || !note.trim()) return;
    const revision = selectionRevisionRef.current;
    await createMemoryComment(
      selected.id,
      buildSourceCorrectionComment({
        kind: 'correction',
        memory: selected,
        note,
        trace: sourceTrace,
      }),
      'manual',
      {
        kind: 'correction',
        source: 'source-correction',
        touch: false,
      },
    );
    await createMemoryRecallFeedback({
      kind: 'corrected',
      memoryId: selected.id,
      query: buildSourceCorrectionQuery(selected, sourceTrace),
      reason: 'direct',
      sources: [],
    });
    await reloadSelectedMemory(revision);
  };

  const markSourceOutdated = async (note: string) => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    const nextNote = note.trim() || '这条记忆的来源背景已经过期，之后召回时需要更谨慎。';
    await createMemoryComment(
      selected.id,
      buildSourceCorrectionComment({
        kind: 'outdated',
        memory: selected,
        note: nextNote,
        trace: sourceTrace,
      }),
      'manual',
      {
        kind: 'update',
        source: 'source-outdated',
        touch: false,
      },
    );
    await createMemoryRecallFeedback({
      kind: 'outdated',
      memoryId: selected.id,
      query: buildSourceCorrectionQuery(selected, sourceTrace),
      reason: 'direct',
      sources: [],
    });
    await reloadSelectedMemory(revision);
  };

  const archiveSelectedAsWrongSource = async () => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    await createMemoryComment(
      selected.id,
      '来源纠错：小仓鼠确认这条记忆不该继续保存，已改为归档。',
      'manual',
      {
        kind: 'correction',
        source: 'source-wrong-memory',
        touch: false,
      },
    );
    await createMemoryRecallFeedback({
      kind: 'corrected',
      memoryId: selected.id,
      query: buildSourceCorrectionQuery(selected, sourceTrace),
      reason: 'direct',
      sources: [],
    });
    await archiveMemory(selected.id, '来源纠错：这条记忆不该保存。');
    await reloadSelectedMemory(revision);
  };

  const makeCorrectionCandidateFromSource = (correctionText = '') => {
    if (!selected) return;
    editBaseRef.current = { memory: selected, epoch: captureBackupRestoreDataEpoch(), source: true };
    setEditConflict(null);
    setDraftSaveError('');
    setSourceCorrectionCandidate(buildSourceCorrectionDraft(selected, sourceTrace, correctionText));
  };

  const updateSourceCorrectionCandidate = (patch: Partial<MemoryDraft>) => {
    if (draftSaveRef.current !== null) return;
    setSourceCorrectionCandidate((candidate) => candidate ? { ...candidate,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.content !== undefined ? { content: patch.content } : {}),
      ...(patch.rememberedReason !== undefined ? { rememberedReason: patch.rememberedReason } : {}) } : candidate);
  };

  const discardSourceCorrectionCandidate = () => {
    if (draftSaveRef.current !== null) return;
    if (editBaseRef.current?.source) editBaseRef.current = null;
    setEditConflict(null);
    setDraftSaveError('');
    setSourceCorrectionCandidate(null);
  };

  const openSourceSelection = async () => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    setSourceSelectionOpen(true);
    setSourceSelectionLoading(true);
    try {
      const [groups, refs] = await Promise.all([
        loadMemorySourceSelectionCandidates(selected),
        loadMemorySourceRefs(selected.id),
      ]);
      if (!selectionIsCurrent(selected, revision)) return;
      setSourceSelectionGroups(groups);
      setSourceSelectionKeys(refs.map((ref) => `${ref.sessionId}\u0000${ref.messageId}`));
    } finally {
      if (selectionIsCurrent(selected, revision)) setSourceSelectionLoading(false);
    }
  };

  const closeSourceSelection = () => {
    setSourceSelectionOpen(false);
    setSourceSelectionGroups([]);
    setSourceSelectionKeys([]);
  };

  const toggleSourceSelection = (sessionId: string, messageId: string) => {
    const key = `${sessionId}\u0000${messageId}`;
    setSourceSelectionKeys((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key]);
  };

  const saveSourceSelection = async () => {
    if (!selected || !sourceSelectionKeys.length) return;
    const revision = selectionRevisionRef.current;
    const selectedKeys = new Set(sourceSelectionKeys);
    const refs: MemorySourceRefInput[] = sourceSelectionGroups.flatMap((group) => (
      group.messages
        .filter((message) => selectedKeys.has(`${group.sessionId}\u0000${message.id}`))
        .map((message) => ({
          excerpt: message.content,
          messageCreatedAt: message.createdAt,
          messageId: message.id,
          relation: 'direct' as const,
          role: message.role,
          sessionId: group.sessionId,
        }))
    ));
    if (!refs.length) return;
    await replaceMemorySourceRefs(selected.id, refs);
    await createMemoryComment(
      selected.id,
      `来源纠错：小仓鼠重新选择了 ${refs.length} 条真实消息作为精确来源。`,
      'manual',
      { kind: 'correction', source: 'source-reselection', touch: false },
    );
    await createMemoryRecallFeedback({
      kind: 'corrected',
      memoryId: selected.id,
      query: buildSourceCorrectionQuery(selected, sourceTrace),
      reason: 'direct',
      sources: [],
    });
    if (!selectionIsCurrent(selected, revision)) return;
    closeSourceSelection();
    await reloadSelectedMemory(revision);
  };

  const saveSourceCorrectionCandidateAsUpdate = async () => {
    if (!selected || !sourceCorrectionCandidate || editConflict || draftSaveRef.current !== null) return;
    const revision = selectionRevisionRef.current;
    const base = editBaseRef.current;
    if (!base || !base.source || base.memory.id !== selected.id) return;
    draftSaveRef.current = revision;
    setDraftSavingRevision(revision);
    setDraftSaveError('');
    try {
      await updateMemory(selected.id, sourceCorrectionCandidate, {
        confirmationLevel: 'reviewed', expectedEditableHash: weeklyTargetHash(base.memory),
        dataEpoch: base.epoch, writeIntent: 'correction', lifecycleReasonCode: 'source-correction-update',
        correctionFeedbackQuery: buildSourceCorrectionQuery({ ...base.memory, ...sourceCorrectionCandidate }, sourceTrace),
      });
      if (!selectionIsCurrent(selected, revision)) return;
      editBaseRef.current = null;
      setSourceCorrectionCandidate(null);
    } catch (error) {
      await showEditFailure(error, revision);
      return;
    } finally {
      if (draftSaveRef.current === revision) {
        draftSaveRef.current = null;
        if (mountedRef.current) setDraftSavingRevision(null);
      }
    }
    try { await reloadSelectedMemory(revision); }
    catch { if (selectionIsCurrent(selected, revision)) setDraftSaveError('修改已保存，详情暂未刷新，请重新打开。'); }
  };

  const saveSourceCorrectionCandidateAsComment = async () => {
    if (!selected || !sourceCorrectionCandidate || draftSaveRef.current !== null) return;
    const revision = selectionRevisionRef.current;
    await createMemoryComment(
      selected.id,
      `来源纠错候选：${sourceCorrectionCandidate.content}`,
      'manual',
      {
        kind: 'correction',
        source: 'source-correction-candidate',
        touch: false,
      },
    );
    if (!selectionIsCurrent(selected, revision)) return;
    setSourceCorrectionCandidate(null);
    await reloadSelectedMemory(revision);
  };

  const deleteComment = async (commentId: string) => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    await deleteMemoryComment(commentId);
    if (!selectionIsCurrent(selected, revision)) return;
    await readSelectedDetail(selected, revision);
  };

  const mergeSelectedMemory = async (source: MemoryEntry) => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    await mergeMemoryInto(selected.id, source.id, { confirmationLevel: 'manual' });
    if (!selectionIsCurrent(selected, revision)) return;
    setMergeOpen(false);
    setMergeQuery('');
    await refresh();
  };

  const deleteSelectedMemory = async () => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    const outcome = await hardDeleteMemory(selected.id);
    if (outcome !== 'deleted' || !selectionIsCurrent(selected, revision)) return;
    setSelected(null);
    resetSelectedDiagnostics();
    await refresh();
  };

  const undoSelectedMerge = async () => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    const outcome = await undoMemoryMerge(selected.id);
    if (!selectionIsCurrent(selected, revision)) return;
    await refresh();
    const latest = await loadMemories({ includeArchived: true })
      .then((records) => records.find((memory) => memory.id === selected.id) ?? null);
    if (!selectionIsCurrent(selected, revision)) return;
    if (latest) {
      const opening = openMemory(latest);
      const openedRevision = selectionRevisionRef.current;
      await opening;
      if (selectionIsCurrent(latest, openedRevision)) setMergeUndoOutcome(outcome);
    }
  };

  const rebuildSelectedEmbedding = async () => {
    if (!selected) return;
    const revision = selectionRevisionRef.current;
    await generateMemoryEmbedding(selected.id);
    if (!selectionIsCurrent(selected, revision)) return;
    await openMemory(selected);
  };

  const toggleSelectedDigested = async () => {
    if (!selected) return;
    await updateMemoryState(selected.id, { digested: !selected.digested });
    await refresh();
  };

  const toggleSelectedSurfaceMuted = async () => {
    if (!selected) return;
    await updateMemoryState(selected.id, { surfaceMutedAt: selected.surfaceMutedAt ? undefined : Date.now() });
    await refresh();
  };

  const toggleSelectedArchive = async () => {
    if (!selected) return;
    if (selected.type === 'archived' && mergeRecovery) await undoSelectedMerge();
    else if (selected.type === 'archived') await restoreMemory(selected.id);
    else await archiveMemory(selected.id);
    await refresh();
  };

  const toggleMemoryArchive = async (memory: MemoryEntry) => {
    if (memory.type === 'archived') {
      const detail = await loadMemoryScreenDetailSnapshot(memory);
      if (detail.mergeRecovery) await undoMemoryMerge(memory.id);
      else await restoreMemory(memory.id);
    }
    else await archiveMemory(memory.id);
    await refresh();
  };

  const changeMonth = (nextMonth: Date) => {
    setMonth(nextMonth);
    setSelectedDate(new Date(nextMonth.getFullYear(), nextMonth.getMonth(), 1));
  };

  const filteredMemories = useMemo(() => filterMemoryScreenMemories({
    domain,
    memories,
    mode,
    query,
    searchResults,
  }), [domain, memories, mode, query, searchResults]);
  const dateMemories = useMemo(
    () => getMemoryScreenDateMemories(memories, selectedDate),
    [memories, selectedDate],
  );
  const markedDates = useMemo(() => getMemoryScreenMarkedDates(memories), [memories]);
  const timelineCandidates = useMemo(() => getMemoryTimelineCandidates({
    existingMemoryIds: threadDetail?.thread.memoryIds ?? timelineSelectedIds,
    memories,
    timelineSearch,
  }), [memories, threadDetail, timelineSearch, timelineSelectedIds]);
  const mergeCandidates = useMemo(() => getMemoryMergeCandidates({
    memories,
    mergeQuery,
    selected,
  }), [memories, mergeQuery, selected]);

  return {
    editConflict,
    acceptEditComparison,
    cancelEdit,
    addComment,
    addMemoryToCurrentTimeline,
    beginEdit,
    beginNew,
    changeMonth,
    commentText,
    commentSaveError,
    commentSaving: commentSavingRevision === selectionRevisionRef.current,
    comments,
    createTimeline,
    creating,
    dateMemories,
    deleteComment,
    deleteSelectedMemory,
    dehydrationDiagnostic,
    domain,
    draft,
    draftSaveError,
    draftSaving: draftSavingRevision === selectionRevisionRef.current,
    editing,
    embeddingStatus,
    filteredMemories,
    graphLinks,
    healthReport,
    healthSummary,
    sourceTrace,
    sourceCorrectionCandidate,
    sourceSelectionGroups,
    sourceSelectionKeys,
    sourceSelectionLoading,
    sourceSelectionOpen,
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
    rebuildSelectedEmbedding,
    recallCuesText,
    refresh,
    refreshNotice,
    refreshing,
    retryRefresh: () => refresh(false),
    refreshSelectedMemory: reloadSelectedMemory,
    refreshStarMap: refreshStarMapNow,
    removeMemoryFromCurrentTimeline,
    saveDraft,
    addSourceCorrection,
    archiveSelectedAsWrongSource,
    discardSourceCorrectionCandidate,
    makeCorrectionCandidateFromSource,
    openSourceSelection,
    markSourceOutdated,
    saveSourceCorrectionCandidateAsComment,
    saveSourceCorrectionCandidateAsUpdate,
    saveSourceSelection,
    saveTimelineTitle,
    searchResults,
    meaningSearching,
    searchNotice,
    searchByMeaning,
    cancelMeaningSearch,
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
    closeSourceSelection,
    toggleSourceSelection,
    updateSourceCorrectionCandidate,
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
    undoSelectedMerge,
  };
}


