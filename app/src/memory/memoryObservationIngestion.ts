import {
  getCameraObservationRecord,
  listCameraObservationMemorySources,
} from '../camera/cameraObservationStore';
import type { CameraObservationRecordV1 } from '../camera/cameraObservationTypes';
import type { CameraVisionStructuredResultV1 } from '../camera/cameraVisionStructured';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { stableMemoryHash } from './memoryAtomicity';
import { beginMemoryIngestionBatch } from './memoryIngestionService';
import { loadMemoryIngestionBatchWithDatabase, type MemoryIngestionBatchInput, type MemoryIngestionWorkMetadata } from './memoryIngestionLedger';
import { getMemoryDatabase } from './memoryStore';

/** Positions identify complete structured entries, never JSON character offsets. */
export type ObservationMaterialBinding = {
  observationId: string;
  sourceHash: string;
  capturedAt: number;
  sourceKind: CameraObservationRecordV1['sourceKind'];
  start: number;
  end: number;
  sentHash: string;
  full: boolean;
};
export type PreparedObservationMaterial = {
  binding: ObservationMaterialBinding;
  record: CameraObservationRecordV1;
  content: string;
  batch: MemoryIngestionBatchInput;
};
export const OBSERVATION_MATERIAL_LIMIT = 6000;

type ObservationResult = CameraVisionStructuredResultV1;
type Entry = { field: keyof ObservationResult; value: unknown; array: boolean };
type BatchProgress = { id: string; status: string; sessionId?: string; work: MemoryIngestionWorkMetadata };
export type ObservationWorkSource = { observationId: string; sourceHash: string };

function entries(record: CameraObservationRecordV1): Entry[] {
  const result: Entry[] = [];
  for (const field of ['objectiveFacts', 'inferences', 'uncertainties', 'deviceContextFacts'] as const) {
    const values = record.result[field];
    if (!values.length) result.push({ field, value: [], array: false });
    else for (const value of values) result.push({ field, value, array: true });
  }
  // Whole-frame summary/confidence are provided only with the actual full
  // result. They are not a last "new fact" after unread/omitted detail.
  return result;
}

export function getObservationMaterialLength(record: CameraObservationRecordV1) {
  return entries(record).length;
}

export function getObservationSourceHash(record: CameraObservationRecordV1) {
  return stableMemoryHash(JSON.stringify({ observationId: record.observationId,
    actionId: record.actionId, requestId: record.requestId, capturedAt: record.capturedAt,
    sourceKind: record.sourceKind, result: record.result }));
}

function partialResult(record: CameraObservationRecordV1, start: number, end: number) {
  const result = record.result;
  const selected = entries(record).slice(start, end);
  // Keep the saved person context intact, including unknown identities. These
  // fields give referenced persons context; they do not certify them as you.
  const partial: Record<string, unknown> = {
    schemaVersion: result.schemaVersion,
    frameUsability: result.frameUsability,
    subjectVisibility: result.subjectVisibility,
    subjectIdentities: result.subjectIdentities,
  };
  for (const entry of selected) {
    if (entry.array) {
      const values = (partial[entry.field] ?? []) as unknown[];
      values.push(entry.value);
      partial[entry.field] = values;
    } else partial[entry.field] = entry.value;
  }
  const selectedInferences = (partial.inferences ?? []) as ObservationResult['inferences'];
  const selectedUncertainties = (partial.uncertainties ?? []) as ObservationResult['uncertainties'];
  const requiredFacts = new Set([
    ...selectedInferences.flatMap(value => value.evidenceFactIds),
    ...selectedUncertainties.flatMap(value => value.relatedFactIds),
  ]);
  const providedFacts = (partial.objectiveFacts ?? []) as ObservationResult['objectiveFacts'];
  for (const fact of providedFacts) requiredFacts.add(fact.factId);
  if (requiredFacts.size) {
    partial.objectiveFacts = result.objectiveFacts.filter(fact => requiredFacts.has(fact.factId));
  }
  return partial;
}

