import { getMemoryQualitySignals, type MemoryQualitySignals } from './memoryCalibration';
import { explainMemoryDehydrationEligibility } from './memoryDehydration';
import { loadMemoryGraphDiagnostics } from './memoryGraphMaintenance';
import { inspectCurrentMemoryMaterial, type CurrentMemoryMaterialReason } from './memoryCurrentMaterials';
import { inspectMemorySurfacingCandidate } from './memorySurfacing';
import {
  isMemoryRecallEligible,
  loadMemories,
  loadRecentRecallFeedback,
  type MemoryEntry,
} from './memoryStore';

export type MemoryQueryFit = {
  matched: boolean;
  reasons: string[];
  blockers: string[];
};

export type MemoryHealthReport = {
  graphWarnings: string[];
  maintenance: { blockers: string[]; dehydrationEligible: boolean };
  queryFit?: MemoryQueryFit;
  quality: MemoryQualitySignals;
  recall: { blockers: string[]; eligible: boolean; reasons: string[] };
  surfacing: { blockers: string[]; eligible: boolean; mode?: 'quiet_context' | 'suggested_mention' };
};

export type MemoryHealthSummary = {
  actionItems: Array<{ count: number; kind: string; label: string; memoryIds: string[] }>;
  counts: Record<string, number>;
};

const DAY_MS = 86400000;

