import type { ShiyingMemorySnapshot, ShiyingMemoryRange } from './shiyingMemorySource';
import { takeReadingPunctuationPrefix, restoreReadingOrganizationReferences,
  type ReadingCorrectionComparison } from '../reading/readingMemoryOrganizationProtocol';

export const SHIYING_ORGANIZATION_CHARACTER_LIMIT = 6000;
export const SHIYING_ORGANIZER_OPENING = 'I 把这批材料里想记住的事，整理成记忆。';
export const SHIYING_ORGANIZER_RULES = '同一段经历写过、说过几遍，I 仍只算一次。\n纸条改了，I 对照新原文更正旧记忆。';
export type ShiyingOrganizationRanges = { body?: ShiyingMemoryRange; imageNote?: ShiyingMemoryRange };
export type ShiyingOrganizationReferences = { body?: string; imageNote?: string };
export type ShiyingOrganizationReferenceMap = { messageRefs: ReadonlyMap<string, string>; memoryRefs: ReadonlyMap<string, string> };
function invalid(): never { throw new Error('SHIYING_MEMORY_SOURCE_INVALID'); }
function selected(text: string, range: ShiyingMemoryRange | undefined) {
  if (!range) return null;
  if (![range.start, range.end].every(Number.isSafeInteger) || range.start < 0 || range.end <= range.start
    || range.end > text.length) return invalid();
  return { text: text.slice(range.start, range.end), full: range.start === 0 && range.end === text.length };
}
function parts(snapshot: ShiyingMemorySnapshot, ranges: ShiyingOrganizationRanges) {
  return [
    { key: 'body' as const, role: 'you', label: '正文', value: selected(snapshot.body, ranges.body) },
    { key: 'imageNote' as const, role: 'I', label: '图片记录',
      value: snapshot.imageNote ? selected(snapshot.imageNote.body, ranges.imageNote) : ranges.imageNote ? invalid() : null },
  ].filter(part => part.value !== null);
}
export function renderShiyingOrganizationMaterial(snapshot: ShiyingMemorySnapshot,
  references: ShiyingOrganizationReferences, ranges: ShiyingOrganizationRanges) {
  const values = parts(snapshot, ranges);
  if (!values.length) return '';
  return [`【拾荧纸条｜${snapshot.recordDate}】`, ...values.map(part => {
    const reference = references[part.key];
    if (!reference || !/^S[1-9]\d*$/u.test(reference)) return invalid();
    return `[messageId=${reference}] ${part.role}：\n${part.label}（${part.value!.full ? '全文' : '片段'}）：${part.value!.text}`;
  })].join('\n\n').replace('】\n\n[messageId=', '】\n[messageId=');
}
export function renderShiyingMemoryMaterial(snapshot: ShiyingMemorySnapshot,
  options: { reference: string | number; ranges: ShiyingOrganizationRanges }) {
  const values = parts(snapshot, options.ranges);
  if (!values.length) return '';
  return [`[记忆 ${options.reference}]【拾荧纸条｜${snapshot.recordDate}】`,
    ...values.map(part => `${part.role}：\n${part.label}（${part.value!.full ? '全文' : '片段'}）：${part.value!.text}`)]
    .join('\n\n').replace('】\n\nyou：', '】\nyou：').replace('】\n\nI：', '】\nI：');
}
export function prepareShiyingOrganizationFragment(snapshot: ShiyingMemorySnapshot,
  options: { bodyStart: number; imageNoteStart: number; references: ShiyingOrganizationReferences },
  limit = SHIYING_ORGANIZATION_CHARACTER_LIMIT): { status: 'ready'; content: string; ranges: ShiyingOrganizationRanges;
    nextBodyOffset: number; nextImageNoteOffset: number; characterCount: number } | { status: 'blocked' | 'done' } {
  const texts = { body: snapshot.body, imageNote: snapshot.imageNote?.body ?? '' };
  const starts = { body: options.bodyStart, imageNote: options.imageNoteStart };
  if (!Object.keys(starts).every(key => {
    const name = key as keyof typeof starts, start = starts[name], text = texts[name];
    return Number.isSafeInteger(start) && start >= 0 && start <= text.length
      && !(start > 0 && start < text.length && /[\uD800-\uDBFF]/u.test(text[start - 1]) && /[\uDC00-\uDFFF]/u.test(text[start]));
  })) return invalid();
  if (starts.body >= texts.body.length && starts.imageNote >= texts.imageNote.length) return { status: 'done' };
  const budget = Math.min(SHIYING_ORGANIZATION_CHARACTER_LIMIT, Math.floor(limit)) - 2;
  const ranges: ShiyingOrganizationRanges = {};
  for (const key of ['body', 'imageNote'] as const) {
    const start = starts[key], text = texts[key];
    if (start >= text.length || !text.slice(start).trim()) continue;
    const overhead = renderShiyingOrganizationMaterial(snapshot, options.references,
      { ...ranges, [key]: { start, end: text.length } }).length - (text.length - start);
    const prefix = takeReadingPunctuationPrefix(text.slice(start), budget - overhead);
    if (prefix) ranges[key] = { start, end: start + prefix.length };
  }
  const content = renderShiyingOrganizationMaterial(snapshot, options.references, ranges);
  if (!content || content.length > budget) return { status: 'blocked' };
  return { status: 'ready', content, ranges, nextBodyOffset: ranges.body?.end ?? starts.body,
    nextImageNoteOffset: ranges.imageNote?.end ?? starts.imageNote, characterCount: content.length + 2 };
}
export function createShiyingOrganizationReferences(messageIds: readonly string[], memoryIds: readonly string[],
  reservedIds: readonly string[] = []): ShiyingOrganizationReferenceMap {
  const reserved = new Set([...reservedIds, ...messageIds, ...memoryIds]);
  const create = (ids: readonly string[], prefix: string) => {
    const result = new Map<string, string>(); let ordinal = 0;
    for (const id of ids) {
      if (result.has(id)) continue;
      let alias: string; do { alias = `${prefix}${++ordinal}`; } while (reserved.has(alias));
      reserved.add(alias); result.set(id, alias);
    }
    return result;
  };
  return { messageRefs: create(messageIds, 'S'), memoryRefs: create(memoryIds, 'M') };
}
export const restoreShiyingOrganizationReferences = restoreReadingOrganizationReferences;
export function renderShiyingCorrectionComparison(input: Omit<ReadingCorrectionComparison, 'readingReferences'> & { shiyingReferences: readonly string[] }) {
  if (!/^M[1-9]\d*$/u.test(input.reference) || !input.shiyingReferences.length
    || input.shiyingReferences.some(id => !/^S[1-9]\d*$/u.test(id))) return invalid();
  const fields: Array<[string, string | undefined]> = [
    ['类型', input.kind], ['认识对象', input.understandingSubject], ['标题', input.title], ['正文', input.content],
    ['时间', input.time], ['标签', input.tags?.join('、')], ['回想线索', input.recallCues?.join('、')],
    ['记住的理由', input.rememberedReason], ['补记', input.comments], ['对应纸条', input.shiyingReferences.join('、')],
  ];
  return ['【旧记忆｜更正对照】', `[memoryId=${input.reference}]`,
    ...fields.flatMap(([label, value]) => value === undefined ? [] : [`${label}：${value}`])].join('\n');
}
