import { useEffect, useRef, useState } from 'react';

import type { AiConnection } from '../ai/types';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
} from '../backup/backupRestoreCoordinator';
import { annotateManualMemoryCandidates } from './memoryAdmissionControl';
import {
  updateMemoryCandidateReview,
} from './memoryCandidateReview';
import {
  explainMemoryDehydrationEligibility,
  runMemoryDehydrationBatch,
} from './memoryDehydration';
import type { HistoryImportPreview } from './memoryHistoryImport';
import {
  loadHistoryImportState, processStoredHistoryImport, resolveStoredHistoryCandidate,
  stageHistoryImport, subscribeHistoryImports, updateStoredHistoryCandidate,
  type HistoryImportCandidate, type HistoryImportDocument,
} from './memoryHistoryImportStore';
import {
  deleteMemoryEdge,
  loadMemoryComments,
  reverseMemoryEdge,
  searchMemoryTextCandidates,
  searchMemories,
  updateMemoryEdge,
  type MemoryDraft,
  type MemoryEntry,
} from './memoryStore';
import { hasMemoryOrganizerConfig } from './memoryOrganizerConfigNotice';

export type { HistoryImportCandidate } from './memoryHistoryImportStore';

type MemoryToolAi = {
  connection?: AiConnection;
  key: string;
};

type ToolAlert = {
  message: string;
  title: string;
};

type MissingConfigResult = {
  status: 'missing_config';
};

type ToolFailedResult = {
  alert: ToolAlert;
  status: 'failed';
};

type DehydrationResult =
  | MissingConfigResult
  | ToolFailedResult
  | {
    alert: ToolAlert;
    status: 'done';
  }
  | {
    status: 'busy';
  };

type HistoryImportResult =
  | MissingConfigResult
  | ToolFailedResult
  | {
    alert: ToolAlert;
    status: 'done';
  };

