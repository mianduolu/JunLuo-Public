import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { appendMessagesToChatSession, loadChatSessionMessage, loadChatSessionSnapshot } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { loadChatPreferences } from '../chat/chatPreferences';
import { getMusicStreamUrl } from '../music/neteaseMusic';
import { dispatchReminderMusicControl, dispatchReminderMusicPlayback, getRegisteredMusicPlaybackSnapshot, sameReminderMusicOwner } from '../tools/musicPlaybackBridge';
import { loadToolPermissionSettings } from '../tools/toolPermissionStore';
import { loadReminderConversationRevision, reminderConversationRevision } from './chatReminderConversation';
import { advanceChatReminder, getChatReminderOccurrence, loadAllChatReminders, loadChatReminderOccurrences,
  snoozeChatReminder, updateChatReminderOccurrence, type ChatReminderOccurrenceRecord } from './chatReminderStore';

const GRACE_MS = 30_000;
const CHANNEL_ID = 'baiyun-reminders';
const deliveries = new Map<string, Promise<ChatReminderDeliveryResult>>();
const actions = new Map<string, Promise<ChatReminderMusicActionResult>>();
type Options = { now?: number; dataEpoch?: number; occurrenceId?: string };
export type ChatReminderDeliveryResult = { occurrenceId: string; inserted: number; state: 'delivered' | 'missed' | 'paused' | 'changed'; error?: string };
export type ChatReminderMusicActionResult = { occurrenceId: string; state: 'stopped' | 'snoozed' | 'superseded' | 'stale' | 'failed'; triggerAt?: number; error?: string };
const detail = (error: unknown) => error instanceof Error ? error.message : String(error);
const savedChat = (record: ChatReminderOccurrenceRecord) => record.chatReminder.chatDelivery
  && record.chatReminder.chatDelivery.state !== 'pending' && record.chatReminder.chatDelivery.state !== 'failed'
  && record.chatReminder.chatDelivery.state !== 'unknown' && record.chatReminder.chatDelivery.deliveredAt > 0;
const messageId = (record: ChatReminderOccurrenceRecord) => `chat-reminder-message:${record.id}`;
const notificationId = (record: ChatReminderOccurrenceRecord) => `chat-reminder-notification:${record.id}`;
const notificationSaved = (record: ChatReminderOccurrenceRecord) => record.chatReminder.notificationEvidence?.state === 'scheduled'
  || record.chatReminder.notificationEvidence?.state === 'shown';
const notificationUnknown = (record: ChatReminderOccurrenceRecord) => record.chatReminder.notificationEvidence?.error?.startsWith('notification-outcome-unknown');
const fallbackBody = (record: ChatReminderOccurrenceRecord) => `鼠鼠，“${record.title}”的提醒时间到啦。(｡･ω･｡)ﾉ`;
const sameTarget = (left: ChatReminderOccurrenceRecord, right: ChatReminderOccurrenceRecord) => left.id === right.id
  && left.chatReminder.attemptId === right.chatReminder.attemptId && left.triggerAt === right.triggerAt
  && left.title === right.title && left.chatReminder.mode === right.chatReminder.mode
  && left.musicSong?.id === right.musicSong?.id;
function executionClock(options: Options) {
  const start = Date.now();
  return () => options.now === undefined ? Date.now() : options.now + Date.now() - start;
}

async function permissionAllowed(record: ChatReminderOccurrenceRecord, music = false) {
  const settings = await loadToolPermissionSettings({ strict: true });
  const blocked = (packageId: string, ids: string[]) => settings.globalDefault === 'deny'
    || settings.packageOverrides[packageId] === 'deny' || ids.some(id => settings.toolOverrides[id] === 'deny');
  if (blocked('reminder', ['reminder.propose_reminders', 'reminder.create'])) return false;
  if (!music) return true;
  if (blocked('alarm', ['alarm.create']) || blocked('music', ['music.play'])) return false;
  return (await loadChatPreferences()).musicEnabled;
}

