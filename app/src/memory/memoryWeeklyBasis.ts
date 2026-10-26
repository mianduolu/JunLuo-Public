import type { SQLiteDatabase } from 'expo-sqlite';
import type { MemoryCandidateReview } from './memoryCandidateReview';
import { getMemoryOccurrenceStart, stableMemoryHash } from './memoryAtomicity';
import { currentMemoryComments } from './memoryCurrentMaterials';
import { memoryFromRow, type MemoryComment, type MemoryEntry, type MemorySourceRefInput } from './memoryStore';

export type WeeklyContextBasis = {
  version: 1;
  weekKey: string;
  startAt: number;
  endAt: number;
  materials: Array<{ memoryId: string; hash: string }>;
  sourceHash: string;
};
export type WeeklyContextStatus = 'current' | 'stale' | 'unverified';
export type WeeklyDatabase = Pick<SQLiteDatabase, 'getAllAsync' | 'getFirstAsync'>;

export function isWeeklyContextMemory(memory: Pick<MemoryEntry, 'source'>) {
  return memory.source === 'weekly-context';
}

export function weeklyRangeFromKey(key?: string) {
  if (!key || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day || date.getDay() !== 1) return null;
  const end = new Date(year, month - 1, day + 7).getTime();
  return { key, start: date.getTime(), end };
}

export function parseWeeklyContextBasis(value: unknown): WeeklyContextBasis | undefined {
  try {
    const item = typeof value === 'string' ? JSON.parse(value) : value;
    if (!item || item.version !== 1 || typeof item.weekKey !== 'string') return undefined;
    const week = weeklyRangeFromKey(item.weekKey);
    if (!week || item.startAt !== week.start || item.endAt !== week.end || !Array.isArray(item.materials)
      || !item.materials.length || item.materials.length > 18 || typeof item.sourceHash !== 'string') return undefined;
    const seen = new Set<string>();
    for (const material of item.materials) {
      if (!material || typeof material.memoryId !== 'string' || !material.memoryId || seen.has(material.memoryId)
        || typeof material.hash !== 'string' || !material.hash) return undefined;
      seen.add(material.memoryId);
    }
    if (item.sourceHash !== stableMemoryHash(JSON.stringify([item.weekKey, item.materials]))) return undefined;
    return item as WeeklyContextBasis;
  } catch { return undefined; }
}

export function isWeeklyEpisode(memory: MemoryEntry) {
  return memory.source === 'episode-memory' || memory.tags.includes('阶段记忆')
    || (memory.semanticType === 'case' && memory.sourceType === 'digest');
}

export function isWeeklyMaterial(memory: MemoryEntry, week: { start: number; end: number }) {
  const at = getMemoryOccurrenceStart(memory.eventTime);
  return !memory.understandingSubject && memory.type !== 'archived' && memory.type !== 'feel'
    && memory.period !== 'whisper' && memory.source !== 'assistant-life-state'
    && !memory.tags.some(tag => ['whisper', '碎碎念', '白云动态'].includes(tag.toLowerCase()))
    && !isWeeklyContextMemory(memory) && !memory.tags.includes('周脉络')
    && at !== undefined && at >= week.start && at < week.end
    && (isWeeklyEpisode(memory) || memory.importance >= 6 || ['边界', '约定', '称呼'].includes(memory.domain)
      || memory.tags.some(tag => ['更新', '确认', '纠正', '质量信号'].includes(tag)));
}

export function selectWeeklyMaterials(memories: MemoryEntry[], week: { start: number; end: number }, limit = 18) {
  return memories.filter(memory => isWeeklyMaterial(memory, week)).sort((left, right) =>
    Number(isWeeklyEpisode(right)) - Number(isWeeklyEpisode(left)) || right.importance - left.importance
    || getMemoryOccurrenceStart(left.eventTime)! - getMemoryOccurrenceStart(right.eventTime)!
    || left.id.localeCompare(right.id)).slice(0, limit);
}

