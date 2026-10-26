import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { createSubjectiveMessage } from '../ai/subjectiveMessages';
import { settleSavedMemoryUsage, type MemoryUsageReceipt } from '../memory/memoryReplyUsage';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { AiConnection, AiProfile } from '../ai/types';
import { appendMessagesToChatSession, loadChatState } from '../chat/chatStorage';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { recordBaiyunCareDelivery } from '../ai/behavior/actionExecutionRuntime';
import {
  loadScheduleReminderEvent, markScheduleCompanionEventDelivered,
  saveScheduleReminderPreparation, type ScheduleReminderEvent,
  saveScheduleReminderBody, markScheduleReminderNotified,
} from './scheduleCompanionStore';
import { markOccurrenceDelivered } from './scheduleStore';
import { generateScheduleCompanionBubbles } from './scheduleReminderGenerator';
import { decideScheduleReminderPersona, formatScheduleCompanionTextForPersona } from './scheduleReminderPersona';
import { notifyScheduleReminderBody } from './scheduleNotifications';
import { cancelScheduleNativeWakeTask } from './scheduleNativeWake';
import { emptyScheduleMessageDelivery, type ScheduleMessageDeliveryResult } from './scheduleDeliveryTypes';
import {
  preparationMatches, scheduleReminderWindow, SCHEDULE_SEND_GRACE_MS,
  type ScheduleReminderPreparation,
} from './scheduleReminderTiming';

type Options = { apiKey?: string; connection?: AiConnection | null; profile?: AiProfile };
const preparations = new Map<string, Promise<void>>();
const deliveries = new Map<string, { deadlineReached: boolean; task: Promise<ScheduleMessageDeliveryResult> }>();
// An active deadline callback can be a few milliseconds late on the JS event loop.
const DEADLINE_TIMER_SLACK_MS = 1_000;

async function makePreparation(event: ScheduleReminderEvent, options?: Options) {
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return;
  const { sessions, activeSessionId } = await loadChatState();
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return;
  const decision = await decideScheduleReminderPersona();
  const preparation: ScheduleReminderPreparation = {
    scheduledAt: event.scheduledAt, itemUpdatedAt: event.itemUpdatedAt,
    sessionId: active.id, persona: decision.persona, state: 'generating',
  };
  const started = await runBackupRestoreDataEpochCommit(dataEpoch, () => saveScheduleReminderPreparation(event.id, preparation));
  if (!started.committed || started.value === false) return;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = event.scheduledAt + SCHEDULE_SEND_GRACE_MS;
  try {
    let memoryUsage: MemoryUsageReceipt | undefined;
    const generation = { outcome: 'failed' as 'ready' | 'quiet' | 'failed' };
    const body = await Promise.race([
      (async () => {
        if (!(await loadAutomaticRemoteAiPolicy()).enabled) return '';
        const config = options ?? await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 }).then((stored) => ({
          apiKey: stored.chatKey, connection: stored.chatConnection, profile: stored.profile,
        }));
        if (!config?.apiKey?.trim() || !config.connection || !config.profile || controller.signal.aborted) return '';
        const bubbles = await generateScheduleCompanionBubbles({
          apiKey: config.apiKey, connection: config.connection, profile: config.profile,
          kind: event.kind, occurrence: event.occurrence, persona: decision.persona,
          messages: active.messages, referenceTime: event.scheduledAt, signal: controller.signal,
          onMemoryUsagePrepared: receipt => { if (!controller.signal.aborted) memoryUsage = receipt; },
          onGenerationOutcome: outcome => { if (!controller.signal.aborted) generation.outcome = outcome; },
          beforeRequest: async () => {
            if (controller.signal.aborted || !canCommitBackupRestoreDataEpoch(dataEpoch)
              || Date.now() > deadline || !(await loadAutomaticRemoteAiPolicy()).enabled) return false;
            const current = await loadScheduleReminderEvent(event.id);
            return !!current && current.scheduledAt === event.scheduledAt && current.itemUpdatedAt === event.itemUpdatedAt;
          },
        });
        return bubbles.map((bubble) => bubble.trim()).filter(Boolean).slice(0, 2).join('\n\n');
      })(),
      new Promise<string>((resolve) => {
        timeout = setTimeout(() => { controller.abort(); resolve(''); }, Math.max(0, deadline - Date.now()));
      }),
    ]);
    preparation.state = body ? 'ready' : generation.outcome === 'quiet' ? 'quiet' : 'failed';
    if (body) { preparation.body = body; preparation.memoryUsage = memoryUsage; }
  } catch {
    preparation.state = 'failed';
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
  }
  const current = await loadScheduleReminderEvent(event.id);
  if (!current || !preparationMatches(preparation, current.scheduledAt, current.itemUpdatedAt)) return;
  await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    await saveScheduleReminderPreparation(event.id, preparation);
    if (preparation.state === 'ready' && preparation.body && Date.now() <= event.scheduledAt + SCHEDULE_SEND_GRACE_MS) {
      await saveScheduleReminderBody(current, preparation.body);
    }
  });
}