async function validTarget(record: ChatReminderOccurrenceRecord, epoch: number, allowTerminal = false) {
  if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
  const current = await getChatReminderOccurrence(record.id);
  if (!current || !sameTarget(record, current) || current.status === 'cancelled'
    || (!allowTerminal && current.status !== 'pending')) return null;
  const series = (await loadAllChatReminders()).find(item => item.id === current.chatReminder.seriesId);
  if (!series || series.chatReminder.kind !== 'series' || series.status === 'cancelled') return null;
  // A snoozed historical occurrence does not become the series' next regular occurrence.
  if (!allowTerminal && current.chatReminder.snoozeCount === 0
    && (series.chatReminder.nextOccurrenceId !== current.id || series.chatReminder.revision !== current.chatReminder.seriesRevision)) return null;
  return canCommitBackupRestoreDataEpoch(epoch) ? current : null;
}

async function change(record: ChatReminderOccurrenceRecord, epoch: number,
  update: (record: ChatReminderOccurrenceRecord) => ChatReminderOccurrenceRecord,
  allowTerminal = false, now = Date.now()) {
  const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
    const current = await validTarget(record, epoch, allowTerminal);
    if (!current) return null;
    return updateChatReminderOccurrence({ occurrenceId: current.id, expectedRevision: current.chatReminder.revision,
      predicate: item => sameTarget(item, current) && item.status !== 'cancelled', update }, now);
  });
  return committed.committed ? committed.value : null;
}

async function finish(record: ChatReminderOccurrenceRecord, epoch: number, now: number,
  terminalReason?: 'missed' | 'permission-denied' | 'outcome-unknown') {
  const current = await change(record, epoch, item => ({ ...item, status: 'delivered',
    chatReminder: { ...item.chatReminder, ...(terminalReason ? { terminalReason } : {}) } }), false, now);
  if (current && canCommitBackupRestoreDataEpoch(epoch)) {
    await runBackupRestoreDataEpochCommit(epoch, async () => {
      await advanceChatReminder(current.chatReminder.seriesId, now);
    });
  }
  return current;
}

async function saveChatBody(record: ChatReminderOccurrenceRecord, epoch: number, now: () => number) {
  if (savedChat(record) || record.chatReminder.snoozeCount > 0) return { record, inserted: 0 };
  const previous = record.chatReminder.chatDelivery;
  const existing = await loadChatSessionMessage(PRIMARY_CHAT_SESSION_ID, messageId(record));
  if (existing) {
    if (existing.role !== 'I' || existing.source !== 'schedule-reminder'
      || (existing.reminderOccurrenceId && existing.reminderOccurrenceId !== record.id)) throw new Error('chat-reminder-message-conflict');
    const adopted = await change(record, epoch, item => ({ ...item, message: existing.content,
      chatReminder: { ...item.chatReminder, chatDelivery: { messageId: existing.id, body: existing.content,
        deliveredAt: existing.createdAt, attemptId: item.chatReminder.attemptId, state: 'saved' } } }), false, now());
    return { record: adopted, inserted: 0 };
  }
  if (previous?.state === 'pending' || previous?.state === 'unknown') {
    const unknown = await change(record, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      chatDelivery: { ...previous, state: 'unknown', error: 'chat-reminder-message-outcome-unknown' } } }), false, now());
    return { record: unknown, inserted: 0 };
  }
  const revision = await loadReminderConversationRevision();
  const preparation = record.chatReminder.preparedBody;
  const usePrepared = preparation?.state === 'ready' && preparation.body?.trim()
    && preparation.conversationRevision === revision && preparation.generatedAt <= now()
    && !notificationSaved(record);
  // Once the notification is actually registered, missing chat writes must retain that same body.
  const body = notificationSaved(record) && previous ? previous.body
    : usePrepared ? preparation!.body! : fallbackBody(record);
  const claimed = await change(record, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
    chatDelivery: { messageId: messageId(item), body, deliveredAt: 0, attemptId: item.chatReminder.attemptId, state: 'pending' } } }), false, now());
  if (!claimed) return { record: null, inserted: 0 };
  const message: SubjectiveMessage = { id: messageId(claimed), role: 'I', content: body,
    createdAt: now(), source: 'schedule-reminder', reminderOccurrenceId: claimed.id,
    reminderAttemptId: claimed.chatReminder.attemptId };
  let appendStarted = false, appendFinished = false, didAppend = false;
  try {
    const snapshot = await loadChatSessionSnapshot(PRIMARY_CHAT_SESSION_ID, { messageLimit: 1 });
    if (!snapshot || !(await permissionAllowed(claimed))) throw new Error('chat-reminder-chat-unavailable');
    appendStarted = true;
    const append = await appendMessagesToChatSession(PRIMARY_CHAT_SESSION_ID, [message], { dataEpoch: epoch,
      beforeAppend: async messages => !!(await validTarget(claimed, epoch)) && now() <= claimed.triggerAt + GRACE_MS
        && await permissionAllowed(claimed) && (!usePrepared
          || reminderConversationRevision(messages) === preparation!.conversationRevision) });
    appendFinished = true;
    if (!append.messages.some(item => item.id === message.id)) throw new Error('chat-reminder-message-not-saved');
    didAppend = true;
    const saved = await change(claimed, epoch, item => ({ ...item, message: body,
      chatReminder: { ...item.chatReminder, chatDelivery: { messageId: message.id, body,
        deliveredAt: message.createdAt, attemptId: item.chatReminder.attemptId, state: 'saved' } } }), false, now());
    return { record: saved, inserted: 1 };
  } catch (error) {
    // An append/save error can occur after the real write: prove it by reading the stable ID first.
    const actual = await loadChatSessionMessage(PRIMARY_CHAT_SESSION_ID, message.id).catch(() => undefined);
    if (actual && actual.content === body) {
      const saved = await change(claimed, epoch, item => ({ ...item, message: body,
        chatReminder: { ...item.chatReminder, chatDelivery: { messageId: actual.id, body,
          deliveredAt: actual.createdAt, attemptId: item.chatReminder.attemptId, state: 'saved' } } }), false, now());
      return { record: saved, inserted: 1 };
    }
    const failed = await change(claimed, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      chatDelivery: { ...item.chatReminder.chatDelivery!, state: actual === undefined || didAppend
        || (appendStarted && !appendFinished) ? 'unknown' : 'failed', error: detail(error) } } }), false, now());
    return { record: failed, inserted: 0 };
  }
}

