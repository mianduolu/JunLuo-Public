import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  acceptBaiyunContinuityCandidate,
  dismissBaiyunContinuityCandidate,
  listBaiyunContinuityCandidates,
  undoBaiyunContinuityRegistration,
  type BaiyunContinuityCandidate,
} from '../ai/behavior/continuityLedger';
import { BAIYUN_CONTINUITY_KIND_LABELS } from '../ai/behavior/continuityLedgerPresentation';

type ContinuityReviewMessage = {
  id: string;
  content: string;
};

export type ChatContinuityReviewItem = {
  candidate: BaiyunContinuityCandidate;
  sourceExcerpt: string;
  title: '已登记为牵挂' | '可能是一条牵挂' | '可能已有进展';
  kindLabel: string;
  stateLabel?: string;
};

type UseChatContinuityReviewControllerInput = {
  active: boolean;
  messages: readonly ContinuityReviewMessage[];
  onError?: (message: string) => void;
  sessionId?: string | null;
};

function compactExcerpt(value: string) {
  const compact = value.replace(/\s+/gu, ' ').trim();
  if (!compact) return '来源消息不可用';
  return compact.length > 120
    ? `${compact.slice(0, 119)}…`
    : compact;
}

function resolutionLabel(candidate: BaiyunContinuityCandidate) {
  if (candidate.proposedResolution === 'progressed') return '建议状态：已有进展';
  if (candidate.proposedResolution === 'completed') return '建议状态：已经完成';
  if (candidate.proposedResolution === 'cancelled') return '建议状态：已经取消';
  return undefined;
}

export function useChatContinuityReviewController({
  active,
  messages,
  onError,
  sessionId,
}: UseChatContinuityReviewControllerInput) {
  const [candidates, setCandidates] = useState<BaiyunContinuityCandidate[]>([]);
  const [busyCandidateIds, setBusyCandidateIds] = useState<string[]>([]);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!active || !sessionId) {
      setCandidates([]);
      return;
    }
    try {
      const next = await listBaiyunContinuityCandidates({
        sessionId,
        states: ['pending', 'accepted'],
        since: Date.now() - 24 * 60 * 60 * 1000,
        limit: 30,
        maintain: false,
      });
      if (generation !== generationRef.current) return;
      setCandidates(next.filter((candidate) => (
        candidate.state === 'pending'
        || (
          candidate.state === 'accepted'
          && candidate.kind === 'create_event'
        )
      )));
    } catch (caught) {
      if (generation === generationRef.current) {
        console.warn('[continuity-review] candidate tray refresh failed', caught);
      }
    }
  }, [active, sessionId]);

  const latestMessageId = messages[messages.length - 1]?.id;
  useEffect(() => {
    void refresh();
    const retry = setTimeout(() => {
      void refresh();
    }, 900);
    return () => clearTimeout(retry);
  }, [latestMessageId, messages.length, refresh]);

  const messageById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );

  const items = useMemo<ChatContinuityReviewItem[]>(() => candidates.map((candidate) => ({
    candidate,
    sourceExcerpt: compactExcerpt(messageById.get(candidate.messageId)?.content ?? ''),
    title: candidate.state === 'accepted'
      ? '已登记为牵挂'
      : candidate.kind === 'create_event'
        ? '可能是一条牵挂'
        : '可能已有进展',
    kindLabel: candidate.eventKind
      ? BAIYUN_CONTINUITY_KIND_LABELS[candidate.eventKind]
      : '既有牵挂',
    stateLabel: resolutionLabel(candidate),
  })), [candidates, messageById]);

  const run = useCallback(async (
    candidate: BaiyunContinuityCandidate,
    action: () => Promise<unknown>,
  ) => {
    setBusyCandidateIds((current) => (
      current.includes(candidate.id) ? current : [...current, candidate.id]
    ));
    try {
      await action();
      await refresh();
    } catch {
      onError?.('这张牵挂卡的状态刚刚发生了变化，已经为你重新加载。');
      await refresh();
    } finally {
      setBusyCandidateIds((current) => current.filter((id) => id !== candidate.id));
    }
  }, [onError, refresh]);

  return {
    busyCandidateIds,
    items,
    onAccept: (candidate: BaiyunContinuityCandidate) => run(
      candidate,
      () => acceptBaiyunContinuityCandidate({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
      }),
    ),
    onDismiss: (candidate: BaiyunContinuityCandidate) => run(
      candidate,
      () => dismissBaiyunContinuityCandidate({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
      }),
    ),
    onRefresh: refresh,
    onUndo: (candidate: BaiyunContinuityCandidate) => run(
      candidate,
      () => undoBaiyunContinuityRegistration({
        candidateId: candidate.id,
        expectedRevision: candidate.revision,
      }),
    ),
  };
}

