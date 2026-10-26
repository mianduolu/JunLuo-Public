import { listAssistantLifeDays, loadAssistantLifeDay } from '../ai/assistantLifeTimeline';
import { isTimelineEligibleMemory, loadMemories, loadTogetherWalkedMemoryLinks, type MemoryEntry } from '../memory/memoryStore';
import { createMemoryMaterialPreparation, type MemoryMaterialPreparation } from '../memory/memoryCurrentMaterials';
import type { MemoryUsageReference } from '../memory/memoryReplyUsage';
import { loadTogetherWalkedEntriesStrict, type TogetherWalkedEntry } from '../memory/togetherWalkedStore';
import { loadLetterTicketOccurrencesBetween } from '../schedule/scheduleStore';
import {
  getPreviousRelationshipDateOccurrence,
  listRelationshipDateOccurrencesBetween,
  localDateAtMinutes,
  type RelationshipDateV1,
} from './relationshipDateCalendar';
import { loadRelationshipDates } from './relationshipDateStore';
import {
  sortLetterDateTicketCandidates,
  type LetterDateTicketCandidate,
} from './letterDateTicketCore';
import {
  resolveLetterMaterialOccurredAt,
  selectAnnualLetterMaterials,
} from './letterGenerationContract';

export { sortLetterDateTicketCandidates } from './letterDateTicketCore';
export type { LetterDateTicketCandidate } from './letterDateTicketCore';

export type AnnualLetterMaterial = {
  id: string;
  occurredAt: number;
  importance: number;
  anchored: boolean;
  text: string;
};

const DAY_MS = 24 * 60 * 60 * 1000;

function relationshipDateCandidate(
  record: RelationshipDateV1,
  occurrence: ReturnType<typeof listRelationshipDateOccurrencesBetween>[number],
): LetterDateTicketCandidate {
  return {
    dateId: occurrence.id,
    source: 'relationship-date',
    sourceRecordId: record.id,
    scheduledAt: occurrence.scheduledAt,
    eventTitle: record.title,
    ...(record.note ? { eventNote: record.note } : {}),
    annual: occurrence.annual,
  };
}

export async function loadLetterDateTicketCandidatesBetween(startAt: number, endAt: number) {
  const [relationshipDates, scheduleOccurrences] = await Promise.all([
    loadRelationshipDates(startAt),
    loadLetterTicketOccurrencesBetween(startAt, endAt),
  ]);
  const relationshipCandidates = relationshipDates
    .filter((record) => record.letterEnabled)
    .flatMap((record) => (
      listRelationshipDateOccurrencesBetween(record, startAt, Math.max(startAt, endAt - 1))
        .map((occurrence) => relationshipDateCandidate(record, occurrence))
    ));
  const scheduleCandidates: LetterDateTicketCandidate[] = scheduleOccurrences.map((occurrence) => ({
    dateId: occurrence.id,
    source: 'schedule',
    sourceRecordId: occurrence.itemId,
    scheduledAt: occurrence.scheduledStartAt,
    eventTitle: occurrence.title,
    ...(occurrence.notes.trim() ? { eventNote: occurrence.notes.trim() } : {}),
    annual: false,
  }));
  return sortLetterDateTicketCandidates([...relationshipCandidates, ...scheduleCandidates]);
}

function memoryMaterial(memory: MemoryEntry): AnnualLetterMaterial {
  const occurredAt = resolveLetterMaterialOccurredAt(memory);
  return {
    id: `memory:${memory.id}`,
    occurredAt,
    importance: memory.importance,
    anchored: memory.pinned || memory.anchor || memory.importance >= 8,
    text: `${new Date(occurredAt).toLocaleDateString('zh-CN')}｜${memory.title}\n${memory.content}`,
  };
}

async function loadLifeTimelineMaterials(from: number, to: number) {
  const dayKeys = await listAssistantLifeDays(90).catch(() => []);
  const days = await Promise.all(dayKeys.map((dateKey) => loadAssistantLifeDay(dateKey).catch(() => null)));
  return days.flatMap((day) => day?.timelineEntries ?? [])
    .filter((entry) => entry.at >= from && entry.at <= to)
    .map((entry): AnnualLetterMaterial => ({
      id: `assistant-life:${entry.id}`,
      occurredAt: entry.at,
      importance: entry.source === 'chat-afterglow' ? 6 : 4,
      anchored: false,
      text: `${new Date(entry.at).toLocaleDateString('zh-CN')}｜${entry.title}\n${entry.activity}`,
    }));
}