async function notify(record: ChatReminderOccurrenceRecord, epoch: number, now: () => number) {
  if (record.chatReminder.snoozeCount > 0 || !record.chatReminder.chatDelivery) return record;
  // If chat never saved and its preparation became stale, do not send stale text through notifications either.
  if (!savedChat(record) && !notificationSaved(record) && record.chatReminder.preparedBody?.body === record.chatReminder.chatDelivery.body
    && record.chatReminder.preparedBody.conversationRevision !== await loadReminderConversationRevision()) {
    const updated = await change(record, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      chatDelivery: { ...item.chatReminder.chatDelivery!, body: fallbackBody(item) } } }), false, now());
    if (!updated) return null;
    record = updated;
  }
  const evidence = record.chatReminder.notificationEvidence;
  if (evidence?.state === 'shown' || evidence?.state === 'scheduled') return record;
  if (notificationUnknown(record)) return record;
  if (evidence?.state === 'pending') {
    // A completed native call may have crashed before its receipt. Do not duplicate a dismissed notification.
    const shown = await Notifications.getPresentedNotificationsAsync();
    const existing = shown.find(item => item.request.identifier === notificationId(record));
    return change(record, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      notificationEvidence: { attemptId: item.chatReminder.attemptId, state: existing ? 'shown' : 'failed',
        updatedAt: now(), ...(existing ? { notificationId: existing.request.identifier } : { error: 'notification-outcome-unknown' }) } } }), false, now());
  }
  const claimed = await change(record, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
    notificationEvidence: { attemptId: item.chatReminder.attemptId, state: 'pending', updatedAt: now() } } }), false, now());
  if (!claimed) return null;
  let nativeStarted = false;
  try {
    if (!(await Notifications.getPermissionsAsync()).granted) throw new Error('notification-permission-unavailable');
    if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync(CHANNEL_ID,
      { name: '白云小姐提醒', importance: Notifications.AndroidImportance.HIGH });
    const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const current = await validTarget(claimed, epoch);
      if (!current || now() > current.triggerAt + GRACE_MS || !await permissionAllowed(current)) return null;
      nativeStarted = true;
      return Notifications.scheduleNotificationAsync({ identifier: notificationId(current), content: {
        title: current.title, body: current.chatReminder.chatDelivery!.body,
        data: { reminderOccurrenceId: current.id, reminderAttemptId: current.chatReminder.attemptId },
        ...(current.chatReminder.mode === 'music' ? { categoryIdentifier: 'junluo-chat-reminder-music' } : {}),
      }, trigger: { channelId: CHANNEL_ID } });
    });
    if (!committed.committed || !committed.value) return null;
    return change(claimed, epoch, item => ({ ...item, notificationId: committed.value!, chatReminder: { ...item.chatReminder,
      notificationEvidence: { attemptId: item.chatReminder.attemptId, state: 'scheduled',
        updatedAt: now(), notificationId: committed.value! } } }), false, now());
  } catch (error) {
    return change(claimed, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      notificationEvidence: { attemptId: item.chatReminder.attemptId, state: 'failed', updatedAt: now(),
        error: nativeStarted ? `notification-outcome-unknown: ${detail(error)}` : detail(error) } } }), false, now());
  }
}

