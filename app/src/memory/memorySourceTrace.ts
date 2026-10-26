import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { getTheaterBackstageContext } from '../ai/subjectiveMessages';
import { getVoiceCallMemorySourceContext } from '../voiceCall/voiceCallMemorySource';
import { getReadingMemorySourceContext } from '../reading/readingMemoryContext';
import { loadChatState } from '../chat/chatStorage';
import { isLetterMemorySource, isObservationMemorySource, loadMemorySourceMessages } from './memorySourceReader';
import type { MemoryRecallRoute } from './memoryRecallRouter';
import {
  loadMemorySourceRefs,
  type MemoryEntry,
  type MemoryRecallItem,
  type MemorySourceRelation,
  type MemorySourceTraceMode,
} from './memoryStore';
import { getMemorySpeechPolicy } from './memorySpeechPolicy';
import type { MemoryReadSnapshot, MemoryReadPart } from './memoryReadMaterials';
import { getMemorySourceStatus, memorySourceStatusLabel, getMemorySourceStatusLabel, type MemorySourceStatus } from './memorySourceStatus';
import type { PostMemoryKnowledgeSnapshot } from '../posts/baiyunPostMemorySource';
import { prepareObservationFragment } from './memoryObservationIngestion';
import { stableMemoryHash } from './memoryAtomicity';

export type MemorySourceTraceMessage = {
  available: boolean;
  role: 'you' | 'I';
  content: string;
  context?: string;
  createdAt: number;
  matched: boolean;
  messageId: string;
  relation?: MemorySourceRelation;
  sourceStatus?: MemorySourceStatus;
  sourceLabel?: string;
  retainedExcerpt: boolean;
  sessionId: string;
};

export type MemorySourceDetail = {
  memoryId: string;
  title: string;
  sourceStartAt?: number;
  sourceEndAt?: number;
  sourceStatus?: 'missing';
  sourceLabel?: string;
  messages: MemorySourceTraceMessage[];
  mode: MemorySourceTraceMode;
  directCount: number;
  derivedCount: number;
  missingCount: number;
};

export type MemorySourceTraceResult = {
  context: string;
  details: MemorySourceDetail[];
  debug: {
    candidates: number;
    matched: number;
    missingRange: number;
    missingMessages: number;
    exact: number;
    legacyRange: number;
    none: number;
  };
};

type LoadMemorySourceDetailsInput = {
  items: MemoryRecallItem[];
  route?: MemoryRecallRoute | null;
  userText: string;
};

const WINDOW_PADDING_MS = 2 * 60 * 1000;
const MAX_MEMORIES = 3;
const MAX_MESSAGES_PER_MEMORY = 6;
const MAX_CONTEXT_CHARS = 1600;
/** Original observation versions stay local; no extra result parameters reach the model. */
export const observationSourceTraceVersions = new WeakMap<object, string>();
export function observationSourcePartsVersion(parts: readonly MemoryReadPart[]) {
  const observations = parts.filter(part => isObservationMemorySource(part.sessionId ?? ''));
  return observations.length ? stableMemoryHash(JSON.stringify(observations.map(part => [
    part.sessionId, part.messageId, part.sourceHash, part.available, part.retainedExcerpt, part.content,
  ]))) : undefined;
}
export function memorySourceTracePartContent(part: MemoryReadPart) {
  return isObservationMemorySource(part.sessionId ?? '')
    ? part.observationRecord ? prepareObservationFragment(part.observationRecord, 0, MAX_CONTEXT_CHARS - 320)?.content ?? '' : part.content
    : compactMessageContent(part.content);
}

