import { useCallback, useEffect, useRef, useState } from 'react';
import { DeviceEventEmitter } from 'react-native';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { updateChatRuntimeResidencySnapshot } from '../runtime/appResidencyDiagnostics';
import { CHAT_MESSAGES_APPENDED_EVENT, type ChatMessagesAppendedEvent } from './chatMessageEvents';
import { createChatPersistenceCoordinator, filterPendingChatReplyMessages, retainChatMessageWriteSnapshot, retainChatSessionWriteSnapshots, type ChatPersistResult } from './chatPersistenceCoordinator';
import { subscribeChatDataChanges } from './chatDataChanges';
import { markVoiceCallRecordDeleted } from '../voiceCall/voiceCallRecordDeletion';
import { clearMemoryIngestionForSession } from '../memory/memoryIngestionService';
import {
  removeHeartCorpusEntriesForMessageIds,
} from './heartCorpusStore';
import {
  emptyChatContextCompressionState,
  loadChatSessionSnapshot,
  loadChatSessionMessagePage,
  loadChatSessionMessages,
  loadChatStateFast,
  mergeAndSaveChatSessionMessages,
  replaceChatSessionMessages,
  mergeChatSnapshotMessages,
  mergeSubjectiveMessages,
  saveActiveChatSessionId,
  saveChatState,
  updateChatSession,
  type ChatContextCompressionState,
  type ChatSession,
} from './chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from './primaryChat';
import {
  CHAT_RESIDENCY_GRACE_PERIOD_MS,
  CHAT_RESIDENCY_MESSAGE_LIMIT,
  compactHiddenChatResidency,
  compactInactiveChatSessions,
} from './chatResidency';
import {
  canLoadHistoryDiagnosticOlderPage,
  hasHistoryDiagnosticLoadedPage,
  noteHistoryDiagnosticPageLoaded,
  scheduleHistoryResidencySnapshot,
} from './chatHistoryResidencyDiagnostics';

const CHAT_MESSAGE_PAGE_SIZE = CHAT_RESIDENCY_MESSAGE_LIMIT;
const PHONE_GUARD_CHAT_MESSAGE_EVENT = 'junluoPhoneGuardChatMessage';
const DEV_RUNTIME_DIAGNOSTICS = __DEV__ && process.env.EXPO_PUBLIC_JUNLUO_RUNTIME_DIAGNOSTICS === '1';

const devNow = () => (typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now());
const devLogChatPerf = (label: string, fields: Record<string, unknown>) => {
  if (DEV_RUNTIME_DIAGNOSTICS) {
    console.log(`[perf][chat] ${label}`, fields);
  }
};

export type ChatSessionActivationReason = 'switch' | 'create' | 'delete' | 'sleep';

export type ReadonlyLatestRef<T> = {
  readonly current: T;
};

type UseChatSessionsControllerOptions = {
  active: boolean;
  compressionState: ChatContextCompressionState;
  externalMessageVersion: number;
  isSending: () => boolean;
  onConversationActivated: (reason: ChatSessionActivationReason) => void;
  onExternalMessagesApplied: () => void;
  onSessionContextLoaded: (session: ChatSession) => void;
  onStorageError?: (message: string) => void;
  organizedThroughId: string | null;
  proactiveReviewedThroughId: string | null;
  sending: boolean;
};

export type ChatSessionRollbackResult = {
  keptMessages: SubjectiveMessage[];
  removedMessages: SubjectiveMessage[];
  visibleKeptMessages: SubjectiveMessage[];
};