async function play(record: ChatReminderOccurrenceRecord, epoch: number, now: () => number) {
  if (record.chatReminder.mode !== 'music' || record.chatReminder.musicEvidence) return record;
  const claimed = await change(record, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
    musicEvidence: { attemptId: item.chatReminder.attemptId, state: 'claimed', attempts: 1, attemptedAt: now() } } }), false, now());
  if (!claimed) return null;
  try {
    if (!claimed.musicSong || !await permissionAllowed(claimed, true)) throw new Error('music-permission-or-song-unavailable');
    const streamUrl = await getMusicStreamUrl(claimed.musicSong.id);
    const owner = { occurrenceId: claimed.id, attemptId: claimed.chatReminder.attemptId };
    const receipt = await dispatchReminderMusicPlayback({ song: claimed.musicSong, streamUrl }, owner,
      async work => {
        const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
          const current = await validTarget(claimed, epoch);
          if (!current || now() > current.triggerAt + GRACE_MS || !await permissionAllowed(current, true)) {
            throw new Error('chat-reminder-play-source-expired');
          }
          const newer = (await loadAllChatReminders()).some(item => item.chatReminder.kind === 'occurrence'
            && item.chatReminder.mode === 'music' && item.status !== 'cancelled'
            && (item.triggerAt > current.triggerAt || item.triggerAt === current.triggerAt && item.id > current.id)
            && item.chatReminder.musicEvidence?.attemptedAt !== undefined
            && ['claimed', 'played', 'failed'].includes(item.chatReminder.musicEvidence.state));
          if (newer) throw new Error('music-reminder-superseded');
          return work();
        });
        if (!committed.committed) throw new Error('chat-reminder-restore-interrupted');
        return committed.value;
      });
    // A newer real ring replaces old postponed rings rather than leaving a music queue behind.
    for (const previous of await loadChatReminderOccurrences()) {
      if (previous.id === claimed.id || previous.chatReminder.snoozeCount === 0
        || previous.chatReminder.mode !== 'music' || previous.chatReminder.scheduledAt > claimed.chatReminder.scheduledAt) continue;
      const skipped = await change(previous, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
        musicEvidence: { attemptId: item.chatReminder.attemptId, state: 'skipped', attempts: 0,
          finishedAt: now(), error: 'music-reminder-superseded' } } }), false, now());
      if (skipped) await finish(skipped, epoch, now());
    }
    return change(claimed, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      musicEvidence: { ...item.chatReminder.musicEvidence!, state: 'played', finishedAt: receipt.confirmedAt } } }), false, now());
  } catch (error) {
    return change(claimed, epoch, item => ({ ...item, chatReminder: { ...item.chatReminder,
      musicEvidence: { ...item.chatReminder.musicEvidence!, state: detail(error) === 'music-reminder-superseded' ? 'skipped' : 'failed',
        finishedAt: now(), error: detail(error) } } }), false, now());
  }
}

