import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { stableMemoryHash } from '../memory/memoryAtomicity';
import { getMemoryDatabase } from '../memory/memoryStore';
import { runMemoryDuplicateCleanupBusinessWrite } from '../memory/memoryDuplicateCleanupState';
import { beginMemoryIngestionBatchWithDatabase, loadMemoryIngestionBatchWithDatabase,
  type MemoryIngestionBatchInput, type MemoryIngestionWorkMetadata } from '../memory/memoryIngestionLedger';
import { listShiyingMemorySnapshots, loadShiyingMemorySnapshot, makeShiyingMemoryBinding, makeShiyingMemoryMessage,
  parseShiyingMemorySource, shiyingMemorySourceSessionId, validateShiyingMemoryBinding, type ShiyingMemoryBinding, type ShiyingMemorySnapshot } from './shiyingMemorySource';
import { prepareShiyingOrganizationFragment, renderShiyingOrganizationMaterial, type ShiyingOrganizationReferenceMap } from './shiyingMemoryOrganizationProtocol';

const SCOPE = 'shiying-record';
const settled = (status: string) => status === 'resolved' || status === 'no_value';
export type ShiyingWorkSource = { recordId: string; availableAt: number; sourceHash: string; countAsNew: boolean; carry: boolean };
export type ShiyingCorrectionTarget = { kind: 'memory' | 'current_state'; id: string };
type PendingSource = { snapshot: ShiyingMemorySnapshot; bodyStart: number; imageNoteStart: number;
  retry?: ShiyingMemoryBinding[]; correctionTargets: ShiyingCorrectionTarget[] };
export type ShiyingOrganizationWork = { sessionId: string; dataEpoch: number | null;
  eligibleSources: ShiyingWorkSource[]; eligibleCount: number; pendingSources: PendingSource[];
  blockedRecords: string[]; unavailableSources: string[] };
export type PreparedShiyingOrganizationMaterial = { snapshot: ShiyingMemorySnapshot; bindings: ShiyingMemoryBinding[];
  messages: SubjectiveMessage[]; content: string; batch: MemoryIngestionBatchInput; correctionTargets: ShiyingCorrectionTarget[] };
function changed(): never { throw new Error('MEMORY_SOURCE_CHANGED'); }
function assertEpoch(epoch: number | null) { if (!canCommitBackupRestoreDataEpoch(epoch)) changed(); }
async function registerSnapshot(tx: import('expo-sqlite').SQLiteDatabase, snapshot: ShiyingMemorySnapshot) {
  const id = `memory-shiying-registration-${snapshot.recordId}`;
  const previous = (await loadMemoryIngestionBatchWithDatabase(tx, id))?.workMetadata?.shiyingRegistration;
  const replaced = new Set(previous?.replacedSources ?? []);
  for (const part of ['body', 'image_note'] as const) {
    const before = part === 'body' ? previous?.bodyVersion : previous?.imageNoteVersion;
    const current = part === 'body' ? snapshot.bodyVersion : snapshot.imageNote?.version;
    if (before && before !== current) replaced.add(shiyingMemorySourceSessionId({ recordId: snapshot.recordId, part, version: before }));
  }
  const metadata: MemoryIngestionWorkMetadata = { version: 1, workId: id, messageIds: [],
    shiyingRegistration: { recordId: snapshot.recordId, availableAt: previous?.availableAt ?? snapshot.finalizedAt,
      bodyVersion: snapshot.bodyVersion, imageNoteVersion: snapshot.imageNote?.version, replacedSources: [...replaced] } };
  await beginMemoryIngestionBatchWithDatabase(tx, { id, stream: 'proactive', scopeKey: SCOPE,
    sourceHash: snapshot.materialHash, advancesCursor: false, workMetadata: metadata });
  await tx.runAsync('UPDATE memory_ingestion_batches SET work_metadata_json=?,source_hash=? WHERE id=?', JSON.stringify(metadata), snapshot.materialHash, id);
}
export async function rememberShiyingMemorySourceVersions(recordId: string) {
  const epoch = captureBackupRestoreDataEpoch(), snapshot = await loadShiyingMemorySnapshot(recordId);
  if (!snapshot) return;
  const committed = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(async () => {
    const db = await getMemoryDatabase('ingestion');
    await db.withExclusiveTransactionAsync(async tx => { assertEpoch(epoch); await registerSnapshot(tx, snapshot); assertEpoch(epoch); });
  }));
  if (!committed.committed) changed();
}

