import type { MemoryEntry } from './memoryStore';
import type { TogetherWalkedEntry } from './togetherWalkedModel';

export type TogetherWalkedMemoryTarget = Pick<TogetherWalkedEntry, 'id' | 'memoryId'>;
export type TogetherWalkedMemoryBinding = TogetherWalkedMemoryTarget & {
  materialVersion: string;
  dataEpoch: number;
};
export type TogetherWalkedMemoryLink = {
  status: 'linked' | 'unlinked' | 'missing' | 'archived' | 'conflict';
  memory?: MemoryEntry;
  memoryIds: string[];
};

export function togetherWalkedMemorySource(entryId: string) {
  return `together-walked:${entryId}`;
}

// Photo/route grouping changes do not change the text offered to memory.
export function togetherWalkedMaterialVersion(entry: TogetherWalkedEntry) {
  return JSON.stringify([entry.id, entry.title, entry.note, entry.createdAt,
    entry.location?.label ?? null, entry.location?.latitude ?? null, entry.location?.longitude ?? null]);
}

export function resolveTogetherWalkedMemoryLink(
  target: TogetherWalkedMemoryTarget,
  records: readonly MemoryEntry[],
): TogetherWalkedMemoryLink {
  const source = togetherWalkedMemorySource(target.id);
  const candidates = records.filter(memory => memory.source === source);
  const known = target.memoryId ? records.find(memory => memory.id === target.memoryId) : undefined;
  const memoryIds = [...new Set([...candidates.map(memory => memory.id), ...(target.memoryId ? [target.memoryId] : [])])];
  if (candidates.length > 1 || (known && known.source !== source)
    || (target.memoryId && candidates.some(memory => memory.id !== target.memoryId))) {
    return { status: 'conflict', memoryIds };
  }
  if (target.memoryId && !known) return { status: 'missing', memoryIds };
  const memory = known ?? candidates[0];
  if (!memory) return { status: 'unlinked', memoryIds };
  return { status: memory.type === 'archived' ? 'archived' : 'linked', memory, memoryIds };
}

export function assertTogetherWalkedMemoryLink(link: TogetherWalkedMemoryLink) {
  if (link.status === 'missing') throw new Error('TOGETHER_WALKED_MEMORY_MISSING');
  if (link.status === 'archived') throw new Error('TOGETHER_WALKED_MEMORY_ARCHIVED');
  if (link.status === 'conflict') throw new Error(`TOGETHER_WALKED_MEMORY_CONFLICT:${link.memoryIds.join(',')}`);
}
