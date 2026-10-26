import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import type { AiConnection } from '../ai/types';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadDayTemplate } from '../schedule/dayTemplate';
import { getAutomaticCostRestriction, isAutomaticRemoteAiAllowed,
  loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import type { ScreenName } from '../types/navigation';
import { readShiyingChatActivity } from './shiyingChatSource';
import { getShiyingManualRun } from './shiyingStore';
import { getShiyingPickupRecoveryState, resolveShiyingPickupModelConfig, runAutomaticShiyingPickup } from './shiyingCoordinator';
import { getShiyingAutomaticNight, SHIYING_AUTOMATIC_CALL_LIMIT } from './shiyingAutomaticPolicy';
import { beginShiyingAutomaticNight, blockShiyingAutomaticNight,
  loadShiyingAutomaticState, subscribeShiyingAutomaticState } from './shiyingAutomaticStore';
import { SHIYING_RESTORE_PAUSED } from './shiyingBackupPolicy';

const CHECK_INTERVAL_MS = 60_000;
type Timer = ReturnType<typeof setTimeout>;

export function createShiyingAutomaticRuntime(ports: {
  isActive: () => boolean;
  screen: () => ScreenName;
  now?: () => number;
  loadState?: typeof loadShiyingAutomaticState;
  beginNight?: typeof beginShiyingAutomaticNight;
  blockNight?: typeof blockShiyingAutomaticNight;
  loadTemplate?: typeof loadDayTemplate;
  loadPolicy?: typeof loadAutomaticRemoteAiPolicy;
  loadConfig?: typeof loadAiConfigPreferencesSnapshot;
  getRun?: typeof getShiyingManualRun;
  getRecoveryState?: typeof getShiyingPickupRecoveryState;
  readActivity?: typeof readShiyingChatActivity;
  run?: typeof runAutomaticShiyingPickup;
  isChatBusy?: typeof isChatReplyInFlight;
  captureEpoch?: typeof captureBackupRestoreDataEpoch;
  canCommitEpoch?: typeof canCommitBackupRestoreDataEpoch;
  commitEpoch?: typeof runBackupRestoreDataEpochCommit;
  subscribe?: typeof subscribeShiyingAutomaticState;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
}) {
  const now = ports.now ?? Date.now;
  const loadState = ports.loadState ?? loadShiyingAutomaticState;
  const isChatBusy = ports.isChatBusy ?? isChatReplyInFlight;
  const captureEpoch = ports.captureEpoch ?? captureBackupRestoreDataEpoch;
  const canCommitEpoch = ports.canCommitEpoch ?? canCommitBackupRestoreDataEpoch;
  const commitEpoch = ports.commitEpoch ?? runBackupRestoreDataEpochCommit;
  const setTimer = ports.setTimer ?? setTimeout, clearTimer = ports.clearTimer ?? clearTimeout;
  let stopped = false, running = false;
  let timer: Timer | null = null;
  let emptySignature: string | null = null;

  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const active = () => !stopped && ports.isActive();
  const allowed = async (connection?: AiConnection, epoch = captureEpoch()) => {
    if (!active() || isChatBusy() || !canCommitEpoch(epoch)) return false;
    const policy = await (ports.loadPolicy ?? loadAutomaticRemoteAiPolicy)();
    if (!active() || !isAutomaticRemoteAiAllowed(policy, ports.screen())) return false;
    if (connection && getAutomaticCostRestriction({ policy, baseUrl: connection.baseUrl,
      now: now(), purpose: 'shiying-pickup' }).mode === 'wait') return false;
    const state = await loadState();
    return active() && !isChatBusy() && canCommitEpoch(epoch) && state.enabled;
  };

  async function check() {
    if (!active() || running) return;
    running = true;
    let nightLifeDate: string | null = null;
    let epoch: number | null = null;
    const block = (code: string) => commitEpoch(epoch, () => (
      (ports.blockNight ?? blockShiyingAutomaticNight)(nightLifeDate!, code, now())
    ));
    try {
      epoch = captureEpoch();
      const initial = await loadState();
      // Off means no chat reads, even on startup or repeated wakeups.
      if (!initial.enabled || initial.firstEnabledLifeDate === null || initial.scanFloorAt === null
        || initial.lastErrorCode !== null || !await allowed(undefined, epoch)) return;
      if ((await (ports.getRun ?? getShiyingManualRun)())?.lastErrorCode === SHIYING_RESTORE_PAUSED) return;
      const night = getShiyingAutomaticNight({ now: now(),
        template: await (ports.loadTemplate ?? loadDayTemplate)(),
        firstEnabledLifeDate: initial.firstEnabledLifeDate });
      if (!night) return;
      const begun = await commitEpoch(epoch, () => (
        (ports.beginNight ?? beginShiyingAutomaticNight)(night.nightLifeDate, now())
      ));
      if (!begun.committed) return;
      const state = begun.value;
      nightLifeDate = night.nightLifeDate;
      if (!state.enabled || state.nightLifeDate !== night.nightLifeDate || state.closed
        || state.lastErrorCode !== null || state.reservedCalls >= SHIYING_AUTOMATIC_CALL_LIMIT) return;
      if ((await (ports.getRecoveryState ?? getShiyingPickupRecoveryState)())?.kind === 'save_pending') return;
      const run = await (ports.getRun ?? getShiyingManualRun)();
      if (run && run.batchId !== state.batchId) return; // Never take over a manually frozen basket.
      if (run && (run.status === 'blocked' || run.chunks.some(chunk => chunk.status === 'in_flight'))) {
        await block(run.chunks.some(chunk => chunk.status === 'in_flight') ? 'interrupted_request'
          : run.lastErrorCode ?? 'unknown');
        return;
      }
      const config = resolveShiyingPickupModelConfig(await (ports.loadConfig ?? loadAiConfigPreferencesSnapshot)({ maxAgeMs: 0 }));
      if (!config || !await allowed(config.connection, epoch)) return;
      const activity = await (ports.readActivity ?? readShiyingChatActivity)();
      if (activity.latestDurableMessageAt === null
        || now() - activity.latestDurableMessageAt < night.idleMs) return;
      const signature = JSON.stringify([night.nightLifeDate, state.scanFloorAt, activity.signature]);
      if (!run && signature === emptySignature) return;
      const result = await (ports.run ?? runAutomaticShiyingPickup)({
        nightLifeDate: night.nightLifeDate, scanFloorAt: state.scanFloorAt!, batchId: state.batchId,
        canRequest: connection => allowed(connection, epoch),
      });
      if (result.kind === 'no_material') emptySignature = signature;
      if (result.kind === 'blocked' || result.kind === 'failed' || result.kind === 'save_pending') {
        await block(result.code);
      }
    } catch {
      // No bodies, no automatic retries of corrupt material or uncertain local failures.
      if (nightLifeDate !== null) {
        try { await block('local_read_failed'); }
        catch { /* Leave the existing run untouched; a later read can report it. */ }
      }
    } finally {
      running = false;
      if (active()) schedule(CHECK_INTERVAL_MS);
    }
  }
  function schedule(delay: number) {
    if (!active()) return;
    clear();
    timer = setTimer(() => { timer = null; void check(); }, delay);
  }
  function wake() { if (active() && !running) schedule(0); }
  const unsubscribe = (ports.subscribe ?? subscribeShiyingAutomaticState)(wake);
  return { wake, check, pause: clear, stop: () => { stopped = true; clear(); unsubscribe(); } };
}
