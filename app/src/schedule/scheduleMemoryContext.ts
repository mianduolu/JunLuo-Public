import { buildMemoryRecall, type MemoryDomain, type MemoryEntry } from '../memory/memoryStore';
import type { ScheduleMemoryReference } from './dayScheduler';

const ALLOWED_DOMAINS = new Set<MemoryDomain>(['经历', '日常', '约定']);
const DAY_MS = 24 * 60 * 60 * 1000;

export type ScheduleMemoryContext = {
  text: string;
  references: ScheduleMemoryReference[];
  missingCommitments: string[];
};

function memoryTimestamp(memory: MemoryEntry) {
  return memory.eventAt ?? memory.createdAt;
}

export function isScheduleMemoryEligible(memory: MemoryEntry, now = Date.now()) {
  if (!ALLOWED_DOMAINS.has(memory.domain) || memory.type === 'archived') return false;
  const age = Math.max(0, now - memoryTimestamp(memory));
  const importantAndRecent = memory.importance >= 4 && age <= 14 * DAY_MS;
  const emotionalAndRecent = (memory.valence >= 0.7 || memory.valence <= 0.3) && age <= 7 * DAY_MS;
  return importantAndRecent || emotionalAndRecent;
}

function compactText(value: string, maxLength = 120) {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function isCommitmentCovered(memory: MemoryEntry, taskTitles: string[]) {
  const haystack = taskTitles.join(' ').toLowerCase();
  const candidates = [memory.title, ...memory.tags, ...memory.recallCues]
    .flatMap((value) => value.toLowerCase().split(/[\s，。！？、；：,.!?;:()（）【】\[\]]+/))
    .filter((value) => value.length >= 2);
  return candidates.some((token) => haystack.includes(token));
}

export async function gatherScheduleMemoryContext(input: {
  originalText: string;
  dateKey: string;
  taskTitles: string[];
  now?: number;
}): Promise<ScheduleMemoryContext> {
  const query = [input.originalText, input.dateKey, ...input.taskTitles].filter(Boolean).join(' ');
  const recalled = await buildMemoryRecall(query, { maxResults: 20, touch: false });
  const seen = new Set<string>();
  const selected = recalled.items
    .map((item) => item.memory)
    .filter((memory) => isScheduleMemoryEligible(memory, input.now ?? Date.now()))
    .filter((memory) => {
      if (seen.has(memory.id)) return false;
      seen.add(memory.id);
      return true;
    })
    .slice(0, 5);
  const references = selected.map((memory) => ({
    id: memory.id,
    title: memory.title,
    summary: compactText(memory.content),
    domain: memory.domain,
    importance: memory.importance,
    valence: memory.valence,
  }));
  const missingCommitments = selected
    .filter((memory) => memory.domain === '约定' && !isCommitmentCovered(memory, input.taskTitles))
    .map((memory) => compactText(memory.title || memory.content, 60))
    .filter(Boolean)
    .slice(0, 3);
  return {
    references,
    missingCommitments,
    text: references.map((memory) => `- [${memory.domain}] ${memory.title}：${memory.summary}`).join('\n'),
  };
}
