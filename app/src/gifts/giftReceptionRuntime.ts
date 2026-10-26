import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isJunluoWantsAwake, isWantsClockOwner } from '../life/junluoDesireRuntime';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadAndroidSyncNetworkClass } from '../sync/syncAndroidNetworkClass';
import { captureGiftWork, deliverDueGift, listGiftViews, loadGift, loadGiftView, recordGiftReceptionDecision } from './giftStore';
import { currentGiftUnderstandingSource } from './giftOriginalMedia';
import { prepareGiftReceptionDecision } from './giftReceptionDecision';
import { understandGiftOriginal } from './giftUnderstanding';
import { executeGiftWorkOnce } from './giftExecutionOnce';
import { deferGiftProcessing, listDueGiftVersions, loadGiftProcessingState, loadGiftUnderstandingReceipt,
  saveGiftUnderstandingReceipt } from './giftProcessingStore';
import { emitGiftChanges } from './giftEvents';
import type { GiftReceptionDecision, GiftRecord, GiftWorkToken } from './giftTypes';

const RETRY_MS = 5 * 60_000;
type Understanding = Awaited<ReturnType<typeof understandGiftOriginal>>;
type Pending = { token: GiftWorkToken; stage: string; choice?: GiftReceptionDecision; original?: Understanding };
// Only actual returned results waiting on their local write; never model work.
const unsaved = new Map<string, Pending>();
let running: Promise<void> | undefined;
const keyFor = (token: GiftWorkToken, stage: string) => JSON.stringify([token.id, token.revision, token.dataEpoch, stage]);
const stale = (error: unknown) => error instanceof Error
  && ['gift-stale-version', 'gift-stale-data-epoch', 'gift-not-opened', 'gift-not-delivered'].includes(error.message);

async function requestAllowed(token: GiftWorkToken) {
  if (!isWantsClockOwner() || !canCommitBackupRestoreDataEpoch(token.dataEpoch) || isChatReplyInFlight()) return false;
  const [awake, policy, network] = await Promise.all([isJunluoWantsAwake(), loadAutomaticRemoteAiPolicy({ strict: true }),
    loadAndroidSyncNetworkClass()]);
  return awake && isAutomaticRemoteAiAllowed(policy) && network !== 'offline'
    && !isChatReplyInFlight() && canCommitBackupRestoreDataEpoch(token.dataEpoch);
}

async function assertCurrent(token: GiftWorkToken, stage: string) {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
  if (stage.startsWith('attachment:')) await currentGiftUnderstandingSource(token, stage.slice('attachment:'.length));
  else {
    const view = await loadGiftView(token.id, 'I');
    if (!view || view.gift.revision !== token.revision) throw Error('gift-stale-version');
    if (view.revealed || view.gift.sender !== 'you' || view.gift.receptionStatus === 'declined'
      || (view.gift.receptionNextAt != null && view.gift.receptionNextAt > Date.now())) throw Error('gift-reception-not-due');
  }
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) throw Error('gift-stale-data-epoch');
}

async function savePending(pending: Pending) {
  const { token, stage } = pending;
  await assertCurrent(token, stage);
  if (pending.choice) await recordGiftReceptionDecision(token, pending.choice, Date.now());
  else if (pending.original) {
    const result = await saveGiftUnderstandingReceipt(pending.original);
    if (!result.committed) throw Error('gift-stale-version');
  } else throw Error('gift-invalid-processing-state');
  unsaved.delete(keyFor(token, stage));
  emitGiftChanges();
}

async function flushPending() {
  for (const [key, pending] of unsaved) {
    try { await savePending(pending); }
    catch (error) { if (stale(error) || !canCommitBackupRestoreDataEpoch(pending.token.dataEpoch)) unsaved.delete(key); }
  }
}

async function reconcile(token: GiftWorkToken, stage: string, attempt: number): Promise<'completed' | 'failed' | null> {
  if (!canCommitBackupRestoreDataEpoch(token.dataEpoch)) return 'failed';
  const gift = await loadGift(token.id);
  if (!gift) return 'failed';
  if (stage === 'reception' && gift.revision === token.revision + 1 && gift.receptionDecidedAt != null
    && gift.deliveryStatus === 'delivered' && ['opened', 'deferred', 'declined'].includes(gift.receptionStatus)) return 'completed';
  if (gift.revision !== token.revision) return 'failed';
  if (stage.startsWith('attachment:') && await loadGiftUnderstandingReceipt(token, stage.slice('attachment:'.length))) return 'completed';
  if (unsaved.has(keyFor(token, stage))) {
    await savePending(unsaved.get(keyFor(token, stage))!);
    return 'completed';
  }
  return (await loadGiftProcessingState(token, stage)).lastFailedAttempt >= attempt ? 'failed' : null;
}

