export type FocusTimerExecutionIdentity = {
  sessionId: string;
  startedAt: number;
};

export type FocusTimerExecutionOnceResult = {
  completedAt: number;
  executedNow: boolean;
  outcome: 'completed';
};

export type FocusTimerExecutionOncePorts = {
  applyReceipt(outcome: 'completed', completedAt: number): Promise<void>;
  executeLocally(): Promise<'completed'>;
  reconcileLocally(): Promise<'completed' | null>;
};

const finishing = new Map<string, Promise<FocusTimerExecutionOnceResult>>();

// Stopping this phone's timer is a local action. History uses the existing stable
// session identity and sync capture; a relay lease must not prevent local stop.
export async function runFocusTimerExecutionOnce(
  identity: FocusTimerExecutionIdentity,
  ports: FocusTimerExecutionOncePorts,
): Promise<FocusTimerExecutionOnceResult> {
  const key = JSON.stringify([identity.sessionId, identity.startedAt]);
  const active = finishing.get(key);
  if (active) return { ...await active, executedNow: false };
  const run = (async () => {
    const existing = await ports.reconcileLocally();
    const outcome = existing ?? await ports.executeLocally();
    const completedAt = Date.now();
    await ports.applyReceipt(outcome, completedAt);
    return { outcome, completedAt, executedNow: existing === null };
  })();
  finishing.set(key, run);
  try { return await run; }
  finally { if (finishing.get(key) === run) finishing.delete(key); }
}
