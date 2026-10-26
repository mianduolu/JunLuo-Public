import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { SLEEP_REPLY_DRAFT_KEY, readSleepReplyDraft } from '../life/sleepPlanPolicy';

import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import { chatStorageSyncBridge as AsyncStorage, chatStorageSyncReplayBridge } from '../sync/syncChatStorageBridge';

import type { MessageImage, SubjectiveMessage, TheaterBackstageMessageSource } from '../ai/subjectiveMessages';
import { isTheaterBackstageMessageSource } from '../ai/subjectiveMessages';
import { isReadingReference } from '../reading/readingReference';
import { isChatExpensePlanCard, isExpensePlanSourceCurrent, type ChatExpensePlanCard, type ExpensePlanSource, type ExpensePlanMutationResult } from './chatExpensePlan';
import { isChatReminderPlanCard, isReminderPlanSourceCurrent, type ChatReminderPlanCard, type ReminderPlanSource } from './chatReminderPlan';
import { stripRetiredActionMetadata } from '../ai/retiredAssistantFeatureData';
import { isVoiceCallRecord } from '../voiceCall/voiceCallRecord';
import type { JunLuoToolCallCard } from './toolCallMessageTypes';
import { isChatTextFileReference } from './chatTextFileReference';
import { SerializedMessageRecordCache } from './serializedMessageRecordCache';
import { observePhoneCareChatChanges, stopPhoneCareFollowUp } from '../proactive/phoneCareFollowUpStore';
import { PRIMARY_CHAT_SESSION_ID, assertPrimaryChatSessionId } from './primaryChat';
import { emitChatDataChanged, subscribeChatDataChanges } from './chatDataChanges';
import { invalidateChatMessageWriteSnapshots, retainChatMessageWriteSnapshot, retainChatSessionWriteSnapshots } from './chatPersistenceCoordinator';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { chatImageQuestionRevision, chatImageSourceRevision, isChatImageObservationMetadata,
  isChatImageReviewAttempt, preserveStoredChatImageRecords } from './chatImageRecord';
import { protectChatSummaryAutosave, mergeChatSummaryCorrectionState, normalizeChatSummaryCorrectionReview,
  type ChatSummaryCorrectionReview } from './chatSummaryCorrection';
import { CHAT_REPLY_DRAFT_KEY, chatReplyDraftBodyState, chatReplyDraftSourceRevision,
  isChatReplyDraftSourceCurrent, readChatReplyDraft, type ChatReplyDraft } from './chatReplyDraft';

const CHAT_MESSAGES_KEY = 'junluo.chat.primaryMessages';
const CHAT_MEMORY_ORGANIZED_THROUGH_KEY = 'junluo.chat.memoryOrganizedThrough';
const CHAT_SESSIONS_KEY = 'junluo.chat.sessions';
const ACTIVE_CHAT_SESSION_KEY = 'junluo.chat.activeSessionId';
const CHAT_SESSION_MESSAGES_PREFIX = 'junluo.chat.sessionMessages.';
const CHAT_SESSION_MESSAGE_ORDER_PREFIX = 'junluo.chat.sessionMessageOrder.';
const CHAT_SESSION_MESSAGE_PREFIX = 'junluo.chat.sessionMessage.';
const CHAT_MESSAGE_STORAGE_VERSION = 1;
const CHAT_MESSAGE_MIGRATION_BATCH_SIZE = 100;
const LEGACY_PHONE_GUARD_PLACEHOLDER = '白云小姐正在抓鼠……';
const PHONE_GUARD_PLACEHOLDER = '我正在抓小仓鼠……';
const LEGACY_PHONE_GUARD_INSTANT_PATTERN = /^鼠，(?:先回来|刚被抓回来又跑到 ).*白云小姐已经看见/;

export type ChatSession = {
  id: string;
  title: string;
  customTitle: boolean;
  messages: SubjectiveMessage[];
  messagesLoaded?: boolean;
  messageCount?: number;
  memoryOrganizedThroughId: string | null;
  proactiveMemoryReviewedThroughId: string | null;
  contextCompression?: ChatContextCompressionState;
  createdAt: number;
  updatedAt: number;
};

export type ChatContextCompressionState = {
  summaryVersion: number;
  summary: string;
  summarizedThroughMessageId: string | null;
  summarizedThroughAt: number | null;
  lastCompressedAt: number | null;
  lastBeforeTokens: number;
  lastAfterTokens: number;
  lastError?: string;
  lastFailedAt?: number;
  currentWindowTokens: number;
  promptCache?: PromptCacheStats;
  promptBreakdown?: PromptTokenBreakdown;
  tokenSource: 'estimate' | 'api';
  shortLogs?: ChatShortLog[];
  correctionReview?: ChatSummaryCorrectionReview;
};

export type ChatShortLog = {
  id: string;
  startMessageId: string;
  endMessageId: string;
  startAt: number;
  endAt: number;
  title: string;
  summary: string;
  createdAt: number;
  source: 'auto' | 'manual';
  correctionReview?: ChatSummaryCorrectionReview;
};

export type PromptCacheStats = {
  hitTokens: number | null;
  missTokens: number | null;
  hitRate: number | null;
  stablePrefixTokens: number;
  stablePrefixFingerprint: string;
  stablePrefixChanged: boolean;
};

export type PromptTokenBreakdown = {
  persona: number;
  userProfile: number;
  scenario: number;
  expression: number;
  memory: number;
  environment: number;
  summary: number;
  history: number;
};

type ChatSessionIndex = Omit<ChatSession, 'messages' | 'messagesLoaded'> & {
  messageCount: number;
};

export const emptyChatContextCompressionState: ChatContextCompressionState = {
  summaryVersion: 2,
  summary: '',
  summarizedThroughMessageId: null,
  summarizedThroughAt: null,
  lastCompressedAt: null,
  lastBeforeTokens: 0,
  lastAfterTokens: 0,
  currentWindowTokens: 0,
  tokenSource: 'estimate',
  shortLogs: [],
};

function normalizeShortLog(value: unknown): ChatShortLog | null {
  if (!value || typeof value !== 'object') return null;
  const log = value as Partial<ChatShortLog>;
  if (
    typeof log.id !== 'string' ||
    typeof log.startMessageId !== 'string' ||
    typeof log.endMessageId !== 'string' ||
    typeof log.startAt !== 'number' ||
    typeof log.endAt !== 'number' ||
    typeof log.title !== 'string' ||
    typeof log.summary !== 'string' ||
    typeof log.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    id: log.id,
    startMessageId: log.startMessageId,
    endMessageId: log.endMessageId,
    startAt: log.startAt,
    endAt: log.endAt,
    title: log.title,
    summary: log.summary,
    createdAt: log.createdAt,
    source: log.source === 'manual' ? 'manual' : 'auto',
    correctionReview: normalizeChatSummaryCorrectionReview(log.correctionReview),
  };
}

function normalizeCompressionState(value: unknown): ChatContextCompressionState {
  if (!value || typeof value !== 'object') return emptyChatContextCompressionState;
  const state = value as Partial<ChatContextCompressionState>;
  const rawBreakdown = state.promptBreakdown;
  const rawPromptCache = state.promptCache;
  const promptBreakdown = rawBreakdown && typeof rawBreakdown === 'object'
    ? {
        persona: Number.isFinite(rawBreakdown.persona) ? Number(rawBreakdown.persona) : 0,
        userProfile: Number.isFinite(rawBreakdown.userProfile) ? Number(rawBreakdown.userProfile) : 0,
        scenario: Number.isFinite(rawBreakdown.scenario) ? Number(rawBreakdown.scenario) : 0,
        expression: Number.isFinite(rawBreakdown.expression) ? Number(rawBreakdown.expression) : 0,
        memory: Number.isFinite(rawBreakdown.memory) ? Number(rawBreakdown.memory) : 0,
        environment: Number.isFinite(rawBreakdown.environment) ? Number(rawBreakdown.environment) : 0,
        summary: Number.isFinite(rawBreakdown.summary) ? Number(rawBreakdown.summary) : 0,
        history: Number.isFinite(rawBreakdown.history) ? Number(rawBreakdown.history) : 0,
      }
    : undefined;
  const promptCache = rawPromptCache && typeof rawPromptCache === 'object'
    ? {
        hitTokens: typeof rawPromptCache.hitTokens === 'number' ? rawPromptCache.hitTokens : null,
        missTokens: typeof rawPromptCache.missTokens === 'number' ? rawPromptCache.missTokens : null,
        hitRate: typeof rawPromptCache.hitRate === 'number' ? rawPromptCache.hitRate : null,
        stablePrefixTokens: typeof rawPromptCache.stablePrefixTokens === 'number'
          ? rawPromptCache.stablePrefixTokens
          : 0,
        stablePrefixFingerprint: typeof rawPromptCache.stablePrefixFingerprint === 'string'
          ? rawPromptCache.stablePrefixFingerprint
          : '',
        stablePrefixChanged: rawPromptCache.stablePrefixChanged === true,
      }
    : undefined;
  const shortLogs = Array.isArray(state.shortLogs)
    ? state.shortLogs.map(normalizeShortLog).filter((item): item is ChatShortLog => !!item)
      .filter((item, index, items) => !!item.correctionReview?.pending.length || index >= items.length - 12)
    : [];
  if (state.summary && state.summaryVersion !== 2) {
    return {
      ...emptyChatContextCompressionState,
      currentWindowTokens: typeof state.currentWindowTokens === 'number' ? state.currentWindowTokens : 0,
      tokenSource: state.tokenSource === 'api' ? 'api' : 'estimate',
    };
  }
  return {
    summaryVersion: 2,
    summary: typeof state.summary === 'string' ? state.summary : '',
    summarizedThroughMessageId:
      typeof state.summarizedThroughMessageId === 'string' ? state.summarizedThroughMessageId : null,
    summarizedThroughAt: typeof state.summarizedThroughAt === 'number' ? state.summarizedThroughAt : null,
    lastCompressedAt: typeof state.lastCompressedAt === 'number' ? state.lastCompressedAt : null,
    lastBeforeTokens: typeof state.lastBeforeTokens === 'number' ? state.lastBeforeTokens : 0,
    lastAfterTokens: typeof state.lastAfterTokens === 'number' ? state.lastAfterTokens : 0,
    lastError: typeof state.lastError === 'string' ? state.lastError : undefined,
    lastFailedAt: typeof state.lastFailedAt === 'number' ? state.lastFailedAt : undefined,
    currentWindowTokens: typeof state.currentWindowTokens === 'number' ? state.currentWindowTokens : 0,
    promptCache,
    promptBreakdown,
    tokenSource: state.tokenSource === 'api' ? 'api' : 'estimate',
    shortLogs,
    correctionReview: normalizeChatSummaryCorrectionReview(state.correctionReview),
  };
}

/** Only shared prose/version fields participate; prompt diagnostics do not invalidate a rewrite. */
function compressionMaterialFingerprint(state?: ChatContextCompressionState) {
  if (!state) return '';
  return JSON.stringify([state.summary, state.summarizedThroughMessageId, state.summarizedThroughAt,
    state.lastCompressedAt, state.correctionReview ?? null, (state.shortLogs ?? []).map(log => [
      log.id, log.startMessageId, log.endMessageId, log.startAt, log.endAt, log.title,
      log.summary, log.createdAt, log.source, log.correctionReview ?? null,
    ])]);
}

export async function loadChatContextCompressionState(sessionId: string): Promise<ChatContextCompressionState | undefined> {
  assertPrimaryChatSessionId(sessionId);
  await waitForPendingChatStateWrites();
  const [raw, active] = await Promise.all([AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY)]);
  if (raw === null) throw new Error('chat-summary-correction-session-missing');
  const session = assertPrimaryStoredIndex(raw, active).readSessions.find(({ index }) => index.id === sessionId);
  if (!session) throw new Error('chat-summary-correction-session-missing');
  const original = (JSON.parse(raw) as Array<Record<string, unknown>>).find(value => value.id === sessionId);
  return original?.contextCompression === undefined ? undefined : session.index.contextCompression;
}

/** Metadata-only CAS. Callers verify memory sources before joining this chat write queue. */
export async function commitChatContextCompressionState(sessionId: string, next: ChatContextCompressionState,
  options: { expected?: ChatContextCompressionState; dataEpoch?: number | null; shouldCommit?: () => boolean },
): Promise<ChatContextCompressionState> {
  assertPrimaryChatSessionId(sessionId);
  const epoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const expectedFingerprint = compressionMaterialFingerprint(options.expected);
  const hasExpected = Object.prototype.hasOwnProperty.call(options, 'expected');
  const snapshot = normalizeCompressionState(JSON.parse(JSON.stringify(next)));
  const shouldCommit = options.shouldCommit;
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const [raw, active] = await Promise.all([AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY)]);
      if (raw === null) throw new Error('chat-summary-correction-session-missing');
      const session = assertPrimaryStoredIndex(raw, active).readSessions.find(({ index }) => index.id === sessionId);
      if (!session) throw new Error('chat-summary-correction-session-missing');
      const values = JSON.parse(raw) as Array<Record<string, unknown>>;
      const storedCompression = values.find(value => value.id === sessionId)?.contextCompression === undefined
        ? undefined : session.index.contextCompression;
      if (hasExpected && compressionMaterialFingerprint(storedCompression) !== expectedFingerprint) {
        throw new Error('chat-summary-correction-stale');
      }
      const normalized = snapshot;
      if (shouldCommit && !shouldCommit()) throw new Error('chat-summary-correction-stale');
      await AsyncStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(values.map(value => value.id === sessionId
        ? { ...value, contextCompression: normalized } : value)));
      try { emitChatDataChanged(); } catch { /* The metadata commit already succeeded. */ }
      return normalized;
    });
    if (!result.committed) throw new Error('chat-summary-correction-stale');
    return result.value;
  });
}

