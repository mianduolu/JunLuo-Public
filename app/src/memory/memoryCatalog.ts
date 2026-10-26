import { buildMemoryIndexLine } from './memoryContextTextBuilder';
import {
  isDailyImpressionMemory,
  isWhisperMemory,
  loadMemories,
  type MemoryEntry,
} from './memoryStore';
import {
  getMemoryCurrentStateKindLabel,
  loadActiveMemoryCurrentStates,
  type MemoryCurrentState,
} from './memoryCurrentStateStore';
import {
  loadMemoryTopicProfiles,
  type MemoryTopicProfile,
} from './memoryTopicProfiles';

export type MemoryCatalogGroupId = 'anchors' | 'current_states' | 'topics' | 'important';

export type MemoryCatalogSourceType = 'memory' | 'topic' | 'current_state';

export type MemoryCatalogLine = {
  currentStateId?: string;
  group: MemoryCatalogGroupId;
  id: string;
  importance?: number;
  memoryId?: string;
  sourceType: MemoryCatalogSourceType;
  subtitle: string;
  tags: string[];
  title: string;
  topicKey?: string;
};

export type MemoryCatalogGroup = {
  id: MemoryCatalogGroupId;
  lines: MemoryCatalogLine[];
  title: string;
};

export type MemoryCatalogSnapshot = {
  groups: MemoryCatalogGroup[];
  summary: string;
  title: string;
};

type BuildMemoryCatalogSnapshotOptions = {
  includeHiddenTopics?: boolean;
  limitPerGroup?: number;
};

const DEFAULT_LIMIT_PER_GROUP = 8;

function compactText(text: string, limit: number) {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).replace(/[，,。；;、\s]+$/g, '')}…`;
}

function isCatalogMemory(memory: MemoryEntry) {
  return memory.type !== 'archived'
    && memory.type !== 'feel'
    && !isWhisperMemory(memory)
    && !isDailyImpressionMemory(memory);
}

function memorySubtitle(memory: MemoryEntry) {
  const parts = [
    memory.anchor ? '长期坐标' : '',
    memory.domain,
    memory.importance ? `重要度 ${memory.importance}` : '',
  ].filter(Boolean);
  return parts.join(' · ') || '普通记忆';
}

function memoryToCatalogLine(memory: MemoryEntry, group: MemoryCatalogGroupId): MemoryCatalogLine {
  return {
    group,
    id: `${group}:${memory.id}`,
    importance: memory.importance,
    memoryId: memory.id,
    sourceType: 'memory',
    subtitle: memorySubtitle(memory),
    tags: Array.from(new Set([memory.domain, ...memory.tags].filter(Boolean))).slice(0, 5),
    title: buildMemoryIndexLine(memory, undefined, { maxChars: 72 }),
  };
}

function stateToCatalogLine(state: MemoryCurrentState): MemoryCatalogLine {
  const kindLabel = getMemoryCurrentStateKindLabel(state.kind);
  return {
    currentStateId: state.id,
    group: 'current_states',
    id: `current_state:${state.id}`,
    sourceType: 'current_state',
    subtitle: `${kindLabel} · 近期便利贴`,
    tags: [kindLabel],
    title: compactText(`${state.title}：${state.content}`, 72),
  };
}

function topicToCatalogLine(profile: MemoryTopicProfile): MemoryCatalogLine {
  const tags = [profile.displayName, ...profile.tags].filter(Boolean);
  return {
    group: 'topics',
    id: `topic:${profile.key}`,
    sourceType: 'topic',
    subtitle: `记忆 ${profile.memoryCount} · 当前 ${profile.currentStateCount} · 关系 ${profile.relationCount}`,
    tags: Array.from(new Set(tags)).slice(0, 5),
    title: profile.displayName,
    topicKey: profile.key,
  };
}

function sortMemoriesForCatalog(left: MemoryEntry, right: MemoryEntry) {
  const leftScore = left.importance * 4 + (left.anchor ? 20 : 0) + (left.pinned ? 12 : 0)
    + Math.max(left.updatedAt, left.lastActiveAt, left.createdAt) / 86400000;
  const rightScore = right.importance * 4 + (right.anchor ? 20 : 0) + (right.pinned ? 12 : 0)
    + Math.max(right.updatedAt, right.lastActiveAt, right.createdAt) / 86400000;
  return rightScore - leftScore;
}

export async function buildMemoryCatalogSnapshot(
  options: BuildMemoryCatalogSnapshotOptions = {},
): Promise<MemoryCatalogSnapshot> {
  const limit = Math.max(3, Math.min(20, options.limitPerGroup ?? DEFAULT_LIMIT_PER_GROUP));
  const [memories, states, topics] = await Promise.all([
    loadMemories({ includeArchived: false }).catch(() => []),
    loadActiveMemoryCurrentStates({ limit, currentOnly: true }).catch(() => []),
    loadMemoryTopicProfiles({ includeHidden: options.includeHiddenTopics, limit }).catch(() => []),
  ]);

  const catalogMemories = memories.filter(isCatalogMemory);
  const anchorLines = catalogMemories
    .filter((memory) => memory.anchor || memory.pinned)
    .sort(sortMemoriesForCatalog)
    .slice(0, limit)
    .map((memory) => memoryToCatalogLine(memory, 'anchors'));
  const currentStateLines = states.slice(0, limit).map(stateToCatalogLine);
  const topicLines = topics
    .filter((topic) => options.includeHiddenTopics || !topic.hidden)
    .slice(0, limit)
    .map(topicToCatalogLine);
  const importantLines = catalogMemories
    .filter((memory) => memory.importance >= 7 && !memory.anchor && !memory.pinned)
    .sort(sortMemoriesForCatalog)
    .slice(0, limit)
    .map((memory) => memoryToCatalogLine(memory, 'important'));

  const groups: MemoryCatalogGroup[] = [
    { id: 'anchors', title: '长期坐标', lines: anchorLines },
    { id: 'current_states', title: '当前状态', lines: currentStateLines },
    { id: 'topics', title: '主题方向', lines: topicLines },
    { id: 'important', title: '重要记忆', lines: importantLines },
  ];
  const totalLines = groups.reduce((sum, group) => sum + group.lines.length, 0);
  const summary = totalLines
    ? `这份小抄整理了 ${totalLines} 条目录线索：长期坐标 ${anchorLines.length}、当前状态 ${currentStateLines.length}、主题方向 ${topicLines.length}、重要记忆 ${importantLines.length}。`
    : '记忆目录暂时很安静；等记忆多一点，这里会长出索引小抄。';

  return {
    groups,
    summary,
    title: totalLines ? '记忆目录小抄已整理' : '记忆目录小抄等待内容',
  };
}

export function formatMemoryCatalogForDebug(snapshot: MemoryCatalogSnapshot) {
  const parts = [snapshot.title, snapshot.summary];
  snapshot.groups.forEach((group) => {
    if (!group.lines.length) return;
    parts.push(`--- ${group.title}（${group.lines.length}）---`);
    group.lines.forEach((line) => {
      const tags = line.tags.length ? ` | ${line.tags.join('、')}` : '';
      const importance = typeof line.importance === 'number' ? ` | 重要度 ${line.importance}` : '';
      parts.push(`${line.title} | ${line.subtitle}${importance}${tags}`);
    });
  });
  return parts.join('\n');
}
