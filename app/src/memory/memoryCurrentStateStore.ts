import { getMemoryDatabase as getMemoryDatabaseForSource } from './memoryStore';
import { runMemoryDuplicateCleanupBusinessWrite } from './memoryDuplicateCleanupState';
import { resolveMemoryIngestionItemsWithDatabase, type MemoryIngestionItemRef } from './memoryIngestionLedger';
import type * as SQLite from 'expo-sqlite';
import type { MemorySourceRefInput } from './memorySourceRefs';
import { stableMemoryHash } from './memoryAtomicity';
import { notifyMemoryProcessingWorkAvailable } from './memoryProcessingSignals';
import { withMemoryDatabaseReadContext, type MemoryDatabaseReadContext } from './memoryDatabaseWrites';

const getMemoryDatabase = () => getMemoryDatabaseForSource('current_state');

export type MemoryCurrentStateKind =
  | 'project'
  | 'sleep_body'
  | 'emotional_weather'
  | 'sensitive_topic'
  | 'task'
  | 'relationship'
  | 'other';

export type MemoryCurrentStateStatus = 'active' | 'resolved' | 'expired';

export type MemoryCurrentStateResolveReason =
  | 'ended'
  | 'improved'
  | 'expired'
  | 'user_closed'
  | 'mistaken';

export type MemoryCurrentStateSourceType = 'manual' | 'memory' | 'chat' | 'candidate';

export type MemoryCurrentState = {
  id: string;
  title: string;
  content: string;
  kind: MemoryCurrentStateKind;
  status: MemoryCurrentStateStatus;
  startsAt: number;
  updatedAt: number;
  expiresAt?: number;
  knownAt?: number;
  sourceRefs: MemorySourceRefInput[];
  lastUsedAt?: number;
  lastSpokenAt?: number;
  resolvedAt?: number;
  resolveReason?: MemoryCurrentStateResolveReason;
  sourceType: MemoryCurrentStateSourceType;
  sourceMemoryId?: string;
  sourceCandidateId?: string;
  sourceTitle?: string;
  createdAt: number;
};

export type MemoryCurrentStateDraft = {
  title: string;
  content: string;
  kind?: MemoryCurrentStateKind;
  startsAt?: number;
  expiresAt?: number;
  knownAt?: number;
  sourceRefs?: MemorySourceRefInput[];
  sourceType?: MemoryCurrentStateSourceType;
  sourceMemoryId?: string;
  sourceCandidateId?: string;
  sourceTitle?: string;
};

export type CurrentStateRow = {
  id: string;
  title: string | null;
  content: string | null;
  kind: string | null;
  status: string | null;
  starts_at: number | null;
  updated_at: number | null;
  expires_at: number | null;
  resolved_at: number | null;
  resolve_reason: string | null;
  source_type: string | null;
  source_memory_id: string | null;
  source_candidate_id: string | null;
  source_title: string | null;
  created_at: number | null;
  known_at?: number | null;
  source_refs_json?: string | null;
  last_used_at?: number | null;
  last_spoken_at?: number | null;
};

const STATE_KINDS: MemoryCurrentStateKind[] = [
  'project',
  'sleep_body',
  'emotional_weather',
  'sensitive_topic',
  'task',
  'relationship',
  'other',
];

const STATE_STATUSES: MemoryCurrentStateStatus[] = ['active', 'resolved', 'expired'];
const SOURCE_TYPES: MemoryCurrentStateSourceType[] = ['manual', 'memory', 'chat', 'candidate'];
const RESOLVE_REASONS: MemoryCurrentStateResolveReason[] = ['ended', 'improved', 'expired', 'user_closed', 'mistaken'];

const DEFAULT_DURATION_MS: Record<MemoryCurrentStateKind, number> = {
  project: 14 * 86400000,
  sleep_body: 7 * 86400000,
  emotional_weather: 7 * 86400000,
  sensitive_topic: 7 * 86400000,
  task: 14 * 86400000,
  relationship: 30 * 86400000,
  other: 14 * 86400000,
};

let currentStateTableReady = false;

export function getMemoryCurrentStateKindLabel(kind: MemoryCurrentStateKind) {
  const labels: Record<MemoryCurrentStateKind, string> = {
    project: '项目推进',
    sleep_body: '睡眠/身体',
    emotional_weather: '情绪天气',
    sensitive_topic: '敏感话题',
    task: '近期任务',
    relationship: '关系背景',
    other: '其他',
  };
  return labels[kind];
}

export function getDefaultCurrentStateExpiresAt(kind: MemoryCurrentStateKind, startsAt = Date.now()) {
  return startsAt + DEFAULT_DURATION_MS[kind];
}