function validRange(record: CameraObservationRecordV1, start: number, end: number) {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= 0 && end > start && end <= getObservationMaterialLength(record);
}

/** Exact saved values only. A partial record omits unread fields instead of inventing empty ones. */
export function renderObservationMaterial(record: CameraObservationRecordV1,
  binding?: Pick<ObservationMaterialBinding, 'start' | 'end'>) {
  const start = binding?.start ?? 0;
  const end = binding?.end ?? getObservationMaterialLength(record);
  if (!validRange(record, start, end)) throw new Error('MEMORY_SOURCE_CHANGED');
  const full = start === 0 && end === getObservationMaterialLength(record);
  return `【I 的观察记录】\n[observationId=${record.observationId}][time=${new Date(record.capturedAt).toISOString()}]\n摄像头：${record.sourceKind === 'android_front' ? '手机前置' : '手机后置'}\n观察内容（${full ? '全文' : '片段'}）：\n${JSON.stringify(full ? record.result : partialResult(record, start, end))}`;
}

function bindRange(record: CameraObservationRecordV1, start: number, end: number) {
  const content = renderObservationMaterial(record, { start, end });
  const binding: ObservationMaterialBinding = {
    observationId: record.observationId,
    sourceHash: getObservationSourceHash(record),
    capturedAt: record.capturedAt,
    sourceKind: record.sourceKind,
    start, end, sentHash: stableMemoryHash(content),
    full: start === 0 && end === getObservationMaterialLength(record),
  };
  return { binding, content };
}

export function prepareObservationFragment(record: CameraObservationRecordV1, start: number,
  limit = OBSERVATION_MATERIAL_LIMIT): { binding: ObservationMaterialBinding; content: string } | null {
  const count = getObservationMaterialLength(record);
  if (!Number.isSafeInteger(start) || start < 0 || start >= count || !Number.isFinite(limit)) return null;
  const budget = Math.min(OBSERVATION_MATERIAL_LIMIT, Math.floor(limit)) - 2;
  const wholeRemainder = bindRange(record, start, count);
  if (wholeRemainder.content.length <= budget) return wholeRemainder;
  let prepared: ReturnType<typeof bindRange> | null = null;
  for (let end = start + 1; end <= count; end += 1) {
    const next = bindRange(record, start, end);
    if (next.content.length > budget) break;
    prepared = next;
  }
  return prepared;
}

async function loadObservation(id: string) {
  try { return await getCameraObservationRecord(id); }
  catch (error) {
    if (error instanceof Error && error.message === 'camera_observation_not_found') return null;
    throw error;
  }
}

function matchesBinding(record: CameraObservationRecordV1, binding: ObservationMaterialBinding) {
  if (getObservationSourceHash(record) !== binding.sourceHash
    || record.capturedAt !== binding.capturedAt || record.sourceKind !== binding.sourceKind
    || !validRange(record, binding.start, binding.end)) return false;
  const current = bindRange(record, binding.start, binding.end);
  return current.binding.full === binding.full && current.binding.sentHash === binding.sentHash;
}

export async function validateObservationBinding(binding: ObservationMaterialBinding) {
  const epoch = captureBackupRestoreDataEpoch();
  if (!canCommitBackupRestoreDataEpoch(epoch)) return false;
  const record = await loadObservation(binding.observationId);
  return !!record && matchesBinding(record, binding) && canCommitBackupRestoreDataEpoch(epoch);
}

function makeRangeBatch(binding: ObservationMaterialBinding, sessionId: string): MemoryIngestionBatchInput {
  const id = `memory-observation-range-${stableMemoryHash(JSON.stringify([
    binding.observationId, binding.sourceHash, binding.start, binding.end,
  ]))}`;
  return { id, stream: 'observation', scopeKey: `observation-source:${binding.observationId}`,
    sessionId, sourceHash: binding.sourceHash, advancesCursor: false,
    workMetadata: { version: 1, workId: id, messageIds: [], observations: [binding] } };
}

