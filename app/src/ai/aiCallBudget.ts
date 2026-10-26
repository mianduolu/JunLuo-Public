import * as Crypto from 'expo-crypto';

import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import {
  discardUnstartedCameraVisionBudgetCaptures,
  discardUnstartedReadingBudgetCaptures,
  discardUnstartedProactiveBudgetCaptures,
  remoteBudgetStorageBridge as AsyncStorage,
} from '../sync/syncRemoteBudgetStorageBridge';
import { runScheduledAiCall, type AiRuntimePriority } from './aiRuntimeScheduler';
import {
  AI_CALL_BUDGET_KEY,
  parseAiCallBudgetState,
  serializeAiCallBudgetState,
  getCostRequestRetryAt,
  type AiCallPurpose,
  type AiCallBudgetKind,
  type AiCallBudgetRecord,
  type AiCallBudgetState,
} from './aiCallBudgetStorage';
import {
  resolveAiCallBudgetScope,
  type AiCallBudgetConnection,
  type AiCallBudgetScope,
} from './aiCallBudgetScope';
import { AI_MAX_BACKGROUND_PER_WINDOW, getBackgroundCallBatchRetryAfter, getBackgroundCallRetryAfter } from './aiCallBudgetPolicy';
import { getAutomaticCostRestriction } from '../runtime/automaticRemoteAiPolicyCore';

export type AiCallKind = AiCallBudgetKind;

export class AiCostDeferredError extends Error {
  constructor(readonly reason: 'cost-window' | 'cost-limit', readonly retryAfter?: number) { super(reason); }
}
export const isAiCostDeferred = (error: unknown): error is AiCostDeferredError => error instanceof AiCostDeferredError;
export class ProactiveBudgetDeferredError extends Error {
  constructor(readonly retryAfter: number) {
    super(`proactive-budget-deferred:${retryAfter}`);
    this.name = 'ProactiveBudgetDeferredError';
  }
}
export type AiRequestAdmission = {
  beforeTransport(beforeStart?: () => Promise<void>, assertTransportReady?: () => void | Promise<void>): Promise<void>;
};

/** Admission only, never a source-validity or already-paid-result predicate. */
export async function checkAutomaticRequestCost(input: {
  connection?: AiCallBudgetConnection | null; purpose?: AiCallPurpose; now?: number;
}, records?: readonly AiCallBudgetRecord[]) {
  if (!input.purpose) return;
  const { loadAutomaticRemoteAiPolicy } = await import('../runtime/automaticRemoteAiPolicy');
  const policy = await loadAutomaticRemoteAiPolicy();
  const now = input.now ?? Date.now();
  const restriction = getAutomaticCostRestriction({ policy,
    baseUrl: input.connection?.baseUrl ?? '', now, purpose: input.purpose });
  if (restriction.mode === 'wait') throw new AiCostDeferredError('cost-window', restriction.retryAt);
  if (restriction.mode === 'limited') {
    const persisted = records ?? (await loadBudgetState(now)).records;
    const ids = new Set(persisted.map(record => record.id));
    const retryAt = getCostRequestRetryAt([...persisted,
      ...[...inFlightBudgetRecords.values()].filter(record => !ids.has(record.id))], now);
    if (retryAt !== undefined) throw new AiCostDeferredError('cost-limit', retryAt);
  }
  return restriction;
}

function costSkipped(error: AiCostDeferredError) {
  return { ok: false as const, skipped: true as const, reason: error.reason, retryAfter: error.retryAfter };
}

