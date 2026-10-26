import type { ApiChatMessage, SubjectiveMessage } from '../ai/subjectiveMessages';
import { getTheaterBackstageContext } from '../ai/subjectiveMessages';
import { formatReadingReference } from '../reading/readingReference';
import type { AiConnection } from '../ai/types';
import type { ChatContextCompressionState, ChatShortLog } from './chatStorage';
import { CHAT_SUMMARY_CORRECTION_INSTRUCTION } from './chatSummaryCorrection';

const RECENT_TURNS_TO_KEEP = 6;
export const COMPRESSION_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
export const SHORT_CHAT_LOG_USER_THRESHOLD = 40;
export const MAX_SHORT_CHAT_LOGS = 12;
const SHORT_LOG_CONTEXT_LIMIT = 5;

export function estimateTextTokens(text: string) {
  const normalized = text.trim();
  if (!normalized) return 0;
  const cjk = (normalized.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const other = normalized.length - cjk;
  return Math.ceil(cjk * 1.05 + other / 3.5);
}

export function estimateApiMessagesTokens(messages: ReadonlyArray<Pick<ApiChatMessage, 'content'>>) {
  return messages.reduce((total, message) => total + 4 + estimateTextTokens(message.content), 2);
}

export function getReplyTokenReserve(connection: AiConnection) {
  const configured = connection.modelParameters?.maxTokens;
  const replyTokens = configured?.enabled ? configured.value : 4096;
  return Math.max(512, Math.round(replyTokens)) + 512;
}

export function findRecentTurnStart(messages: SubjectiveMessage[], turns = RECENT_TURNS_TO_KEEP) {
  let userTurns = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'you') {
      userTurns += 1;
      if (userTurns > turns) return index + 1;
    }
  }
  return 0;
}

export function getMessagesAfterSummary(
  messages: SubjectiveMessage[],
  state?: ChatContextCompressionState,
) {
  if (!state?.summarizedThroughMessageId) return messages;
  const boundary = messages.findIndex((message) => message.id === state.summarizedThroughMessageId);
  if (boundary >= 0) return messages.slice(boundary + 1);
  if (!state.correctionReview?.pending.length) return messages;
  // A missing old boundary must not turn a paused summary into the entire old transcript.
  return typeof state.summarizedThroughAt === 'number'
    ? messages.filter(message => message.createdAt > state.summarizedThroughAt!)
    : messages.slice(findRecentTurnStart(messages));
}

export function getCompressionCandidates(
  messages: SubjectiveMessage[],
  state?: ChatContextCompressionState,
) {
  const afterSummary = getMessagesAfterSummary(messages, state);
  const recentStart = findRecentTurnStart(afterSummary);
  return afterSummary.slice(0, recentStart);
}

export function getRequestMessages(
  messages: SubjectiveMessage[],
  state: ChatContextCompressionState | undefined,
  inputBudget: number,
  measureInput?: (messages: SubjectiveMessage[]) => number,
) {
  let selected = getMessagesAfterSummary(messages, state);
  let removable = findRecentTurnStart(selected);
  while (
    selected.length > 1
    && (measureInput ? measureInput(selected) : estimateTextTokens(selected.map((message) => [message.content,
      message.role === 'you' ? formatReadingReference(message.readingReference) : ''].filter(Boolean).join('\n\n')).join('\n'))) > inputBudget
  ) {
    if (removable <= 0) break;
    let removeCount = 1;
    while (removeCount < removable && selected[removeCount].role !== 'you') {
      removeCount += 1;
    }
    selected = selected.slice(removeCount);
    removable -= removeCount;
  }
  return selected;
}

export function countUserMessagesSinceSummary(
  messages: SubjectiveMessage[],
  state?: ChatContextCompressionState,
) {
  return getMessagesAfterSummary(messages, state).filter((message) => message.role === 'you').length;
}

export function getMessagesAfterShortLog(
  messages: SubjectiveMessage[],
  state?: ChatContextCompressionState,
) {
  const boundaryId = state?.shortLogs?.[state.shortLogs.length - 1]?.endMessageId;
  if (!boundaryId) return messages;
  const boundary = messages.findIndex((message) => message.id === boundaryId);
  return boundary < 0 ? messages : messages.slice(boundary + 1);
}

export function getShortLogCandidates(
  messages: SubjectiveMessage[],
  state?: ChatContextCompressionState,
) {
  const afterShortLog = getMessagesAfterShortLog(messages, state);
  const recentStart = findRecentTurnStart(afterShortLog);
  return afterShortLog.slice(0, recentStart);
}

export function countUserMessagesSinceShortLog(
  messages: SubjectiveMessage[],
  state?: ChatContextCompressionState,
) {
  return getMessagesAfterShortLog(messages, state).filter((message) => message.role === 'you').length;
}

export function shouldGenerateShortLog(
  messages: SubjectiveMessage[],
  state: ChatContextCompressionState | undefined,
  manual = false,
) {
  if (!getShortLogCandidates(messages, state).length) return false;
  if (manual) return true;
  return countUserMessagesSinceShortLog(messages, state) >= SHORT_CHAT_LOG_USER_THRESHOLD;
}

