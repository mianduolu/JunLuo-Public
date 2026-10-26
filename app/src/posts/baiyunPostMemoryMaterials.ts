import { stableMemoryHash } from '../memory/memoryAtomicity';
import { takeWeeklySentencePrefix } from '../memory/memoryWeeklyMaterialText';
import { postMemoryMessage, type PostMaterialBinding, type PostMaterialRange, type PostMemoryMessage, type PostMemoryOriginal } from './baiyunPostMemorySource';

export const POST_MEMORY_MATERIAL_LIMIT = 6000;
export const POST_MEMORY_ORGANIZER_PROMPT = `【从动态里留下记忆】
I 从动态和留言里的新内容，整理想记住的事。
前情只帮 I 看懂新内容，不再重复出卡。
愿望和想象，I 记作想法，不写成已经发生的事。
原动态或留言改过了，I 对照新原文改正旧记忆，不再另记一次。`;
export type PreparedPostMemoryMaterials = {
  text: string; originals: PostMemoryOriginal[]; messages: PostMemoryMessage[]; bindings: PostMaterialBinding[];
  newRanges: PostMaterialRange[]; blocked: { sessionId: string; messageId: string; sourceHash: string; start: number }[]; hasMore: boolean;
};

function rangeIdentity(range: Pick<PostMaterialRange, 'sessionId' | 'messageId' | 'sourceHash'>) {
  return JSON.stringify([range.sessionId, range.messageId, range.sourceHash]);
}
/** Find the first unconsumed interval. Old-version offsets cannot apply to changed text. */
export function firstUnprocessedPostRange(original: PostMemoryOriginal, processed: readonly PostMaterialRange[]) {
  const ranges = processed.filter(range => rangeIdentity(range) === rangeIdentity(original)
    && Number.isSafeInteger(range.start) && Number.isSafeInteger(range.end)
    && range.start >= 0 && range.end > range.start && range.end <= original.content.length)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  let start = 0;
  for (const range of ranges) {
    if (range.end <= start) continue;
    if (range.start > start) return { start, end: range.start };
    start = Math.max(start, range.end);
  }
  return { start, end: original.content.length };
}
export function renderPostMemoryMaterial(original: PostMemoryOriginal, binding: Pick<PostMaterialBinding, 'start' | 'end' | 'purpose'>) {
  const content = original.content.slice(binding.start, binding.end);
  return `【${binding.purpose === 'new' ? '本次新内容' : '前情'}｜${original.kind === 'post' ? '原动态' : '留言'}】\n`
    + `[messageId=${original.messageId}][time=${new Date(original.createdAt).toISOString()}] ${original.role}：\n`
    + `正文（${binding.start === 0 && binding.end === original.content.length ? '全文' : '片段'}）：${content}`;
}
function bindingFor(original: PostMemoryOriginal, start: number, end: number, purpose: 'new' | 'context'): PostMaterialBinding {
  return { version: 1, postId: original.postId, sessionId: original.sessionId, messageId: original.messageId,
    sourceHash: original.sourceHash, start, end, sentHash: stableMemoryHash(original.content.slice(start, end)), purpose };
}
function firstSentenceLength(text: string) {
  const match = /(?:[。！？!?]+|\.(?=\s|$)|\r?\n)[”’"'）)\]】》」』]*/u.exec(text);
  return match ? match.index + match[0].length : text.length;
}

/** Pure preparation. Only settled ranges belong in processed; pending batches are handled by the caller's gate. */
export function preparePostMemoryMaterials(originals: readonly PostMemoryOriginal[], processed: readonly PostMaterialRange[],
  options: { characterLimit?: number } = {}): PreparedPostMemoryMaterials {
  const limit = Math.min(POST_MEMORY_MATERIAL_LIMIT, Math.max(0, options.characterLimit ?? POST_MEMORY_MATERIAL_LIMIT));
  const ordered = [...originals].sort((a, b) => a.availableAt - b.availableAt || a.createdAt - b.createdAt
    || a.postId.localeCompare(b.postId) || a.messageId.localeCompare(b.messageId));
  const identities = ordered.map(rangeIdentity);
  if (new Set(identities).size !== identities.length) throw new Error('POST_MEMORY_SOURCE_CONFLICT');
  const groups = new Map<string, { original: PostMemoryOriginal; binding: PostMaterialBinding }[]>();
  const blocks: { sessionId: string; messageId: string; sourceHash: string; start: number }[] = [];
  let size = 0;
  const added = new Set<string>();
  const pending = ordered.filter(item => {
    const range = firstUnprocessedPostRange(item, processed);
    return !!item.content.slice(range.start, range.end).trim();
  });
  for (const item of pending) {
    if (added.has(rangeIdentity(item))) continue;
    const range = firstUnprocessedPostRange(item, processed);
    const group = groups.get(item.postId);
    const opening = group ? '' : `【动态｜postId=${item.postId}】\n`;
    const separator = group ? 2 : groups.size ? 2 : 0;
    const headerLength = renderPostMemoryMaterial(item, { start: range.start, end: range.start, purpose: 'new' }).length;
    // Reserve one complete original-post sentence before filling a group's first new comment.
    // This keeps the topic visible even when the new comments alone would fill the budget.
    const context = !group && item.kind === 'comment' ? ordered.find(source => source.postId === item.postId
      && source.kind === 'post' && !added.has(rangeIdentity(source))) : undefined;
    const contextBinding = context ? bindingFor(context, 0, firstSentenceLength(context.content), 'context') : undefined;
    const contextCost = context && contextBinding ? renderPostMemoryMaterial(context, contextBinding).length + 2 : 0;
    const minimumNew = firstSentenceLength(item.content.slice(range.start, range.end));
    const remaining = limit - size - opening.length - separator - headerLength;
    const useContext = context && contextBinding && contextCost + minimumNew <= remaining;
    const budget = remaining - (useContext ? contextCost : 0);
    const content = takeWeeklySentencePrefix(item.content.slice(range.start, range.end), budget);
    if (!content.trim()) {
      // A large item should not hold up unrelated posts. Mark only intrinsically overlong first sentences.
      const fullBudget = limit - `【动态｜postId=${item.postId}】\n`.length - headerLength;
      if (!takeWeeklySentencePrefix(item.content.slice(range.start, range.end), fullBudget).trim()) {
        blocks.push({ sessionId: item.sessionId, messageId: item.messageId, sourceHash: item.sourceHash, start: range.start });
      }
      continue;
    }
    const binding = bindingFor(item, range.start, range.start + content.length, 'new');
    const entries = group ?? [];
    if (useContext) { entries.push({ original: context, binding: contextBinding }); added.add(rangeIdentity(context)); size += contextCost; }
    entries.push({ original: item, binding }); groups.set(item.postId, entries);
    added.add(rangeIdentity(item));
    size += opening.length + separator + renderPostMemoryMaterial(item, binding).length;
  }
  // Necessary old context only: original post and at most one immediately preceding settled comment.
  // Add it after reserving new ranges so lengthy old prose cannot consume the entire batch.
  for (const [postId, entries] of groups) {
    const first = entries.find(item => item.binding.purpose === 'new')!.original;
    const candidates = ordered.filter(item => item.postId === postId && !added.has(rangeIdentity(item))
      && !pending.includes(item));
    const post = candidates.find(item => item.kind === 'post');
    const previous = candidates.filter(item => item.kind === 'comment' && item.createdAt <= first.createdAt)
      .sort((a, b) => b.createdAt - a.createdAt || b.messageId.localeCompare(a.messageId))[0];
    for (const context of [post, previous]) {
      if (!context) continue;
      const header = renderPostMemoryMaterial(context, { start: 0, end: 0, purpose: 'context' }).length;
      const content = takeWeeklySentencePrefix(context.content, limit - size - 2 - header);
      if (!content.trim()) continue;
      const binding = bindingFor(context, 0, content.length, 'context');
      entries.unshift({ original: context, binding }); added.add(rangeIdentity(context));
      size += 2 + renderPostMemoryMaterial(context, binding).length;
    }
    entries.sort((a, b) => (a.original.kind === 'post' ? 0 : 1) - (b.original.kind === 'post' ? 0 : 1)
      || a.original.createdAt - b.original.createdAt || a.original.messageId.localeCompare(b.original.messageId));
  }
  const selected = [...groups.values()].flat();
  const bindings = selected.map(item => item.binding);
  const newRanges = bindings.filter(item => item.purpose === 'new').map(({ sessionId, messageId, sourceHash, start, end }) =>
    ({ sessionId, messageId, sourceHash, start, end }));
  const text = [...groups.entries()].map(([postId, entries]) => `【动态｜postId=${postId}】\n`
    + entries.map(item => renderPostMemoryMaterial(item.original, item.binding)).join('\n\n')).join('\n\n');
  if (text.length > limit) throw new Error('POST_MEMORY_MATERIAL_BUDGET');
  return { text, originals: selected.map(item => item.original), bindings, newRanges,
    messages: selected.map(item => postMemoryMessage(item.original, item.binding)), blocked: blocks,
    hasMore: ordered.some(item => { const range = firstUnprocessedPostRange(item, [...processed, ...newRanges]);
      return !!item.content.slice(range.start, range.end).trim(); }),
  };
}