export function renderPreparedShiyingMaterial(material: PreparedShiyingOrganizationMaterial, references?: ShiyingOrganizationReferenceMap) {
  const ref = (part: 'body' | 'image_note') => {
    const binding = material.bindings.find(value => value.part === part);
    return binding ? references?.messageRefs.get(binding.messageId) ?? (part === 'body' ? 'S999998' : 'S999999') : undefined;
  };
  return renderShiyingOrganizationMaterial(material.snapshot, { body: ref('body'), imageNote: ref('image_note') }, {
    body: material.bindings.find(value => value.part === 'body')?.range,
    imageNote: material.bindings.find(value => value.part === 'image_note')?.range,
  });
}
function material(snapshot: ShiyingMemorySnapshot, bindings: ShiyingMemoryBinding[], sessionId: string,
  correctionTargets: ShiyingCorrectionTarget[]): PreparedShiyingOrganizationMaterial {
  const id = `memory-shiying-range-${stableMemoryHash(JSON.stringify(bindings))}`;
  const value: PreparedShiyingOrganizationMaterial = { snapshot, bindings,
    messages: bindings.map(binding => makeShiyingMemoryMessage(snapshot, binding.part, binding.range)!), content: '',
    batch: { id, stream: 'proactive', scopeKey: SCOPE, sessionId, sourceHash: stableMemoryHash(JSON.stringify(bindings)),
      advancesCursor: false, workMetadata: { version: 1, workId: id, messageIds: [], shiying: bindings } }, correctionTargets };
  value.content = renderPreparedShiyingMaterial(value); return value;
}
export async function loadShiyingOrganizationRetry(sessionId: string) {
  const db = await getMemoryDatabase('ingestion');
  const row = await db.getFirstAsync<{ id: string }>(`SELECT id FROM memory_ingestion_batches
    WHERE scope_key=? AND session_id=? AND stream IN ('manual_digest','proactive')
      AND json_array_length(work_metadata_json,'$.shiying')>0 AND item_count=0
      AND status IN ('pending','failed','waiting') ORDER BY created_at,id LIMIT 1`, sessionId, sessionId);
  return row ? loadMemoryIngestionBatchWithDatabase(db, row.id) : null;
}
export async function loadShiyingCorrectionTargets(snapshot: ShiyingMemorySnapshot) {
  const db = await getMemoryDatabase('ingestion');
  const rows = await db.getAllAsync<{ memory_id: string; session_id: string }>(`SELECT r.memory_id,r.session_id
    FROM memory_source_refs r JOIN memories m ON m.id=r.memory_id
    WHERE r.relation='direct' AND r.session_id LIKE 'shiying-source-v1:%' AND m.type!='archived'`);
  const targets: ShiyingCorrectionTarget[] = [];
  const isChanged = (sessionId: string) => {
    const identity = parseShiyingMemorySource(sessionId);
    return identity?.recordId === snapshot.recordId
      && identity.version !== (identity.part === 'body' ? snapshot.bodyVersion : snapshot.imageNote?.version);
  };
  for (const row of rows) if (isChanged(row.session_id)) targets.push({ kind: 'memory', id: row.memory_id });
  const states = await db.getAllAsync<{ id: string; source_refs_json: string | null }>(
    "SELECT id,source_refs_json FROM memory_current_states WHERE status='active' AND source_refs_json LIKE '%shiying-source-v1:%'");
  for (const state of states) {
    const refs = JSON.parse(state.source_refs_json ?? '[]') as Array<{ sessionId: string }>;
    if (refs.some(ref => isChanged(ref.sessionId))) targets.push({ kind: 'current_state', id: state.id });
  }
  return [...new Map(targets.map(target => [JSON.stringify(target), target])).values()];
}
export async function nextShiyingOrganizationWork(options: { sessionId: string }): Promise<ShiyingOrganizationWork> {
  const epoch = captureBackupRestoreDataEpoch(); assertEpoch(epoch);
  const snapshots = await listShiyingMemorySnapshots();
  const db = await getMemoryDatabase('ingestion');
  const registration = await runBackupRestoreDataEpochCommit(epoch, () => runMemoryDuplicateCleanupBusinessWrite(() =>
    db.withExclusiveTransactionAsync(async tx => {
      assertEpoch(epoch);
      for (const snapshot of snapshots) {
        await registerSnapshot(tx, snapshot);
      }
      assertEpoch(epoch);
    })));
  if (!registration.committed) changed();
  const rows = await db.getAllAsync<{ status: string; work_metadata_json: string }>(
    "SELECT status,work_metadata_json FROM memory_ingestion_batches WHERE scope_key=? AND json_array_length(work_metadata_json,'$.shiying')>0 ORDER BY created_at,id", SCOPE);
  const ranges = rows.map(row => ({ status: row.status, bindings: (JSON.parse(row.work_metadata_json) as MemoryIngestionWorkMetadata).shiying ?? [] }));
  const eligibleSources: ShiyingWorkSource[] = [], pendingSources: PendingSource[] = [], blockedRecords: string[] = [];
  for (const snapshot of snapshots.sort((a, b) => a.finalizedAt - b.finalizedAt || a.recordId.localeCompare(b.recordId))) {
    const own = ranges.filter(row => row.bindings.some(binding => binding.recordId === snapshot.recordId));
    if (own.some(row => row.status === 'ready' || row.status === 'waiting')) { blockedRecords.push(snapshot.recordId); continue; }
    const offset = (part: 'body' | 'image_note', version: string | undefined) => {
      let start = 0;
      const accepted = own.filter(row => settled(row.status)).flatMap(row => row.bindings)
        .filter(binding => binding.part === part && binding.version === version);
      for (;;) { const next = accepted.find(binding => binding.start === start && binding.nextOffset > start); if (!next) break; start = next.nextOffset; }
      return start;
    };
    const bodyStart = offset('body', snapshot.bodyVersion), imageNoteStart = offset('image_note', snapshot.imageNote?.version);
    if (bodyStart >= snapshot.body.length && imageNoteStart >= (snapshot.imageNote?.body.length ?? 0)) continue;
    const retry = own.find(row => ['pending', 'failed'].includes(row.status) && row.bindings.every(binding =>
      binding.recordContentHash === snapshot.recordContentHash && binding.version === (binding.part === 'body' ? snapshot.bodyVersion : snapshot.imageNote?.version)
      && binding.start === (binding.part === 'body' ? bodyStart : imageNoteStart)))?.bindings;
    const carry = own.some(row => settled(row.status));
    eligibleSources.push({ recordId: snapshot.recordId, availableAt: snapshot.finalizedAt, sourceHash: snapshot.materialHash, countAsNew: !carry, carry });
    pendingSources.push({ snapshot, bodyStart, imageNoteStart, retry, correctionTargets: await loadShiyingCorrectionTargets(snapshot) });
  }
  assertEpoch(epoch);
  return { sessionId: options.sessionId, dataEpoch: epoch, eligibleSources, eligibleCount: eligibleSources.filter(value => value.countAsNew).length,
    pendingSources, blockedRecords, unavailableSources: [] };
}
export async function restoreShiyingOrganizationMaterial(bindings: readonly ShiyingMemoryBinding[], sessionId: string) {
  if (!bindings.length || bindings.some(binding => binding.recordId !== bindings[0].recordId)) changed();
  const snapshot = await loadShiyingMemorySnapshot(bindings[0].recordId);
  if (!snapshot) changed();
  for (const binding of bindings) if (!(await validateShiyingMemoryBinding(binding))) changed();
  return material(snapshot, [...bindings], sessionId, await loadShiyingCorrectionTargets(snapshot));
}
export async function prepareShiyingOrganizationMaterials(work: ShiyingOrganizationWork, selectedRecordIds: readonly string[], limit = 6000) {
  assertEpoch(work.dataEpoch);
  const selected = new Set(selectedRecordIds), materials: PreparedShiyingOrganizationMaterial[] = [], blockedSources: string[] = [];
  const budget = Math.min(6000, Math.max(0, Math.floor(limit)));
  let remaining = budget;
  for (const pending of work.pendingSources) {
    if (!selected.has(pending.snapshot.recordId)) continue;
    const current = await loadShiyingMemorySnapshot(pending.snapshot.recordId);
    if (!current || current.materialHash !== pending.snapshot.materialHash) changed();
    let prepared: PreparedShiyingOrganizationMaterial;
    if (pending.retry) prepared = await restoreShiyingOrganizationMaterial(pending.retry, work.sessionId);
    else {
      const start = { bodyStart: pending.bodyStart, imageNoteStart: pending.imageNoteStart,
        references: { body: 'S999998', imageNote: 'S999999' } };
      const fragment = prepareShiyingOrganizationFragment(current, start, remaining);
      if (fragment.status !== 'ready') {
        // A smaller remainder defers this paper; only a full-budget failure is a real blocker.
        if (fragment.status === 'blocked' && (remaining === budget
          || prepareShiyingOrganizationFragment(current, start, budget).status === 'blocked')) blockedSources.push(current.recordId);
        continue;
      }
      const bindings: ShiyingMemoryBinding[] = [];
      if (fragment.ranges.body) bindings.push(makeShiyingMemoryBinding(current, 'body', fragment.ranges.body));
      if (fragment.ranges.imageNote) bindings.push(makeShiyingMemoryBinding(current, 'image_note', fragment.ranges.imageNote));
      prepared = material(current, bindings, work.sessionId, pending.correctionTargets);
    }
    if (prepared.content.length + 2 > remaining) continue;
    materials.push(prepared); remaining -= prepared.content.length + 2;
  }
  assertEpoch(work.dataEpoch);
  return { materials, blockedSources, characterCount: materials.reduce((sum, value) => sum + value.content.length + 2, 0) };
}
