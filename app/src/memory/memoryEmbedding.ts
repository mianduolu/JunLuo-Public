import {
  aiLogicalConfigStorageBridge as AsyncStorage,
} from '../sync/syncAiLogicalConfigStorageBridge';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { ShiyingMemoryIndexSource } from '../shiying/shiyingMemorySource';
import type { PostSourceIndexSource } from '../posts/baiyunPostRecallSource';
import { currentStateEmbeddingText, currentStateIndexEligible, loadCurrentStateIndexSource, loadCurrentStateIndexSources, type CurrentStateIndexSource, type MemoryIndexTargetKind } from './memoryIndexTargets';
export { ensureMemoryEmbeddingSchema, MEMORY_EMBEDDING_SCHEMA_SQL, memoryEmbeddingMigrationSql } from './memoryIndexTargets';

import { filterCurrentMemories, getMemoryDatabase as getMemoryDatabaseForSource, isCurrentMemory, loadMemories, loadMemory, memoryFromRow, type MemoryEntry } from './memoryStore';
import { isBaiyunPostMemory } from '../posts/baiyunPostContract';
import { getWeeklyContextStatus, weeklyTargetHash } from './memoryWeeklyBasis';
import { getUnderstandingStatus } from './memoryUnderstanding';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { getSecretItem } from '../storage/secretStore';
import { setVaultSharedSecret } from '../sync/syncVaultSharedSecretsStorageBridge';
import { notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import {
  runMemoryDuplicateCleanupBusinessWrite,
  runMemoryDuplicateCleanupDataEpochCommit,
} from './memoryDuplicateCleanupState';
import { beginRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';
import {
  isEmbeddingRequestCancelledError,
  isEmbeddingRequestTimeoutError,
  resolveOptionalEmbedding,
  runEmbeddingRequestWithDeadline,
  type EmbeddingRequestBudget,
} from './embeddingRequestLifecycle';

const getMemoryDatabase = () => getMemoryDatabaseForSource('embedding');

export type EmbeddingSettings = {
  enabled: boolean;
  baseUrl: string;
  model: string;
  updatedAt: number;
};

export type EmbeddingRequestOptions = {
  budget: EmbeddingRequestBudget;
  diagnosticParentToken?: number;
  signal?: AbortSignal;
  reporter?: import('./memoryDatabaseWrites').MemoryRecallWorkReporter;
};

type EmbeddingRow = {
  target_kind: MemoryIndexTargetKind;
  memory_id: string;
  embedding_json: string;
  model: string;
  content_hash: string;
  updated_at: number;
};


const SETTINGS_KEY = 'junluo.memoryEmbedding.settings';
const API_KEY_KEY = 'junluo.memoryEmbedding.apiKey';

export const defaultEmbeddingSettings: EmbeddingSettings = {
  enabled: false,
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  model: 'gemini-embedding-001',
  updatedAt: 0,
};

export async function loadEmbeddingSettingsSnapshot(options?: { strict?: boolean }) {
  const saved = await AsyncStorage.getItem(SETTINGS_KEY);
  let settings = defaultEmbeddingSettings;
  if (saved !== null && (options?.strict || saved)) {
    try {
      settings = { ...defaultEmbeddingSettings, ...(JSON.parse(saved) as Partial<EmbeddingSettings>) };
    } catch (error) {
      if (options?.strict) throw error;
      settings = defaultEmbeddingSettings;
    }
  }
  return settings;
}

export async function loadEmbeddingSettings(options?: { strict?: boolean }) {
  const [settings, apiKey] = await Promise.all([
    loadEmbeddingSettingsSnapshot(options),
    getSecretItem(API_KEY_KEY),
  ]);
  return { settings, apiKey: apiKey ?? '' };
}

export async function saveEmbeddingSettings(settings: EmbeddingSettings, apiKey: string) {
  const normalized = {
    ...settings,
    baseUrl: settings.baseUrl.trim().replace(/\/+$/, ''),
    model: settings.model.trim(),
    updatedAt: Date.now(),
  };
  await Promise.all([
    AsyncStorage.setItem(SETTINGS_KEY, JSON.stringify(normalized)),
    setVaultSharedSecret(API_KEY_KEY, apiKey),
  ]);
  notifyMemoryProcessingWorkAvailable('configuration_changed');
  return normalized;
}

export function getMemoryEmbeddingText(memory: { title: string; content: string; domain: string; tags: string[]; recallCues: string[] }) {
  return [
    `Title: ${memory.title}`,
    `Domain: ${memory.domain}`,
    memory.tags.length ? `Tags: ${memory.tags.join(', ')}` : '',
    memory.recallCues.length ? `Recall cues: ${memory.recallCues.join(', ')}` : '',
    `Content: ${memory.content}`,
  ].filter(Boolean).join('\n');
}

export function hashText(text: string) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function embeddingConnectionIdentity(settings: EmbeddingSettings) {
  return JSON.stringify([settings.baseUrl.trim().replace(/\/+$/, ''), settings.model.trim()]);
}

export function getMemoryEmbeddingHash(text: string, settings: EmbeddingSettings) {
  const version = text.length <= 4000 ? 'embedding-v2' : 'embedding-chunks-v1:4000:200';
  return hashText(`${version}\n${embeddingConnectionIdentity(settings)}\n${text}`);
}

// Slice original material only. Overlap preserves context at a boundary; neither
// boundary may split a UTF-16 surrogate pair. Short v2 indexes remain compatible.
export function splitEmbeddingText(text: string) {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 4000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    chunks.push(text.slice(start, end));
    if (end === text.length) break;
    start = end - 200;
    if (/[\uDC00-\uDFFF]/.test(text[start])) start -= 1;
  }
  return chunks;
}

export function serializeEmbeddingChunks(vectors: number[][]) {
  return JSON.stringify(vectors.length === 1 ? vectors[0] : { version: 1, vectors });
}

function readEmbeddingChunks(json: string, text: string, decoded?: number[][]): number[][] {
  try {
    const value = decoded ? undefined : JSON.parse(json);
    const vectors: unknown = decoded ?? (isValidEmbeddingVector(value) ? [value] : value?.version === 1 ? value.vectors : null);
    if (!Array.isArray(vectors) || vectors.length !== splitEmbeddingText(text).length
      || !vectors.every(isValidEmbeddingVector)
      || !vectors.every(vector => vector.length === vectors[0].length)) return [];
    return vectors;
  } catch { return []; }
}

export async function isEmbeddingSettingsCurrent(expected: EmbeddingSettings) {
  const current = await loadEmbeddingSettingsSnapshot();
  return current.enabled && current.updatedAt === expected.updatedAt
    && embeddingConnectionIdentity(current) === embeddingConnectionIdentity(expected);
}

export function isValidEmbeddingVector(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0
    && value.every(item => typeof item === 'number' && Number.isFinite(item))
    && value.some(item => item !== 0);
}

export function isEmbeddingEligible(memory: MemoryEntry | null): memory is MemoryEntry {
  return Boolean(memory && memory.type !== 'archived' && memory.type !== 'feel' && !isBaiyunPostMemory(memory));
}

export function hasCurrentEmbedding(
  memory: MemoryEntry | null,
  row: Pick<EmbeddingRow, 'model' | 'content_hash' | 'embedding_json'> | null | undefined,
  settings: EmbeddingSettings,
) {
  return isEmbeddingEligible(memory) && hasUsableEmbeddingRow(row, getMemoryEmbeddingText(memory), settings);
}

export function hasUsableEmbeddingRow(
  row: Pick<EmbeddingRow, 'model' | 'content_hash' | 'embedding_json'> | null | undefined,
  text: string,
  settings: EmbeddingSettings,
) {
  return row?.model === settings.model && row.content_hash === getMemoryEmbeddingHash(text, settings)
    && readEmbeddingChunks(row.embedding_json, text).length > 0;
}

export function getShiyingRecordEmbeddingHash(source: ShiyingMemoryIndexSource, settings: EmbeddingSettings) {
  return hashText(JSON.stringify(['shiying-record-v1', source.sourceContentHash, source.materialHash,
    getMemoryEmbeddingHash(source.indexText, settings)]));
}

export function hasUsableShiyingRecordEmbedding(row: Pick<EmbeddingRow, 'model' | 'content_hash' | 'embedding_json'> | null | undefined,
  source: ShiyingMemoryIndexSource, settings: EmbeddingSettings) {
  return row?.model === settings.model && row.content_hash === getShiyingRecordEmbeddingHash(source, settings)
    && readEmbeddingChunks(row.embedding_json, source.indexText).length > 0;
}

export function getPostSourceEmbeddingHash(source: PostSourceIndexSource, settings: EmbeddingSettings) {
  return hashText(JSON.stringify(['post-source-v1', source.sourceHash, getMemoryEmbeddingHash(source.indexText, settings)]));
}

export function hasUsablePostSourceEmbedding(row: Pick<EmbeddingRow, 'model' | 'content_hash' | 'embedding_json'> | null | undefined,
  source: PostSourceIndexSource, settings: EmbeddingSettings) {
  return row?.model === settings.model && row.content_hash === getPostSourceEmbeddingHash(source, settings)
    && readEmbeddingChunks(row.embedding_json, source.indexText).length > 0;
}

/** Reconstruct the existing overlapping chunks against this exact original. */
export function postSourceEmbeddingRanges(text: string) {
  let start = 0;
  return splitEmbeddingText(text).map(chunk => {
    const end = start + chunk.length;
    const range = { start, end };
    if (text.slice(start, end) !== chunk) throw new Error('post-source-chunk-range-mismatch');
    start = end - 200;
    if (start >= 0 && /[\uDC00-\uDFFF]/.test(text[start])) start -= 1;
    return range;
  });
}

export async function requestEmbedding(
  text: string,
  settings: EmbeddingSettings,
  apiKey: string,
  options: EmbeddingRequestOptions,
) {
  if (text.length > 4000) throw new Error('embedding-single-vector-input-too-long');
  const vectors = await requestEmbeddingChunks(text, settings, apiKey, options);
  return vectors[0] ?? [];
}

export async function requestEmbeddingChunks(
  text: string,
  settings: EmbeddingSettings,
  apiKey: string,
  options: EmbeddingRequestOptions,
): Promise<number[][]> {
  return requestEmbeddingInputs(splitEmbeddingText(text), settings, apiKey, options);
}

async function requestEmbeddingInputs(
  chunks: string[], settings: EmbeddingSettings, apiKey: string, options: EmbeddingRequestOptions,
): Promise<number[][]> {
  if (!settings.enabled || !settings.baseUrl.trim() || !settings.model.trim() || !apiKey.trim()) return [];
  if (!chunks.length) return [];
  const span = beginRuntimeWorkload('embedding.request', {
    budget: options.budget,
    parentToken: options.diagnosticParentToken,
  });
  try {
    const vectors = await runEmbeddingRequestWithDeadline(options.budget, async (signal) => {
      const result: number[][] = [];
      // All batches share one deadline. A failure leaves the previous row intact.
      for (let offset = 0; offset < chunks.length; offset += 8) {
        if (signal.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
        const batch = chunks.slice(offset, offset + 8);
        let response: Response;
        let httpStatus: number | undefined;
        const finishHttp = options.reporter?.start('embedding_http');
        try {
          response = await fetch(`${settings.baseUrl.trim().replace(/\/+$/, '')}/embeddings`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: settings.model.trim(), input: batch.length === 1 ? batch[0] : batch }),
            signal,
          });
          httpStatus = response.status;
        } finally { finishHttp?.(httpStatus); }
        if (!response.ok) throw new Error(`embedding-http-${response.status}`);
        let payload: { data?: Array<{ index?: number; embedding?: unknown }> };
        const finishParse = options.reporter?.start('embedding_parse');
        try { payload = await response.json() as typeof payload; }
        finally { finishParse?.(); }
        if (chunks.length === 1 && Array.isArray(payload.data?.[0]?.embedding)
          && payload.data[0].embedding.length === 0) return [];
        if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
          throw new Error('embedding-invalid-vector-response');
        }
        const ordered: number[][] = new Array(batch.length);
        for (const item of payload.data) {
          const index = batch.length === 1 && item?.index === undefined ? 0 : item?.index;
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= batch.length
            || ordered[index] || !isValidEmbeddingVector(item?.embedding)) {
            throw new Error('embedding-invalid-vector-response');
          }
          ordered[index] = item.embedding;
        }
        result.push(...ordered);
        if (!result.every(vector => vector.length === result[0].length)) {
          throw new Error('embedding-invalid-vector-response');
        }
      }
      return result;
    }, options.signal);
    span?.finish('ok');
    return vectors;
  } catch (error) {
    span?.finish(isEmbeddingRequestCancelledError(error) ? 'cancelled' : isEmbeddingRequestTimeoutError(error) ? 'timeout' : 'failed');
    throw error;
  }
}

