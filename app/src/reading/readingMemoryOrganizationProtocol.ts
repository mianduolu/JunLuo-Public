import type { ReadingMemorySourceSnapshot } from './readingMemorySource';

export const READING_ORGANIZATION_CHARACTER_LIMIT = 6000;
export const READING_ORGANIZER_PROMPT = `I 把这批聊天、观察和阅读里想记住的事，整理成记忆。
I 先写书里的内容，再写自己读后的想法和感受。
同一场阅读的批注和读后感，I 放在同一次经历里。
阅读记录改了，I 对照新原文更正旧记忆。`;
export const READING_BATCH_MATERIAL_HEADING = '【本批整理材料】';
const PUNCTUATION_BOUNDARIES = /(?:[。！？!?，；;、：]+|,(?!\d)|:(?=\s|$)|\.(?=\s|$)|\r?\n)[”’"'）)\]】》」』]*/gu;

export type ReadingOrganizationTextRange = { start: number; end: number };
export type ReadingOrganizationReferences = {
  messageRefs: ReadonlyMap<string, string>;
  memoryRefs: ReadonlyMap<string, string>;
};
export type ReadingOrganizationFragment = {
  status: 'ready';
  content: string;
  messageId: string;
  sourceMessageId: string;
  reference: string;
  bookText: string;
  messageContent: string;
  bookRange: ReadingOrganizationTextRange;
  contentRange: ReadingOrganizationTextRange;
  nextBookOffset: number;
  nextContentOffset: number;
  fullBook: boolean;
  fullContent: boolean;
  characterCount: number;
};
export type ReadingOrganizationFragmentResult = ReadingOrganizationFragment | { status: 'blocked' | 'done' };

function invalid(): never { throw new Error('READING_ORGANIZATION_SOURCE_INVALID'); }

export function formatReadingOrganizationDate(timestamp: number) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return invalid();
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Boundaries preserve their punctuation and closing quotes. Decimal points are not stops. */
export function takeReadingPunctuationPrefix(text: string, budget: number) {
  if (!Number.isFinite(budget) || budget <= 0) return '';
  if (text.length <= Math.floor(budget)) return text;
  let end = 0;
  for (const match of text.matchAll(PUNCTUATION_BOUNDARIES)) {
    const next = match.index! + match[0].length;
    if (next > budget) break;
    end = next;
  }
  return text.slice(0, end);
}

function firstRange(text: string, start: number): ReadingOrganizationTextRange {
  if (start === text.length) return { start, end: start };
  const remaining = text.slice(start);
  for (const match of remaining.matchAll(PUNCTUATION_BOUNDARIES)) {
    const end = start + match.index! + match[0].length;
    if (text.slice(start, end).trim()) return { start, end };
  }
  return { start, end: text.length };
}

function validStart(text: string, start: number) {
  return Number.isSafeInteger(start) && start >= 0 && start <= text.length
    && !(start > 0 && start < text.length && /[\uD800-\uDBFF]/.test(text[start - 1]) && /[\uDC00-\uDFFF]/.test(text[start]));
}

function readingMessage(snapshot: ReadingMemorySourceSnapshot) {
  if (!['annotation', 'summary'].includes(snapshot.binding.kind) || snapshot.messages.length !== 1) return invalid();
  const message = snapshot.messages[0];
  if (message.role !== 'I' || !message.content.trim()) return invalid();
  return message;
}

export function renderReadingOrganizationMaterial(snapshot: ReadingMemorySourceSnapshot, reference: string,
  bookRange: ReadingOrganizationTextRange, contentRange: ReadingOrganizationTextRange) {
  const message = readingMessage(snapshot);
  if (!/^R[1-9]\d*$/.test(reference)
    || !validStart(snapshot.bookText, bookRange.start) || !validStart(snapshot.bookText, bookRange.end)
    || !validStart(message.content, contentRange.start) || !validStart(message.content, contentRange.end)
    || bookRange.end < bookRange.start || contentRange.end <= contentRange.start) return invalid();
  const header = [`《${snapshot.book.title}》`, snapshot.item.chapterTitle, snapshot.item.positionLabel].filter(Boolean).join('｜');
  const book = bookRange.end > bookRange.start
    ? `书中内容（${bookRange.start === 0 && bookRange.end === snapshot.bookText.length ? '全文' : '片段'}）：\n${snapshot.bookText.slice(bookRange.start, bookRange.end)}` : '';
  const kind = snapshot.binding.kind === 'annotation' ? '批注' : '读后感';
  return `【阅读记录｜${header}】\n${book ? `${book}\n\n` : ''}`
    + `[messageId=${reference}][date=${formatReadingOrganizationDate(message.createdAt)}] I：\n${kind}（${contentRange.start === 0 && contentRange.end === message.content.length ? '全文' : '片段'}）：${message.content.slice(contentRange.start, contentRange.end)}`;
}

/** A completed side contributes only a small already-read context; its cursor never moves backwards. */
export function prepareReadingOrganizationFragment(snapshot: ReadingMemorySourceSnapshot,
  input: { messageId: string; reference: string; bookStart?: number; contentStart?: number },
  limit = READING_ORGANIZATION_CHARACTER_LIMIT): ReadingOrganizationFragmentResult {
  const message = readingMessage(snapshot);
  const bookStart = input.bookStart ?? 0;
  const contentStart = input.contentStart ?? 0;
  if (!input.messageId || !/^R[1-9]\d*$/.test(input.reference)
    || !validStart(snapshot.bookText, bookStart) || !validStart(message.content, contentStart)) return invalid();
  const bookUnread = bookStart < snapshot.bookText.length;
  const contentUnread = contentStart < message.content.length;
  if (!bookUnread && !contentUnread) return { status: 'done' };
  const budget = Math.min(READING_ORGANIZATION_CHARACTER_LIMIT, Math.floor(limit)) - 2;
  if (!Number.isFinite(budget) || budget <= 0) return { status: 'blocked' };
  const bookMinimum = firstRange(snapshot.bookText, bookUnread ? bookStart : 0);
  const contentMinimum = firstRange(message.content, contentUnread ? contentStart : 0);
  let bookRange = bookUnread ? { start: bookStart, end: snapshot.bookText.length } : bookMinimum;
  let contentRange = contentUnread ? { start: contentStart, end: message.content.length } : contentMinimum;
  const render = () => renderReadingOrganizationMaterial(snapshot, input.reference, bookRange, contentRange);
  if (render().length > budget) {
    bookRange = bookMinimum;
    contentRange = contentMinimum;
    const minimumLength = render().length;
    if (minimumLength > budget) return { status: 'blocked' };
    const overhead = minimumLength - (bookRange.end - bookRange.start) - (contentRange.end - contentRange.start);
    const available = budget - overhead;
    const grow = (which: 'book' | 'content', allocation: number) => {
      if (which === 'book' ? !bookUnread : !contentUnread) return;
      const text = which === 'book' ? snapshot.bookText : message.content;
      const range = which === 'book' ? bookRange : contentRange;
      const prefix = takeReadingPunctuationPrefix(text.slice(range.start), allocation);
      if (prefix.length >= range.end - range.start) range.end = range.start + prefix.length;
    };
    const contentMinimumSize = contentRange.end - contentRange.start;
    const bookAllocation = bookUnread && contentUnread
      ? Math.min(available - contentMinimumSize, Math.max(bookRange.end - bookRange.start, Math.floor(available / 2)))
      : available - contentMinimumSize;
    grow('book', bookAllocation);
    grow('content', available - (bookRange.end - bookRange.start));
    grow('book', available - (contentRange.end - contentRange.start));
    grow('content', available - (bookRange.end - bookRange.start));
  }
  const content = render();
  if (content.length > budget) return { status: 'blocked' };
  return { status: 'ready', content, messageId: input.messageId, sourceMessageId: message.id,
    reference: input.reference, bookText: snapshot.bookText.slice(bookRange.start, bookRange.end),
    messageContent: message.content.slice(contentRange.start, contentRange.end), bookRange, contentRange,
    nextBookOffset: bookUnread ? bookRange.end : bookStart,
    nextContentOffset: contentUnread ? contentRange.end : contentStart,
    fullBook: bookRange.start === 0 && bookRange.end === snapshot.bookText.length,
    fullContent: contentRange.start === 0 && contentRange.end === message.content.length,
    characterCount: content.length + 2 };
}

export function createReadingOrganizationReferences(messageIds: readonly string[], memoryIds: readonly string[],
  reservedIds: readonly string[] = []): ReadingOrganizationReferences {
  const reserved = new Set([...reservedIds, ...messageIds, ...memoryIds]);
  const create = (ids: readonly string[], prefix: 'R' | 'M') => {
    const result = new Map<string, string>();
    let ordinal = 0;
    for (const id of ids) {
      if (typeof id !== 'string' || !id) return invalid();
      if (result.has(id)) continue;
      let reference: string;
      do { reference = `${prefix}${++ordinal}`; } while (reserved.has(reference));
      reserved.add(reference);
      result.set(id, reference);
    }
    return result;
  };
  return { messageRefs: create(messageIds, 'R'), memoryRefs: create(memoryIds, 'M') };
}

export function restoreReadingOrganizationReferences(candidates: readonly unknown[], references: ReadingOrganizationReferences,
  allowedMessageIds: ReadonlySet<string>, allowedMemoryIds: ReadonlySet<string>) {
  const restoreWith = (refs: ReadonlyMap<string, string>, allowed: ReadonlySet<string>) => {
    const originals = new Map([...refs].map(([id, reference]) => [reference, id]));
    return (value: unknown) => {
      if (typeof value !== 'string') return invalid();
      const original = originals.get(value);
      if (original !== undefined) return original;
      if (!refs.has(value) && allowed.has(value)) return value;
      return invalid();
    };
  };
  const message = restoreWith(references.messageRefs, allowedMessageIds);
  const memory = restoreWith(references.memoryRefs, allowedMemoryIds);
  const list = (value: unknown, restore: (item: unknown) => string) => {
    if (!Array.isArray(value)) return invalid();
    const restored = value.map(restore);
    if (new Set(restored).size !== restored.length) return invalid();
    return restored;
  };
  const sourceFields = (value: Record<string, unknown>) => ({
    ...('sourceMessageIds' in value ? { sourceMessageIds: list(value.sourceMessageIds, message) } : {}),
    ...('sourceMemoryIds' in value ? { sourceMemoryIds: list(value.sourceMemoryIds, memory) } : {}),
  });
  return candidates.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const candidate = value as Record<string, unknown>;
    const eventTime = candidate.eventTime && typeof candidate.eventTime === 'object' && !Array.isArray(candidate.eventTime)
      ? candidate.eventTime as Record<string, unknown> : undefined;
    return { ...candidate, ...sourceFields(candidate),
      ...(candidate.targetMemoryId != null ? { targetMemoryId: memory(candidate.targetMemoryId) } : {}),
      ...(eventTime?.timeSourceMessageId != null ? { eventTime: { ...eventTime,
        timeSourceMessageId: message(eventTime.timeSourceMessageId) } } : {}),
      ...(Array.isArray(candidate.patternEvidence) ? { patternEvidence: candidate.patternEvidence.map(occurrence => {
        if (!occurrence || typeof occurrence !== 'object' || Array.isArray(occurrence)) return occurrence;
        return { ...occurrence, ...sourceFields(occurrence as Record<string, unknown>) };
      }) } : {}),
    };
  });
}

export type ReadingCorrectionComparison = {
  reference: string;
  kind?: string;
  understandingSubject?: 'I' | 'you';
  title: string;
  content: string;
  time?: string;
  tags?: readonly string[];
  recallCues?: readonly string[];
  rememberedReason?: string;
  comments?: string;
  readingReferences: readonly string[];
};

export function renderReadingCorrectionComparison(input: ReadingCorrectionComparison) {
  if (!/^M[1-9]\d*$/.test(input.reference) || !input.title || !input.content
    || !input.readingReferences.length || input.readingReferences.some(id => !/^R[1-9]\d*$/.test(id))) return invalid();
  const fields: Array<[string, string | undefined]> = [
    ['类型', input.kind], ['认识对象', input.understandingSubject], ['标题', input.title], ['正文', input.content],
    ['时间', input.time], ['标签', input.tags?.join('、')], ['回想线索', input.recallCues?.join('、')],
    ['记住的理由', input.rememberedReason], ['补记', input.comments], ['对应阅读', input.readingReferences.join('、')],
  ];
  return ['【旧记忆｜更正对照】', `[memoryId=${input.reference}]`,
    ...fields.flatMap(([label, value]) => value === undefined ? [] : [`${label}：${value}`])].join('\n');
}