type ReadSessionResult = {
  index: ChatSessionIndex;
  legacyMessages?: SubjectiveMessage[];
};

type ChatStoredMessageOrderEntry = {
  id: string;
  createdAt: number;
};

type ChatStoredMessageOrder = {
  version: typeof CHAT_MESSAGE_STORAGE_VERSION;
  messages: ChatStoredMessageOrderEntry[];
};

export type ChatMessagePage = {
  messages: SubjectiveMessage[];
  startIndex: number;
  totalCount: number;
};

const cachedSerializedMessageRecords = new SerializedMessageRecordCache();
let cachedSessionIds = new Set<string>();
const cachedMessageOrders = new Map<string, ChatStoredMessageOrderEntry[]>();
let saveChatStateQueue = Promise.resolve();
subscribeChatDataChanges(change => {
  if (change !== 'restore') return;
  cachedSerializedMessageRecords.clear();
  cachedMessageOrders.clear();
  cachedSessionIds.clear();
});

function getCachedMessageOrder(sessionId: string) {
  const cached = cachedMessageOrders.get(sessionId);
  if (!cached) return null;
  cachedMessageOrders.delete(sessionId);
  cachedMessageOrders.set(sessionId, cached);
  return cached;
}

function cacheMessageOrder(sessionId: string, order: ChatStoredMessageOrderEntry[]) {
  cachedMessageOrders.delete(sessionId);
  cachedMessageOrders.set(sessionId, order);
  while (cachedMessageOrders.size > 4) {
    const oldestSessionId = cachedMessageOrders.keys().next().value;
    if (typeof oldestSessionId !== 'string') break;
    cachedMessageOrders.delete(oldestSessionId);
  }
}

function enqueueChatStateWrite<T>(write: () => Promise<T>) {
  const currentWrite = saveChatStateQueue.catch(() => undefined).then(write);
  saveChatStateQueue = currentWrite.then(() => undefined, () => undefined);
  return currentWrite;
}

async function waitForPendingChatStateWrites() {
  await saveChatStateQueue.catch(() => undefined);
}

function enqueueChatMessageSnapshotWrite<T>(sessionId: string, messages: SubjectiveMessage[],
  write: (current: SubjectiveMessage[]) => Promise<T>, local = true) {
  const snapshot = local ? retainChatMessageWriteSnapshot(sessionId, messages) : null;
  return enqueueChatStateWrite(() => write(snapshot?.messages ?? messages)).finally(() => snapshot?.release());
}

async function readPendingChatReplyDraftNow(sessionId: string) {
  const draft = readChatReplyDraft(await RawAsyncStorage.getItem(CHAT_REPLY_DRAFT_KEY));
  return draft?.sessionId === sessionId ? draft : null;
}

async function discardPendingChatReplyDraftNow(sessionId: string, replyId?: string) {
  const draft = await readPendingChatReplyDraftNow(sessionId);
  if (draft && (replyId === undefined || draft.replyId === replyId)) {
    await RawAsyncStorage.removeItem(CHAT_REPLY_DRAFT_KEY);
  }
}

export async function loadPendingChatReplyDraft(sessionId: string): Promise<ChatReplyDraft | null> {
  await waitForPendingChatStateWrites();
  return readPendingChatReplyDraftNow(sessionId);
}

export function discardPendingChatReplyDraft(sessionId: string, replyId?: string): Promise<void> {
  return enqueueChatStateWrite(() => discardPendingChatReplyDraftNow(sessionId, replyId));
}

export async function savePendingChatReplyDraft(
  draft: ChatReplyDraft, options: { dataEpoch: number; canCommit: () => boolean },
): Promise<void> {
  assertPrimaryChatSessionId(draft.sessionId);
  const serialized = JSON.stringify(draft);
  const snapshot = readChatReplyDraft(serialized)!;
  await enqueueChatStateWrite(async () => {
    const committed = await runBackupRestoreDataEpochCommit(options.dataEpoch, async () => {
      const [raw, active] = await Promise.all([
        AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
      ]);
      const session = raw === null ? null : assertPrimaryStoredIndex(raw, active).readSessions
        .find(({ index }) => index.id === snapshot.sessionId);
      if (!session || !options.canCommit()) throw new Error('chat_reply_draft_stale');
      const order = readStoredMessageOrder(await AsyncStorage.getItem(getSessionMessageOrderKey(snapshot.sessionId)));
      const sourceIndex = order?.findIndex(entry => entry.id === snapshot.source.messageId) ?? -1;
      if (!order || sourceIndex < 0) throw new Error('chat_reply_draft_stale');
      const sourceIds = new Set([snapshot.source.messageId, ...snapshot.turnSources.map(ref => ref.messageId)]);
      // Older, unrelated history is not needed to check this turn. The tail is
      // still read so a newer you (including equal timestamps) cannot be missed.
      const messages = await loadMessageRecords(snapshot.sessionId,
        order.filter((entry, index) => index >= sourceIndex || sourceIds.has(entry.id)));
      if (!isChatReplyDraftSourceCurrent(snapshot, messages) || !options.canCommit()) {
        throw new Error('chat_reply_draft_stale');
      }
      await RawAsyncStorage.setItem(CHAT_REPLY_DRAFT_KEY, serialized);
      if (!options.canCommit()) {
        await discardPendingChatReplyDraftNow(snapshot.sessionId, snapshot.replyId);
        throw new Error('chat_reply_draft_stale');
      }
    });
    if (!committed.committed) throw new Error('chat_reply_draft_stale');
  });
}

export async function appendPendingChatReplyDraft(
  draft: ChatReplyDraft, options: { dataEpoch: number; canCommit: () => boolean;
    sourcesCurrent?: (messages: readonly SubjectiveMessage[]) => Promise<boolean> },
): Promise<SubjectiveMessage[] | null> {
  const serialized = JSON.stringify(draft);
  const snapshot = readChatReplyDraft(serialized)!;
  const additions = [...snapshot.messages];
  const result = await appendMessagesToChatSession(snapshot.sessionId, additions, {
    dataEpoch: options.dataEpoch,
    beforeAppend: async (messages) => {
      const pending = await readPendingChatReplyDraftNow(snapshot.sessionId);
      if (!pending || JSON.stringify(pending) !== serialized || !options.canCommit()) return false;
      if (!isChatReplyDraftSourceCurrent(pending, messages) || chatReplyDraftBodyState(pending, messages) === 'changed') {
        await discardPendingChatReplyDraftNow(snapshot.sessionId, snapshot.replyId);
        return false;
      }
      if (options.sourcesCurrent && !await options.sourcesCurrent(messages)) {
        await discardPendingChatReplyDraftNow(snapshot.sessionId, snapshot.replyId);
        return false;
      }
      const existing = new Set(messages.map(message => message.id));
      additions.splice(0, additions.length, ...additions.filter(message => !existing.has(message.id)));
      return options.canCommit();
    },
  });
  return result.session ? result.messages : null;
}

// Called only by the chat writer: metadata refreshes keep the paid body, while
// a source edit, new turn or explicit deletion invalidates its original host.
async function invalidatePendingChatReplyDraftForWrite(
  sessionId: string, existingIds: Set<string>, nextOrder: ChatStoredMessageOrderEntry[],
  records: readonly [string, string][],
) {
  const sleepDraft = readSleepReplyDraft(await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY));
  if (sleepDraft?.sessionId === sessionId && existingIds.has(sleepDraft.message.id)
    && !nextOrder.some(entry => entry.id === sleepDraft.message.id)) {
    await RawAsyncStorage.removeItem(SLEEP_REPLY_DRAFT_KEY);
  }
  const draft = await readPendingChatReplyDraftNow(sessionId);
  if (!draft) return;
  const refs = [draft.source, ...draft.turnSources];
  const nextIds = new Set(nextOrder.map(entry => entry.id));
  const sourceIndex = nextOrder.findIndex(entry => entry.id === draft.source.messageId);
  const changed = records.map(([, raw]) => JSON.parse(raw) as SubjectiveMessage);
  const invalid = refs.some(ref => !nextIds.has(ref.messageId))
    || draft.messages.some(message => existingIds.has(message.id) && !nextIds.has(message.id))
    || changed.some(message => message.role === 'you' && message.id !== draft.source.messageId
      && nextOrder.findIndex(entry => entry.id === message.id) > sourceIndex)
    || refs.some(ref => {
      const next = changed.find(message => message.id === ref.messageId);
      return next && (next.role !== 'you' || next.deliveryStatus === 'failed'
        || chatReplyDraftSourceRevision(next) !== ref.revision);
    })
    || chatReplyDraftBodyState(draft, changed) === 'changed';
  if (invalid) await discardPendingChatReplyDraftNow(sessionId, draft.replyId);
}

function getSessionMessagesKey(sessionId: string) {
  return `${CHAT_SESSION_MESSAGES_PREFIX}${encodeURIComponent(sessionId)}`;
}

function getSessionMessageOrderKey(sessionId: string) {
  return `${CHAT_SESSION_MESSAGE_ORDER_PREFIX}${encodeURIComponent(sessionId)}`;
}

function getSessionMessageKey(sessionId: string, messageId: string) {
  return `${CHAT_SESSION_MESSAGE_PREFIX}${encodeURIComponent(sessionId)}.${encodeURIComponent(messageId)}`;
}

function isMusicSong(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const song = value as Record<string, unknown>;
  return (
    typeof song.id === 'string' &&
    typeof song.name === 'string' &&
    typeof song.artist === 'string' &&
    typeof song.album === 'string' &&
    typeof song.cover === 'string' &&
    typeof song.duration === 'number'
  );
}

function isMessageMusicCard(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const card = value as Record<string, unknown>;
  const agentBinding = card.agentBinding as Record<string, unknown> | undefined;
  const validAgentBinding = agentBinding == null || (
    typeof agentBinding === 'object'
    && typeof agentBinding.cardId === 'string'
    && (agentBinding.searchAuditId == null || typeof agentBinding.searchAuditId === 'string')
    && (agentBinding.playAuditId == null || typeof agentBinding.playAuditId === 'string')
    && (typeof agentBinding.searchAuditId === 'string' || typeof agentBinding.playAuditId === 'string')
    && (
      agentBinding.controlAuditIds == null
      || Array.isArray(agentBinding.controlAuditIds)
        && agentBinding.controlAuditIds.every((item) => typeof item === 'string')
    )
  );
  const validPlaybackStatus = card.playbackStatus == null || [
    'ready',
    'starting',
    'playing',
    'paused',
    'stopped',
    'outcome_unknown',
  ].includes(String(card.playbackStatus));
  return (
    typeof card.keyword === 'string' &&
    (card.status === 'loading' || card.status === 'ready' || card.status === 'error') &&
    (card.song == null || isMusicSong(card.song)) &&
    (card.error == null || typeof card.error === 'string') &&
    validAgentBinding &&
    validPlaybackStatus
  );
}

function isMessageVoice(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const voice = value as Record<string, unknown>;
  return (
    typeof voice.uri === 'string' &&
    typeof voice.durationMs === 'number' &&
    Number.isFinite(voice.durationMs) &&
    (voice.transcript == null || typeof voice.transcript === 'string') &&
    (
      voice.transcriptionStatus == null ||
      voice.transcriptionStatus === 'pending' ||
      voice.transcriptionStatus === 'ready' ||
      voice.transcriptionStatus === 'error'
    ) &&
    (voice.transcriptionError == null || typeof voice.transcriptionError === 'string')
  );
}
function isMessageImage(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const image = value as Record<string, unknown>;
  return (
    typeof image.id === 'string' &&
    typeof image.uri === 'string' &&
    typeof image.name === 'string' &&
    (image.mimeType == null || typeof image.mimeType === 'string') &&
    (image.width == null || typeof image.width === 'number') &&
    (image.height == null || typeof image.height === 'number') &&
    (image.size == null || typeof image.size === 'number') &&
    (image.cacheId == null || typeof image.cacheId === 'string') &&
    (image.source === 'picker' || image.source === 'camera') &&
    typeof image.createdAt === 'number' &&
    (
      image.visionStatus === 'pending' ||
      image.visionStatus === 'ready' ||
      image.visionStatus === 'error' ||
      image.visionStatus === 'metadata_only'
    ) &&
    (image.visionSummary == null || typeof image.visionSummary === 'string') &&
    (image.visionError == null || typeof image.visionError === 'string') &&
    isChatImageObservationMetadata(image)
  );
}

function isMessageImages(value: unknown) {
  return Array.isArray(value) && value.every(isMessageImage);
}

function isMessageSticker(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const sticker = value as Record<string, unknown>;
  return (
    typeof sticker.id === 'string' &&
    typeof sticker.moodId === 'string' &&
    typeof sticker.name === 'string' &&
    typeof sticker.uri === 'string' &&
    (sticker.width == null || typeof sticker.width === 'number') &&
    (sticker.height == null || typeof sticker.height === 'number')
  );
}

