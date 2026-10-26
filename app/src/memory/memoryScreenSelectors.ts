import {
  isTimelineEligibleMemory,
  isWhisperMemory,
  type MemoryDomain,
  type MemoryEntry,
} from './memoryStore';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { formatMemoryEventTimeLabel, getMemoryOccurrenceStart } from './memoryAtomicity';

export type MemoryScreenViewMode = 'calendar' | 'pinned' | 'active' | 'all' | 'timeline' | 'archived' | 'weekly';

export function filterMemoryScreenMemories({
  domain,
  memories,
  mode,
  query,
  searchResults,
  now = Date.now(),
}: {
  domain?: MemoryDomain;
  memories: MemoryEntry[];
  mode: MemoryScreenViewMode;
  query: string;
  searchResults?: MemoryEntry[] | null;
  now?: number;
}) {
  const search = query.trim().toLowerCase();
  const base = searchResults ?? memories;
  const filtered = base.filter((memory) => {
    if (isWhisperMemory(memory) || isBaiyunPostMemory(memory)) return false;
    if (mode === 'weekly' && memory.source !== 'weekly-context') return false;
    if (mode === 'pinned' && !memory.pinned && !memory.anchor && memory.type !== 'permanent') return false;
    if (mode === 'active' && (memory.type === 'feel' || memory.type === 'archived' || memory.statsSemanticsVersion !== 1
      || memory.activationCount <= 0 || memory.lastActiveAt <= 0 || memory.lastActiveAt > now || now - memory.lastActiveAt > 7 * 86400000)) return false;
    if (mode === 'archived' && memory.type !== 'archived') return false;
    if (mode === 'all' && !memory.understandingSubject && !isTimelineEligibleMemory(memory) && memory.type !== 'permanent') return false;
    if (mode !== 'archived' && mode !== 'weekly' && memory.type === 'archived') return false;
    if (memory.type === 'feel') return false;
    if (domain && memory.domain !== domain) return false;
    if (!searchResults && search && !getMemorySearchText(memory).includes(search)) return false;
    return true;
  });
  return mode === 'active' ? filtered.sort((left, right) => right.lastActiveAt - left.lastActiveAt || left.id.localeCompare(right.id)) : filtered;
}

export function getMemoryScreenDateMemories(memories: MemoryEntry[], selectedDate: Date) {
  const selectedKey = dateKey(selectedDate);
  return memories.filter((memory) => !isWhisperMemory(memory) && !isBaiyunPostMemory(memory) && memory.period !== 'daily' && dateKey(new Date(getMemoryOccurrenceStart(memory.eventTime) ?? memory.createdAt)) === selectedKey);
}

export function getMemoryScreenMarkedDates(memories: MemoryEntry[]) {
  return new Set(memories.filter((memory) => !isWhisperMemory(memory) && !isBaiyunPostMemory(memory) && memory.period !== 'daily').map((memory) => dateKey(new Date(getMemoryOccurrenceStart(memory.eventTime) ?? memory.createdAt))));
}

export function getMemoryScreenTimeLabel(memory: MemoryEntry) {
  if (memory.understandingSubject) return `保存时间 ${new Date(memory.createdAt).toLocaleDateString('zh-CN')}`;
  if (getMemoryOccurrenceStart(memory.eventTime) !== undefined) {
    return `事件时间 ${formatMemoryEventTimeLabel(memory.eventTime)}`;
  }
  return `保存时间 ${new Date(memory.createdAt).toLocaleDateString('zh-CN')} · ${formatMemoryEventTimeLabel(memory.eventTime)}`;
}

export function getMemoryTimelineCandidates({
  memories,
  timelineSearch,
  existingMemoryIds,
}: {
  memories: MemoryEntry[];
  timelineSearch: string;
  existingMemoryIds: string[];
}) {
  const search = timelineSearch.trim().toLowerCase();
  const existingIds = new Set(existingMemoryIds);
  return memories
    .filter((memory) => !isBaiyunPostMemory(memory) && isTimelineEligibleMemory(memory) && !existingIds.has(memory.id))
    .filter((memory) => !search || getMemorySearchText(memory).includes(search))
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 20);
}

export function getMemoryMergeCandidates({
  memories,
  mergeQuery,
  selected,
}: {
  memories: MemoryEntry[];
  mergeQuery: string;
  selected: MemoryEntry | null;
}) {
  if (!selected) return [];
  const search = mergeQuery.trim().toLowerCase();
  return memories
    .filter((memory) => !memory.understandingSubject && !selected.understandingSubject && !isBaiyunPostMemory(memory) && memory.id !== selected.id)
    .filter((memory) => !search || getMemorySearchText(memory).includes(search))
    .sort((left, right) => Number(right.domain === selected.domain) - Number(left.domain === selected.domain));
}

export function dateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function getMemorySearchText(memory: MemoryEntry) {
  return `${memory.title} ${memory.content} ${memory.tags.join(' ')} ${memory.recallCues.join(' ')}`.toLowerCase();
}