function createRequestAdmission(record: AiCallBudgetRecord, options: {
  connection?: AiCallBudgetConnection | null; dataEpoch?: number | null; purpose?: AiCallPurpose;
}) {
  let admitted = false;
  let deferred: AiCostDeferredError | undefined;
  const admission: AiRequestAdmission = { beforeTransport: async (beforeStart, assertTransportReady) => {
    if (admitted) throw new Error('ai-budget-transport-already-admitted');
    if (!options.purpose) { await beforeStart?.(); await assertTransportReady?.(); return; }
    try {
      await runBudgetWrite(async () => {
        const work = async () => {
          const now = Date.now();
          const restriction = await checkAutomaticRequestCost(options);
          // Freeze at admission, before attempts/cooldowns. The shared memory hold
          // owns this slot until the same record is durably registered for transport.
          const next: AiCallBudgetRecord = { ...record, purpose: options.purpose, startedAt: now, endedAt: now,
            ...(restriction?.mode === 'limited' ? { costRestricted: true } : {}) };
          inFlightBudgetRecords.set(record.id, next);
          try {
            if (options.dataEpoch !== undefined && !canCommitBackupRestoreDataEpoch(options.dataEpoch)) throw new Error('ai-budget-restore');
            const latest = await loadBudgetState(now);
            const bridge = await import('../sync/syncRemoteBudgetStorageBridge');
            await bridge.saveAutomaticBudgetBeforeTransport(serializeAiCallBudgetState({ ...latest,
              records: [...latest.records.filter(item => item.id !== next.id), next] }), async () => {
              await beforeStart?.();
              await assertTransportReady?.();
            });
            admitted = true;
            Object.assign(record, next);
          } catch (error) {
            // No permission to enter transport was returned. Only this request's
            // unstarted local/capture entry can be withdrawn; network errors cannot.
            if (next.scope === 'remote-account') {
              const bridge = await import('../sync/syncRemoteBudgetStorageBridge');
              await bridge.discardUnstartedAutomaticBudgetCaptures(next.id, next.remoteAccountId!, next.kind);
            }
            const latest = await loadBudgetState(now);
            if (latest.records.some(item => item.id === next.id)) await saveBudgetState({ ...latest,
              records: latest.records.filter(item => item.id !== next.id) });
            inFlightBudgetRecords.set(record.id, record);
            throw error;
          }
        };
        if (options.dataEpoch === undefined) await work();
        else if (!(await runBackupRestoreDataEpochCommit(options.dataEpoch, work)).committed) throw new Error('ai-budget-restore');
      });
    } catch (error) { if (isAiCostDeferred(error)) deferred = error; throw error; }
  } };
  const finish = async () => {
    if (!admitted || !options.purpose) return;
    const endedAt = Date.now();
    await runBudgetWrite(async () => {
      const latest = await loadBudgetState(endedAt);
      const current = latest.records.find(item => item.id === record.id);
      if (!current || current.endedAt >= endedAt) return;
      await saveBudgetState({ ...latest, records: latest.records.map(item => item.id === record.id
        ? { ...item, endedAt } : item) });
      record.endedAt = endedAt;
    });
  };
  return { admission, finish, deferred: () => deferred };
}

export async function getReadingBudgetRetryAt(connection: AiCallBudgetConnection, now = Date.now(), kind: 'reading' | 'dayPlan' = 'reading') {
  const scope = resolveAiCallBudgetScope(connection);
  return getBackgroundCallRetryAfter(cameraBudgetRecords(await loadBudgetState(now), scope, now), kind, now);
}

/** Admission only: no network while the existing short budget write queue is held. */
export async function beginReadingBudgetRequest(input: {
  kind?: 'reading' | 'dayPlan';
  connection: AiCallBudgetConnection;
  dataEpoch: number;
  requestId: string;
  beforeTransport: () => Promise<void>;
  batch?: { connections: AiCallBudgetConnection[]; index: number };
}): Promise<void> {
  if (input.batch) return beginReadingBatchTransport({ ...input, batch: input.batch });
  const kind = input.kind ?? 'reading';
  const id = `${kind}:${input.requestId}`;
  if (!input.requestId || id.length > 256) throw new Error('reading-budget-invalid-id');
  const scope = resolveAiCallBudgetScope(input.connection);
  const result = await runBudgetWrite(() => runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    const now = Date.now();
    const state = await loadBudgetState(now);
    if (state.records.some(record => record.id === id)) throw new Error('reading-budget-duplicate');
    const retryAt = getBackgroundCallRetryAfter(cameraBudgetRecords(state, scope, now), kind, now);
    if (retryAt !== undefined) throw new Error(`reading-budget-deferred:${retryAt}`);
    const record: AiCallBudgetRecord = { id, kind, priority: 'background',
      startedAt: now, endedAt: now, scope: scope.kind,
      ...(scope.kind === 'remote-account' ? { remoteAccountId: scope.remoteAccountId } : {}) };
    try {
      await saveBudgetState({ ...state, records: [...state.records, record] });
      await input.beforeTransport();
    } catch (error) {
      // This invocation has not received permission to enter transport.
      if (scope.kind === 'remote-account') await discardUnstartedReadingBudgetCaptures(id, scope.remoteAccountId, kind);
      const latest = await loadBudgetState(now);
      if (latest.records.some(item => item.id === id)) await saveBudgetState({
        ...latest, records: latest.records.filter(item => item.id !== id),
      });
      throw error;
    }
  }));
  if (!result.committed) throw new Error('reading-budget-restore');
}

