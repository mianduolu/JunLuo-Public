import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import {
  captureBackupRestoreDataEpoch,
  canCommitBackupRestoreDataEpoch,
  subscribeBackupRestoreRuntimeState,
} from '../backup/backupRestoreCoordinator';
import { createShiyingBatchNotificationId } from '../schedule/localNotificationIdentity';
import {
  establishShiyingNotificationReceiptBaseline,
  hasShiyingPendingBatch,
  listShiyingNotificationBatches,
  subscribeShiyingEntryChanges,
  hasShiyingPendingEntryIds,
} from './shiyingStore';
import { getShiyingBackfillTask, claimShiyingBackfillCompletion, deleteShiyingBackfillTask } from './shiyingBackfillStore';
import {
  isShiyingNotificationDomain,
  isShiyingNotificationFeatureVisible,
  isShiyingNotificationPayload,
  setShiyingNotificationPolicyFeatureVisible,
  SHIYING_NOTIFICATION_BODY,
  SHIYING_NOTIFICATION_CHANNEL,
  SHIYING_NOTIFICATION_TITLE,
  type ShiyingNotificationPayload,
  createShiyingBackfillNotificationId,
} from './shiyingNotificationPolicy';

export const SHIYING_NOTIFICATION_SETTINGS_KEY = 'junluo.shiying.notifications.local.v1';
type LocalState = {
  version: 2;
  enabled: boolean;
  handledThroughReceiptRowId: number | null;
  needsRebase: boolean;
  enabledAfterReceiptRowId: number | null;
};
export type ShiyingNotificationSettings = LocalState & { permissionGranted: boolean };

const emptyState = (): LocalState => ({
  version: 2, enabled: false, handledThroughReceiptRowId: null, needsRebase: false, enabledAfterReceiptRowId: null,
});
let serial = Promise.resolve();
let generation = 0;
let settingsGeneration = 0;
const listeners = new Set<() => void>();

function fail(code: string): never { throw new Error(`shiying_notification_${code}`); }
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = serial.then(work).catch(error => {
    if (error instanceof Error && /^shiying_notification_[a-z_]+$/u.test(error.message)) throw error;
    return fail('operation_failed');
  });
  serial = result.then(() => undefined, () => undefined);
  return result;
}
function changed() {
  for (const listener of listeners) {
    try { listener(); } catch { /* UI observers cannot undo a local write. */ }
  }
}
function cursor(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) fail('cursor_invalid');
  return value;
}
async function readState(): Promise<LocalState> {
  const epoch = captureBackupRestoreDataEpoch();
  const raw = await AsyncStorage.getItem(SHIYING_NOTIFICATION_SETTINGS_KEY);
  if (raw === null) return emptyState();
  let state: LocalState;
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw); } catch { return fail('state_invalid'); }
  const migrating = parsed?.version === 1 && Object.keys(parsed).sort().join(',') === 'enabled,handledThroughReceiptRowId,needsRebase,version';
  if (migrating) {
    // No backfill existed in V1. Keep live's cursor, establish a separate enable boundary.
    const baseline = await establishShiyingNotificationReceiptBaseline(value => Promise.resolve(value));
    parsed = { ...parsed, version: 2, enabledAfterReceiptRowId: baseline };
  }
  state = parsed as unknown as LocalState;
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).sort().join(',') !== 'enabled,enabledAfterReceiptRowId,handledThroughReceiptRowId,needsRebase,version'
    || state.version !== 2 || typeof state.enabled !== 'boolean' || typeof state.needsRebase !== 'boolean'
    || state.enabledAfterReceiptRowId !== null && (!Number.isSafeInteger(state.enabledAfterReceiptRowId) || state.enabledAfterReceiptRowId < 0)
    || state.handledThroughReceiptRowId !== null
      && (!Number.isSafeInteger(state.handledThroughReceiptRowId) || state.handledThroughReceiptRowId < 0)) {
    return fail('state_invalid');
  }
  if (migrating && canCommitBackupRestoreDataEpoch(epoch)) {
    if (!await writeState(state, epoch)) fail('stale');
  }
  return state;
}
async function writeState(state: LocalState, epoch: number | null, stillCurrent: () => boolean = () => true) {
  const valid = () => canCommitBackupRestoreDataEpoch(epoch) && stillCurrent();
  if (!valid()) return false;
  // This device-only key is excluded from restored business data. Its sole writer is this queue;
  // restore invalidates old work immediately and queues its rebase after any already-started write.
  // Joining the global shared queue here would deadlock against restore awaiting this domain queue.
  await AsyncStorage.setItem(SHIYING_NOTIFICATION_SETTINGS_KEY, JSON.stringify(state));
  if (!valid()) return false;
  changed();
  return true;
}
async function rebase(state: LocalState, epoch: number | null): Promise<LocalState | null> {
  if (!state.needsRebase) return state;
  if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
  return establishShiyingNotificationReceiptBaseline(async baseline => {
    const next = { ...state, handledThroughReceiptRowId: cursor(baseline), enabledAfterReceiptRowId: cursor(baseline), needsRebase: false };
    return await writeState(next, epoch) ? next : null;
  });
}
function featureIsForeground() {
  return AppState.currentState === 'active' && isShiyingNotificationFeatureVisible();
}
async function initializeQuietChannel() {
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(SHIYING_NOTIFICATION_CHANNEL, {
    name: '拾荧', importance: Notifications.AndroidImportance.LOW, sound: null, enableVibrate: false,
  });
}
async function dismissOwnNotifications(batchId?: string) {
  const [presented, scheduled] = await Promise.all([
    Notifications.getPresentedNotificationsAsync(), Notifications.getAllScheduledNotificationsAsync(),
  ]);
  const target = (data: unknown) => isShiyingNotificationDomain(data)
    && (batchId === undefined || isShiyingNotificationPayload(data) && data.batchId === batchId);
  for (const item of scheduled) if (target(item.content.data)) {
    await Notifications.cancelScheduledNotificationAsync(item.identifier);
  }
  for (const item of presented) if (target(item.request.content.data)) {
    await Notifications.dismissNotificationAsync(item.request.identifier);
  }
}

export function subscribeShiyingNotificationSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function setShiyingNotificationFeatureVisible(visible: boolean) {
  if (visible === isShiyingNotificationFeatureVisible()) return;
  generation += 1;
  setShiyingNotificationPolicyFeatureVisible(visible);
}

export function getShiyingNotificationSettings(): Promise<ShiyingNotificationSettings> {
  const epoch = captureBackupRestoreDataEpoch();
  return enqueue(async () => {
    const state = await readState();
    const current = await rebase(state, epoch) ?? state;
    const permission = await Notifications.getPermissionsAsync();
    return { ...current, permissionGranted: permission.granted };
  });
}

export function setShiyingNotificationsEnabled(enabled: boolean): Promise<ShiyingNotificationSettings> {
  if (typeof enabled !== 'boolean') return Promise.reject(new Error('shiying_notification_boolean_invalid'));
  const epoch = captureBackupRestoreDataEpoch();
  generation += 1;
  const requestGeneration = ++settingsGeneration;
  return enqueue(async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) return fail('stale');
    const state = await readState();
    if (!enabled) {
      const next = { ...state, enabled: false };
      if (!(await writeState(next, epoch, () => requestGeneration === settingsGeneration))) return fail('stale');
      await dismissOwnNotifications();
      const permission = await Notifications.getPermissionsAsync().catch(() => ({ granted: false }));
      return { ...next, permissionGranted: permission.granted };
    }
    // Android 13's permission dialog requires a channel to exist first.
    await initializeQuietChannel();
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain !== false) permission = await Notifications.requestPermissionsAsync();
    if (requestGeneration !== settingsGeneration || !canCommitBackupRestoreDataEpoch(epoch)) return fail('stale');
    const next = await establishShiyingNotificationReceiptBaseline(async baseline => {
      const updated: LocalState = { ...state, enabled: permission.granted,
        handledThroughReceiptRowId: cursor(baseline), enabledAfterReceiptRowId: cursor(baseline), needsRebase: false };
      if (!(await writeState(updated, epoch, () => requestGeneration === settingsGeneration))) return fail('stale');
      return updated;
    });
    if (!next.enabled) await dismissOwnNotifications();
    return { ...next, permissionGranted: permission.granted };
  });
}