export async function collectWeeklyMaterials(database: WeeklyDatabase, memories: MemoryEntry[], week: { key: string; start: number; end: number }) {
  const comments: string[] = [];
  const refs = new Map<string, MemorySourceRefInput>();
  const materials: WeeklyContextBasis['materials'] = [];
  // Preserve the old per-card ordering and hash shape, while reading each set once.
  const commentIds = memories.slice(0, 8).map(memory => memory.id);
  const commentRows = commentIds.length ? await database.getAllAsync<{
    id: string; memory_id: string; content: string; source_type: MemoryComment['sourceType'];
    kind: MemoryComment['kind']; author: string; source: string | null; created_at: number;
  }>(`SELECT * FROM memory_comments WHERE memory_id IN (${commentIds.map(() => '?').join(',')}) ORDER BY created_at DESC, id ASC`, ...commentIds) : [];
  const ids = memories.map(memory => memory.id);
  const allSourceRows = ids.length ? await database.getAllAsync<{
    memory_id: string; session_id: string; message_id: string; role: 'I' | 'you'; message_created_at: number; relation: string;
  }>(`SELECT memory_id, session_id, message_id, role, message_created_at, relation FROM memory_source_refs WHERE memory_id IN (${ids.map(() => '?').join(',')}) ORDER BY message_created_at, session_id, message_id, relation`, ...ids) : [];
  let dateFormatter: Intl.DateTimeFormat | undefined;
  const formatCommentTime = (at: number) => {
    const date = new Date(at);
    return Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN')
      : (dateFormatter ??= new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric' })).format(date);
  };
  for (let index = 0; index < memories.length; index += 1) {
    const memory = memories[index];
    const rows = index < 8 ? commentRows.filter(row => row.memory_id === memory.id) : [];
    const notes = currentMemoryComments(memory, rows.map(row => ({
      id: row.id, memoryId: row.memory_id, content: row.content, sourceType: row.source_type,
      kind: row.kind, author: row.author, source: row.source ?? undefined, createdAt: row.created_at,
    }))).filter(comment => ['correction', 'update', 'confirmation', 'dehydration', 'merge'].includes(comment.kind))
      .slice(0, Math.min(2, 12 - comments.length));
    const formatted = notes.map(comment => `${memory.title} / ${comment.kind} / ${formatCommentTime(comment.createdAt)}：${comment.content}`);
    comments.push(...formatted);
    // memory_id is only a grouping key, never a new component of saved basis hashes.
    const sourceRows = allSourceRows.filter(row => row.memory_id === memory.id)
      .map(({ memory_id: _id, ...row }) => row);
    for (const row of sourceRows) {
      const key = `${row.session_id}\u0000${row.message_id}`;
      if (!refs.has(key) && refs.size < 80) refs.set(key, {
        sessionId: row.session_id, messageId: row.message_id, role: row.role,
        messageCreatedAt: row.message_created_at, relation: 'derived',
      });
    }
    materials.push({ memoryId: memory.id, hash: stableMemoryHash(JSON.stringify([
      memory.title, memory.content, memory.domain, memory.semanticType, memory.importance, memory.tags,
      memory.eventTime, memory.eventAt, memory.date, isWeeklyMaterial(memory, week), formatted, sourceRows,
    ])) });
  }
  const basis: WeeklyContextBasis = {
    version: 1, weekKey: week.key, startAt: week.start, endAt: week.end, materials,
    sourceHash: stableMemoryHash(JSON.stringify([week.key, materials])),
  };
  const sourceRefsByMemory = new Map(memories.map(memory => [memory.id, allSourceRows.filter(row => row.memory_id === memory.id)
    .map(row => ({ sessionId: row.session_id, relation: row.relation === 'direct' ? 'direct' as const : 'derived' as const }))]));
  return { basis, comments, sourceRefs: [...refs.values()], sourceRefsByMemory };
}

export async function weeklyBasisMatches(database: WeeklyDatabase, basis: WeeklyContextBasis,
  postOptions: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions = {}) {
  if (!parseWeeklyContextBasis(basis)) return false;
  const memories: MemoryEntry[] = [];
  const week = { key: basis.weekKey, start: basis.startAt, end: basis.endAt };
  const ids = basis.materials.map(material => material.memoryId);
  const rows = await database.getAllAsync<Parameters<typeof memoryFromRow>[0]>(
    `SELECT * FROM memories WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  const byId = new Map(rows.map(row => [row.id, row]));
  for (const material of basis.materials) {
    const row = byId.get(material.memoryId);
    if (!row) return false;
    const memory = memoryFromRow(row);
    if (!isWeeklyMaterial(memory, week)) return false;
    memories.push(memory);
  }
  const statuses = await (await import('../posts/baiyunPostMemoryBasis')).inspectPostDerivedTargets(database,
    memories.map(memory => ({ kind: 'memory', id: memory.id })), postOptions);
  if (statuses.some(target => target.status !== 'current')) return false;
  const collected = await collectWeeklyMaterials(database, memories, week);
  const reading = await (await import('../reading/readingMemoryOrganizationSource')).currentReadingOrganizationMemoryIds(database, memories, collected.sourceRefsByMemory);
  if (memories.some(memory => !reading.has(memory.id))) return false;
  return collected.basis.sourceHash === basis.sourceHash;
}

export async function getWeeklyContextStatus(database: WeeklyDatabase, memory: MemoryEntry,
  postOptions: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions = {}): Promise<WeeklyContextStatus> {
  if (!isWeeklyContextMemory(memory)) return 'current';
  const basis = parseWeeklyContextBasis(memory.weeklyContextBasis);
  if (!basis) return 'unverified';
  if (memory.date !== basis.weekKey) return 'stale';
  return await weeklyBasisMatches(database, basis, postOptions) ? 'current' : 'stale';
}

export async function filterCurrentWeeklyMemories(database: WeeklyDatabase, memories: readonly MemoryEntry[],
  postOptions: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions = {}) {
  const statuses = await Promise.all(memories.map(memory => getWeeklyContextStatus(database, memory, postOptions)));
  return memories.filter((_, index) => statuses[index] === 'current');
}

export function weeklyTargetHash(memory: MemoryEntry) {
  const { activationCount, lastActiveAt, lastSurfacedAt, surfaceCount, lastMentionedAt, statsSemanticsVersion,
    updatedAt, surfaceSuppressedUntil, tier, ...editable } = memory;
  return stableMemoryHash(JSON.stringify(editable));
}

export async function isWeeklyCandidateCurrent(database: WeeklyDatabase, candidate: MemoryCandidateReview,
  postOptions: import('../posts/baiyunPostMemorySource').PostMemoryReadOptions = {}) {
  if (candidate.source !== 'weekly-context') return true;
  const basis = parseWeeklyContextBasis(candidate.weeklyContextBasis);
  if (!basis || candidate.date !== basis.weekKey || !(await weeklyBasisMatches(database, basis, postOptions))) return false;
  if (!candidate.weeklyRefresh) return true;
  const row = await database.getFirstAsync<Parameters<typeof memoryFromRow>[0]>('SELECT * FROM memories WHERE id = ?', candidate.weeklyRefresh.memoryId);
  return !!row && row.type !== 'archived' && weeklyTargetHash(memoryFromRow(row)) === candidate.weeklyRefresh.targetHash;
}
