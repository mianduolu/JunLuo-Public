import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { isWantsClockOwner, isJunluoWantsAwake } from '../life/junluoDesireRuntime';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadAndroidSyncNetworkClass } from '../sync/syncAndroidNetworkClass';
import { captureGiftWork, listGiftViews } from './giftStore';
import { adoptGiftUnderstandingEchoes, commitGiftEchoReply, listPendingGiftEchoVersions, loadGiftEchoThread } from './giftEchoStore';
import { loadGiftEchoReadSelection, saveGiftEchoReadSelection } from './giftEchoReadStore';
import { deferGiftProcessing, loadGiftProcessingState, isGiftLocalWorkStarted,
  isKnownGiftLocalFailure } from './giftProcessingStore';
import { executeGiftWorkOnce } from './giftExecutionOnce';
import { giftEchoReviewApproved, prepareGiftEchoCall, type GiftEchoModelResult } from './giftEchoModel';
import { emitGiftChanges } from './giftEvents';
import type { GiftEcho, GiftWorkToken } from './giftTypes';

const RETRY_MS = 5 * 60_000;
type Pending = { token: GiftWorkToken; replyToId: string; result: GiftEchoModelResult; at: number };
const unsaved = new Map<string, Pending>();
const flights = new Map<string, Promise<void>>();
const workKey = (token: GiftWorkToken, replyToId: string) => JSON.stringify([token.id, token.revision, token.dataEpoch, replyToId]);
const isStale = (error: unknown) => error instanceof Error && ['gift-stale-version', 'gift-stale-data-epoch', 'gift-not-opened',
  'gift-echo-target-missing', 'gift-attachment-not-owned'].includes(error.message);

async function threadFor(token: GiftWorkToken) {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  const thread = await loadGiftEchoThread(token, 'I');
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  return thread;
}

async function allowed(token: GiftWorkToken, manual: boolean) {
  if ((!manual && !isWantsClockOwner()) || !canCommitBackupRestoreDataEpoch(token.dataEpoch) || isChatReplyInFlight()) return false;
  if (!await isJunluoWantsAwake()) return false;
  if (!manual && !isAutomaticRemoteAiAllowed(await loadAutomaticRemoteAiPolicy({ strict: true }))) return false;
  if (isWantsClockOwner() && await loadAndroidSyncNetworkClass() === 'offline') return false;
  return canCommitBackupRestoreDataEpoch(token.dataEpoch) && !isChatReplyInFlight();
}

async function savePending(pending: Pending) {
  const { token, replyToId, result, at } = pending;
  await threadFor(token);
  if (result.kind === 'read') await saveGiftEchoReadSelection(token, { replyToId, attachmentId: result.attachmentId, selectedAt: at });
  else await commitGiftEchoReply(token, { replyToId, content: result.content, createdAt: at,
    ...(result.attachmentId ? { attachmentId: result.attachmentId, originalId: result.originalId, readAt: result.readAt } : {}) });
  unsaved.delete(workKey(token, replyToId)); emitGiftChanges();
}

async function flushPending() {
  for (const [key, pending] of unsaved) {
    try { await savePending(pending); }
    catch (error) { if (isStale(error) || !canCommitBackupRestoreDataEpoch(pending.token.dataEpoch)) unsaved.delete(key); }
  }
}

/** Maps only existing real expressions; opening a page never calls a model. */
export async function recoverGiftEchoes() {
  for (const view of await listGiftViews('I')) {
    if (!view.revealed || view.gift.deliveryStatus !== 'delivered' || view.gift.openedAt === null) continue;
    const token = await captureGiftWork(view.gift.id);
    if (token?.revision === view.gift.revision) await adoptGiftUnderstandingEchoes(token);
  }
}

async function evidence(token: GiftWorkToken, messageId: string, stage: string, attempt: number): Promise<'completed' | 'failed' | null> {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) return 'failed';
  let thread;
  try { thread = await threadFor(token); } catch (error) { if (isStale(error)) return 'failed'; throw error; }
  if (thread.messages.some(line => line.subject === 'I' && line.replyToId === messageId)) return 'completed';
  const pending = unsaved.get(workKey(token, messageId));
  if (pending) { await savePending(pending); return 'completed'; }
  if (stage.startsWith('echo-select:') && await loadGiftEchoReadSelection(token, messageId)) return 'completed';
  return (await loadGiftProcessingState(token, stage)).lastFailedAttempt >= attempt ? 'failed' : null;
}

