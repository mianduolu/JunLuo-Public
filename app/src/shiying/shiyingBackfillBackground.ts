import { AppState, NativeEventEmitter, NativeModules, Platform } from 'react-native';
import { registerShiyingBackupParticipant } from './shiyingBackupRuntime';

export const SHIYING_BACKFILL_BACKGROUND_LIMIT_MS = 6 * 60 * 60_000;
const END_EVENT = 'JunLuoShiyingBackfillBackgroundEnd';
type EndReason = 'stopped' | 'time_limit' | 'system_timeout' | 'destroyed' | 'headless_finished' | 'start_failed';
export type ShiyingBackfillBackgroundEnd = { taskId: string; reason: EndReason };
export type ShiyingBackfillBackgroundStart =
  | { started: true; hostToken: string }
  | { started: false; code: string };
type NativeHost = {
  start(taskId: string, hostToken: string, completedDays: number, totalDays: number): Promise<boolean>;
  update(taskId: string, hostToken: string, completedDays: number, totalDays: number): Promise<boolean>;
  stop(taskId: string, hostToken: string): Promise<boolean>;
};
type Owner = {
  taskId: string;
  hostToken: string;
  started: boolean;
  done: Promise<void>;
  finish: () => void;
  timer: ReturnType<typeof setTimeout> | null;
  start: Promise<ShiyingBackfillBackgroundStart>;
};
const listeners = new Set<(event: ShiyingBackfillBackgroundEnd) => void>();
let owner: Owner | null = null;
let sequence = 0;
let nativeSubscription: { remove(): void } | null = null;

function nativeHost(): NativeHost | undefined {
  const host = Platform.OS === 'android' ? NativeModules.JunLuoShiyingBackfillBackground : undefined;
  return host?.start && host?.update && host?.stop ? host as NativeHost : undefined;
}

function finish(expected: Owner, reason: EndReason, publish: boolean) {
  if (owner !== expected) return;
  owner = null;
  if (expected.timer !== null) clearTimeout(expected.timer);
  expected.finish();
  if (publish) for (const listener of listeners) {
    try { listener({ taskId: expected.taskId, reason }); } catch { /* Host cleanup must still finish. */ }
  }
}

function ensureNativeListener(host: NativeHost) {
  if (nativeSubscription) return;
  nativeSubscription = new NativeEventEmitter(host as never).addListener(END_EVENT, (payload: unknown) => {
    if (!payload || typeof payload !== 'object') return;
    const event = payload as { taskId?: unknown; hostToken?: unknown; reason?: unknown };
    const current = owner;
    if (!current || event.taskId !== current.taskId || event.hostToken !== current.hostToken) return;
    const known: EndReason[] = ['stopped', 'time_limit', 'system_timeout', 'destroyed', 'headless_finished', 'start_failed'];
    const reason = known.includes(event.reason as EndReason) ? event.reason as EndReason : 'destroyed';
    finish(current, reason, true);
  });
}

export function hasActiveShiyingBackfillBackground(taskId?: string) {
  return Boolean(owner?.started && (!taskId || owner.taskId === taskId));
}

export function subscribeShiyingBackfillBackgroundEnd(listener: (event: ShiyingBackfillBackgroundEnd) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function startShiyingBackfillBackground(
  taskId: string, completedDays: number, totalDays: number,
): Promise<ShiyingBackfillBackgroundStart> {
  if (owner) return owner.taskId === taskId ? owner.start : Promise.resolve({ started: false, code: 'BACKFILL_HOST_BUSY' });
  if (!taskId.trim() || taskId.length > 96 || !Number.isSafeInteger(totalDays) || totalDays < 1 || totalDays > 31 ||
      !Number.isSafeInteger(completedDays) || completedDays < 0 || completedDays > totalDays) {
    return Promise.resolve({ started: false, code: 'BACKFILL_HOST_INPUT_INVALID' });
  }
  const host = nativeHost();
  if (!host) return Promise.resolve({ started: false, code: 'BACKFILL_HOST_UNAVAILABLE' });
  if (AppState.currentState !== 'active') return Promise.resolve({ started: false, code: 'BACKFILL_HOST_START_REQUIRES_FOREGROUND' });
  try { ensureNativeListener(host); }
  catch { return Promise.resolve({ started: false, code: 'BACKFILL_HOST_UNAVAILABLE' }); }
  let resolve!: () => void;
  const current: Owner = {
    taskId, hostToken: `shiying-backfill-${Date.now()}-${++sequence}`, started: false,
    done: new Promise<void>(accept => { resolve = accept; }), finish: () => resolve(), timer: null,
    start: Promise.resolve({ started: false, code: 'BACKFILL_HOST_START_DENIED' }),
  };
  owner = current;
  current.start = (async (): Promise<ShiyingBackfillBackgroundStart> => {
    try {
      const started = await host.start(taskId, current.hostToken, completedDays, totalDays);
      if (!started || owner !== current) {
        finish(current, 'start_failed', false);
        // The accepted native start may arrive after its JS owner was stopped.
        if (started) await host.stop(taskId, current.hostToken).catch(() => undefined);
        return { started: false, code: 'BACKFILL_HOST_START_DENIED' };
      }
      current.started = true;
      current.timer = setTimeout(() => {
        finish(current, 'time_limit', true);
        void host.stop(taskId, current.hostToken).catch(() => undefined);
      }, SHIYING_BACKFILL_BACKGROUND_LIMIT_MS);
      return { started: true, hostToken: current.hostToken };
    } catch {
      finish(current, 'start_failed', false);
      return { started: false, code: 'BACKFILL_HOST_START_DENIED' };
    }
  })();
  return current.start;
}

export async function updateShiyingBackfillBackground(taskId: string, completedDays: number, totalDays: number) {
  const current = owner;
  const host = nativeHost();
  if (!current?.started || current.taskId !== taskId || !host || !Number.isSafeInteger(totalDays) ||
      totalDays < 1 || totalDays > 31 || !Number.isSafeInteger(completedDays) || completedDays < 0 || completedDays > totalDays) return false;
  try { return await host.update(taskId, current.hostToken, completedDays, totalDays); }
  catch { return false; }
}

export async function stopShiyingBackfillBackground(taskId: string, expectedHostToken?: string) {
  const current = owner;
  const host = nativeHost();
  if (!current || current.taskId !== taskId || (expectedHostToken && current.hostToken !== expectedHostToken)) return false;
  finish(current, 'stopped', false);
  try { return Boolean(await host?.stop(taskId, current.hostToken)); }
  catch { return false; }
}

// Holding an existing in-memory owner never creates or resumes a persisted job.
// Cold invocation therefore resolves immediately and cannot spend an API call.
export async function holdShiyingBackfillBackgroundTask(payload: { taskId?: unknown; hostToken?: unknown } | null) {
  const current = owner;
  if (current && payload?.taskId === current.taskId && payload.hostToken === current.hostToken) await current.done;
}

registerShiyingBackupParticipant({ invalidate: () => {
  const current = owner;
  if (!current) return;
  finish(current, 'stopped', false);
  void nativeHost()?.stop(current.taskId, current.hostToken).catch(() => undefined);
} });