function isMessageReplyTo(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const replyTo = value as Record<string, unknown>;
  return (
    typeof replyTo.id === 'string' &&
    (replyTo.role === 'I' || replyTo.role === 'you') &&
    typeof replyTo.content === 'string' &&
    typeof replyTo.createdAt === 'number'
  );
}

function isToolInputPreviewValue(value: unknown) {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return true;
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return (
    (item.type === 'array' && typeof item.length === 'number') ||
    (item.type === 'object' && Array.isArray(item.keys) && item.keys.every((key) => typeof key === 'string')) ||
    item.type === 'unknown'
  );
}

function isToolCallCard(value: unknown): value is JunLuoToolCallCard {
  if (!value || typeof value !== 'object') return false;
  const card = value as Partial<JunLuoToolCallCard>;
  return (
    typeof card.callId === 'string' &&
    typeof card.toolId === 'string' &&
    typeof card.packageId === 'string' &&
    typeof card.toolName === 'string' &&
    (card.status === 'requested' ||
      card.status === 'awaiting_permission' ||
      card.status === 'awaiting_confirmation' ||
      card.status === 'running' ||
      card.status === 'success' ||
      card.status === 'error' ||
      card.status === 'permission_denied' ||
      card.status === 'cancelled' ||
      card.status === 'outcome_unknown') &&
    !!card.inputPreview &&
    typeof card.inputPreview === 'object' &&
    Object.values(card.inputPreview).every(isToolInputPreviewValue) &&
    (card.permissionDecision === 'not_checked' ||
      card.permissionDecision === 'allowed' ||
      card.permissionDecision === 'denied' ||
      card.permissionDecision === 'cancelled') &&
    (card.resultSummary == null || typeof card.resultSummary === 'string') &&
    (card.errorMessage == null || typeof card.errorMessage === 'string') &&
    (card.fileReference === undefined || isChatTextFileReference(card.fileReference)) &&
    typeof card.createdAt === 'number' &&
    (card.startedAt == null || typeof card.startedAt === 'number') &&
    (card.finishedAt == null || typeof card.finishedAt === 'number')
    && (card.auditId == null || typeof card.auditId === 'string')
    && (card.providerCallId == null || typeof card.providerCallId === 'string')
    && (card.proposalId == null || typeof card.proposalId === 'string')
    && (card.confirmationExpiresAt == null || typeof card.confirmationExpiresAt === 'number')
    && (card.confirmationDecision == null || card.confirmationDecision === 'pending' || card.confirmationDecision === 'confirmed' || card.confirmationDecision === 'declined' || card.confirmationDecision === 'expired')
    && (card.confirmationPresentation == null || (
      typeof card.confirmationPresentation === 'object'
      && typeof card.confirmationPresentation.title === 'string'
      && (card.confirmationPresentation.summary == null || typeof card.confirmationPresentation.summary === 'string')
      && Array.isArray(card.confirmationPresentation.fields)
      && card.confirmationPresentation.fields.every((field) => (
        !!field && typeof field === 'object'
        && typeof field.label === 'string'
        && typeof field.value === 'string'
      ))
    ))
  );
}

function isToolCallCards(value: unknown) {
  return Array.isArray(value) && value.every(isToolCallCard);
}

function isFallbackDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const diagnostics = value as Record<string, unknown>;
  const sensitiveContext = diagnostics.sensitiveContext as Record<string, unknown> | undefined;
  const templateFamilies = diagnostics.templateFamilies;
  return (
    (
      diagnostics.kind === 'cleaned-empty' ||
      diagnostics.kind === 'quality-failed' ||
      diagnostics.kind === 'safety-redline' ||
      diagnostics.kind === 'laughter-guard'
    ) &&
    Array.isArray(diagnostics.reasons) &&
    diagnostics.reasons.every((reason) => typeof reason === 'string') &&
    typeof diagnostics.retryAttempted === 'boolean' &&
    typeof diagnostics.createdAt === 'number' &&
    (templateFamilies == null ||
      (Array.isArray(templateFamilies) &&
        templateFamilies.every((family) =>
          family === 'no-pressure' ||
          family === 'false-choice' ||
          family === 'echo-confirmation' ||
          family === 'static-presence' ||
          family === 'understanding-confirmation' ||
          family === 'soft-exit' ||
          family === 'performative-companion' ||
          family === 'model-self-disclosure' ||
          family === 'generic-comfort-stack' ||
          family === 'unsupported-past-fact' ||
          family === 'unsupported-tool-completion' ||
          family === 'coined-verb-cliche' ||
          family === 'user-correction-ignored',
        ))) &&
    (diagnostics.rawContentChars == null || typeof diagnostics.rawContentChars === 'number') &&
    (diagnostics.wasTruncated == null || typeof diagnostics.wasTruncated === 'boolean') &&
    !!sensitiveContext &&
    typeof sensitiveContext === 'object' &&
    typeof sensitiveContext.isSensitive === 'boolean' &&
    (
      sensitiveContext.severity === 'none' ||
      sensitiveContext.severity === 'mild' ||
      sensitiveContext.severity === 'strong'
    ) &&
    Array.isArray(sensitiveContext.signals) &&
    sensitiveContext.signals.every((signal) =>
      signal === 'pain' ||
      signal === 'anger' ||
      signal === 'rupture' ||
      signal === 'rejection' ||
      signal === 'comfortSeeking' ||
      signal === 'aiHarm',
    )
  );
}

function isGenerationDiagnostics(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const diagnostics = value as Record<string, unknown>;
  const reasons = diagnostics.reasons;
  return (
    (
      diagnostics.source === 'agent-task' ||
      diagnostics.source === 'proactive-message' ||
      diagnostics.source === 'phone-activity' ||
      diagnostics.source === 'life-project-share' ||
      diagnostics.source === 'social-share' ||
      diagnostics.source === 'web-voyage-share' ||
      diagnostics.source === 'jealousy-dismissal'
    ) &&
    typeof diagnostics.contextProfile === 'string' &&
    typeof diagnostics.usedMemory === 'boolean' &&
    typeof diagnostics.usedDesire === 'boolean' &&
    typeof diagnostics.usedSchedule === 'boolean' &&
    (diagnostics.usedPhoneActivity == null || typeof diagnostics.usedPhoneActivity === 'boolean') &&
    (diagnostics.usedRecentMessages == null || typeof diagnostics.usedRecentMessages === 'boolean') &&
    (diagnostics.rawMessageCount == null || typeof diagnostics.rawMessageCount === 'number') &&
    (diagnostics.keptMessageCount == null || typeof diagnostics.keptMessageCount === 'number') &&
    (diagnostics.rawContentChars == null || typeof diagnostics.rawContentChars === 'number') &&
    (diagnostics.wasTruncated == null || typeof diagnostics.wasTruncated === 'boolean') &&
    (reasons == null || (Array.isArray(reasons) && reasons.every((reason) => typeof reason === 'string'))) &&
    (diagnostics.triggerKind == null || typeof diagnostics.triggerKind === 'string') &&
    (diagnostics.eventStage == null || typeof diagnostics.eventStage === 'string') &&
    (diagnostics.usedFallback == null || typeof diagnostics.usedFallback === 'boolean') &&
    typeof diagnostics.createdAt === 'number'
  );
}

function isSubjectiveMessage(value: unknown): value is SubjectiveMessage {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const message = value as Partial<SubjectiveMessage>;
  return (
    (message.role === 'I' || message.role === 'you') &&
    typeof message.id === 'string' &&
    typeof message.content === 'string' &&
    typeof message.createdAt === 'number' &&
    (message.theaterBackstage === undefined || (
      message.role === 'I' && isTheaterBackstageMessageSource(message.theaterBackstage)
    )) &&
    (message.theaterBackstagePending === undefined || (
      message.theaterBackstagePending === true && message.role === 'I'
      && isTheaterBackstageMessageSource(message.theaterBackstage)
    )) &&
    (message.deliveryStatus == null || message.deliveryStatus === 'failed') &&
    (message.deliveryError == null || typeof message.deliveryError === 'string') &&
    (message.sendPreparation === undefined || (message.role === 'you' && message.sendPreparation === 'sleep')) &&
    (message.source == null ||
      message.source === 'chat' ||
      message.source === 'schedule-plan' ||
      message.source === 'goal-time-credit' ||
      message.source === 'schedule-reminder' ||
      message.source === 'todo-reminder' ||
      message.source === 'schedule-companion' ||
      message.source === 'period-companion' ||
      message.source === 'proactive-message' ||
      message.source === 'agent-task' ||
      message.source === 'life-message' ||
      message.source === 'letter' ||
      message.source === 'execution-nudge' ||
      message.source === 'voice-call' ||
      message.source === 'tool-call') &&
    (message.schedulePlanCard == null || (
      typeof message.schedulePlanCard === 'object' &&
      typeof message.schedulePlanCard.plan === 'object' &&
      typeof message.schedulePlanCard.plan.id === 'string' &&
      (message.schedulePlanCard.status === 'pending' ||
        message.schedulePlanCard.status === 'confirmed' ||
        message.schedulePlanCard.status === 'cancelled' ||
        message.schedulePlanCard.status === 'conflict')
    )) &&
    (message.expensePlanCard === undefined || (message.role === 'I' && isChatExpensePlanCard(message.expensePlanCard))) &&
    (message.reminderPlanCard === undefined || (message.role === 'I' && isChatReminderPlanCard(message.reminderPlanCard))) &&
    (message.reminderOccurrenceId === undefined || typeof message.reminderOccurrenceId === 'string') &&
    (message.reminderAttemptId === undefined || typeof message.reminderAttemptId === 'string') &&
    ((message.reminderOccurrenceId === undefined && message.reminderAttemptId === undefined)
      || (message.role === 'I' && message.source === 'schedule-reminder'
        && !!message.reminderOccurrenceId && !!message.reminderAttemptId)) &&
    (message.goalTimeCreditCard == null || (
      typeof message.goalTimeCreditCard === 'object' &&
      typeof message.goalTimeCreditCard.requestId === 'string' &&
      typeof message.goalTimeCreditCard.todoId === 'string' &&
      typeof message.goalTimeCreditCard.goalId === 'string' &&
      typeof message.goalTimeCreditCard.todoTitle === 'string' &&
      typeof message.goalTimeCreditCard.suggestedMinutes === 'number' &&
      typeof message.goalTimeCreditCard.reason === 'string' &&
      (message.goalTimeCreditCard.status === 'pending' ||
        message.goalTimeCreditCard.status === 'confirmed' ||
        message.goalTimeCreditCard.status === 'skipped' ||
        message.goalTimeCreditCard.status === 'cancelled')
    )) &&
    (message.scheduleChangeCard == null || (
      typeof message.scheduleChangeCard === 'object' &&
      typeof message.scheduleChangeCard.id === 'string' &&
      typeof message.scheduleChangeCard.kind === 'string' &&
      typeof message.scheduleChangeCard.title === 'string' &&
      typeof message.scheduleChangeCard.before === 'string' &&
      (message.scheduleChangeCard.after == null || typeof message.scheduleChangeCard.after === 'string') &&
      (message.scheduleChangeCard.status === 'pending' ||
        message.scheduleChangeCard.status === 'confirmed' ||
        message.scheduleChangeCard.status === 'cancelled' ||
        message.scheduleChangeCard.status === 'failed')
    )) &&
    (message.scheduleOccurrenceId == null || typeof message.scheduleOccurrenceId === 'string') &&
    (message.scheduleReminderPersona == null ||
      message.scheduleReminderPersona === 'live' ||
      message.scheduleReminderPersona === 'prepared-note' ||
      message.scheduleReminderPersona === 'sleep-talk') &&
    (message.scheduleCompanionEventId == null || typeof message.scheduleCompanionEventId === 'string') &&
    (message.scheduleCompanionKind == null || message.scheduleCompanionKind === 'upcoming' || message.scheduleCompanionKind === 'timeUp' || message.scheduleCompanionKind === 'followUp') &&
    (message.taskExecutionSessionId == null || typeof message.taskExecutionSessionId === 'string') &&
    (message.taskExecutionNudgeKind == null ||
      message.taskExecutionNudgeKind === 'timeReached' ||
      message.taskExecutionNudgeKind === 'stuck' ||
      message.taskExecutionNudgeKind === 'breakNeeded') &&
    (message.toolCallCards == null || isToolCallCards(message.toolCallCards)) &&
    (message.musicCard == null || isMessageMusicCard(message.musicCard)) &&
    (message.replyTo == null || isMessageReplyTo(message.replyTo)) &&
    (message.readingReference === undefined || (message.role === 'you' && isReadingReference(message.readingReference))) &&
    (message.fallbackDiagnostics == null || isFallbackDiagnostics(message.fallbackDiagnostics)) &&
    (message.generationDiagnostics == null || isGenerationDiagnostics(message.generationDiagnostics)) &&
    (message.voice == null || isMessageVoice(message.voice)) &&
    (message.voiceCallRecord == null || isVoiceCallRecord(message.voiceCallRecord)) &&
    (message.images == null || isMessageImages(message.images)) &&
    (message.chatImageReviewAttempt === undefined || (message.role === 'you' && isChatImageReviewAttempt(message.chatImageReviewAttempt))) &&
    (message.sticker == null || isMessageSticker(message.sticker))
  );
}

