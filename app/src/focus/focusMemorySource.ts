import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import type { FocusLogEntry } from './focusStore';

export type FocusMaterialBinding = {
  version: 1; sessionId: string; messageId: string; sourceHash: string;
};
const PREFIX = 'focus-source:';
export type FocusMemoryOriginalReader = (sessionId: string) => Promise<{
  exists: boolean; logs: readonly FocusLogEntry[];
}>;
let originalReader: FocusMemoryOriginalReader | null = null;
/** Desktop borrows current materialized originals; the phone keeps its store. */
export function bindFocusMemoryOriginalReader(reader: FocusMemoryOriginalReader | null) { originalReader = reader; }

function originalSessionId(value: unknown) {
  if (typeof value !== 'string') return null;
  const id = value.startsWith(PREFIX) ? value.slice(PREFIX.length) : value;
  return /^focus-[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
export function isFocusMemorySource(sessionId: string) { return originalSessionId(sessionId) !== null; }
export function focusMemorySourceSessionId(sessionId: string) {
  const original = originalSessionId(sessionId);
  if (!original) throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
  return `${PREFIX}${original}`;
}
export function getFocusMemorySourceContext(message: Pick<SubjectiveMessage, 'focusContext'>) {
  const value = message.focusContext;
  return value && isFocusMemorySource(value.sessionId) && typeof value.trigger === 'string'
    && Number.isFinite(value.elapsedSeconds) ? value : null;
}
export function focusMemoryMessageHash(message: SubjectiveMessage) {
  const context = getFocusMemorySourceContext(message);
  if (!context || !['I', 'you'].includes(message.role)) throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
  return stableMemoryHash(JSON.stringify([focusMemorySourceSessionId(context.sessionId), message.id,
    message.role, message.content, message.createdAt, context.trigger, context.elapsedSeconds]));
}
export function makeFocusMaterialBinding(message: SubjectiveMessage): FocusMaterialBinding {
  const context = getFocusMemorySourceContext(message);
  if (!context) throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
  return { version: 1, sessionId: focusMemorySourceSessionId(context.sessionId),
    messageId: message.id, sourceHash: focusMemoryMessageHash(message) };
}
export function isFocusOriginalLog(log: Pick<FocusLogEntry, 'role' | 'trigger' | 'content'>) {
  return (log.role === 'I' || log.role === 'you') && !!log.content.trim()
    && log.trigger !== 'focus-sleep-reply-receipt' && log.trigger !== 'focus-organization-result';
}
function originalMessage(sessionId: string, log: FocusLogEntry): SubjectiveMessage | null {
  if (!isFocusOriginalLog(log)) return null;
  return { id: log.id, role: log.role as 'I' | 'you', content: log.content, createdAt: log.createdAt,
    focusContext: { sessionId: focusMemorySourceSessionId(sessionId), trigger: log.trigger,
      elapsedSeconds: log.elapsedSeconds } };
}
export async function loadFocusMemoryMessages(sessionId: string): Promise<SubjectiveMessage[]> {
  const id = originalSessionId(sessionId);
  if (!id) return [];
  const source = originalReader ? await originalReader(id) : await (async () => {
    const store = await import('./focusStore');
    const exists = Boolean(await store.loadFocusSessionById(id));
    return { exists, logs: exists ? await store.loadFocusLogs(id) : [] };
  })();
  if (!source.exists) return [];
  const logs = source.logs;
  return logs.filter(log => log.sessionId === id).flatMap(log => {
    const message = originalMessage(id, log);
    return message ? [message] : [];
  });
}
export async function loadFocusMemoryMessage(sessionId: string, messageId: string) {
  return (await loadFocusMemoryMessages(sessionId)).find(message => message.id === messageId) ?? null;
}
export async function validateFocusMaterialBindings(bindings: readonly FocusMaterialBinding[],
  sentMessages?: readonly SubjectiveMessage[]) {
  const originals = new Map<string, Map<string, SubjectiveMessage>>();
  for (const binding of bindings) {
    if (!binding || binding.version !== 1 || !isFocusMemorySource(binding.sessionId)
      || typeof binding.messageId !== 'string' || !binding.messageId || typeof binding.sourceHash !== 'string') return false;
    const sessionId = focusMemorySourceSessionId(binding.sessionId);
    if (!originals.has(sessionId)) originals.set(sessionId,
      new Map((await loadFocusMemoryMessages(sessionId)).map(message => [message.id, message])));
    const original = originals.get(sessionId)!.get(binding.messageId);
    if (!original || focusMemoryMessageHash(original) !== binding.sourceHash) return false;
    if (sentMessages) {
      const sent = sentMessages.find(message => message.id === binding.messageId
        && getFocusMemorySourceContext(message)?.sessionId === sessionId);
      if (!sent || focusMemoryMessageHash(sent) !== binding.sourceHash) return false;
    }
  }
  return true;
}
export async function validateFocusMaterialBinding(binding: FocusMaterialBinding, sentMessage?: SubjectiveMessage) {
  return validateFocusMaterialBindings([binding], sentMessage ? [sentMessage] : undefined);
}
export async function validateFocusCandidateSources(candidate: {
  focusBindings?: FocusMaterialBinding[];
  sourceRefs?: Array<{ sessionId: string; messageId: string; role: 'I' | 'you'; messageCreatedAt: number;
    relation: 'direct' | 'derived'; excerpt?: string }>;
}) {
  const refs = (candidate.sourceRefs ?? []).filter(ref => ref.relation === 'direct' && isFocusMemorySource(ref.sessionId));
  const bindings = candidate.focusBindings ?? [];
  if (!refs.length) return !bindings.length;
  if (refs.some(ref => !bindings.some(binding => binding.sessionId === focusMemorySourceSessionId(ref.sessionId)
    && binding.messageId === ref.messageId)) || !(await validateFocusMaterialBindings(bindings))) return false;
  for (const ref of refs) {
    const message = await loadFocusMemoryMessage(ref.sessionId, ref.messageId);
    if (!message || message.role !== ref.role || message.createdAt !== ref.messageCreatedAt
      || typeof ref.excerpt === 'string' && !message.content.includes(ref.excerpt)) return false;
  }
  return true;
}
