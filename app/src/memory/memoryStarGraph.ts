import { diagnoseMemoryEdge, type MemoryEdgeDiagnostic } from './memoryGraphMaintenance';
import {
  isDailyImpressionMemory,
  isTimelineEligibleMemory,
  isWhisperMemory,
  loadAllMemoryEdges,
  loadMemories,
  type MemoryEdge,
  type MemoryEntry,
  type MemoryRelationType,
} from './memoryStore';
import {
  createMemoryTopicKey,
  deriveMemoryTopicLabels,
  getMemoryTopicLabelFromKey,
  loadMemoryTopicOverrides,
  resolveMemoryTopicLabel,
} from './memoryTopicProfiles';

export type MemoryStarGraphMode = 'local' | 'overview';
export type MemoryStarGraphFilter = 'anchor' | 'warning' | 'conflict' | 'boundary' | 'recent';

export type MemoryStarGraphNode = {
  color: string;
  id: string;
  kind: 'memory' | 'topic';
  label: string;
  memory?: MemoryEntry;
  muted: boolean;
  radius: number;
  subtitle?: string;
  tags: string[];
  topicKey?: string;
  x: number;
  y: number;
};

export type MemoryStarGraphEdge = {
  color: string;
  confidence?: number;
  diagnostic?: MemoryEdgeDiagnostic;
  direction?: 'forward' | 'backward' | 'none';
  edge?: MemoryEdge;
  id: string;
  kind: 'memory_edge' | 'topic_link';
  label: string;
  muted: boolean;
  relationType?: MemoryRelationType;
  sourceId: string;
  targetId: string;
};

export type MemoryStarGraph = {
  centerNodeId?: string;
  edges: MemoryStarGraphEdge[];
  nodes: MemoryStarGraphNode[];
  stats: {
    edgeCount: number;
    memoryCount: number;
    topicCount: number;
    warningCount: number;
  };
};

export type BuildMemoryStarGraphOptions = {
  centerMemoryId?: string;
  filters?: MemoryStarGraphFilter[];
  maxNodes?: number;
  mode: MemoryStarGraphMode;
  query?: string;
};

const GRAPH_WIDTH = 1000;
const GRAPH_HEIGHT = 720;
const CENTER_X = GRAPH_WIDTH / 2;
const CENTER_Y = GRAPH_HEIGHT / 2;
const WARNING_TAGS = new Set(['弱关系', '时间顺序可疑', '目标已归档', '非普通记忆', '孤立关系', '缺少原因']);
const HIGH_SIGNAL_RELATIONS = new Set<MemoryRelationType>(['updates', 'contradicts', 'promises', 'causes', 'blocks', 'supports']);
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const DOMAIN_COLORS: Record<MemoryEntry['domain'], string> = {
  相处: '#8FC7E8',
  称呼: '#B9A7E8',
  喜好: '#F4D77E',
  边界: '#F3A29A',
  经历: '#9ED9B6',
  约定: '#F0AFC7',
  日常: '#8EDDE0',
  其他: '#BBC5CC',
};

function isReflectionMemory(memory: MemoryEntry) {
  return memory.source === 'baiyun-reflection'
    || memory.period === 'reflection'
    || memory.tags.includes('白云心声')
    || memory.tags.includes('白云沉淀');
}

function isOverviewEligible(memory: MemoryEntry) {
  return isTimelineEligibleMemory(memory)
    && !isDailyImpressionMemory(memory)
    && !isWhisperMemory(memory)
    && !isReflectionMemory(memory);
}

function isMutedMemory(memory: MemoryEntry) {
  return memory.type === 'archived'
    || memory.type === 'feel'
    || isDailyImpressionMemory(memory)
    || isWhisperMemory(memory)
    || isReflectionMemory(memory);
}

function memoryNodeColor(memory: MemoryEntry) {
  if (memory.type === 'archived') return '#AEB9C4';
  return DOMAIN_COLORS[memory.domain] ?? DOMAIN_COLORS.其他;
}

function edgeColor(relationType?: MemoryRelationType, diagnostic?: MemoryEdgeDiagnostic) {
  if (diagnostic?.severity === 'warning') return '#E39A43';
  if (diagnostic?.severity === 'weak') return '#8DA8C3';
  switch (relationType) {
    case 'updates':
      return '#4D8FD9';
    case 'contradicts':
      return '#D46A61';
    case 'supports':
      return '#65A66F';
    case 'promises':
      return '#C9912F';
    case 'blocks':
      return '#9B6ACB';
    case 'causes':
    case 'triggers':
      return '#4FA7A5';
    default:
      return '#A7B4C2';
  }
}

