import type { WebVoyageLogEntry } from '../life/webVoyage';
import { listLifeSelfSources, loadLifeSelfSource, makeLifeSelfExplorationSource, prepareLifeSelfFragment,
  renderLifeSelfMaterial, validateLifeSelfBinding, type LifeSelfBinding, type LifeSelfSource,
  type PreparedLifeSelfMaterial } from '../life/lifeSelfMemorySource';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash } from './memoryAtomicity';
import { getMemoryDatabase } from './memoryStore';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { beginMemoryIngestionBatchWithDatabase, seedMemoryIngestionCursorWithDatabase,
  loadMemoryIngestionCursorWithDatabase, loadMemoryIngestionBatchWithDatabase,
  type MemoryIngestionBatchInput, type MemoryIngestionWorkMetadata } from './memoryIngestionLedger';
import { queryTerms } from './memoryRecallScoring';

export type LifeSelfRegistration = { kind: 'exploration'; id: string; sourceHash: string; availableAt: number; sourceLength: number };
export type LifeSelfWorkSource = { kind: 'exploration'; id: string; sourceHash: string; availableAt: number; countAsNew: boolean; carry: boolean };
export type PreparedLifeSelfOrganizationMaterial = PreparedLifeSelfMaterial & { batch: MemoryIngestionBatchInput };
export type LifeSelfOrganizationWork = {
  dataEpoch: number | null; eligibleSources: LifeSelfWorkSource[];
  pendingSources: Array<{ source: LifeSelfSource; start: number }>;
};
type Progress = { id: string; status: string; item_count: number; work_metadata_json: string };
const SCOPE = 'life-self-record';
const changed = () => { throw new Error('MEMORY_SOURCE_CHANGED'); };
const settled = (status: string) => status === 'resolved' || status === 'no_value';
const assertEpoch = (epoch: number | null) => { if (!canCommitBackupRestoreDataEpoch(epoch)) changed(); };
const sourceKey = (source: Pick<LifeSelfSource, 'kind' | 'id'>) => JSON.stringify([source.kind, source.id]);

export async function ensureLifeSelfMemoryCutover(at = Date.now()) {
  const database = await getMemoryDatabase('ingestion');
  const existing = await loadMemoryIngestionCursorWithDatabase(database, 'life-self-cutover', 'proactive');
  if (existing) return existing.throughCreatedAt;
  const epoch = captureBackupRestoreDataEpoch();
  const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    let start = at;
    await database.withExclusiveTransactionAsync(async transaction => {
      assertEpoch(epoch);
      const cursor = await seedMemoryIngestionCursorWithDatabase(transaction, { scopeKey: 'life-self-cutover',
        stream: 'proactive', throughCreatedAt: at, throughMessageId: 'life-self-v1' });
      start = cursor!.throughCreatedAt;
    });
    return start;
  }));
  if (!result.committed) return changed();
  return result.value;
}

async function registerSource(source: LifeSelfSource, availableAt: number) {
  if (source.kind !== 'exploration') return;
  const epoch = captureBackupRestoreDataEpoch();
  const id = `memory-life-self-registration-${stableMemoryHash(JSON.stringify([source.sessionId, source.sourceHash]))}`;
  const database = await getMemoryDatabase('ingestion');
  if (await loadMemoryIngestionBatchWithDatabase(database, id)) return;
  const registration: LifeSelfRegistration = { kind: 'exploration', id: source.id, sourceHash: source.sourceHash,
    availableAt, sourceLength: source.body.length };
  const result = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    await database.withExclusiveTransactionAsync(async transaction => {
      assertEpoch(epoch);
      await beginMemoryIngestionBatchWithDatabase(transaction, { id, scopeKey: SCOPE, stream: 'proactive', advancesCursor: false,
        sourceHash: source.sourceHash, workMetadata: { version: 1, workId: id, messageIds: [], lifeSelfRegistration: registration } });
    });
  }));
  if (!result.committed) changed();
}

export async function registerLifeSelfExploration(entry: WebVoyageLogEntry) {
  const start = await ensureLifeSelfMemoryCutover(entry.at);
  const source = makeLifeSelfExplorationSource(entry);
  if (source && (source.newExploration || entry.at >= start)) await registerSource(source, entry.at);
}

async function loadProgress() {
  const database = await getMemoryDatabase('ingestion');
  const rows = await database.getAllAsync<Progress>(`SELECT id, status, item_count, work_metadata_json
    FROM memory_ingestion_batches WHERE json_type(work_metadata_json, '$.lifeSelfBindings') IS NOT NULL
      OR json_type(work_metadata_json, '$.lifeSelfRegistration') IS NOT NULL ORDER BY created_at, id`);
  return rows.map(row => ({ ...row, work: JSON.parse(row.work_metadata_json) as MemoryIngestionWorkMetadata }));
}

export async function loadLifeSelfOrganizationRetry(sessionId: string) {
  const database = await getMemoryDatabase('ingestion');
  const row = await database.getFirstAsync<{ id: string }>(`SELECT id FROM memory_ingestion_batches
    WHERE scope_key = ? AND session_id = ? AND stream IN ('manual_digest', 'proactive')
      AND json_array_length(work_metadata_json, '$.lifeSelfBindings') > 0
      AND status IN ('pending', 'failed', 'waiting') AND item_count = 0 ORDER BY created_at, id LIMIT 1`, sessionId, sessionId);
  return row ? loadMemoryIngestionBatchWithDatabase(database, row.id) : null;
}