// One bounded preparation, retaining which query owns each embedding chunk.
// Ordinary chat keeps its existing single-query entry point and policy.
export async function searchSimilarMemorySegments(queries: readonly string[], topK = 8,
  options: { signal?: AbortSignal; budget?: EmbeddingRequestOptions['budget']; eligibleIds?: ReadonlySet<string> } = {}) {
  return (await searchSimilarMemoryTargetSegments(queries, topK, { ...options,
    eligibleMemoryIds: options.eligibleIds, eligibleCurrentStateIds: new Set() })).map(result => result.memories);
}

export type PostSourceEmbeddingRange = { sourceHash: string; start: number; end: number };
export type MemoryTargetScores = {
  memories: Map<string, number>; currentStates: Map<string, number>; shiyingRecords: Map<string, number>;
  postSources?: Map<string, number>; postSourceRanges?: Map<string, PostSourceEmbeddingRange>;
};
export type MemoryTargetSearchOptions = {
  reporter?: import('./memoryDatabaseWrites').MemoryRecallWorkReporter;
  signal?: AbortSignal; budget?: EmbeddingRequestOptions['budget']; diagnosticParentToken?: number; throwOnError?: boolean;
  eligibleMemoryIds?: ReadonlySet<string>; eligibleCurrentStateIds?: ReadonlySet<string>;
  eligibleShiyingRecordIds?: ReadonlySet<string>;
  eligiblePostSourceIds?: ReadonlySet<string>;
};
const emptyTargetScores = () => ({ memories: new Map<string, number>(), currentStates: new Map<string, number>(),
  shiyingRecords: new Map<string, number>(), postSources: new Map<string, number>(),
  postSourceRanges: new Map<string, PostSourceEmbeddingRange>() });

