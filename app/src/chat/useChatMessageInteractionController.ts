import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { Alert, Keyboard } from 'react-native';

import type { AiConnection } from '../ai/types';
import {
  type FallbackDiagnostics,
  type GenerationDiagnostics,
  type SubjectiveMessage,
} from '../ai/subjectiveMessages';
import { inferAnchorKindFromDomain } from '../memory/memoryAnchorContext';
import type { MemoryCandidateReview } from '../memory/memoryCandidateReview';
import {
  MEMORY_ORGANIZER_CONFIG_MESSAGE,
  MEMORY_ORGANIZER_CONFIG_TITLE,
} from '../memory/memoryOrganizerConfigNotice';
import { getMemoryOrganizationFailureNotice } from '../memory/memoryOrganizationFailure';
import { deriveMemoryTitle } from '../memory/memoryStore';
import type { useChatMemoryController } from '../memory/useChatMemoryController';
import { memoryDraftToToolInput } from '../tools';
import { findHeartReplyRound } from './heartCorpus';
import { loadActiveHeartRoundIds, toggleHeartReplyRound } from './heartCorpusStore';
import {
  formatFallbackDiagnostics,
  formatGenerationDiagnostics,
} from './chatReplyText';
import type { useChatSessionsController } from './useChatSessionsController';
import type { useChatToolBridge } from './useChatToolBridge';
import { loadChatSessionMessages } from './chatStorage';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';

type ChatMemoryController = ReturnType<typeof useChatMemoryController>;
type ChatSessionsController = ReturnType<typeof useChatSessionsController>;
type ChatToolBridge = ReturnType<typeof useChatToolBridge>;

type UseChatMessageInteractionControllerOptions = {
  memory: {
    controller: ChatMemoryController;
    organizerConnection: AiConnection | null | undefined;
    organizerKey: string;
    organizedThroughId: string | null;
  };
  messages: {
    activeSessionId: string | null;
    commitMessages: ChatSessionsController['commitMessages'];
    messages: SubjectiveMessage[];
    messagesRef: ChatSessionsController['messagesRef'];
    presentedMessages?: SubjectiveMessage[];
    saveMessageContent?: (message: SubjectiveMessage, content: string) => Promise<boolean>;
  };
  page: {
    active: boolean;
    onError: (message: string | null) => void;
    onOpenAiSettings: () => void;
    onRollbackToMessage: (message: SubjectiveMessage) => void;
    replyBusy: boolean;
  };
  tools: {
    executeChatTool: ChatToolBridge['executeChatTool'];
    showToolResultNotice: ChatToolBridge['showToolResultNotice'];
  };
};