export async function nextLifeSelfOrganizationWork(): Promise<LifeSelfOrganizationWork> {
  const epoch = captureBackupRestoreDataEpoch();
  const start = await ensureLifeSelfMemoryCutover();
  const sources = (await listLifeSelfSources()).filter(source => source.kind !== 'exploration' || source.newExploration || source.message.createdAt >= start);
  for (const source of sources) if (source.kind === 'exploration') await registerSource(source, source.message.createdAt);
  const progress = await loadProgress();
  const work: LifeSelfOrganizationWork = { dataEpoch: epoch, eligibleSources: [], pendingSources: [] };
  for (const source of sources) {
    const related = progress.filter(row => row.work.lifeSelfBindings?.some(binding => sourceKey(binding) === sourceKey(source)));
    // Keep an edited old proposal even when its source version is no longer current.
    if (related.some(row => row.item_count > 0 && !settled(row.status) && row.status !== 'stale')) continue;
    const ranges = related.filter(row => settled(row.status)).flatMap(row => row.work.lifeSelfBindings ?? [])
      .filter(binding => sourceKey(binding) === sourceKey(source) && binding.sourceHash === source.sourceHash)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    let offset = 0;
    for (const range of ranges) {
      if (range.start > offset) break;
      if (!Number.isSafeInteger(range.end) || range.end < range.start || range.end > source.body.length) return changed();
      offset = Math.max(offset, range.end);
    }
    if (offset >= source.body.length) continue;
    work.pendingSources.push({ source, start: offset });
    if (source.kind === 'exploration') work.eligibleSources.push({ kind: 'exploration', id: source.id,
      sourceHash: source.sourceHash, availableAt: source.message.createdAt, countAsNew: offset === 0, carry: offset > 0 });
  }
  assertEpoch(epoch);
  return work;
}

function rangeBatch(material: PreparedLifeSelfMaterial, sessionId: string): MemoryIngestionBatchInput {
  const id = `memory-life-self-range-${stableMemoryHash(JSON.stringify(material.binding))}`;
  return { id, stream: 'proactive', scopeKey: SCOPE, sessionId, advancesCursor: false, sourceHash: material.source.sourceHash,
    workMetadata: { version: 1, workId: id, messageIds: [], lifeSelfBindings: [material.binding] } };
}

export async function prepareLifeSelfOrganizationMaterials(work: LifeSelfOrganizationWork, selectedIds: string[],
  sessionId: string, query: string) {
  assertEpoch(work.dataEpoch);
  const selected = new Set(selectedIds);
  const candidates = work.pendingSources.filter(item => item.source.kind === 'exploration' && selected.has(item.source.id));
  const terms = queryTerms([query, ...candidates.map(item => item.source.query ?? '')].join('\n'));
  const wishCandidates = work.pendingSources.filter(item => item.source.kind === 'wish'
    && terms.some(term => item.source.authoredContent.toLocaleLowerCase().includes(term.toLocaleLowerCase())));
  const materials: PreparedLifeSelfOrganizationMaterial[] = [];
  let remaining = 6000;
  let explorationCount = 0, wishCount = 0;
  for (const item of [...candidates, ...wishCandidates]) {
    const reference = item.source.kind === 'exploration' ? `E${explorationCount + 1}` : `W${wishCount + 1}`;
    const fragment = prepareLifeSelfFragment(item.source, item.start, remaining, reference);
    if (!fragment) continue;
    if (!(await validateLifeSelfBinding(fragment.binding, fragment.message))) return changed();
    materials.push({ ...fragment, batch: rangeBatch(fragment, sessionId) });
    remaining -= fragment.content.length + 2;
    if (item.source.kind === 'exploration') explorationCount++; else wishCount++;
  }
  assertEpoch(work.dataEpoch);
  return materials;
}

export async function restoreLifeSelfOrganizationMaterials(bindings: readonly LifeSelfBinding[], sessionId: string) {
  const epoch = captureBackupRestoreDataEpoch();
  const materials: PreparedLifeSelfOrganizationMaterial[] = [];
  let size = 0;
  for (const binding of bindings) {
    const source = await loadLifeSelfSource(binding.sessionId, binding.messageId);
    if (!source || !(await validateLifeSelfBinding(binding))) return changed();
    const content = renderLifeSelfMaterial(source, binding);
    const material = { source, binding, content, message: { ...source.message, content } };
    size += content.length + 2;
    if (size > 6000) return changed();
    materials.push({ ...material, batch: rangeBatch(material, sessionId) });
  }
  assertEpoch(epoch);
  return materials;
}

export function attachLifeSelfBatch(base: MemoryIngestionBatchInput, materials: PreparedLifeSelfOrganizationMaterial[], work: LifeSelfWorkSource[]) {
  if (!materials.length) return base;
  return { ...base, advancesCursor: !!base.sourceLastMessageId,
    id: `${base.id}-${stableMemoryHash(JSON.stringify(materials.map(material => material.batch.id)))}`,
    workMetadata: { ...(base.workMetadata ?? { version: 1 as const, workId: base.id, messageIds: [] }),
      lifeSelfBindings: materials.map(material => material.binding), lifeSelfWork: work } };
}

export async function validateLifeSelfCandidateSources(candidate: {
  lifeSelfBindings?: LifeSelfBinding[];
  sourceRefs?: Array<{ sessionId: string; messageId: string; relation?: string }>;
}) {
  const bindings = candidate.lifeSelfBindings ?? [];
  for (const ref of candidate.sourceRefs ?? []) {
    if (!ref.sessionId.startsWith('life-self-v1:') || ref.relation === 'derived') continue;
    if (!bindings.some(binding => binding.sessionId === ref.sessionId && binding.messageId === ref.messageId)) return false;
  }
  for (const binding of bindings) if (!(await validateLifeSelfBinding(binding))) return false;
  return true;
}