async function deliver(record: ChatReminderOccurrenceRecord, options: Options): Promise<ChatReminderDeliveryResult> {
  const now = executionClock(options), epoch = options.dataEpoch ?? captureBackupRestoreDataEpoch();
  const result: ChatReminderDeliveryResult = { occurrenceId: record.id, inserted: 0, state: 'changed' };
  if (epoch === null || Platform.OS !== 'android') return result;
  let current = await validTarget(record, epoch);
  if (!current || now() < current.triggerAt) return result;
  if (now() > current.triggerAt + GRACE_MS) {
    await finish(current, epoch, now(), 'missed'); return { ...result, state: 'missed' };
  }
  if (!await permissionAllowed(current)) return { ...result, state: 'paused' };
  const chat = await saveChatBody(current, epoch, now);
  result.inserted = chat.inserted;
  if (!chat.record) return result;
  current = await notify(chat.record, epoch, now) ?? chat.record;
  current = await play(current, epoch, now) ?? current;
  const notification = current.chatReminder.notificationEvidence;
  const notificationDone = current.chatReminder.snoozeCount > 0 || notification?.state === 'scheduled' || notification?.state === 'shown';
  const musicDone = current.chatReminder.mode !== 'music' || !!current.chatReminder.musicEvidence;
  if (savedChat(current) && notificationDone && musicDone) {
    await finish(current, epoch, now()); result.state = 'delivered';
  } else if (current.chatReminder.chatDelivery?.state === 'unknown') {
    await finish(current, epoch, now(), 'outcome-unknown');
  } else if (notificationUnknown(current)) {
    await finish(current, epoch, now(), 'outcome-unknown');
  } else result.state = 'paused';
  return result;
}

export async function tickChatReminderDelivery(options: Options = {}) {
  const epoch = options.dataEpoch ?? captureBackupRestoreDataEpoch();
  if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch) || Platform.OS !== 'android') return { attempted: 0, inserted: 0, results: [] };
  // A terminal write and next-occurrence write are separate saves; finish only that missing local part after interruption.
  const all = await loadAllChatReminders();
  for (const series of all) {
    if (series.chatReminder.kind !== 'series' || series.status !== 'pending' || !series.chatReminder.nextOccurrenceId) continue;
    const nextId = series.chatReminder.nextOccurrenceId;
    const next = all.find(item => item.id === nextId);
    if (next && next.status !== 'pending') {
      await runBackupRestoreDataEpochCommit(epoch, () => advanceChatReminder(series.id, options.now ?? Date.now()));
    }
  }
  const records = (await loadChatReminderOccurrences({ dueAt: options.now ?? Date.now() }))
    .filter(record => !options.occurrenceId || record.id === options.occurrenceId);
  records.sort((a, b) => a.triggerAt - b.triggerAt || a.id.localeCompare(b.id));
  const results: ChatReminderDeliveryResult[] = [];
  for (const record of records) {
    let flight = deliveries.get(record.id);
    if (!flight) {
      flight = deliver(record, { ...options, dataEpoch: epoch }).finally(() => deliveries.delete(record.id));
      deliveries.set(record.id, flight);
    }
    try { results.push(await flight); }
    catch (error) { results.push({ occurrenceId: record.id, inserted: 0, state: 'paused', error: detail(error) }); }
  }
  return { attempted: results.length, inserted: results.reduce((sum, result) => sum + result.inserted, 0), results };
}

