import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { getMemoryDatabase } from '../memory/memoryStore';
import { loadPostNotificationArrivals } from './baiyunPostNotificationData';
import { isPostNotificationPayload, postNotificationPreview, type PostNotificationPayload } from './baiyunPostNotificationPolicy';
import { loadPostUnreadNotices, postNoticeKey, requestPostNoticeOpen, subscribePostNoticeRead } from './baiyunPostNotice';
import { subscribeBaiyunPosts } from './baiyunPostStore';

const KEY = 'junluo.posts.notifications.v1';
const CHANNEL = 'baiyun-posts';
const QUIET_CHANNEL = 'baiyun-posts-updates';
type Delivery = { phase: 'attempted' | 'sent' | 'closed'; revision: number; signature: string };
type Journal = Record<string, Delivery>;
let serial = Promise.resolve();
const clicked = new Set<string>();
const appActive = () => AppState.currentState === 'active';
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const result = serial.then(work); serial = result.then(() => undefined, () => undefined); return result;
}
async function readJournal(): Promise<Journal> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return {};
  const parsed = JSON.parse(raw) as Journal;
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object'
    || Object.values(parsed).some(item => !item || !['attempted', 'sent', 'closed'].includes(item.phase)
      || !Number.isSafeInteger(item.revision) || typeof item.signature !== 'string')) throw new Error('post-notification-journal-invalid');
  return parsed;
}
async function writeJournal(journal: Journal, epoch: number | null) {
  const result = await runBackupRestoreDataEpochCommit(epoch, async () => {
    const value = JSON.stringify(journal);
    if (await AsyncStorage.getItem(KEY) !== value) await AsyncStorage.setItem(KEY, value);
  });
  if (!result.committed) throw new Error('post-notification-stale');
}
const notificationId = (key: string) => `junluo-post:${encodeURIComponent(key)}`;

/** No timers or model work. Called after committed content and on existing app opportunities. */
export function flushPostNotifications(): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  return enqueue(async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch)) return;
    const [journal, arrivals, unread, presented, permission] = await Promise.all([
      readJournal(), getMemoryDatabase().then(loadPostNotificationArrivals), loadPostUnreadNotices(),
      Notifications.getPresentedNotificationsAsync(), Notifications.getPermissionsAsync(),
    ]);
    const keys = new Set(unread.map(item => postNoticeKey(item.postId, item.commentSource)));
    const groups = new Map<string, typeof arrivals>();
    for (const item of arrivals) if (item.background && keys.has(postNoticeKey(item.postId, item.commentSource))) {
      const group = groups.get(item.groupKey) ?? []; group.push(item); groups.set(item.groupKey, group);
    }
    const existing = new Map(presented.filter(item => isPostNotificationPayload(item.request.content.data))
      .map(item => [item.request.content.data.groupKey as string, item]));
    // Acknowledged/deleted records disappear from the tray; other notification domains are untouched.
    for (const [key, item] of existing) if (!groups.has(key) || clicked.has(key)) {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      await Notifications.dismissNotificationAsync(item.request.identifier);
      existing.delete(key);
    }
    for (const [key, delivery] of Object.entries(journal)) {
      if (delivery.phase !== 'closed' && (!groups.has(key) || clicked.has(key)
        || (delivery.phase === 'sent' && !existing.has(key)))) {
        journal[key] = { ...delivery, phase: 'closed' };
      }
    }
    await writeJournal(journal, epoch);
    if (!groups.size) return;
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL, {
      name: '白云苍狗', importance: Notifications.AndroidImportance.DEFAULT,
    });
    // Android background delivery bypasses the JS handler. A quiet channel is required:
    // sound:false alone does not silence an Android 8+ channel with a configured sound.
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(QUIET_CHANNEL, {
      name: '白云苍狗·静默更新', importance: Notifications.AndroidImportance.LOW, sound: null, enableVibrate: false,
    });
    for (const [key, items] of groups) {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return;
      const previous = journal[key], present = existing.get(key);
      if (previous?.phase === 'closed' || clicked.has(key)) continue;
      const signature = JSON.stringify(items.map(item => [postNoticeKey(item.postId, item.commentSource), item.updatedAt]));
      if (previous?.phase === 'sent' && previous.signature === signature) continue;
      if (!permission.granted || (appActive() && !present)) {
        // Never backfill an alert after returning from the foreground or granting permission.
        if (!previous) { journal[key] = { phase: 'closed', revision: 0, signature }; await writeJournal(journal, epoch); }
        continue;
      }
      const silent = Boolean(previous || present);
      const revision = (previous?.revision ?? 0) + 1;
      const first = items[0], latest = items[items.length - 1];
      const posts = items.filter(item => item.commentSource === null).length, comments = items.length - posts;
      const counts = [posts ? `新动态 ${posts} 条` : '', comments ? `新评论 ${comments} 条` : ''].filter(Boolean).join(' · ');
      const data: PostNotificationPayload = { kind: 'baiyun-post', groupKey: key,
        requestId: `${notificationId(key)}:${revision}`, postId: first.postId,
        commentSource: first.commentSource, createdAt: first.createdAt, silent };
      // Claim the one audible attempt before crossing the OS boundary. Ambiguous recovery is silent.
      journal[key] = { phase: 'attempted', revision, signature }; await writeJournal(journal, epoch);
      if (clicked.has(key) || !canCommitBackupRestoreDataEpoch(epoch)) return;
      // Recheck source/read changes after local IO, immediately before publication.
      const current = await getMemoryDatabase().then(loadPostNotificationArrivals);
      const currentUnread = new Set((await loadPostUnreadNotices()).map(item => postNoticeKey(item.postId, item.commentSource)));
      const valid = items.every(item => currentUnread.has(postNoticeKey(item.postId, item.commentSource))
        && current.some(row => row.postId === item.postId && row.commentSource === item.commentSource && row.updatedAt === item.updatedAt));
      if (!valid || (appActive() && !present) || !canCommitBackupRestoreDataEpoch(epoch)) continue;
      if (previous?.phase === 'sent' && !(await Notifications.getPresentedNotificationsAsync()).some(item => item.request.identifier === notificationId(key))) {
        journal[key] = { ...journal[key], phase: 'closed' }; await writeJournal(journal, epoch); continue;
      }
      const id = await Notifications.scheduleNotificationAsync({ identifier: notificationId(key),
        content: { title: `☁ 白云苍狗 · ${counts}`, body: postNotificationPreview(latest.content, latest.title) || undefined,
          data, sound: silent ? false : 'default', vibrate: silent ? [] : undefined, autoDismiss: true,
          priority: silent ? Notifications.AndroidNotificationPriority.LOW : Notifications.AndroidNotificationPriority.DEFAULT },
        trigger: Platform.OS === 'android' ? { channelId: silent ? QUIET_CHANNEL : CHANNEL } : null });
      if (!canCommitBackupRestoreDataEpoch(epoch)) { await Notifications.dismissNotificationAsync(id); return; }
      const after = await getMemoryDatabase().then(loadPostNotificationArrivals);
      const stillUnread = new Set((await loadPostUnreadNotices()).map(item => postNoticeKey(item.postId, item.commentSource)));
      if (clicked.has(key) || items.some(item => !stillUnread.has(postNoticeKey(item.postId, item.commentSource))
        || !after.some(row => row.postId === item.postId && row.commentSource === item.commentSource && row.updatedAt === item.updatedAt))) {
        await Notifications.dismissNotificationAsync(id);
        // Keep the attempted state: remaining valid content can only be restored quietly.
        continue;
      }
      journal[key] = { phase: 'sent', revision, signature }; await writeJournal(journal, epoch);
    }
  });
}