export function memorySourceTraceItems(items: MemoryRecallItem[]) {
  return items.filter(item => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention').slice(0, MAX_MEMORIES);
}

/** Render the same source view from the locally verified batch, without another storage await. */
export function memorySourceDetailsFromSnapshots(input: LoadMemorySourceDetailsInput,
  snapshots: ReadonlyMap<string, MemoryReadSnapshot>): MemorySourceDetail[] {
  const terms = buildQueryTerms(input.route, input.userText);
  return memorySourceTraceItems(input.items).flatMap(({ memory }) => {
      const snapshot = snapshots.get(memory.id);
      if (!snapshot) return [];
      const parts = snapshot.parts.filter(part => part.kind === 'source');
      const legacy = memory.sourceTraceMode === 'legacy_range';
      const selectedIds = legacy ? new Set(selectWindowMessages(parts.map(part => ({
        id: `${part.sessionId}\0${part.messageId}`, role: part.role!, createdAt: part.createdAt!, content: part.content,
      })), terms).map(item => item.message.id)) : undefined;
      const messages: MemorySourceTraceMessage[] = parts.filter(part => !selectedIds || selectedIds.has(`${part.sessionId}\0${part.messageId}`))
        .map(part => ({ available: part.available === true, content: memorySourceTracePartContent(part),
          ...(part.context ? { context: part.context } : {}), createdAt: part.createdAt!,
          matched: part.available === true && (isObservationMemorySource(part.sessionId ?? '')
            ? terms.some(term => normalizeText(part.content).includes(normalizeText(term)))
            : messageMatchesTerms({ id: part.messageId!, role: part.role!, content: part.content, createdAt: part.createdAt! }, terms)),
          messageId: part.messageId!, ...(part.relation ? { relation: part.relation } : {}), retainedExcerpt: part.retainedExcerpt === true,
          sourceStatus: part.sourceStatus,
          sourceLabel: getMemorySourceStatusLabel(part.sourceStatus ?? getMemorySourceStatus({
            available: part.available === true, retainedExcerpt: part.retainedExcerpt === true, mode: memory.sourceTraceMode }),
            isObservationMemorySource(part.sessionId ?? '')),
          role: part.role!, sessionId: part.sessionId!,
        }));
      const detail = { memoryId: memory.id, title: memory.title, mode: memory.sourceTraceMode,
        ...(!messages.length ? { sourceStatus: 'missing' as const, sourceLabel: memorySourceStatusLabel.missing } : {}),
        sourceStartAt: memory.sourceStartAt ?? parts[0]?.createdAt,
        sourceEndAt: memory.sourceEndAt ?? parts.at(-1)?.createdAt,
        directCount: messages.filter(message => message.relation === 'direct').length,
        derivedCount: messages.filter(message => message.relation === 'derived').length,
        missingCount: messages.filter(message => !message.available).length, messages };
      const observationVersion = observationSourcePartsVersion(parts);
      if (observationVersion) observationSourceTraceVersions.set(detail, observationVersion);
      return [detail];
    });
}

const GENERIC_TERMS = new Set([
  '上次',
  '之前',
  '以前',
  '曾经',
  '当时',
  '具体',
  '原文',
  '原话',
  '细节',
  '步骤',
  '怎么',
  '如何',
  '记得',
  '回忆',
  '聊天',
  '小仓鼠',
  '白云',
  '白云小姐',
]);

function normalizeText(text: string) {
  return text.toLowerCase().replace(/\s+/g, '');
}

function pushTerm(terms: string[], value: string) {
  const normalized = value.trim();
  if (normalized.length < 2 || GENERIC_TERMS.has(normalized)) return;
  if (!terms.includes(normalized)) terms.push(normalized);
}

function extractTerms(text: string) {
  const terms: string[] = [];
  const normalized = text
    .replace(/[^\p{L}\p{N}\u3400-\u9fff]+/gu, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  normalized.forEach((term) => {
    if (/[\u3400-\u9fff]/.test(term)) {
      if (term.length <= 8) {
        pushTerm(terms, term);
      } else {
        for (let index = 0; index <= term.length - 2; index += 2) {
          pushTerm(terms, term.slice(index, index + 4));
        }
      }
      return;
    }
    pushTerm(terms, term);
  });
  return terms;
}

function buildQueryTerms(route: MemoryRecallRoute | null | undefined, userText: string) {
  const terms: string[] = [];
  route?.keywords.forEach((keyword) => pushTerm(terms, keyword));
  extractTerms(route?.topic ?? '').forEach((term) => pushTerm(terms, term));
  extractTerms(userText).forEach((term) => pushTerm(terms, term));
  return terms.slice(0, 12);
}

function messageMatchesTerms(message: SubjectiveMessage, terms: string[]) {
  if (!terms.length) return false;
  const content = normalizeText(message.content);
  return terms.some((term) => content.includes(normalizeText(term)));
}

function compactMessageContent(content: string) {
  return content
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function formatMessageTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    day: '2-digit',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: '2-digit',
  });
}

