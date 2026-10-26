import {
  isDailyImpressionMemory,
  isTimelineEligibleMemory,
  isWhisperMemory,
  loadMemories,
  normalizeMemoryAnchorKind,
  type MemoryAnchorKind,
  type MemoryDomain,
  type MemoryEntry,
} from './memoryStore';
import { createMemoryMaterialPreparation, type MemoryMaterialPreparation } from './memoryCurrentMaterials';

export const MEMORY_ANCHOR_KIND_LABELS: Record<MemoryAnchorKind, string> = {
  name: '称呼',
  boundary: '边界',
  relationship_rule: '关系准则',
  preference: '偏好',
  promise: '约定',
  identity: '身份',
  other: '长期',
};

export function getAnchorKindLabel(kind?: MemoryAnchorKind) {
  return MEMORY_ANCHOR_KIND_LABELS[normalizeMemoryAnchorKind(kind)];
}

export function inferAnchorKindFromDomain(domain?: MemoryDomain): MemoryAnchorKind {
  if (domain === '称呼') return 'name';
  if (domain === '边界') return 'boundary';
  if (domain === '喜好') return 'preference';
  if (domain === '约定') return 'promise';
  if (domain === '相处') return 'relationship_rule';
  return 'other';
}

function splitTerms(text: string) {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9_#@.-]{2,}/g) ?? [];
  const cjk = Array.from(normalized.matchAll(/[\u3400-\u9fff]{2,}/g)).flatMap((match) => {
    const value = match[0];
    if (value.length <= 2) return [value];
    const grams: string[] = [];
    for (let index = 0; index < value.length - 1; index += 1) grams.push(value.slice(index, index + 2));
    return grams;
  });
  return Array.from(new Set([...latin, ...cjk]));
}

export function isAnchorCoordinate(memory: MemoryEntry) {
  return memory.anchor && !memory.understandingSubject
    && !isWhisperMemory(memory)
    && !isDailyImpressionMemory(memory)
    && isTimelineEligibleMemory(memory)
    && memory.type !== 'archived'
    && memory.type !== 'feel';
}

export function scoreAnchor(memory: MemoryEntry, input: string) {
  const terms = splitTerms(input);
  if (!terms.length) return 0;
  const haystack = [
    memory.title,
    memory.content,
    memory.domain,
    ...memory.tags,
    ...memory.recallCues,
    memory.rememberedReason ?? '',
  ].join(' ').toLowerCase();
  let score = 0;
  terms.forEach((term) => {
    if (!term) return;
    if (memory.title.toLowerCase().includes(term)) score += 1.2;
    if (memory.recallCues.some((cue) => cue.toLowerCase().includes(term))) score += 1;
    if (memory.tags.some((tag) => tag.toLowerCase().includes(term))) score += 0.8;
    if (haystack.includes(term)) score += 0.45;
  });
  if (memory.anchorKind === 'name' || memory.anchorKind === 'boundary' || memory.anchorKind === 'relationship_rule') score += 0.15;
  return score * (1 + Math.min(10, memory.importance) / 25);
}

export async function loadAnchorCoordinates(options: { limit?: number; memories?: readonly MemoryEntry[] } = {}) {
  const limit = Math.max(1, options.limit ?? 30);
  const memories = options.memories
    ? options.memories.filter((memory) => memory.type !== 'archived')
    : await loadMemories({ includeArchived: false, currentOnly: true });
  return memories
    .filter(isAnchorCoordinate)
    .sort((left, right) => {
      const priority = (memory: MemoryEntry) => (memory.anchorKind === 'boundary' || memory.anchorKind === 'relationship_rule' ? 1 : 0);
      return priority(right) - priority(left)
        || right.importance - left.importance
        || right.updatedAt - left.updatedAt;
    })
    .slice(0, limit);
}

export async function buildAnchorContext(
  input: string,
  options: { limit?: number; memories?: readonly MemoryEntry[]; materialPreparation?: MemoryMaterialPreparation } = {},
) {
  const limit = Math.max(1, options.limit ?? 3);
  const anchors = await loadAnchorCoordinates({ limit: Math.max(30, limit * 8), memories: options.memories });
  const selected = anchors
    .filter(memory => !memory.surfaceMutedAt)
    .map((memory) => ({ memory, score: scoreAnchor(memory, input) }))
    .filter((item) => item.score > 0.2)
    .sort((left, right) => right.score - left.score || right.memory.importance - left.memory.importance)
    .slice(0, limit)
    .map((item) => item.memory);
  const preparation = options.materialPreparation ?? createMemoryMaterialPreparation();
  const items = (await preparation.refresh(selected, isAnchorCoordinate)).filter(memory => !memory.surfaceMutedAt && scoreAnchor(memory, input) > 0.2);
  if (!items.length) return { context: '', items };
  const lines = items.map((memory) => {
    const label = `${getAnchorKindLabel(memory.anchorKind)}坐标`;
    const reason = memory.rememberedReason?.trim() ? `；留下理由：${memory.rememberedReason.trim()}` : '';
    return `- [${label}] ${memory.content}${reason}`;
  });
  return {
    context: [
      '【长期坐标】',
      '这些是白云小姐长期稳定的称呼、边界、偏好或关系准则背景。只在相关处自然遵守；不要说“根据坐标”，不要当作今天新发生，也不要生硬复述。',
      ...lines,
    ].join('\n'),
    items,
  };
}