export async function restoreObservationMaterial(binding: ObservationMaterialBinding, sessionId: string): Promise<PreparedObservationMaterial> {
  const epoch = captureBackupRestoreDataEpoch();
  const record = await loadObservation(binding.observationId);
  if (!record || !matchesBinding(record, binding) || !canCommitBackupRestoreDataEpoch(epoch)) {
    throw new Error('MEMORY_SOURCE_CHANGED');
  }
  return { binding, record, content: renderObservationMaterial(record, binding), batch: makeRangeBatch(binding, sessionId) };
}

async function loadProgress(): Promise<BatchProgress[]> {
  const rows = await (await getMemoryDatabase()).getAllAsync<{ id: string; status: string; session_id: string | null; work_metadata_json: string }>(
    `SELECT id, status, session_id, work_metadata_json FROM memory_ingestion_batches
     WHERE stream = 'observation' OR json_type(work_metadata_json, '$.observations') IS NOT NULL
     ORDER BY created_at, id;`,
  );
  return rows.map(row => ({ id: row.id, status: row.status, sessionId: row.session_id ?? undefined,
    work: JSON.parse(row.work_metadata_json) }))
    .filter(row => row.work?.version === 1);
}

/** The camera transaction is already committed. Failed ledger registration is retried from its eligibility flag. */
export async function registerNewObservationSources() {
  const epoch = captureBackupRestoreDataEpoch();
  if (!canCommitBackupRestoreDataEpoch(epoch)) return;
  const sources = await listCameraObservationMemorySources();
  const registered = new Set((await loadProgress()).map(row => row.work.observationRegistration?.observationId).filter(Boolean));
  for (const source of sources) {
    if (registered.has(source.observationId)) continue;
    const record = await loadObservation(source.observationId);
    if (!record || !canCommitBackupRestoreDataEpoch(epoch)) continue;
    const sourceHash = getObservationSourceHash(record);
    const id = `memory-observation-source-${stableMemoryHash(JSON.stringify([record.observationId, sourceHash]))}`;
    const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const current = await loadObservation(record.observationId);
      if (!current || getObservationSourceHash(current) !== sourceHash) return;
      return beginMemoryIngestionBatch({ id, stream: 'observation', scopeKey: `observation-source:${record.observationId}`,
        sourceHash, advancesCursor: false, workMetadata: { version: 1, workId: id, messageIds: [],
          observationRegistration: { observationId: record.observationId, sourceHash, capturedAt: record.capturedAt } } });
    });
    if (!result.committed) return;
  }
}

export async function loadObservationOrganizationRetry(sessionId: string) {
  const database = await getMemoryDatabase();
  const row = await database.getFirstAsync<{ id: string }>(
    `SELECT id FROM memory_ingestion_batches WHERE session_id = ?
     AND stream IN ('manual_digest', 'proactive')
     AND json_type(work_metadata_json, '$.observations') IS NOT NULL
     AND status IN ('pending', 'failed', 'waiting') AND item_count = 0
     ORDER BY created_at, id LIMIT 1;`, sessionId,
  );
  return row ? loadMemoryIngestionBatchWithDatabase(database, row.id) : null;
}

