import { loadGiftExecutionRelayBaseUrl } from './giftExecutionRelay';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import { createSyncExecutionOperationId } from '../sync/syncExecutionOperationId';
import { bytesToBase64Url, sha256BytesV1 } from '../sync/syncCrypto';
import { Platform } from 'react-native';
import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { ensurePhonePrimaryActivation, loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { AndroidSyncExecutionFenceV2SqlitePort } from '../sync/syncExecutionFenceSqlitePort';
import { isGiftLocalWorkStarted, startGiftLocalWork } from './giftProcessingStore';

type GiftWorkOutcome = 'completed' | 'failed';
type GiftWorkInput = { giftId: string; revision: number; stage: string; attempt: number; createdAt: number;
  dataEpoch?: number | null; localSourceCreatedAt?: number };
type GiftWorkResult = { state: 'completed'; outcome: GiftWorkOutcome }
  | { state: 'deferred' } | { state: 'reconciliation-required' };
type GiftWorkCallbacks = {
  executeLocally(startLocalRequest?: () => Promise<void>): Promise<GiftWorkOutcome>;
  reconcileLocally(): Promise<GiftWorkOutcome | null>;
};
type Enrollment = Awaited<ReturnType<typeof loadCurrentSyncRelayEnrollment>>;
type GiftWorkContext = { enrollment: Enrollment; scope: string; androidToken: {
  id: string; revision: number; dataEpoch: number;
} | null; activatedAt?: number };
const scopeOf = (enrollment: Enrollment) => enrollment
  ? JSON.stringify([enrollment.publicIdentity.vaultId, enrollment.publicIdentity.keyId, enrollment.publicIdentity.deviceId])
  : 'unpaired';
const active = new Map<string, { createdAt: number; dataEpoch?: number | null; localSourceCreatedAt?: number;
  result: Promise<GiftWorkResult> }>();

/** The caller supplies gift evidence and owns retry attempts; tick receipts are unrelated. */
export async function executeGiftWorkOnce(input: GiftWorkInput, callbacks: GiftWorkCallbacks): Promise<GiftWorkResult> {
  if (!input || typeof input.giftId !== 'string' || !input.giftId.trim() || input.giftId !== input.giftId.trim()
    || input.giftId.length > 128 || typeof input.stage !== 'string' || !input.stage.trim()
    || input.stage !== input.stage.trim() || input.stage.length > 512
    || !Number.isSafeInteger(input.revision) || input.revision < 1
    || !Number.isSafeInteger(input.attempt) || input.attempt < 0
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw Error('gift-execution-invalid-identity');
  const operationId = createSyncExecutionOperationId({ category: 'life-tick', scope: 'gift-cabinet',
    entityId: JSON.stringify([input.giftId, input.revision]),
    action: `${bytesToBase64Url(sha256BytesV1(new TextEncoder().encode(input.stage)))}:${input.attempt}` });
  const work = { ...input };
  const androidToken = Platform.OS === 'android' && work.dataEpoch !== undefined && work.dataEpoch !== null
    ? { id: work.giftId, revision: work.revision, dataEpoch: work.dataEpoch } : null;
  if (androidToken) {
    if (!canCommitBackupRestoreDataEpoch(androidToken.dataEpoch)) throw Error('gift-stale-data-epoch');
    const existing = await callbacks.reconcileLocally();
    if (existing !== null) return { state: 'completed', outcome: existing };
    // This survives activation changes: an already-started local request never
    // becomes an old source that may be sent again through the relay.
    if (await isGiftLocalWorkStarted(androidToken, work.stage, work.attempt)) return { state: 'reconciliation-required' };
  }
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const activation = androidToken ? await ensurePhonePrimaryActivation() : undefined;
  if (androidToken && !activation) return { state: 'deferred' };
  const context: GiftWorkContext = { enrollment, scope: scopeOf(enrollment), androidToken, activatedAt: activation?.activatedAt };
  if (!await contextCurrent(context)) return { state: 'deferred' };
  const activeKey = JSON.stringify([operationId, context.scope, context.activatedAt ?? null, work.dataEpoch ?? null, Platform.OS]);
  const current = active.get(activeKey);
  if (current) {
    if (current.createdAt !== work.createdAt || current.dataEpoch !== work.dataEpoch
      || current.localSourceCreatedAt !== work.localSourceCreatedAt) throw Error('gift-execution-identity-changed');
    return current.result;
  }
  const result = execute(work, operationId, callbacks, context).finally(() => {
    if (active.get(activeKey)?.result === result) active.delete(activeKey);
  });
  active.set(activeKey, { createdAt: work.createdAt, dataEpoch: work.dataEpoch,
    localSourceCreatedAt: work.localSourceCreatedAt, result });
  return result;
}

async function contextCurrent(context: GiftWorkContext) {
  if (context.androidToken) {
    if (!canCommitBackupRestoreDataEpoch(context.androidToken.dataEpoch)) return false;
    const activation = await loadPhonePrimaryActivation();
    if (!activation || activation.activatedAt !== context.activatedAt) return false;
  }
  const current = await loadCurrentSyncRelayEnrollment();
  return scopeOf(current) === context.scope
    && (!context.androidToken || canCommitBackupRestoreDataEpoch(context.androidToken.dataEpoch));
}

async function execute(input: GiftWorkInput, operationId: string, callbacks: GiftWorkCallbacks,
  context: GiftWorkContext): Promise<GiftWorkResult> {
  const { enrollment, androidToken } = context;
  if (androidToken && Number.isSafeInteger(input.localSourceCreatedAt) && input.localSourceCreatedAt! >= 0) {
    // Older sources and every existing fence keep their original reconciliation path.
    if (input.localSourceCreatedAt! >= context.activatedAt!
      && (!enrollment || !await new AndroidSyncExecutionFenceV2SqlitePort().load(operationId))) {
      const token = androidToken;
      let started = false;
      const startLocalRequest = async () => {
        if (started) throw Error('gift-local-request-already-started');
        if (!await contextCurrent(context)) throw Error('gift-local-context-changed');
        if (!await startGiftLocalWork(token, input.stage, input.attempt)) throw Error('gift-local-reconciliation-required');
        if (!await contextCurrent(context)) throw Error('gift-local-context-changed');
        started = true;
      };
      try {
        await callbacks.executeLocally(startLocalRequest);
      } catch {
        // A returned value may still be in the runtime's RAM cache. Only reconcile it.
      }
      const saved = await callbacks.reconcileLocally();
      return saved === null ? { state: 'reconciliation-required' } : { state: 'completed', outcome: saved };
    }
  }
  if (!enrollment) {
    const existing = await callbacks.reconcileLocally();
    if (!await contextCurrent(context)) return { state: 'deferred' };
    return { state: 'completed', outcome: existing ?? await callbacks.executeLocally() };
  }
  try {
    if (!await contextCurrent(context)) return { state: 'deferred' };
    const baseUrl = await loadGiftExecutionRelayBaseUrl();
    if (!baseUrl) return { state: 'deferred' };
    const { coordinator } = await createAndroidSyncExecutionOnceController({ baseUrl });
    const result = await coordinator.execute({ operationId, category: 'life-tick', createdAt: input.createdAt,
      reconcile: callbacks.reconcileLocally,
      execute: async () => await callbacks.reconcileLocally() ?? callbacks.executeLocally() });
    return result.state === 'completed'
      ? { state: 'completed', outcome: result.outcome === 'completed' ? 'completed' : 'failed' }
      : { state: result.state };
  } catch { return { state: 'deferred' }; }
}