function selectWindowMessages(messages: SubjectiveMessage[], terms: string[]) {
  if (messages.length <= MAX_MESSAGES_PER_MEMORY) {
    return messages.map((message) => ({ message, matched: messageMatchesTerms(message, terms) }));
  }

  const matchedIndexes = messages
    .map((message, index) => ({ index, matched: messageMatchesTerms(message, terms) }))
    .filter((item) => item.matched)
    .map((item) => item.index);

  if (!matchedIndexes.length) {
    return messages.slice(0, MAX_MESSAGES_PER_MEMORY).map((message) => ({ message, matched: false }));
  }

  const selectedIndexes = new Set<number>();
  for (const index of matchedIndexes) {
    for (let offset = -1; offset <= 1; offset += 1) {
      const nextIndex = index + offset;
      if (nextIndex >= 0 && nextIndex < messages.length) selectedIndexes.add(nextIndex);
      if (selectedIndexes.size >= MAX_MESSAGES_PER_MEMORY) break;
    }
    if (selectedIndexes.size >= MAX_MESSAGES_PER_MEMORY) break;
  }

  return [...selectedIndexes]
    .sort((left, right) => left - right)
    .map((index) => ({
      matched: matchedIndexes.includes(index),
      message: messages[index],
    }));
}

export function buildSourceTraceContext(details: MemorySourceDetail[], maxChars = MAX_CONTEXT_CHARS) {
  if (!details.length) return '';
  const lines: string[] = [
    '【原文追溯】',
    getMemorySpeechPolicy('sourceTrace').promptInstruction,
  ];
  let usedChars = lines.join('\n').length;

  for (const detail of details.slice(0, MAX_MEMORIES)) {
    const header = `- 关联记忆：${detail.title}${!detail.messages.length ? ` [${memorySourceStatusLabel.missing}]` : ''}`;
    if (usedChars + header.length + 1 > Math.min(MAX_CONTEXT_CHARS, maxChars)) break;
    lines.push(header);
    usedChars += header.length + 1;
    for (const message of detail.messages.slice(0, MAX_MESSAGES_PER_MEMORY)) {
      const role = message.role;
      const observation = isObservationMemorySource(message.sessionId);
      const marker = getMemorySourceStatusLabel(getMemorySourceStatus({ ...message, mode: detail.mode }), observation);
      const readable = message.available || message.retainedExcerpt;
      const line = observation ? `${marker}\n${readable ? message.content : ''}`
        : `${readable && message.context ? `${message.context}\n` : ''}  - [${formatMessageTime(message.createdAt)}｜${role}｜${marker}] ${readable ? message.content : ''}`;
      if (usedChars + line.length + 1 > Math.min(MAX_CONTEXT_CHARS, maxChars)) return lines.join('\n');
      lines.push(line);
      usedChars += line.length + 1;
    }
  }

  return lines.join('\n');
}

