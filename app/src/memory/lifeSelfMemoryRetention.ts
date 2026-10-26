/** IDs are projected from existing evidence and ingestion records, never from a source reader. */
export type LifeSelfRetainedIds = { exploration: Set<string>; wish: Set<string> };
export type LifeSelfRetentionReader = {
  getAllAsync<T>(source: string): Promise<T[]>;
};

export function parseLifeSelfRetentionSource(value: unknown): { kind: 'exploration' | 'wish'; id: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^life-self-v1:(exploration|wish):(.+)$/.exec(value);
  if (!match) return null;
  try {
    const id = decodeURIComponent(match[2]);
    return id ? { kind: match[1] as 'exploration' | 'wish', id } : null;
  } catch { return null; }
}

export function collectLifeSelfRetainedIds(values: readonly unknown[]): LifeSelfRetainedIds {
  const result: LifeSelfRetainedIds = { exploration: new Set(), wish: new Set() };
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    const source = parseLifeSelfRetentionSource(record.sessionId ?? record.session_id);
    if (source) result[source.kind].add(source.id);
    if ((record.kind === 'exploration' || record.kind === 'wish') && typeof record.id === 'string' && record.id) {
      result[record.kind].add(record.id);
    }
    Object.values(record).forEach(visit);
  };
  values.forEach(visit);
  return result;
}

export async function loadLifeSelfRetainedIds(database?: LifeSelfRetentionReader,
  explorations: readonly { id: string; at: number; memoryIngestionVersion?: 1 }[] = []): Promise<LifeSelfRetainedIds> {
  const reader = database ?? await (await import('./memoryStore')).getMemoryDatabase();
  const [memories, candidates, batches, cursors] = await Promise.all([
    reader.getAllAsync<{ value: string | null }>(
      "SELECT understanding_basis_json AS value FROM memories WHERE understanding_subject IS NOT NULL AND understanding_basis_json IS NOT NULL"),
    reader.getAllAsync<{ value: string | null }>(
      "SELECT candidate_json AS value FROM memory_ingestion_items WHERE status IN ('pending', 'waiting') AND candidate_json IS NOT NULL"),
    reader.getAllAsync<{ value: string | null; status: string }>(
      "SELECT work_metadata_json AS value, status FROM memory_ingestion_batches WHERE work_metadata_json IS NOT NULL"),
    reader.getAllAsync<{ through_created_at: number }>(
      "SELECT through_created_at FROM memory_ingestion_cursors WHERE scope_key = 'life-self-cutover' AND stream = 'proactive'"),
  ]);
  // A read/parse error must abort a prune, not masquerade as an empty reference set.
  const result = collectLifeSelfRetainedIds([...memories, ...candidates]
    .flatMap(row => row.value === null ? [] : [JSON.parse(row.value)]));
  const registrations: Array<{ kind: 'exploration' | 'wish'; id: string; sourceHash: string; sourceLength: number }> = [];
  const completed = new Map<string, Array<{ start: number; end: number }>>();
  const sourceKey = (entry: { kind: string; id: string; sourceHash: string }) => JSON.stringify([entry.kind, entry.id, entry.sourceHash]);
  for (const row of batches) {
    if (row.value === null) continue;
    const metadata = JSON.parse(row.value) as { lifeSelfRegistration?: typeof registrations[number];
      lifeSelfBindings?: Array<typeof registrations[number] & { start: number; end: number }> };
    const registration = metadata.lifeSelfRegistration;
    if (registration && (registration.kind === 'exploration' || registration.kind === 'wish')
      && typeof registration.id === 'string' && typeof registration.sourceHash === 'string') registrations.push(registration);
    const bindings = metadata.lifeSelfBindings ?? [];
    if (row.status !== 'resolved' && row.status !== 'no_value') {
      const pending = collectLifeSelfRetainedIds(bindings);
      pending.exploration.forEach(id => result.exploration.add(id));
      pending.wish.forEach(id => result.wish.add(id));
    } else {
      for (const binding of bindings) {
        if (!Number.isInteger(binding.start) || !Number.isInteger(binding.end) || binding.start < 0 || binding.end < binding.start) continue;
        const key = sourceKey(binding);
        completed.set(key, [...completed.get(key) ?? [], { start: binding.start, end: binding.end }]);
      }
    }
  }
  for (const registration of registrations) {
    let end = 0;
    for (const range of (completed.get(sourceKey(registration)) ?? []).sort((a, b) => a.start - b.start || a.end - b.end)) {
      if (range.start > end) break;
      end = Math.max(end, range.end);
    }
    if (!Number.isInteger(registration.sourceLength) || end < registration.sourceLength) result[registration.kind].add(registration.id);
  }
  const registeredExplorations = new Set(registrations.filter(entry => entry.kind === 'exploration').map(entry => entry.id));
  const cutover = cursors[0]?.through_created_at;
  for (const entry of explorations) {
    if ((entry.memoryIngestionVersion === 1 || Number.isFinite(cutover) && entry.at >= cutover)
      && !registeredExplorations.has(entry.id)) result.exploration.add(entry.id);
  }
  return result;
}

/** Protected originals do not consume the ordinary recent-record allowance. */
export function retainLifeSelfRecent<T extends { id: string }>(
  records: readonly T[], retained: ReadonlySet<string>, limit: number,
): T[] {
  const recent = new Set(records.filter(record => !retained.has(record.id)).slice(0, limit).map(record => record.id));
  return records.filter(record => retained.has(record.id) || recent.has(record.id));
}