export function useMemoryScreenTools({
  ai,
  refresh,
  refreshSelectedMemory,
  refreshStarMap,
}: {
  ai: MemoryToolAi;
  refresh: () => Promise<void>;
  refreshSelectedMemory: () => Promise<void>;
  refreshStarMap: () => Promise<void>;
}) {
  const [dehydrating, setDehydrating] = useState(false);
  const [dehydrationNotice, setDehydrationNotice] = useState('');
  const [historyImporting, setHistoryImporting] = useState(false);
  const [historyImportNotice, setHistoryImportNotice] = useState('');
  const [historyImportProgress, setHistoryImportProgress] = useState('');
  const [historyImportCandidates, setHistoryImportCandidates] = useState<HistoryImportCandidate[]>([]);
  const [historyImportDocuments, setHistoryImportDocuments] = useState<HistoryImportDocument[]>([]);
  const historyCandidatesRef = useRef(historyImportCandidates);
  const historyReadRevision = useRef(0);
  const mounted = useRef(true);

  const refreshHistoryImports = async () => {
    const revision = ++historyReadRevision.current;
    const dataEpoch = captureBackupRestoreDataEpoch();
    const state = await loadHistoryImportState();
    if (!mounted.current || revision !== historyReadRevision.current || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    historyCandidatesRef.current = state.candidates;
    setHistoryImportCandidates(state.candidates);
    setHistoryImportDocuments(state.documents);
    setHistoryImporting(state.documents.some((document) => document.running));
  };

  useEffect(() => {
    mounted.current = true;
    const reload = () => { void refreshHistoryImports().catch(() => {
      if (mounted.current) setHistoryImportNotice('历史导入记录暂未读取成功，请重新打开记忆页。');
    }); };
    const unsubscribe = subscribeHistoryImports(reload);
    reload();
    return () => { mounted.current = false; historyReadRevision.current += 1; unsubscribe(); };
  }, []);

  const findHistoryImportDuplicateHint = async (candidate: MemoryDraft) => {
    const search = `${candidate.title} ${candidate.content}`.trim();
    if (!search) return undefined;
    try {
      const textScores = await searchMemoryTextCandidates(search, 5);
      const matches = await searchMemories(search, { includeArchived: false, limit: 3, textScores });
      const match = matches.find((item) => item.memory.source !== 'history-import') ?? matches[0];
      return match ? `可能已有相似记忆：${match.memory.title}` : undefined;
    } catch {
      return undefined;
    }
  };

  const runDehydrationMaintenance = async (): Promise<DehydrationResult> => {
    if (dehydrating) return { status: 'busy' };
    if (!hasMemoryOrganizerConfig(ai)) return { status: 'missing_config' };
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return { status: 'busy' };
    setDehydrating(true);
    setDehydrationNotice('正在把旧长记忆压成短年轮...');
    try {
      const result = await runMemoryDehydrationBatch(
        { apiKey: ai.key, connection: ai.connection! },
        { dataEpoch, limit: 5 },
      );
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'busy' };
      const message = result.checked
        ? `旧记忆整理完成：压缩 ${result.dehydrated} 条，跳过 ${result.skipped} 条。`
        : '暂时没有需要压缩的旧长记忆。';
      setDehydrationNotice(message);
      await refresh();
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'busy' };
      await refreshSelectedMemory();
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'busy' };
      return { alert: { message, title: '旧记忆整理完成' }, status: 'done' };
    } catch {
      if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return { status: 'busy' };
      const message = '这次没有写入压缩年轮，稍后可以再试。';
      setDehydrationNotice('旧记忆整理失败了，聊天和记忆页不会受影响。');
      return { alert: { message, title: '整理失败' }, status: 'failed' };
    } finally {
      setDehydrating(false);
    }
  };

  const continueHistoryImport = async (importId: string): Promise<HistoryImportResult> => {
    if (!hasMemoryOrganizerConfig(ai)) return { status: 'missing_config' };
    setHistoryImporting(true);
    setHistoryImportProgress('正在继续未完成的文本块，每次最多 24 块。');
    setHistoryImportNotice('');
    try {
      await processStoredHistoryImport(importId, { apiKey: ai.key, connection: ai.connection! }, async (candidates) => {
        const annotated = await annotateManualMemoryCandidates(candidates);
        return Promise.all(annotated.map(async (candidate): Promise<HistoryImportCandidate> => ({
          ...candidate,
          duplicateHint: candidate.admission?.duplicateTitle
            ? `可能已有相似记忆：${candidate.admission.duplicateTitle}`
            : await findHistoryImportDuplicateHint(candidate),
        })));
      });
      await refreshHistoryImports();
      const state = await loadHistoryImportState();
      const document = state.documents.find((item) => item.id === importId);
      const message = document?.remainingChunks
        ? `已完成 ${document.completedChunks}/${document.chunkCount} 块，还有 ${document.remainingChunks} 块待处理（其中 ${document.failedChunks} 块本次失败）。可继续整理，已有候选和编辑已保留。`
        : '这份文件已整理完，候选等待人工保存或舍弃。';
      if (mounted.current) setHistoryImportNotice(message);
      return { alert: { message, title: '历史导入进度' }, status: 'done' };
    } catch {
      if (mounted.current) setHistoryImportNotice('历史导入暂未完成，已落盘的分块与候选仍保留。');
      return {
        alert: { message: '请从文件记录继续整理，已完成的块不会重复请求。', title: '导入暂未完成' },
        status: 'failed',
      };
    } finally {
      if (mounted.current) { setHistoryImporting(false); setHistoryImportProgress(''); }
    }
  };

  const processHistoryImportPreview = async (preview: HistoryImportPreview): Promise<HistoryImportResult> => {
    try {
      const importId = await stageHistoryImport(preview);
      await refreshHistoryImports();
      return continueHistoryImport(importId);
    } catch {
      return { status: 'failed', alert: { title: '导入未登记', message: '原文件暂未写入本地，尚未调用整理模型。请重新选择文件。' } };
    }
  };

  const updateHistoryImportCandidate = (reviewId: string, updates: Partial<HistoryImportCandidate>) => {
    historyReadRevision.current += 1;
    const next = updateMemoryCandidateReview(historyCandidatesRef.current, reviewId, updates);
    historyCandidatesRef.current = next;
    setHistoryImportCandidates(next);
    const candidate = next.find((item) => item.reviewId === reviewId);
    if (candidate) void updateStoredHistoryCandidate(candidate).catch(() => {
      if (mounted.current) setHistoryImportNotice('候选修改暂未写入本地，请稍后再试。');
    });
  };

  const discardHistoryImportCandidate = async (reviewId: string) => {
    const candidate = historyCandidatesRef.current.find((item) => item.reviewId === reviewId);
    if (!candidate) return;
    try {
      await resolveStoredHistoryCandidate(candidate, 'discarded');
      await refreshHistoryImports();
    } catch {
      if (mounted.current) setHistoryImportNotice('舍弃操作暂未保存，候选仍保留。');
    }
  };

  const saveHistoryImportCandidate = async (candidate: HistoryImportCandidate) => {
    try {
      await resolveStoredHistoryCandidate(candidate, 'saved', hasMemoryOrganizerConfig(ai)
        ? { apiKey: ai.key, connection: ai.connection! } : undefined);
      await refreshHistoryImports();
      await refresh();
    } catch {
      if (mounted.current) setHistoryImportNotice('候选暂未保存为记忆，请稍后重试。');
    }
  };

  const reverseEdge = async (edgeId: string, options: { refreshMap?: boolean } = {}) => {
    await reverseMemoryEdge(edgeId);
    await refreshSelectedMemory();
    if (options.refreshMap) await refreshStarMap();
  };

  const softenEdge = async (edgeId: string, options: { refreshMap?: boolean } = {}) => {
    await updateMemoryEdge(edgeId, {
      relationType: 'relates_to',
      reason: '用户手动修正：这两条只是相关，不作为更新关系。',
    });
    await refreshSelectedMemory();
    if (options.refreshMap) await refreshStarMap();
  };

  const deleteEdge = async (edgeId: string, options: { refreshMap?: boolean } = {}) => {
    await deleteMemoryEdge(edgeId);
    await refreshSelectedMemory();
    if (options.refreshMap) await refreshStarMap();
  };

  return {
    dehydration: {
      notice: dehydrationNotice,
      run: runDehydrationMaintenance,
      running: dehydrating,
    },
    graphRepair: {
      deleteEdge,
      reverseEdge,
      softenEdge,
    },
    historyImport: {
      candidates: historyImportCandidates,
      documents: historyImportDocuments,
      continueImport: continueHistoryImport,
      discardCandidate: discardHistoryImportCandidate,
      importing: historyImporting,
      notice: historyImportNotice,
      processPreview: processHistoryImportPreview,
      progress: historyImportProgress,
      saveCandidate: saveHistoryImportCandidate,
      updateCandidate: updateHistoryImportCandidate,
    },
  };
}