function normalizeStoredMessage(message: SubjectiveMessage): SubjectiveMessage {
  message = stripRetiredActionMetadata(message);
  const trimmedContent = message.content.trim();
  if (trimmedContent === LEGACY_PHONE_GUARD_PLACEHOLDER || LEGACY_PHONE_GUARD_INSTANT_PATTERN.test(trimmedContent)) {
    return {
      ...message,
      content: PHONE_GUARD_PLACEHOLDER,
    };
  }

  if (message.toolCallCards?.some((card) => (
    card.status === 'awaiting_confirmation' && card.confirmationDecision === 'pending'
  ))) {
    return {
      ...message,
      toolCallCards: message.toolCallCards.map((card) => (
        card.status === 'awaiting_confirmation' && card.confirmationDecision === 'pending'
          ? {
              ...card,
              confirmationDecision: 'expired',
              finishedAt: card.finishedAt ?? Date.now(),
            }
          : card
      )),
    };
  }

  return message;
}

function normalizeStoredMessages(messages: SubjectiveMessage[]) {
  return messages.map(normalizeStoredMessage);
}

function deriveSessionTitle(messages: SubjectiveMessage[]) {
  const firstYouMessage = messages.find((message) => message.role === 'you');
  const preview = firstYouMessage?.content.replace(/\s+/g, ' ').trim();
  return preview ? (preview.length > 16 ? `${preview.slice(0, 16)}...` : preview) : '新的对话';
}

export function createChatSession(now = Date.now()): ChatSession {
  return {
    id: PRIMARY_CHAT_SESSION_ID,
    title: '新的对话',
    customTitle: false,
    messages: [],
    messagesLoaded: true,
    messageCount: 0,
    memoryOrganizedThroughId: null,
    proactiveMemoryReviewedThroughId: null,
    contextCompression: emptyChatContextCompressionState,
    createdAt: now,
    updatedAt: now,
  };
}

export function updateChatSession(
  session: ChatSession,
  messages: SubjectiveMessage[],
  memoryOrganizedThroughId: string | null,
  proactiveMemoryReviewedThroughId: string | null = session.proactiveMemoryReviewedThroughId,
) {
  const lastMessage = messages[messages.length - 1];
  return {
    ...session,
    title: session.customTitle ? session.title : deriveSessionTitle(messages),
    messages,
    messagesLoaded: true,
    messageCount: messages.length,
    memoryOrganizedThroughId,
    proactiveMemoryReviewedThroughId,
    updatedAt: lastMessage?.createdAt ?? session.updatedAt,
  };
}

export function mergeSubjectiveMessages(
  preferredMessages: SubjectiveMessage[],
  incomingMessages: SubjectiveMessage[],
) {
  const byId = new Map<string, SubjectiveMessage>();
  incomingMessages.forEach((message) => byId.set(message.id, message));
  preferredMessages.forEach((message) => {
    const pokeInteraction = message.pokeInteraction ?? byId.get(message.id)?.pokeInteraction;
    const existing = byId.get(message.id);
    const readingReference = message.role === 'you' && existing?.role === 'you'
      ? existing.readingReference ?? message.readingReference : message.readingReference;
    byId.set(message.id, { ...message, ...(pokeInteraction ? { pokeInteraction } : {}),
      ...(readingReference ? { readingReference } : {}) });
  });
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

export function mergeChatSnapshotMessages(
  snapshotMessages: SubjectiveMessage[],
  currentMessages: SubjectiveMessage[],
  localRevisionChanged: boolean,
) {
  return localRevisionChanged
    ? mergeSubjectiveMessages(currentMessages, snapshotMessages)
    : mergeSubjectiveMessages(snapshotMessages, currentMessages);
}

function toSessionIndex(session: ChatSession): ChatSessionIndex {
  return {
    id: session.id,
    title: session.title,
    customTitle: session.customTitle,
    memoryOrganizedThroughId: session.memoryOrganizedThroughId,
    proactiveMemoryReviewedThroughId: session.proactiveMemoryReviewedThroughId,
    contextCompression: normalizeCompressionState(session.contextCompression),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messagesLoaded === false
      ? session.messageCount ?? 0
      : session.messages.length,
  };
}

function readSessionIndex(value: unknown): ReadSessionResult | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const session = value as Partial<ChatSession> & { messageCount?: unknown };
  if (session.id === PRIMARY_CHAT_SESSION_ID && session.messages !== undefined
    && (!Array.isArray(session.messages) || session.messages.some(message => !isSubjectiveMessage(message)))) {
    throw new Error('主聊天内嵌消息损坏。');
  }
  const embeddedMessages = Array.isArray(session.messages)
    ? normalizeStoredMessages(session.messages.filter(isSubjectiveMessage))
    : undefined;

  if (
    typeof session.id === 'string' &&
    typeof session.title === 'string' &&
    (session.memoryOrganizedThroughId === null || typeof session.memoryOrganizedThroughId === 'string') &&
    (session.proactiveMemoryReviewedThroughId == null || typeof session.proactiveMemoryReviewedThroughId === 'string') &&
    typeof session.createdAt === 'number' && Number.isFinite(session.createdAt) &&
    typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt) &&
    (session.messageCount === undefined || (Number.isSafeInteger(session.messageCount) && session.messageCount >= 0))
  ) {
    return {
      index: {
        id: session.id,
        title: session.title,
        customTitle: session.customTitle === true,
        memoryOrganizedThroughId: session.memoryOrganizedThroughId,
        proactiveMemoryReviewedThroughId: session.proactiveMemoryReviewedThroughId ?? null,
        contextCompression: normalizeCompressionState(session.contextCompression),
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount:
          typeof session.messageCount === 'number'
            ? session.messageCount
            : embeddedMessages?.length ?? 0,
      },
      legacyMessages: embeddedMessages,
    };
  }

  return null;
}

function readMessagesJson(raw: string | null) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? normalizeStoredMessages(parsed.filter(isSubjectiveMessage)) : [];
  } catch {
    return [];
  }
}

function readMessageJson(raw: string | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isSubjectiveMessage(parsed) ? normalizeStoredMessage(parsed) : null;
  } catch {
    return null;
  }
}

function readStoredMessageOrder(raw: string | null): ChatStoredMessageOrderEntry[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ChatStoredMessageOrder>;
    if (parsed.version !== CHAT_MESSAGE_STORAGE_VERSION || !Array.isArray(parsed.messages)) {
      throw new Error('聊天消息顺序索引损坏。');
    }
    const seen = new Set<string>();
    const messages: ChatStoredMessageOrderEntry[] = [];
    for (const value of parsed.messages) {
      if (
        !value ||
        typeof value !== 'object' ||
        typeof value.id !== 'string' ||
        !Number.isFinite(value.createdAt) ||
        seen.has(value.id)
      ) {
        throw new Error('聊天消息顺序索引损坏：重复或缺失消息字段。');
      }
      seen.add(value.id);
      messages.push({ id: value.id, createdAt: value.createdAt });
    }
    return messages;
  } catch (error) {
    throw new Error(`聊天消息顺序索引损坏：${error instanceof Error ? error.message : String(error)}`);
  }
}

function toStoredMessageOrder(messages: SubjectiveMessage[]) {
  const seen = new Set<string>();
  const entries: ChatStoredMessageOrderEntry[] = [];
  for (const message of messages) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    entries.push({ id: message.id, createdAt: message.createdAt });
  }
  return entries;
}

function serializeStoredMessageOrder(messages: ChatStoredMessageOrderEntry[]) {
  return JSON.stringify({ version: CHAT_MESSAGE_STORAGE_VERSION, messages } satisfies ChatStoredMessageOrder);
}

function mergeStoredMessageOrder(
  existing: ChatStoredMessageOrderEntry[],
  incoming: SubjectiveMessage[],
) {
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  incoming.forEach((message) => byId.set(message.id, { id: message.id, createdAt: message.createdAt }));
  return [...byId.values()].sort((left, right) => left.createdAt - right.createdAt);
}

async function loadMessageRecords(sessionId: string, entries: ChatStoredMessageOrderEntry[]) {
  if (!entries.length) return [];
  const keys = entries.map((entry) => getSessionMessageKey(sessionId, entry.id));
  const stored = new Map(await AsyncStorage.multiGet(keys));
  const messages: SubjectiveMessage[] = [];
  for (const entry of entries) {
    const key = getSessionMessageKey(sessionId, entry.id);
    const raw = stored.get(key) ?? null;
    const message = readMessageJson(raw);
    if (!message || message.id !== entry.id || message.createdAt !== entry.createdAt) {
      throw new Error('聊天消息原文缺失或损坏，已经停止读取。');
    }
    cachedSerializedMessageRecords.set(key, raw!);
    messages.push(message);
  }
  return messages;
}

async function loadSessionMessagePage(
  sessionId: string,
  options: { limit?: number; beforeIndex?: number } = {},
  embeddedLegacyMessages: SubjectiveMessage[] = [],
): Promise<ChatMessagePage> {
  const cachedOrder = getCachedMessageOrder(sessionId);
  const orderRaw = cachedOrder ? null : await AsyncStorage.getItem(getSessionMessageOrderKey(sessionId));
  const order = cachedOrder ?? readStoredMessageOrder(orderRaw);
  if (order) {
    if (!cachedOrder) cacheMessageOrder(sessionId, order);
    const totalCount = order.length;
    const endIndex = Math.max(0, Math.min(options.beforeIndex ?? totalCount, totalCount));
    const startIndex = options.limit == null
      ? 0
      : Math.max(0, endIndex - Math.max(0, options.limit));
    return {
      messages: await loadMessageRecords(sessionId, order.slice(startIndex, endIndex)),
      startIndex,
      totalCount,
    };
  }

  if (sessionId === PRIMARY_CHAT_SESSION_ID) throw new Error('主聊天消息顺序索引缺失，不能回落旧聊天。');

  const legacyRaw = await AsyncStorage.getItem(getSessionMessagesKey(sessionId));
  const legacyMessages = legacyRaw ? readMessagesJson(legacyRaw) : embeddedLegacyMessages;
  return options.limit == null
    ? { messages: legacyMessages, startIndex: 0, totalCount: legacyMessages.length }
    : getMessagePage(legacyMessages, options.limit, options.beforeIndex);
}

function preserveStoredReadingReference(serialized: string, oldRaw?: string, imageMetadataCommit = false, expenseMetadataCommit = false) {
  if (!oldRaw) return serialized;
  const existing = JSON.parse(oldRaw) as SubjectiveMessage;
  let incoming = JSON.parse(serialized) as SubjectiveMessage;
  if (!imageMetadataCommit) incoming = preserveStoredChatImageRecords(incoming, existing);
  if (!expenseMetadataCommit && existing.expensePlanCard) incoming = { ...incoming, expensePlanCard: existing.expensePlanCard };
  if (!expenseMetadataCommit && existing.reminderPlanCard) incoming = { ...incoming, reminderPlanCard: existing.reminderPlanCard };
  if (existing.role === 'you' && incoming.role === 'you' && isReadingReference(existing.readingReference)) {
    incoming = { ...incoming, readingReference: existing.readingReference };
  }
  return JSON.stringify(incoming);
}