export async function scoreMemoryTargets(database: SQLiteDatabase, groups: number[][][], settings: EmbeddingSettings,
  options: MemoryTargetSearchOptions, topK: number, stableTies: boolean) {
  const results = groups.map(emptyTargetScores);
  const queryDimension = groups.find(group => group.length)?.[0].length;
  let comparableCount = 0;
  const score = (kind: 'memories' | 'currentStates' | 'shiyingRecords', id: string, json: string, text: string, decoded?: number[][]) => {
    let indexed: number[][];
    try { indexed = readEmbeddingChunks(json, text, decoded); } catch { return; }
    if (indexed.some(vector => vector.length === queryDimension)) comparableCount += 1;
    groups.forEach((group, index) => {
      let similarity = 0;
      for (const query of group) for (const vector of indexed) similarity = Math.max(similarity, cosineSimilarityValidated(query, vector));
      if (similarity > 0) results[index][kind].set(id, similarity);
    });
  };
  if (!options.eligibleMemoryIds || options.eligibleMemoryIds.size) {
    const finishPart = options.reporter?.start('vector_match_memory');
    try {
    const rows = await database.getAllAsync<EmbeddingRow & Parameters<typeof memoryFromRow>[0]>(
      `SELECT memories.*, embeddings.memory_id, embeddings.embedding_json, embeddings.model, embeddings.content_hash
         FROM memory_embeddings embeddings JOIN memories ON memories.id = embeddings.memory_id
        WHERE embeddings.target_kind = 'memory' AND embeddings.model = ?`, settings.model);
    const candidates: Array<{ row: typeof rows[number]; memory: MemoryEntry; indexed: number[][] }> = [];
    for (const row of rows) {
      if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
      if (options.eligibleMemoryIds && !options.eligibleMemoryIds.has(row.memory_id)) continue;
      try {
        const memory = memoryFromRow(row);
        if (!isEmbeddingEligible(memory)) continue;
        const text = getMemoryEmbeddingText(memory);
        const indexed = row.model === settings.model && row.content_hash === getMemoryEmbeddingHash(text, settings)
          ? readEmbeddingChunks(row.embedding_json, text) : [];
        if (indexed.length) candidates.push({ row, memory, indexed });
      } catch (error) {
        // Keep the original single-query corrupt-row fallback; segmented reads
        // retain their existing strict source-read behavior.
        if (stableTies) throw error;
      }
    }
    // Source verification may yield. Re-read targets after it, then synchronously
    // rank only unchanged cards; the corpus cannot authorize an old snapshot.
    if (candidates.length) {
      const currentIds = new Set((await filterCurrentMemories(database, candidates.map(item => item.memory),
        { signal: options.signal })).map(memory => memory.id));
      const latestRows = await database.getAllAsync<Parameters<typeof memoryFromRow>[0]>(
        'SELECT * FROM memories WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(candidates.map(item => item.memory.id)));
      if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
      const latest = new Map(latestRows.map(row => { const memory = memoryFromRow(row); return [memory.id, memory] as const; }));
      for (const { row, memory, indexed } of candidates) {
        const current = latest.get(memory.id);
        if (currentIds.has(memory.id) && current && weeklyTargetHash(current) === weeklyTargetHash(memory)
          && isEmbeddingEligible(current)) {
          const text = getMemoryEmbeddingText(current);
          // Revalidate final text against the index decoded privately for this call.
          if (row.model === settings.model && row.content_hash === getMemoryEmbeddingHash(text, settings)) {
            score('memories', memory.id, row.embedding_json, text, indexed);
          }
        }
      }
    }
    } finally { finishPart?.(); }
  }
  if (!options.eligibleCurrentStateIds || options.eligibleCurrentStateIds.size) {
    const finishPart = options.reporter?.start('vector_match_current_state');
    try {
    const rows = await database.getAllAsync<EmbeddingRow & CurrentStateIndexSource>(
      `SELECT states.*, embeddings.memory_id, embeddings.embedding_json, embeddings.model, embeddings.content_hash
         FROM memory_embeddings embeddings JOIN memory_current_states states ON states.id = embeddings.memory_id
        WHERE embeddings.target_kind = 'current_state' AND embeddings.model = ?`, settings.model);
    const candidates = rows.filter(row => (!options.eligibleCurrentStateIds || options.eligibleCurrentStateIds.has(row.memory_id))
      && currentStateIndexEligible(row) && hasUsableEmbeddingRow(row, currentStateEmbeddingText(row), settings));
    if (candidates.length) {
      const statuses = new Map((await (await import('../posts/baiyunPostMemoryBasis')).inspectPostDerivedTargets(database,
        candidates.map(row => ({ kind: 'current_state', id: row.id }))))
        .map(target => [target.id, target.status]));
      // Source checks may yield while the card is edited. Rank only the current
      // text matching this index, reading the candidate set once, not per card.
      const latestRows = await database.getAllAsync<CurrentStateIndexSource>(
        'SELECT * FROM memory_current_states WHERE id IN (SELECT value FROM json_each(?))', JSON.stringify(candidates.map(row => row.id)));
      if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
      const latest = new Map(latestRows.map(row => [row.id, row]));
      for (const row of candidates) {
        const current = latest.get(row.id) ?? null;
        if (!currentStateIndexEligible(current) || statuses.get(row.id) !== 'current') continue;
        const text = currentStateEmbeddingText(current);
        if (hasUsableEmbeddingRow(row, text, settings)) score('currentStates', row.id, row.embedding_json, text);
      }
    }
    } finally { finishPart?.(); }
  }
  if (options.eligibleShiyingRecordIds?.size) {
    const finishPart = options.reporter?.start('vector_match_shiying');
    try {
    const { loadShiyingMemoryIndexSources } = await import('../shiying/shiyingMemorySource');
    const rows = await database.getAllAsync<EmbeddingRow>(
      "SELECT * FROM memory_embeddings WHERE target_kind = 'shiying_record' AND model = ?", settings.model);
    const eligible = rows.filter(row => options.eligibleShiyingRecordIds!.has(row.memory_id));
    const sources = await loadShiyingMemoryIndexSources(eligible.map(row => row.memory_id), { signal: options.signal });
    const candidates = eligible.filter(row => { const source = sources.get(row.memory_id);
      return source && source.indexText.trim() && hasUsableShiyingRecordEmbedding(row, source, settings); });
    // Like formal cards, only the last locally reread original can authorize a vector.
    const current = await loadShiyingMemoryIndexSources(candidates.map(row => row.memory_id), { signal: options.signal });
    for (const row of candidates) {
      if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
      const source = current.get(row.memory_id);
      if (source?.indexText.trim() && hasUsableShiyingRecordEmbedding(row, source, settings)) {
        score('shiyingRecords', row.memory_id, row.embedding_json, source.indexText);
      }
    }
    } finally { finishPart?.(); }
  }
  if (options.eligiblePostSourceIds?.size) {
    const finishPart = options.reporter?.start('vector_match_post');
    try {
    const reader = await import('../posts/baiyunPostRecallSource');
    const rows = await database.getAllAsync<EmbeddingRow>(
      "SELECT * FROM memory_embeddings WHERE target_kind = 'post_source' AND model = ?", settings.model);
    const eligible = rows.filter(row => options.eligiblePostSourceIds!.has(row.memory_id));
    const sources = await reader.loadPostSourceIndexSources(eligible.map(row => row.memory_id), { signal: options.signal });
    const candidates = eligible.flatMap(row => {
      const source = sources.get(row.memory_id);
      if (!source?.indexText.trim() || row.content_hash !== getPostSourceEmbeddingHash(source, settings)) return [];
      const vectors = readEmbeddingChunks(row.embedding_json, source.indexText);
      return vectors.length ? [{ row, source, vectors }] : [];
    });
    const current = await reader.loadPostSourceIndexSources(candidates.map(item => item.row.memory_id), { signal: options.signal });
    for (const { row, source, vectors } of candidates) {
      if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
      const latest = current.get(row.memory_id);
      if (!latest || latest.sourceHash !== source.sourceHash || latest.indexText !== source.indexText) continue;
      const ranges = postSourceEmbeddingRanges(latest.indexText);
      if (vectors.some(vector => vector.length === queryDimension)) comparableCount += 1;
      groups.forEach((group, index) => {
        let similarity = 0, hit = -1;
        for (const query of group) for (let chunk = 0; chunk < vectors.length; chunk++) {
          const value = cosineSimilarityValidated(query, vectors[chunk]);
          if (value > similarity) { similarity = value; hit = chunk; }
        }
        if (hit >= 0) {
          results[index].postSources.set(row.memory_id, similarity);
          results[index].postSourceRanges.set(row.memory_id, { sourceHash: latest.sourceHash, ...ranges[hit] });
        }
      });
    }
    } finally { finishPart?.(); }
  }
  return { comparableCount, results: results.map(result => ({
    memories: new Map([...result.memories].sort((a, b) => b[1] - a[1] || (stableTies ? a[0].localeCompare(b[0]) : 0)).slice(0, topK)),
    currentStates: new Map([...result.currentStates].sort((a, b) => b[1] - a[1] || (stableTies ? a[0].localeCompare(b[0]) : 0)).slice(0, topK)),
    shiyingRecords: new Map([...result.shiyingRecords].sort((a, b) => b[1] - a[1] || (stableTies ? a[0].localeCompare(b[0]) : 0)).slice(0, topK)),
    postSources: new Map([...result.postSources].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topK)),
    postSourceRanges: new Map([...result.postSources].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, topK)
      .map(([id]) => [id, result.postSourceRanges.get(id)!])),
  })) };
}

