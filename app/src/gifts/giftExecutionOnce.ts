import { loadGiftExecutionRelayBaseUrl } from './giftExecutionRelay';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';
import { createAndroidSyncExecutionOnceController } from '../sync/syncExecutionOnceExpo';
import { createSyncExecutionOperationId } from '../sync/syncExecutionOperationId';
import { bytesToBase64Url, sha256BytesV1 } from '../sync/syncCrypto';

type GiftWorkOutcome = 'completed' | 'failed';
type GiftWorkInput = { giftId: string; revision: number; stage: string; attempt: number; createdAt: number };
type GiftWorkResult = { state: 'completed'; outcome: GiftWorkOutcome }
  | { state: 'deferred' } | { state: 'reconciliation-required' };
type GiftWorkCallbacks = {
  executeLocally(): Promise<GiftWorkOutcome>;
  reconcileLocally(): Promise<GiftWorkOutcome | null>;
};
const active = new Map<string, { createdAt: number; result: Promise<GiftWorkResult> }>();

/** The caller supplies gift evidence and owns retry attempts; tick receipts are unrelated. */
export function executeGiftWorkOnce(input: GiftWorkInput, callbacks: GiftWorkCallbacks): Promise<GiftWorkResult> {
  if (!input || typeof input.giftId !== 'string' || !input.giftId.trim() || input.giftId !== input.giftId.trim()
    || input.giftId.length > 128 || typeof input.stage !== 'string' || !input.stage.trim()
    || input.stage !== input.stage.trim() || input.stage.length > 512
    || !Number.isSafeInteger(input.revision) || input.revision < 1
    || !Number.isSafeInteger(input.attempt) || input.attempt < 0
    || !Number.isSafeInteger(input.createdAt) || input.createdAt < 0) throw Error('gift-execution-invalid-identity');
  const operationId = createSyncExecutionOperationId({ category: 'life-tick', scope: 'gift-cabinet',
    entityId: JSON.stringify([input.giftId, input.revision]),
    action: `${bytesToBase64Url(sha256BytesV1(new TextEncoder().encode(input.stage)))}:${input.attempt}` });
  const current = active.get(operationId);
  if (current) {
    if (current.createdAt !== input.createdAt) throw Error('gift-execution-identity-changed');
    return current.result;
  }
  const work = { ...input };
  const result = execute(work, operationId, callbacks).finally(() => {
    if (active.get(operationId)?.result === result) active.delete(operationId);
  });
  active.set(operationId, { createdAt: work.createdAt, result });
  return result;
}

async function execute(input: GiftWorkInput, operationId: string, callbacks: GiftWorkCallbacks): Promise<GiftWorkResult> {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  if (!enrollment) {
    const existing = await callbacks.reconcileLocally();
    return { state: 'completed', outcome: existing ?? await callbacks.executeLocally() };
  }
  try {
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
