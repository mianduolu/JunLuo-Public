import type { AiConnection } from '../ai/types';
import { makeDerivedPeriodEventTime } from './memoryAtomicity';
import { generateWeeklyContextMemoryWithAi } from './memoryOrganizer';
import { collectWeeklyMaterials, isWeeklyEpisode, isWeeklyMaterial, selectWeeklyMaterials, weeklyBasisMatches, weeklyRangeFromKey, type WeeklyContextBasis, type WeeklyDatabase } from './memoryWeeklyBasis';
import { buildWeeklyMaterialText } from './memoryWeeklyMaterialText';
import {
  getMemoryDatabase,
  filterCurrentMemories,
  loadMemories,
  type MemoryDraft,
  type MemoryEntry,
  type MemorySourceRefInput,
} from './memoryStore';

const WEEKLY_MATERIAL_LIMIT = 18;
const IMPORTANT_MEMORY_THRESHOLD = 6;

function formatDateKey(timestamp: number) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isEpisodeMemory(memory: MemoryEntry) {
  return isWeeklyEpisode(memory);
}

export function getCurrentWeekRange(now = Date.now()) {
  const date = new Date(now);
  const day = date.getDay();
  const mondayOffset = (day + 6) % 7;
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset);
  const start = startDate.getTime();
  const end = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7).getTime();
  return { start, end, key: formatDateKey(start) };
}

export async function findWeeklyContextMaterials(options: { now?: number; limit?: number; weekKey?: string } = {}) {
  const week = options.weekKey ? weeklyRangeFromKey(options.weekKey) : getCurrentWeekRange(options.now);
  if (!week) return [];
  const memories = await loadMemories({ includeArchived: true, currentOnly: true });
  return selectWeeklyMaterials(memories, week, options.limit ?? WEEKLY_MATERIAL_LIMIT);
}

export async function hasWeeklyContextMemory(weekKey: string) {
  const memories = await loadMemories({ includeArchived: true });
  return memories.some((memory) => memory.source === 'weekly-context' && memory.date === weekKey);
}

function hasEnoughWeeklyMaterials(materials: MemoryEntry[]) {
  if (materials.some(isEpisodeMemory)) return true;
  return materials.filter((memory) => memory.importance >= IMPORTANT_MEMORY_THRESHOLD).length >= 5;
}

export type WeeklyContextPreparation = {
  basis: WeeklyContextBasis;
  comments: string[];
  materials: MemoryEntry[];
  sourceHash: string;
  sourceRefs: MemorySourceRefInput[];
  materialText: string;
  week: ReturnType<typeof getCurrentWeekRange>;
};

export async function prepareWeeklyContextCandidate(
  options: { now?: number; limit?: number; weekKey?: string; replacing?: boolean; memories?: MemoryEntry[]; database?: WeeklyDatabase;
    postOptions?: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions } = {},
): Promise<WeeklyContextPreparation | null> {
  const week = options.weekKey ? weeklyRangeFromKey(options.weekKey) : getCurrentWeekRange(options.now);
  if (!week) return null;
  const memories = options.memories ?? await loadMemories({ includeArchived: true });
  if (!options.replacing && memories.some(memory => memory.source === 'weekly-context' && memory.date === week.key)) return null;
  const database = options.database ?? await getMemoryDatabase();
  const current = await filterCurrentMemories(database, memories.filter(memory => isWeeklyMaterial(memory, week)), options.postOptions);
  const ranked = selectWeeklyMaterials(current, week, Math.min(18, options.limit ?? 18));
  const weekLabel = `${formatDateKey(week.start)} 至 ${formatDateKey(week.end - 1)}`;
  const { materials } = buildWeeklyMaterialText(ranked, [], weekLabel);
  if (!hasEnoughWeeklyMaterials(materials)) return null;
  const { basis, comments, sourceRefs } = await collectWeeklyMaterials(database, materials, week);
  const { materialText } = buildWeeklyMaterialText(materials, comments, weekLabel);
  return { basis, comments, materials, materialText, sourceHash: basis.sourceHash, sourceRefs, week };
}

export async function generateWeeklyContextCandidate(
  ai: { apiKey: string; connection: AiConnection },
  options: { now?: number; limit?: number; preparation?: WeeklyContextPreparation; signal?: AbortSignal } = {},
): Promise<(MemoryDraft & { sourceRefs: MemorySourceRefInput[] }) | null> {
  if (!ai.apiKey.trim()) return null;
  const preparation = options.preparation ?? await prepareWeeklyContextCandidate(options);
  if (!preparation) return null;
  const { comments, materials, sourceRefs, week } = preparation;
  if (!(await weeklyBasisMatches(await getMemoryDatabase(), preparation.basis))) throw new Error('MEMORY_WEEKLY_STALE');
  const draft = await generateWeeklyContextMemoryWithAi({
    apiKey: ai.apiKey,
    comments,
    connection: ai.connection,
    memories: materials,
    materialText: preparation.materialText,
    weekLabel: `${formatDateKey(week.start)} 至 ${formatDateKey(week.end - 1)}`,
    signal: options.signal,
  });
  if (!draft) return null;
  if (!(await weeklyBasisMatches(await getMemoryDatabase(), preparation.basis))) throw new Error('MEMORY_WEEKLY_STALE');

  return {
    ...draft,
    weeklyContextBasis: preparation.basis,
    date: week.key,
    eventAt: week.start,
    eventTime: makeDerivedPeriodEventTime(week.start, week.end - 1),
    sourceStartAt: week.start,
    sourceEndAt: week.end,
    recallCues: Array.from(new Set([week.key, '本周脉络', ...draft.recallCues])).slice(0, 8),
    tags: Array.from(new Set(['周脉络', ...draft.tags])).slice(0, 8),
    sourceRefs,
  };
}