async function writeSessionMessagesIncrementally(
  sessionId: string,
  incomingMessages: SubjectiveMessage[],
  mode: 'merge' | 'replace',
  embeddedLegacyMessages: SubjectiveMessage[] = [],
  imageMetadataCommit = false,
  expenseMetadataCommit = false,
  writeStorage = AsyncStorage,
) {
  const orderKey = getSessionMessageOrderKey(sessionId);
  const legacyKey = getSessionMessagesKey(sessionId);
  const orderRaw = await AsyncStorage.getItem(orderKey);
  const storedOrder = readStoredMessageOrder(orderRaw);
  if (!storedOrder && sessionId === PRIMARY_CHAT_SESSION_ID && await AsyncStorage.getItem(CHAT_SESSIONS_KEY) !== null) {
    throw new Error('主聊天消息顺序索引缺失，不能用新写入覆盖损坏的数据。');
  }
  const legacyRaw = storedOrder ? null : await AsyncStorage.getItem(legacyKey);
  const legacyMessages = storedOrder
    ? []
    : legacyRaw
      ? readMessagesJson(legacyRaw)
      : embeddedLegacyMessages;
  const existingOrder = storedOrder ?? toStoredMessageOrder(legacyMessages);
  const nextOrder = mode === 'replace'
    ? toStoredMessageOrder(incomingMessages)
    : mergeStoredMessageOrder(existingOrder, incomingMessages);
  const existingIds = new Set(existingOrder.map(({ id }) => id));
  const nextIds = new Set(nextOrder.map(({ id }) => id));
  const migrationMessages = storedOrder
    ? incomingMessages
    : mergeSubjectiveMessages(incomingMessages, legacyMessages);
  const candidateByKey = new Map<string, { id: string; serialized: string }>();
  for (const message of migrationMessages) {
    candidateByKey.set(
      getSessionMessageKey(sessionId, message.id),
      { id: message.id, serialized: JSON.stringify(stripRetiredActionMetadata(message)) },
    );
  }

  const keysToRead = [...candidateByKey.entries()]
    .filter(([key, candidate]) => existingIds.has(candidate.id) && !cachedSerializedMessageRecords.has(key))
    .map(([key]) => key);
  if (keysToRead.length) {
    const storedRecords = await AsyncStorage.multiGet(keysToRead);
    storedRecords.forEach(([key, raw]) => {
      if (raw != null) cachedSerializedMessageRecords.set(key, raw);
    });
  }

  const nextOrderRaw = serializeStoredMessageOrder(nextOrder);
  const messageEntries: [string, string][] = [];
  candidateByKey.forEach(({ serialized }, key) => {
    serialized = preserveStoredReadingReference(serialized, cachedSerializedMessageRecords.get(key), imageMetadataCommit, expenseMetadataCommit);
    if (cachedSerializedMessageRecords.get(key) !== serialized) messageEntries.push([key, serialized]);
  });
  await invalidatePendingChatReplyDraftForWrite(sessionId, existingIds, nextOrder, messageEntries);
  const bodyKey = (message: SubjectiveMessage) => JSON.stringify([
    message.role, message.content, message.images, message.voice, message.sticker, message.replyTo, message.readingReference,
  ]);
  const changedBodies = messageEntries.flatMap(([key, raw]) => {
    const next = JSON.parse(raw) as SubjectiveMessage;
    const oldRaw = cachedSerializedMessageRecords.get(key);
    return oldRaw && bodyKey(JSON.parse(oldRaw) as SubjectiveMessage) === bodyKey(next) ? [] : [next];
  });
  if (!storedOrder) {
    for (let index = 0; index < messageEntries.length; index += CHAT_MESSAGE_MIGRATION_BATCH_SIZE) {
      const batch = messageEntries.slice(index, index + CHAT_MESSAGE_MIGRATION_BATCH_SIZE);
      await writeStorage.multiSet(batch);
      batch.forEach(([key, value]) => cachedSerializedMessageRecords.set(key, value));
    }
    await writeStorage.setItem(orderKey, nextOrderRaw);
  } else {
    const entries = orderRaw === nextOrderRaw
      ? messageEntries
      : [[orderKey, nextOrderRaw] as [string, string], ...messageEntries];
    if (entries.length) await writeStorage.multiSet(entries);
    messageEntries.forEach(([key, value]) => cachedSerializedMessageRecords.set(key, value));
  }
  if (cachedMessageOrders.has(sessionId)) cacheMessageOrder(sessionId, nextOrder);

  const removedKeys = existingOrder
    .filter(({ id }) => !nextIds.has(id))
    .map(({ id }) => getSessionMessageKey(sessionId, id));
  if (removedKeys.length) {
    await writeStorage.multiRemove(removedKeys);
    removedKeys.forEach((key) => cachedSerializedMessageRecords.delete(key));
  }
  if (legacyRaw != null) await writeStorage.removeItem(legacyKey);
  await observePhoneCareChatChanges(sessionId, changedBodies, [...existingIds].filter((id) => !nextIds.has(id)));
  const freshYou = incomingMessages.filter(message => message.role === 'you' && message.source !== 'letter' && !existingIds.has(message.id));
  if (freshYou.length) {
    const { observeContactYouMessage } = await import('../proactive/unifiedContactStore');
    const { runChatAuxiliaryOperation } = await import('./chatAuxiliaryDiagnostics');
    for (const message of freshYou) await runChatAuxiliaryOperation({
      phase: 'commit', stage: 'continuity_ledger', retryLocalSave: true,
    }, () => observeContactYouMessage(message));
    // Do not hold the chat writer while the desire writer may be checking these messages.
    // The clock entry has its own local retry/diagnostic boundary; saved chat remains saved.
    void (await import('../life/junluoDesireRuntime'))
      .noteJunluoYouMessage(Math.max(...freshYou.map(message => message.createdAt)));
  }
  return nextOrder;
}

async function removeSessionMessageStorage(sessionId: string) {
  await stopPhoneCareFollowUp('session_deleted', sessionId);
  const orderKey = getSessionMessageOrderKey(sessionId);
  const order = readStoredMessageOrder(await AsyncStorage.getItem(orderKey)) ?? [];
  const messageKeys = order.map(({ id }) => getSessionMessageKey(sessionId, id));
  await AsyncStorage.multiRemove([orderKey, getSessionMessagesKey(sessionId), ...messageKeys]);
  cachedMessageOrders.delete(sessionId);
  messageKeys.forEach((key) => cachedSerializedMessageRecords.delete(key));
}

function getMessagePage(messages: SubjectiveMessage[], limit: number, beforeIndex?: number): ChatMessagePage {
  const totalCount = messages.length;
  const endIndex = Math.max(0, Math.min(beforeIndex ?? totalCount, totalCount));
  const startIndex = Math.max(0, endIndex - Math.max(0, limit));
  return {
    messages: messages.slice(startIndex, endIndex),
    startIndex,
    totalCount,
  };
}

function hydrateSession(index: ChatSessionIndex, messages: SubjectiveMessage[], messagesLoaded: boolean): ChatSession {
  if (!messagesLoaded) {
    return {
      ...index,
      messages,
      messagesLoaded: false,
      messageCount: Math.max(index.messageCount, messages.length),
    };
  }
  const normalized = updateChatSession(
    { ...index, messages, messagesLoaded, messageCount: index.messageCount },
    messages,
    index.memoryOrganizedThroughId,
    index.proactiveMemoryReviewedThroughId,
  );
  return {
    ...normalized,
    messages,
    messagesLoaded,
    messageCount: messagesLoaded ? normalized.messages.length : index.messageCount,
  };
}

function parseStoredSessionIndexes(storedSessions: string, storedActiveSessionId: string | null) {
  const parsed = JSON.parse(storedSessions) as unknown;
  if (!Array.isArray(parsed)) throw new Error('聊天索引损坏：必须是会话数组。');
  const readSessions = parsed.map(readSessionIndex);
  if (readSessions.some(session => !session)) throw new Error('聊天索引损坏：会话字段不完整。');
  const validSessions = readSessions as ReadSessionResult[];
  if (!validSessions.length) return null;
  if (new Set(validSessions.map(({ index }) => index.id)).size !== validSessions.length) {
    throw new Error('聊天索引损坏：出现重复会话。');
  }
  const activeSessionId =
    validSessions.some(({ index }) => index.id === storedActiveSessionId) ? storedActiveSessionId! : validSessions[0].index.id;
  cachedSessionIds = new Set(validSessions.map(({ index }) => index.id));
  return { readSessions: validSessions, activeSessionId };
}

function assertPrimaryStoredIndex(storedSessions: string, storedActiveSessionId: string | null) {
  const parsed = parseStoredSessionIndexes(storedSessions, storedActiveSessionId);
  if (!parsed) throw new Error('聊天索引为空，需核对已删除会话和存储恢复状态，不能自动重建。');
  parsed.readSessions.forEach(({ index }) => assertPrimaryChatSessionId(index.id));
  if (storedActiveSessionId !== PRIMARY_CHAT_SESSION_ID) {
    throw new Error('主聊天索引损坏：当前聊天标识缺失或不一致。');
  }
  return parsed;
}

async function ensurePrimaryChatStorage() {
  const read = async () => {
    const [sessions, active] = await Promise.all([
      AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
    ]);
    if (sessions !== null) assertPrimaryStoredIndex(sessions, active);
    return { sessions, active };
  };
  await waitForPendingChatStateWrites();
  const existing = await read();
  if (existing.sessions !== null) return existing;
  return enqueueChatStateWrite(async () => {
    const current = await read();
    if (current.sessions !== null) return current;
    const keys = await RawAsyncStorage.getAllKeys();
    if (current.active !== null || keys.some(key => (
      key === CHAT_MESSAGES_KEY || key === CHAT_MEMORY_ORGANIZED_THROUGH_KEY
      || key.startsWith(CHAT_SESSION_MESSAGE_PREFIX)
      || key.startsWith(CHAT_SESSION_MESSAGE_ORDER_PREFIX)
      || key.startsWith(CHAT_SESSION_MESSAGES_PREFIX)
      || key === 'junluo.sync.chatCorePendingCapture.v1'
    ))) throw new Error('发现旧聊天或未完成保存记录，需先完成旧聊天清理，不能自动创建主聊天。');
    const initial = createChatSession();
    await saveChatStateNow([initial], PRIMARY_CHAT_SESSION_ID);
    return read();
  });
}

async function loadStoredSessions(storedSessions: string, storedActiveSessionId: string | null) {
  const parsed = parseStoredSessionIndexes(storedSessions, storedActiveSessionId);
  if (!parsed) return null;
  const { readSessions, activeSessionId } = parsed;

  const sessions = await Promise.all(readSessions.map(async ({ index, legacyMessages }): Promise<ChatSession> => {
    const page = await loadSessionMessagePage(index.id, {}, legacyMessages);
    return hydrateSession(index, page.messages, true);
  }));

  cachedSessionIds = new Set(sessions.map((session) => session.id));
  return { sessions, activeSessionId };
}

async function loadStoredSessionsWithActiveOnly(
  storedSessions: string,
  storedActiveSessionId: string | null,
  activeMessageLimit?: number,
) {
  const parsed = parseStoredSessionIndexes(storedSessions, storedActiveSessionId);
  if (!parsed) return null;
  const { readSessions, activeSessionId } = parsed;
  const activeReadSession = readSessions.find(({ index }) => index.id === activeSessionId);
  const activePage = activeReadSession
    ? await loadSessionMessagePage(
        activeSessionId,
        activeMessageLimit ? { limit: activeMessageLimit } : {},
        activeReadSession.legacyMessages,
      )
    : { messages: [], startIndex: 0, totalCount: 0 };
  return {
    activeSessionId,
    sessions: readSessions.map(({ index }) => {
      if (index.id === activeSessionId) {
        return hydrateSession(
          { ...index, messageCount: Math.max(index.messageCount, activePage.totalCount) },
          activePage.messages,
          !activeMessageLimit || activePage.messages.length === activePage.totalCount,
        );
      }
      return {
        ...index,
        messages: [],
        messagesLoaded: false,
        messageCount: index.messageCount,
      };
    }),
  };
}

function summarizeLoadedChatState(state: { activeSessionId: string; sessions: ChatSession[] }) {
  return {
    activeMessageCount: state.sessions.find((session) => session.id === state.activeSessionId)?.messages.length ?? 0,
    messageCount: state.sessions.reduce((sum, session) => sum + session.messages.length, 0),
    sessionCount: state.sessions.length,
  };
}

export async function loadChatState() {
  return observeRuntimeWorkload(
    'chat.full_state_load',
    async () => {
      const stored = await ensurePrimaryChatStorage();
      return (await loadStoredSessions(stored.sessions!, stored.active))!;
    },
    summarizeLoadedChatState,
  );
}

export async function loadChatStateFast(options: { activeMessageLimit?: number } = {}) {
  return observeRuntimeWorkload(
    'chat.fast_state_load',
    async () => {
      const stored = await ensurePrimaryChatStorage();
      return (await loadStoredSessionsWithActiveOnly(stored.sessions!, stored.active, options.activeMessageLimit))!;
    },
    summarizeLoadedChatState,
  );
}

export async function loadPrimaryChatSession(options: { messageLimit?: number } = {}) {
  const state = await loadChatStateFast({ activeMessageLimit: options.messageLimit });
  return state.sessions[0];
}

export async function loadChatSessionSnapshot(
  sessionId: string,
  options: { messageLimit?: number } = {},
) {
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return null;
  await waitForPendingChatStateWrites();
  const [storedSessions, storedActiveSessionId] = await Promise.all([
    AsyncStorage.getItem(CHAT_SESSIONS_KEY),
    AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
  ]);
  if (storedSessions !== null) {
      const parsed = assertPrimaryStoredIndex(storedSessions, storedActiveSessionId);
      const target = parsed?.readSessions.find(({ index }) => index.id === sessionId);
      if (parsed && target) {
        const page = await loadSessionMessagePage(
          sessionId,
          { limit: options.messageLimit ?? 30 },
          target.legacyMessages,
        );
        const targetSession = hydrateSession(
          { ...target.index, messageCount: Math.max(target.index.messageCount, page.totalCount) },
          page.messages,
          page.messages.length === page.totalCount,
        );
        return {
          session: targetSession,
          sessions: parsed.readSessions.map(({ index }) => (
            index.id === sessionId
              ? targetSession
              : { ...index, messages: [], messagesLoaded: false, messageCount: index.messageCount }
          )),
        };
      }
  }
  return null;
}

export function getChatStorageResidencySnapshot() {
  return {
    serializedMessageRecordCount: cachedSerializedMessageRecords.size,
    serializedMessageRecordEstimatedBytes: cachedSerializedMessageRecords.estimatedBytes,
  };
}

export async function loadChatSessionMessages(sessionId: string) {
  await waitForPendingChatStateWrites();
  return (await loadSessionMessagePage(sessionId)).messages;
}

export async function hasChatSessionMessage(sessionId: string, messageId: string) {
  await waitForPendingChatStateWrites();
  const cachedOrder = getCachedMessageOrder(sessionId);
  const orderRaw = cachedOrder ? null : await AsyncStorage.getItem(getSessionMessageOrderKey(sessionId));
  const order = cachedOrder ?? readStoredMessageOrder(orderRaw);
  if (order) {
    if (!cachedOrder) cacheMessageOrder(sessionId, order);
    return order.some((entry) => entry.id === messageId);
  }
  if (sessionId === PRIMARY_CHAT_SESSION_ID) {
    if (await AsyncStorage.getItem(CHAT_SESSIONS_KEY) === null) return false;
    throw new Error('主聊天消息顺序索引缺失，不能回落旧聊天。');
  }
  const legacyRaw = await AsyncStorage.getItem(getSessionMessagesKey(sessionId));
  return readMessagesJson(legacyRaw).some((message) => message.id === messageId);
}