export async function searchSimilarMemoryTargetSegments(queries: readonly string[], topK = 8,
  options: MemoryTargetSearchOptions = {}): Promise<MemoryTargetScores[]> {
  if (queries.length > 8) throw new Error('memory-segment-query-limit');
  const epoch = captureBackupRestoreDataEpoch();
  const empty = () => queries.map(emptyTargetScores);
  const settings = await loadEmbeddingSettingsSnapshot();
  if (!settings.enabled) return empty();
  const apiKey = (await getSecretItem(API_KEY_KEY)) ?? '';
  const chunks = queries.map(query => splitEmbeddingText(query));
  const vectors = await resolveOptionalEmbedding(() => requestEmbeddingInputs(chunks.flat(), settings, apiKey,
    { signal: options.signal, budget: options.budget ?? 'interactive' }), options.signal);
  if (!vectors.length) return empty();
  let offset = 0;
  const groups = chunks.map(parts => { const group = vectors.slice(offset, offset + parts.length); offset += parts.length; return group; });
  const database = await getMemoryDatabase();
  const { results } = await scoreMemoryTargets(database, groups, settings, options, topK, true);
  if (!canCommitBackupRestoreDataEpoch(epoch) || !(await isEmbeddingSettingsCurrent(settings))) return empty();
  return results;
}