function prepareOnce(event: ScheduleReminderEvent, options?: Options) {
  // Starts use the body written by the already-existing chat reply, never another model request.
  if (event.kind === 'upcoming') return Promise.resolve();
  const key = `${event.id}:${event.scheduledAt}:${event.itemUpdatedAt}`;
  const existing = preparations.get(key);
  if (existing) return existing;
  if (preparationMatches(event.preparation, event.scheduledAt, event.itemUpdatedAt)) return Promise.resolve();
  const task = makePreparation(event, options).finally(() => preparations.delete(key));
  preparations.set(key, task);
  return task;
}

async function deliver(expected: ScheduleReminderEvent, dataEpoch: number, deadlineReached: boolean) {
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return emptyScheduleMessageDelivery();
  const eventId = expected.id;
  let event = await loadScheduleReminderEvent(eventId, true);
  if (!event || event.scheduledAt !== expected.scheduledAt || event.itemUpdatedAt !== expected.itemUpdatedAt
    || !canCommitBackupRestoreDataEpoch(dataEpoch)) return emptyScheduleMessageDelivery();
  // A timely deadline wake may still need to wait for local storage. This is
  // bounded delivery time, not more time for generation or a late wake to enter.
  const sendBy = event.scheduledAt + SCHEDULE_SEND_GRACE_MS * (deadlineReached ? 2 : 1);
  if (Date.now() < event.scheduledAt || Date.now() > sendBy) return emptyScheduleMessageDelivery();
  const preparation = preparationMatches(event.preparation, event.scheduledAt, event.itemUpdatedAt)
    ? event.preparation : undefined;
  const chat = await loadChatState();
  const scheduledAt = event.scheduledAt;
  const alreadySaved = chat.sessions.flatMap((session) => session.messages)
    .filter((message) => message.scheduleCompanionEventId === eventId && message.createdAt >= scheduledAt);
  if (alreadySaved.length) {
    if (preparation?.state === 'ready' && alreadySaved.some(message => message.content === preparation.body)) {
      await settleSavedMemoryUsage({ receipt: preparation.memoryUsage, dataEpoch,
        savedAt: Math.max(...alreadySaved.map(message => message.createdAt)) });
    }
    if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return emptyScheduleMessageDelivery();
    const current = await loadScheduleReminderEvent(eventId, true);
    if (!current || current.scheduledAt !== event.scheduledAt || current.itemUpdatedAt !== event.itemUpdatedAt) return emptyScheduleMessageDelivery();
    event = current;
    if (!await markScheduleCompanionEventDelivered(eventId, event)) return emptyScheduleMessageDelivery();
    if (!event.notifiedAt && await notifyScheduleReminderBody(event, alreadySaved[0].content).catch(() => false)) {
      await markScheduleReminderNotified(eventId, event.scheduledAt);
    }
    await cancelScheduleNativeWakeTask(eventId);
    return emptyScheduleMessageDelivery();
  }
  if (event.status === 'delivered' || (event.kind !== 'upcoming'
    && (!preparation || preparation.state === 'generating') && !deadlineReached)) return emptyScheduleMessageDelivery();
  const sessionId = preparation?.sessionId ?? chat.activeSessionId;
  if (!chat.sessions.some((session) => session.id === sessionId)) return emptyScheduleMessageDelivery();
  const persona = preparation?.persona ?? (await decideScheduleReminderPersona()).persona;
  // Re-read after context awaits: a cancelled or edited event must never publish the old body.
  const current = await loadScheduleReminderEvent(eventId);
  if (!current || current.scheduledAt !== event.scheduledAt || current.itemUpdatedAt !== event.itemUpdatedAt) {
    return emptyScheduleMessageDelivery();
  }
  event = current;
  const storedBody = event.reminderBody?.scheduledAt === event.scheduledAt
    && event.reminderBody.itemUpdatedAt === event.itemUpdatedAt && event.reminderBody.body.trim()
    ? event.reminderBody.body : undefined;
  const body = storedBody ?? (event.kind !== 'upcoming' && preparation?.state === 'ready' && preparation.body?.trim()
    ? preparation.body : formatScheduleCompanionTextForPersona(event.kind, event.occurrence.title, persona));
  const message = createSubjectiveMessage('I', body, {
    source: 'schedule-companion', scheduleOccurrenceId: event.occurrenceId,
    scheduleReminderPersona: persona, scheduleCompanionEventId: event.id,
    scheduleCompanionKind: event.kind,
  });
  const committed = await runBackupRestoreDataEpochCommit(dataEpoch, async () => {
    return appendMessagesToChatSession(sessionId, [message], {
      activeSessionId: chat.activeSessionId,
      // The chat writer can wait while the occurrence is completed or edited.
      beforeAppend: async () => {
        const current = await loadScheduleReminderEvent(eventId);
        return canCommitBackupRestoreDataEpoch(dataEpoch) && !!current
          && current.scheduledAt === event.scheduledAt && current.itemUpdatedAt === event.itemUpdatedAt
          && Date.now() <= sendBy;
      },
    });
  });
  if (!committed.committed || !committed.value?.messages.some((item) => item.id === message.id)) return emptyScheduleMessageDelivery();
  if (preparation?.state === 'ready' && preparation.body === body) {
    await settleSavedMemoryUsage({ receipt: preparation.memoryUsage, dataEpoch, savedAt: message.createdAt });
  }
  if (!canCommitBackupRestoreDataEpoch(dataEpoch)) return emptyScheduleMessageDelivery();
  if (!await markScheduleCompanionEventDelivered(event.id, event)) return { inserted: 1, messages: [message] };
  await saveScheduleReminderBody(event, message.content);
  if (event.kind === 'upcoming') await markOccurrenceDelivered(event.occurrenceId);
  await recordBaiyunCareDelivery({
    sourceId: `schedule-companion:${event.id}`, itemName: event.occurrence.title,
    occurredAt: event.scheduledAt, messageIds: [message.id],
    links: [{ relation: 'task', targetKind: 'schedule_occurrence', targetId: event.occurrenceId }],
  }).catch(() => undefined);
  const notificationSource = await loadScheduleReminderEvent(event.id, true);
  if (notificationSource && notificationSource.scheduledAt === event.scheduledAt && notificationSource.itemUpdatedAt === event.itemUpdatedAt
    && canCommitBackupRestoreDataEpoch(dataEpoch) && await notifyScheduleReminderBody(notificationSource, message.content).catch(() => false)) {
    await markScheduleReminderNotified(event.id, event.scheduledAt);
  }
  await cancelScheduleNativeWakeTask(event.id).catch(() => undefined);
  return { inserted: 1, messages: [message] };
}

