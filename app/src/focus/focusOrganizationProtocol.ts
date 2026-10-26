import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { FocusSession } from './focusStore';

export function focusLogPurpose(trigger = '') {
  if (trigger === 'sleeping-you-message') return '睡眠留言';
  if (trigger === 'focus-sleep-opening' || trigger === 'focus-sleep-motion') return '睡眠动静';
  if (trigger.startsWith('focus-sleep-preparing')) return '入睡前';
  if (trigger.startsWith('focus-sleep-waking')) return '刚醒来';
  if (trigger === 'focus-sleep-reply') return '醒后接话';
  return '普通表达';
}

export function formatFocusRecordedAt(timestamp: number) {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} UTC${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

export function createFocusOrganizationMessageReferences(messages: readonly SubjectiveMessage[], reservedIds: readonly string[]) {
  const reserved = new Set([...reservedIds, ...messages.map(message => message.id)]);
  const references = new Map<string, string>();
  let ordinal = 0;
  for (const message of messages) {
    if (references.has(message.id)) continue;
    let reference: string;
    do { reference = `M${++ordinal}`; } while (reserved.has(reference));
    references.set(message.id, reference);
  }
  return references;
}

export function restoreFocusOrganizationMessageReferences(candidates: readonly unknown[], references: ReadonlyMap<string, string>,
  otherMessageIds: ReadonlySet<string>) {
  const originals = new Map([...references].map(([id, reference]) => [reference, id]));
  const restore = (value: unknown) => {
    if (typeof value !== 'string') throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
    const original = originals.get(value);
    if (original !== undefined) return original;
    if (!references.has(value) && otherMessageIds.has(value)) return value;
    throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
  };
  const restoreList = (value: unknown) => {
    if (!Array.isArray(value)) throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
    const restored = value.map(restore);
    if (new Set(restored).size !== restored.length) throw new Error('FOCUS_MEMORY_SOURCE_INVALID');
    return restored;
  };
  return candidates.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const candidate = value as Record<string, unknown>;
    const eventTime = candidate.eventTime && typeof candidate.eventTime === 'object' && !Array.isArray(candidate.eventTime)
      ? candidate.eventTime as Record<string, unknown> : undefined;
    return { ...candidate, sourceMessageIds: restoreList(candidate.sourceMessageIds),
      ...(eventTime?.timeSourceMessageId != null ? { eventTime: { ...eventTime,
        timeSourceMessageId: restore(eventTime.timeSourceMessageId) } } : {}),
      ...(Array.isArray(candidate.patternEvidence) ? { patternEvidence: candidate.patternEvidence.map(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const occurrence = value as Record<string, unknown>;
        return { ...occurrence, sourceMessageIds: restoreList(occurrence.sourceMessageIds) };
      }) } : {}),
    };
  });
}

export function buildFocusOrganizationMaterial(session: FocusSession, messages: readonly SubjectiveMessage[],
  references?: ReadonlyMap<string, string>) {
  const transcript = messages.map(message =>
    `[messageId=${references?.get(message.id) ?? message.id}][time=${new Date(message.createdAt).toISOString()}][用途=${focusLogPurpose(message.focusContext?.trigger)}]\n${message.role}: ${message.content}`).join('\n\n');
  return `【本次专注记录】\n\n开始时间：${formatFocusRecordedAt(session.startedAt)}\n结束时间：${formatFocusRecordedAt(session.endedAt)}\n记录时长：${Math.round(session.durationSeconds / 60 * 10) / 10} 分钟\nyou 的事项：${session.userActivity}\nI 的事项记录：${session.baiyunActivity}\n\n【原始日志】\n\n${transcript}`;
}