export function useChatSessionsController(options: UseChatSessionsControllerOptions) {
  const [messages, setMessages] = useState<SubjectiveMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [loadedMessageStartIndex, setLoadedMessageStartIndex] = useState(0);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [sessionMessagesLoadingId, setSessionMessagesLoadingId] = useState<string | null>(null);
  const [externalRefreshRetryVersion, setExternalRefreshRetryVersion] = useState(0);
  const [historyCompactionVersion, setHistoryCompactionVersion] = useState(0);

  const optionsRef = useRef(options);
  optionsRef.current = options;

  const mountedRef = useRef(true);
  const activeRef = useRef(options.active);
  const messagesRef = useRef<SubjectiveMessage[]>([]);
  const sessionsRef = useRef<ChatSession[]>([]);
  const activeSessionRef = useRef<string | null>(null);
  const messagesSessionIdRef = useRef<string | null>(null);
  const loadedMessageStartIndexRef = useRef(0);
  const sessionMessagesLoadingIdRef = useRef<string | null>(null);
  const historyLoadedRef = useRef(false);
  const historyPageLoadCountRef = useRef(0);
  const persistenceActivityCountRef = useRef(0);
  const historyCompactionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const historyCompactionPendingRef = useRef(false);
  const runPendingHistoryCompactionRef = useRef<() => void>(() => undefined);
  const skipAutoSaveMessagesRef = useRef<SubjectiveMessage[] | null>(null);
  const chatSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextStoredMessageMergeRef = useRef(false);
  const historyRevealCoolingRef = useRef(false);
  const externalRefreshInFlightRef = useRef(false);
  const externalRefreshPendingRef = useRef(false);
  const messageRevisionRef = useRef(0);
  const sessionRevisionRef = useRef(new Map<string, number>());
  const snapshotRevisionRef = useRef(new WeakMap<SubjectiveMessage[], { revision: number; sessionId: string }>());
  const persistenceCoordinatorRef = useRef(createChatPersistenceCoordinator());
  // Only this page's stale reads are invalidated; a later sync upsert releases its ID.
  const deletedMessageIdsRef = useRef(new Set<string>());
  const autoSaveSnapshotRef = useRef<{
    messages: SubjectiveMessage[];
    metadataSignature: string;
    sessionId: string;
  } | null>(null);
  const dataEpochRef = useRef(captureBackupRestoreDataEpoch());

  const canCommitChatData = useCallback(
    () => canCommitBackupRestoreDataEpoch(dataEpochRef.current),
    [],
  );
  const runChatDataWrite = useCallback(async (write: () => Promise<void>) => {
    const result = await runBackupRestoreDataEpochCommit(dataEpochRef.current, write);
    return result.committed;
  }, []);

  const recordSessionRevision = useCallback((sessionId: string, nextMessages: SubjectiveMessage[]) => {
    const revision = (sessionRevisionRef.current.get(sessionId) ?? 0) + 1;
    sessionRevisionRef.current.set(sessionId, revision);
    snapshotRevisionRef.current.set(nextMessages, { revision, sessionId });
    return revision;
  }, []);

  const filterDeletedMessages = useCallback((sessionId: string | null, nextMessages: SubjectiveMessage[]) => {
    if (sessionId !== PRIMARY_CHAT_SESSION_ID || !deletedMessageIdsRef.current.size) return nextMessages;
    const kept = nextMessages.filter(message => !deletedMessageIdsRef.current.has(message.id));
    return kept.length === nextMessages.length ? nextMessages : kept;
  }, []);

  const filterDeletedSessions = useCallback((nextSessions: ChatSession[]) => nextSessions.map(session => {
    const kept = filterDeletedMessages(session.id, session.messages);
    return kept === session.messages ? session : { ...session, messages: kept,
      messageCount: Math.max(kept.length, (session.messageCount ?? session.messages.length) - (session.messages.length - kept.length)) };
  }), [filterDeletedMessages]);

  const commitMessages = useCallback((nextMessages: SubjectiveMessage[]) => {
    if (!canCommitChatData()) return false;
    messageRevisionRef.current += 1;
    const sessionId = messagesSessionIdRef.current ?? activeSessionRef.current;
    nextMessages = filterDeletedMessages(sessionId, nextMessages);
    if (sessionId) recordSessionRevision(sessionId, nextMessages);
    messagesRef.current = nextMessages;
    if (mountedRef.current) setMessages(nextMessages);
    return true;
  }, [canCommitChatData, filterDeletedMessages, recordSessionRevision]);

  const commitSessions = useCallback((nextSessions: ChatSession[]) => {
    if (!canCommitChatData()) return;
    nextSessions = filterDeletedSessions(nextSessions);
    sessionsRef.current = nextSessions;
    if (mountedRef.current) setSessions(nextSessions);
  }, [canCommitChatData, filterDeletedSessions]);

  const updateLoadedMessageStartIndex = useCallback((nextIndex: number) => {
    loadedMessageStartIndexRef.current = nextIndex;
    if (mountedRef.current) setLoadedMessageStartIndex(nextIndex);
  }, []);

  const updateSessionMessagesLoadingId = useCallback((nextSessionId: string | null) => {
    sessionMessagesLoadingIdRef.current = nextSessionId;
    if (mountedRef.current) setSessionMessagesLoadingId(nextSessionId);
  }, []);

  const getSessionMessageCount = useCallback(
    (session: ChatSession) => session.messageCount ?? session.messages.length,
    [],
  );

  const markSessionPartiallyLoaded = useCallback((
    session: ChatSession,
    loadedMessages: SubjectiveMessage[],
    totalCount: number,
  ): ChatSession => ({
    ...session,
    messages: loadedMessages,
    messagesLoaded: loadedMessages.length >= totalCount,
    messageCount: Math.max(totalCount, loadedMessages.length),
  }), []);

  const isHistoryCompactionBusy = useCallback(() => (
    !historyLoadedRef.current
    || optionsRef.current.sending
    || optionsRef.current.isSending()
    || sessionMessagesLoadingIdRef.current !== null
    || historyPageLoadCountRef.current > 0
    || persistenceActivityCountRef.current > 0
    || chatSaveTimerRef.current !== null
  ), []);

  const compactHistoryResidency = useCallback(() => {
    if (optionsRef.current.active) {
      historyCompactionPendingRef.current = false;
      return false;
    }
    const currentSessionId = activeSessionRef.current;
    if (!currentSessionId || isHistoryCompactionBusy()) {
      historyCompactionPendingRef.current = true;
      return false;
    }
    const compacted = compactHiddenChatResidency(
      sessionsRef.current,
      currentSessionId,
      messagesRef.current,
    );
    historyCompactionPendingRef.current = false;
    skipAutoSaveMessagesRef.current = compacted.messages;
    updateLoadedMessageStartIndex(compacted.loadedMessageStartIndex);
    commitSessions(compacted.sessions);
    commitMessages(compacted.messages);
    if (mountedRef.current) setHistoryCompactionVersion((current) => current + 1);
    if (hasHistoryDiagnosticLoadedPage()) {
      scheduleHistoryResidencySnapshot('compacted', compacted.messages.length, {
        clearLoadedPageIds: true,
      });
    }
    return true;
  }, [commitMessages, commitSessions, isHistoryCompactionBusy, updateLoadedMessageStartIndex]);

  const flushPendingHistoryCompaction = useCallback(() => {
    if (!historyCompactionPendingRef.current) return;
    if (optionsRef.current.active) {
      historyCompactionPendingRef.current = false;
      return;
    }
    compactHistoryResidency();
  }, [compactHistoryResidency]);
  runPendingHistoryCompactionRef.current = flushPendingHistoryCompaction;

  const loadSessionIfNeeded = useCallback(async (session: ChatSession) => {
    if (session.messagesLoaded !== false) {
      return {
        session,
        startIndex: Math.max(0, getSessionMessageCount(session) - session.messages.length),
      };
    }
    historyPageLoadCountRef.current += 1;
    try {
      const page = await loadChatSessionMessagePage(session.id, {
        limit: CHAT_MESSAGE_PAGE_SIZE,
        waitForPendingWrites: false,
      });
      const latestSession = sessionsRef.current.find((entry) => entry.id === session.id) ?? session;
      const loadedSession = markSessionPartiallyLoaded(latestSession, page.messages, page.totalCount);
      commitSessions(compactInactiveChatSessions(
        sessionsRef.current.map((entry) => entry.id === loadedSession.id ? loadedSession : entry),
        loadedSession.id,
      ));
      return { session: loadedSession, startIndex: page.startIndex };
    } finally {
      historyPageLoadCountRef.current = Math.max(0, historyPageLoadCountRef.current - 1);
      runPendingHistoryCompactionRef.current();
    }
  }, [commitSessions, getSessionMessageCount, markSessionPartiallyLoaded]);

  const activateSession = useCallback(async (
    session: ChatSession,
    reason: ChatSessionActivationReason = 'switch',
  ) => {
    if (session.id !== PRIMARY_CHAT_SESSION_ID) throw new Error('旧聊天不能成为主聊天。');
    const compactedSessions = compactInactiveChatSessions(
      sessionsRef.current.map((entry) => entry.id === session.id ? session : entry),
      session.id,
    );
    commitSessions(compactedSessions);
    const residentSession = compactedSessions.find((entry) => entry.id === session.id) ?? session;
    const needsLoad = residentSession.messagesLoaded === false;
    const sessionLoad = needsLoad ? loadSessionIfNeeded(residentSession) : null;
    activeSessionRef.current = session.id;
    messagesSessionIdRef.current = session.id;
    const activeSessionSaved = runChatDataWrite(
      () => saveActiveChatSessionId(session.id),
    ).catch(() => undefined);
    void activeSessionSaved;
    if (mountedRef.current) setActiveSessionId(session.id);
    updateSessionMessagesLoadingId(needsLoad ? session.id : null);
    updateLoadedMessageStartIndex(needsLoad ? 0 : Math.max(0, getSessionMessageCount(residentSession) - residentSession.messages.length));
    commitMessages(needsLoad ? [] : residentSession.messages);
    const activationRevision = messageRevisionRef.current;
    optionsRef.current.onSessionContextLoaded(residentSession);
    optionsRef.current.onConversationActivated(reason);
    if (!sessionLoad) return residentSession;
    const loadedPage = await sessionLoad;
    const loadedSession = loadedPage.session;
    if (activeSessionRef.current !== loadedSession.id) return loadedSession;
    const activatedMessages = mergeChatSnapshotMessages(
      loadedSession.messages,
      messagesRef.current,
      messageRevisionRef.current !== activationRevision,
    );
    updateSessionMessagesLoadingId(null);
    updateLoadedMessageStartIndex(loadedPage.startIndex);
    commitMessages(activatedMessages);
    optionsRef.current.onSessionContextLoaded(loadedSession);
    runPendingHistoryCompactionRef.current();
    return loadedSession;
  }, [commitMessages, getSessionMessageCount, loadSessionIfNeeded, runChatDataWrite, updateLoadedMessageStartIndex, updateSessionMessagesLoadingId]);

  const activateStoredSessionById = useCallback(async (
    sessionId: string,
    reason: ChatSessionActivationReason = 'sleep',
  ) => {
    if (sessionId !== PRIMARY_CHAT_SESSION_ID) return null;
    const stored = await loadChatSessionSnapshot(sessionId, { messageLimit: CHAT_MESSAGE_PAGE_SIZE });
    const targetSession = stored?.session;
    if (!stored || !targetSession) return null;
    commitSessions(compactInactiveChatSessions(stored.sessions, targetSession.id));
    if (activeSessionRef.current !== targetSession.id) {
      await activateSession(targetSession, reason);
    }
    return targetSession;
  }, [activateSession, commitSessions]);

  const revealOlderMessages = useCallback(() => {
    const currentSessionId = activeSessionRef.current;
    const currentStartIndex = loadedMessageStartIndexRef.current;
    if (
      historyRevealCoolingRef.current
      || !currentSessionId
      || currentStartIndex <= 0
      || !canLoadHistoryDiagnosticOlderPage()
    ) return;
    historyRevealCoolingRef.current = true;
    historyPageLoadCountRef.current += 1;
    void loadChatSessionMessagePage(currentSessionId, {
      beforeIndex: currentStartIndex,
      limit: CHAT_MESSAGE_PAGE_SIZE,
      waitForPendingWrites: false,
    }).then((page) => {
      if (activeSessionRef.current !== currentSessionId) return;
      const existingIds = new Set(messagesRef.current.map((message) => message.id));
      const newlyLoadedMessages = page.messages.filter((message) => !existingIds.has(message.id));
      const nextMessages = [
        ...newlyLoadedMessages,
        ...messagesRef.current,
      ];
      noteHistoryDiagnosticPageLoaded(newlyLoadedMessages);
      updateLoadedMessageStartIndex(page.startIndex);
      commitMessages(nextMessages);
      devLogChatPerf('history-page-load', {
        loaded: page.messages.length,
        loadedMessages: nextMessages.length,
        remainingBefore: page.startIndex,
        totalMessages: page.totalCount,
      });
    }).finally(() => {
      historyPageLoadCountRef.current = Math.max(0, historyPageLoadCountRef.current - 1);
      runPendingHistoryCompactionRef.current();
      setTimeout(() => {
        historyRevealCoolingRef.current = false;
      }, 180);
    });
  }, [commitMessages, updateLoadedMessageStartIndex]);

  const commitSessionMessages = useCallback((sessionId: string, nextMessages: SubjectiveMessage[]) => {
    const isActiveSession = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId;
    if (isActiveSession) {
      commitMessages(nextMessages);
      return;
    }
    recordSessionRevision(sessionId, nextMessages);
    commitSessions(sessionsRef.current.map((session) =>
      session.id === sessionId
        ? updateChatSession(
            session,
            nextMessages,
            session.memoryOrganizedThroughId,
            session.proactiveMemoryReviewedThroughId,
          )
        : session,
    ));
  }, [commitMessages, commitSessions, recordSessionRevision]);

  const updateMessageDeliveryStatus = useCallback((
    messageId: string,
    deliveryStatus?: SubjectiveMessage['deliveryStatus'],
    deliveryError?: string,
    sessionId = activeSessionRef.current,
  ) => {
    if (!sessionId) return;
    const isActiveSession = activeSessionRef.current === sessionId && messagesSessionIdRef.current === sessionId;
    const sourceMessages = isActiveSession
      ? messagesRef.current
      : sessionsRef.current.find((session) => session.id === sessionId)?.messages ?? [];
    const nextMessages = sourceMessages.map((message) =>
      message.id === messageId
        ? { ...message, deliveryError, deliveryStatus }
        : message,
    );
    commitSessionMessages(sessionId, nextMessages);
  }, [commitSessionMessages]);

  const persistSessionMessages = useCallback(async (
    sessionId: string | null,
    nextMessages: SubjectiveMessage[],
    ownedReplyMessageIds?: readonly string[],
    chatImageSources?: import('./chatImageRecord').ChatImageCardSources,
  ): Promise<ChatPersistResult> => {
    if (!sessionId) return 'failed';
    const currentMessages = filterDeletedMessages(sessionId, nextMessages);
    const savableMessages = filterPendingChatReplyMessages(sessionId, currentMessages, ownedReplyMessageIds);
    const snapshot = retainChatMessageWriteSnapshot(sessionId, savableMessages);
    const snapshotRevision = snapshotRevisionRef.current.get(nextMessages);
    const revision = snapshotRevision?.sessionId === sessionId
      ? snapshotRevision.revision
      : recordSessionRevision(sessionId, nextMessages);
    const pending = persistenceCoordinatorRef.current.persist({
      revision,
      sessionId,
      partial: savableMessages !== currentMessages,
      write: async () => {
        const committed = await runChatDataWrite(async () => {
          const saved = await mergeAndSaveChatSessionMessages(sessionId, snapshot.messages, {
            chatImageSources,
            activeSessionId: activeSessionRef.current,
            contextCompression: activeSessionRef.current === sessionId
              ? optionsRef.current.compressionState
              : undefined,
          });
          if (!saved) throw new Error('chat_session_missing_before_persist');
        });
        if (!committed) throw new Error('chat_persist_blocked_by_data_epoch');
      },
    });
    persistenceActivityCountRef.current += 1;
    void pending.finally(() => {
      snapshot.release();
      persistenceActivityCountRef.current = Math.max(0, persistenceActivityCountRef.current - 1);
      runPendingHistoryCompactionRef.current();
    });
    return pending;
  }, [filterDeletedMessages, recordSessionRevision, runChatDataWrite]);

  const patchSession = useCallback((sessionId: string, patch: Partial<ChatSession>) => {
    const nextSessions = sessionsRef.current.map((session) =>
      session.id === sessionId ? { ...session, ...patch } : session,
    );
    commitSessions(nextSessions);
  }, [commitSessions]);

  const rollbackActiveSessionToMessage = useCallback(async (
    messageId: string,
  ): Promise<ChatSessionRollbackResult | null> => {
    const targetSessionId = activeSessionRef.current;
    if (!targetSessionId) return null;
    const storedMessages = loadedMessageStartIndexRef.current > 0 || !messagesRef.current.some(message => message.id === messageId)
      ? await loadChatSessionMessages(targetSessionId)
      : null;
    if (!mountedRef.current || !canCommitChatData()) return null;
    const currentMessages = storedMessages ?? messagesRef.current;
    const rollbackIndex = currentMessages.findIndex((message) => message.id === messageId);
    if (rollbackIndex < 0) return null;
    const removedMessages = currentMessages.slice(rollbackIndex);
    const keptMessages = currentMessages.slice(0, rollbackIndex);
    const visibleKeptMessages = keptMessages.slice(-CHAT_MESSAGE_PAGE_SIZE);

    if (chatSaveTimerRef.current) {
      clearTimeout(chatSaveTimerRef.current);
      chatSaveTimerRef.current = null;
    }
    skipNextStoredMessageMergeRef.current = true;
    updateLoadedMessageStartIndex(Math.max(0, keptMessages.length - visibleKeptMessages.length));
    commitMessages(visibleKeptMessages);
    const nextSessions = sessionsRef.current.map((session) =>
      session.id === targetSessionId
        ? {
            ...updateChatSession(session, keptMessages, null, null),
            contextCompression: emptyChatContextCompressionState,
          }
        : session,
    );
    commitSessions(nextSessions);
    const rolledBackSession = nextSessions.find((session) => session.id === targetSessionId);
    if (rolledBackSession) optionsRef.current.onSessionContextLoaded(rolledBackSession);
    const snapshot = retainChatSessionWriteSnapshots(filterDeletedSessions(nextSessions));
    await runChatDataWrite(async () => {
      await clearMemoryIngestionForSession(targetSessionId, { fromAt: Math.min(...removedMessages.map((item) => item.createdAt)) });
      return saveChatState(snapshot.sessions, targetSessionId, { preserveActiveSessionId: true, discardPendingReply: true });
    }).finally(() => snapshot.release());
    await removeHeartCorpusEntriesForMessageIds(
      removedMessages.map((message) => message.id),
    ).catch(() => undefined);
    return { keptMessages, removedMessages, visibleKeptMessages };
  }, [canCommitChatData, commitMessages, commitSessions, filterDeletedSessions, runChatDataWrite, updateLoadedMessageStartIndex]);

  const deleteActiveVoiceCallRecordMessage = useCallback(async (messageId: string) => {
    const targetSessionId = activeSessionRef.current;
    if (!targetSessionId) return false;
    try {
      const storedMessages = loadedMessageStartIndexRef.current > 0 || !messagesRef.current.some(message => message.id === messageId)
        ? await loadChatSessionMessages(targetSessionId)
        : null;
      if (!mountedRef.current || activeSessionRef.current !== targetSessionId || !canCommitChatData()) return false;
      const currentMessages = storedMessages ?? messagesRef.current;
      const targetMessage = currentMessages.find((message) => message.id === messageId);
      if (!targetMessage?.voiceCallRecord) return false;
      await markVoiceCallRecordDeleted(targetMessage.voiceCallRecord.callId);
      if (!mountedRef.current || activeSessionRef.current !== targetSessionId || !canCommitChatData()) return false;
      return await runChatDataWrite(async () => {
        await clearMemoryIngestionForSession(targetSessionId, { messageId });
        const saved = await replaceChatSessionMessages(targetSessionId,
          current => current.filter(message => message.id !== messageId),
          { deletedMessageIds: [messageId] });
        if (!saved) throw new Error('VOICE_CALL_RECORD_DELETE_FAILED');
      });
    } catch {
      if (mountedRef.current && activeSessionRef.current === targetSessionId && canCommitChatData()) {
        optionsRef.current.onStorageError?.('通话记录删除失败，请重试。');
      }
      return false;
    }
  }, [canCommitChatData, runChatDataWrite]);

  const syncExternalChatMessagesFromStorage = useCallback((sessionId: string, logLabel: string) => {
    setTimeout(() => {
      void (async () => {
        if (!mountedRef.current || sessionId !== activeSessionRef.current) return;
        try {
          const readRevision = messageRevisionRef.current;
          const page = await loadChatSessionMessagePage(sessionId, {
            limit: CHAT_MESSAGE_PAGE_SIZE,
            waitForPendingWrites: false,
          });
          if (!mountedRef.current || !optionsRef.current.active || sessionId !== activeSessionRef.current || !page.messages.length) return;
          const nextMessages = mergeChatSnapshotMessages(
            page.messages,
            messagesRef.current,
            messageRevisionRef.current !== readRevision,
          );
          const currentIds = messagesRef.current.map((message) => message.id).join('\n');
          const nextIds = nextMessages.map((message) => message.id).join('\n');
          if (currentIds === nextIds) return;
          if (DEV_RUNTIME_DIAGNOSTICS) {
            console.log(`${logLabel}: storage sync`, {
              beforeCount: messagesRef.current.length,
              afterCount: nextMessages.length,
              sessionId,
            });
          }
          const nextLoadedMessageStartIndex = messagesRef.current.length
            ? Math.min(loadedMessageStartIndexRef.current, page.startIndex)
            : page.startIndex;
          updateSessionMessagesLoadingId(null);
          updateLoadedMessageStartIndex(nextLoadedMessageStartIndex);
          commitMessages(nextMessages);
          commitSessions(sessionsRef.current.map((session) => {
            if (session.id !== sessionId) return session;
            if (nextLoadedMessageStartIndex > 0 || nextMessages.length < page.totalCount) {
              return {
                ...session,
                messages: nextMessages,
                messagesLoaded: false,
                messageCount: Math.max(page.totalCount, nextLoadedMessageStartIndex + nextMessages.length),
                updatedAt: nextMessages[nextMessages.length - 1]?.createdAt ?? session.updatedAt,
              };
            }
            return updateChatSession(
              session,
              nextMessages,
              session.memoryOrganizedThroughId,
              session.proactiveMemoryReviewedThroughId,
            );
          }));
          optionsRef.current.onExternalMessagesApplied();
        } catch (error) {
          console.warn(`${logLabel}: storage sync failed`, error);
        }
      })();
    }, 90);
  }, [commitMessages, commitSessions, updateLoadedMessageStartIndex, updateSessionMessagesLoadingId]);

  const applyExternalChatMessages = useCallback((
    sessionId: string | undefined,
    incomingMessages: SubjectiveMessage[],
    logLabel: string,
  ) => {
    if (!sessionId || !incomingMessages.length || sessionId !== activeSessionRef.current) return;
    if (!optionsRef.current.active) {
      externalRefreshPendingRef.current = true;
      return;
    }
    if (DEV_RUNTIME_DIAGNOSTICS) {
      console.log(logLabel, {
        messageCount: incomingMessages.length,
        newestAgeMs: Date.now() - incomingMessages[incomingMessages.length - 1].createdAt,
        newestMessageId: incomingMessages[incomingMessages.length - 1].id,
        sessionId,
      });
    }
    const nextMessages = mergeSubjectiveMessages([...messagesRef.current, ...incomingMessages], messagesRef.current);
    if (sessionMessagesLoadingIdRef.current === sessionId) {
      updateSessionMessagesLoadingId(null);
    }
    commitMessages(nextMessages);
    commitSessions(sessionsRef.current.map((session) => {
      if (session.id !== sessionId) return session;
      if (loadedMessageStartIndexRef.current > 0 || session.messagesLoaded === false) {
        return {
          ...session,
          messages: nextMessages,
          messagesLoaded: false,
          messageCount: Math.max(
            getSessionMessageCount(session),
            loadedMessageStartIndexRef.current + nextMessages.length,
          ),
          memoryOrganizedThroughId: session.memoryOrganizedThroughId,
          proactiveMemoryReviewedThroughId: session.proactiveMemoryReviewedThroughId,
          updatedAt: nextMessages[nextMessages.length - 1]?.createdAt ?? session.updatedAt,
        };
      }
      return updateChatSession(
        session,
        nextMessages,
        session.memoryOrganizedThroughId,
        session.proactiveMemoryReviewedThroughId,
      );
    }));
    syncExternalChatMessagesFromStorage(sessionId, logLabel);
    optionsRef.current.onExternalMessagesApplied();
  }, [commitMessages, commitSessions, getSessionMessageCount, syncExternalChatMessagesFromStorage, updateSessionMessagesLoadingId]);

  useEffect(() => {
    const unsubscribe = subscribeChatDataChanges((change, deletion) => {
      if (change === 'restore') { deletedMessageIdsRef.current.clear(); return; }
      if (!deletion || deletion.sessionId !== PRIMARY_CHAT_SESSION_ID || !canCommitChatData()) return;
      deletion.deletedMessageIds.forEach(id => deletedMessageIdsRef.current.add(id));
      if (chatSaveTimerRef.current) {
        clearTimeout(chatSaveTimerRef.current);
        chatSaveTimerRef.current = null;
      }
      if (messagesSessionIdRef.current === deletion.sessionId) {
        const kept = filterDeletedMessages(deletion.sessionId, messagesRef.current);
        updateLoadedMessageStartIndex(Math.min(loadedMessageStartIndexRef.current, Math.max(0, deletion.messageCount - kept.length)));
        if (kept !== messagesRef.current) commitMessages(kept);
      }
      commitSessions(sessionsRef.current.map(session => session.id === deletion.sessionId
        ? { ...session, messages: filterDeletedMessages(session.id, session.messages), messageCount: Math.max(deletion.messageCount,
          filterDeletedMessages(session.id, session.messages).length) } : session));
    });
    return () => { unsubscribe(); deletedMessageIdsRef.current.clear(); };
  }, [canCommitChatData, commitMessages, commitSessions, filterDeletedMessages, updateLoadedMessageStartIndex]);

  useEffect(() => {
    const phoneGuardSubscription = DeviceEventEmitter.addListener(PHONE_GUARD_CHAT_MESSAGE_EVENT, (value) => {
      const event = value as { message?: SubjectiveMessage; sessionId?: string };
      applyExternalChatMessages(
        event.sessionId,
        event.message ? [event.message] : [],
        '[phone-guard] 聊天页即时事件收到',
      );
    });
    const appendedSubscription = DeviceEventEmitter.addListener(CHAT_MESSAGES_APPENDED_EVENT, (value) => {
      const event = value as ChatMessagesAppendedEvent;
      if (event.sessionId === PRIMARY_CHAT_SESSION_ID && event.source === 'sync-chat-core') {
        event.messages?.forEach(message => deletedMessageIdsRef.current.delete(message.id));
      }
      applyExternalChatMessages(
        event.sessionId,
        Array.isArray(event.messages) ? event.messages : [],
        '[chat-sync] 外部消息写入事件收到',
      );
    });
    return () => {
      phoneGuardSubscription.remove();
      appendedSubscription.remove();
    };
  }, [applyExternalChatMessages]);

  useEffect(() => {
    mountedRef.current = true;
    let current = true;
    const initialLoadStartedAt = devNow();
    void loadChatStateFast({ activeMessageLimit: CHAT_MESSAGE_PAGE_SIZE }).then((stored) => {
      const loadedAt = devNow();
      if (!current) return;
      const currentSession = stored.sessions.find((session) => session.id === stored.activeSessionId);
      if (!currentSession) return;
      if (activeSessionRef.current && activeSessionRef.current !== stored.activeSessionId) {
        const localSessions = sessionsRef.current;
        const localSessionIds = new Set(localSessions.map((session) => session.id));
        commitSessions([
          ...localSessions,
          ...stored.sessions.filter((session) => !localSessionIds.has(session.id)),
        ]);
        historyLoadedRef.current = true;
        setHistoryLoaded(true);
        runPendingHistoryCompactionRef.current();
        return;
      }
      const currentMessageCount = getSessionMessageCount(currentSession);
      commitSessions(stored.sessions);
      activeSessionRef.current = stored.activeSessionId;
      messagesSessionIdRef.current = stored.activeSessionId;
      setActiveSessionId(stored.activeSessionId);
      updateLoadedMessageStartIndex(Math.max(0, currentMessageCount - currentSession.messages.length));
      commitMessages(currentSession.messages);
      optionsRef.current.onSessionContextLoaded(currentSession);
      historyLoadedRef.current = true;
      setHistoryLoaded(true);
      runPendingHistoryCompactionRef.current();
      requestAnimationFrame(() => {
        devLogChatPerf('initial-load', {
          loadMs: Math.round(loadedAt - initialLoadStartedAt),
          readyFrameMs: Math.round(devNow() - initialLoadStartedAt),
          sessions: stored.sessions.length,
          activeMessages: currentSession.messages.length,
          activeMessageCount: currentMessageCount,
        });
      });
    }).catch((error: unknown) => {
      if (!current) return;
      optionsRef.current.onStorageError?.(error instanceof Error ? error.message : '聊天记录读取失败，未创建新聊天。');
    });
    return () => {
      current = false;
      mountedRef.current = false;
      if (chatSaveTimerRef.current) clearTimeout(chatSaveTimerRef.current);
      if (historyCompactionTimerRef.current) clearTimeout(historyCompactionTimerRef.current);
    };
  }, [commitMessages, commitSessions, getSessionMessageCount, updateLoadedMessageStartIndex]);

  useEffect(() => {
    activeRef.current = options.active;
    if (options.active) historyCompactionPendingRef.current = false;
    if (!options.active && hasHistoryDiagnosticLoadedPage()) {
      scheduleHistoryResidencySnapshot('chatHidden', messagesRef.current.length);
    }
  }, [options.active]);

  useEffect(() => {
    if (options.active || !historyLoaded) return undefined;
    const timer = setTimeout(() => {
      if (historyCompactionTimerRef.current === timer) historyCompactionTimerRef.current = null;
      if (optionsRef.current.active) return;
      historyCompactionPendingRef.current = true;
      runPendingHistoryCompactionRef.current();
    }, CHAT_RESIDENCY_GRACE_PERIOD_MS);
    historyCompactionTimerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (historyCompactionTimerRef.current === timer) historyCompactionTimerRef.current = null;
    };
  }, [historyLoaded, options.active]);

  useEffect(() => {
    if (!options.sending && sessionMessagesLoadingId === null && historyLoaded) {
      runPendingHistoryCompactionRef.current();
    }
  }, [historyLoaded, options.sending, sessionMessagesLoadingId]);

  useEffect(() => {
    if (!options.active || !historyLoaded || options.sending || optionsRef.current.isSending()) return;
    if (externalRefreshInFlightRef.current) {
      externalRefreshPendingRef.current = true;
      return;
    }
    externalRefreshPendingRef.current = false;
    externalRefreshInFlightRef.current = true;
    const refreshStartedAt = devNow();
    const refreshSessionId = activeSessionRef.current;
    const refreshRevision = messageRevisionRef.current;
    void loadChatStateFast({ activeMessageLimit: CHAT_MESSAGE_PAGE_SIZE }).then((stored) => {
      const loadedAt = devNow();
      if (!optionsRef.current.active || optionsRef.current.isSending()) {
        externalRefreshPendingRef.current = true;
        return;
      }
      const foregroundSessionId = activeSessionRef.current;
      const foregroundSession = foregroundSessionId
        ? sessionsRef.current.find((session) => session.id === foregroundSessionId)
        : null;
      const shouldAdoptStoredActive =
        !foregroundSessionId
        || stored.activeSessionId === foregroundSessionId
        || !foregroundSession;
      if (!shouldAdoptStoredActive) {
        const localOnlySessions = sessionsRef.current.filter((session) =>
          !stored.sessions.some((storedSession) => storedSession.id === session.id),
        );
        commitSessions(compactInactiveChatSessions([
          ...localOnlySessions,
          ...stored.sessions.map((session) => {
            const existing = sessionsRef.current.find((entry) => entry.id === session.id);
            if (session.messagesLoaded === false && existing && existing.messagesLoaded !== false) {
              return {
                ...session,
                messages: existing.messages,
                messagesLoaded: existing.messagesLoaded,
                messageCount: getSessionMessageCount(existing),
              };
            }
            return session;
          }),
        ], foregroundSessionId));
        devLogChatPerf('external-refresh-preserve-foreground', {
          foregroundSessionId,
          storedActiveSessionId: stored.activeSessionId,
          sessions: stored.sessions.length,
        });
        return;
      }
      const currentSession = stored.sessions.find((session) =>
        session.id === (shouldAdoptStoredActive ? stored.activeSessionId : foregroundSessionId),
      );
      if (!currentSession) return;
      const sameSession = currentSession.id === foregroundSessionId;
      const localMessagesBelongToCurrentSession = messagesSessionIdRef.current === currentSession.id;
      const nextMessages = sameSession && localMessagesBelongToCurrentSession
        ? mergeChatSnapshotMessages(
            currentSession.messages,
            messagesRef.current,
            refreshSessionId !== currentSession.id || messageRevisionRef.current !== refreshRevision,
          )
        : currentSession.messages;
      const nextLoadedMessageStartIndex = currentSession.messagesLoaded === false
        ? sameSession && localMessagesBelongToCurrentSession && messagesRef.current.length > 0
          ? loadedMessageStartIndexRef.current
          : Math.max(0, getSessionMessageCount(currentSession) - currentSession.messages.length)
        : 0;
      const currentMessages = messagesRef.current;
      const unchangedActiveMessages =
        sameSession
        && nextMessages.length === currentMessages.length
        && nextMessages.every((message, index) => {
          const currentMessage = currentMessages[index];
          return (
            currentMessage
            && message.id === currentMessage.id
            && message.content === currentMessage.content
            && message.source === currentMessage.source
          );
        });
      if (unchangedActiveMessages) {
        devLogChatPerf('external-refresh-skip', {
          loadMs: Math.round(loadedAt - refreshStartedAt),
          totalMs: Math.round(devNow() - refreshStartedAt),
          sessions: stored.sessions.length,
          activeMessages: nextMessages.length,
        });
        return;
      }
      const localOnlySessions = sessionsRef.current.filter((session) =>
        !stored.sessions.some((storedSession) => storedSession.id === session.id),
      );
      const nextStoredSessions = [
        ...localOnlySessions,
        ...stored.sessions.map((session) => {
          if (session.id === currentSession.id) {
            if (session.messagesLoaded === false) {
              return {
                ...session,
                messages: nextMessages,
                messagesLoaded: false,
                messageCount: Math.max(getSessionMessageCount(session), nextLoadedMessageStartIndex + nextMessages.length),
                updatedAt: nextMessages[nextMessages.length - 1]?.createdAt ?? session.updatedAt,
              };
            }
            return updateChatSession(
              session,
              nextMessages,
              session.memoryOrganizedThroughId,
              session.proactiveMemoryReviewedThroughId,
            );
          }
          const existing = sessionsRef.current.find((entry) => entry.id === session.id);
          if (session.messagesLoaded === false && existing && existing.messagesLoaded !== false) {
            return {
              ...session,
              messages: existing.messages,
              messagesLoaded: true,
              messageCount: existing.messages.length,
            };
          }
          return session;
        }),
      ];
      commitSessions(compactInactiveChatSessions(nextStoredSessions, currentSession.id));
      if (!shouldAdoptStoredActive && !sameSession) return;
      activeSessionRef.current = currentSession.id;
      messagesSessionIdRef.current = currentSession.id;
      setActiveSessionId(currentSession.id);
      updateLoadedMessageStartIndex(nextLoadedMessageStartIndex);
      commitMessages(nextMessages);
      optionsRef.current.onExternalMessagesApplied();
      optionsRef.current.onSessionContextLoaded(currentSession);
      devLogChatPerf('external-refresh', {
        loadMs: Math.round(loadedAt - refreshStartedAt),
        totalMs: Math.round(devNow() - refreshStartedAt),
        sessions: stored.sessions.length,
        activeMessages: nextMessages.length,
      });
    }).catch((error: unknown) => {
      if (mountedRef.current) {
        optionsRef.current.onStorageError?.(error instanceof Error ? error.message : '聊天记录读取失败，未替换当前聊天。');
      }
    }).finally(() => {
      externalRefreshInFlightRef.current = false;
      if (externalRefreshPendingRef.current && mountedRef.current && activeRef.current) {
        externalRefreshPendingRef.current = false;
        setExternalRefreshRetryVersion((current) => current + 1);
      }
    });
  }, [externalRefreshRetryVersion, historyLoaded, options.active, options.sending, options.externalMessageVersion, commitMessages, commitSessions, getSessionMessageCount, updateLoadedMessageStartIndex]);

  useEffect(() => {
    if (!historyLoaded || !activeSessionId || sessionMessagesLoadingId === activeSessionId || !canCommitChatData()) return;
    if (messagesSessionIdRef.current !== activeSessionId) return;
    if (filterDeletedMessages(activeSessionId, messages) !== messages) return;
    if (skipAutoSaveMessagesRef.current === messages) {
      skipAutoSaveMessagesRef.current = null;
      return;
    }
    const metadataSignature = JSON.stringify([
      options.compressionState,
      options.organizedThroughId,
      options.proactiveReviewedThroughId,
    ]);
    const previousAutoSave = autoSaveSnapshotRef.current;
    if (
      previousAutoSave?.sessionId === activeSessionId
      && previousAutoSave.messages === messages
      && previousAutoSave.metadataSignature !== metadataSignature
    ) recordSessionRevision(activeSessionId, messages);
    autoSaveSnapshotRef.current = { messages, metadataSignature, sessionId: activeSessionId };
    setSessions((current) => {
      const next = current.map((session) =>
        session.id === activeSessionId
          ? loadedMessageStartIndex > 0
            ? {
                ...session,
                messages,
                messagesLoaded: false,
                messageCount: Math.max(getSessionMessageCount(session), loadedMessageStartIndex + messages.length),
                memoryOrganizedThroughId: options.organizedThroughId,
                proactiveMemoryReviewedThroughId: options.proactiveReviewedThroughId,
                contextCompression: options.compressionState,
                updatedAt: messages[messages.length - 1]?.createdAt ?? session.updatedAt,
              }
            : {
                ...updateChatSession(
                  session,
                  messages,
                  options.organizedThroughId,
                  options.proactiveReviewedThroughId,
                ),
                contextCompression: options.compressionState,
              }
          : session,
      );
      sessionsRef.current = next;
      if (chatSaveTimerRef.current) {
        clearTimeout(chatSaveTimerRef.current);
        chatSaveTimerRef.current = null;
      }
      if (filterPendingChatReplyMessages(activeSessionId, messages) !== messages) return next;
      const shouldReplaceStoredMessages = skipNextStoredMessageMergeRef.current
        && !next.some((session) => filterPendingChatReplyMessages(session.id, session.messages) !== session.messages);
      skipNextStoredMessageMergeRef.current = false;
      const saveTimer = setTimeout(() => {
        const activeSession = next.find((session) => session.id === activeSessionId);
        const snapshot = shouldReplaceStoredMessages ? retainChatSessionWriteSnapshots(filterDeletedSessions(next)) : null;
        const save = shouldReplaceStoredMessages
          ? runChatDataWrite(() => saveChatState(snapshot!.sessions, activeSessionId, { preserveActiveSessionId: true }))
          : activeSession
            ? persistSessionMessages(activeSessionId, activeSession.messages)
            : Promise.resolve('failed' as ChatPersistResult);
        void save.finally(() => {
          snapshot?.release();
          if (chatSaveTimerRef.current === saveTimer) {
            chatSaveTimerRef.current = null;
            runPendingHistoryCompactionRef.current();
          }
        });
      }, 500);
      chatSaveTimerRef.current = saveTimer;
      return next;
    });
  }, [activeSessionId, historyLoaded, loadedMessageStartIndex, messages, options.compressionState, options.organizedThroughId, options.proactiveReviewedThroughId, sessionMessagesLoadingId, canCommitChatData, filterDeletedMessages, filterDeletedSessions, getSessionMessageCount, persistSessionMessages, recordSessionRevision, runChatDataWrite]);

  const sessionMessagesLoading = !!activeSessionId && sessionMessagesLoadingId === activeSessionId;
  const hiddenHistoryCount = Math.max(0, loadedMessageStartIndex);

  updateChatRuntimeResidencySnapshot(sessions);

  return {
    activeSessionId,
    activeSessionRef: activeSessionRef as ReadonlyLatestRef<string | null>,
    activateSession,
    activateStoredSessionById,
    commitMessages,
    commitSessionMessages,
    deleteActiveVoiceCallRecordMessage,
    getSessionMessageCount,
    hiddenHistoryCount,
    historyCompactionVersion,
    historyLoaded,
    loadedMessageStartIndex,
    messages,
    messagesRef: messagesRef as ReadonlyLatestRef<SubjectiveMessage[]>,
    messagesSessionIdRef: messagesSessionIdRef as ReadonlyLatestRef<string | null>,
    patchSession,
    persistSessionMessages,
    revealOlderMessages,
    rollbackActiveSessionToMessage,
    sessionMessagesLoading,
    sessions,
    sessionsRef: sessionsRef as ReadonlyLatestRef<ChatSession[]>,
    updateMessageDeliveryStatus,
  };
}