export type AiCallPriority = AiRuntimePriority;

export type BudgetedAiCallResult<T> =
  | { nextAllowedAt?: number; ok: true; skipped: false; value: T }
  | { ok: false; reason: string; retryAfter?: number; skipped: true };

export type BudgetedAiCallPairResult<TFirst, TSecond> =
  | { ok: true; skipped: false; values: readonly [TFirst, TSecond | undefined] }
  | { ok: false; reason: string; retryAfter?: number; skipped: true };

const SCHEDULER_RECHECK_MS = 60 * 1000;
let budgetWriteTail: Promise<void> = Promise.resolve();
const inFlightBudgetRecords = new Map<string, AiCallBudgetRecord>();

// Uses the shared reservation map, not a second queue or persistent request ledger.
export function releaseReadingBatchBudget(requestId: string) {
  for (const id of inFlightBudgetRecords.keys()) if (id.startsWith(`reading:${requestId}:part:`)) inFlightBudgetRecords.delete(id);
}

async function beginReadingBatchTransport(input: {
  connection: AiCallBudgetConnection; dataEpoch: number; requestId: string;
  beforeTransport: () => Promise<void>;
  batch: { connections: AiCallBudgetConnection[]; index: number };
}) {
  const { connections, index } = input.batch;
  if (!connections.length || connections.length > 16 || !Number.isSafeInteger(index) || index < 0 || index >= connections.length
    || input.requestId.length > 180) throw new Error('reading-batch-invalid');
  const ids = connections.map((_, n) => `reading:${input.requestId}:part:${n}`);
  const result = await runBudgetWrite(() => runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    const now = Date.now();
    let state = await loadBudgetState(now);
    if (state.records.some(r => r.id === ids[index])) throw new Error('reading-budget-duplicate');
    if (index === 0) {
      const scopes = connections.map(resolveAiCallBudgetScope);
      for (const scope of scopes) {
        const count = scopes.filter(s => s.kind === scope.kind && (s.kind === 'device'
          || (scope.kind === 'remote-account' && s.remoteAccountId === scope.remoteAccountId))).length;
        if (count > AI_MAX_BACKGROUND_PER_WINDOW || getBackgroundCallBatchRetryAfter(cameraBudgetRecords(state, scope, now), 'reading', now, count) !== undefined) {
          throw new Error('reading-budget-deferred');
        }
      }
      scopes.forEach((scope, n) => inFlightBudgetRecords.set(ids[n], { id: ids[n], kind: 'reading', priority: 'background',
        startedAt: now, endedAt: now, scope: scope.kind,
        ...(scope.kind === 'remote-account' ? { remoteAccountId: scope.remoteAccountId } : {}) }));
    }
    const reserved = inFlightBudgetRecords.get(ids[index]);
    const actualScope = resolveAiCallBudgetScope(input.connection);
    if (!reserved || reserved.scope !== actualScope.kind
      || (actualScope.kind === 'remote-account' && reserved.remoteAccountId !== actualScope.remoteAccountId)) throw new Error('reading-budget-unreserved');
    try {
      await input.beforeTransport();
      state = await loadBudgetState(now);
      await saveBudgetState({ ...state, records: [...state.records, { ...reserved, startedAt: now, endedAt: now }] });
      inFlightBudgetRecords.delete(ids[index]);
    } catch (error) {
      if (actualScope.kind === 'remote-account') await discardUnstartedReadingBudgetCaptures(ids[index], actualScope.remoteAccountId);
      const latest = await loadBudgetState(now);
      if (latest.records.some(r => r.id === ids[index])) await saveBudgetState({ ...latest, records: latest.records.filter(r => r.id !== ids[index]) });
      throw error;
    }
  }));
  if (!result.committed) throw new Error('reading-budget-restore');
}