export function cosineSimilarity(left: number[], right: number[]) {
  if (!isValidEmbeddingVector(left) || !isValidEmbeddingVector(right)) return 0;
  return cosineSimilarityValidated(left, right);
}

// Only callers that already checked both vectors use this synchronous calculation.
function cosineSimilarityValidated(left: number[], right: number[]) {
  if (left.length !== right.length) return 0;
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (!leftNorm || !rightNorm) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

export async function testMemoryEmbeddingConnection(settings: EmbeddingSettings, apiKey: string) {
  try {
    const embedding = await requestEmbedding(
      '君落语义记忆连接测试',
      { ...settings, enabled: true },
      apiKey,
      { budget: 'connection-test' },
    );
    if (!embedding.length) return { ok: false, detail: '向量接口返回为空。' };
    return { ok: true, detail: `向量连接可用，维度 ${embedding.length}。` };
  } catch {
    return { ok: false, detail: '向量连接失败，请检查 Base URL、模型名和 API Key。' };
  }
}

export async function generateMemoryEmbedding(
  memoryId: string,
  options: { dataEpoch?: number | null; targetKind?: MemoryIndexTargetKind } = {},
) {
  if (options.targetKind === 'current_state') return generateCurrentStateEmbedding(memoryId, options);
  if (options.targetKind === 'shiying_record') return generateShiyingRecordEmbedding(memoryId, options);
  if (options.targetKind === 'post_source') return generatePostSourceEmbedding(memoryId, options);
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const [{ settings, apiKey }, database, memory] = await Promise.all([
    loadEmbeddingSettings(),
    getMemoryDatabase(),
    loadMemory(memoryId),
  ]);
  if (!isEmbeddingEligible(memory)) return false;
  if (!(await isCurrentMemory(memory))) return false;
  if (!settings.enabled) return false;

  const text = getMemoryEmbeddingText(memory);
  const contentHash = getMemoryEmbeddingHash(text, settings);
  const existing = await database.getFirstAsync<EmbeddingRow>("SELECT * FROM memory_embeddings WHERE target_kind = 'memory' AND memory_id = ?", memoryId);
  if (hasCurrentEmbedding(memory, existing, settings)) return isEmbeddingSettingsCurrent(settings);

  const embedding = await requestEmbeddingChunks(text, settings, apiKey, { budget: 'background' });
  if (!embedding.length) return false;
  const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
  const postOptions = await preloadPostDerivedReadOptions(database, [{ kind: 'memory', id: memoryId }]);
  let saved = false;
  const persisted = await runMemoryDuplicateCleanupDataEpochCommit(dataEpoch, async () => {
    const currentDatabase = await getMemoryDatabase();
    await currentDatabase.withExclusiveTransactionAsync(async (transaction) => {
      const currentRow = await transaction.getFirstAsync<Parameters<typeof memoryFromRow>[0]>(
        'SELECT * FROM memories WHERE id = ?', memoryId,
      );
      const current = currentRow ? memoryFromRow(currentRow) : null;
      if (!hasCurrentEmbedding(current, { model: settings.model, content_hash: contentHash, embedding_json: serializeEmbeddingChunks(embedding) }, settings)) return;
      if ((await getPostDerivedStatus(transaction, 'memory', memoryId, undefined, postOptions)).status !== 'current') return;
      if (current && await getWeeklyContextStatus(transaction, current, postOptions) !== 'current') return;
      if (current && await getUnderstandingStatus(transaction, current, postOptions) !== 'current') return;
      if (!(await isEmbeddingSettingsCurrent(settings))) return;
      await transaction.runAsync(
        "INSERT OR REPLACE INTO memory_embeddings (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('memory', ?, ?, ?, ?, ?)",
        memoryId,
        serializeEmbeddingChunks(embedding),
        settings.model,
        contentHash,
        Date.now(),
      );
      saved = true;
    });
  });
  return persisted.committed && saved;
}

export async function generateCurrentStateEmbedding(id: string, options: { dataEpoch?: number | null } = {}) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  const [{ settings, apiKey }, database] = await Promise.all([loadEmbeddingSettings(), getMemoryDatabase()]);
  const source = await loadCurrentStateIndexSource(database, id);
  if (!settings.enabled || !currentStateIndexEligible(source)) return false;
  const { getPostDerivedStatus, preloadPostDerivedReadOptions } = await import('../posts/baiyunPostMemoryBasis');
  if ((await getPostDerivedStatus(database, 'current_state', id)).status !== 'current') return false;
  const text = currentStateEmbeddingText(source), contentHash = getMemoryEmbeddingHash(text, settings);
  const existing = await database.getFirstAsync<EmbeddingRow>(
    "SELECT * FROM memory_embeddings WHERE target_kind = 'current_state' AND memory_id = ?", id);
  if (hasUsableEmbeddingRow(existing, text, settings)) return isEmbeddingSettingsCurrent(settings);
  const vectors = await requestEmbeddingChunks(text, settings, apiKey, { budget: 'background' });
  if (!vectors.length) return false;
  const postOptions = await preloadPostDerivedReadOptions(database, [{ kind: 'current_state', id }]);
  let saved = false;
  const committed = await runMemoryDuplicateCleanupDataEpochCommit(dataEpoch, async () => {
    const currentDatabase = await getMemoryDatabase();
    await currentDatabase.withExclusiveTransactionAsync(async transaction => {
      const current = await loadCurrentStateIndexSource(transaction, id);
      if (!currentStateIndexEligible(current) || getMemoryEmbeddingHash(currentStateEmbeddingText(current), settings) !== contentHash
        || !await isEmbeddingSettingsCurrent(settings)) return;
      if ((await getPostDerivedStatus(transaction, 'current_state', id, undefined, postOptions)).status !== 'current') return;
      await transaction.runAsync(`INSERT OR REPLACE INTO memory_embeddings
        (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('current_state', ?, ?, ?, ?, ?)`,
      id, serializeEmbeddingChunks(vectors), settings.model, contentHash, Date.now());
      saved = true;
    });
  });
  return committed.committed && saved;
}

