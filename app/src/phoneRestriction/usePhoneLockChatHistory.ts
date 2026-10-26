import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, getBackupRestoreRuntimeState, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { loadChatSessionMessagePage, mergeSubjectiveMessages } from '../chat/chatStorage';
import { mergePhoneLockChatDisplayMessages, selectRecentPhoneLockChatMessages } from './phoneLockChatHistory';

// Read-only display initialization. It never commits into the conversation/model history.
export function usePhoneLockChatHistory(options: {
  visible: boolean; ready: boolean; sessionId: string | null;
  messages: SubjectiveMessage[]; loadedStartIndex: number;
}) {
  const [initial, setInitial] = useState<{
    messages: SubjectiveMessage[]; liveIds: Set<string>; sessionId: string; epoch: number | null;
  } | null>(null);
  const [failure, setFailure] = useState(false);
  const restoreState = useSyncExternalStore(subscribeBackupRestoreRuntimeState, getBackupRestoreRuntimeState);
  useEffect(() => {
    setInitial(null);
    setFailure(false);
    if (!options.visible || !options.ready || !options.sessionId || restoreState.status !== 'ready') return;
    let cancelled = false;
    const epoch = captureBackupRestoreDataEpoch();
    const liveIds = new Set(options.messages.map(message => message.id));
    void (async () => {
      let messages = options.messages;
      let beforeIndex = options.loadedStartIndex;
      while (beforeIndex > 0 && messages.filter(message => message.role === 'you').length < 5) {
        const page = await loadChatSessionMessagePage(options.sessionId!, {
          beforeIndex, limit: 30, waitForPendingWrites: false,
        });
        if (cancelled || !canCommitBackupRestoreDataEpoch(epoch)) return;
        messages = mergeSubjectiveMessages(messages, page.messages);
        if (page.startIndex >= beforeIndex) break;
        beforeIndex = page.startIndex;
      }
      if (!cancelled && canCommitBackupRestoreDataEpoch(epoch)) {
        setInitial({ messages: selectRecentPhoneLockChatMessages(messages), liveIds,
          sessionId: options.sessionId!, epoch });
      }
    })().catch(() => { if (!cancelled && canCommitBackupRestoreDataEpoch(epoch)) setFailure(true); });
    return () => { cancelled = true; };
    // Capture one opening window. New messages append; they do not evict these rounds.
  }, [options.visible, options.ready, options.sessionId, restoreState]);
  const openingReady = !!initial && initial.sessionId === options.sessionId && canCommitBackupRestoreDataEpoch(initial.epoch);
  const messages = useMemo(() => {
    if (!initial || !openingReady || !options.visible || !options.ready) return [];
    return mergePhoneLockChatDisplayMessages(initial.messages, initial.liveIds, options.messages);
  }, [initial, openingReady, options.visible, options.ready, options.messages]);
  return { messages, loading: !openingReady && !failure, failure };
}