async function runStage(token: GiftWorkToken, stage: string, createdAt: number) {
  const state = await loadGiftProcessingState(token, stage);
  if (state.retryAt > Date.now() || !await requestAllowed(token)) return false;
  const attempt = state.lastFailedAttempt + 1;
  const callbacks = {
    reconcileLocally: () => reconcile(token, stage, attempt),
    executeLocally: async (): Promise<'completed' | 'failed'> => {
      let retryAt = Date.now() + RETRY_MS;
      try {
        await assertCurrent(token, stage);
        if (!await requestAllowed(token)) throw Error('gift-request-postponed');
        const reception = stage === 'reception' ? await prepareGiftReceptionDecision(token) : null;
        const config = reception ? null : await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
        const source = reception ? null : await currentGiftUnderstandingSource(token, stage.slice('attachment:'.length));
        const connection = reception?.connection ?? (source?.attachment.kind === 'audio'
          ? config!.audioUnderstandingConnection : config!.visionConnection);
        const result = await runBudgetedAiCall(reception ? 'giftReception' : 'giftUnderstanding', 'background', async admission => {
          const beforeRequest = (assertReady?: () => Promise<void>) => admission.beforeTransport(undefined, async () => {
            if (!await requestAllowed(token)) throw Error('gift-request-postponed');
            if (config && source) {
              const latest = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
              const audio = source.attachment.kind === 'audio';
              if (JSON.stringify(audio ? latest.audioUnderstandingConnection : latest.visionConnection) !== JSON.stringify(connection)
                || (audio ? latest.audioUnderstandingKey : latest.visionKey) !== (audio ? config.audioUnderstandingKey : config.visionKey)) {
                throw Error('gift-understanding-config-changed');
              }
            }
            await assertCurrent(token, stage);
            await assertReady?.();
          });
          const pending = reception ? { token, stage, choice: await reception.request(beforeRequest,
            choice => unsaved.set(keyFor(token, stage), { token, stage, choice })) }
            : { token, stage, original: await understandGiftOriginal(token, source!.attachment.id, { beforeRequest,
              onResult: original => unsaved.set(keyFor(token, stage), { token, stage, original }) }) };
          // The shared budget's own final write can fail after a paid response.
          // Retain it inside the callback, before control returns to that writer.
          unsaved.set(keyFor(token, stage), pending);
          return pending;
        }, { connection, dataEpoch: token.dataEpoch, purpose: 'other' });
        if (!result.ok) {
          retryAt = Math.max(retryAt, result.retryAfter ?? 0);
          throw Error('gift-request-postponed');
        }
        // Keeping the paid result precedes the fallible SQLite write. Sleeping or
        // turning automatic requests off afterwards does not erase a real result.
        const pending = result.value;
        unsaved.set(keyFor(token, stage), pending);
        await savePending(pending);
        return 'completed';
      } catch (error) {
        if (unsaved.has(keyFor(token, stage))) throw error;
        if (!stale(error)) await deferGiftProcessing(token, stage, attempt,
          error instanceof Error && /^gift-[a-z-]+$/.test(error.message) ? error.message : 'gift-request-failed', retryAt, true);
        return 'failed';
      }
    },
  };
  const result = await executeGiftWorkOnce({ giftId: token.id, revision: token.revision, stage, attempt, createdAt }, callbacks);
  const evidence = result.state === 'completed' ? await reconcile(token, stage, attempt) : null;
  if (result.state !== 'completed' || evidence === null) {
    await deferGiftProcessing(token, stage, attempt, result.state === 'deferred' ? 'gift-online-claim-pending'
      : 'gift-result-reconciliation-pending', Date.now() + RETRY_MS, false);
    emitGiftChanges();
    return false;
  }
  emitGiftChanges();
  return evidence === 'completed';
}

/** Existing phone life opportunities and immediate delivery share one drain. */
export function runGiftReceptionTick(options: { now?: number; allowRequest?: boolean } = {}): Promise<void> {
  if (!isWantsClockOwner()) return Promise.resolve();
  if (running) return running;
  running = tick(options).finally(() => { running = undefined; });
  return running;
}

async function tick(options: { now?: number; allowRequest?: boolean }) {
  const now = Math.min(options.now ?? Date.now(), Date.now());
  for (const version of await listDueGiftVersions(now)) {
    const token = await captureGiftWork(version.id);
    if (!token || token.revision !== version.revision) continue;
    if (await deliverDueGift(token, now)) emitGiftChanges();
  }
  await flushPending();
  const { runGiftEchoReplies } = await import('./giftEchoRuntime');
  const { runGiftMemoryTick } = await import('./giftMemoryRuntime');
  await runGiftEchoReplies({ allowRequest: false });
  await runGiftMemoryTick({ allowRequest: false });
  if (options.allowRequest === false) return;
  for (const view of await listGiftViews('I')) {
    if (view.gift.sender !== 'you' || view.gift.deliveryStatus !== 'delivered' || view.gift.receptionStatus === 'declined') continue;
    let token = await captureGiftWork(view.gift.id);
    if (!token || token.revision !== view.gift.revision) continue;
    if (!view.revealed) {
      if (view.gift.receptionNextAt != null && view.gift.receptionNextAt > Date.now()) continue;
      if (!await runStage(token, 'reception', view.gift.deliveredAt!)) continue;
      // Preserve the original data epoch; a model result never captures a fresh epoch.
      const current = await loadGiftView(token.id, 'I');
      if (!current?.revealed || current.gift.revision !== token.revision + 1) continue;
      token = { ...token, revision: current.gift.revision };
    }
    const opened = await loadGiftView(token.id, 'I');
    if (!opened?.revealed || opened.gift.revision !== token.revision) continue;
    await readOpenedOriginals(token, opened.gift);
  }
  await runGiftEchoReplies();
  await runGiftMemoryTick();
}

async function readOpenedOriginals(token: GiftWorkToken, gift: GiftRecord) {
  for (const attachment of gift.attachments) {
    // Supplements are available to the existing echo read tool, without a new reception request.
    if (gift.supplementalAttachmentIds?.includes(attachment.id)) continue;
    if (attachment.kind !== 'audio' && attachment.kind !== 'image') continue;
    if (await loadGiftUnderstandingReceipt(token, attachment.id)) continue;
    // Preserve original order; a failed or budget-delayed item waits before the next.
    if (!await runStage(token, `attachment:${attachment.id}`, gift.openedAt!)) break;
  }
}
