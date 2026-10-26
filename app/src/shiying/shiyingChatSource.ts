import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  loadChatSessionMessagePage,
  loadChatStateFast,
  type ChatMessagePage,
} from '../chat/chatStorage';
import {
  assertShiyingHash,
  createShiyingMessageContentHash,
  type ShiyingMessageCursorV1,
  type ShiyingRole,
} from './shiyingContract';
import {
  getShiyingCoverageKnowledge,
  type ShiyingCoverageKnowledgeV1,
} from './shiyingStore';
import {
  compareShiyingMessageCursor,
  deriveShiyingWindowBoundary,
  addShiyingLifeDates,
  getShiyingLifeDate,
  getShiyingLifeDateStartAt,
  getShiyingRecentLifeDateStart,
} from './shiyingWindow';

const SHIYING_CHAT_PAGE_SIZE = 100;
const SHIYING_CARD_FRAGMENT_LIMIT = 12;
const SHIYING_CARD_TEXT_LIMIT = 1_200;
const SHIYING_MESSAGE_TEXT_LIMIT = 20_000;
const SHIYING_MESSAGE_TEXT_EDGE_LENGTH = 10_000;

export type ShiyingChatMaterialV1 = {
  sessionId: string;
  messageId: string;
  role: ShiyingRole;
  messageCreatedAt: number;
  text: string;
  textKind: 'message_text' | 'voice_transcript' | 'message_with_core_card_context';
  textTruncated: boolean;
  contentHash: string;
};

export type ShiyingMaterialWindowV1 = {
  triggeredAt: number;
  lifeDateStart: string;
  lifeDateEnd: string;
  scanFloorAt: number;
  windowStartCursor: ShiyingMessageCursorV1 | null;
  windowEndCursor: ShiyingMessageCursorV1 | null;
  historyGapBeforeLifeDate: string | null;
  latestDurableMessageAt: number | null;
  latestEligibleYouAt: number | null;
  uncoveredYouCount: number;
  messages: ShiyingChatMaterialV1[];
  skipped: {
    failedYou: number;
    unavailableVoiceTranscript: number;
    attachmentOnlyOrBlank: number;
  };
};

export type ShiyingChatReadPort = {
  loadStateFast(): Promise<{
    sessions: Array<{
      id: string;
      messageCount?: number;
    }>;
  }>;
  loadMessagePage(
    sessionId: string,
    options: { limit: number; beforeIndex: number; waitForPendingWrites: false },
  ): Promise<ChatMessagePage>;
};

type ShiyingChatSnapshot = {
  sessions: Array<{ sessionId: string; messageCount: number }>;
};

type ShiyingSkippedReason = keyof ShiyingMaterialWindowV1['skipped'];

export type ShiyingChatMessageProjection = {
  material: ShiyingChatMaterialV1 | null;
  skippedReason: ShiyingSkippedReason | null;
};

type ShiyingMaterialWindowDependencies = {
  chatPort?: ShiyingChatReadPort;
  loadCoverageKnowledge?: typeof getShiyingCoverageKnowledge;
};

const defaultChatPort: ShiyingChatReadPort = {
  loadStateFast: () => loadChatStateFast({ activeMessageLimit: 1 }),
  loadMessagePage: (sessionId, options) => loadChatSessionMessagePage(sessionId, options),
};

function chatReadError(code: string, sessionId?: string, pageIndex?: number): never {
  const details = [sessionId, pageIndex].filter((value) => value !== undefined).join(':');
  throw new Error(details ? `shiying_chat_read_${code}:${details}` : `shiying_chat_read_${code}`);
}

function assertSafeTimestamp(value: number, code: string, sessionId?: string, pageIndex?: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    chatReadError(code, sessionId, pageIndex);
  }
}

function assertTechnicalId(value: string, code: string, sessionId?: string, pageIndex?: number) {
  if (!value || value.length > 512 || value !== value.trim()) {
    chatReadError(code, sessionId, pageIndex);
  }
}

