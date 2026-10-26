import { diagnoseMemoryEdge } from './memoryGraphMaintenance';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import {
  getMemoryDatabase,
  isDailyImpressionMemory,
  isWhisperMemory,
  loadAllMemoryEdges,
  loadMemories,
  type MemoryEdge,
  type MemoryEntry,
} from './memoryStore';
import {
  getMemoryCurrentStateKindLabel,
  loadActiveMemoryCurrentStates,
  type MemoryCurrentState,
} from './memoryCurrentStateStore';

export type MemoryTopicKind =
  | 'person'
  | 'project'
  | 'place'
  | 'interest'
  | 'event'
  | 'relationship'
  | 'state'
  | 'other';

export type MemoryTopicOverride = {
  displayName?: string;
  hidden: boolean;
  key: string;
  updatedAt: number;
};

export type MemoryTopicProfile = {
  activeStates: MemoryCurrentState[];
  currentStateCount: number;
  displayName: string;
  hidden: boolean;
  key: string;
  keyMemories: MemoryEntry[];
  kind: MemoryTopicKind;
  label: string;
  memoryCount: number;
  recentUpdatedAt: number;
  relationCount: number;
  tags: string[];
  warningCount: number;
};

type TopicOverrideRow = {
  display_name: string | null;
  hidden: number | null;
  topic_key: string;
  updated_at: number | null;
};

const TOPIC_PREFIX = 'topic:';
const IGNORED_TOPIC_LABELS = new Set([
  '历史导入',
  '阶段记忆',
  '周脉络',
  '白云心声',
  '白云沉淀',
  '日印象',
  '近况小纸条',
  '情绪天气',
  '普通记忆',
]);

let topicOverrideTableReady = false;

export function createMemoryTopicKey(label: string) {
  return `${TOPIC_PREFIX}${label.trim().toLowerCase()}`;
}

export function getMemoryTopicLabelFromKey(key: string) {
  return key.startsWith(TOPIC_PREFIX) ? key.slice(TOPIC_PREFIX.length) : key;
}

function cleanTopicLabel(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function isTopicLabelUsable(label: string) {
  return label.length >= 2 && label.length <= 14 && !IGNORED_TOPIC_LABELS.has(label);
}

function extractTextTopics(text: string) {
  const compact = text.replace(/[，。！？、；：,.!?;:()[\]【】「」"']/g, ' ');
  return compact
    .split(/\s+/)
    .map(cleanTopicLabel)
    .filter(isTopicLabelUsable)
    .slice(0, 4);
}

export function deriveMemoryTopicLabels(memory: MemoryEntry) {
  if (memory.type === 'archived' || memory.type === 'feel' || isWhisperMemory(memory) || isDailyImpressionMemory(memory)) {
    return [];
  }
  const raw = [
    memory.domain,
    ...memory.tags,
    ...memory.recallCues.slice(0, 4),
  ];
  return Array.from(new Set(raw.map(cleanTopicLabel).filter(isTopicLabelUsable))).slice(0, 6);
}

function deriveCurrentStateTopicLabels(state: MemoryCurrentState, sourceMemoryTopics: string[] = []) {
  const kindLabel = getMemoryCurrentStateKindLabel(state.kind);
  const raw = [
    ...sourceMemoryTopics,
    kindLabel,
    ...extractTextTopics(`${state.title} ${state.sourceTitle ?? ''}`),
  ];
  return Array.from(new Set(raw.map(cleanTopicLabel).filter(isTopicLabelUsable))).slice(0, 5);
}

function inferTopicKind(label: string): MemoryTopicKind {
  if (/白云|小仓鼠|朋友|妈妈|爸爸|老师|同学|家人|对象|伴侣/.test(label)) return 'person';
  if (/君落|APP|系统|功能|项目|星图|附近世界|记忆|工具包|界面|前端|后端|代码/.test(label)) return 'project';
  if (/家|学校|商场|公园|城市|区|街|路|店|景点|地点|附近/.test(label)) return 'place';
  if (/喜欢|偏好|音乐|歌|游戏|食物|饮料|蛋黄酥|兴趣/.test(label)) return 'interest';
  if (/相处|称呼|边界|约定|关系|承诺/.test(label)) return 'relationship';
  if (/睡眠|身体|情绪|心情|焦虑|疼|难受|低落|状态|当前/.test(label)) return 'state';
  if (/经历|事件|校园|考试|旅行|出门|回忆|历史/.test(label)) return 'event';
  return 'other';
}

function relationTouchesTopic(edge: MemoryEdge, ids: Set<string>) {
  return ids.has(edge.sourceId) || ids.has(edge.targetId);
}

async function ensureTopicOverrideTable() {
  if (topicOverrideTableReady) return;
  await getMemoryDatabase();
  topicOverrideTableReady = true;
}

function rowToOverride(row: TopicOverrideRow): MemoryTopicOverride {
  return {
    displayName: row.display_name?.trim() || undefined,
    hidden: !!row.hidden,
    key: row.topic_key,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : 0,
  };
}

export async function loadMemoryTopicOverrides() {
  await ensureTopicOverrideTable();
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<TopicOverrideRow>(
    'SELECT * FROM memory_topic_overrides ORDER BY updated_at DESC',
  );
  return new Map(rows.map((row) => {
    const override = rowToOverride(row);
    return [override.key, override] as const;
  }));
}

export function resolveMemoryTopicLabel(label: string, overrides: Map<string, MemoryTopicOverride>) {
  const key = createMemoryTopicKey(label);
  const override = overrides.get(key);
  return {
    displayName: override?.displayName || label,
    hidden: !!override?.hidden,
    key,
  };
}

async function upsertMemoryTopicOverride(key: string, patch: { displayName?: string | null; hidden?: boolean }) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    await ensureTopicOverrideTable();
    const database = await getMemoryDatabase();
    const now = Date.now();
    const existing = await database.getFirstAsync<TopicOverrideRow>(
      'SELECT * FROM memory_topic_overrides WHERE topic_key = ?',
      key,
    );
    const displayName = patch.displayName !== undefined
      ? patch.displayName?.replace(/\s+/g, ' ').trim().slice(0, 24) || null
      : existing?.display_name ?? null;
    const hidden = patch.hidden !== undefined ? patch.hidden : !!existing?.hidden;
    await database.runAsync(
      `INSERT OR REPLACE INTO memory_topic_overrides (topic_key, display_name, hidden, updated_at)
       VALUES (?, ?, ?, ?)`,
      key,
      displayName,
      hidden ? 1 : 0,
      now,
    );
  });
}

