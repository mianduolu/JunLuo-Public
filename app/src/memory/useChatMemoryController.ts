import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { subscribeSavedCameraObservations } from '../camera/cameraObservationStore';
import { subscribeWeeklyRefreshChanges } from './memoryWeeklyRefresh';
import { subscribeUnderstandingChanges } from './memoryUnderstandingReview';
import { subscribeMemoryProcessingUpdates } from './memoryProcessingSignals';

import type { MemoryBundleDebug } from './memoryOrchestrator';
import type { MemoryRecallItem } from './memoryStore';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { appendMemoryCandidateReviews, memoryCandidateEditableHash } from './memoryCandidateReview';
import { loadPendingMemoryCandidates, subscribeMemoryCandidateInvalidation, updatePendingMemoryCandidates, loadLatestUnfinishedMemoryIngestionWork } from './memoryIngestionService';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadPendingCurrentStateReviews } from './memoryCurrentStateRecovery';
import type {
  MemoryCurrentStateCandidate,
  MemoryCurrentStateResolveCandidate,
} from './memoryCurrentStateCandidates';
import {
  createChatMemoryController,
  type ChatMemoryControllerOptions,
  type ChatMemoryControllerState,
} from './chatMemoryRuntime';

export { shouldAttemptEpisodeMemoryForMessages } from './chatMemoryRuntime';

const CANDIDATE_WRITE_NOTICE = '候选修改暂未写入本地，重新打开前请稍后再试。';

async function verifyDraftsPersisted(drafts: MemoryCandidateReview[], epoch: number | null) {
  const batchIds = [...new Set(drafts.flatMap(draft => draft.ingestionRefs?.map(ref => ref.batchId) ?? []))];
  const pending = await loadPendingMemoryCandidates({ batchIds, includeWaiting: true });
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_DATA_CHANGED');
  for (const draft of drafts) {
    const stored = pending.find(item => item.reviewId === draft.reviewId);
    if (!stored || memoryCandidateEditableHash(stored) !== memoryCandidateEditableHash(draft)) {
      throw new Error('MEMORY_CANDIDATE_CHANGED');
    }
  }
}