export function normalizeMemoryCurrentStateKind(value: unknown): MemoryCurrentStateKind {
  return typeof value === 'string' && STATE_KINDS.includes(value as MemoryCurrentStateKind)
    ? (value as MemoryCurrentStateKind)
    : 'other';
}

function normalizeStatus(value: unknown): MemoryCurrentStateStatus {
  return typeof value === 'string' && STATE_STATUSES.includes(value as MemoryCurrentStateStatus)
    ? (value as MemoryCurrentStateStatus)
    : 'active';
}

function normalizeSourceType(value: unknown): MemoryCurrentStateSourceType {
  return typeof value === 'string' && SOURCE_TYPES.includes(value as MemoryCurrentStateSourceType)
    ? (value as MemoryCurrentStateSourceType)
    : 'manual';
}

function normalizeResolveReason(value: unknown): MemoryCurrentStateResolveReason | undefined {
  return typeof value === 'string' && RESOLVE_REASONS.includes(value as MemoryCurrentStateResolveReason)
    ? (value as MemoryCurrentStateResolveReason)
    : undefined;
}

async function ensureCurrentStateTable() {
  if (currentStateTableReady) return;
  await getMemoryDatabase();
  currentStateTableReady = true;
}

export function rowToCurrentState(row: CurrentStateRow): MemoryCurrentState {
  const now = Date.now();
  const startsAt = typeof row.starts_at === 'number' ? row.starts_at : now;
  const kind = normalizeMemoryCurrentStateKind(row.kind);
  return {
    id: row.id,
    title: (row.title ?? '').trim() || '当前状态',
    content: (row.content ?? '').trim(),
    kind,
    status: normalizeStatus(row.status),
    startsAt,
    updatedAt: typeof row.updated_at === 'number' ? row.updated_at : startsAt,
    expiresAt: row.expires_at ?? undefined,
    knownAt: row.known_at ?? undefined,
    lastUsedAt: row.last_used_at ?? undefined,
    lastSpokenAt: row.last_spoken_at ?? undefined,
    sourceRefs: row.source_refs_json ? normalizeCurrentStateSourceRefs(JSON.parse(row.source_refs_json)) : [],
    resolvedAt: row.resolved_at ?? undefined,
    resolveReason: normalizeResolveReason(row.resolve_reason),
    sourceType: normalizeSourceType(row.source_type),
    sourceMemoryId: row.source_memory_id ?? undefined,
    sourceCandidateId: row.source_candidate_id ?? undefined,
    sourceTitle: row.source_title ?? undefined,
    createdAt: typeof row.created_at === 'number' ? row.created_at : startsAt,
  };
}

function normalizeDraft(draft: MemoryCurrentStateDraft) {
  const now = Date.now();
  const startsAt = typeof draft.startsAt === 'number' ? draft.startsAt : now;
  const kind = normalizeMemoryCurrentStateKind(draft.kind);
  const title = draft.title.trim() || '当前状态';
  const content = draft.content.trim();
  return {
    title,
    content: content || title,
    kind,
    startsAt,
    expiresAt: undefined,
    sourceType: normalizeSourceType(draft.sourceType),
    sourceMemoryId: draft.sourceMemoryId?.trim() || null,
    sourceCandidateId: draft.sourceCandidateId?.trim() || null,
    sourceTitle: draft.sourceTitle?.trim() || null,
  };
}

function normalizeCurrentStateSourceRefs(value: unknown): MemorySourceRefInput[] {
  if (!Array.isArray(value)) throw new Error('current-state-source-invalid');
  const refs = new Map<string, MemorySourceRefInput>();
  for (const ref of value) {
    if (!ref || typeof ref.sessionId !== 'string' || !ref.sessionId.trim()
      || typeof ref.messageId !== 'string' || !ref.messageId.trim()
      || (ref.role !== 'I' && ref.role !== 'you')
      || !Number.isSafeInteger(ref.messageCreatedAt) || ref.messageCreatedAt < 0
      || (ref.relation !== 'direct' && ref.relation !== 'derived')
      || (ref.excerpt !== undefined && typeof ref.excerpt !== 'string')) throw new Error('current-state-source-invalid');
    refs.set(`${ref.sessionId}\u0000${ref.messageId}\u0000${ref.relation}`,
      Object.fromEntries(Object.keys(ref).sort().map(key => [key, ref[key]])) as MemorySourceRefInput);
  }
  return [...refs.values()].sort((left, right) => left.messageCreatedAt - right.messageCreatedAt
    || left.sessionId.localeCompare(right.sessionId) || left.messageId.localeCompare(right.messageId)
    || left.relation.localeCompare(right.relation));
}

