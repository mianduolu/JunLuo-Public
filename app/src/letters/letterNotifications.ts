import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';

import {
  canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import type { LetterEntry } from './letterStore';
import { loadLetters, saveLetters, updateLetter } from './letterStore';

const CHANNEL_ID = 'baiyun-letters';

type LetterNotificationOptions = {
  dataEpoch?: number | null;
};

export async function initializeLetterNotifications() {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: '白云小姐信件',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 120, 80, 160],
    });
  }
}

async function hasNotificationPermission() {
  const permission = await Notifications.getPermissionsAsync();
  return permission.granted;
}

async function canNotify() {
  await initializeLetterNotifications();
  return hasNotificationPermission();
}

export async function scheduleLetterDueNotification(
  letter: LetterEntry,
  options: LetterNotificationOptions = {},
) {
  if (
    options.dataEpoch !== undefined
    && !canCommitBackupRestoreDataEpoch(options.dataEpoch)
  ) return null;
  if (!letter.dueAt || !(await canNotify())) return null;
  if (
    options.dataEpoch !== undefined
    && !canCommitBackupRestoreDataEpoch(options.dataEpoch)
  ) return null;
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: '白云小姐信箱',
      body: letter.kind === 'future-self' ? '有一封未来的信可以拆开了' : '我可以回信了',
      data: { kind: 'letter', letterId: letter.id },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(letter.dueAt),
      channelId: Platform.OS === 'android' ? CHANNEL_ID : undefined,
    },
  });
  try {
    if (options.dataEpoch === undefined) {
      await updateLetter(letter.id, { notificationId: identifier });
      return identifier;
    }
    const persisted = await runBackupRestoreDataEpochCommit(options.dataEpoch, () => (
      updateLetter(letter.id, { notificationId: identifier })
    ));
    if (persisted.committed && persisted.value) return identifier;
  } catch (error) {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
    throw error;
  }
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
  return null;
}

export async function resetLetterNotificationBindings() {
  const letters = await loadLetters();
  const resetCount = letters.filter((letter) => !!letter.notificationId).length;
  if (resetCount) {
    await saveLetters(letters.map((letter) => ({ ...letter, notificationId: undefined })));
  }
  return resetCount;
}

export async function rebindRestoredLetterNotifications(now = Date.now()) {
  const letters = await loadLetters();
  const pending = letters.filter((letter) => {
    if (!letter.dueAt || letter.dueAt <= now || letter.notificationId) return false;
    if (letter.kind === 'future-self') return letter.status === 'sealed';
    return letter.direction === 'you-to-ai'
      && (letter.status === 'waiting_ai' || letter.status === 'failed');
  });
  let scheduled = 0;
  for (const letter of pending) {
    if (await scheduleLetterDueNotification(letter)) scheduled += 1;
  }
  return scheduled;
}

export async function notifyIncomingLetter(
  letter: LetterEntry,
  options: LetterNotificationOptions = {},
) {
  if (
    options.dataEpoch !== undefined
    && !canCommitBackupRestoreDataEpoch(options.dataEpoch)
  ) return null;
  if (!(await canNotify())) return null;
  if (
    options.dataEpoch !== undefined
    && !canCommitBackupRestoreDataEpoch(options.dataEpoch)
  ) return null;
  const identifier = await Notifications.scheduleNotificationAsync({
    content: {
      title: '白云小姐寄来一封信',
      body: letter.title || '打开信箱看看吧',
      data: { kind: 'letter', letterId: letter.id },
    },
    trigger: null,
  });
  if (
    options.dataEpoch === undefined
    || canCommitBackupRestoreDataEpoch(options.dataEpoch)
  ) return identifier;
  await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => undefined);
  return null;
}

export async function cancelLetterNotification(letter: LetterEntry) {
  if (!letter.notificationId) return;
  await Notifications.cancelScheduledNotificationAsync(letter.notificationId).catch(() => undefined);
}

export function observeLetterNotifications(onLetter: (opened: boolean) => void) {
  const received = Notifications.addNotificationReceivedListener((event) => {
    if (event.request.content.data?.kind === 'letter') onLetter(false);
  });
  const responded = Notifications.addNotificationResponseReceivedListener((event) => {
    if (event.notification.request.content.data?.kind === 'letter') onLetter(true);
  });
  return () => {
    received.remove();
    responded.remove();
  };
}