function relationLabel(relationType?: MemoryRelationType) {
  const labels: Record<MemoryRelationType, string> = {
    belongs_to: '同属',
    blocks: '阻碍',
    causes: '因果',
    contradicts: '冲突',
    emotional_echo: '情绪回声',
    promises: '约定',
    supersedes: '替代',
    relates_to: '相关',
    supports: '支持',
    triggers: '触发',
    updates: '更新',
  };
  return relationType ? labels[relationType] : '主题';
}

function normalizeQuery(value: string) {
  return value.trim().toLowerCase();
}

function memoryMatchesQuery(memory: MemoryEntry, query: string) {
  if (!query) return true;
  const haystack = [
    memory.title,
    memory.content,
    memory.domain,
    memory.semanticType,
    memory.rememberedReason ?? '',
    ...memory.tags,
    ...memory.recallCues,
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function topicMatchesQuery(topicLabel: string, query: string) {
  return !query || topicLabel.toLowerCase().includes(query);
}

function hasWarning(diagnostic?: MemoryEdgeDiagnostic) {
  return !!diagnostic && (diagnostic.severity !== 'ok' || diagnostic.tags.some((tag) => WARNING_TAGS.has(tag)));
}

function memoryMatchesFilters(memory: MemoryEntry, filters: Set<MemoryStarGraphFilter>, relatedDiagnostics: MemoryEdgeDiagnostic[]) {
  if (!filters.size) return true;
  for (const filter of filters) {
    if (filter === 'anchor' && !memory.anchor && !memory.pinned && !memory.protected) return false;
    if (filter === 'warning' && !relatedDiagnostics.some(hasWarning)) return false;
    if (filter === 'conflict' && !relatedDiagnostics.some((item) => item.tags.some((tag) => tag.includes('冲突') || tag.includes('更新')))) return false;
    if (filter === 'boundary' && memory.domain !== '边界' && memory.domain !== '约定' && !memory.anchor) return false;
    if (filter === 'recent' && Date.now() - Math.max(memory.lastActiveAt, memory.updatedAt, memory.createdAt) > 30 * 86400000) return false;
  }
  return true;
}

function topicKey(label: string) {
  return createMemoryTopicKey(label);
}

function topicLabelFromId(id: string) {
  return getMemoryTopicLabelFromKey(id);
}

function scoreMemory(memory: MemoryEntry, degree: number, warningCount: number) {
  const recentDays = (Date.now() - Math.max(memory.lastActiveAt, memory.updatedAt, memory.createdAt)) / 86400000;
  const recency = Math.max(0, 10 - Math.min(10, recentDays / 7));
  return (
    memory.importance * 3
    + memory.activationCount
    + degree * 4
    + warningCount * 8
    + recency
    + (memory.anchor ? 18 : 0)
    + (memory.pinned || memory.protected ? 12 : 0)
  );
}

function scoreGraphEdge(edge: MemoryStarGraphEdge) {
  return (
    (edge.confidence ?? 0) * 100
    + (edge.diagnostic?.severity === 'warning' ? 55 : 0)
    + (edge.diagnostic?.severity === 'weak' ? 10 : 0)
    + (edge.relationType && HIGH_SIGNAL_RELATIONS.has(edge.relationType) ? 35 : 0)
  );
}

function clampPoint(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function relationDiagnosticsByMemory(edges: MemoryEdge[], memories: Map<string, MemoryEntry>) {
  const byMemory = new Map<string, MemoryEdgeDiagnostic[]>();
  const byEdge = new Map<string, MemoryEdgeDiagnostic>();
  edges.forEach((edge) => {
    const source = memories.get(edge.sourceId) ?? null;
    const target = memories.get(edge.targetId) ?? null;
    const diagnostic = diagnoseMemoryEdge(edge, source, target);
    byEdge.set(edge.id, diagnostic);
    [edge.sourceId, edge.targetId].forEach((memoryId) => {
      const current = byMemory.get(memoryId) ?? [];
      current.push(diagnostic);
      byMemory.set(memoryId, current);
    });
  });
  return { byEdge, byMemory };
}

function pickOverviewMemoryIds(
  memories: MemoryEntry[],
  edges: MemoryEdge[],
  diagnosticsByMemory: Map<string, MemoryEdgeDiagnostic[]>,
  options: { filters: Set<MemoryStarGraphFilter>; maxNodes: number; query: string },
) {
  const degree = new Map<string, number>();
  edges.forEach((edge) => {
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1);
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1);
  });
  return memories
    .filter(isOverviewEligible)
    .filter((memory) => memoryMatchesQuery(memory, options.query))
    .filter((memory) => memoryMatchesFilters(memory, options.filters, diagnosticsByMemory.get(memory.id) ?? []))
    .sort((left, right) => (
      scoreMemory(right, degree.get(right.id) ?? 0, (diagnosticsByMemory.get(right.id) ?? []).filter(hasWarning).length)
      - scoreMemory(left, degree.get(left.id) ?? 0, (diagnosticsByMemory.get(left.id) ?? []).filter(hasWarning).length)
    ))
    .slice(0, Math.max(1, options.maxNodes));
}

function pickLocalMemoryIds(centerMemoryId: string | undefined, memories: Map<string, MemoryEntry>, edges: MemoryEdge[], maxNodes: number) {
  if (!centerMemoryId || !memories.has(centerMemoryId)) return [];
  const selected = new Set<string>([centerMemoryId]);
  const firstHop = edges
    .filter((edge) => edge.sourceId === centerMemoryId || edge.targetId === centerMemoryId)
    .sort((left, right) => right.confidence - left.confidence);
  firstHop.forEach((edge) => {
    if (selected.size >= maxNodes) return;
    selected.add(edge.sourceId === centerMemoryId ? edge.targetId : edge.sourceId);
  });
  const firstHopIds = Array.from(selected).filter((id) => id !== centerMemoryId);
  for (const id of firstHopIds) {
    if (selected.size >= maxNodes) break;
    edges
      .filter((edge) => edge.sourceId === id || edge.targetId === id)
      .sort((left, right) => right.confidence - left.confidence)
      .forEach((edge) => {
        if (selected.size < maxNodes) selected.add(edge.sourceId === id ? edge.targetId : edge.sourceId);
      });
  }
  return Array.from(selected).filter((id) => memories.has(id));
}

function layoutTopicNodes(nodes: MemoryStarGraphNode[], mode: MemoryStarGraphMode) {
  const topicNodes = nodes.filter((node) => node.kind === 'topic');
  const radiusX = mode === 'local' ? 300 : 320;
  const radiusY = mode === 'local' ? 235 : 255;
  topicNodes.forEach((node, index) => {
    const seededNudge = ((hashString(node.id) % 17) - 8) * 0.012;
    const angle = (-Math.PI / 2) + (2 * Math.PI * index / Math.max(topicNodes.length, 1)) + seededNudge;
    node.x = CENTER_X + Math.cos(angle) * radiusX;
    node.y = CENTER_Y + Math.sin(angle) * radiusY;
  });
}

function layoutMemoryNodes(
  nodes: MemoryStarGraphNode[],
  mode: MemoryStarGraphMode,
  centerNodeId: string | undefined,
  memoryTopics: Map<string, string[]>,
) {
  const memoryNodes = nodes.filter((node) => node.kind === 'memory');
  if (mode === 'local' && centerNodeId) {
    const center = memoryNodes.find((node) => node.id === centerNodeId);
    if (center) {
      center.x = CENTER_X;
      center.y = CENTER_Y;
    }
    const around = memoryNodes.filter((node) => node.id !== centerNodeId);
    around.forEach((node, index) => {
      const angle = (-Math.PI / 2) + (2 * Math.PI * index / Math.max(around.length, 1));
      const ring = index % 2;
      const radius = around.length <= 6 ? 220 : 235 + ring * 65;
      node.x = clampPoint(CENTER_X + Math.cos(angle) * radius, 85, GRAPH_WIDTH - 85);
      node.y = clampPoint(CENTER_Y + Math.sin(angle) * radius, 75, GRAPH_HEIGHT - 75);
    });
    return;
  }

  const topicNodes = nodes.filter((node) => node.kind === 'topic');
  const topicByKey = new Map(topicNodes.map((node) => [node.topicKey ?? node.id, node]));
  const topicTotals = new Map<string, number>();
  memoryNodes.forEach((node) => {
    const topics = memoryTopics.get(node.id) ?? [];
    const primaryTopic = topics.find((topic) => topicByKey.has(topic));
    if (primaryTopic) topicTotals.set(primaryTopic, (topicTotals.get(primaryTopic) ?? 0) + 1);
  });
  const bucketIndex = new Map<string, number>();
  let looseIndex = 0;
  memoryNodes.forEach((node) => {
    const topics = memoryTopics.get(node.id) ?? [];
    const primaryTopic = topics.find((topic) => topicByKey.has(topic));
    if (!primaryTopic) {
      const angle = (-Math.PI / 2) + looseIndex * 0.92;
      const radius = 95 + (looseIndex % 4) * 34;
      looseIndex += 1;
      node.x = clampPoint(CENTER_X + Math.cos(angle) * radius, 95, GRAPH_WIDTH - 95);
      node.y = clampPoint(CENTER_Y + Math.sin(angle) * radius, 85, GRAPH_HEIGHT - 85);
      return;
    }
    const topic = topicByKey.get(primaryTopic)!;
    const index = bucketIndex.get(primaryTopic) ?? 0;
    bucketIndex.set(primaryTopic, index + 1);
    const seed = hashString(`${node.id}:${primaryTopic}`);
    const jitter = ((seed % 100) / 100 - 0.5) * 0.72;
    const angle = (-Math.PI / 2) + index * GOLDEN_ANGLE + jitter;
    const radiusNorm = Math.sqrt((index + 0.5) / Math.max(1, topicTotals.get(primaryTopic) ?? 1));
    const radius = topic.radius + 50 + radiusNorm * 86 + ((seed >>> 8) % 18);
    node.x = clampPoint(topic.x + Math.cos(angle) * radius, 85, GRAPH_WIDTH - 85);
    node.y = clampPoint(topic.y + Math.sin(angle) * radius, 75, GRAPH_HEIGHT - 75);
  });
}

function relationIdealLength(edge: MemoryStarGraphEdge, mode: MemoryStarGraphMode) {
  if (edge.kind === 'topic_link') return mode === 'local' ? 130 : 150;
  if (edge.diagnostic?.severity === 'warning') return mode === 'local' ? 245 : 275;
  if (edge.relationType && HIGH_SIGNAL_RELATIONS.has(edge.relationType)) return mode === 'local' ? 175 : 205;
  return mode === 'local' ? 205 : 235;
}

function runConstellationLayout(nodes: MemoryStarGraphNode[], edges: MemoryStarGraphEdge[], mode: MemoryStarGraphMode, centerNodeId?: string) {
  if (nodes.length <= 1) return;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const iterations = mode === 'local' ? 72 : 88;
  const repulsion = mode === 'local' ? 21000 : 26000;
  const attraction = mode === 'local' ? 0.028 : 0.024;
  const centerGravity = mode === 'local' ? 0.010 : 0.007;
  let temperature = mode === 'local' ? 12 : 14;

  for (let step = 0; step < iterations; step += 1) {
    const forces = new Map<string, { x: number; y: number }>();
    nodes.forEach((node) => forces.set(node.id, { x: 0, y: 0 }));

    for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
        const left = nodes[leftIndex];
        const right = nodes[rightIndex];
        const dx = left.x - right.x;
        const dy = left.y - right.y;
        const distanceSq = Math.max(36, dx * dx + dy * dy);
        if (distanceSq > 260000) continue;
        const distance = Math.sqrt(distanceSq);
        const push = repulsion * (1 + (left.radius + right.radius) / 90) / distanceSq;
        const fx = (dx / distance) * push;
        const fy = (dy / distance) * push;
        const leftForce = forces.get(left.id)!;
        const rightForce = forces.get(right.id)!;
        leftForce.x += fx;
        leftForce.y += fy;
        rightForce.x -= fx;
        rightForce.y -= fy;
      }
    }

    edges.forEach((edge) => {
      const source = nodeById.get(edge.sourceId);
      const target = nodeById.get(edge.targetId);
      if (!source || !target) return;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(6, Math.hypot(dx, dy));
      const ideal = relationIdealLength(edge, mode);
      const pull = (distance - ideal) * attraction * (edge.kind === 'topic_link' ? 0.44 : 1);
      const fx = (dx / distance) * pull;
      const fy = (dy / distance) * pull;
      const sourceForce = forces.get(source.id)!;
      const targetForce = forces.get(target.id)!;
      sourceForce.x += fx;
      sourceForce.y += fy;
      targetForce.x -= fx;
      targetForce.y -= fy;
    });

    nodes.forEach((node) => {
      if (node.id === centerNodeId) {
        node.x = CENTER_X;
        node.y = CENTER_Y;
        return;
      }
      const force = forces.get(node.id)!;
      const anchorPull = node.kind === 'topic' ? 0.018 : centerGravity;
      force.x += (CENTER_X - node.x) * anchorPull;
      force.y += (CENTER_Y - node.y) * anchorPull;
      const mass = node.kind === 'topic' ? 1.8 : node.tags.includes('锚点') ? 1.35 : 1;
      const moveX = clampPoint(force.x / mass, -temperature, temperature);
      const moveY = clampPoint(force.y / mass, -temperature, temperature);
      node.x = clampPoint(node.x + moveX, 70, GRAPH_WIDTH - 70);
      node.y = clampPoint(node.y + moveY, 62, GRAPH_HEIGHT - 62);
    });

    temperature *= 0.965;
  }
}