export function currentStateVersion(state: MemoryCurrentState) {
  return stableMemoryHash(JSON.stringify({ id: state.id, title: state.title, content: state.content,
    kind: state.kind, status: state.status, knownAt: state.knownAt ?? null,
    sourceRefs: normalizeCurrentStateSourceRefs(state.sourceRefs ?? []),
    sourceType: state.sourceType, sourceMemoryId: state.sourceMemoryId ?? null,
    sourceCandidateId: state.sourceCandidateId ?? null, sourceTitle: state.sourceTitle ?? null,
    resolvedAt: state.resolvedAt ?? null, resolveReason: state.resolveReason ?? null }));
}

export async function loadMemoryCurrentState(id: string, database?: Pick<SQLite.SQLiteDatabase, 'getFirstAsync'>) {
  const db = database ?? await getMemoryDatabase();
  const row = await db.getFirstAsync<CurrentStateRow>('SELECT * FROM memory_current_states WHERE id = ?', id);
  return row ? rowToCurrentState(row) : null;
}

export type MemoryCurrentStateWrite = Omit<MemoryCurrentStateDraft, 'expiresAt' | 'kind'> & {
  action: 'create' | 'update' | 'close'; id?: string; expectedVersion?: string;
  resolveReason?: MemoryCurrentStateResolveReason;
};

/** The caller owns the transaction and candidate receipt. */
export async function writeMemoryCurrentStateWithDatabase(database: SQLite.SQLiteDatabase, input: MemoryCurrentStateWrite) {
  const now = Date.now();
  const previous = input.id ? await loadMemoryCurrentState(input.id, database) : null;
  if (input.action === 'create' ? !!input.id : !previous) throw new Error('current-state-target-missing');
  if (previous && (previous.status !== 'active' || (input.expectedVersion !== undefined
    && currentStateVersion(previous) !== input.expectedVersion))) throw new Error('current-state-target-changed');
  const addedRefs = normalizeCurrentStateSourceRefs(input.sourceRefs ?? []);
  if (input.knownAt !== undefined && !addedRefs.some(ref => ref.messageCreatedAt === input.knownAt)) {
    throw new Error('current-state-known-time-without-source');
  }
  const refs = normalizeCurrentStateSourceRefs([...(previous?.sourceRefs ?? []), ...addedRefs]);
  const knownAt = addedRefs.length ? Math.max(...addedRefs.map(ref => ref.messageCreatedAt)) : previous?.knownAt;
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || !content) throw new Error('current-state-content-required');
  const id = previous?.id ?? `current-state-${now}-${Math.random().toString(36).slice(2, 10)}`;
  if (previous) {
    await database.runAsync(`UPDATE memory_current_states SET title = ?, content = ?, status = ?,
      known_at = ?, source_refs_json = ?, updated_at = ?, expires_at = NULL, resolved_at = ?, resolve_reason = ? WHERE id = ?`,
    title, content, input.action === 'close' ? 'resolved' : 'active', knownAt ?? null, JSON.stringify(refs), now,
    input.action === 'close' ? now : null, input.action === 'close' ? input.resolveReason ?? 'ended' : null, id);
  } else {
    await database.runAsync(`INSERT INTO memory_current_states (id, title, content, kind, status, starts_at,
      updated_at, expires_at, source_type, source_memory_id, source_candidate_id, source_title, created_at, known_at, source_refs_json)
      VALUES (?, ?, ?, 'other', 'active', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`, id, title, content, input.startsAt ?? now,
    now, input.sourceType ?? 'chat', input.sourceMemoryId ?? null, input.sourceCandidateId ?? null,
    input.sourceTitle ?? null, now, knownAt ?? null, JSON.stringify(refs));
  }
  const { queueCurrentStateEmbeddingWithDatabase } = await import('./memoryProcessingQueue');
  await queueCurrentStateEmbeddingWithDatabase(database, id, now);
  return (await loadMemoryCurrentState(id, database))!;
}

export async function createMemoryCurrentState(
  draft: MemoryCurrentStateDraft, ingestionRef?: MemoryIngestionItemRef,
): Promise<string | null> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    await ensureCurrentStateTable();
    const database = await getMemoryDatabase();
    const normalized = normalizeDraft(draft);
    let savedId: string | null = null;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      if (ingestionRef && !await transaction.getFirstAsync(
        "SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status = 'pending'",
        ingestionRef.batchId, ingestionRef.itemKey,
      )) return;
      const saved = await writeMemoryCurrentStateWithDatabase(transaction, { ...draft, action: 'create',
        title: normalized.title, content: normalized.content });
      if (ingestionRef) await resolveMemoryIngestionItemsWithDatabase(transaction, [ingestionRef], 'saved');
      savedId = saved.id;
    });
    if (savedId) notifyMemoryProcessingWorkAvailable('memory_changed');
    return savedId;
  });
}

