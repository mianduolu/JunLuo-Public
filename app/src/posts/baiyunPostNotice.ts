import AsyncStorage from '@react-native-async-storage/async-storage';
import { DeviceEventEmitter } from 'react-native';
import { getMemoryDatabase } from '../memory/memoryStore';
import { captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';

export type PostNoticeTarget = { postId: string; commentSource: string | null; createdAt: number; requestId?: string };
type ReadState = { since: number; seen: string[] };
const READ_KEY = 'junluo.posts.heartRead.v1';
const READ_CHANGED = 'junluo.posts.heartRead.changed';
let writes = Promise.resolve();
let requested: PostNoticeTarget | null = null;
const openListeners = new Set<() => void>();
let openSequence = 0;

// A logical comment keeps this key when “修修” replaces its physical storage row.
export function postNoticeKey(postId: string, commentSource: string | null = null) {
  return JSON.stringify([postId, commentSource]);
}

async function readState(now: number): Promise<ReadState> {
  const raw = await AsyncStorage.getItem(READ_KEY);
  if (raw !== null) {
    const value = JSON.parse(raw) as ReadState;
    if (!Number.isFinite(value.since) || !Array.isArray(value.seen) || value.seen.some(key => typeof key !== 'string')) {
      throw new Error('post-notice-read-state-invalid');
    }
    return value;
  }
  const previous = await AsyncStorage.getItem('junluo.memory.baiyunHeartViewedThroughId');
  const state = { since: now - 24 * 60 * 60 * 1000, seen: previous ? [postNoticeKey(previous)] : [] };
  await (await import('../sync/syncMemoryExperienceStorageBridge')).memoryExperienceStorageBridge.setItem(READ_KEY, JSON.stringify(state));
  return state;
}

function withPostNoticeWrite<T>(work: () => Promise<T>): Promise<T> {
  const epoch = captureBackupRestoreDataEpoch();
  const task = writes.then(async () => {
    const result = await runBackupRestoreDataEpochCommit(epoch, work);
    if (!result.committed) throw new Error('post-notice-stale');
    return result.value;
  });
  writes = task.then(() => undefined, () => undefined);
  return task;
}
function withReadState<T>(work: (state: ReadState) => Promise<T>, now = Date.now()): Promise<T> {
  return withPostNoticeWrite(async () => work(await readState(now)));
}

/** Receipt union shares the existing writer, and keeps notification execution local. */
export function mergeSyncedPostNoticeRead(value: import('../sync/syncMemoryExperience').PostNoticeReadSyncValueV1 | null) {
  return withPostNoticeWrite(async () => {
    const raw = await AsyncStorage.getItem(READ_KEY);
    if (value === null) { if (raw !== null) { await AsyncStorage.removeItem(READ_KEY); DeviceEventEmitter.emit(READ_CHANGED); } return; }
    const sync = await import('../sync/syncMemoryExperience');
    const previous = raw === null ? null : JSON.parse(raw) as ReadState;
    const merged = sync.mergePostNoticeReadSyncValuesV1(previous, value);
    const next = JSON.stringify(merged);
    if (raw !== next) { await AsyncStorage.setItem(READ_KEY, next); DeviceEventEmitter.emit(READ_CHANGED); }
  });
}

/** Only small arrival records, never the whole memory corpus or post bodies. */
export async function loadPostUnreadNotices(now = Date.now()): Promise<PostNoticeTarget[]> {
  const state = await withReadState(async value => value, now);
  const database = await getMemoryDatabase();
  const rows = await database.getAllAsync<PostNoticeTarget>(`SELECT p.post_id AS postId,
      NULL AS commentSource, m.created_at AS createdAt
    FROM baiyun_post_metadata p JOIN memories m ON m.id = p.post_id
    WHERE p.author = 'I' AND m.type <> 'archived' AND m.created_at >= ?
    UNION ALL
    SELECT c.post_id AS postId, c.source AS commentSource, c.created_at AS createdAt
    FROM baiyun_post_comment_metadata c
    JOIN baiyun_post_metadata p ON p.post_id = c.post_id
    JOIN memories m ON m.id = p.post_id
    JOIN memory_comments body ON body.id = c.current_id AND body.memory_id = c.post_id
    WHERE c.author = 'I' AND c.deleted = 0 AND m.type <> 'archived' AND c.created_at >= ?
    ORDER BY createdAt DESC, postId, commentSource`, state.since, state.since);
  const seen = new Set(state.seen);
  return rows.filter(row => !seen.has(postNoticeKey(row.postId, row.commentSource)));
}

export async function loadPostHeartNotice(now = Date.now()): Promise<PostNoticeTarget | null> {
  return (await loadPostUnreadNotices(now))[0] ?? null;
}

export function markPostNoticesSeen(keys: readonly string[]) {
  return withReadState(async state => {
    const seen = [...new Set([...state.seen, ...keys])];
    if (seen.length === state.seen.length) return;
    await (await import('../sync/syncMemoryExperienceStorageBridge')).memoryExperienceStorageBridge.setItem(READ_KEY, JSON.stringify({ ...state, seen }));
    // Read acknowledgements do not make the post page reload its database rows.
    DeviceEventEmitter.emit(READ_CHANGED);
  });
}

export function subscribePostNoticeRead(listener: () => void) {
  const subscription = DeviceEventEmitter.addListener(READ_CHANGED, listener);
  return () => subscription.remove();
}

// Navigation handoff is process-local and synchronous: no sync/database write on a tap.
export function requestPostNoticeOpen(target: PostNoticeTarget | null) {
  requested = target ? { ...target, requestId: target.requestId ?? `post-open:${Date.now()}:${++openSequence}` } : null;
  openListeners.forEach(listener => listener());
}
export function subscribePostNoticeOpen(listener: () => void) {
  openListeners.add(listener); return () => { openListeners.delete(listener); };
}
export function consumePostNoticeOpen() { const target = requested; requested = null; return target; }
