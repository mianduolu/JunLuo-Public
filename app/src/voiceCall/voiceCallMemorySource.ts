import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadChatSessionMessagePage } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import type { VoiceCallIDelivery, VoiceCallRecord, VoiceCallTurnRecord, VoiceCallYouTurnRecord } from './voiceCallRecord';

/** Full-turn identity is separate from the exact fragment supplied to a request. */
export type VoiceCallMaterialBinding = {
  version: 1; callId: string; sessionId: string; messageId: string; turnId: string;
  role: 'I' | 'you'; sourceHash: string; start: number; end: number; sentHash: string;
};
export type VoiceCallMemoryMessage = SubjectiveMessage & { voiceCallSource?: {
  sourceHash: string; contentHash: string; delivery?: VoiceCallIDelivery; confidence?: number;
  emotionHint?: VoiceCallYouTurnRecord['emotion'];
} };
export const getVoiceCallMemorySessionId = (callId: string) => `voice-call:${callId}`;
export const getVoiceCallMemoryMessageId = (turnId: string, role: 'I' | 'you') => `voice-call-turn:${encodeURIComponent(turnId)}:${role}`;
export const isVoiceCallMemorySource = (sessionId: string) => sessionId.startsWith('voice-call:');
export const getVoiceCallMemorySourceInfo = (message: SubjectiveMessage) => (message as VoiceCallMemoryMessage).voiceCallSource;