export async function expireMemoryCurrentStates(now = Date.now()) {
  // Kept for older callers; elapsed time no longer closes a current state.
  void now;
}

export async function loadActiveMemoryCurrentStates(options: { limit?: number; now?: number; readOnly?: boolean; currentOnly?: boolean } = {}) {
  const database = await getMemoryDatabase();
  const limit = Math.max(1, Math.min(50, Math.round(options.limit ?? 20)));
  const rows = await database.getAllAsync<CurrentStateRow>(
    `SELECT * FROM memory_current_states
     WHERE status = 'active'
     ORDER BY updated_at DESC, id DESC
     ${options.currentOnly ? '' : 'LIMIT ?'}`,
    ...(options.currentOnly ? [] : [limit]),
  );
  const states = rows.map(rowToCurrentState);
  return options.currentOnly ? (await filterCurrentPostStates(database, states)).slice(0, limit) : states;
}

async function filterCurrentPostStates(database: Pick<SQLite.SQLiteDatabase, 'getFirstAsync' | 'getAllAsync'>, states: MemoryCurrentState[]) {
  const { inspectPostDerivedTargets } = await import('../posts/baiyunPostMemoryBasis');
  const statuses = await inspectPostDerivedTargets(database, states.map(state => ({ kind: 'current_state' as const, id: state.id, sourceRefs: state.sourceRefs })));
  return states.filter((_, index) => statuses[index].status === 'current');
}

export async function loadMemoryCurrentStates(options: { includeResolved?: boolean; historyOnly?: boolean; limit?: number; offset?: number; now?: number; currentOnly?: boolean } = {}, readContext?: MemoryDatabaseReadContext) {
  const database = withMemoryDatabaseReadContext(await getMemoryDatabase(), readContext);
  const limit = Math.max(1, Math.min(100, Math.round(options.limit ?? 50)));
  const where = options.historyOnly ? "WHERE status IN ('resolved', 'expired')" : options.includeResolved ? '' : "WHERE status = 'active'";
  const rows = await database.getAllAsync<CurrentStateRow>(
    `SELECT * FROM memory_current_states
     ${where}
     ORDER BY updated_at DESC, id DESC
     ${options.currentOnly ? '' : 'LIMIT ? OFFSET ?'}`,
    ...(options.currentOnly ? [] : [limit, Math.max(0, Math.floor(options.offset ?? 0))]),
  );
  const states = rows.map(rowToCurrentState);
  const offset = Math.max(0, Math.floor(options.offset ?? 0));
  return options.currentOnly ? (await filterCurrentPostStates(database, states)).slice(offset, offset + limit) : states;
}

export async function resolveMemoryCurrentState(
  id: string, reason: MemoryCurrentStateResolveReason = 'ended', ingestionRef?: MemoryIngestionItemRef,
): Promise<boolean> {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    await ensureCurrentStateTable();
    const database = await getMemoryDatabase();
    let changed = false;
    await database.withExclusiveTransactionAsync(async (transaction) => {
      if (ingestionRef && !await transaction.getFirstAsync(
        "SELECT 1 FROM memory_ingestion_items WHERE batch_id = ? AND item_key = ? AND status = 'pending'",
        ingestionRef.batchId, ingestionRef.itemKey,
      )) return;
      const state = await loadMemoryCurrentState(id, transaction);
      if (!state || state.status !== 'active') return;
      await writeMemoryCurrentStateWithDatabase(transaction, { action: 'close', id,
        expectedVersion: currentStateVersion(state), title: state.title, content: state.content, resolveReason: reason });
      changed = true;
      if (ingestionRef) await resolveMemoryIngestionItemsWithDatabase(transaction, [ingestionRef], 'saved');
    });
    if (changed) notifyMemoryProcessingWorkAvailable('memory_changed');
    return changed;
  });
}

export async function updateMemoryCurrentStateActivity(id: string, patch: { expiresAt?: number; content?: string } = {}) {
  return runMemoryDuplicateCleanupBusinessWrite(async () => {
    await ensureCurrentStateTable();
    const database = await getMemoryDatabase();
    if (typeof patch.content === 'string') {
      await database.withExclusiveTransactionAsync(async transaction => {
        const state = await loadMemoryCurrentState(id, transaction);
        if (!state || state.status !== 'active') return;
        await writeMemoryCurrentStateWithDatabase(transaction, { action: 'update', id,
          expectedVersion: currentStateVersion(state), title: state.title, content: patch.content! });
      });
      notifyMemoryProcessingWorkAvailable('memory_changed');
    }
  });
}
