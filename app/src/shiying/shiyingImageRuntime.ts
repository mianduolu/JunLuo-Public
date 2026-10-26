import { prepareShiyingRecordImages, subscribeShiyingImageNotes } from './shiyingImageCoordinator';

const CONTINUE_DELAY_MS = 30_000;
type Timer = ReturnType<typeof setTimeout>;

/** Woken after local finalization, never by adding a picture or opening its note panel. */
export function createShiyingImageRuntime(ports: {
  isActive: () => boolean;
  canRequest: () => boolean | Promise<boolean>;
  run?: typeof prepareShiyingRecordImages;
  setTimer?: (callback: () => void, delay: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  subscribe?: typeof subscribeShiyingImageNotes;
}) {
  const run = ports.run ?? prepareShiyingRecordImages;
  const setTimer = ports.setTimer ?? setTimeout;
  const clearTimer = ports.clearTimer ?? clearTimeout;
  let stopped = false, running = false, queued = false;
  let timer: Timer | null = null;
  const clear = () => { if (timer !== null) clearTimer(timer); timer = null; };
  const allowed = async () => {
    if (stopped || !ports.isActive()) return false;
    const permitted = await ports.canRequest();
    return !stopped && ports.isActive() && permitted;
  };
  function schedule(delay: number) {
    if (stopped || !ports.isActive()) return;
    clear();
    timer = setTimer(() => { timer = null; void check(); }, delay);
  }
  async function check() {
    if (stopped || !ports.isActive()) return;
    if (running) { queued = true; return; }
    running = true;
    let continueLater = false, failed = false;
    try {
      if (!await allowed()) { continueLater = true; return; }
      const result = await run({ automatic: true, canRequest: allowed });
      failed = result.kind === 'blocked' || result.kind === 'failed' || result.kind === 'save_pending'
        || result.kind === 'retry_confirmation_required';
      continueLater = result.kind === 'progress' || result.kind === 'busy' || result.kind === 'config_missing';
    } catch {
      // Unexpected local failures also stop; no blind paid retry loop.
      failed = true;
    } finally {
      running = false;
      const wakeAgain = queued; queued = false;
      if (!failed && (continueLater || wakeAgain)) schedule(CONTINUE_DELAY_MS);
    }
  }
  function wake() {
    if (stopped || !ports.isActive()) return;
    if (running) queued = true;
    else if (timer === null) schedule(0);
  }
  const unsubscribe = (ports.subscribe ?? subscribeShiyingImageNotes)(workAvailable => {
    if (workAvailable) wake(); // Explicit retry/skip can unblock remaining normal work.
  });
  return { wake, stop: () => { stopped = true; queued = false; clear(); unsubscribe(); } };
}