export async function loadMemorySourceDetails({
  items,
  route,
  userText,
}: LoadMemorySourceDetailsInput): Promise<MemorySourceTraceResult> {
  const debug = {
    candidates: 0,
    exact: 0,
    legacyRange: 0,
    matched: 0,
    missingMessages: 0,
    missingRange: 0,
    none: 0,
  };
  const traceable = items
    .filter((item) => item.reason !== 'quiet_context' && item.reason !== 'suggested_mention')
    .slice(0, MAX_MEMORIES);
  debug.candidates = traceable.length;
  if (!traceable.length) return { context: '', debug, details: [] };

  const terms = buildQueryTerms(route, userText);
  const sessionCache = new Map<string, Promise<SubjectiveMessage[]>>();
  let postKnowledge: Promise<PostMemoryKnowledgeSnapshot> | undefined;
  const loadSession = (sessionId: string) => {
    const existing = sessionCache.get(sessionId);
    if (existing) return existing;
    const pending = sessionId.startsWith('post-source:')
      ? (postKnowledge ??= import('../posts/baiyunPostMemorySource').then(module => module.loadPostMemoryKnowledgeSnapshot()))
        .then(knowledge => loadMemorySourceMessages(sessionId, { knowledge }))
      : loadMemorySourceMessages(sessionId);
    sessionCache.set(sessionId, pending);
    return pending;
  };
  let legacyState: Awaited<ReturnType<typeof loadChatState>> | null = null;

  const details: MemorySourceDetail[] = [];
  for (const item of traceable) {
    const { memory } = item;
    if (memory.sourceTraceMode === 'none') {
      debug.none += 1;
      details.push({
        directCount: 0,
        derivedCount: 0,
        memoryId: memory.id,
        messages: [],
        missingCount: 0,
        mode: 'none',
        sourceEndAt: memory.sourceEndAt ?? undefined,
        sourceStartAt: memory.sourceStartAt ?? undefined,
        sourceStatus: 'missing', sourceLabel: memorySourceStatusLabel.missing,
        title: memory.title,
      });
      continue;
    }

    if (memory.sourceTraceMode === 'exact') {
      debug.exact += 1;
      const refs = await loadMemorySourceRefs(memory.id);
      const messages: MemorySourceTraceMessage[] = [];
      const observationParts: MemoryReadPart[] = [];
      for (const ref of refs) {
        if (isObservationMemorySource(ref.sessionId)) {
          const part = await (await import('./memoryReadMaterials')).loadObservationReadPart(ref);
          observationParts.push(part);
          if (!part.available) debug.missingMessages += 1;
          messages.push({ available: part.available === true, content: memorySourceTracePartContent(part),
            createdAt: part.createdAt!, matched: !!part.available && terms.some(term => normalizeText(part.content).includes(normalizeText(term))),
            messageId: ref.messageId, relation: ref.relation, sourceStatus: part.sourceStatus, sourceLabel: part.sourceLabel,
            retainedExcerpt: part.retainedExcerpt === true, role: 'I', sessionId: ref.sessionId });
          continue;
        }
        const stored = (await loadSession(ref.sessionId)).find((message) => (
          message.id === ref.messageId && message.role === ref.role
        ));
        const available = !!stored;
        if (!available) debug.missingMessages += 1;
        const content = compactMessageContent(stored?.content ?? ref.excerpt ?? '');
        const context = stored ? getReadingMemorySourceContext(stored) || getVoiceCallMemorySourceContext(stored) || getTheaterBackstageContext(stored) : '';
        const sourceStatus = getMemorySourceStatus({ available, retainedExcerpt: !available && !!ref.excerpt, mode: 'exact' });
        messages.push({
          available,
          content,
          ...(context ? { context } : {}),
          createdAt: stored?.createdAt ?? ref.messageCreatedAt,
          matched: available ? messageMatchesTerms(stored, terms) : false,
          messageId: ref.messageId,
          relation: ref.relation,
          sourceStatus, sourceLabel: memorySourceStatusLabel[sourceStatus],
          retainedExcerpt: !available && !!ref.excerpt,
          role: ref.role,
          sessionId: ref.sessionId,
        });
      }
      if (messages.some((message) => message.available)) debug.matched += 1;
      const detail: MemorySourceDetail = {
        directCount: refs.filter((ref) => ref.relation === 'direct').length,
        derivedCount: refs.filter((ref) => ref.relation === 'derived').length,
        memoryId: memory.id,
        messages,
        missingCount: messages.filter((message) => !message.available).length,
        mode: 'exact',
        sourceEndAt: memory.sourceEndAt ?? refs.at(-1)?.messageCreatedAt,
        sourceStartAt: memory.sourceStartAt ?? refs[0]?.messageCreatedAt,
        ...(!messages.length ? { sourceStatus: 'missing' as const, sourceLabel: memorySourceStatusLabel.missing } : {}),
        title: memory.title,
      };
      const observationVersion = observationSourcePartsVersion(observationParts);
      if (observationVersion) observationSourceTraceVersions.set(detail, observationVersion);
      details.push(detail);
      continue;
    }

    debug.legacyRange += 1;
    const missingDetail: MemorySourceDetail = { memoryId: memory.id, title: memory.title, mode: memory.sourceTraceMode,
      directCount: 0, derivedCount: 0, missingCount: 0, messages: [],
      sourceStartAt: memory.sourceStartAt ?? undefined, sourceEndAt: memory.sourceEndAt ?? undefined,
      sourceStatus: 'missing', sourceLabel: memorySourceStatusLabel.missing };
    if (!Number.isFinite(memory.sourceStartAt) || !Number.isFinite(memory.sourceEndAt)
      || memory.sourceEndAt! < memory.sourceStartAt!) {
      debug.missingRange += 1;
      details.push(missingDetail);
      continue;
    }

    legacyState ??= await loadChatState();
    const sessionByMessage = new Map<SubjectiveMessage, string>();
    const allMessages = legacyState.sessions
      .flatMap((session) => session.messages.map((message) => {
        sessionByMessage.set(message, session.id);
        return message;
      }))
      .filter((message) => message.role === 'you' || message.role === 'I')
      .sort((left, right) => left.createdAt - right.createdAt);
    const start = memory.sourceStartAt! - WINDOW_PADDING_MS;
    const end = memory.sourceEndAt! + WINDOW_PADDING_MS;
    const messages = allMessages.filter((message) => message.createdAt >= start && message.createdAt <= end);
    if (!messages.length) {
      debug.missingMessages += 1;
      details.push(missingDetail);
      continue;
    }

    const selected = selectWindowMessages(messages, terms)
      .map(({ matched, message }): MemorySourceTraceMessage => ({
        available: true,
        content: compactMessageContent(message.content),
        ...(getTheaterBackstageContext(message) ? { context: getTheaterBackstageContext(message) } : {}),
        createdAt: message.createdAt,
        matched,
        messageId: message.id,
        sourceStatus: 'legacy_range', sourceLabel: memorySourceStatusLabel.legacy_range,
        retainedExcerpt: false,
        role: message.role,
        sessionId: sessionByMessage.get(message)!,
      }))
      .filter((message) => message.content);
    if (!selected.length) {
      debug.missingMessages += 1;
      details.push(missingDetail);
      continue;
    }

    debug.matched += 1;
    details.push({
      memoryId: memory.id,
      directCount: 0,
      derivedCount: 0,
      messages: selected,
      missingCount: 0,
      mode: 'legacy_range',
      sourceEndAt: memory.sourceEndAt!,
      sourceStartAt: memory.sourceStartAt!,
      title: memory.title,
    });
  }

  return {
    context: buildSourceTraceContext(details),
    debug,
    details,
  };
}

