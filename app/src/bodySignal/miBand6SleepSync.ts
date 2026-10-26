import { getMiBand6SleepConnection, readMiBand6SleepHistory } from './miBand6SleepInspection';
import { buildMiBand6SleepBatch } from './miBand6SleepPolicy';
import { loadMiBand6SleepHistory, saveMiBand6SleepBatch } from './miBand6SleepStore';
import type { MiBand6SleepBatch } from './miBand6SleepTypes';

const AUTO_INTERVAL = 30 * 60_000;
const ATTEMPT_INTERVAL = 10_000;
type SyncState = { deviceProfileId?: string; busy: boolean; error?: string };
let state: SyncState = { busy: false };
let pending: { controller: AbortController; task: Promise<MiBand6SleepBatch | undefined> } | undefined;
let lastAttempt: { key: string; at: number } | undefined;
const listeners = new Set<() => void>();
export function getMiBand6SleepSyncState(): SyncState { return { ...state }; }
export function subscribeMiBand6SleepSync(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function emit() { for (const listener of listeners) { try { listener(); } catch { /* A view cannot undo saved records. */ } } }
export function cancelMiBand6SleepSync(): void { pending?.controller.abort(); }

export function syncMiBand6SleepHistory(trigger: 'manual' | 'automatic' = 'manual', deviceProfileId?: string): Promise<MiBand6SleepBatch | undefined> {
  if (pending) return pending.task;
  const controller = new AbortController();
  const active = () => { if (controller.signal.aborted) throw new Error('sleep_cancelled'); };
  const run = async () => {
    active();
    const target = await getMiBand6SleepConnection();
    if (deviceProfileId && target.deviceProfileId !== deviceProfileId) throw new Error('activity_disconnected');
    active();
    const now = Date.now();
    if (new Date(now).getTimezoneOffset() !== -480) throw new Error('sleep_timezone_unsupported');
    if (lastAttempt?.key === target.connectionKey && now - lastAttempt.at < ATTEMPT_INTERVAL) {
      if (trigger === 'automatic') return undefined;
      throw new Error('sleep_cooldown');
    }
    if (trigger === 'automatic') {
      const history = await loadMiBand6SleepHistory(target.deviceProfileId, now);
      active();
      if (history.lastBatch && now - history.lastBatch.observedAt < AUTO_INTERVAL) return undefined;
    }
    lastAttempt = { key: target.connectionKey, at: now };
    state = { deviceProfileId: target.deviceProfileId, busy: true }; emit();
    const read = await readMiBand6SleepHistory({ window: 'recent7days', deviceProfileId: target.deviceProfileId, signal: controller.signal });
    active();
    if (read.connectionKey !== target.connectionKey) throw new Error('activity_disconnected');
    const batch = buildMiBand6SleepBatch(read, Date.now());
    const after = await getMiBand6SleepConnection();
    active();
    if (after.connectionKey !== target.connectionKey) throw new Error('activity_disconnected');
    // Session updates, seven-day cleanup and the sleep-only cursor commit together.
    await saveMiBand6SleepBatch(batch, Date.now(), controller.signal);
    state = { deviceProfileId: target.deviceProfileId, busy: false }; emit();
    return batch;
  };
  const task = run().catch((error: unknown) => {
    const code = error instanceof Error && /^(sleep|activity)_\w+$/.test(error.message) ? error.message : 'sleep_sync_failed';
    state = { ...state, busy: false, ...(trigger === 'manual' || state.busy ? { error: code } : {}) };
    emit();
    throw error;
  }).finally(() => { if (pending?.task === task) pending = undefined; });
  pending = { controller, task };
  return task;
}

export function miBand6SleepSyncError(code: string): string {
  if (code === 'sleep_timezone_unsupported') return '当前睡眠规则仅完成了东八区验证，暂不计算其他时区。';
  if (code === 'sleep_update_required') return '当前安装包需要更新后才能同步睡眠记录。';
  if (['activity_not_ready', 'activity_profile_missing', 'sleep_inspection_not_ready'].includes(code)) return '请等待这台手环连接并完成认证。';
  if (['activity_busy', 'sleep_inspection_busy', 'sleep_heart_rate_due', 'sleep_inspection_heart_rate_due'].includes(code)) return '手环通道或心率采样正在使用，稍后会再同步。';
  if (['sleep_paused', 'sleep_inspection_paused'].includes(code)) return '守候或采样已暂停，本次没有读取手环。';
  if (['sleep_cooldown', 'sleep_inspection_cooldown'].includes(code)) return '刚刚尝试过，请稍后再同步。';
  if (['sleep_cancelled', 'activity_cancelled', 'activity_disconnected'].includes(code)) return '本次同步已结束，未完成的记录没有保存。';
  return '睡眠同步暂未完成，已保存的记录仍可查看。';
}