// Serializes only local budget read/check/write, never model work or the model scheduler.
function runBudgetWrite<T>(work: () => Promise<T>): Promise<T> {
  const next = budgetWriteTail.then(work, work);
  budgetWriteTail = next.then(() => undefined, () => undefined);
  return next;
}

function holdInFlightBudget(kind: AiCallKind, scope: AiCallBudgetScope, startedAt: number, priority: AiRuntimePriority = 'background') {
  const record: AiCallBudgetRecord = {
    id: `ai-call-${Crypto.randomUUID()}`, kind, priority, scope: scope.kind, startedAt, endedAt: startedAt,
    ...(scope.kind === 'remote-account' ? { remoteAccountId: scope.remoteAccountId } : {}),
  };
  inFlightBudgetRecords.set(record.id, record);
  return record;
}

function cameraBudgetRecords(state: AiCallBudgetState, scope: AiCallBudgetScope, now: number) {
  const persistedIds = new Set(state.records.map(record => record.id));
  return [...state.records, ...[...inFlightBudgetRecords.values()]
    .filter(record => !persistedIds.has(record.id))
    .map(record => ({ ...record, endedAt: now }))]
    .filter(record => recordAppliesToScope(record, scope));
}

/** A read-only offer check. responseRequests counts only remaining background text requests. */
export async function canAffordCameraObservation(input: {
  visionConnection: AiCallBudgetConnection;
  responseConnection?: AiCallBudgetConnection;
  responseRequests?: number;
  now?: number;
}): Promise<boolean> {
  const count = input.responseRequests ?? 0;
  if (!Number.isSafeInteger(count) || count < 0 || count > AI_MAX_BACKGROUND_PER_WINDOW
    || (count > 0 && !input.responseConnection)) return false;
  const now = input.now ?? Date.now();
  const visionScope = resolveAiCallBudgetScope(input.visionConnection);
  const responseScope = count > 0 ? resolveAiCallBudgetScope(input.responseConnection) : undefined;
  const sameScope = !!responseScope && responseScope.kind === visionScope.kind
    && (responseScope.kind === 'device'
      || (visionScope.kind === 'remote-account' && responseScope.remoteAccountId === visionScope.remoteAccountId));
  const visionCount = 1 + (sameScope ? count : 0);
  // The generic batch helper was designed for one/two requests; never ask it to admit three.
  if (visionCount > AI_MAX_BACKGROUND_PER_WINDOW) return false;
  const state = await loadBudgetState(now);
  const visionRetryAt = getBackgroundCallBatchRetryAfter(
    cameraBudgetRecords(state, visionScope, now), 'cameraVision', now, visionCount,
  );
  if (visionRetryAt !== undefined) return false;
  return !responseScope || getBackgroundCallBatchRetryAfter(
    cameraBudgetRecords(state, responseScope, now), 'proactive', now,
    sameScope ? visionCount : count,
  ) === undefined;
}

/** Invoked immediately before each real vision transport. A successful ID cannot admit transport again. */
export async function beginCameraVisionBudgetRequest(input: {
  connection: AiCallBudgetConnection;
  dataEpoch: number;
  requestId: string;
  beforeTransport?: () => Promise<void>;
}): Promise<void> {
  const recordId = `camera-vision:${input.requestId}`;
  if (!input.requestId.trim() || recordId.length > 256) throw new Error('camera-vision-budget-invalid-request-id');
  const scope = resolveAiCallBudgetScope(input.connection);
  const result = await runBudgetWrite(() => runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    await input.beforeTransport?.();
    if (!canCommitBackupRestoreDataEpoch(input.dataEpoch)) throw new Error('camera-vision-budget-restore');
    const now = Date.now();
    const latest = await loadBudgetState(now);
    if (latest.records.some(record => record.id === recordId)) throw new Error('camera-vision-budget-duplicate');
    const retryAt = getBackgroundCallRetryAfter(
      cameraBudgetRecords(latest, scope, now), 'cameraVision', now,
    );
    if (retryAt !== undefined) throw new Error(`camera-vision-budget-deferred:${retryAt}`);
    if (scope.kind === 'remote-account') {
      await discardUnstartedCameraVisionBudgetCaptures(recordId, scope.remoteAccountId);
    }
    const record: AiCallBudgetRecord = {
      id: recordId, startedAt: now, endedAt: now, kind: 'cameraVision', priority: 'background', scope: scope.kind,
      ...(scope.kind === 'remote-account' ? { remoteAccountId: scope.remoteAccountId } : {}),
    };
    try {
      await saveBudgetState({ ...latest, records: [...latest.records, record] });
    } catch (error) {
      if (scope.kind === 'remote-account') {
        await discardUnstartedCameraVisionBudgetCaptures(recordId, scope.remoteAccountId);
      }
      throw error;
    }
  }));
  if (!result.committed) throw new Error('camera-vision-budget-restore');
}