export function handleChatReminderMusicAction(input: {
  occurrenceId: string; attemptId: string; operationId: string; action: 'stop' | 'snooze'; minutes?: number;
}, options: Options = {}): Promise<ChatReminderMusicActionResult> {
  const key = `${input.occurrenceId}:${input.operationId}`;
  const existing = actions.get(key);
  if (existing) return existing;
  const flight = (async (): Promise<ChatReminderMusicActionResult> => {
    const now = executionClock(options), epoch = options.dataEpoch ?? captureBackupRestoreDataEpoch();
    const clickedAt = now();
    const fallback: ChatReminderMusicActionResult = { occurrenceId: input.occurrenceId, state: 'stale' };
    const minutes = input.minutes ?? 10;
    if (!input.operationId || (input.action === 'snooze' && (!Number.isSafeInteger(minutes) || minutes <= 0
      || !Number.isSafeInteger(clickedAt + minutes * 60_000)))) return { ...fallback, state: 'failed' };
    if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) return fallback;
    let record = await getChatReminderOccurrence(input.occurrenceId);
    if (!record || record.chatReminder.mode !== 'music') return fallback;
    if (record.chatReminder.musicControl?.operationId === input.operationId) {
      const stopped = record.chatReminder.musicControl.action === 'stop';
      const snoozed = record.chatReminder.lastOperationId === input.operationId;
      const next = !stopped && !snoozed ? (await loadChatReminderOccurrences()).find(item => item.id !== record!.id
        && item.chatReminder.seriesId === record!.chatReminder.seriesId) : undefined;
      return { ...fallback, state: stopped ? 'stopped' : snoozed ? 'snoozed' : 'superseded',
        ...(!stopped ? { triggerAt: snoozed ? record.triggerAt : next?.triggerAt } : {}) };
    }
    if (input.action === 'snooze' && record.chatReminder.lastOperationId === input.operationId
      && record.chatReminder.snoozeCount > 0) {
      // The snooze committed but its control receipt did not. Adopt the saved time, never stop or snooze again.
      return { ...fallback, state: 'snoozed', triggerAt: record.triggerAt };
    }
    const owner = { occurrenceId: input.occurrenceId, attemptId: input.attemptId };
    if (record.chatReminder.attemptId !== input.attemptId || !sameReminderMusicOwner(getRegisteredMusicPlaybackSnapshot()?.reminderOwner, owner)) return fallback;
    try {
      await dispatchReminderMusicControl('stop', owner, async work => {
        const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
          const target = await getChatReminderOccurrence(record!.id);
          if (!target || target.chatReminder.attemptId !== input.attemptId) throw new Error('chat-reminder-stale-action');
          return work();
        });
        if (!committed.committed) throw new Error('chat-reminder-restore-interrupted');
        return committed.value;
      });
      record = await getChatReminderOccurrence(record.id);
      if (!record || record.chatReminder.attemptId !== input.attemptId || !canCommitBackupRestoreDataEpoch(epoch)) {
        return { ...fallback, state: 'failed', error: 'chat-reminder-control-receipt-not-saved' };
      }
      const control = { operationId: input.operationId, action: input.action, at: clickedAt, ...(input.action === 'snooze' ? { minutes } : {}) };
      if (input.action === 'stop') {
        const committed = await runBackupRestoreDataEpochCommit(epoch, () => updateChatReminderOccurrence({ occurrenceId: record!.id,
          expectedRevision: record!.chatReminder.revision, update: item => ({ ...item, chatReminder: { ...item.chatReminder,
            lastOperationId: input.operationId, musicControl: control } }) }, now()));
        return committed.committed && committed.value ? { ...fallback, state: 'stopped' }
          : { ...fallback, state: 'failed', error: 'chat-reminder-control-receipt-not-saved' };
      }
      if (!await permissionAllowed(record, true)) return { ...fallback, state: 'failed', error: 'music-permission-unavailable' };
      const triggerAt = control.at + minutes * 60_000;
      if (!Number.isSafeInteger(triggerAt)) return { ...fallback, state: 'failed' };
      const next = (await loadChatReminderOccurrences()).find(item => item.chatReminder.seriesId === record!.chatReminder.seriesId
        && item.id !== record!.id && item.triggerAt <= triggerAt);
      if (next) {
        const committed = await runBackupRestoreDataEpochCommit(epoch, () => updateChatReminderOccurrence({ occurrenceId: record!.id,
          expectedRevision: record!.chatReminder.revision, update: item => ({ ...item, chatReminder: { ...item.chatReminder, musicControl: control } }) }, now()));
        return committed.committed && committed.value ? { ...fallback, state: 'superseded', triggerAt: next.triggerAt }
          : { ...fallback, state: 'failed', error: 'chat-reminder-control-receipt-not-saved' };
      }
      const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
        const snoozed = await snoozeChatReminder({ occurrenceId: record!.id, expectedRevision: record!.chatReminder.revision,
          operationId: input.operationId, triggerAt }, control.at);
        return updateChatReminderOccurrence({ occurrenceId: snoozed.id, expectedRevision: snoozed.chatReminder.revision,
          update: item => ({ ...item, chatReminder: { ...item.chatReminder, musicControl: control } }) }, control.at);
      });
      return committed.committed && committed.value ? { ...fallback, state: 'snoozed', triggerAt }
        : { ...fallback, state: 'failed', error: 'chat-reminder-control-receipt-not-saved' };
    } catch (error) { return { ...fallback, state: 'failed', error: detail(error) }; }
  })().finally(() => actions.delete(key));
  actions.set(key, flight);
  return flight;
}
