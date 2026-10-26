type MemoryContextTextComment = {
  content: string;
  kind: string;
};

type MemoryContextTextMemory = {
  content: string;
  atomicKind?: string | null;
  recallCues: string[];
  rememberedReason?: string | null;
  semanticType?: string | null;
  source?: string | null;
  tags: string[];
  title: string;
};

type MemoryContextTextItem = {
  latestComment?: MemoryContextTextComment;
  memory: MemoryContextTextMemory;
  reason?: string;
};

type BuildMemoryContextSnippetOptions = {
  latestComment?: MemoryContextTextComment;
  maxChars?: number;
  reason?: string;
  episodeFormat?: boolean;
};

function compactText(text: string, limit: number) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).replace(/[，,。；;、\s]+$/g, '')}…`;
}

function isLongSummaryMemory(memory: MemoryContextTextMemory) {
  return memory.semanticType === 'case'
    || memory.source === 'weekly-context'
    || memory.source === 'episode-memory'
    || memory.tags.includes('阶段记忆')
    || memory.tags.includes('周脉络');
}

export function isEpisodeContextMemory(memory: MemoryContextTextMemory) {
  return memory.source !== 'weekly-context'
    && (memory.source === 'episode-memory' || memory.atomicKind === 'stage_conclusion')
    && !memory.tags.includes('周脉络');
}

/** Original sentence ranges, shared punctuation rules with weekly/letter material. */
function sentenceEnds(text: string) {
  const ends = [...text.matchAll(/(?:[。！？!?]+|\.(?=\s|$)|\r?\n)[”’"'）)\]】》」』]*/gu)]
    .map(match => match.index! + match[0].length);
  if (ends.at(-1) !== text.length) ends.push(text.length);
  return ends;
}

export function buildEpisodeContextSnippet(memory: MemoryContextTextMemory, options: BuildMemoryContextSnippetOptions = {}) {
  const budget = Math.max(0, options.maxChars ?? 140);
  const title = `${memory.title}\n`;
  const available = budget - title.length;
  if (available <= 0) return memory.title.length <= budget ? memory.title : '';
  const summary = options.latestComment?.kind === 'dehydration' ? options.latestComment.content.trim() : '';
  if (summary && summary.length <= 120 && `缩略小记：${summary}`.length <= available) return `${title}缩略小记：${summary}`;
  const text = memory.content;
  if (`正文（全文）：${text}`.length <= available) return `${title}正文（全文）：${text}`;
  const label = '正文（片段）：';
  const gap = '\n〔中间省略〕\n';
  const ends = sentenceEnds(text);
  const starts = [0, ...ends.slice(0, -1)];
  const half = Math.floor((available - label.length * 2 - gap.length) / 2);
  let headEnd = ends.filter(end => end <= half).at(-1) ?? 0;
  let tailStart = starts.find(start => text.length - start <= half) ?? text.length;
  if (!headEnd || tailStart === text.length) {
    // A whole tail sentence takes priority when two minimum sentences cannot fit.
    tailStart = starts.find(start => text.length - start + label.length <= available) ?? text.length;
    if (tailStart < text.length) {
      const room = available - label.length * 2 - gap.length - (text.length - tailStart);
      headEnd = ends.filter(end => end <= room && end < tailStart).at(-1) ?? 0;
    } else headEnd = ends.filter(end => end + label.length <= available).at(-1) ?? 0;
  } else {
    // Donate unused space on either side without overlapping or merging distant text.
    const room = available - label.length * 2 - gap.length - (text.length - tailStart);
    headEnd = ends.filter(end => end <= room && end < tailStart).at(-1) ?? headEnd;
    tailStart = starts.find(start => start > headEnd && text.length - start + headEnd + label.length * 2 + gap.length <= available) ?? tailStart;
  }
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  if (head && tail) return `${title}${label}${head}${gap}${label}${tail}`;
  return head || tail ? `${title}${label}${tail || head}` : memory.title;
}

export function buildMemoryIndexLine(
  memory: MemoryContextTextMemory,
  latestComment?: MemoryContextTextComment,
  options: { maxChars?: number } = {},
) {
  const maxChars = options.maxChars ?? 96;
  const dehydrationSummary = latestComment?.kind === 'dehydration' ? latestComment.content.trim() : '';
  if (dehydrationSummary) {
    return compactText(`压缩年轮：${dehydrationSummary}`, maxChars);
  }

  return compactText(memory.content, maxChars);
}

export function buildMemoryContextSnippet(
  memory: MemoryContextTextMemory,
  options: BuildMemoryContextSnippetOptions = {},
) {
  const latestComment = options.latestComment;
  if (options.episodeFormat && isEpisodeContextMemory(memory)) return buildEpisodeContextSnippet(memory, options);
  const defaultLimit = isLongSummaryMemory(memory) ? 140 : 180;
  const maxChars = options.maxChars ?? defaultLimit;
  const shouldPreferIndex = isLongSummaryMemory(memory);
  const content = shouldPreferIndex
    ? `${buildMemoryIndexLine(memory, latestComment, { maxChars })}。正文线索：${memory.title}`
    : memory.content;
  const note = shouldPreferIndex
    ? '（长记忆先给短核心，原文仍保留在详情页）'
    : '';
  return `${compactText(content, maxChars)}${note}`;
}

export function buildMemoryContextLines(
  items: MemoryContextTextItem[],
  options: { maxChars?: number } = {},
) {
  return items.map((item) => buildMemoryContextSnippet(item.memory, {
    latestComment: item.latestComment,
    maxChars: options.maxChars,
    reason: item.reason,
  }));
}

