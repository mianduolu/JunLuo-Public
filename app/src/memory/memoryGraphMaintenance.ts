import {
  isTimelineEligibleMemory,
  loadAllMemoryEdges,
  loadMemory,
  type MemoryEdge,
  type MemoryEntry,
  type MemoryRelationType,
} from './memoryStore';

export type MemoryEdgeDiagnostic = {
  severity: 'ok' | 'weak' | 'warning';
  tags: string[];
  note?: string;
};

export type MemoryGraphLink = {
  diagnostic: MemoryEdgeDiagnostic;
  direction: 'incoming' | 'outgoing';
  edge: MemoryEdge;
  memory: MemoryEntry;
};

const STRONG_EDGE_TYPES = new Set<MemoryRelationType>(['updates', 'contradicts', 'promises', 'causes', 'blocks']);
const EXPLAINED_EDGE_TYPES = new Set<MemoryRelationType>(['updates', 'contradicts']);

function relationLabel(relationType: MemoryRelationType) {
  const labels: Record<MemoryRelationType, string> = {
    belongs_to: '同属关系',
    blocks: '阻碍关系',
    causes: '因果关系',
    contradicts: '冲突关系',
    emotional_echo: '情绪回声',
    promises: '约定关系',
    supersedes: '替代关系',
    relates_to: '相关关系',
    supports: '支持关系',
    triggers: '触发关系',
    updates: '更新关系',
  };
  return labels[relationType];
}

function memoryTime(memory: MemoryEntry) {
  return memory.eventAt ?? memory.sourceStartAt ?? memory.createdAt;
}

export function diagnoseMemoryEdge(
  edge: MemoryEdge,
  sourceMemory: MemoryEntry | null,
  targetMemory: MemoryEntry | null,
): MemoryEdgeDiagnostic {
  const tags = new Set<string>([relationLabel(edge.relationType)]);
  let severity: MemoryEdgeDiagnostic['severity'] = 'ok';
  const notes: string[] = [];

  if (!sourceMemory || !targetMemory) {
    tags.add('孤立关系');
    return { severity: 'warning', tags: Array.from(tags), note: '关系的一端已经找不到对应记忆。' };
  }

  if (edge.confidence < 0.58) {
    severity = 'weak';
    tags.add('弱关系');
    notes.push('置信度偏低，只作为轻量线索。');
  }

  if ((!sourceMemory.understandingSubject && !isTimelineEligibleMemory(sourceMemory))
    || (!targetMemory.understandingSubject && !isTimelineEligibleMemory(targetMemory))
    || sourceMemory.type === 'archived' || targetMemory.type === 'archived') {
    severity = severity === 'ok' ? 'warning' : severity;
    tags.add(sourceMemory.type === 'archived' || targetMemory.type === 'archived' ? '目标已归档' : '非普通记忆');
    notes.push('关系的一端暂时不适合进入普通召回。');
  }

  if (edge.relationType === 'updates' && memoryTime(sourceMemory) > memoryTime(targetMemory)) {
    severity = 'warning';
    tags.add('时间顺序可疑');
    notes.push('更新关系的时间顺序看起来反了。');
  }

  if (EXPLAINED_EDGE_TYPES.has(edge.relationType) && !edge.reason.trim()) {
    severity = severity === 'ok' ? 'weak' : severity;
    tags.add('缺少原因');
    notes.push('这类强关系最好有一句解释。');
  }

  if (STRONG_EDGE_TYPES.has(edge.relationType) && edge.confidence >= 0.65 && severity === 'ok') {
    tags.add('强关系');
  }

  return {
    severity,
    tags: Array.from(tags),
    note: notes.join(' '),
  };
}

export function shouldUseEdgeForRelatedRecall(edge: MemoryEdge, diagnostic: MemoryEdgeDiagnostic) {
  const strongEdge = STRONG_EDGE_TYPES.has(edge.relationType) && edge.confidence >= 0.65;
  if (diagnostic.tags.includes('孤立关系') || diagnostic.tags.includes('目标已归档') || diagnostic.tags.includes('非普通记忆')) {
    return false;
  }
  if (diagnostic.severity === 'warning' && !strongEdge) return false;
  if (diagnostic.severity === 'weak' && !strongEdge) return false;
  return true;
}

export async function loadMemoryGraphDiagnostics(memoryId: string, options: { limit?: number; minConfidence?: number } = {}) {
  const limit = Math.max(1, Math.min(20, Math.round(options.limit ?? 5)));
  const minConfidence = options.minConfidence ?? 0;
  const edges = (await loadAllMemoryEdges(minConfidence))
    .filter((edge) => edge.sourceId === memoryId || edge.targetId === memoryId)
    .sort((left, right) => (
      right.confidence - left.confidence
      || right.createdAt - left.createdAt
    ));

  const links = await Promise.all(edges.map(async (edge): Promise<MemoryGraphLink | null> => {
    const direction = edge.sourceId === memoryId ? 'outgoing' as const : 'incoming' as const;
    const [sourceMemory, targetMemory] = await Promise.all([loadMemory(edge.sourceId), loadMemory(edge.targetId)]);
    const other = direction === 'outgoing' ? targetMemory : sourceMemory;
    if (!other) return null;
    return {
      diagnostic: diagnoseMemoryEdge(edge, sourceMemory, targetMemory),
      direction,
      edge,
      memory: other,
    };
  }));

  return links
    .filter((link): link is MemoryGraphLink => !!link)
    .slice(0, limit);
}