export async function findChatSessionContainingMessage(messageId: string) {
  await waitForPendingChatStateWrites();
  const [storedSessions, storedActiveSessionId] = await Promise.all([
    AsyncStorage.getItem(CHAT_SESSIONS_KEY),
    AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
  ]);
  if (!storedSessions) return null;
  let parsed: ReturnType<typeof parseStoredSessionIndexes>;
  try {
    parsed = parseStoredSessionIndexes(storedSessions, storedActiveSessionId);
  } catch {
    return null;
  }
  if (!parsed) return null;

  const uncachedSessions = parsed.readSessions.filter(
    ({ index }) => !cachedMessageOrders.has(index.id),
  );
  const storedOrders = new Map(await AsyncStorage.multiGet(
    uncachedSessions.map(({ index }) => getSessionMessageOrderKey(index.id)),
  ));
  const legacySessions: ReadSessionResult[] = [];
  for (const readSession of parsed.readSessions) {
    const cachedOrder = getCachedMessageOrder(readSession.index.id);
    const order = cachedOrder ?? readStoredMessageOrder(
      storedOrders.get(getSessionMessageOrderKey(readSession.index.id)) ?? null,
    );
    if (order) {
      if (!cachedOrder) cacheMessageOrder(readSession.index.id, order);
      if (order.some((entry) => entry.id === messageId)) return readSession.index.id;
    } else if (readSession.legacyMessages?.some((message) => message.id === messageId)) {
      return readSession.index.id;
    } else {
      legacySessions.push(readSession);
    }
  }

  if (!legacySessions.length) return null;
  const legacyBundles = new Map(await AsyncStorage.multiGet(
    legacySessions.map(({ index }) => getSessionMessagesKey(index.id)),
  ));
  return legacySessions.find(({ index }) => readMessagesJson(
    legacyBundles.get(getSessionMessagesKey(index.id)) ?? null,
  ).some((message) => message.id === messageId))?.index.id ?? null;
}

export async function loadChatSessionMessage(sessionId: string, messageId: string) {
  await waitForPendingChatStateWrites();
  if (sessionId === PRIMARY_CHAT_SESSION_ID && !await hasChatSessionMessage(sessionId, messageId)) return null;
  const raw = await AsyncStorage.getItem(getSessionMessageKey(sessionId, messageId));
  const message = readMessageJson(raw);
  if (sessionId === PRIMARY_CHAT_SESSION_ID && (!message || message.id !== messageId)) {
    throw new Error('主聊天消息原文缺失或损坏，不能回落旧聊天。');
  }
  if (message) {
    cachedSerializedMessageRecords.set(getSessionMessageKey(sessionId, messageId), raw!);
    return message;
  }
  const legacyRaw = await AsyncStorage.getItem(getSessionMessagesKey(sessionId));
  return readMessagesJson(legacyRaw).find((item) => item.id === messageId) ?? null;
}

/** Edit a persisted history message without bringing the history page into the live send window. */
export async function editStoredChatMessageContent(sessionId: string, messageId: string, content: string) {
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return null;
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const [sessionsRaw, activeId, orderRaw] = await Promise.all([
        AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
        AsyncStorage.getItem(getSessionMessageOrderKey(sessionId)),
      ]);
      if (sessionsRaw === null) return null;
      assertPrimaryStoredIndex(sessionsRaw, activeId);
      const order = readStoredMessageOrder(orderRaw);
      if (!order) throw new Error('主聊天消息顺序索引缺失，不能编辑历史消息。');
      if (!order.some(entry => entry.id === messageId)) return null;
      const existing = readMessageJson(await AsyncStorage.getItem(getSessionMessageKey(sessionId, messageId)));
      if (!existing || existing.id !== messageId) throw new Error('历史消息原文缺失或损坏，不能编辑。');
      const next = preserveStoredChatImageRecords({ ...existing, content }, existing);
      await writeSessionMessagesIncrementally(sessionId, [next], 'merge');
      emitChatDataChanged();
      return next;
    });
    return result.committed ? result.value : null;
  });
}

/** Queue-internal exact read: public loaders wait on this queue and must not be called here. */
async function readStoredChatImageMessage(sessionId: string, messageId: string): Promise<SubjectiveMessage | null> {
  const [sessionsRaw, activeId, orderRaw] = await Promise.all([
    AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
    AsyncStorage.getItem(getSessionMessageOrderKey(sessionId)),
  ]);
  if (sessionsRaw === null) return null;
  assertPrimaryStoredIndex(sessionsRaw, activeId);
  const order = readStoredMessageOrder(orderRaw);
  if (!order) throw new Error('chat-image-message-order-missing');
  const entry = order.find(item => item.id === messageId);
  if (!entry) return null;
  const key = getSessionMessageKey(sessionId, messageId);
  const raw = await AsyncStorage.getItem(key);
  const existing = readMessageJson(raw);
  if (!existing || existing.id !== messageId || existing.createdAt !== entry.createdAt) {
    throw new Error('chat-image-message-record-invalid');
  }
  cachedSerializedMessageRecords.set(key, raw!);
  return existing;
}

/** Patch only a still-existing image; never hydrate or recreate the original message from a snapshot. */
export async function patchStoredChatImage(
  sessionId: string,
  messageId: string,
  imageId: string,
  expectedSource: string,
  patch: Partial<MessageImage>,
  options: {
    dataEpoch: number;
    /** Runs inside the chat writer. Must not call public chat loaders or start network requests. */
    beforeCommit?: () => Promise<boolean>;
    questionSource?: { messageId: string; revision: string };
  },
): Promise<MessageImage | null> {
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return null;
  const update = { ...patch,
    ...(patch.visionAttempt ? { visionAttempt: { ...patch.visionAttempt } } : {}),
    ...(patch.visionReview ? { visionReview: { ...patch.visionReview } } : {}),
  };
  const questionSource = options.questionSource ? { ...options.questionSource } : undefined;
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(options.dataEpoch, async () => {
      if (options.beforeCommit && !await options.beforeCommit()) return null;
      const message = await readStoredChatImageMessage(sessionId, messageId);
      if (!message || message.role !== 'you') return null;
      const image = message.images?.find(item => item.id === imageId);
      if (!image || chatImageSourceRevision(message, image) !== expectedSource) return null;
      if (update.visionAttempt && image.visionAttempt) return null;
      if (update.visionReview && (!questionSource
        || update.visionReview.sourceMessageId !== questionSource.messageId
        || update.visionReview.sourceRevision !== questionSource.revision)) return null;
      if (questionSource) {
        const question = questionSource.messageId === messageId
          ? message : await readStoredChatImageMessage(sessionId, questionSource.messageId);
        if (!question || question.role !== 'you' || chatImageQuestionRevision(question) !== questionSource.revision) return null;
      }
      const next = { ...image, ...update, visionAttempt: image.visionAttempt ?? update.visionAttempt };
      if (!isMessageImage(next)) throw new Error('chat-image-observation-invalid');
      if (chatImageSourceRevision(message, next) !== expectedSource) return null;
      await writeSessionMessagesIncrementally(sessionId, [{ ...message,
        images: message.images!.map(item => item.id === imageId ? next : item),
      }], 'merge', [], true);
      emitChatDataChanged();
      return next;
    });
    return result.committed ? result.value : null;
  });
}

/** A turn keeps its one review attempt across duplicate calls, retries, stale snapshots and restart. */
export async function claimChatImageReviewAttempt(
  sessionId: string,
  messageId: string,
  expectedRevision: string,
  executionId: string,
  dataEpoch: number,
): Promise<boolean> {
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return false;
  if (!executionId.trim()) throw new Error('chat-image-review-execution-id-missing');
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const message = await readStoredChatImageMessage(sessionId, messageId);
      if (!message || message.role !== 'you' || message.chatImageReviewAttempt
        || chatImageQuestionRevision(message) !== expectedRevision) return false;
      await writeSessionMessagesIncrementally(sessionId, [{ ...message,
        chatImageReviewAttempt: { executionId, startedAt: Date.now() },
      }], 'merge', [], true);
      emitChatDataChanged();
      return true;
    });
    return result.committed ? result.value : false;
  });
}

export async function loadChatExpensePlanCard(messageId: string): Promise<ChatExpensePlanCard | null> {
  await waitForPendingChatStateWrites();
  const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId);
  return message?.role === 'I' && isChatExpensePlanCard(message.expensePlanCard) ? message.expensePlanCard : null;
}

export async function isStoredExpensePlanSourceCurrent(source: ExpensePlanSource): Promise<boolean> {
  if (source.sessionId !== PRIMARY_CHAT_SESSION_ID) return false;
  await waitForPendingChatStateWrites();
  return isExpensePlanSourceCurrent(source, await readStoredChatImageMessage(source.sessionId, source.messageId));
}

/** Only local ledger work runs here, after permission waits and inside the existing chat writer. */
export async function commitChatExpensePlanMutation(messageId: string, expectedRevision: number,
  source: ExpensePlanSource, dataEpoch: number | null,
  apply: () => Promise<ExpensePlanMutationResult>): Promise<ExpensePlanMutationResult> {
  if (source.sessionId !== PRIMARY_CHAT_SESSION_ID) return { status: 'failed', code: 'SOURCE_OR_CARD_CHANGED' };
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId);
      const card = message?.expensePlanCard;
      if (message?.role !== 'I' || !card || card.status !== 'active' || card.revision !== expectedRevision
        || JSON.stringify(card.source) !== JSON.stringify(source)
        || !isExpensePlanSourceCurrent(source, await readStoredChatImageMessage(source.sessionId, source.messageId))) {
        return { status: 'failed' as const, code: 'SOURCE_OR_CARD_CHANGED' };
      }
      return apply();
    });
    return result.committed ? result.value : { status: 'failed', code: 'RESTORE_INVALIDATED' };
  });
}

/** The existing serialized chat writer is the sole expense-card persistence path. */
export async function patchChatExpensePlanCard(messageId: string, expectedRevision: number,
  next: ChatExpensePlanCard): Promise<ChatExpensePlanCard | null> {
  if (!isChatExpensePlanCard(next) || next.revision !== expectedRevision + 1) throw new Error('expense-plan-patch-invalid');
  const update = JSON.parse(JSON.stringify(next)) as ChatExpensePlanCard;
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId);
      const current = message?.expensePlanCard;
      if (!message || message.role !== 'I' || !current || current.status !== 'active'
        || current.revision !== expectedRevision || update.status !== 'active'
        || JSON.stringify(current.source) !== JSON.stringify(update.source)
        || JSON.stringify(current.feedback) !== JSON.stringify(update.feedback)
        || current.rows.some(row => row.state === 'saved' && JSON.stringify(row) !== JSON.stringify(update.rows.find(item => item.id === row.id)))) return null;
      await writeSessionMessagesIncrementally(PRIMARY_CHAT_SESSION_ID, [{ ...message, expensePlanCard: update }], 'merge', [], false, true);
      emitChatDataChanged();
      return update;
    });
    return result.committed ? result.value : null;
  });
}

/** Consume the original turn's remaining request once, atomically on its original card. */
export async function claimChatExpensePlanFeedback(messageId: string): Promise<ChatExpensePlanCard | null> {
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId);
      const card = message?.expensePlanCard;
      if (!message || message.role !== 'I' || !card || card.status !== 'active'
        || card.feedback.claimed || card.feedback.remainingRequests <= 0
        || !card.rows.length
        || card.rows.some(row => ['pending', 'saving'].includes(row.state))
        || !isExpensePlanSourceCurrent(card.source,
          await readStoredChatImageMessage(card.source.sessionId, card.source.messageId))) return null;
      const next: ChatExpensePlanCard = { ...card, revision: card.revision + 1,
        feedback: { remainingRequests: card.feedback.remainingRequests - 1, claimed: true } };
      await writeSessionMessagesIncrementally(PRIMARY_CHAT_SESSION_ID, [{ ...message, expensePlanCard: next }], 'merge', [], false, true);
      emitChatDataChanged();
      return next;
    });
    return result.committed ? result.value : null;
  });
}

export async function loadChatReminderPlanCard(messageId: string): Promise<ChatReminderPlanCard | null> {
  await waitForPendingChatStateWrites();
  const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId);
  return message?.role === 'I' && isChatReminderPlanCard(message.reminderPlanCard) ? message.reminderPlanCard : null;
}

export async function isStoredReminderPlanSourceCurrent(source: ReminderPlanSource) {
  if (source.sessionId !== PRIMARY_CHAT_SESSION_ID) return false;
  await waitForPendingChatStateWrites();
  return isReminderPlanSourceCurrent(source, await readStoredChatImageMessage(source.sessionId, source.messageId));
}

/** No song/model/network work may run within this short existing chat commit. */
export async function commitChatReminderPlanMutation<T>(messageId: string, revision: number,
  source: ReminderPlanSource, dataEpoch: number | null, apply: () => Promise<T>): Promise<T> {
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
      const card = (await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId))?.reminderPlanCard;
      if (!card || card.status !== 'active' || card.revision !== revision || source.sessionId !== PRIMARY_CHAT_SESSION_ID
        || JSON.stringify(card.source) !== JSON.stringify(source)
        || !isReminderPlanSourceCurrent(source, await readStoredChatImageMessage(source.sessionId, source.messageId))) throw new Error('SOURCE_OR_CARD_CHANGED');
      return apply();
    });
    if (!result.committed) throw new Error('RESTORE_INVALIDATED');
    return result.value;
  });
}