function createMemoryNode(memory: MemoryEntry): MemoryStarGraphNode {
  return {
    color: memoryNodeColor(memory),
    id: memory.id,
    kind: 'memory',
    label: memory.title || memory.domain,
    memory,
    muted: isMutedMemory(memory),
    radius: memory.anchor || memory.pinned ? 34 : memory.importance >= 8 ? 30 : 25,
    subtitle: memory.anchor ? '长期坐标' : memory.domain,
    tags: [
      memory.domain,
      memory.anchor ? '锚点' : '',
      memory.tags.includes('阶段记忆') ? '阶段记忆' : '',
      memory.type === 'archived' ? '已归档' : '',
    ].filter(Boolean),
    x: CENTER_X,
    y: CENTER_Y,
  };
}

function createTopicNode(label: string, count: number, key = topicKey(label)): MemoryStarGraphNode {
  return {
    color: '#E8C66D',
    id: key,
    kind: 'topic',
    label,
    muted: false,
    radius: Math.min(30, 18 + count * 2),
    subtitle: `${count} 条`,
    tags: ['主题'],
    x: CENTER_X,
    y: CENTER_Y,
  };
}

export async function buildMemoryStarGraph(options: BuildMemoryStarGraphOptions): Promise<MemoryStarGraph> {
  const mode = options.mode;
  const query = normalizeQuery(options.query ?? '');
  const filters = new Set(options.filters ?? []);
  const maxNodes = Math.max(8, Math.min(mode === 'local' ? 22 : 34, options.maxNodes ?? (mode === 'local' ? 18 : 30)));
  const [allMemories, allEdges, topicOverrides] = await Promise.all([
    loadMemories({ includeArchived: true }),
    loadAllMemoryEdges(0),
    loadMemoryTopicOverrides(),
  ]);
  const memoryById = new Map(allMemories.map((memory) => [memory.id, memory]));
  const { byEdge, byMemory } = relationDiagnosticsByMemory(allEdges, memoryById);
  const memoryBudget = Math.max(4, Math.floor(maxNodes * (mode === 'local' ? 0.76 : 0.72)));
  const pickedMemories = mode === 'local'
    ? pickLocalMemoryIds(options.centerMemoryId, memoryById, allEdges, memoryBudget)
      .map((id) => memoryById.get(id))
      .filter((memory): memory is MemoryEntry => !!memory)
      .filter((memory) => memoryMatchesQuery(memory, query) || memory.id === options.centerMemoryId)
      .filter((memory) => memory.id === options.centerMemoryId || memoryMatchesFilters(memory, filters, byMemory.get(memory.id) ?? []))
    : pickOverviewMemoryIds(allMemories, allEdges, byMemory, { filters, maxNodes: memoryBudget, query });

  const pickedIds = new Set(pickedMemories.map((memory) => memory.id));
  const maxMemoryEdges = mode === 'local' ? 16 : 24;
  const memoryEdges = allEdges
    .filter((edge) => pickedIds.has(edge.sourceId) && pickedIds.has(edge.targetId))
    .map((edge): MemoryStarGraphEdge => {
      const diagnostic = byEdge.get(edge.id);
      return {
        color: edgeColor(edge.relationType, diagnostic),
        confidence: edge.confidence,
        diagnostic,
        direction: 'forward',
        edge,
        id: edge.id,
        kind: 'memory_edge',
        label: relationLabel(edge.relationType),
        muted: hasWarning(diagnostic),
        relationType: edge.relationType,
        sourceId: edge.sourceId,
        targetId: edge.targetId,
      };
    })
    .sort((left, right) => scoreGraphEdge(right) - scoreGraphEdge(left))
    .slice(0, maxMemoryEdges);

  const topicCounts = new Map<string, number>();
  const topicLabelsByKey = new Map<string, string>();
  const memoryTopics = new Map<string, string[]>();
  pickedMemories.forEach((memory) => {
    const topics = deriveMemoryTopicLabels(memory)
      .map((topic) => resolveMemoryTopicLabel(topic, topicOverrides))
      .filter((topic) => !topic.hidden && topicMatchesQuery(topic.displayName, query));
    const topicKeys = topics.map((topic) => topic.key);
    memoryTopics.set(memory.id, topicKeys);
    topics.forEach((topic) => {
      topicLabelsByKey.set(topic.key, topic.displayName);
      topicCounts.set(topic.key, (topicCounts.get(topic.key) ?? 0) + 1);
    });
  });
  const topicKeys = Array.from(topicCounts.entries())
    .sort((left, right) => right[1] - left[1] || (topicLabelsByKey.get(left[0]) ?? left[0]).localeCompare(topicLabelsByKey.get(right[0]) ?? right[0], 'zh-CN'))
    .slice(0, Math.min(mode === 'local' ? 5 : 8, Math.max(0, maxNodes - pickedMemories.length)))
    .map(([key]) => key);
  const topicSet = new Set(topicKeys);
  const topicEdges: MemoryStarGraphEdge[] = [];
  const topicEdgeCounts = new Map<string, number>();
  const maxTopicEdges = mode === 'local' ? 6 : 10;
  memoryTopics.forEach((topics, memoryId) => {
    topics.filter((topic) => topicSet.has(topic)).slice(0, 2).forEach((topic) => {
      if (topicEdges.length >= maxTopicEdges) return;
      const currentTopicEdges = topicEdgeCounts.get(topic) ?? 0;
      if (currentTopicEdges >= 3) return;
      topicEdgeCounts.set(topic, currentTopicEdges + 1);
      topicEdges.push({
        color: '#D7BC72',
        direction: 'none',
        id: `topic-link-${memoryId}-${topic}`,
        kind: 'topic_link',
        label: '主题',
        muted: true,
        sourceId: memoryId,
        targetId: topic,
      });
    });
  });
  const linkedTopicIds = new Set(topicEdges.map((edge) => edge.targetId));
  const visibleTopicKeys = topicKeys.filter((key) => linkedTopicIds.has(key));

  const nodes = [
    ...pickedMemories.map(createMemoryNode),
    ...visibleTopicKeys.map((key) => createTopicNode(topicLabelsByKey.get(key) ?? topicLabelFromId(key), topicCounts.get(key) ?? 1, key)),
  ];
  const centerNodeId = mode === 'local' && options.centerMemoryId && pickedIds.has(options.centerMemoryId)
    ? options.centerMemoryId
    : undefined;
  layoutTopicNodes(nodes, mode);
  layoutMemoryNodes(nodes, mode, centerNodeId, memoryTopics);

  const edges = [...memoryEdges, ...topicEdges].filter((edge) => {
    const source = nodes.some((node) => node.id === edge.sourceId);
    const target = nodes.some((node) => node.id === edge.targetId);
    return source && target;
  });
  runConstellationLayout(nodes, edges, mode, centerNodeId);
  return {
    centerNodeId,
    edges,
    nodes,
    stats: {
      edgeCount: edges.length,
      memoryCount: nodes.filter((node) => node.kind === 'memory').length,
      topicCount: nodes.filter((node) => node.kind === 'topic').length,
      warningCount: memoryEdges.filter((edge) => hasWarning(edge.diagnostic)).length,
    },
  };
}