export function resumePostNotifications() {
  return flushPostNotifications().catch(() => { console.warn('post-notifications-deferred'); });
}

export function observePostNotifications() {
  const changed = subscribeBaiyunPosts(() => { void resumePostNotifications(); });
  const read = subscribePostNoticeRead(() => { void resumePostNotifications(); });
  const foreground = AppState.addEventListener('change', state => { if (state === 'active') void resumePostNotifications(); });
  void resumePostNotifications();
  return () => { changed(); read(); foreground.remove(); };
}

export async function openPostNotification(data: PostNotificationPayload) {
  const epoch = captureBackupRestoreDataEpoch();
  clicked.add(data.groupKey);
  await enqueue(async () => {
    const journal = await readJournal();
    journal[data.groupKey] = { phase: 'closed', revision: journal[data.groupKey]?.revision ?? 0, signature: '' };
    await writeJournal(journal, epoch);
  }).catch(() => undefined); // Closing the OS reminder must not gate opening real content.
  let arrivals: Awaited<ReturnType<typeof loadPostNotificationArrivals>> = [], unread: Awaited<ReturnType<typeof loadPostUnreadNotices>> = [];
  try {
    [arrivals, unread] = await Promise.all([getMemoryDatabase().then(loadPostNotificationArrivals), loadPostUnreadNotices()]);
  } catch { /* The page retries its own current data load and displays a technical read error. */ }
  if (!canCommitBackupRestoreDataEpoch(epoch)) return false;
  const group = arrivals.filter(item => item.groupKey === data.groupKey);
  const keys = new Set(unread.map(item => postNoticeKey(item.postId, item.commentSource)));
  const target = group.find(item => keys.has(postNoticeKey(item.postId, item.commentSource)))
    ?? group.find(item => item.postId === data.postId && item.commentSource === data.commentSource) ?? group[0] ?? data;
  requestPostNoticeOpen({ postId: target.postId, commentSource: target.commentSource, createdAt: target.createdAt, requestId: data.requestId });
  void resumePostNotifications();
  return true;
}