export function voiceCallTurnSourceHash(turn: VoiceCallTurnRecord) {
  return stableMemoryHash(JSON.stringify([turn.turnId, turn.role, turn.at, turn.text,
    turn.role === 'I' ? [turn.delivery, turn.playbackFailureCode ?? null] : [turn.transcriptStatus,
      turn.confidence ?? null, turn.durationMs ?? null, turn.emotion ? [turn.emotion.confidenceLevel,
        turn.emotion.hint, turn.emotion.label, turn.emotion.score] : null,
      turn.fallback ?? null, turn.language ?? null, turn.provider ?? null]]));
}
export function buildVoiceCallMaterialBinding(record: VoiceCallRecord, turn: VoiceCallTurnRecord,
  start = 0, end = turn.text.length): VoiceCallMaterialBinding {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > turn.text.length
    || !record.turns.includes(turn) || !turn.text.slice(start, end).trim()) throw new Error('MEMORY_VOICE_RANGE_INVALID');
  return { version: 1, callId: record.callId, sessionId: getVoiceCallMemorySessionId(record.callId),
    messageId: getVoiceCallMemoryMessageId(turn.turnId, turn.role), turnId: turn.turnId, role: turn.role,
    sourceHash: voiceCallTurnSourceHash(turn), start, end, sentHash: stableMemoryHash(turn.text.slice(start, end)) };
}
export function buildVoiceCallMaterialMessage(record: VoiceCallRecord, turn: VoiceCallTurnRecord,
  start = 0, end = turn.text.length): { message: VoiceCallMemoryMessage; binding: VoiceCallMaterialBinding } {
  const binding = buildVoiceCallMaterialBinding(record, turn, start, end);
  return { binding, message: { id: binding.messageId, role: turn.role, createdAt: turn.at,
    content: turn.text.slice(start, end), source: 'voice-call', voiceCallSource: {
      sourceHash: binding.sourceHash, contentHash: stableMemoryHash(turn.text), ...(turn.role === 'I' ? { delivery: turn.delivery }
        : { confidence: turn.confidence, emotionHint: turn.emotion }) } } };
}
export function getVoiceCallMemoryMessages(record: VoiceCallRecord) {
  return record.turns.filter(turn => !!turn.text.trim()).map(turn => buildVoiceCallMaterialMessage(record, turn).message);
}
export function renderVoiceCallMaterial(message: SubjectiveMessage, binding?: VoiceCallMaterialBinding) {
  const delivery = getVoiceCallMemorySourceInfo(message)?.delivery;
  return `[messageId=${binding?.messageId ?? message.id}][time=${new Date(message.createdAt).toISOString()}]${message.role === 'I' && delivery ? `[播放状态=${delivery}]` : ''} ${message.role}：${message.content}`;
}
export function getVoiceCallMemorySourceContext(message: SubjectiveMessage) {
  const source = getVoiceCallMemorySourceInfo(message);
  if (!source) return '';
  const clues = message.role === 'you' ? JSON.stringify({ confidence: source.confidence, emotionHint: source.emotionHint }) : '';
  return renderVoiceCallMaterial({ ...message, content: '' }) + (clues && clues !== '{}' ? `\n${clues}` : '');
}
export async function loadVoiceCallMemoryRecord(sessionId: string, options: { waitForPendingWrites?: boolean } = {}) {
  if (!isVoiceCallMemorySource(sessionId)) return null;
  const callId = sessionId.slice('voice-call:'.length);
  let beforeIndex: number | undefined;
  for (;;) {
    const page = await loadChatSessionMessagePage(PRIMARY_CHAT_SESSION_ID, { limit: 100, beforeIndex,
      waitForPendingWrites: options.waitForPendingWrites });
    const carrier = page.messages.find(message => message.id === `voice-call-record-${callId}`);
    if (carrier) return carrier.voiceCallRecord?.callId === callId ? carrier.voiceCallRecord : null;
    if (!page.startIndex || beforeIndex !== undefined && page.startIndex >= beforeIndex) return null;
    beforeIndex = page.startIndex;
  }
}
export async function loadVoiceCallMemoryMessages(sessionId: string, options: { waitForPendingWrites?: boolean } = {}) {
  const record = await loadVoiceCallMemoryRecord(sessionId, options);
  return record ? getVoiceCallMemoryMessages(record) : [];
}
export async function loadVoiceCallMemoryMessage(sessionId: string, messageId: string,
  options: { waitForPendingWrites?: boolean } = {}) {
  const messages = (await loadVoiceCallMemoryMessages(sessionId, options)).filter(message => message.id === messageId);
  // Ambiguous duplicate turn IDs cannot serve as exact evidence.
  return messages.length === 1 ? messages[0] : null;
}
export async function validateVoiceCallMaterialBinding(binding: VoiceCallMaterialBinding, sent?: SubjectiveMessage,
  options: { waitForPendingWrites?: boolean } = {}) {
  const original = await loadVoiceCallMemoryMessage(binding.sessionId, binding.messageId, options);
  return isVoiceCallMaterialBindingCurrent(binding, original, sent);
}
function isVoiceCallMaterialBindingCurrent(binding: VoiceCallMaterialBinding, original: SubjectiveMessage | null, sent?: SubjectiveMessage) {
  if (binding.version !== 1 || binding.sessionId !== getVoiceCallMemorySessionId(binding.callId)
    || binding.messageId !== getVoiceCallMemoryMessageId(binding.turnId, binding.role)) return false;
  if (!original || getVoiceCallMemorySourceInfo(original)?.sourceHash !== binding.sourceHash
    || !Number.isInteger(binding.start) || !Number.isInteger(binding.end) || binding.start < 0
    || binding.end <= binding.start || binding.end > original.content.length) return false;
  const content = original.content.slice(binding.start, binding.end);
  return stableMemoryHash(content) === binding.sentHash && (!sent || (sent.id === original.id && sent.role === original.role
    && sent.createdAt === original.createdAt && sent.content === content));
}

/** One local source snapshot per call for this check, never retained across checks. */
export async function validateVoiceCallMaterialBindings(bindings: readonly VoiceCallMaterialBinding[],
  options: { waitForPendingWrites?: boolean } = {}) {
  const messages = new Map<string, SubjectiveMessage[]>();
  for (const sessionId of new Set(bindings.map(binding => binding.sessionId))) {
    messages.set(sessionId, await loadVoiceCallMemoryMessages(sessionId, options));
  }
  return bindings.every(binding => {
    const matches = messages.get(binding.sessionId)?.filter(message => message.id === binding.messageId) ?? [];
    return isVoiceCallMaterialBindingCurrent(binding, matches.length === 1 ? matches[0] : null);
  });
}