function togetherWalkedId(memory: MemoryEntry) {
  const prefix = 'together-walked:';
  return memory.source?.startsWith(prefix) ? memory.source.slice(prefix.length) : undefined;
}

function walkedMaterial(entry: TogetherWalkedEntry): AnnualLetterMaterial {
  return {
    id: `together-walked:${entry.id}`,
    occurredAt: entry.createdAt,
    importance: 7,
    anchored: true,
    text: `${new Date(entry.createdAt).toLocaleDateString('zh-CN')}｜${entry.title}${entry.note.trim() ? `\n${entry.note.trim()}` : ''}`,
  };
}

function dedupeAnnualMaterials(materials: readonly AnnualLetterMaterial[]) {
  const selected = new Map<string, AnnualLetterMaterial>();
  for (const material of materials) {
    const current = selected.get(material.id);
    if (
      !current
      || material.importance > current.importance
      || (material.importance === current.importance && material.occurredAt > current.occurredAt)
    ) selected.set(material.id, material);
  }
  return [...selected.values()];
}

export async function prepareRelationshipDateAnnualMaterials(input: {
  now: number;
  ticket: LetterDateTicketCandidate;
  preparation?: MemoryMaterialPreparation;
}) {
  const empty = () => ({ materials: [] as string[], refresh: async () => [] as string[], usageReferences: () => [] as MemoryUsageReference[] });
  if (input.ticket.source !== 'relationship-date' || !input.ticket.annual) return empty();
  const record = (await loadRelationshipDates(input.now))
    .find((item) => item.id === input.ticket.sourceRecordId);
  if (!record || record.mode === 'once') return empty();
  const preparation = input.preparation ?? createMemoryMaterialPreparation();
  const previous = getPreviousRelationshipDateOccurrence(record, input.ticket.scheduledAt);
  const originAt = localDateAtMinutes(record.originDateKey, record.openTimeMinutes) ?? input.now - 366 * DAY_MS;
  const from = previous && previous.scheduledAt >= originAt ? previous.scheduledAt : originAt;
  const [allMemories, timeline, entries] = await Promise.all([
    loadMemories({ includeArchived: false, currentOnly: true }),
    loadLifeTimelineMaterials(Math.max(from, input.now - 90 * DAY_MS), input.now),
    loadTogetherWalkedEntriesStrict(),
  ]);
  const eligible = (memory: MemoryEntry) => isTimelineEligibleMemory(memory)
    && resolveLetterMaterialOccurredAt(memory) >= from && resolveLetterMaterialOccurredAt(memory) <= input.now;
  const targets = new Map<string, Pick<TogetherWalkedEntry, 'id' | 'memoryId'>>(entries.map(entry => [entry.id, entry]));
  for (const memory of allMemories.filter(eligible)) {
    const id = togetherWalkedId(memory);
    if (id && !targets.has(id)) targets.set(id, { id, memoryId: memory.id });
  }
  const links = await loadTogetherWalkedMemoryLinks([...targets.values()]);
  let memories = allMemories.filter(eligible).filter(memory => {
    const id = togetherWalkedId(memory);
    return !id || links.get(id)?.status === 'linked' && links.get(id)?.memory?.id === memory.id;
  });
  const inWindow = (entry: TogetherWalkedEntry) => entry.createdAt >= from && entry.createdAt <= input.now;
  const walked = entries.filter(inWindow).flatMap((entry): AnnualLetterMaterial[] => {
    const link = links.get(entry.id);
    if (link?.status === 'linked' && link.memory && eligible(link.memory)) {
      memories.push(link.memory);
      return [memoryMaterial(link.memory)];
    }
    return link?.status === 'unlinked' ? [walkedMaterial(entry)] : [];
  });
  memories = [...new Map(memories.map(memory => [memory.id, memory])).values()];
  const candidates = dedupeAnnualMaterials([...memories.map(memoryMaterial), ...timeline, ...walked]);
  const selectedOrder = selectAnnualLetterMaterials(candidates.map(material => ({ ...material, text: material.id })), from, input.now);
  const byId = new Map(candidates.map(material => [material.id, material]));
  const selected = selectedOrder.map(id => byId.get(id)!);
  const selectedIds = new Set(selectedOrder);
  memories = memories.filter(memory => selectedIds.has(`memory:${memory.id}`));
  const independent = selected.filter(material => material.id.startsWith('assistant-life:'));
  const walkedSelections = new Map<string, {
    id: string; memoryId?: string; version?: string; refreshed: boolean; omitted: boolean;
  }>();
  for (const memory of memories) {
    const id = togetherWalkedId(memory);
    if (id) walkedSelections.set(id, { id, memoryId: memory.id, refreshed: false, omitted: false });
  }
  for (const entry of entries) {
    if (selectedIds.has(`together-walked:${entry.id}`)) walkedSelections.set(entry.id, {
      id: entry.id, version: JSON.stringify(walkedMaterial(entry)), refreshed: false, omitted: false,
    });
  }
  let sentMemoryIds = new Set<string>();
  const refresh = async () => {
    const attemptedIds = new Set(memories.map(memory => memory.id));
    memories = await preparation.refresh(memories, eligible);
    const latestEntries = new Map((await loadTogetherWalkedEntriesStrict()).map(entry => [entry.id, entry]));
    const active = [...walkedSelections.values()].filter(selection => !selection.omitted);
    const latestLinks = await loadTogetherWalkedMemoryLinks(active.map(selection => ({
      id: selection.id, memoryId: latestEntries.get(selection.id)?.memoryId ?? selection.memoryId,
    })));
    const linked: AnnualLetterMaterial[] = [];
    const unlinked: AnnualLetterMaterial[] = [];
    for (const selection of active) {
      const link = latestLinks.get(selection.id);
      if (link?.status === 'linked' && link.memory) {
        if (selection.memoryId && selection.memoryId !== link.memory.id || !eligible(link.memory)) {
          selection.omitted = true; continue;
        }
        // Once a formal card exists, its identity survives a lost journey mirror.
        selection.memoryId = link.memory.id;
        const memory = memories.find(item => item.id === link.memory!.id);
        if (memory) {
          if (JSON.stringify(memoryMaterial(memory)) === JSON.stringify(memoryMaterial(link.memory))) linked.push(memoryMaterial(memory));
        } else if (!attemptedIds.has(link.memory.id)) {
          // The next existing refresh must certify a newly linked card before sending.
          memories.push(link.memory);
        } else selection.omitted = true;
        continue;
      }
      const entry = latestEntries.get(selection.id);
      if (link?.status !== 'unlinked' || selection.memoryId || !entry || !inWindow(entry)) {
        selection.omitted = true; continue;
      }
      const material = walkedMaterial(entry);
      const version = JSON.stringify(material);
      if (selection.version !== version) {
        if (selection.refreshed) { selection.omitted = true; continue; }
        selection.refreshed = true;
        selection.version = version;
      }
      unlinked.push(material);
    }
    memories = memories.filter(memory => {
      const id = togetherWalkedId(memory);
      return !id || walkedSelections.get(id)?.omitted === false;
    });
    preparation.assertCurrent();
    const current = dedupeAnnualMaterials([
      ...memories.filter(memory => !togetherWalkedId(memory)).map(memoryMaterial), ...linked, ...independent, ...unlinked,
    ]);
    const order = selectAnnualLetterMaterials(current.map(item => ({ ...item, text: item.id })), from, input.now).slice(0, 16);
    sentMemoryIds = new Set(order);
    const currentById = new Map(current.map(item => [item.id, item.text]));
    return order.map(id => currentById.get(id)!);
  };
  return { materials: await refresh(), refresh, usageReferences: () => preparation.usageReferences(
    memories.filter(memory => sentMemoryIds.has(`memory:${memory.id}`)),
  ) };
}

export async function loadRelationshipDateAnnualMaterials(input: {
  now: number;
  ticket: LetterDateTicketCandidate;
}) {
  const prepared = await prepareRelationshipDateAnnualMaterials(input);
  return prepared.refresh();
}