export function dismissShiyingBatchNotification(batchId: string): Promise<void> {
  return enqueue(() => dismissOwnNotifications(batchId));
}

/** One local attempt per committed batch, with no model work or additional timer. */
export function flushShiyingNotifications(): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  const flushGeneration = generation;
  return enqueue(async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch) || flushGeneration !== generation) return;
    let state = await rebase(await readState(), epoch);
    if (!state || !canCommitBackupRestoreDataEpoch(epoch)) return;
    if (!state.enabled) {
      await dismissOwnNotifications();
      const task = await getShiyingBackfillTask();
      if (task?.status === 'completed') await flushBackfillCompletionInQueue(task.id, epoch);
      return;
    }
    const presented = await Notifications.getPresentedNotificationsAsync();
    for (const item of presented) {
      const data = item.request.content.data;
      if (!isShiyingNotificationPayload(data)) continue;
      if (!canCommitBackupRestoreDataEpoch(epoch) || flushGeneration !== generation) return;
      if (!(await (data.payloadVersion === 2 ? hasShiyingPendingEntryIds(data.entryIds) : hasShiyingPendingBatch(data.batchId)))) {
        await Notifications.dismissNotificationAsync(item.request.identifier);
      }
    }
    if (state.handledThroughReceiptRowId === null) {
      state = await establishShiyingNotificationReceiptBaseline(async baseline => {
        const next = { ...state!, handledThroughReceiptRowId: cursor(baseline) };
        return await writeState(next, epoch) ? next : null;
      });
      if (!state) return;
    }
    await initializeQuietChannel();
    while (canCommitBackupRestoreDataEpoch(epoch) && flushGeneration === generation) {
      const batches = await listShiyingNotificationBatches(state.handledThroughReceiptRowId!, 30);
      if (!batches.length) {
        const task = await getShiyingBackfillTask();
        if (task?.status === 'completed') await flushBackfillCompletionInQueue(task.id, epoch);
        return;
      }
      for (const batch of batches) {
        if (!canCommitBackupRestoreDataEpoch(epoch) || flushGeneration !== generation) return;
        const rowId = cursor(batch.receiptRowId);
        if (rowId <= state.handledThroughReceiptRowId!) return fail('cursor_not_forward');
        const data: ShiyingNotificationPayload = { kind: 'shiying', payloadVersion: 1,
          batchId: batch.batchId, operationId: createShiyingBatchNotificationId(batch.batchId) };
        if (!isShiyingNotificationPayload(data)) return fail('payload_invalid');
        // Claim before the OS boundary. A failed/unknown delivery is never republished after restart.
        state = { ...state, handledThroughReceiptRowId: rowId };
        if (!(await writeState(state, epoch, () => flushGeneration === generation))) return;
        if (!batch.hasPendingEntries || featureIsForeground()) continue;
        const permission = await Notifications.getPermissionsAsync();
        if (!permission.granted || !canCommitBackupRestoreDataEpoch(epoch)
          || flushGeneration !== generation || featureIsForeground()) continue;
        if (!(await hasShiyingPendingBatch(batch.batchId))) continue;
        if (!canCommitBackupRestoreDataEpoch(epoch) || flushGeneration !== generation || featureIsForeground()) return;
        const identifier = await Notifications.scheduleNotificationAsync({
          identifier: data.operationId,
          content: { title: SHIYING_NOTIFICATION_TITLE, body: SHIYING_NOTIFICATION_BODY, data,
            sound: false, vibrate: [], autoDismiss: true, priority: Notifications.AndroidNotificationPriority.LOW },
          trigger: Platform.OS === 'android' ? { channelId: SHIYING_NOTIFICATION_CHANNEL } : null,
        });
        // No epoch commit after an OS call: restore can be waiting for this domain queue to drain.
        if (!canCommitBackupRestoreDataEpoch(epoch) || flushGeneration !== generation || featureIsForeground()) {
          await Notifications.dismissNotificationAsync(identifier);
          return;
        }
        if (!(await hasShiyingPendingBatch(batch.batchId)) || !canCommitBackupRestoreDataEpoch(epoch)
          || flushGeneration !== generation || featureIsForeground()) {
          await Notifications.dismissNotificationAsync(identifier);
          if (!canCommitBackupRestoreDataEpoch(epoch) || flushGeneration !== generation) return;
        }
      }
    }
  });
}