export async function generateShiyingRecordEmbedding(id: string, options: { dataEpoch?: number | null } = {}) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
  const { loadShiyingMemoryIndexSource } = await import('../shiying/shiyingMemorySource');
  const [{ settings, apiKey }, database, source] = await Promise.all([
    loadEmbeddingSettings(), getMemoryDatabase(), loadShiyingMemoryIndexSource(id),
  ]);
  if (!settings.enabled || !source?.indexText.trim()) return false;
  const contentHash = getShiyingRecordEmbeddingHash(source, settings);
  const existing = await database.getFirstAsync<EmbeddingRow>(
    "SELECT * FROM memory_embeddings WHERE target_kind = 'shiying_record' AND memory_id = ?", id);
  const vectors = hasUsableShiyingRecordEmbedding(existing, source, settings) ? null
    : await requestEmbeddingChunks(source.indexText, settings, apiKey, { budget: 'background' });
  if (vectors && !vectors.length) return false;
  let saved = false;
  const committed = await runMemoryDuplicateCleanupDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
    const settingsCurrent = await isEmbeddingSettingsCurrent(settings);
    const current = await loadShiyingMemoryIndexSource(id);
    if (!settingsCurrent || !current?.indexText.trim() || getShiyingRecordEmbeddingHash(current, settings) !== contentHash
      || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!vectors) {
      const index = await transaction.getFirstAsync<EmbeddingRow>(
        "SELECT * FROM memory_embeddings WHERE target_kind = 'shiying_record' AND memory_id = ?", id);
      saved = hasUsableShiyingRecordEmbedding(index, current, settings);
      return;
    }
    await transaction.runAsync(`INSERT OR REPLACE INTO memory_embeddings
      (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('shiying_record', ?, ?, ?, ?, ?)`,
    id, serializeEmbeddingChunks(vectors), settings.model, contentHash, Date.now());
    saved = true;
  }));
  return committed.committed && saved;
}

export async function generatePostSourceEmbedding(id: string, options: { dataEpoch?: number | null } = {}) {
  const dataEpoch = options.dataEpoch === undefined ? captureBackupRestoreDataEpoch() : options.dataEpoch;
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return false;
  const reader = await import('../posts/baiyunPostRecallSource');
  const [{ settings, apiKey }, database, source] = await Promise.all([
    loadEmbeddingSettings(), getMemoryDatabase(), reader.loadPostSourceIndexSource(id),
  ]);
  if (!settings.enabled || !source?.indexText.trim()) return false;
  const contentHash = getPostSourceEmbeddingHash(source, settings);
  const existing = await database.getFirstAsync<EmbeddingRow>(
    "SELECT * FROM memory_embeddings WHERE target_kind = 'post_source' AND memory_id = ?", id);
  const vectors = hasUsablePostSourceEmbedding(existing, source, settings) ? null
    : await requestEmbeddingChunks(source.indexText, settings, apiKey, { budget: 'background' });
  if (vectors && !vectors.length) return false;
  // Reading lives outside SQLite; acquire its current snapshot before taking the SQL lock.
  const knowledge = await (await import('../posts/baiyunPostMemorySource')).loadPostMemoryKnowledgeSnapshot(database);
  let saved = false;
  const committed = await runMemoryDuplicateCleanupDataEpochCommit(dataEpoch, () => database.withExclusiveTransactionAsync(async transaction => {
    const settingsCurrent = await isEmbeddingSettingsCurrent(settings);
    const current = await reader.loadPostSourceIndexSource(id, { database: transaction, knowledge });
    if (!settingsCurrent || !current || current.sourceHash !== source.sourceHash || current.indexText !== source.indexText
      || !canCommitBackupRestoreDataEpoch(dataEpoch)) return;
    if (!vectors) {
      const index = await transaction.getFirstAsync<EmbeddingRow>(
        "SELECT * FROM memory_embeddings WHERE target_kind = 'post_source' AND memory_id = ?", id);
      saved = hasUsablePostSourceEmbedding(index, current, settings);
      return;
    }
    await transaction.runAsync(`INSERT OR REPLACE INTO memory_embeddings
      (target_kind, memory_id, embedding_json, model, content_hash, updated_at) VALUES ('post_source', ?, ?, ?, ?, ?)`,
    id, serializeEmbeddingChunks(vectors), settings.model, contentHash, Date.now());
    saved = true;
  }));
  return committed.committed && saved;
}