export async function nextObservationMaterials(options: { sessionId: string; limit: number; textLimit?: number }): Promise<{
  materials: PreparedObservationMaterial[]; eligibleCount: number; blockedItem: boolean;
  eligibleSources: Array<ObservationWorkSource & { capturedAt: number }>;
  work?: ObservationWorkSource[];
}> {
  await registerNewObservationSources();
  const epoch = captureBackupRestoreDataEpoch();
  const records = await loadProgress();
  const ranges = new Map<string, Array<{ binding: ObservationMaterialBinding; status: string }>>();
  for (const row of records) for (const binding of row.work.observations ?? []) {
    const items = ranges.get(binding.observationId) ?? [];
    items.push({ binding, status: row.status });
    ranges.set(binding.observationId, items);
  }
  const registrations = records.filter(row => row.work.observationRegistration)
    .sort((a, b) => a.work.observationRegistration!.capturedAt - b.work.observationRegistration!.capturedAt || a.id.localeCompare(b.id));
  const materials: PreparedObservationMaterial[] = [];
  const seen = new Set<string>();
  let blockedItem = false;
  let remaining = Math.min(OBSERVATION_MATERIAL_LIMIT, options.textLimit ?? OBSERVATION_MATERIAL_LIMIT);
  const pending: Array<{ record: CameraObservationRecordV1; start: number;
    sourceRanges: Array<{ binding: ObservationMaterialBinding; status: string }>; blocked: boolean }> = [];
  for (const row of registrations) {
    const ref = row.work.observationRegistration!;
    if (seen.has(ref.observationId)) continue;
    seen.add(ref.observationId);
    const sourceRanges = ranges.get(ref.observationId) ?? [];
    const record = await loadObservation(ref.observationId);
    if (!record || getObservationSourceHash(record) !== ref.sourceHash) continue;
    const count = getObservationMaterialLength(record);
    let start = 0;
    for (const range of sourceRanges.filter(value => value.binding.sourceHash === ref.sourceHash)
      .sort((a, b) => a.binding.start - b.binding.start || a.binding.end - b.binding.end)) {
      if ((range.status === 'resolved' || range.status === 'no_value') && range.binding.start === start
        && matchesBinding(record, range.binding)) start = range.binding.end;
    }
    if (start >= count) continue;
    pending.push({ record, start, sourceRanges,
      blocked: sourceRanges.some(value => value.status === 'ready' || value.status === 'waiting') });
  }
  const unfinished = new Set(pending.map(value => `${value.record.observationId}:${getObservationSourceHash(value.record)}`));
  const work = [...records].reverse().find(row => row.sessionId === options.sessionId
    && row.work.observationWork?.some(source => unfinished.has(`${source.observationId}:${source.sourceHash}`)))?.work.observationWork;
  const allowed = work ? new Set(work.map(source => `${source.observationId}:${source.sourceHash}`)) : undefined;
  const available = pending.filter(value => !value.blocked
    && (!allowed || allowed.has(`${value.record.observationId}:${getObservationSourceHash(value.record)}`)));
  const eligibleSources = available.map(value => ({ observationId: value.record.observationId,
    sourceHash: getObservationSourceHash(value.record), capturedAt: value.record.capturedAt }));
  for (const { record, start, sourceRanges } of available) {
    if (materials.length >= Math.max(0, Math.floor(options.limit))) continue;
    const retry = sourceRanges.find(value => (value.status === 'pending' || value.status === 'failed')
      && value.binding.sourceHash === getObservationSourceHash(record) && value.binding.start === start);
    // An ordinary short record waits intact for the next opportunity instead
    // of splitting merely to use the tail of this batch's shared budget.
    if (!retry && start === 0 && renderObservationMaterial(record).length + 2 <= OBSERVATION_MATERIAL_LIMIT
      && renderObservationMaterial(record).length + 2 > remaining) continue;
    const prepared = retry && matchesBinding(record, retry.binding)
      ? bindRange(record, retry.binding.start, retry.binding.end)
      : prepareObservationFragment(record, start, remaining);
    if (!prepared) { blockedItem = true; continue; }
    if (prepared.content.length + 2 > remaining) continue;
    materials.push({ ...prepared, record, batch: makeRangeBatch(prepared.binding, options.sessionId) });
    remaining -= prepared.content.length + 2;
  }
  if (!canCommitBackupRestoreDataEpoch(epoch)) throw new Error('MEMORY_SOURCE_CHANGED');
  return { materials, eligibleCount: available.length, blockedItem, eligibleSources, work };
}
