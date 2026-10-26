import type { AiConnection } from './types';
import { buildApiMessageContent, getTheaterBackstageContext, type ApiChatMessage, type SubjectiveMessage } from './subjectiveMessages';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { fingerprintPromptText } from './promptCacheMetrics';
import { buildToolProviderConnectionFingerprint } from './toolProviderCapabilities';

/** Reviewed local candidate only; other models/providers retain their existing layout. */
export function isLocalQwenChatConnection(connection: AiConnection) {
  return connection.preset === 'ollama'
    && connection.baseUrl.trim().replace(/\/+$/u, '') === 'http://127.0.0.1:11434/v1'
    && connection.model.trim() === 'junluo-qwen38-27b:q4_k_m';
}

/** Run after tool continuations are inserted; keep their objects and relative order intact. */
export function mergeLocalQwenSystemMessages<T extends { role: string; content: string }>(
  messages: readonly T[],
): (T | ApiChatMessage)[] {
  const system = messages.filter(message => message.role === 'system');
  if (!system.length || system.length === 1 && messages[0].role === 'system') return [...messages];
  return [{ role: 'system', content: system.map(message => message.content).join('\n\n') },
    ...messages.filter(message => message.role !== 'system')];
}

/** Explicit business opt-in is also required; the shared contextSource is not a gate. */
export function isSiliconQwenChatConnection(connection: AiConnection) {
  return connection.baseUrl.trim().replace(/\/+$/u, '') === 'https://api.siliconflow.cn/v1'
    && connection.model.trim() === 'Qwen/Qwen3.8-27B';
}

export type QwenChatSource = { version: 1; connectionFingerprint: string; sessionId: string;
  refs: { id: string; revision: string }[] };
export type QwenChatLayoutMode = 'ordinary' | 'important_raw';

export class QwenChatSourceUnavailable extends Error {
  constructor() { super('QWEN_CHAT_SOURCE_UNAVAILABLE'); }
}
export class QwenChatSourceInvalid extends Error {
  constructor() { super('QWEN_CHAT_SOURCE_INVALID'); }
}
export function isQwenChatSourceDeferred(error: unknown) {
  return error instanceof QwenChatSourceUnavailable;
}

export function selectQwenChatMessages(messages: readonly SubjectiveMessage[]) {
  return messages.filter(message => (message.role === 'I' || message.role === 'you')
    && Number.isFinite(message.createdAt) && message.createdAt > 0 && message.content.trim()
    && message.source !== 'voice-call' && message.source !== 'tool-call'
    && message.deliveryStatus !== 'failed');
}

/** Keep the important contact's whole original selection, including voice/tool records. */
export function canUseQwenImportantRawChat(messages: readonly SubjectiveMessage[]) {
  return new Set(messages.map(message => message.id)).size === messages.length
    && messages.every(message => typeof message.id === 'string' && !!message.id
      && (message.role === 'I' || message.role === 'you')
      && Number.isFinite(message.createdAt) && message.createdAt > 0 && Number.isFinite(new Date(message.createdAt).getTime())
      && typeof message.content === 'string' && !!message.content.trim()
      && message.deliveryStatus !== 'failed')
    && selectQwenChatMessages(messages).some(message => message.role === 'you');
}

export function assertQwenChatMessages(messages: readonly SubjectiveMessage[], mode: QwenChatLayoutMode = 'ordinary') {
  if (mode === 'important_raw' && !canUseQwenImportantRawChat(messages)) throw new QwenChatSourceInvalid();
  if (!selectQwenChatMessages(messages).some(message => message.role === 'you')) throw new QwenChatSourceInvalid();
}

/** Only the transmitted message contract, not evolving diagnostics/player state. */
export function qwenChatMessageRevision(message: SubjectiveMessage, mode: QwenChatLayoutMode = 'ordinary') {
  if (mode === 'important_raw') return fingerprintPromptText(JSON.stringify([message.role, message.content, message.createdAt]));
  return fingerprintPromptText(JSON.stringify([message.id, message.role, message.createdAt, message.content,
    message.source ?? null, message.deliveryStatus ?? null, message.replyTo ?? null,
    buildApiMessageContent(message, false), message.theaterBackstage ?? null]));
}

export function freezeQwenChatSource(connection: AiConnection, sessionId: string, messages: readonly SubjectiveMessage[], mode: QwenChatLayoutMode = 'ordinary'): QwenChatSource {
  const actual = mode === 'important_raw' ? [...messages] : selectQwenChatMessages(messages);
  assertQwenChatMessages(actual, mode);
  return { version: 1, connectionFingerprint: buildToolProviderConnectionFingerprint(connection), sessionId,
    refs: actual.map(message => ({ id: message.id, revision: qwenChatMessageRevision(message, mode) })) };
}

/** Missing/edited originals invalidate; temporary I/O failures wait without buying a request. */
export async function readQwenChatSource(source: QwenChatSource,
  read: (sessionId: string, id: string) => Promise<SubjectiveMessage | null | undefined>, connection?: AiConnection,
  mode: QwenChatLayoutMode = 'ordinary') {
  if (connection && buildToolProviderConnectionFingerprint(connection) !== source.connectionFingerprint) throw new QwenChatSourceInvalid();
  const messages: SubjectiveMessage[] = [];
  for (const ref of source.refs) {
    let message: SubjectiveMessage | null | undefined;
    try { message = await read(source.sessionId, ref.id); } catch { throw new QwenChatSourceUnavailable(); }
    if (!message || mode === 'important_raw' && message.id !== ref.id
      || qwenChatMessageRevision(message, mode) !== ref.revision) throw new QwenChatSourceInvalid();
    messages.push(message);
  }
  assertQwenChatMessages(messages, mode);
  return messages;
}

/** Caller supplies compiled facts/tasks separately. No classification by prompt prose. */
export function buildQwenChatLayout(systemParts: readonly string[], messages: readonly SubjectiveMessage[], taskParts: readonly string[] = [], includeBackstage = true, mode: QwenChatLayoutMode = 'ordinary'): ApiChatMessage[] {
  const actual = mode === 'important_raw' ? [...messages] : selectQwenChatMessages(messages);
  assertQwenChatMessages(actual, mode);
  const backstage = includeBackstage && mode !== 'important_raw' ? actual.map((message, index) => getTheaterBackstageContext(message, actual[index - 1])).filter(Boolean) : [];
  return [{ role: 'system', content: [...systemParts, ...backstage, ...taskParts].filter(Boolean).join('\n\n') },
    ...actual.map(message => ({ role: message.role === 'you' ? 'user' as const : 'assistant' as const,
      content: JSON.stringify({ role: message.role, time: formatChatAfterglowMessageTime(message.createdAt),
        content: mode === 'important_raw' ? message.content : buildApiMessageContent(message, false) }) }))];
}
