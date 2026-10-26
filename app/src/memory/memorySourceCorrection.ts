import type { MemoryDraft, MemoryEntry } from './memoryStore';
import type { MemorySourceTraceResult } from './memorySourceTrace';

function compactText(text: string, limit: number) {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

export function buildSourceTraceExcerpt(trace: MemorySourceTraceResult | null, limit = 900) {
  const lines = trace?.details.flatMap((detail) => (
    detail.messages.map((message) => `${message.role === 'you' ? '小仓鼠' : '白云小姐'}：${message.content}`)
  )) ?? [];
  return compactText(lines.join('\n'), limit);
}

export function buildSourceCorrectionQuery(memory: MemoryEntry, trace: MemorySourceTraceResult | null) {
  const excerpt = buildSourceTraceExcerpt(trace, 360);
  return compactText([memory.title, memory.content, excerpt].filter(Boolean).join('\n'), 520);
}

export function buildSourceCorrectionComment(input: {
  kind: 'correction' | 'outdated';
  memory: MemoryEntry;
  note: string;
  trace: MemorySourceTraceResult | null;
}) {
  const title = input.kind === 'correction' ? '来源纠错' : '来源过期';
  const excerpt = buildSourceTraceExcerpt(input.trace, 520);
  return [
    `${title}：${input.note.trim()}`,
    excerpt ? `参考来源片段：\n${excerpt}` : '这条记忆暂无可回看的来源片段。',
  ].join('\n\n');
}

export function buildSourceCorrectionDraft(
  memory: MemoryEntry,
  trace: MemorySourceTraceResult | null,
  correctionText = '',
): MemoryDraft {
  const correctedContent = correctionText.trim() || memory.content;
  return {
    ...memory,
    content: correctedContent,
    recallCues: Array.from(new Set(memory.recallCues)),
    tags: [...memory.tags],
  };
}