export async function getProactiveBudgetRetryAt(connection: AiCallBudgetConnection, now = Date.now(), count = 2) {
  const scope = resolveAiCallBudgetScope(connection);
  const state = await loadBudgetState(now);
  return getBackgroundCallBatchRetryAfter(state.records.filter(record => recordAppliesToScope(record, scope)), 'proactive', now, count);
}

/** Called immediately before an admitted proactive transport request. Failed transports
 * still cost one request; generated drafts and local retries do not add records. */
export async function beginProactiveBudgetRequest(input: {
  connection: AiCallBudgetConnection;
  dataEpoch: number;
  preflightCount: number;
  beforeStart: () => Promise<string | void>;
  beforeTransport?: () => Promise<void>;
  /** A paired contact starts its shared round only after the existing cost admission committed. */
  afterAdmission?: () => Promise<void>;
  purpose?: 'proactive-contact' | 'other';
}): Promise<void> {
  const scope = resolveAiCallBudgetScope(input.connection);
  const now = Date.now();
  await checkAutomaticRequestCost(input);
  const current = await loadBudgetState(now);
  const retryAt = getBackgroundCallBatchRetryAfter(current.records.filter(record => recordAppliesToScope(record, scope)),
    'proactive', now, input.preflightCount);
  if (retryAt) throw new ProactiveBudgetDeferredError(retryAt);
  await checkAutomaticRequestCost(input);
  const requestToken = await input.beforeStart();
  await input.beforeTransport?.();
  const result = await runBudgetWrite(() => runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    await checkAutomaticRequestCost(input);
    const latest = await loadBudgetState(now);
    const currentRetryAt = getBackgroundCallBatchRetryAfter(
      latest.records.filter(record => recordAppliesToScope(record, scope)), 'proactive', Date.now(), input.preflightCount,
    );
    if (currentRetryAt) throw new ProactiveBudgetDeferredError(currentRetryAt);
    const admittedAt = Date.now();
    const record: AiCallBudgetRecord = {
      id: requestToken ? `proactive:${requestToken}` : `ai-call-${Crypto.randomUUID()}`, startedAt: admittedAt, endedAt: admittedAt,
      kind: 'proactive', priority: 'background', scope: scope.kind,
      ...(input.purpose ? { purpose: input.purpose } : {}),
      ...(scope.kind === 'remote-account' ? { remoteAccountId: scope.remoteAccountId } : {}),
    };
    await saveBudgetState({ ...latest, records: [...latest.records, record] });
  }));
  if (!result.committed) throw new Error('proactive-budget-restore');
  await input.afterAdmission?.();
}

/** Only the owner of a request proven not to have reached transport may release it. */
export async function releaseUnstartedProactiveBudgetRequest(input: {
  connection: AiCallBudgetConnection; dataEpoch: number; requestToken: string;
}): Promise<void> {
  const scope = resolveAiCallBudgetScope(input.connection);
  const result = await runBudgetWrite(() => runBackupRestoreDataEpochCommit(input.dataEpoch, async () => {
    if (scope.kind === 'remote-account') await discardUnstartedProactiveBudgetCaptures(
      `proactive:${input.requestToken}`, scope.remoteAccountId,
    );
    const latest = await loadBudgetState(Date.now());
    const records = latest.records.filter(record => record.id !== `proactive:${input.requestToken}`
      || !recordAppliesToScope(record, scope));
    if (records.length !== latest.records.length) await saveBudgetState({ ...latest, records });
  }));
  if (!result.committed) throw new Error('proactive-budget-restore');
}