async function postSourceIndexSources() {
  const reader = await import('../posts/baiyunPostRecallSource');
  const result: PostSourceIndexSource[] = [];
  let after: { id: string; updatedAt: number } | undefined;
  for (;;) {
    const keys = await reader.listPostSourceIndexSourceKeys({ after, limit: 1000 });
    const sources = await reader.loadPostSourceIndexSources(keys.map(key => key.id));
    result.push(...[...sources.values()].filter(source => source.indexText.trim()));
    if (keys.length < 1000) return result;
    after = keys[keys.length - 1];
  }
}

async function shiyingRecordIndexSources() {
  const reader = await import('../shiying/shiyingMemorySource');
  const result: ShiyingMemoryIndexSource[] = [];
  let after: { id: string; updatedAt: number } | undefined;
  for (;;) {
    const keys = await reader.listShiyingMemoryIndexSourceKeys({ after, limit: 1000 });
    const sources = await reader.loadShiyingMemoryIndexSources(keys.map(key => key.id));
    result.push(...[...sources.values()].filter(source => source.indexText.trim()));
    if (keys.length < 1000) return result;
    after = keys[keys.length - 1];
  }
}

async function currentStateIndexSources(database: SQLiteDatabase) {
  const states = await loadCurrentStateIndexSources(database);
  const { inspectPostDerivedTargets } = await import('../posts/baiyunPostMemoryBasis');
  const statuses = await inspectPostDerivedTargets(database, states.map(state => ({ kind: 'current_state' as const, id: state.id })));
  return states.filter((_, index) => statuses[index].status === 'current');
}

export async function getMissingEmbeddingCount() {
  const [{ settings }, database] = await Promise.all([loadEmbeddingSettings(), getMemoryDatabase()]);
  const memories = await loadMemories({ currentOnly: true });
  const rows = await database.getAllAsync<Pick<EmbeddingRow, 'target_kind' | 'memory_id' | 'model' | 'content_hash' | 'embedding_json'>>(
    'SELECT target_kind, memory_id, model, content_hash, embedding_json FROM memory_embeddings WHERE model = ?', settings.model,
  );
  const indexed = new Map(rows.map((row) => [`${row.target_kind}:${row.memory_id}`, row]));
  const states = await currentStateIndexSources(database);
  const records = await shiyingRecordIndexSources();
  const postSources = await postSourceIndexSources();
  return memories.filter((memory) => isEmbeddingEligible(memory) && !hasCurrentEmbedding(memory, indexed.get(`memory:${memory.id}`), settings)).length
    + states.filter(source => !hasUsableEmbeddingRow(indexed.get(`current_state:${source.id}`), currentStateEmbeddingText(source), settings)).length
    + records.filter(source => !hasUsableShiyingRecordEmbedding(indexed.get(`shiying_record:${source.id}`), source, settings)).length
    + postSources.filter(source => !hasUsablePostSourceEmbedding(indexed.get(`post_source:${source.id}`), source, settings)).length;
}

export async function getMemoryEmbeddingStatus(memoryId: string, targetKind: MemoryIndexTargetKind = 'memory') {
  const [{ settings }, database] = await Promise.all([loadEmbeddingSettings(), getMemoryDatabase()]);
  const row = await database.getFirstAsync<EmbeddingRow>(
    'SELECT * FROM memory_embeddings WHERE target_kind = ? AND memory_id = ? AND model = ?',
    targetKind,
    memoryId,
    settings.model,
  );
  if (targetKind === 'current_state') {
    const source = await loadCurrentStateIndexSource(database, memoryId);
    return row && currentStateIndexEligible(source) && hasUsableEmbeddingRow(row, currentStateEmbeddingText(source), settings)
      && (await (await import('../posts/baiyunPostMemoryBasis')).getPostDerivedStatus(database, 'current_state', memoryId)).status === 'current'
      ? { indexed: true, updatedAt: row.updated_at, model: row.model } : { indexed: false, model: settings.model };
  }
  if (targetKind === 'shiying_record') {
    const source = await (await import('../shiying/shiyingMemorySource')).loadShiyingMemoryIndexSource(memoryId);
    return row && source?.indexText.trim() && hasUsableShiyingRecordEmbedding(row, source, settings)
      ? { indexed: true, updatedAt: row.updated_at, model: row.model } : { indexed: false, model: settings.model };
  }
  if (targetKind === 'post_source') {
    const source = await (await import('../posts/baiyunPostRecallSource')).loadPostSourceIndexSource(memoryId);
    return row && source?.indexText.trim() && hasUsablePostSourceEmbedding(row, source, settings)
      ? { indexed: true, updatedAt: row.updated_at, model: row.model } : { indexed: false, model: settings.model };
  }
  const memory = await loadMemory(memoryId);
  return row && hasCurrentEmbedding(memory, row, settings) && memory && await isCurrentMemory(memory)
    ? { indexed: true, updatedAt: row.updated_at, model: row.model }
    : { indexed: false, model: settings.model };
}

