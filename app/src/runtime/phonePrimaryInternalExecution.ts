import type { SyncExecutionOutcomeV2 } from '../sync/syncExecutionClaimV2Protocol';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import type {
  SyncExecutionFenceRecordV2,
  SyncExecutionLegacyFenceMarker,
  SyncExecutionOnceInputV2,
} from '../sync/syncExecutionOnceV2Controller';

type Result =
  | { state: 'completed'; outcome: SyncExecutionOutcomeV2; completedAt: number }
  | { state: 'deferred'; reason: 'not-before' | 'claimed-by-another-device' }
  | { state: 'reconciliation-required'; operationId: string };

export type PhonePrimaryInternalExecutor = (input: SyncExecutionOnceInputV2) => Promise<Result>;

type Ports = {
  activatedAt: number;
  identityScope: string;
  dataEpoch: number | null;
  isCurrent(): Promise<boolean>;
  mode: 'new-life' | 'local-completion' | 'new-side-effect';
  sideEffectStorage?: {
    getItem(key: string): Promise<string | null>;
    setItem(key: string, value: string): Promise<void>;
  };
  loadFence(operationId: string): Promise<SyncExecutionFenceRecordV2 | SyncExecutionLegacyFenceMarker | null>;
  now?: () => number;
};

const active = new Map<string, { identity: string; promise: Promise<Result> }>();

export function phonePrimaryExecutionScope(enrollment: {
  publicIdentity: { vaultId: string; keyId: string; deviceId: string };
} | null) {
  return enrollment ? JSON.stringify([enrollment.publicIdentity.vaultId,
    enrollment.publicIdentity.keyId, enrollment.publicIdentity.deviceId]) : 'unpaired';
}

/** Local business receipts remain authoritative; this never creates or finishes a relay claim. */
export function createPhonePrimaryInternalExecutor(ports: Ports): PhonePrimaryInternalExecutor {
  if (!Number.isSafeInteger(ports.activatedAt) || ports.activatedAt < 0) {
    throw new Error('phone-primary-activation-invalid');
  }
  return (input) => {
    if ((ports.mode === 'new-life' && input.category !== 'life-tick')
      || (ports.mode === 'local-completion' && input.category !== 'reminder')
      || (ports.mode === 'new-side-effect' && input.category !== 'alarm' && input.category !== 'tool-call')) {
      throw new Error('phone-primary-internal-category-invalid');
    }
    if (!canCommitBackupRestoreDataEpoch(ports.dataEpoch)) {
      return Promise.resolve({ state: 'reconciliation-required', operationId: input.operationId });
    }
    const key = JSON.stringify([ports.identityScope, ports.activatedAt, ports.dataEpoch, input.operationId]);
    const identity = JSON.stringify([input.category, input.createdAt, input.notBefore ?? input.createdAt, ports.mode]);
    const current = active.get(key);
    if (current) {
      if (current.identity !== identity) throw new Error('phone-primary-operation-identity-changed');
      return current.promise;
    }
    const promise = run(input, ports).finally(() => {
      if (active.get(key)?.promise === promise) active.delete(key);
    });
    active.set(key, { identity, promise });
    return promise;
  };
}

async function run(input: SyncExecutionOnceInputV2, ports: Ports): Promise<Result> {
  const pending = (): Result => ({ state: 'reconciliation-required', operationId: input.operationId });
  const current = async () => canCommitBackupRestoreDataEpoch(ports.dataEpoch)
    && await ports.isCurrent() && canCommitBackupRestoreDataEpoch(ports.dataEpoch);
  if (!await current()) return pending();
  const now = (ports.now ?? Date.now)();
  if ((input.notBefore ?? input.createdAt) > now) return { state: 'deferred', reason: 'not-before' };
  const fence = await ports.loadFence(input.operationId);
  if (!await current()) return pending();
  const existing = await input.reconcile?.() ?? null;
  if (!await current()) return pending();
  if (existing !== null) return { state: 'completed', outcome: existing, completedAt: now };
  // Only external/device effects need a durable local start. Never manufacture a
  // relay claim: the original operation and local business receipts stay intact.
  const storage = ports.mode === 'new-side-effect' ? ports.sideEffectStorage : undefined;
  const localKey = `junluo.runtime.phonePrimaryEffect.v1:${ports.identityScope}:${input.operationId}`;
  const localIdentity = JSON.stringify([input.category, input.createdAt, input.notBefore ?? input.createdAt]);
  if (ports.mode === 'new-side-effect') {
    if (!storage) throw new Error('phone-primary-side-effect-storage-required');
    const raw = await storage.getItem(localKey);
    if (!await current()) return pending();
    if (raw !== null) {
      const saved: unknown = JSON.parse(raw);
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)
        || !('identity' in saved) || saved.identity !== localIdentity || !('state' in saved)) {
        throw new Error('phone-primary-side-effect-record-invalid');
      }
      if (saved.state === 'completed' && 'outcome' in saved && 'completedAt' in saved
        && (saved.outcome === 'completed' || saved.outcome === 'failed' || saved.outcome === 'cancelled')
        && Number.isSafeInteger(saved.completedAt) && Number(saved.completedAt) >= 0) {
        return { state: 'completed', outcome: saved.outcome, completedAt: Number(saved.completedAt) };
      }
      return pending();
    }
  }
  if (fence) {
    if (fence.protocolVersion === 2 && fence.operationId === input.operationId
      && fence.category === input.category && fence.state === 'completed'
      && fence.completion && 'operationId' in fence.completion
      && fence.completion.state === 'completed' && fence.completion.outcome !== null
      && fence.completion.completedAt !== null) {
      return { state: 'completed', outcome: fence.completion.outcome, completedAt: fence.completion.completedAt };
    }
    // A local absence of a result never proves that an old remote action did not happen.
    return { state: 'reconciliation-required', operationId: input.operationId };
  }
  if ((ports.mode === 'new-life' || ports.mode === 'new-side-effect') && input.createdAt < ports.activatedAt) {
    return { state: 'reconciliation-required', operationId: input.operationId };
  }
  // Completion callers use the existing round/CAS transaction. Life callers persist
  // their existing completedOperationIds; this in-process flight is not a crash journal.
  const latest = await input.reconcile?.() ?? null;
  if (!await current()) return pending();
  if (latest !== null) return { state: 'completed', outcome: latest, completedAt: (ports.now ?? Date.now)() };
  if (storage) {
    await storage.setItem(localKey, JSON.stringify({ identity: localIdentity, state: 'started' }));
    if (!await current()) return pending();
  }
  const outcome = await input.execute();
  if (!await current()) return pending();
  const completedAt = (ports.now ?? Date.now)();
  const completedOutcome = outcome === 'failed' || outcome === 'cancelled' ? outcome : 'completed';
  if (storage) {
    await storage.setItem(localKey, JSON.stringify({ identity: localIdentity, state: 'completed',
      outcome: completedOutcome, completedAt }));
    if (!await current()) return pending();
  }
  return {
    state: 'completed',
    outcome: completedOutcome,
    completedAt,
  };
}