/** The caller already owns restore's exclusive window; do not re-enter its shared commit queue. */
export function resetShiyingNotificationsAfterRestore(): Promise<void> {
  generation += 1;
  settingsGeneration += 1;
  return enqueue(async () => {
    let state: LocalState;
    try { state = await readState(); } catch (error) {
      if (!(error instanceof Error) || error.message !== 'shiying_notification_state_invalid') throw error;
      // A corrupt, excluded device projection must not block restoration of real business data.
      state = emptyState();
    }
    await AsyncStorage.setItem(SHIYING_NOTIFICATION_SETTINGS_KEY,
      JSON.stringify({ ...state, handledThroughReceiptRowId: null, enabledAfterReceiptRowId: null, needsRebase: true }));
    changed();
    await dismissOwnNotifications();
  });
}

async function flushBackfillCompletionInQueue(taskId: string, epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) return;
  const state = await rebase(await readState(), epoch);
  if (!state || epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) return;
  const claimed = await claimShiyingBackfillCompletion(taskId, epoch);
  if (!claimed) {
    const task = await getShiyingBackfillTask();
    if (task?.id === taskId && task.status === 'completed' && task.notificationClaimed)
      await deleteShiyingBackfillTask(taskId, epoch);
    return;
  }
  const requestGeneration = settingsGeneration;
  try {
    const eligibleDays = claimed.task.days.filter(day => day.receiptRowId > (state.enabledAfterReceiptRowId ?? Number.MAX_SAFE_INTEGER));
    const entryIds = eligibleDays.flatMap(day => day.entryIds);
    const representative = eligibleDays.find(day => day.batchId && day.entryIds.length);
    if (!state.enabled || !representative?.batchId || !entryIds.length || featureIsForeground()
      || !await hasShiyingPendingEntryIds(entryIds) || !canCommitBackupRestoreDataEpoch(epoch)) return;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted || featureIsForeground() || requestGeneration !== settingsGeneration || !canCommitBackupRestoreDataEpoch(epoch)) return;
    await initializeQuietChannel();
    if (!canCommitBackupRestoreDataEpoch(epoch) || requestGeneration !== settingsGeneration || featureIsForeground()) return;
    const data: ShiyingNotificationPayload = { kind: 'shiying', payloadVersion: 2, taskId,
      batchId: representative.batchId, operationId: createShiyingBackfillNotificationId(taskId), entryIds };
    if (!isShiyingNotificationPayload(data)) fail('payload_invalid');
    const identifier = await Notifications.scheduleNotificationAsync({ identifier: data.operationId,
      content: { title: SHIYING_NOTIFICATION_TITLE, body: SHIYING_NOTIFICATION_BODY, data,
        sound: false, vibrate: [], autoDismiss: true, priority: Notifications.AndroidNotificationPriority.LOW },
      trigger: Platform.OS === 'android' ? { channelId: SHIYING_NOTIFICATION_CHANNEL } : null });
    if (!canCommitBackupRestoreDataEpoch(epoch) || requestGeneration !== settingsGeneration || featureIsForeground()
      || !await hasShiyingPendingEntryIds(entryIds)) await Notifications.dismissNotificationAsync(identifier);
  } finally {
    // Only terminal local metadata is removed; receipts and diaries remain untouched.
    if (canCommitBackupRestoreDataEpoch(epoch)) await deleteShiyingBackfillTask(taskId, epoch);
  }
}
export function flushShiyingBackfillCompletion(taskId: string) {
  const epoch = captureBackupRestoreDataEpoch();
  return enqueue(() => flushBackfillCompletionInQueue(taskId, epoch));
}

export function observeShiyingNotifications(): () => void {
  const resume = () => { void flushShiyingNotifications().catch(() => { console.warn('shiying_notification_deferred'); }); };
  const stopEntries = subscribeShiyingEntryChanges(resume);
  const foreground = AppState.addEventListener('change', state => { if (state === 'active') resume(); });
  const stopRestore = subscribeBackupRestoreRuntimeState(state => { if (state.status === 'ready') resume(); });
  resume();
  return () => { stopEntries(); foreground.remove(); stopRestore(); };
}