export function useChatMemoryController({
  activeSessionRef,
  ai,
  automaticExplicitFactMemories,
  isActive,
  onOrganizedThroughIdChange,
  onProactiveReviewedThroughIdChange,
  proactiveMemorySuggestions,
  messages,
}: ChatMemoryControllerOptions) {
  const automaticExplicitFactMemoriesRef = useRef(automaticExplicitFactMemories);
  automaticExplicitFactMemoriesRef.current = automaticExplicitFactMemories;
  const [flaggedRecallIds, setFlaggedRecallIds] = useState<Set<string>>(() => new Set());
  const [latestMemoryDebug, setLatestMemoryDebug] = useState<MemoryBundleDebug | null>(null);
  const [latestMemoryRecall, setLatestMemoryRecall] = useState<MemoryRecallItem[] | null>(null);
  const [latestMemoryRecallQuery, setLatestMemoryRecallQuery] = useState('');
  const [memoryCandidates, setMemoryCandidateState] = useState<MemoryCandidateReview[]>([]);
  const memoryCandidatesRef = useRef(memoryCandidates);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const dirtyCandidateDrafts = useRef(new Map<string, MemoryCandidateReview>());
  const candidateRemovalRevisionRef = useRef(0);
  const candidateEditRevisionRef = useRef(0);
  const [currentStateCandidates, setCurrentStateCandidates] = useState<MemoryCurrentStateCandidate[]>([]);
  const [currentStateResolveCandidates, setCurrentStateResolveCandidates] = useState<MemoryCurrentStateResolveCandidate[]>([]);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [organizing, setOrganizing] = useState(false);
  const [unfinishedOrganization, setUnfinishedOrganization] = useState(false);
  const organizationAbortRef = useRef<AbortController | null>(null);
  const waitingOrganizationRef = useRef<string | null>(null);
  useEffect(() => () => organizationAbortRef.current?.abort(), []);

  const memoryNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const proactiveReviewingRef = useRef(false);
  const memoryOrganizationRevisionRef = useRef(0);
  const lastProactiveMemorySuggestionAtRef = useRef(0);
  const lastEpisodeMemoryAttemptAtRef = useRef(0);
  const lastEpisodeMemoryThroughIdRef = useRef<string | null>(null);
  const lastWeeklyContextAttemptAtRef = useRef(0);
  const lastWeeklyContextThroughIdRef = useRef<string | null>(null);
  const voiceCallCandidateBatchesSeenRef = useRef(new Set<string>());
  const voiceCallOrganizationInFlightRef = useRef(new Set<string>());

  const setMemoryCandidates: ChatMemoryControllerState['setMemoryCandidates'] = (value) => {
    candidateEditRevisionRef.current += 1;
    const previous = memoryCandidatesRef.current;
    const next = typeof value === 'function' ? value(previous) : value;
    if ((Array.isArray(value) && !value.length)
      || previous.some((candidate) => !next.some((item) => item.reviewId === candidate.reviewId))) {
      candidateRemovalRevisionRef.current += 1;
    }
    memoryCandidatesRef.current = next;
    setMemoryCandidateState(next);
    const changed = next.filter((candidate) => {
      const original = previous.find((item) => item.reviewId === candidate.reviewId);
      // Newly displayed cards were already registered. Only edits need another write.
      return candidate.ingestionRefs?.length && original && candidate !== original;
    });
    for (const id of dirtyCandidateDrafts.current.keys()) {
      if (!next.some(candidate => candidate.reviewId === id)) dirtyCandidateDrafts.current.delete(id);
    }
    for (const candidate of changed) {
      dirtyCandidateDrafts.current.set(candidate.reviewId, candidate);
    }
    const sourceSessionId = activeSessionRef.current;
    const draftDataEpoch = captureBackupRestoreDataEpoch();
    const editsAreCurrent = () => mountedRef.current && activeSessionRef.current === sourceSessionId
      && changed.some(candidate => memoryCandidatesRef.current.some(current => current.reviewId === candidate.reviewId
        && (current === candidate || dirtyCandidateDrafts.current.get(candidate.reviewId) === candidate)));
    if (changed.length) void updatePendingMemoryCandidates(changed, { dataEpoch: draftDataEpoch }).then(async () => {
      await verifyDraftsPersisted(changed, draftDataEpoch);
      const current = editsAreCurrent();
      for (const candidate of changed) {
        if (dirtyCandidateDrafts.current.get(candidate.reviewId) === candidate) dirtyCandidateDrafts.current.delete(candidate.reviewId);
      }
      if (current && !dirtyCandidateDrafts.current.size) {
        setMemoryNotice(notice => notice === CANDIDATE_WRITE_NOTICE ? null : notice);
      }
    }).catch(() => {
      if (editsAreCurrent()) setMemoryNotice(CANDIDATE_WRITE_NOTICE);
    });
  };

  const sessionId = activeSessionRef.current;
  useEffect(() => {
    if (!sessionId) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    let cancelled = false;
    let restoreSequence = 0;
    const restore = (replace = false) => {
      let removalRevision: number;
      let editRevision: number;
      const sequence = ++restoreSequence;
      // Session activation clears the old UI in another effect during this same commit.
      void Promise.resolve().then(() => {
        removalRevision = candidateRemovalRevisionRef.current;
        editRevision = candidateEditRevisionRef.current;
        return loadPendingMemoryCandidates({ sessionId });
      }).then(async (pending) => {
        if (cancelled || activeSessionRef.current !== sessionId || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        const work = await loadLatestUnfinishedMemoryIngestionWork(sessionId).catch(() => null);
        if (cancelled || removalRevision !== candidateRemovalRevisionRef.current
          || editRevision !== candidateEditRevisionRef.current || sequence !== restoreSequence
          || activeSessionRef.current !== sessionId || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
        setUnfinishedOrganization(!!work);
        const restored = pending.map(candidate => {
          const dirty = dirtyCandidateDrafts.current.get(candidate.reviewId);
          return dirty ? { ...dirty, understandingStale: candidate.understandingStale, reviewStatus: candidate.reviewStatus } : candidate;
        });
        const retainedInputs = [...dirtyCandidateDrafts.current.values()].filter(draft => !restored.some(item => item.reviewId === draft.reviewId))
          .map(draft => ({ ...draft, reviewStatus: 'missing' as const }));
        const next = replace ? [...restored, ...retainedInputs] : appendMemoryCandidateReviews(memoryCandidatesRef.current, restored);
        memoryCandidatesRef.current = next;
        setMemoryCandidateState(next);
        try {
          const states = await loadPendingCurrentStateReviews(sessionId);
          if (!cancelled && activeSessionRef.current === sessionId && sequence === restoreSequence && canCommitBackupRestoreDataEpoch(dataEpoch)) {
            setCurrentStateCandidates(states.currentStateCandidates);
            setCurrentStateResolveCandidates(states.currentStateResolveCandidates);
          }
        } catch {
          if (!cancelled && activeSessionRef.current === sessionId && sequence === restoreSequence) {
            setMemoryNotice('旧近况草稿暂未恢复，原稿仍保留，可以稍后重新打开对话。');
          }
        }
      }).catch(() => {
        if (!cancelled && activeSessionRef.current === sessionId) {
          setMemoryNotice('待处理记忆暂未恢复，可以稍后重新打开对话。');
        }
      });
    };
    restore();
    const unsubscribeWeekly = subscribeWeeklyRefreshChanges(() => restore(true));
    const unsubscribeUnderstanding = subscribeUnderstandingChanges(() => restore(true));
    const unsubscribeUpdates = subscribeMemoryProcessingUpdates(() => restore(true));
    const unsubscribe = subscribeMemoryCandidateInvalidation((changedSessionId) => {
      if (changedSessionId !== sessionId) return;
      candidateRemovalRevisionRef.current += 1;
      memoryCandidatesRef.current = [];
      setMemoryCandidateState([]);
      setCurrentStateCandidates([]);
      setCurrentStateResolveCandidates([]);
      restore(true);
    });
    return () => { cancelled = true; unsubscribe(); unsubscribeWeekly(); unsubscribeUnderstanding(); unsubscribeUpdates(); };
  }, [sessionId]);

  const { processVoiceCallMemoryCandidates, ...controller } = createChatMemoryController({
    activeSessionRef,
    ai,
    automaticExplicitFactMemories,
    getAutomaticExplicitFactMemories: () => automaticExplicitFactMemoriesRef.current,
    isActive,
    onOrganizedThroughIdChange,
    onProactiveReviewedThroughIdChange,
    proactiveMemorySuggestions,
    messages,
  }, {
    flaggedRecallIds, setFlaggedRecallIds,
    latestMemoryDebug, setLatestMemoryDebug,
    latestMemoryRecall, setLatestMemoryRecall,
    latestMemoryRecallQuery, setLatestMemoryRecallQuery,
    memoryCandidates, setMemoryCandidates,
    memoryCandidateRemovalRevisionRef: candidateRemovalRevisionRef,
    memoryOrganizationRevisionRef,
    organizationAbortRef, waitingOrganizationRef, setUnfinishedOrganization,
    currentStateCandidates, setCurrentStateCandidates,
    currentStateResolveCandidates, setCurrentStateResolveCandidates,
    memoryNotice, setMemoryNotice,
    organizing, setOrganizing,
    memoryNoticeTimerRef,
    proactiveReviewingRef,
    lastProactiveMemorySuggestionAtRef,
    lastEpisodeMemoryAttemptAtRef,
    lastEpisodeMemoryThroughIdRef,
    lastWeeklyContextAttemptAtRef,
    lastWeeklyContextThroughIdRef,
    voiceCallCandidateBatchesSeenRef,
    voiceCallOrganizationInFlightRef,
  });

  useEffect(() => {
    processVoiceCallMemoryCandidates();
  }, [messages]);

  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  const voiceProcessorRef = useRef(processVoiceCallMemoryCandidates);
  voiceProcessorRef.current = processVoiceCallMemoryCandidates;
  useEffect(() => {
    const resume = () => {
      if (AppState.currentState === 'active') {
        void controllerRef.current.resumeExplicitFactMemories().catch(() => undefined);
        void controllerRef.current.resumeObservationOrganization().catch(() => undefined);
        if (isActive?.() ?? true) voiceProcessorRef.current();
      }
    };
    const start = setTimeout(resume, 5_000);
    const interval = setInterval(resume, 60_000);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
    });
    const unsubscribeObservation = subscribeSavedCameraObservations(() => {
      if (AppState.currentState === 'active') void controllerRef.current.resumeObservationOrganization().catch(() => undefined);
    });
    return () => { clearTimeout(start); clearInterval(interval); subscription.remove(); unsubscribeObservation(); };
  }, []);

  return { ...controller, unfinishedOrganization, flushCandidateDrafts: async () => {
    const drafts = [...dirtyCandidateDrafts.current.values()];
    if (!drafts.length) return;
    const epoch = captureBackupRestoreDataEpoch();
    try {
      await updatePendingMemoryCandidates(drafts, { dataEpoch: epoch });
      await verifyDraftsPersisted(drafts, epoch);
      for (const draft of drafts) if (dirtyCandidateDrafts.current.get(draft.reviewId) === draft) dirtyCandidateDrafts.current.delete(draft.reviewId);
    } catch (error) { setMemoryNotice(CANDIDATE_WRITE_NOTICE); throw error; }
  }, saveCandidate: async (candidate: MemoryCandidateReview, index: number) => {
    const latest = memoryCandidatesRef.current.find(item => item.reviewId === candidate.reviewId);
    if (!latest) return;
    await controllerRef.current.saveCandidate(latest, index);
    await controllerRef.current.resumeWaitingOrganization();
  }, discardCandidate: async (reviewId: string) => {
    await controllerRef.current.discardCandidate(reviewId);
    await controllerRef.current.resumeWaitingOrganization();
  } };
}