export async function patchChatReminderPlanCard(messageId: string, revision: number, next: ChatReminderPlanCard) {
  if (!isChatReminderPlanCard(next) || next.revision !== revision + 1) throw new Error('REMINDER_CARD_INVALID');
  const frozen = JSON.parse(JSON.stringify(next)) as ChatReminderPlanCard;
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId);
      const card = message?.reminderPlanCard;
      if (!message || !card || card.status !== 'active' || frozen.status !== 'active' || card.revision !== revision
        || JSON.stringify(card.source) !== JSON.stringify(frozen.source) || JSON.stringify(card.feedback) !== JSON.stringify(frozen.feedback)
        || card.rows.some(row => row.state === 'saved' && JSON.stringify(row) !== JSON.stringify(frozen.rows.find(item => item.id === row.id)))) return null;
      await writeSessionMessagesIncrementally(PRIMARY_CHAT_SESSION_ID, [{ ...message, reminderPlanCard: frozen }], 'merge', [], false, true);
      emitChatDataChanged(); return frozen;
    });
    return result.committed ? result.value : null;
  });
}

export async function claimChatReminderPlanFeedback(messageId: string) {
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const message = await readStoredChatImageMessage(PRIMARY_CHAT_SESSION_ID, messageId); const card = message?.reminderPlanCard;
      if (!message || !card || card.status !== 'active' || card.feedback.claimed || card.feedback.remainingRequests !== 1
        || !card.rows.length || card.rows.some(row => ['pending', 'saving'].includes(row.state))
        || !isReminderPlanSourceCurrent(card.source, await readStoredChatImageMessage(card.source.sessionId, card.source.messageId))) return null;
      const next: ChatReminderPlanCard = { ...card, revision: card.revision + 1, feedback: { remainingRequests: 0, claimed: true } };
      await writeSessionMessagesIncrementally(PRIMARY_CHAT_SESSION_ID, [{ ...message, reminderPlanCard: next }], 'merge', [], false, true);
      emitChatDataChanged(); return next;
    });
    return result.committed ? result.value : null;
  });
}

/** Called only after the complete reply save succeeds; mark its bubbles without rewriting their bodies. */
export async function recordTheaterBackstageReplySource(
  sessionId: string,
  replyMessageIds: readonly string[],
  source: TheaterBackstageMessageSource,
): Promise<SubjectiveMessage[]> {
  assertPrimaryChatSessionId(sessionId);
  if (!isTheaterBackstageMessageSource(source) || !replyMessageIds.length
    || replyMessageIds.some(id => typeof id !== 'string' || !id.trim())
    || new Set(replyMessageIds).size !== replyMessageIds.length) {
    throw new Error('幕后回复来源或消息编号无效。');
  }
  const ids = [...replyMessageIds];
  const receipt = { ...source };
  const epoch = captureBackupRestoreDataEpoch();
  return enqueueChatStateWrite(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const [sessionsRaw, activeId, orderRaw] = await Promise.all([
        AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
        AsyncStorage.getItem(getSessionMessageOrderKey(sessionId)),
      ]);
      if (sessionsRaw === null) throw new Error('主聊天尚未保存，不能记录幕后回复来源。');
      assertPrimaryStoredIndex(sessionsRaw, activeId);
      const order = readStoredMessageOrder(orderRaw);
      const byId = new Map(order?.map(entry => [entry.id, entry]));
      const entries = ids.map(id => byId.get(id));
      if (entries.some(entry => !entry)) throw new Error('完整回复尚未保存，不能记录幕后来源。');
      const messages = await loadMessageRecords(sessionId, entries as ChatStoredMessageOrderEntry[]);
      for (const message of messages) {
        if (message.role !== 'I') throw new Error('幕后来源只能关联完整的 I 回复。');
        if (message.theaterBackstage && Object.keys(receipt).some(key => (
          message.theaterBackstage![key as keyof TheaterBackstageMessageSource] !== receipt[key as keyof TheaterBackstageMessageSource]
        ))) throw new Error('幕后回复已绑定其他来源，不能覆盖。');
      }
      const next = messages.map(({ theaterBackstagePending: _pending, ...message }) => ({ ...message, theaterBackstage: receipt }));
      const missing = next.filter((_, index) => !messages[index].theaterBackstage || messages[index].theaterBackstagePending);
      if (!missing.length) return next;
      await writeSessionMessagesIncrementally(sessionId, missing, 'merge');
      emitChatDataChanged();
      return next;
    });
    if (!result.committed) throw new Error('备份恢复已使本次幕后回复来源提交失效。');
    return result.value;
  });
}

/** Metadata only; page offsets use this same stored order, including equal timestamps. */
export async function loadChatSessionMessageOrder(sessionId: string, options: { strict?: boolean } = {}) {
  await waitForPendingChatStateWrites();
  const cached = getCachedMessageOrder(sessionId);
  if (cached) return cached;
  const order = readStoredMessageOrder(await AsyncStorage.getItem(getSessionMessageOrderKey(sessionId)));
  if (order) {
    cacheMessageOrder(sessionId, order);
    return order;
  }
  if (options.strict) throw new Error(`chat_message_order_missing:${sessionId}`);
  return toStoredMessageOrder((await loadSessionMessagePage(sessionId)).messages);
}

/** Highest persisted use number; the active card keeps its local high-water mark after deletion. */
export async function loadTheaterBackstageUsedCount(batchId: string): Promise<number> {
  await waitForPendingChatStateWrites();
  if (!batchId.trim()) return 0;
  const order = readStoredMessageOrder(await AsyncStorage.getItem(getSessionMessageOrderKey(PRIMARY_CHAT_SESSION_ID)));
  if (!order) {
    if (await AsyncStorage.getItem(CHAT_SESSIONS_KEY) === null) return 0;
    throw new Error('主聊天消息顺序索引缺失，不能读取幕后回复次数。');
  }
  const replies = new Map<string, { batchId: string; useNumber: number }>();
  let usedCount = 0;
  for (let offset = 0; offset < order.length; offset += CHAT_MESSAGE_MIGRATION_BATCH_SIZE) {
    const messages = await loadMessageRecords(PRIMARY_CHAT_SESSION_ID, order.slice(offset, offset + CHAT_MESSAGE_MIGRATION_BATCH_SIZE));
    for (const message of messages) {
      if (message.role === 'I' && message.theaterBackstage) {
        const source = message.theaterBackstage;
        const previous = replies.get(source.replyId);
        if (previous && (previous.batchId !== source.batchId || previous.useNumber !== source.useNumber)) {
          throw new Error('同一幕后回复批的来源批次或使用序号不一致。');
        }
        replies.set(source.replyId, source);
        if (!message.theaterBackstagePending && source.batchId === batchId) usedCount = Math.max(usedCount, source.useNumber);
      }
    }
  }
  return usedCount;
}

export async function loadChatSessionMessagePage(
  sessionId: string,
  options: { limit: number; beforeIndex?: number; waitForPendingWrites?: boolean },
) {
  if (options.waitForPendingWrites !== false) {
    await waitForPendingChatStateWrites();
  }
  return loadSessionMessagePage(sessionId, {
    beforeIndex: options.beforeIndex,
    limit: options.limit,
  });
}

async function saveChatStateNow(
  sessions: ChatSession[],
  activeSessionId: string,
  options: {
    messageSessionIds?: Set<string>;
    preserveActiveSessionId?: boolean;
    removedSessionIds?: readonly string[];
    discardPendingReply?: boolean;
  } = {},
) {
  assertPrimaryChatSessionId(activeSessionId);
  sessions.forEach(session => assertPrimaryChatSessionId(session.id));
  if (sessions.length !== 1 || options.removedSessionIds?.includes(PRIMARY_CHAT_SESSION_ID)) {
    throw new Error('主聊天必须保留唯一记录，不能删除后自动重建。');
  }
  const [storedSessionsRaw, storedActiveSessionId] = await Promise.all([
    AsyncStorage.getItem(CHAT_SESSIONS_KEY),
    AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
  ]);
  const removedSessionIds = new Set(options.removedSessionIds ?? []);
  let providedSessions = sessions.filter((session) => !removedSessionIds.has(session.id));
  const providedSessionIds = new Set(providedSessions.map((session) => session.id));
  const retainedStoredSessionIndexes: unknown[] = [];
  const storedSessionIndexesById = new Map<string, unknown>();
  if (storedSessionsRaw !== null) {
      assertPrimaryStoredIndex(storedSessionsRaw, storedActiveSessionId);
      const storedValues = JSON.parse(storedSessionsRaw) as unknown;
      if (Array.isArray(storedValues)) {
        storedValues.forEach((value) => {
          const read = readSessionIndex(value);
          if (read) storedSessionIndexesById.set(read.index.id, value);
          if (
            read
            && !providedSessionIds.has(read.index.id)
            && !removedSessionIds.has(read.index.id)
          ) {
            retainedStoredSessionIndexes.push(value);
          }
        });
      }
  } else {
    const keys = await RawAsyncStorage.getAllKeys();
    if (providedSessions.some(session => session.messages.length > 0 || (session.messageCount ?? 0) > 0)
      || storedActiveSessionId !== null || keys.some(key => key === CHAT_MESSAGES_KEY
        || key === CHAT_MEMORY_ORGANIZED_THROUGH_KEY || key.startsWith(CHAT_SESSION_MESSAGE_PREFIX)
        || key.startsWith(CHAT_SESSION_MESSAGE_ORDER_PREFIX) || key.startsWith(CHAT_SESSION_MESSAGES_PREFIX))) {
      throw new Error('主聊天索引缺失且仍有旧聊天数据，不能用待保存内容重新建立会话。');
    }
  }
  // An older UI snapshot must not lend a newer correction receipt to old prose.
  // Explicit rewrites use commitChatContextCompressionState before updating the UI.
  providedSessions = providedSessions.map(session => {
    const stored = readSessionIndex(storedSessionIndexesById.get(session.id))?.index.contextCompression;
    return { ...session, contextCompression: protectChatSummaryAutosave(stored, session.contextCompression) };
  });
  const messageSessionIds = options.messageSessionIds ?? new Set([activeSessionId]);
  for (const session of providedSessions) {
    if (session.messagesLoaded === false || !messageSessionIds.has(session.id)) continue;
    if (options.discardPendingReply) await discardPendingChatReplyDraftNow(session.id);
    await writeSessionMessagesIncrementally(session.id, session.messages, 'replace');
  }
  const providedSessionIndexesById = new Map(
    providedSessions.map((session) => [session.id, toSessionIndex(session)] as const),
  );
  const sessionIndex: unknown[] = options.preserveActiveSessionId && storedSessionIndexesById.size
    ? [
        ...[...storedSessionIndexesById.entries()]
          .filter(([sessionId]) => !removedSessionIds.has(sessionId))
          .map(([sessionId, storedIndex]) => providedSessionIndexesById.get(sessionId) ?? storedIndex),
        ...providedSessions
          .filter((session) => !storedSessionIndexesById.has(session.id))
          .map(toSessionIndex),
      ]
    : [
        ...providedSessions.map(toSessionIndex),
        ...retainedStoredSessionIndexes,
      ];
  const nextSessionIds = new Set(
    sessionIndex
      .map(readSessionIndex)
      .filter((read): read is ReadSessionResult => !!read)
      .map(({ index }) => index.id),
  );
  const nextActiveSessionId = options.preserveActiveSessionId
    && storedActiveSessionId
    && nextSessionIds.has(storedActiveSessionId)
      ? storedActiveSessionId
      : nextSessionIds.has(activeSessionId)
        ? activeSessionId
        : storedActiveSessionId && nextSessionIds.has(storedActiveSessionId)
          ? storedActiveSessionId
          : providedSessions[0]?.id;
  if (!nextActiveSessionId) return;

  await AsyncStorage.multiSet([
    [CHAT_SESSIONS_KEY, JSON.stringify(sessionIndex)],
    [ACTIVE_CHAT_SESSION_KEY, nextActiveSessionId],
  ]);

  for (const sessionId of removedSessionIds) {
    await removeSessionMessageStorage(sessionId);
  }
  cachedSessionIds = nextSessionIds;
  emitChatDataChanged();
}

export async function saveChatState(
  sessions: ChatSession[],
  activeSessionId: string,
  options: {
    preserveActiveSessionId?: boolean;
    removedSessionIds?: readonly string[];
    discardPendingReply?: boolean;
  } = {},
) {
  const snapshot = retainChatSessionWriteSnapshots(sessions);
  return enqueueChatStateWrite(async () => {
    await saveChatStateNow(snapshot.sessions, activeSessionId, options);
  }).finally(() => snapshot.release());
}

export async function saveActiveChatSessionId(activeSessionId: string) {
  assertPrimaryChatSessionId(activeSessionId);
  return enqueueChatStateWrite(async () => {
    const storedSessions = await AsyncStorage.getItem(CHAT_SESSIONS_KEY);
    if (!storedSessions) throw new Error('主聊天尚未建立，不能写入当前聊天标识。');
    assertPrimaryStoredIndex(storedSessions, activeSessionId);
    await AsyncStorage.setItem(ACTIVE_CHAT_SESSION_KEY, activeSessionId);
  });
}