function splitTerms(text: string) {
  const normalized = text.trim().toLowerCase();
  if (/^[\p{L}\p{N}]$/u.test(normalized)) return [normalized];
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

function memoryHaystack(memory: MemoryEntry) {
  return [
    memory.title,
    memory.content,
    memory.domain,
    ...memory.tags,
    ...memory.recallCues,
  ].join(' ').toLowerCase();
}

function recallBlockers(memory: MemoryEntry) {
  if (isMemoryRecallEligible(memory)) return [];
  const blockers: string[] = [];
  if (memory.type === 'archived') blockers.push('已归档，普通召回会避开。');
  if (memory.type === 'feel') blockers.push('材料有效，但属于心情或沉淀，不进入普通召回主池。');
  return blockers;
}

function recallReasons(memory: MemoryEntry) {
  const reasons = ['符合普通召回类别；是否选中还取决于相关性和本轮名额。'];
  if (memory.pinned || memory.protected) reasons.push('钉住/保护记忆会更稳定出现。');
  if (memory.anchor) reasons.push('长期坐标会在相关场景托底。');
  if (memory.importance >= 7) reasons.push('重要度较高。');
  if (memory.arousal >= 0.7) reasons.push('情绪唤醒较高。');
  if (memory.digested) reasons.push('消化会影响排序，不代表禁止使用。');
  if (memory.recallCues.length) reasons.push(`有想起词：${memory.recallCues.slice(0, 4).join('、')}。`);
  if (memory.tags.length) reasons.push(`有标签：${memory.tags.slice(0, 4).join('、')}。`);
  return reasons;
}

function surfacingState(memory: MemoryEntry, now = Date.now()): MemoryHealthReport['surfacing'] {
  const { candidate, blocker } = inspectMemorySurfacingCandidate(memory, now);
  if (candidate) return { blockers: [], eligible: true, mode: candidate.mode };
  const reasons = {
    archived: '已归档，不进入主动浮现。',
    category: '材料有效，但不属于主动浮现的取材类别。',
    muted: '已设为“别主动提”。',
    cooldown: `正在冷却到 ${new Date(memory.surfaceSuppressedUntil ?? now).toLocaleDateString('zh-CN')}。`,
    low_score: '本次浮现分数未达到门槛；不影响相关搜索。',
  };
  return { blockers: blocker ? [reasons[blocker]] : [], eligible: false };
}

function unavailableReason(reason: CurrentMemoryMaterialReason) {
  return {
    missing: '原记忆已删除，当前不可取用。',
    weekly_stale: '周回顾依据待更新，当前暂停取用；详情与历史仍保留。',
    understanding_stale: '认识依据待核对，当前暂停取用；详情与历史仍保留。',
    post_source_stale: '动态原文有变化或版本未核实，当前暂停取用；详情仍可查看。',
    reading_source_stale: '阅读原件有变化或版本未核实，当前暂停取用；详情仍可查看。',
    shiying_source_stale: '拾荧原件有变化或版本未核实，当前暂停取用；详情仍可查看。',
  }[reason];
}

export async function explainMemoryQueryFit(memory: MemoryEntry, query: string): Promise<MemoryQueryFit> {
  const terms = splitTerms(query.trim());
  if (!terms.length) {
    return { matched: false, reasons: [], blockers: ['当前没有搜索词。'] };
  }
  const haystack = memoryHaystack(memory);
  const reasons: string[] = [];
  for (const term of terms) {
    if (memory.title.toLowerCase().includes(term)) reasons.push(`标题命中“${term}”。`);
    else if (memory.recallCues.some((cue) => cue.toLowerCase().includes(term))) reasons.push(`想起词命中“${term}”。`);
    else if (memory.tags.some((tag) => tag.toLowerCase().includes(term))) reasons.push(`标签命中“${term}”。`);
    else if (memory.domain.toLowerCase().includes(term)) reasons.push(`领域命中“${term}”。`);
    else if (haystack.includes(term)) reasons.push(`正文里出现“${term}”。`);
  }
  const blockers = reasons.length ? [] : ['当前搜索词没有命中标题、标签、想起词或正文。'];
  return {
    matched: reasons.length > 0,
    reasons: reasons.length
      ? [...Array.from(new Set(reasons)).slice(0, 5), '这里只检查文字命中，不保证被本轮选中。']
      : [],
    blockers,
  };
}

export async function buildMemoryHealthReport(
  memory: MemoryEntry,
  options: { query?: string } = {},
): Promise<MemoryHealthReport> {
  const current = await inspectCurrentMemoryMaterial(memory);
  const currentMemory = current.memory ?? memory;
  const unavailable = current.reason ? [unavailableReason(current.reason)] : [];
  const [quality, dehydration, graphLinks] = await Promise.all([
    getMemoryQualitySignals(memory.id),
    current.memory ? explainMemoryDehydrationEligibility(current.memory) : null,
    loadMemoryGraphDiagnostics(memory.id, { limit: 8 }).catch(() => []),
  ]);
  const blockers = unavailable.length ? unavailable : recallBlockers(currentMemory);
  const graphWarnings = graphLinks
    .filter((link) => link.diagnostic.severity !== 'ok')
    .flatMap((link) => link.diagnostic.tags.filter((tag) => tag !== '相关关系'))
    .slice(0, 8);
  const queryFit = options.query?.trim()
    ? unavailable.length ? { matched: false, reasons: [], blockers: unavailable }
      : await explainMemoryQueryFit(currentMemory, options.query)
    : undefined;

  return {
    graphWarnings: Array.from(new Set(graphWarnings)),
    maintenance: {
      blockers: dehydration?.reasons ?? (unavailable.length ? ['not_timeline_eligible'] : []),
      dehydrationEligible: dehydration?.eligible ?? false,
    },
    queryFit,
    quality,
    recall: {
      blockers,
      eligible: blockers.length === 0,
      reasons: blockers.length ? [] : recallReasons(currentMemory),
    },
    surfacing: unavailable.length ? { blockers: unavailable, eligible: false } : surfacingState(currentMemory),
  };
}

function pushSummary(summary: MemoryHealthSummary, kind: string, label: string, memoryId: string) {
  const existing = summary.actionItems.find((item) => item.kind === kind);
  if (existing) {
    existing.count += 1;
    existing.memoryIds.push(memoryId);
  } else {
    summary.actionItems.push({ count: 1, kind, label, memoryIds: [memoryId] });
  }
  summary.counts[kind] = (summary.counts[kind] ?? 0) + 1;
}

export async function buildRecentMemoryHealthSummary(options: { limit?: number } = {}): Promise<MemoryHealthSummary> {
  const limit = Math.max(1, Math.min(12, options.limit ?? 8));
  const now = Date.now();
  const [memories, feedback] = await Promise.all([
    loadMemories({ includeArchived: true }),
    loadRecentRecallFeedback({ limit: 120, since: now - 30 * DAY_MS }),
  ]);
  const summary: MemoryHealthSummary = { actionItems: [], counts: {} };
  const byId = new Map(memories.map((memory) => [memory.id, memory]));

  memories.forEach((memory) => {
    if (memory.surfaceMutedAt) pushSummary(summary, 'muted', '别主动提', memory.id);
    if (memory.surfaceSuppressedUntil && memory.surfaceSuppressedUntil > now) pushSummary(summary, 'suppressed', '浮现冷却中', memory.id);
  });

  feedback.forEach((item) => {
    if (!byId.has(item.memoryId)) return;
    if (item.kind === 'corrected') pushSummary(summary, 'corrected', '最近被纠正', item.memoryId);
    if (item.kind === 'outdated') pushSummary(summary, 'outdated', '旧状态已过期', item.memoryId);
    if (item.kind === 'confirmed') pushSummary(summary, 'confirmed', '近期被确认', item.memoryId);
  });

  const graphChecks = await Promise.all(memories.slice(0, 80).map(async (memory) => ({
    id: memory.id,
    links: await loadMemoryGraphDiagnostics(memory.id, { limit: 4 }).catch(() => []),
  })));
  graphChecks.forEach(({ id, links }) => {
    if (links.some((link) => link.diagnostic.severity !== 'ok')) pushSummary(summary, 'graph_warning', '关系需要看一眼', id);
  });

  const dehydrationChecks = await Promise.all(memories.slice(0, 80).map(async (memory) => ({
    id: memory.id,
    diagnostic: await explainMemoryDehydrationEligibility(memory).catch(() => null),
  })));
  dehydrationChecks.forEach(({ id, diagnostic }) => {
    if (diagnostic?.eligible) pushSummary(summary, 'dehydration_ready', '可整理旧长记忆', id);
  });

  summary.actionItems = summary.actionItems
    .sort((left, right) => right.count - left.count)
    .slice(0, limit);
  return summary;
}