function stableTextOrder(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeCoreFragment(value: string) {
  return value.trim().replace(/\s+/gu, ' ');
}

function limitCoreCardFragments(candidates: readonly string[]) {
  const fragments: string[] = [];
  const seen = new Set<string>();
  let usedLength = 0;
  for (const candidate of candidates) {
    if (fragments.length >= SHIYING_CARD_FRAGMENT_LIMIT || usedLength >= SHIYING_CARD_TEXT_LIMIT) {
      break;
    }
    const normalized = normalizeCoreFragment(candidate);
    if (!normalized || seen.has(normalized)) continue;
    const separatorLength = fragments.length ? 1 : 0;
    const remaining = SHIYING_CARD_TEXT_LIMIT - usedLength - separatorLength;
    const fragment = normalized.slice(0, remaining);
    if (!fragment) break;
    fragments.push(fragment);
    seen.add(normalized);
    usedLength += separatorLength + fragment.length;
  }
  return fragments;
}

function collectCoreCardFragments(message: SubjectiveMessage) {
  const candidates: string[] = [];

  for (const card of message.toolCallCards ?? []) {
    const terminal = card.status === 'success'
      || card.status === 'error'
      || card.status === 'permission_denied'
      || card.status === 'cancelled'
      || card.status === 'outcome_unknown';
    if (terminal && card.resultSummary?.trim()) {
      candidates.push(`工具结果：${card.resultSummary}`);
    } else if (
      (card.status === 'error'
        || card.status === 'permission_denied'
        || card.status === 'cancelled')
      && card.errorMessage?.trim()
    ) {
      candidates.push(`工具错误：${card.errorMessage}`);
    }
  }

  const musicCards = message.musicCards?.length
    ? message.musicCards
    : message.musicCard
      ? [message.musicCard]
      : [];
  const primarySong = musicCards.find((card) => card.status === 'ready' && card.song)?.song;
  if (primarySong) {
    candidates.push(
      `歌曲：${primarySong.name}｜歌手：${primarySong.artist}｜专辑：${primarySong.album}`,
    );
  }

  if (message.goalTimeCreditCard) {
    const card = message.goalTimeCreditCard;
    candidates.push(
      `目标：${card.todoTitle}｜分钟：${card.suggestedMinutes}`
      + (card.reason.trim() ? `｜原因：${card.reason}` : ''),
    );
  }

  if (message.scheduleChangeCard) {
    const card = message.scheduleChangeCard;
    candidates.push(
      `日程变更：${card.title}｜之前：${card.before}`
      + (card.after?.trim() ? `｜之后：${card.after}` : ''),
    );
  }

  if (message.schedulePlanCard) {
    candidates.push(`日程计划日期：${message.schedulePlanCard.plan.dateKey}`);
    for (const task of message.schedulePlanCard.plan.tasks) {
      candidates.push(`日程任务：${task.title}`);
    }
  }

  return limitCoreCardFragments(candidates);
}

function truncateMaterialText(text: string) {
  if (text.length <= SHIYING_MESSAGE_TEXT_LIMIT) {
    return { text, textTruncated: false };
  }
  return {
    text: text.slice(0, SHIYING_MESSAGE_TEXT_EDGE_LENGTH)
      + text.slice(-SHIYING_MESSAGE_TEXT_EDGE_LENGTH),
    textTruncated: true,
  };
}

function materialFromText(input: {
  sessionId: string;
  message: SubjectiveMessage;
  text: string;
  textKind: ShiyingChatMaterialV1['textKind'];
}): ShiyingChatMaterialV1 {
  const truncated = truncateMaterialText(input.text);
  return {
    sessionId: input.sessionId,
    messageId: input.message.id,
    role: input.message.role,
    messageCreatedAt: input.message.createdAt,
    text: truncated.text,
    textKind: input.textKind,
    textTruncated: truncated.textTruncated,
    contentHash: createShiyingMessageContentHash({
      role: input.message.role,
      content: truncated.text,
    }),
  };
}

export function projectShiyingChatMessage(
  sessionId: string,
  message: SubjectiveMessage,
): ShiyingChatMessageProjection {
  assertTechnicalId(sessionId, 'session_id_invalid');
  assertTechnicalId(message.id, 'message_id_invalid', sessionId);
  assertSafeTimestamp(message.createdAt, 'message_time_invalid', sessionId);
  if (message.role !== 'I' && message.role !== 'you') {
    chatReadError('message_role_invalid', sessionId);
  }
  if (typeof message.content !== 'string') chatReadError('message_content_missing', sessionId);

  if (message.role === 'you') {
    if (message.deliveryStatus === 'failed') {
      return { material: null, skippedReason: 'failedYou' };
    }
    if (message.voice) {
      if (
        message.voice.transcriptionStatus !== 'ready'
        || !message.voice.transcript?.trim()
      ) {
        return { material: null, skippedReason: 'unavailableVoiceTranscript' };
      }
      return {
        material: materialFromText({
          sessionId,
          message,
          text: message.voice.transcript.trim(),
          textKind: 'voice_transcript',
        }),
        skippedReason: null,
      };
    }
    if (!message.content.trim()) {
      return { material: null, skippedReason: 'attachmentOnlyOrBlank' };
    }
    return {
      material: materialFromText({
        sessionId,
        message,
        text: message.content.trim(),
        textKind: 'message_text',
      }),
      skippedReason: null,
    };
  }

  const mainText = message.content.trim();
  const coreCardFragments = collectCoreCardFragments(message);
  const text = [mainText, ...coreCardFragments].filter(Boolean).join('\n');
  if (!text) return { material: null, skippedReason: 'attachmentOnlyOrBlank' };
  return {
    material: materialFromText({
      sessionId,
      message,
      text,
      textKind: coreCardFragments.length
        ? 'message_with_core_card_context'
        : 'message_text',
    }),
    skippedReason: null,
  };
}

function captureChatSnapshot(port: ShiyingChatReadPort): Promise<ShiyingChatSnapshot> {
  return port.loadStateFast().then((state) => {
    if (!state || !Array.isArray(state.sessions)) chatReadError('session_index_invalid');
    const seen = new Set<string>();
    const sessions = state.sessions.map((session) => {
      if (!session || typeof session.id !== 'string') chatReadError('session_index_invalid');
      assertTechnicalId(session.id, 'session_id_invalid');
      if (seen.has(session.id)) chatReadError('session_duplicate', session.id);
      seen.add(session.id);
      if (!Number.isSafeInteger(session.messageCount) || session.messageCount! < 0) {
        chatReadError('session_message_count_invalid', session.id);
      }
      return { sessionId: session.id, messageCount: session.messageCount! };
    });
    sessions.sort((left, right) => stableTextOrder(left.sessionId, right.sessionId));
    return { sessions };
  }).catch((error: unknown) => {
    if (error instanceof Error && error.message.startsWith('shiying_chat_read_')) throw error;
    chatReadError('state_load_failed');
  });
}

function coverageIdentityKey(source: {
  sessionId: string;
  messageId: string;
  contentHash: string;
}) {
  return JSON.stringify([source.sessionId, source.messageId, source.contentHash]);
}

function validateCoverageKnowledge(knowledge: ShiyingCoverageKnowledgeV1) {
  const covered = new Set<string>();
  for (const source of knowledge.coveredSources) {
    assertTechnicalId(source.sessionId, 'coverage_session_id_invalid');
    assertTechnicalId(source.messageId, 'coverage_message_id_invalid', source.sessionId);
    assertSafeTimestamp(source.messageCreatedAt, 'coverage_message_time_invalid', source.sessionId);
    if (source.role !== 'I' && source.role !== 'you') {
      chatReadError('coverage_role_invalid', source.sessionId);
    }
    try {
      assertShiyingHash(source.contentHash, 'coverage_knowledge_hash');
    } catch {
      chatReadError('coverage_hash_invalid', source.sessionId);
    }
    covered.add(coverageIdentityKey(source));
  }
  return covered;
}

async function readSnapshotMessages(input: {
  snapshot: ShiyingChatSnapshot;
  port: ShiyingChatReadPort;
  triggeredAt: number;
  scanFloorAt: number;
  coveredSources: Set<string>;
  excludedLifeDates?: readonly string[];
}) {
  const durable: Array<{ sessionId: string; message: SubjectiveMessage }> = [];

  for (const session of input.snapshot.sessions) {
    let beforeIndex = session.messageCount;
    let newerPageFirstCreatedAt: number | null = null;
    const seenMessageIds = new Set<string>();
    while (beforeIndex > 0) {
      let page: ChatMessagePage;
      try {
        page = await input.port.loadMessagePage(session.sessionId, {
          limit: SHIYING_CHAT_PAGE_SIZE,
          beforeIndex,
          waitForPendingWrites: false,
        });
      } catch {
        chatReadError('page_load_failed', session.sessionId, beforeIndex);
      }

      const expectedStartIndex = Math.max(0, beforeIndex - SHIYING_CHAT_PAGE_SIZE);
      const expectedCount = beforeIndex - expectedStartIndex;
      if (
        !Number.isSafeInteger(page.totalCount)
        || page.totalCount < session.messageCount
        || page.startIndex !== expectedStartIndex
        || !Array.isArray(page.messages)
        || page.messages.length !== expectedCount
      ) {
        chatReadError('page_incomplete', session.sessionId, beforeIndex);
      }

      let previousCreatedAt: number | null = null;
      for (const message of page.messages) {
        if (!message || typeof message !== 'object') {
          chatReadError('message_record_invalid', session.sessionId, beforeIndex);
        }
        if (typeof message.id !== 'string') {
          chatReadError('message_id_invalid', session.sessionId, beforeIndex);
        }
        assertTechnicalId(message.id, 'message_id_invalid', session.sessionId, beforeIndex);
        assertSafeTimestamp(
          message.createdAt,
          'message_time_invalid',
          session.sessionId,
          beforeIndex,
        );
        if (seenMessageIds.has(message.id)) {
          chatReadError('message_identity_conflict', session.sessionId, beforeIndex);
        }
        seenMessageIds.add(message.id);
        if (previousCreatedAt !== null && message.createdAt < previousCreatedAt) {
          chatReadError('page_order_invalid', session.sessionId, beforeIndex);
        }
        previousCreatedAt = message.createdAt;
        if (message.role !== 'I' && message.role !== 'you') {
          chatReadError('message_role_invalid', session.sessionId, beforeIndex);
        }
        if (typeof message.content !== 'string') {
          chatReadError('message_content_missing', session.sessionId, beforeIndex);
        }
      }

      const pageFirstCreatedAt = page.messages[0]?.createdAt ?? null;
      const pageLastCreatedAt = page.messages[page.messages.length - 1]?.createdAt ?? null;
      if (
        newerPageFirstCreatedAt !== null
        && pageLastCreatedAt !== null
        && pageLastCreatedAt > newerPageFirstCreatedAt
      ) {
        chatReadError('page_order_invalid', session.sessionId, beforeIndex);
      }
      newerPageFirstCreatedAt = pageFirstCreatedAt;

      for (const message of page.messages) {
        if (message.createdAt >= input.scanFloorAt && message.createdAt <= input.triggeredAt) {
          durable.push({ sessionId: session.sessionId, message });
        }
      }

      if (pageFirstCreatedAt !== null && pageFirstCreatedAt < input.scanFloorAt) break;
      if (page.startIndex >= beforeIndex) {
        chatReadError('page_not_advancing', session.sessionId, beforeIndex);
      }
      beforeIndex = page.startIndex;
    }
  }

  durable.sort((left, right) => compareShiyingMessageCursor(
    {
      sessionId: left.sessionId,
      messageId: left.message.id,
      messageCreatedAt: left.message.createdAt,
    },
    {
      sessionId: right.sessionId,
      messageId: right.message.id,
      messageCreatedAt: right.message.createdAt,
    },
  ));

  const skipped: ShiyingMaterialWindowV1['skipped'] = {
    failedYou: 0,
    unavailableVoiceTranscript: 0,
    attachmentOnlyOrBlank: 0,
  };
  const messages: ShiyingChatMaterialV1[] = [];
  for (const item of durable) {
    const projection = projectShiyingChatMessage(item.sessionId, item.message);
    if (projection.skippedReason) {
      skipped[projection.skippedReason] += 1;
      continue;
    }
    if (
      projection.material
      && !input.coveredSources.has(coverageIdentityKey(projection.material))
      && !input.excludedLifeDates?.includes(getShiyingLifeDate(projection.material.messageCreatedAt))
    ) {
      messages.push(projection.material);
    }
  }

  const latestDurable = durable[durable.length - 1] ?? null;
  const uncoveredYou = messages.filter((message) => message.role === 'you');
  return {
    messages,
    skipped,
    latestDurableMessageAt: latestDurable?.message.createdAt ?? null,
    latestEligibleYouAt: uncoveredYou[uncoveredYou.length - 1]?.messageCreatedAt ?? null,
    windowEndCursor: latestDurable
      ? {
          sessionId: latestDurable.sessionId,
          messageId: latestDurable.message.id,
          messageCreatedAt: latestDurable.message.createdAt,
        }
      : null,
    uncoveredYouCount: uncoveredYou.length,
  };
}

export async function loadShiyingMaterialWindow(
  input: { triggered: boolean; triggeredAt: number; automaticScanFloorAt?: number; excludedLifeDates?: readonly string[] },
  dependencies: ShiyingMaterialWindowDependencies = {},
): Promise<ShiyingMaterialWindowV1 | null> {
  if (!input.triggered) return null;
  assertSafeTimestamp(input.triggeredAt, 'triggered_at_invalid');

  const chatPort = dependencies.chatPort ?? defaultChatPort;
  const coverageLoader = dependencies.loadCoverageKnowledge ?? getShiyingCoverageKnowledge;
  const snapshot = await captureChatSnapshot(chatPort);
  const recentLifeDateStart = getShiyingRecentLifeDateStart(input.triggeredAt);
  const coverageKnowledge = await coverageLoader({
    messageCreatedAtStart: getShiyingLifeDateStartAt(recentLifeDateStart),
    messageCreatedAtEnd: input.triggeredAt,
  });
  let boundary = deriveShiyingWindowBoundary({
    triggeredAt: input.triggeredAt,
    firstLiveLifeDate: coverageKnowledge.firstLiveLifeDate,
    latestLiveEndCursor: coverageKnowledge.latestLiveEndCursor,
  });
  if (input.automaticScanFloorAt !== undefined) {
    assertSafeTimestamp(input.automaticScanFloorAt, 'automatic_floor_invalid');
    if (input.automaticScanFloorAt > input.triggeredAt) chatReadError('automatic_floor_future');
    const recentStartAt = getShiyingLifeDateStartAt(recentLifeDateStart);
    const scanFloorAt = Math.max(
      input.automaticScanFloorAt,
      recentStartAt,
      coverageKnowledge.firstLiveLifeDate === null ? 0 : boundary.scanFloorAt,
    );
    boundary = {
      ...boundary,
      scanFloorAt,
      lifeDateStart: getShiyingLifeDate(scanFloorAt),
      historyGapBeforeLifeDate: boundary.historyGapBeforeLifeDate
        ?? (input.automaticScanFloorAt < recentStartAt
          ? addShiyingLifeDates(recentLifeDateStart, -1) : null),
    };
  }
  const read = await readSnapshotMessages({
    snapshot,
    port: chatPort,
    triggeredAt: input.triggeredAt,
    scanFloorAt: boundary.scanFloorAt,
    coveredSources: validateCoverageKnowledge(coverageKnowledge),
    excludedLifeDates: input.excludedLifeDates,
  });

  return {
    triggeredAt: input.triggeredAt,
    lifeDateStart: boundary.lifeDateStart,
    lifeDateEnd: boundary.lifeDateEnd,
    scanFloorAt: boundary.scanFloorAt,
    windowStartCursor: boundary.windowStartCursor,
    windowEndCursor: read.windowEndCursor,
    historyGapBeforeLifeDate: boundary.historyGapBeforeLifeDate,
    latestDurableMessageAt: read.latestDurableMessageAt,
    latestEligibleYouAt: read.latestEligibleYouAt,
    uncoveredYouCount: read.uncoveredYouCount,
    messages: read.messages,
    skipped: read.skipped,
  };
}

/** A bounded tail check; never loads a session's whole conversation. */
export async function readShiyingChatActivity(
  port: ShiyingChatReadPort = {
    ...defaultChatPort,
    loadStateFast: () => loadChatStateFast({ activeMessageLimit: 0 }),
  },
) {
  const snapshot = await captureChatSnapshot(port);
  let latestDurableMessageAt: number | null = null;
  const tails: unknown[] = [];
  for (const session of snapshot.sessions) {
    if (session.messageCount === 0) {
      tails.push([session.sessionId, 0]);
      continue;
    }
    let page: ChatMessagePage;
    try {
      page = await port.loadMessagePage(session.sessionId, {
        limit: 1, beforeIndex: session.messageCount, waitForPendingWrites: false,
      });
    } catch { chatReadError('activity_page_failed', session.sessionId); }
    if (!Number.isSafeInteger(page.totalCount) || page.totalCount < session.messageCount
      || page.startIndex !== session.messageCount - 1 || !Array.isArray(page.messages) || page.messages.length !== 1) {
      chatReadError('activity_page_incomplete', session.sessionId);
    }
    const message = page.messages[0];
    if (!message || typeof message.id !== 'string' || typeof message.content !== 'string'
      || (message.role !== 'I' && message.role !== 'you')) {
      chatReadError('activity_message_invalid', session.sessionId);
    }
    assertTechnicalId(message.id, 'message_id_invalid', session.sessionId);
    assertSafeTimestamp(message.createdAt, 'message_time_invalid', session.sessionId);
    latestDurableMessageAt = Math.max(latestDurableMessageAt ?? 0, message.createdAt);
    const projected = projectShiyingChatMessage(session.sessionId, message);
    tails.push([session.sessionId, session.messageCount, message.id, message.createdAt,
      projected.material?.contentHash ?? projected.skippedReason]);
  }
  return { latestDurableMessageAt, signature: JSON.stringify(tails) };
}