export async function loadMemorySourceSelectionCandidates(memory: MemoryEntry) {
  if (memory.sourceTraceMode === 'legacy_range' && (!Number.isFinite(memory.sourceStartAt)
    || !Number.isFinite(memory.sourceEndAt) || memory.sourceEndAt! < memory.sourceStartAt!)) return [];
  const refs = memory.sourceTraceMode === 'exact' ? await loadMemorySourceRefs(memory.id) : [];
  const sessionIds = memory.sourceTraceMode === 'exact'
    ? Array.from(new Set(refs.map((ref) => ref.sessionId)))
    : [];
  const startAt = (memory.sourceStartAt ?? refs[0]?.messageCreatedAt ?? memory.createdAt) - WINDOW_PADDING_MS;
  const endAt = (memory.sourceEndAt ?? refs.at(-1)?.messageCreatedAt ?? memory.createdAt) + WINDOW_PADDING_MS;
  if (sessionIds.length) {
    const groups = await Promise.all(sessionIds.map(async (sessionId) => ({
      messages: (await loadMemorySourceMessages(sessionId)).filter((message) => (
        isLetterMemorySource(sessionId) || sessionId.startsWith('post-source:')
          ? refs.some(ref => ref.sessionId === sessionId && ref.messageId === message.id && ref.role === message.role)
          : message.createdAt >= startAt && message.createdAt <= endAt
      )),
      sessionId,
    })));
    return groups.filter((group) => group.messages.length);
  }
  if (memory.sourceTraceMode !== 'legacy_range') return [];
  const state = await loadChatState();
  return state.sessions
    .map((session) => ({
      messages: session.messages.filter((message) => message.createdAt >= startAt && message.createdAt <= endAt),
      sessionId: session.id,
    }))
    .filter((group) => group.messages.length);
}