export async function renameMemoryTopic(topicKey: string, displayName: string) {
  await upsertMemoryTopicOverride(topicKey, { displayName });
}

export async function hideMemoryTopic(topicKey: string) {
  await upsertMemoryTopicOverride(topicKey, { hidden: true });
}

export async function restoreMemoryTopic(topicKey: string) {
  await upsertMemoryTopicOverride(topicKey, { hidden: false });
}

export async function loadMemoryTopicProfiles(options: { includeHidden?: boolean; limit?: number } = {}) {
  const [memories, edges, states, overrides] = await Promise.all([
    loadMemories({ includeArchived: false }),
    loadAllMemoryEdges(0),
    loadActiveMemoryCurrentStates({ limit: 50, currentOnly: true }),
    loadMemoryTopicOverrides(),
  ]);
  const memoryById = new Map(memories.map((memory) => [memory.id, memory]));
  const topicMemories = new Map<string, MemoryEntry[]>();
  const topicRawLabels = new Map<string, string>();
  const memoryTopics = new Map<string, string[]>();

  memories.forEach((memory) => {
    const labels = deriveMemoryTopicLabels(memory);
    memoryTopics.set(memory.id, labels);
    labels.forEach((label) => {
      const key = createMemoryTopicKey(label);
      topicRawLabels.set(key, label);
      const list = topicMemories.get(key) ?? [];
      list.push(memory);
      topicMemories.set(key, list);
    });
  });

  const topicStates = new Map<string, MemoryCurrentState[]>();
  states.forEach((state) => {
    const sourceTopics = state.sourceMemoryId ? memoryTopics.get(state.sourceMemoryId) ?? [] : [];
    deriveCurrentStateTopicLabels(state, sourceTopics).forEach((label) => {
      const key = createMemoryTopicKey(label);
      topicRawLabels.set(key, topicRawLabels.get(key) ?? label);
      const list = topicStates.get(key) ?? [];
      list.push(state);
      topicStates.set(key, list);
    });
  });

  const profiles = Array.from(topicRawLabels.entries()).map(([key, label]) => {
    const override = overrides.get(key);
    const relatedMemories = topicMemories.get(key) ?? [];
    const relatedStates = topicStates.get(key) ?? [];
    const ids = new Set(relatedMemories.map((memory) => memory.id));
    const relatedEdges = edges.filter((edge) => relationTouchesTopic(edge, ids));
    const warningCount = relatedEdges.filter((edge) => {
      const source = memoryById.get(edge.sourceId) ?? null;
      const target = memoryById.get(edge.targetId) ?? null;
      return diagnoseMemoryEdge(edge, source, target).severity !== 'ok';
    }).length;
    const keyMemories = [...relatedMemories]
      .sort((left, right) => {
        const leftScore = left.importance * 3 + (left.anchor ? 12 : 0) + Math.max(left.updatedAt, left.lastActiveAt) / 86400000;
        const rightScore = right.importance * 3 + (right.anchor ? 12 : 0) + Math.max(right.updatedAt, right.lastActiveAt) / 86400000;
        return rightScore - leftScore;
      })
      .slice(0, 5);
    const recentUpdatedAt = Math.max(
      0,
      ...relatedMemories.map((memory) => Math.max(memory.updatedAt, memory.lastActiveAt, memory.createdAt)),
      ...relatedStates.map((state) => state.updatedAt),
    );
    return {
      activeStates: relatedStates.slice(0, 4),
      currentStateCount: relatedStates.length,
      displayName: override?.displayName || label,
      hidden: !!override?.hidden,
      key,
      keyMemories,
      kind: inferTopicKind(label),
      label,
      memoryCount: relatedMemories.length,
      recentUpdatedAt,
      relationCount: relatedEdges.length,
      tags: Array.from(new Set(relatedMemories.flatMap((memory) => [memory.domain, ...memory.tags]).filter(isTopicLabelUsable))).slice(0, 8),
      warningCount,
    } satisfies MemoryTopicProfile;
  });

  return profiles
    .filter((profile) => options.includeHidden || !profile.hidden)
    .filter((profile) => profile.memoryCount > 0 || profile.currentStateCount > 0)
    .sort((left, right) => {
      if (left.hidden !== right.hidden) return left.hidden ? 1 : -1;
      return (right.memoryCount + right.currentStateCount * 2) - (left.memoryCount + left.currentStateCount * 2)
        || right.recentUpdatedAt - left.recentUpdatedAt
        || left.displayName.localeCompare(right.displayName, 'zh-CN');
    })
    .slice(0, Math.max(1, Math.min(80, options.limit ?? 60)));
}

export async function buildMemoryTopicProfile(topicKey: string, options: { includeHidden?: boolean } = {}) {
  const profiles = await loadMemoryTopicProfiles({ includeHidden: options.includeHidden, limit: 80 });
  return profiles.find((profile) => profile.key === topicKey) ?? null;
}