async function runStage(token: GiftWorkToken, message: GiftEcho, manual: boolean) {
  const read = await loadGiftEchoReadSelection(token, message.id);
  const stage = `${read ? 'echo-read' : 'echo-select'}:${message.id}`;
  const state = await loadGiftProcessingState(token, stage);
  if ((!manual && state.retryAt > Date.now()) || !await allowed(token, manual)) return false;
  const attempt = state.lastFailedAttempt + 1;
  const result = await executeGiftWorkOnce({ giftId: token.id, revision: token.revision, stage, attempt, createdAt: message.createdAt,
    dataEpoch: token.dataEpoch, localSourceCreatedAt: message.createdAt }, {
    reconcileLocally: () => evidence(token, message.id, stage, attempt),
    executeLocally: async (startLocalRequest?: () => Promise<void>) => {
      let retryAt = Date.now() + RETRY_MS;
      let localStartDenied = false;
      try {
        const prepared = await prepareGiftEchoCall(token, message.id, read);
        const budget = await runBudgetedAiCall(prepared.budgetKind, manual ? 'normal' : 'background', async admission => {
          const returned = (value: GiftEchoModelResult) => unsaved.set(workKey(token, message.id), {
            token: { ...token }, replyToId: message.id, result: value, at: Date.now() });
          const value = await prepared.request(assertReady => admission.beforeTransport(undefined, async () => {
            if (!await allowed(token, manual)) throw Error('gift-echo-request-postponed');
            const current = await threadFor(token);
            if (!current.pendingYouIds.includes(message.id)) throw Error('gift-echo-target-missing');
            await assertReady?.();
            try { await startLocalRequest?.(); } catch (error) { localStartDenied = true; throw error; }
          }), returned);
          returned(value); return value;
        }, { connection: prepared.connection, dataEpoch: token.dataEpoch, purpose: manual ? 'manual-chat' : 'other' });
        if (!budget.ok) {
          retryAt = Math.max(retryAt, budget.retryAfter ?? 0);
          throw Error('gift-echo-request-postponed');
        }
        await savePending(unsaved.get(workKey(token, message.id))!);
        return 'completed';
      } catch (error) {
        if (unsaved.has(workKey(token, message.id))) throw error;
        if (localStartDenied) throw error;
        if (await isGiftLocalWorkStarted(token, stage, attempt) && !isKnownGiftLocalFailure(error)) throw error;
        if (!isStale(error)) await deferGiftProcessing(token, stage, attempt,
          error instanceof Error && /^gift-[a-z-]+$/.test(error.message) ? error.message : 'gift-echo-request-failed', retryAt, true);
        return 'failed';
      }
    },
  });
  const saved = result.state === 'completed' ? await evidence(token, message.id, stage, attempt) : null;
  if (result.state !== 'completed' || saved === null) {
    await deferGiftProcessing(token, stage, attempt, 'gift-echo-reconciliation-pending', Date.now() + RETRY_MS, false);
    emitGiftChanges(); return false;
  }
  emitGiftChanges(); return saved === 'completed';
}

async function drain(giftId: string, manual: boolean) {
  const token = await captureGiftWork(giftId);
  if (!token) return;
  for (;;) {
    const thread = await threadFor(token), messageId = thread.pendingYouIds[0];
    if (!messageId) return;
    const message = thread.messages.find(line => line.id === messageId)!;
    if (!await runStage(token, message, manual)) return;
  }
}

/** Manual desktop work and phone life opportunities share per-gift flights. */
export async function runGiftEchoReplies(options: { giftId?: string; manual?: boolean; allowRequest?: boolean } = {}) {
  await recoverGiftEchoes(); await flushPending();
  if (options.allowRequest === false || !giftEchoReviewApproved || (!options.manual && !isWantsClockOwner())) return;
  const ids = options.giftId ? [options.giftId] : (await listPendingGiftEchoVersions()).map(gift => gift.id);
  for (const id of ids) {
    let pending = flights.get(id);
    if (!pending) {
      pending = drain(id, options.manual === true).finally(() => { if (flights.get(id) === pending) flights.delete(id); });
      flights.set(id, pending);
    }
    try { await pending; } catch { emitGiftChanges(); }
  }
}