function deliverOnce(event: ScheduleReminderEvent, dataEpoch: number, deadlineReached = false): Promise<ScheduleMessageDeliveryResult> {
  const key = `${event.id}:${event.scheduledAt}:${event.itemUpdatedAt}:${dataEpoch}`;
  const current = deliveries.get(key);
  if (current) {
    if (!deadlineReached || current.deadlineReached) return current.task;
    // An earlier delivery may return while preparation is still generating.
    // The deadline must get one local pass with its stronger delivery condition.
    return current.task.then(() => deliverOnce(event, dataEpoch, true));
  }
  const task = deliver(event, dataEpoch, deadlineReached).finally(() => deliveries.delete(key));
  deliveries.set(key, { deadlineReached, task });
  return task;
}

export async function handleScheduleReminderTask(
  payload: { eventId: string; scheduledAt: number; phase: 'prepare' | 'deliver' | 'deadline' },
  options?: Options,
): Promise<ScheduleMessageDeliveryResult> {
  const enteredAt = Date.now();
  const dataEpoch = captureBackupRestoreDataEpoch();
  if (dataEpoch === null) return emptyScheduleMessageDelivery();
  const event = await loadScheduleReminderEvent(payload.eventId, true);
  if (!event || event.scheduledAt !== payload.scheduledAt
    || !canCommitBackupRestoreDataEpoch(dataEpoch)) return emptyScheduleMessageDelivery();
  const window = scheduleReminderWindow(event.scheduledAt, enteredAt);
  // Startup must discard missed windows before making any model request.
  const liveDeadline = payload.phase === 'deadline'
    && enteredAt <= event.scheduledAt + SCHEDULE_SEND_GRACE_MS + DEADLINE_TIMER_SLACK_MS;
  if ((window === 'expired' && !liveDeadline) || window === 'future') return emptyScheduleMessageDelivery();
  if (Date.now() > event.scheduledAt + SCHEDULE_SEND_GRACE_MS * 2) return emptyScheduleMessageDelivery();
  if (event.status === 'delivered') return deliverOnce(event, dataEpoch, true);
  if (payload.phase === 'deadline' || Date.now() >= event.scheduledAt + SCHEDULE_SEND_GRACE_MS) {
    return deliverOnce(event, dataEpoch, true);
  }
  await prepareOnce(event, options);
  const waitMs = event.scheduledAt - Date.now();
  // A single bounded wait keeps the existing headless wake alive until delivery.
  if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
  const deliverySource = await loadScheduleReminderEvent(event.id, true);
  if (!deliverySource || deliverySource.scheduledAt !== event.scheduledAt || deliverySource.itemUpdatedAt !== event.itemUpdatedAt) {
    return emptyScheduleMessageDelivery();
  }
  const deadline = event.scheduledAt + SCHEDULE_SEND_GRACE_MS;
  const delivered = await deliverOnce(event, dataEpoch, Date.now() >= deadline);
  if (delivered.inserted || Date.now() >= deadline) return delivered;
  const current = await loadScheduleReminderEvent(event.id);
  if (!current || current.scheduledAt !== event.scheduledAt || current.itemUpdatedAt !== event.itemUpdatedAt
    || current.preparation?.state !== 'generating') return delivered;
  // A restarted task may have saved 'generating' without a live request. Wait out this window only.
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));
  return deliverOnce(event, dataEpoch, true);
}