async function loadBudgetState(now = Date.now()): Promise<AiCallBudgetState> {
  const raw = await AsyncStorage.getItem(AI_CALL_BUDGET_KEY);
  return parseAiCallBudgetState(raw, now);
}

async function saveBudgetState(state: AiCallBudgetState) {
  await AsyncStorage.setItem(
    AI_CALL_BUDGET_KEY,
    serializeAiCallBudgetState(state),
  );
}

function recordAppliesToScope(
  record: AiCallBudgetRecord,
  scope: AiCallBudgetScope,
) {
  if (record.scope === 'legacy-device') return true;
  if (scope.kind === 'device') return record.scope === 'device';
  return record.scope === 'remote-account'
    && record.remoteAccountId === scope.remoteAccountId;
}

function getBudgetRetryAfter(
  state: AiCallBudgetState,
  kind: AiCallKind,
  now: number,
  scope: AiCallBudgetScope,
) {
  const applicable = state.records.filter(
    (record) => recordAppliesToScope(record, scope),
  );
  // Existing appointment/follow-up callers retain their original interval.
  // Unified contact uses its separate preflight above and owns its 5/15/30m timing.
  const legacyProactiveRetryAt = kind === 'proactive'
    ? applicable.filter(record => record.kind === 'proactive')
      .reduce((latest, record) => Math.max(latest, record.endedAt + 20 * 60_000), 0)
    : 0;
  const retryAt = Math.max(getBackgroundCallRetryAfter(applicable, kind, now) ?? 0, legacyProactiveRetryAt);
  return retryAt > now ? retryAt : undefined;
}

export async function runBudgetedAiCall<T>(
  kind: AiCallKind,
  priority: AiCallPriority,
  fn: (admission: AiRequestAdmission) => Promise<T>,
  options: {
    connection?: AiCallBudgetConnection | null;
    dataEpoch?: number | null;
    shouldRecordSuccess?: (value: T) => boolean;
    purpose?: AiCallPurpose;
    continuation?: { generationKey: string; nextRequest: 2 | 3 };
  } = {},
): Promise<BudgetedAiCallResult<T>> {
  if (priority !== 'background' && !options.purpose) {
    return runScheduledAiCall(kind, priority, () => fn({ beforeTransport: async (start, ready) => { await start?.(); ready?.(); } }));
  }

  const startedAt = Date.now();
  const scope = resolveAiCallBudgetScope(options.connection);
  const state = options.dataEpoch === undefined
    ? await loadBudgetState(startedAt)
    : await runBackupRestoreDataEpochCommit(
      options.dataEpoch,
      () => loadBudgetState(startedAt),
    ).then((loaded) => loaded.committed ? loaded.value : null);
  if (!state) return { ok: false, reason: 'restore', skipped: true };
  try { await checkAutomaticRequestCost(options, state.records); }
  catch (error) { if (isAiCostDeferred(error)) return costSkipped(error); throw error; }
  if (options.continuation && (kind !== 'lifeStatePolish' || options.purpose !== 'home-status'
    || !options.continuation.generationKey || ![2, 3].includes(options.continuation.nextRequest))) throw new Error('unsupported-cost-continuation');
  const budgetRetryAfter = priority !== 'background' ? undefined : options.continuation
    ? getBackgroundCallRetryAfter(state.records.filter(record => recordAppliesToScope(record, scope)), kind, startedAt, true)
    : getBudgetRetryAfter(state, kind, startedAt, scope);
  if (budgetRetryAfter) {
    return { ok: false, reason: 'budget', retryAfter: budgetRetryAfter, skipped: true };
  }

  let inFlightRecord: AiCallBudgetRecord | undefined;
  let requestAdmission: ReturnType<typeof createRequestAdmission> | undefined;
  try {
    const scheduled = await runScheduledAiCall(kind, priority, () => {
      inFlightRecord = holdInFlightBudget(kind, scope, startedAt, priority);
      requestAdmission = createRequestAdmission(inFlightRecord, options);
      return fn(requestAdmission.admission);
    });
    if (!('value' in scheduled)) {
      return {
        ok: false,
        reason: scheduled.reason,
        retryAfter: startedAt + SCHEDULER_RECHECK_MS,
        skipped: true,
      };
    }
    const value = scheduled.value;
    if (requestAdmission?.deferred()) return costSkipped(requestAdmission.deferred()!);
    // Explicit-purpose callers register each HTTP at beforeTransport, not again
    // when a result, null paper or local-only save returns from the outer wrapper.
    if (options.purpose) return { ok: true, skipped: false, value };
    if (options.shouldRecordSuccess && !options.shouldRecordSuccess(value)) {
      return { ok: true, skipped: false, value };
    }
    const endedAt = Date.now();
    const record: AiCallBudgetRecord = { ...inFlightRecord!, endedAt };
    const saved = await runBudgetWrite(async () => {
      const appendRecord = async () => {
        const latest = await loadBudgetState(endedAt);
        await saveBudgetState({
          ...latest,
          records: [...latest.records, record],
        });
      };
      if (options.dataEpoch === undefined) {
        await appendRecord();
        return { committed: true };
      }
      return runBackupRestoreDataEpochCommit(options.dataEpoch, appendRecord);
    });
    if (!saved.committed) return { ok: false, reason: 'restore', skipped: true };
    const nextAllowedAt = getBudgetRetryAfter({
      ...state,
      records: [...state.records, record],
    }, kind, endedAt, scope);
    return { nextAllowedAt, ok: true, skipped: false, value };
  } catch (error) {
    if (isAiCostDeferred(error)) return costSkipped(error);
    throw error;
  } finally {
    try { await requestAdmission?.finish(); }
    finally { if (inFlightRecord) inFlightBudgetRecords.delete(inFlightRecord.id); }
  }
}

