import { getMemoryOccurrenceStart } from './memoryAtomicity';
import type { MemoryEntry } from './memoryStore';

export const WEEKLY_MATERIAL_CHARACTER_LIMIT = 6000;

/** Keep the original text, including punctuation; never split a sentence or surrogate pair. */
export function takeWeeklySentencePrefix(text: string, budget: number): string {
  if (budget <= 0) return '';
  if (text.length <= budget) return text;
  let end = 0;
  const boundaries = /(?:[。！？!?]+|\.(?=\s|$)|\r?\n)[”’"'）)\]】》」』]*/gu;
  for (const match of text.matchAll(boundaries)) {
    const next = match.index! + match[0].length;
    if (next > budget) break;
    end = next;
  }
  return text.slice(0, end);
}

export function buildWeeklyMaterialText(memories: readonly MemoryEntry[], comments: readonly string[], weekLabel: string) {
  const opening = `这一周的日期：${weekLabel}\n\n【这一周留下的记忆】\n\n`;
  const commentsHeading = '\n\n【这些记忆已有的批注】\n\n';
  const blocks: string[] = [];
  const selected: MemoryEntry[] = [];
  let dateFormatter: Intl.DateTimeFormat | undefined;
  let size = opening.length + commentsHeading.length + 3; // Reserve the empty-comments marker.
  for (const memory of memories.slice(0, 18)) {
    const at = getMemoryOccurrenceStart(memory.eventTime);
    if (at === undefined) continue;
    const tags = memory.tags.length ? `；标签：${memory.tags.join('、')}` : '';
    const date = new Date(at);
    const dateText = Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN')
      : (dateFormatter ??= new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric' })).format(date);
    const header = `${selected.length + 1}. [${dateText}] ${memory.title}（${memory.domain}/${memory.semanticType}，重要度${memory.importance}${tags}）\n`;
    const separator = blocks.length ? 2 : 0;
    const body = takeWeeklySentencePrefix(memory.content, WEEKLY_MATERIAL_CHARACTER_LIMIT - size - separator - header.length - '正文（全文）：'.length);
    if (!body.trim()) continue;
    const block = `${header}正文（${body === memory.content ? '全文' : '片段'}）：${body}`;
    blocks.push(block); selected.push(memory); size += separator + block.length;
  }
  const notes: string[] = [];
  size -= 3;
  for (const comment of comments.slice(0, 12)) {
    if (!selected.some(memory => comment.startsWith(`${memory.title} /`))) continue;
    const prefix = '- 补记（全文）：';
    const text = takeWeeklySentencePrefix(comment, WEEKLY_MATERIAL_CHARACTER_LIMIT - size - (notes.length ? 1 : 0) - prefix.length);
    if (!text.trim()) continue;
    const block = `- 补记（${text === comment ? '全文' : '片段'}）：${text}`;
    notes.push(block); size += (notes.length > 1 ? 1 : 0) + block.length;
  }
  return { materials: selected, materialText: `${opening}${blocks.join('\n\n') || '- 无'}${commentsHeading}${notes.join('\n') || '- 无'}` };
}