export function useChatMessageInteractionController({
  memory,
  messages,
  page,
  tools,
}: UseChatMessageInteractionControllerOptions) {
  const {
    clearSessionMemoryState,
    currentStateCandidates,
    currentStateResolveCandidates,
    memoryCandidates,
    organizing,
    setMemoryCandidates,
    setMemoryNotice,
  } = memory.controller;
  const [editingMessage, setEditingMessage] = useState<SubjectiveMessage | null>(null);
  const [editingMessageText, setEditingMessageText] = useState('');
  const [replyingToMessage, setReplyingToMessage] = useState<SubjectiveMessage | null>(null);
  const [pendingOrganizationMessages, setPendingOrganizationMessages] = useState<SubjectiveMessage[] | null>(null);
  const [pendingOrganizationMode, setPendingOrganizationMode] = useState<'new' | 'selected'>('new');
  const [memorySelectionOpen, setMemorySelectionOpen] = useState(false);
  const [selectedMemoryMessageIds, setSelectedMemoryMessageIds] = useState<string[]>([]);
  const [likedStyleReferenceIds, setLikedStyleReferenceIds] = useState<string[]>([]);
  const memoryNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showShortMemoryNotice = (notice: string) => {
    setMemoryNotice(notice);
    if (memoryNoticeTimerRef.current) clearTimeout(memoryNoticeTimerRef.current);
    memoryNoticeTimerRef.current = setTimeout(() => setMemoryNotice(null), 2600);
  };

  const resetSelectionState = () => {
    setMemorySelectionOpen(false);
    setSelectedMemoryMessageIds([]);
  };

  const resetConversationInteraction = () => {
    setReplyingToMessage(null);
    resetSelectionState();
  };

  useEffect(() => () => {
    if (memoryNoticeTimerRef.current) clearTimeout(memoryNoticeTimerRef.current);
  }, []);

  useEffect(() => {
    if (!page.active) return undefined;
    let active = true;
    void loadActiveHeartRoundIds().then((ids) => {
      if (!active) return;
      setLikedStyleReferenceIds(ids);
    });
    return () => {
      active = false;
    };
  }, [page.active]);

  useEffect(() => {
    clearSessionMemoryState();
    resetSelectionState();
  }, [messages.activeSessionId]);

  const showMemoryOrganizerConfigAlert = () => {
    Alert.alert(MEMORY_ORGANIZER_CONFIG_TITLE, MEMORY_ORGANIZER_CONFIG_MESSAGE, [
      { text: '稍后再说', style: 'cancel' },
      { text: '去配置 AI', onPress: page.onOpenAiSettings },
    ]);
  };

  const handleOrganizeMemories = () => {
    if (organizing || page.replyBusy) return;
    if (!memory.organizerConnection || !memory.organizerKey.trim()) {
      showMemoryOrganizerConfigAlert();
      return;
    }

    const organizedThroughId = memory.organizedThroughId;
    const organizedIndex = organizedThroughId
      ? messages.messages.findIndex((message) => message.id === organizedThroughId)
      : -1;
    const newMessages = messages.messages.slice(organizedIndex + 1);
    // An empty chat range can still have an eligible letter waiting in the existing ledger.

    Keyboard.dismiss();
    page.onError(null);
    setPendingOrganizationMode('new');
    setPendingOrganizationMessages(newMessages);
  };

  const openSelectedMemoryOrganizer = () => {
    if (!messages.messages.length || organizing || page.replyBusy) return;
    if (!memory.organizerConnection || !memory.organizerKey.trim()) {
      showMemoryOrganizerConfigAlert();
      return;
    }
    Keyboard.dismiss();
    page.onError(null);
    setSelectedMemoryMessageIds([]);
    setMemorySelectionOpen(true);
  };

  const toggleSelectedMemoryMessage = (messageId: string) => {
    setSelectedMemoryMessageIds((current) =>
      current.includes(messageId)
        ? current.filter((id) => id !== messageId)
        : [...current, messageId],
    );
  };

  const confirmSelectedMemoryMessages = () => {
    const selected = (messages.presentedMessages ?? messages.messages).filter((message) => selectedMemoryMessageIds.includes(message.id));
    if (!selected.length) {
      page.onError('先勾选想整理进记忆的消息。');
      return;
    }
    setMemorySelectionOpen(false);
    setSelectedMemoryMessageIds([]);
    setPendingOrganizationMode('selected');
    setPendingOrganizationMessages(selected);
  };

  const confirmOrganizeMemories = async () => {
    const newMessages = pendingOrganizationMessages;
    if (!newMessages || organizing || !memory.organizerConnection || !memory.organizerKey.trim()) return;

    setPendingOrganizationMessages(null);
    page.onError(null);
    const legacyCursorMessage = pendingOrganizationMode === 'new' && memory.organizedThroughId
      ? messages.messages.find((message) => message.id === memory.organizedThroughId) ?? null
      : null;
    const result = await memory.controller.organizeMessages(
      newMessages,
      pendingOrganizationMode,
      legacyCursorMessage
        ? { createdAt: legacyCursorMessage.createdAt, id: legacyCursorMessage.id }
        : null,
    );
    if (result.status === 'done' && !result.generated) {
      page.onError('这次材料暂时没有提炼出需要保存的记忆。');
    } else if (result.status === 'failed') {
      page.onError(getMemoryOrganizationFailureNotice(result.failure));
    }
    setPendingOrganizationMode('new');
    setSelectedMemoryMessageIds([]);
  };

  const closeOrganizationModal = () => {
    setPendingOrganizationMessages(null);
    setPendingOrganizationMode('new');
  };

  const saveCandidate = async (candidate: MemoryCandidateReview, index: number) => {
    await memory.controller.saveCandidate(candidate, index);
  };

  const updateMemoryCandidate = (reviewId: string, patch: Partial<MemoryCandidateReview>) => {
    setMemoryCandidates((current) => current.map((candidate) => (
      candidate.reviewId === reviewId ? { ...candidate, ...patch } : candidate
    )));
  };

  const adjustMemoryCandidateImportance = (reviewId: string, delta: number) => {
    setMemoryCandidates((current) => current.map((candidate) => (
      candidate.reviewId === reviewId
        ? { ...candidate, importance: Math.max(1, Math.min(10, candidate.importance + delta)) }
        : candidate
    )));
  };

  const toggleMemoryCandidateAnchor = (reviewId: string) => {
    setMemoryCandidates((current) => current.map((candidate) => {
      if (candidate.reviewId !== reviewId) return candidate;
      const nextAnchor = !candidate.anchor;
      return {
        ...candidate,
        anchor: nextAnchor,
        anchorKind: nextAnchor
          ? candidate.anchorKind ?? inferAnchorKindFromDomain(candidate.domain)
          : undefined,
      };
    }));
  };

  const toggleMemoryCandidatePinned = (reviewId: string) => {
    setMemoryCandidates((current) => current.map((candidate) => (
      candidate.reviewId === reviewId ? { ...candidate, pinned: !candidate.pinned } : candidate
    )));
  };

  const discardMemoryCandidate = (reviewId: string) => {
    return memory.controller.discardCandidate(reviewId);
  };

  const saveCurrentStateCandidate = async (reviewId: string) => {
    const candidate = currentStateCandidates.find((item) => item.reviewId === reviewId);
    if (candidate) await memory.controller.saveCurrentStateCandidate(candidate);
  };

  const saveCurrentStateResolveCandidate = async (reviewId: string) => {
    const candidate = currentStateResolveCandidates.find((item) => item.reviewId === reviewId);
    if (candidate) await memory.controller.saveCurrentStateResolveCandidate(candidate);
  };

  const rememberMessage = (message: SubjectiveMessage) => {
    Alert.alert('收进记忆本？', '这条消息会作为一页可编辑的记忆保存下来。', [
      { text: '取消', style: 'cancel' },
      {
        text: '保存',
        onPress: async () => {
          const result = await tools.executeChatTool('memory.create', {
            ...memoryDraftToToolInput({
            title: deriveMemoryTitle(message.content),
            content: message.content,
            domain: '其他',
            tags: [],
            recallCues: [],
            importance: 5,
            valence: 0.5,
            arousal: 0.3,
            pinned: false,
            anchor: false,
            type: 'dynamic',
            resolved: false,
            digested: false,
            protected: false,
            sourceType: 'message',
            sourceStartAt: message.createdAt,
            sourceEndAt: message.createdAt,
            }),
            continuationAi: memory.organizerConnection && memory.organizerKey.trim()
              ? { apiKey: memory.organizerKey, connection: memory.organizerConnection }
              : undefined,
          }, message.id, { requestedBy: 'manual' });
          tools.showToolResultNotice(result, `已经收进记忆本啦：${deriveMemoryTitle(message.content)}`);
        },
      },
    ]);
  };

  const beginEditingMessage = (message: SubjectiveMessage) => {
    setEditingMessage(message);
    setEditingMessageText(message.content);
  };

  const copyMessage = async (message: SubjectiveMessage) => {
    await Clipboard.setStringAsync(message.content);
    showShortMemoryNotice('已经复制到剪贴板啦。');
  };

  const showFallbackDiagnostics = (diagnostics: FallbackDiagnostics) => {
    Alert.alert('兜底原因', formatFallbackDiagnostics(diagnostics), [{ text: '知道啦' }]);
  };

  const showGenerationDiagnostics = (diagnostics: GenerationDiagnostics) => {
    Alert.alert('生成原因', formatGenerationDiagnostics(diagnostics), [{ text: '知道啦' }]);
  };

  const getAssistantReplyRound = (anchor: SubjectiveMessage) => {
    return findHeartReplyRound(messages.presentedMessages ?? messages.messagesRef.current, anchor.id);
  };

  const toggleAssistantReplyRoundHeart = async (message: SubjectiveMessage) => {
    try {
      const epoch = captureBackupRestoreDataEpoch();
      const stored = messages.activeSessionId ? await loadChatSessionMessages(messages.activeSessionId) : [];
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      const round = findHeartReplyRound(stored, message.id);
      if (!round) return;
      const result = await toggleHeartReplyRound({
        round,
        sessionId: messages.activeSessionId,
      });
      setLikedStyleReferenceIds(result.activeIds);
      showShortMemoryNotice(
        result.liked
          ? '爱心亮起来啦，这轮放进爱心语料了。'
          : '爱心收回来啦，这轮离开爱心语料了。',
      );
    } catch {
      page.onError('爱心状态保存失败，请稍后再试。');
    }
  };

  const handleMessageLongPress = (message: SubjectiveMessage) => {
    if (message.role === 'I') {
      const moreActions = [
        ...(message.fallbackDiagnostics
          ? [{ text: '查看兜底原因', onPress: () => showFallbackDiagnostics(message.fallbackDiagnostics!) }]
          : []),
        ...(message.generationDiagnostics
          ? [{ text: '查看生成原因', onPress: () => showGenerationDiagnostics(message.generationDiagnostics!) }]
          : []),
        { text: '编辑这句话', onPress: () => beginEditingMessage(message) },
        { text: '复制', onPress: () => void copyMessage(message) },
        { text: '收进记忆本', onPress: () => rememberMessage(message) },
      ];
      const moreLabel = '更多';
      const showMoreActions = (start = 0) => Alert.alert('更多操作', undefined, [
        ...moreActions.slice(start, start + 2),
        ...(start + 2 < moreActions.length
          ? [{ text: moreLabel, onPress: () => showMoreActions(start + 2) }]
          : []),
      ], { cancelable: true });
      Alert.alert(
        '白云小姐的这句话',
        undefined,
        [
          { text: '复制', onPress: () => void copyMessage(message) },
          {
            text: moreLabel,
            onPress: () => showMoreActions(),
          },
          { text: '回溯到这里', style: 'destructive', onPress: () => page.onRollbackToMessage(message) },
        ],
        { cancelable: true },
      );
      return;
    }

    Alert.alert('小仓鼠的这句话', undefined, [
      { text: '复制', onPress: () => void copyMessage(message) },
      {
        text: '更多',
        onPress: () => Alert.alert('更多操作', undefined, [
          { text: '收进记忆本', onPress: () => rememberMessage(message) },
          { text: '回溯到这里', style: 'destructive', onPress: () => page.onRollbackToMessage(message) },
        ]),
      },
    ]);
  };

  const saveEditedMessage = async () => {
    const content = editingMessageText.trim();
    if (!editingMessage || !content) return;
    const originalMessage = editingMessage;

    if (messages.saveMessageContent) {
      if (!await messages.saveMessageContent(originalMessage, content)) return;
    } else messages.commitMessages(
      messages.messagesRef.current.map((message) =>
        message.id === originalMessage.id
          ? { ...message, content }
          : message,
      ),
    );
    setEditingMessage(null);
    setEditingMessageText('');
    Keyboard.dismiss();
  };

  const beginReplyToMessage = (message: SubjectiveMessage) => {
    if (memorySelectionOpen) return;
    setReplyingToMessage(message);
  };

  const closeEditingMessage = () => setEditingMessage(null);
  const closeMemorySelection = () => {
    setMemorySelectionOpen(false);
    setSelectedMemoryMessageIds([]);
  };
  const clearReplyingToMessage = () => setReplyingToMessage(null);

  return {
    actions: {
      adjustMemoryCandidateImportance,
      beginReplyToMessage,
      clearReplyingToMessage,
      closeEditingMessage,
      closeMemorySelection,
      closeOrganizationModal,
      confirmOrganizeMemories,
      confirmSelectedMemoryMessages,
      discardMemoryCandidate,
      getAssistantReplyRound,
      handleMessageLongPress,
      handleOrganizeMemories,
      openSelectedMemoryOrganizer,
      resetConversationInteraction,
      saveCandidate,
      saveCurrentStateCandidate,
      saveCurrentStateResolveCandidate,
      saveEditedMessage,
      toggleMemoryCandidateAnchor,
      toggleMemoryCandidatePinned,
      toggleAssistantReplyRoundHeart,
      toggleSelectedMemoryMessage,
      updateEditingMessageText: setEditingMessageText,
      updateMemoryCandidate,
    },
    showShortMemoryNotice,
    state: {
      editingMessage,
      editingMessageText,
      likedStyleReferenceIds,
      memorySelectionOpen,
      pendingOrganizationMessages,
      pendingOrganizationMode,
      replyingToMessage,
      selectedMemoryMessageIds,
    },
  };
}