export async function runBudgetedAiCallPair<TFirst, TSecond>(
  kind: AiCallKind,
  first: (admission: AiRequestAdmission) => Promise<TFirst>,
  second: (admission: AiRequestAdmission) => Promise<TSecond>,
  options: {
    connection?: AiCallBudgetConnection | null;
    dataEpoch?: number | null;
    shouldContinue?: () => boolean;
    shouldRecordAttempt?: (attempt: 1 | 2) => boolean;
    retrySecond?: { run: (admission: AiRequestAdmission) => Promise<TSecond>; shouldRun: () => boolean; shouldRecordAttempt: () => boolean };
    purpose?: AiCallPurpose;
    secondPurpose?: AiCallPurpose;
    secondKind?: AiCallKind;
    sharedExperienceContinuation?: { generationKey: string; partIndex: number };
  } = {},
): Promise<BudgetedAiCallPairResult<TFirst, TSecond>> {
  // Only the approved homepage tool-follow-up path may buy one extra body retry.
  if (options.retrySecond && (kind !== 'lifeStatePolish' || options.secondKind)) throw new Error('unsupported-pair-retry');
  const scope = resolveAiCallBudgetScope(options.connection);
  const scheduled = await runScheduledAiCall(kind, 'background', async () => {
    const preflightAt = Date.now();
    const state = options.dataEpoch === undefined
      ? await loadBudgetState(preflightAt)
      : await runBackupRestoreDataEpochCommit(
          options.dataEpoch,
          () => loadBudgetState(preflightAt),
        ).then((loaded) => loaded.committed ? loaded.value : null);
    if (!state) return { ok: false as const, reason: 'restore', skipped: true as const };
    try { await checkAutomaticRequestCost(options, state.records); }
    catch (error) { if (isAiCostDeferred(error)) return costSkipped(error); throw error; }
    const applicable = state.records.filter((record) => recordAppliesToScope(record, scope));
    let continuation = false;
    if (kind === 'afterglow' && options.secondKind === 'affectState' && options.sharedExperienceContinuation) {
      const { loadInnerUpdateState } = await import('../chat/chatAfterglowState');
      const batch = (await loadInnerUpdateState())?.experience?.batch;
      continuation = !!batch?.segments && batch.generationKey === options.sharedExperienceContinuation.generationKey
        && batch.segments.index === options.sharedExperienceContinuation.partIndex && batch.segments.index > 0
        && ['post', 'call', 'letter', 'gift'].includes(batch.kind) && batch.wants.attempts === 0 && batch.affect.attempts === 0;
    }
    // Keep the ordinary two-slot admission. The explicitly approved third request
    // is held below and all actual requests count against subsequent opportunities.
    const retryAfter = getBackgroundCallBatchRetryAfter(applicable, kind, preflightAt, 2, continuation)
      || (options.secondKind && getBackgroundCallBatchRetryAfter(applicable, options.secondKind, preflightAt, 2, continuation));
    if (retryAfter) return { ok: false as const, reason: 'budget', retryAfter, skipped: true as const };

    const appendStartedCallRecord = async (startedAt: number, pending: AiCallBudgetRecord) => {
      const endedAt = Date.now();
      const record: AiCallBudgetRecord = { ...pending, startedAt, endedAt };
      const saveLatest = async () => {
        const latest = await loadBudgetState(endedAt);
        await saveBudgetState({ ...latest, records: [...latest.records, record] });
      };
      await runBudgetWrite(async () => {
        if (options.dataEpoch === undefined) await saveLatest();
        else await runBackupRestoreDataEpochCommit(options.dataEpoch, saveLatest);
      });
    };

    // Reserve the admitted continuation (and optional one-shot retry) before starting.
    const firstPending = holdInFlightBudget(kind, scope, Date.now());
    const secondPending = holdInFlightBudget(options.secondKind ?? kind, scope, Date.now());
    const retryPending = options.retrySecond ? holdInFlightBudget(options.secondKind ?? kind, scope, Date.now()) : undefined;
    const firstAdmission = createRequestAdmission(firstPending, options);
    const secondAdmission = createRequestAdmission(secondPending, { ...options, purpose: options.secondPurpose ?? options.purpose });
    const retryAdmission = retryPending ? createRequestAdmission(retryPending, { ...options, purpose: options.secondPurpose ?? options.purpose }) : undefined;
    try {
      const firstStartedAt = Date.now();
      let firstValue: TFirst;
      try {
        firstValue = await first(firstAdmission.admission);
      } finally {
        await firstAdmission.finish();
        if (!options.purpose && options.shouldRecordAttempt?.(1) !== false) await appendStartedCallRecord(firstStartedAt, firstPending);
        inFlightBudgetRecords.delete(firstPending.id);
      }
      if (firstAdmission.deferred()) return costSkipped(firstAdmission.deferred()!);
      if (options.shouldContinue && !options.shouldContinue()) {
        return { ok: true as const, skipped: false as const, values: [firstValue, undefined] as const };
      }
      const secondStartedAt = Date.now();
      let secondValue: TSecond;
      try {
        secondValue = await second(secondAdmission.admission);
      } finally {
        await secondAdmission.finish();
        if (!(options.secondPurpose ?? options.purpose) && options.shouldRecordAttempt?.(2) !== false) await appendStartedCallRecord(secondStartedAt, secondPending);
        inFlightBudgetRecords.delete(secondPending.id);
      }
      if (secondAdmission.deferred()) return costSkipped(secondAdmission.deferred()!);
      if (options.retrySecond?.shouldRun() && retryPending) {
        const retryStartedAt = Date.now();
        try { secondValue = await options.retrySecond.run(retryAdmission!.admission); }
        finally {
          await retryAdmission!.finish();
          if (!(options.secondPurpose ?? options.purpose) && options.retrySecond.shouldRecordAttempt()) await appendStartedCallRecord(retryStartedAt, retryPending);
        }
      }
      if (retryAdmission?.deferred()) return costSkipped(retryAdmission.deferred()!);
      return { ok: true as const, skipped: false as const, values: [firstValue, secondValue] as const };
    } catch (error) {
      if (isAiCostDeferred(error)) return costSkipped(error);
      throw error;
    } finally {
      inFlightBudgetRecords.delete(firstPending.id);
      inFlightBudgetRecords.delete(secondPending.id);
      if (retryPending) inFlightBudgetRecords.delete(retryPending.id);
    }
  });
  if (!('value' in scheduled)) {
    return { ok: false, reason: scheduled.reason, retryAfter: Date.now() + SCHEDULER_RECHECK_MS, skipped: true };
  }
  return scheduled.value;
}