function buildShortLogTitle(messages: SubjectiveMessage[]) {
  const firstUserMessage = messages.find((message) => message.role === 'you');
  const text = (firstUserMessage?.content || messages[0]?.content || '这段聊天')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '这段聊天';
  return text.length > 18 ? `${text.slice(0, 18)}...` : text;
}

export function createChatShortLog(
  messages: SubjectiveMessage[],
  summary: string,
  source: ChatShortLog['source'],
): ChatShortLog | null {
  const first = messages[0];
  const last = messages[messages.length - 1];
  if (!first || !last || !summary.trim()) return null;
  return {
    id: `short-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    startMessageId: first.id,
    endMessageId: last.id,
    startAt: first.createdAt,
    endAt: last.createdAt,
    title: buildShortLogTitle(messages),
    summary: summary.trim(),
    createdAt: Date.now(),
    source,
  };
}

export function appendChatShortLog(
  state: ChatContextCompressionState,
  log: ChatShortLog,
): ChatContextCompressionState {
  const existing = state.shortLogs ?? [];
  const deduped = existing.filter((item) => item.id !== log.id && item.endMessageId !== log.endMessageId);
  return {
    ...state,
    shortLogs: [...deduped, log].filter((item, index, items) => !!item.correctionReview?.pending.length
      || index >= items.length - MAX_SHORT_CHAT_LOGS),
  };
}

export function buildShortLogContext(shortLogs?: ChatShortLog[]) {
  const logs = (shortLogs ?? []).filter(log => !log.correctionReview?.pending.length).slice(-SHORT_LOG_CONTEXT_LIMIT);
  if (!logs.length) return '';
  const lines = logs.map((log) => {
    const time = new Date(log.endAt).toLocaleString('zh-CN');
    return `- [${time}] ${log.title}：${log.summary}`;
  });
  return `【短期聊天小便签】\n${lines.join('\n')}`;
}

export function buildConversationSummaryWithShortLogs(state?: ChatContextCompressionState) {
  const parts = [state?.correctionReview?.pending.length ? '' : state?.summary?.trim() || '',
    buildShortLogContext(state?.shortLogs)].filter(Boolean);
  return parts.join('\n\n');
}

export function shouldCompressContext(
  messages: SubjectiveMessage[],
  state: ChatContextCompressionState | undefined,
  connection: AiConnection,
) {
  if (connection.contextCompressionEnabled === false) return false;
  if (state?.lastFailedAt && Date.now() - state.lastFailedAt < COMPRESSION_FAILURE_COOLDOWN_MS) return false;
  if (!getCompressionCandidates(messages, state).length) return false;
  const window = connection.contextWindowTokens ?? 65536;
  const ratio = (state?.currentWindowTokens ?? 0) / window;
  if (ratio >= (connection.contextCompressionThreshold ?? 0.7)) return true;
  return (
    connection.contextCompressionByMessageCount !== false
    && countUserMessagesSinceSummary(messages, state)
      >= (connection.contextCompressionMessageThreshold ?? 16)
  );
}

function formatConversation(messages: SubjectiveMessage[]) {
  return messages.map((message, index) => {
    const role = message.role === 'you' ? 'you' : 'I';
    const time = new Date(message.createdAt).toLocaleString('zh-CN');
    const context = getTheaterBackstageContext(message, messages[index - 1]);
    return `${context ? `${context}\n` : ''}[${time}] ${role}：${message.content}`;
  }).join('\n');
}

export async function generateContextSummary({
  apiKey,
  connection,
  messages,
  previousSummary,
  corrections,
}: {
  apiKey: string;
  connection: AiConnection;
  messages: SubjectiveMessage[];
  previousSummary?: string;
  corrections?: string;
}) {
  const body = JSON.stringify({
      model: connection.model.trim(),
      messages: [
        {
          role: 'system',
          content: `【整理更早的对话】

和 you 聊过的内容渐渐多起来时，I 想把更早的对话收拢成一份简短记录，让以后还能自然地接着聊下去。

I 留下已经说清的人物、事实、偏好、边界、约定、日期、感受变化、还没结束的事、关系变化和当前话题，依着对话里真正出现的内容来写。

写好后，I 把这份记录发出来。${corrections?.trim() ? `\n\n${CHAT_SUMMARY_CORRECTION_INSTRUCTION}` : ''}`,
        },
        {
          role: 'system',
          content: `${previousSummary?.trim() ? `已有累计摘要：\n${previousSummary.trim()}\n\n` : ''}${corrections?.trim() ? `${corrections.trim()}\n\n` : ''}新增对话：\n${formatConversation(messages)}`,
        },
      ],
      max_tokens: 1600,
      temperature: 0.2,
  });
  const { beginPromptCacheMetric } = await import('../ai/promptCacheMetrics');
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'chat.compression', connection });
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    if (!response.ok) throw new Error(`summary-http-${response.status}`);
    const payload = await response.json() as {
      usage?: unknown;
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    cacheMetric.recordUsage(payload?.usage);
    const content = payload.choices?.[0]?.message?.content;
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content) ? content.map((part) => part.text ?? '').join('') : '';
    if (!text.trim()) throw new Error('summary-empty');
    return text.trim();
  } finally { cacheMetric.finish(); }
}