/** Sync session fields never replace message bodies or unrelated session metadata. */
export async function patchChatSessionFields(
  sessionId: string,
  fields: Partial<Pick<ChatSession, 'title' | 'customTitle' | 'createdAt' | 'updatedAt'>>,
  options: { syncOrigin?: 'remote' } = {},
) {
  assertPrimaryChatSessionId(sessionId);
  await ensurePrimaryChatStorage();
  const writeStorage = options.syncOrigin === 'remote' ? chatStorageSyncReplayBridge : AsyncStorage;
  return enqueueChatStateWrite(async () => {
    const [raw, active] = await Promise.all([
      AsyncStorage.getItem(CHAT_SESSIONS_KEY), AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
    ]);
    if (raw === null) throw new Error('chat-session-fields-session-missing');
    assertPrimaryStoredIndex(raw, active);
    const indexes = JSON.parse(raw) as Array<Record<string, unknown>>;
    await writeStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(indexes.map(index => (
      index.id === sessionId ? { ...index, ...fields } : index
    ))));
    emitChatDataChanged();
  });
}

export async function appendMessagesToChatSession(
  sessionId: string,
  additions: SubjectiveMessage[],
  _options: { activeSessionId?: string | null; requireActiveSession?: boolean; beforeAppend?: (messages: SubjectiveMessage[]) => Promise<boolean>; dataEpoch?: number } = {},
): Promise<{ messages: SubjectiveMessage[]; session: ChatSession | null }> {
  let savedMessages: SubjectiveMessage[] = [];
  let savedSession: ChatSession | null = null;
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return { messages: savedMessages, session: savedSession };
  if (!additions.length) {
    return { messages: savedMessages, session: savedSession };
  }

  await enqueueChatMessageSnapshotWrite(sessionId, additions, async additions => {
    const write = async () => {
      const [storedSessions, storedActiveSessionId] = await Promise.all([
        AsyncStorage.getItem(CHAT_SESSIONS_KEY),
        AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
      ]);
      if (storedSessions === null) return;
      if (_options.requireActiveSession && storedActiveSessionId !== sessionId) return;
      const parsed = assertPrimaryStoredIndex(storedSessions, storedActiveSessionId);
      const targetReadSession = parsed.readSessions.find(({ index }) => index.id === sessionId);
      if (!targetReadSession) return;
      const targetMessages = (await loadSessionMessagePage(
        sessionId,
        {},
        targetReadSession.legacyMessages,
      )).messages;
      const targetSession = hydrateSession(targetReadSession.index, targetMessages, true);

      if (_options.beforeAppend && !await _options.beforeAppend(targetMessages)) return;

      const nextMessages = mergeSubjectiveMessages([...targetSession.messages, ...additions], targetSession.messages);
      const nextSession = updateChatSession(
        targetSession,
        nextMessages,
        targetSession.memoryOrganizedThroughId,
        targetSession.proactiveMemoryReviewedThroughId,
      );
      await writeSessionMessagesIncrementally(sessionId, additions, 'merge', targetReadSession.legacyMessages);
      const rawSessionIndexes = JSON.parse(storedSessions) as unknown;
      if (!Array.isArray(rawSessionIndexes)) return;
      const nextSessionIndexes = rawSessionIndexes.map((value) => {
        const read = readSessionIndex(value);
        return read?.index.id === sessionId ? toSessionIndex(nextSession) : value;
      });

      await AsyncStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(nextSessionIndexes));
      cachedSessionIds = new Set(parsed.readSessions.map(({ index }) => index.id));
      savedMessages = nextMessages;
      savedSession = nextSession;
      emitChatDataChanged();
    };
    if (_options.dataEpoch === undefined) await write();
    else await runBackupRestoreDataEpochCommit(_options.dataEpoch, write);
  });
  return { messages: savedMessages, session: savedSession };
}

export async function replaceChatSessionMessages(
  sessionId: string,
  messagesOrUpdate: SubjectiveMessage[] | ((current: SubjectiveMessage[]) => SubjectiveMessage[]),
  _options: { activeSessionId?: string | null; syncOrigin?: 'remote'; deletedMessageIds?: readonly string[] } = {},
) {
  let savedSession: ChatSession | null = null;
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return null;
  const writeStorage = _options.syncOrigin === 'remote' ? chatStorageSyncReplayBridge : AsyncStorage;

  await enqueueChatStateWrite(async () => {
    if (_options.deletedMessageIds?.length) {
      const sleepDraft = readSleepReplyDraft(await RawAsyncStorage.getItem(SLEEP_REPLY_DRAFT_KEY));
      if (sleepDraft?.sessionId === sessionId && _options.deletedMessageIds.includes(sleepDraft.message.id)) {
        await RawAsyncStorage.removeItem(SLEEP_REPLY_DRAFT_KEY);
      }
      const pending = await readPendingChatReplyDraftNow(sessionId);
      if (pending) {
        const affected = new Set([pending.source.messageId, ...pending.turnSources.map(ref => ref.messageId),
          ...pending.messages.map(message => message.id)]);
        if (_options.deletedMessageIds.some(id => affected.has(id))) {
          await discardPendingChatReplyDraftNow(sessionId, pending.replyId);
        }
      }
    }
    const [storedSessions, storedActiveSessionId] = await Promise.all([
      AsyncStorage.getItem(CHAT_SESSIONS_KEY),
      AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
    ]);
    if (storedSessions === null) return;
    const parsed = assertPrimaryStoredIndex(storedSessions, storedActiveSessionId);
    const targetReadSession = parsed.readSessions.find(({ index }) => index.id === sessionId);
    if (!targetReadSession) return;
    // Read-modify-write callers resolve their change only after owning the chat queue.
    const currentMessages = typeof messagesOrUpdate === 'function'
      ? (await loadSessionMessagePage(sessionId, {}, targetReadSession.legacyMessages)).messages
      : undefined;
    const messages = typeof messagesOrUpdate === 'function'
      ? messagesOrUpdate(currentMessages!) : messagesOrUpdate;
    const keptIds = new Set(messages.map(message => message.id));
    const deletedMessageIds = [...new Set(_options.deletedMessageIds ?? [])].filter(id => !keptIds.has(id));
    const publishDeletion = () => {
      invalidateChatMessageWriteSnapshots(sessionId, deletedMessageIds);
      emitChatDataChanged('write', { sessionId, deletedMessageIds, messageCount: messages.length });
    };
    if (currentMessages && messages === currentMessages) {
      if (deletedMessageIds.length) publishDeletion();
      return;
    }
    const targetSession = hydrateSession(targetReadSession.index, [], true);

    const nextSession = updateChatSession(
      targetSession,
      messages,
      targetSession.memoryOrganizedThroughId,
      targetSession.proactiveMemoryReviewedThroughId,
    );
    await writeSessionMessagesIncrementally(sessionId, messages, 'replace', targetReadSession.legacyMessages, false, false, writeStorage);
    const rawSessionIndexes = JSON.parse(storedSessions) as unknown;
    if (!Array.isArray(rawSessionIndexes)) return;
    const nextSessionIndexes = rawSessionIndexes.map((value) => {
      const read = readSessionIndex(value);
      return read?.index.id === sessionId ? toSessionIndex(nextSession) : value;
    });

    await writeStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(nextSessionIndexes));
    cachedSessionIds = new Set(parsed.readSessions.map(({ index }) => index.id));
    savedSession = nextSession;
    if (deletedMessageIds.length) publishDeletion();
    else emitChatDataChanged();
  });
  return savedSession;
}

export async function mergeAndSaveChatSessionMessages(
  sessionId: string,
  messages: SubjectiveMessage[],
  options: {
    activeSessionId?: string | null;
    syncOrigin?: 'remote';
    contextCompression?: ChatContextCompressionState;
    summaryWriteMode?: 'sync' | 'reset';
    memoryOrganizedThroughId?: string | null;
    proactiveMemoryReviewedThroughId?: string | null;
    chatImageSources?: import('./chatImageRecord').ChatImageCardSources;
  } = {},
) {
  let savedSession: ChatSession | null = null;
  if (sessionId !== PRIMARY_CHAT_SESSION_ID) return null;
  const writeStorage = options.syncOrigin === 'remote' ? chatStorageSyncReplayBridge : AsyncStorage;
  await enqueueChatMessageSnapshotWrite(sessionId, messages, async messages => {
    const orderKey = getSessionMessageOrderKey(sessionId);
    const [storedSessions, storedActiveSessionId, orderRaw] = await Promise.all([
      AsyncStorage.getItem(CHAT_SESSIONS_KEY),
      AsyncStorage.getItem(ACTIVE_CHAT_SESSION_KEY),
      AsyncStorage.getItem(orderKey),
    ]);
    if (storedSessions === null) return;
    const parsed = assertPrimaryStoredIndex(storedSessions, storedActiveSessionId);
    const targetReadSession = parsed.readSessions.find(({ index }) => index.id === sessionId);
    if (!targetReadSession) return;

    // This runs in the same chat queue as deletion, including far-away quoted images.
    if (options.chatImageSources) {
      const sources = options.chatImageSources;
      for (const source of [sources.question, ...sources.reviewQuestions]) {
        const question = await readStoredChatImageMessage(sessionId, source.messageId);
        if (!question || chatImageQuestionRevision(question) !== source.revision) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
      }
      for (const source of sources.images) {
        const message = await readStoredChatImageMessage(sessionId, source.messageId);
        const image = message?.images?.find(item => item.id === source.imageId);
        if (!message || !image || chatImageSourceRevision(message, image) !== source.revision) throw new Error('CHAT_IMAGE_SOURCE_CHANGED');
      }
      if (sources.existingCardId && !await readStoredChatImageMessage(sessionId, sources.existingCardId)) throw new Error('CHAT_IMAGE_CARD_DELETED');
    }

    const storedOrder = readStoredMessageOrder(orderRaw);
    const nextOrder = storedOrder
      ? mergeStoredMessageOrder(storedOrder, messages)
      : await writeSessionMessagesIncrementally(
          sessionId,
          messages,
          'merge',
          targetReadSession.legacyMessages,
          false, false, writeStorage,
        );
    const targetIndex = targetReadSession.index;
    const nextSession: ChatSession = {
      ...targetIndex,
      title: targetIndex.customTitle || targetIndex.title !== '新的对话'
        ? targetIndex.title
        : deriveSessionTitle(messages),
      messages,
      messagesLoaded: false,
      messageCount: nextOrder.length,
      memoryOrganizedThroughId: options.memoryOrganizedThroughId === undefined
        ? targetIndex.memoryOrganizedThroughId
        : options.memoryOrganizedThroughId,
      proactiveMemoryReviewedThroughId: options.proactiveMemoryReviewedThroughId === undefined
        ? targetIndex.proactiveMemoryReviewedThroughId
        : options.proactiveMemoryReviewedThroughId,
      contextCompression: options.summaryWriteMode === 'reset' ? options.contextCompression
        : options.summaryWriteMode === 'sync' && options.contextCompression
          ? mergeChatSummaryCorrectionState(targetIndex.contextCompression, options.contextCompression)
          : protectChatSummaryAutosave(targetIndex.contextCompression, options.contextCompression),
      updatedAt: nextOrder[nextOrder.length - 1]?.createdAt ?? targetIndex.updatedAt,
    };
    const rawSessionIndexes = JSON.parse(storedSessions) as unknown;
    if (!Array.isArray(rawSessionIndexes)) return;
    const nextSessionIndexes = rawSessionIndexes.map((value) => {
      const read = readSessionIndex(value);
      return read?.index.id === sessionId ? toSessionIndex(nextSession) : value;
    });

    if (storedOrder) {
      const existingIds = new Set(storedOrder.map(({ id }) => id));
      const candidateByKey = new Map<string, { id: string; serialized: string }>();
      for (const message of messages) {
        candidateByKey.set(
          getSessionMessageKey(sessionId, message.id),
          { id: message.id, serialized: JSON.stringify(stripRetiredActionMetadata(message)) },
        );
      }
      const keysToRead = [...candidateByKey.entries()]
        .filter(([key, candidate]) => existingIds.has(candidate.id) && !cachedSerializedMessageRecords.has(key))
        .map(([key]) => key);
      if (keysToRead.length) {
        const storedRecords = await AsyncStorage.multiGet(keysToRead);
        storedRecords.forEach(([key, raw]) => {
          if (raw != null) cachedSerializedMessageRecords.set(key, raw);
        });
      }
      const messageEntries: [string, string][] = [];
      candidateByKey.forEach(({ serialized }, key) => {
        serialized = preserveStoredReadingReference(serialized, cachedSerializedMessageRecords.get(key));
        if (cachedSerializedMessageRecords.get(key) !== serialized) messageEntries.push([key, serialized]);
      });
      await invalidatePendingChatReplyDraftForWrite(sessionId, existingIds, nextOrder, messageEntries);
      const nextOrderRaw = serializeStoredMessageOrder(nextOrder);
      const captureEntries: [string, string][] = [
        ...(orderRaw === nextOrderRaw ? [] : [[orderKey, nextOrderRaw] as [string, string]]),
        ...messageEntries,
        [CHAT_SESSIONS_KEY, JSON.stringify(nextSessionIndexes)],
      ];
      await writeStorage.multiSet(captureEntries);
      messageEntries.forEach(([key, value]) => cachedSerializedMessageRecords.set(key, value));
      if (cachedMessageOrders.has(sessionId)) cacheMessageOrder(sessionId, nextOrder);
    } else {
      await writeStorage.setItem(CHAT_SESSIONS_KEY, JSON.stringify(nextSessionIndexes));
    }
    cachedSessionIds = new Set(parsed.readSessions.map(({ index }) => index.id));
    savedSession = nextSession;
    emitChatDataChanged();
  }, options.syncOrigin !== 'remote');
  return savedSession;
}
