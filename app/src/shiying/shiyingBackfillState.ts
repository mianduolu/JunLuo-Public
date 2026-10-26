/** Process execution only. It does not resume a persisted task on app startup. */
let executing = false;
const listeners = new Set<() => void>();
export function isShiyingBackfillExecuting() { return executing; }
export function setShiyingBackfillExecuting(value: boolean) {
  if (executing === value) return;
  executing = value;
  for (const listener of listeners) { try { listener(); } catch { /* Observer only. */ } }
}
export function subscribeShiyingBackfillExecution(listener: () => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
