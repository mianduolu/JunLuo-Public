import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canReuseExactMemory, type MemoryDeduplicationMemory } from './memoryDeduplication';
import type { ObservationMaterialBinding } from './memoryObservationIngestion';

export type MemoryConfirmationLevel = 'automatic' | 'reviewed' | 'manual';
export type MemorySourceTraceMode = 'exact' | 'legacy_range' | 'none';
export type MemorySourceRelation = 'direct' | 'derived';

export type MemorySourceRef = {
  memoryId: string;
  sessionId: string;
  messageId: string;
  role: 'I' | 'you';
  messageCreatedAt: number;
  relation: MemorySourceRelation;
  excerpt?: string;
  observationBinding?: ObservationMaterialBinding;
  createdAt: number;
};

export type MemorySourceRefInput = Omit<MemorySourceRef, 'memoryId' | 'createdAt'>;

export function promoteMemoryConfirmation(
  current: MemoryConfirmationLevel,
  requested: MemoryConfirmationLevel,
) {
  const rank: Record<MemoryConfirmationLevel, number> = { automatic: 0, reviewed: 1, manual: 2 };
  return rank[requested] > rank[current] ? requested : current;
}

export function selectWhitelistedSourceMessages(
  sourceMessageIds: unknown,
  messages: SubjectiveMessage[],
  limit = 6,
) {
  if (!Array.isArray(sourceMessageIds)) return [];
  const allowed = new Map(messages.map((message) => [message.id, message]));
  const selected: SubjectiveMessage[] = [];
  const seen = new Set<string>();
  for (const rawId of sourceMessageIds) {
    if (typeof rawId !== 'string' || rawId !== rawId.trim() || !rawId) continue;
    const message = allowed.get(rawId);
    if (!message || seen.has(rawId) || (message.role !== 'I' && message.role !== 'you')) continue;
    seen.add(rawId);
    selected.push(message);
    if (selected.length >= Math.max(1, limit)) break;
  }
  return selected;
}

export function buildDirectMemorySourceRefs(
  sessionId: string,
  messages: SubjectiveMessage[],
  sourceMessageIds: unknown,
): MemorySourceRefInput[] {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return [];
  return selectWhitelistedSourceMessages(sourceMessageIds, messages).map((message) => ({
    sessionId: normalizedSessionId,
    messageId: message.id,
    role: message.role,
    messageCreatedAt: message.createdAt,
    relation: 'direct',
    excerpt: message.content,
  }));
}

export function buildSingleMemorySourceRef(sessionId: string, message: SubjectiveMessage) {
  return buildDirectMemorySourceRefs(sessionId, [message], [message.id]);
}

export function buildObservationMemorySourceRefs(bindings: readonly ObservationMaterialBinding[]): MemorySourceRefInput[] {
  return bindings.map(binding => ({ sessionId: `observation-source:${binding.observationId}`,
    messageId: binding.observationId, role: 'I', messageCreatedAt: binding.capturedAt,
    relation: 'direct', observationBinding: binding }));
}

/** Retained observation evidence is complete structured material, never a sliced JSON prefix. */
export function isCompleteObservationExcerpt(content: string | undefined): content is string {
  if (!content || !content.startsWith('【I 的观察记录】\n')) return false;
  const marker = /\n观察内容（(?:全文|片段)）：\n/.exec(content);
  if (!marker || marker.index === undefined) return false;
  try {
    const value = JSON.parse(content.slice(marker.index + marker[0].length));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
      || !value.subjectVisibility || !Array.isArray(value.subjectVisibility.subjects) || !Array.isArray(value.subjectIdentities)) return false;
    const facts = value.objectiveFacts ?? [];
    const inferences = value.inferences ?? [];
    const uncertainties = value.uncertainties ?? [];
    if (![facts, inferences, uncertainties].every(Array.isArray)) return false;
    const factIds = new Set(facts.map((fact: { factId?: unknown }) => fact.factId));
    const personIds = new Set(value.subjectVisibility.subjects.map((person: { subjectRef?: unknown }) => person.subjectRef));
    return [...facts, ...inferences].every(item => item && (item.subjectRef === null || personIds.has(item.subjectRef)))
      && [...inferences, ...uncertainties].every(item => item
        && Array.isArray(item.evidenceFactIds ?? item.relatedFactIds)
        && (item.evidenceFactIds ?? item.relatedFactIds).every((id: unknown) => factIds.has(id)));
  } catch { return false; }
}

type MemorySourceComparable = {
  atomicKind?: MemoryDeduplicationMemory['atomicKind'];
  eventTime?: MemoryDeduplicationMemory['eventTime'];
  content: string;
  domain: string;
  recallCues: string[];
  tags: string[];
  title: string;
};

export function findSourceCoveredMemoryDuplicate<T extends MemorySourceComparable>(
  candidate: MemorySourceComparable,
  memories: T[],
) {
  const memory = memories.find((item) => canReuseExactMemory(candidate, item, true));
  return memory ? { memory, score: 1 } : null;
}

export function limitMemorySourceExcerpts(refs: MemorySourceRefInput[], keepExcerpt: boolean) {
  let remaining = 800;
  return refs.map((ref) => {
    if (ref.sessionId.startsWith('observation-source:')) {
      const excerpt = keepExcerpt && ref.relation === 'direct' && isCompleteObservationExcerpt(ref.excerpt)
        && ref.excerpt.length <= remaining ? ref.excerpt : undefined;
      remaining -= excerpt?.length ?? 0;
      return { ...ref, excerpt };
    }
    const compact = keepExcerpt && ref.relation === 'direct'
      ? ref.excerpt?.replace(/\s+/g, ' ').trim().slice(0, 240)
      : undefined;
    const excerpt = compact?.slice(0, remaining);
    remaining -= excerpt?.length ?? 0;
    return { ...ref, excerpt: excerpt || undefined };
  });
}