export async function backfillMemoryEmbeddings(limit = 20) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    const [{ settings }, database, memories] = await Promise.all([
      loadEmbeddingSettings(),
      getMemoryDatabase(),
      loadMemories({ currentOnly: true }),
    ]);
    const rows = await database.getAllAsync<Pick<EmbeddingRow, 'memory_id' | 'model' | 'content_hash' | 'embedding_json'>>(
      "SELECT memory_id, model, content_hash, embedding_json FROM memory_embeddings WHERE target_kind = 'memory' AND model = ?",
      settings.model,
    );
    const indexed = new Map(rows.map((row) => [row.memory_id, row]));
    let attempted = 0;
    let succeeded = 0;
    for (const memory of memories.filter(
      (item) => isEmbeddingEligible(item) && !hasCurrentEmbedding(item, indexed.get(item.id), settings),
    )) {
      if (attempted >= limit) break;
      attempted += 1;
      try {
        if (await generateMemoryEmbedding(memory.id)) succeeded += 1;
      } catch {
        // One failed memory should not stop the batch.
      }
    }
    for (const source of await currentStateIndexSources(database)) {
      if (attempted >= limit) break;
      if ((await getMemoryEmbeddingStatus(source.id, 'current_state')).indexed) continue;
      attempted += 1;
      try { if (await generateCurrentStateEmbedding(source.id)) succeeded += 1; } catch { /* Keep the remaining batch. */ }
    }
    for (const source of await shiyingRecordIndexSources()) {
      if (attempted >= limit) break;
      if ((await getMemoryEmbeddingStatus(source.id, 'shiying_record')).indexed) continue;
      attempted += 1;
      try { if (await generateShiyingRecordEmbedding(source.id)) succeeded += 1; } catch { /* Keep the remaining batch. */ }
    }
    for (const source of await postSourceIndexSources()) {
      if (attempted >= limit) break;
      if ((await getMemoryEmbeddingStatus(source.id, 'post_source')).indexed) continue;
      attempted += 1;
      try { if (await generatePostSourceEmbedding(source.id)) succeeded += 1; } catch { /* Keep the remaining batch. */ }
    }
    const missing = await getMissingEmbeddingCount();
    return { attempted, succeeded, missing };
  });
}

export async function searchSimilarMemoryIds(
  query: string,
  topK = 10,
  options: { diagnosticParentToken?: number; signal?: AbortSignal; throwOnError?: boolean;
    reporter?: import('./memoryDatabaseWrites').MemoryRecallWorkReporter } = {},
) {
  return (await searchSimilarMemoryTargets(query, topK, { ...options, eligibleCurrentStateIds: new Set() })).memories;
}

export async function searchSimilarMemoryTargets(query: string, topK = 10, options: MemoryTargetSearchOptions = {}): Promise<MemoryTargetScores> {
  const epoch = captureBackupRestoreDataEpoch();
  const [{ settings, apiKey }, connection] = await Promise.all([loadEmbeddingSettings(), getMemoryDatabase()]);
  const database = (await import('./memoryDatabaseWrites')).withMemoryDatabaseReadContext(connection,
    { signal: options.signal, reporter: options.reporter });
  if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
  if (options.throwOnError && !settings.enabled) throw new Error('embedding-disabled');
  if (options.throwOnError && (!settings.baseUrl.trim() || !settings.model.trim() || !apiKey.trim())) {
    throw new Error('embedding-not-configured');
  }
  if (!settings.enabled || !query.trim()) return emptyTargetScores();
  const eligibleMemories = options.throwOnError && options.eligibleMemoryIds === undefined
    ? (await loadMemories({ includeArchived: false, currentOnly: true },
      { signal: options.signal, reporter: options.reporter })).filter(isEmbeddingEligible)
    : undefined;
  if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
  if (!options.eligibleShiyingRecordIds?.size && !options.eligiblePostSourceIds?.size
    && (options.eligibleMemoryIds?.size === 0 || (eligibleMemories && !eligibleMemories.length))) {
    const states = !options.eligibleCurrentStateIds || options.eligibleCurrentStateIds.size ? await currentStateIndexSources(database) : [];
    if (!states.some(state => !options.eligibleCurrentStateIds || options.eligibleCurrentStateIds.has(state.id))) return emptyTargetScores();
  }
  const embedQuery = () => requestEmbeddingChunks(query, settings, apiKey, {
    budget: options.budget ?? 'interactive', diagnosticParentToken: options.diagnosticParentToken, signal: options.signal,
    reporter: options.reporter,
  });
  const queryEmbedding = options.throwOnError ? await embedQuery() : await resolveOptionalEmbedding(embedQuery, options.signal);
  if (!queryEmbedding.length) {
    if (options.throwOnError) throw new Error('embedding-empty-response');
    return emptyTargetScores();
  }

  let scored: Awaited<ReturnType<typeof scoreMemoryTargets>>;
  const finishMatch = options.reporter?.start('vector_match');
  try { scored = await scoreMemoryTargets(database, [queryEmbedding], settings, options, topK, false); }
  finally { finishMatch?.(); }
  const { results, comparableCount } = scored;
  if (!canCommitBackupRestoreDataEpoch(epoch) || !(await isEmbeddingSettingsCurrent(settings))) {
    if (options.throwOnError) throw new Error('embedding-configuration-changed');
    return emptyTargetScores();
  }
  if (options.signal?.aborted) throw Object.assign(new Error('embedding-cancelled'), { name: 'AbortError' });
  if (options.throwOnError && comparableCount === 0) throw new Error('embedding-index-unavailable');
  return results[0];
}
