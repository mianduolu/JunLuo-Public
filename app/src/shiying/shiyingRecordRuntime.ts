import { AppState } from 'react-native';
import { shiyingRecordCoordinator } from './shiyingRecordCoordinator';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

/** Local finalization only; an optional non-blocking hook wakes the separate image worker. */
export function startShiyingRecordRuntime(options: { onSettled?: () => void } = {}) {
  let stopped = false, running = false, queued = false, queuedCatchUp = false;
  let restoreGeneration = 0, settledRestoreGeneration = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const clear = () => { if (timer) clearTimeout(timer); timer = null; };
  async function check(catchUp = false) {
    if (stopped || AppState.currentState !== 'active') return;
    if (running) { queued = true; queuedCatchUp ||= catchUp; return; }
    running = true; clear();
    const generation = restoreGeneration;
    const restoreCatchUp = generation !== settledRestoreGeneration;
    try {
      const settled = await shiyingRecordCoordinator.settle({ notifyFinalized: !restoreCatchUp });
      settledRestoreGeneration = generation;
      if (!stopped && generation === restoreGeneration && !restoreCatchUp && (catchUp || settled.finalizedIds.length)) options.onSettled?.();
      const at = await shiyingRecordCoordinator.nextDeadline();
      if (!stopped && AppState.currentState === 'active' && at !== null) {
        timer = setTimeout(() => { timer = null; void check(); }, Math.min(2_147_483_647, Math.max(1, at - Date.now())));
      }
    } catch {
      // Retry at a later foreground/page opportunity; never report successful finalization.
    } finally {
      running = false;
      if (queued && !stopped) {
        const catchUpAgain = queuedCatchUp; queued = false; queuedCatchUp = false;
        void check(catchUpAgain);
      }
    }
  }
  const unsubscribe = shiyingRecordCoordinator.subscribe(change => { void check(change === 'finalized'); });
  const releaseBackup = registerShiyingBackupParticipant({ invalidate: () => {
    restoreGeneration++; clear(); queued = false; queuedCatchUp = false;
  } });
  const appState = AppState.addEventListener('change', state => {
    if (state === 'active') void check(true); else clear();
  });
  void check(true);
  return () => { stopped = true; clear(); unsubscribe(); releaseBackup(); appState.remove(); };
}
