export type CoalescedSingleFlightTask = {
  isRunning: () => boolean;
  run: () => Promise<void>;
};

export type SerialRuntimeQueue = {
  enqueue: <T>(task: () => Promise<T>) => Promise<T>;
};

export function createSerialRuntimeQueue(): SerialRuntimeQueue {
  let tail: Promise<void> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>) => {
    const result = tail.then(task, task);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };

  return { enqueue };
}

export function createCoalescedSingleFlightTask(
  task: () => Promise<void>,
): CoalescedSingleFlightTask {
  let running: Promise<void> | null = null;
  let rerunRequested = false;

  const run = () => {
    if (running) {
      rerunRequested = true;
      return running;
    }

    const current = (async () => {
      do {
        rerunRequested = false;
        await task();
      } while (rerunRequested);
    })().finally(() => {
      if (running === current) running = null;
    });
    running = current;
    return current;
  };

  return {
    isRunning: () => running !== null,
    run,
  };
}

export const MAX_RUNTIME_TIMER_DELAY_MS = 2_147_483_647;

export function getRuntimeTimerDelay(triggerAt: number, now = Date.now()) {
  if (!Number.isFinite(triggerAt)) return null;
  return Math.min(
    MAX_RUNTIME_TIMER_DELAY_MS,
    Math.max(0, Math.floor(triggerAt - now)),
  );
}
