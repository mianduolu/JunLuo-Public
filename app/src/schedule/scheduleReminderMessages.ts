import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { recordBaiyunCareDelivery } from '../ai/behavior/actionExecutionRuntime';
import type { AiConnection, AiProfile } from '../ai/types';
import type { BackendEvent } from '../backend/backendClient';
import { appendMessagesToChatSession, loadChatState } from '../chat/chatStorage';
import { recordActiveMessageDelivery } from '../proactive/activeMessageCoordinator';
import {
  loadUndeliveredDueOccurrences,
  loadUpcomingUndeliveredOccurrences,
  markOccurrenceDelivered,
  type ScheduleOccurrence,
} from './scheduleStore';
import { generateScheduleReminderBubbles } from './scheduleReminderGenerator';
import { getScheduleReminderLeadText, reminderLeadLooksSpecific } from './scheduleReminderText';
import { emptyScheduleMessageDelivery, type ScheduleMessageDeliveryResult } from './scheduleDeliveryTypes';
import { decideScheduleReminderPersona, type ScheduleReminderPersona } from './scheduleReminderPersona';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';

const MESSAGE_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const AI_REMINDER_TIMEOUT_MS = 4500;
const AI_REMINDER_PREWARM_TIMEOUT_MS = 12000;
const AI_REMINDER_PREWARM_WINDOW_MS = 10 * 60 * 1000;
const AI_REMINDER_RELEASE_WAIT_MS = 900;
const MAX_AI_SUPPLEMENT_BUBBLES = 2;

type ReminderDeliveryOptions = {
  apiKey?: string;
  connection?: AiConnection | null;
  diagnosticParentToken?: number;
  onFallbackMessages?: (messages: SubjectiveMessage[]) => void;
  profile?: AiProfile;
};

type ReminderBubble = {
  content: string;
  persona?: ScheduleReminderPersona;
};

type PrewarmedReminderEntry = {
  reminderAt: number;
  resolved?: ReminderBubble[];
  task: Promise<ReminderBubble[]>;
};

const prewarmedReminderSupplements = new Map<string, PrewarmedReminderEntry>();

function withTimeout<T>(task: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return task(controller.signal).finally(() => clearTimeout(timer));
}

function waitFor<T>(ms: number, value: T) {
  return new Promise<T>((resolve) => {
    setTimeout(() => resolve(value), ms);
  });
}

function reminderPrewarmKey(occurrence: ScheduleOccurrence) {
  return `${occurrence.id}:${occurrence.reminderAt}:${occurrence.scheduledStartAt}`;
}

function cleanupPrewarmedReminderSupplements(now = Date.now()) {
  for (const [key, entry] of prewarmedReminderSupplements.entries()) {
    if (entry.reminderAt < now - MESSAGE_LOOKBACK_MS || entry.reminderAt > now + AI_REMINDER_PREWARM_WINDOW_MS * 2) {
      prewarmedReminderSupplements.delete(key);
    }
  }
}

async function buildReminderSupplements(
  occurrence: ScheduleOccurrence,
  activeMessages: SubjectiveMessage[],
  options: ReminderDeliveryOptions,
  referenceTime = Date.now(),
  timeoutMs = AI_REMINDER_TIMEOUT_MS,
): Promise<ReminderBubble[]> {
  const fallbackLead = getScheduleReminderLeadText(occurrence);
  const personaDecision = await decideScheduleReminderPersona();
  if (!personaDecision.allowAiSupplement || !options.apiKey?.trim() || !options.connection || !options.profile) {
    return [];
  }

  try {
    const generated = await withTimeout(
      (signal) => generateScheduleReminderBubbles({
        apiKey: options.apiKey!.trim(),
        connection: options.connection!,
        messages: activeMessages,
        occurrence,
        persona: personaDecision.persona,
        profile: options.profile!,
        referenceTime,
        signal,
      }),
      timeoutMs,
    );
    const supplements = generated
      .filter((bubble) => bubble.trim() && bubble.trim() !== fallbackLead)
      .filter((bubble, index) => index > 0 || !reminderLeadLooksSpecific(bubble, occurrence))
      .slice(0, MAX_AI_SUPPLEMENT_BUBBLES);
    return supplements.map((content) => ({
      content,
      persona: personaDecision.persona,
    }));
  } catch {
    return [];
  }
}

async function consumePrewarmedReminderSupplements(occurrence: ScheduleOccurrence) {
  const key = reminderPrewarmKey(occurrence);
  const entry = prewarmedReminderSupplements.get(key);
  if (!entry) return null;
  prewarmedReminderSupplements.delete(key);
  if (entry.resolved) return entry.resolved;
  return Promise.race([entry.task, waitFor(AI_REMINDER_RELEASE_WAIT_MS, null)]);
}

export function prewarmUpcomingScheduleReminderMessages(options: ReminderDeliveryOptions = {}) {
  return observeRuntimeWorkload(
    'schedule.reminder_prewarm_dispatch',
    async (span) => {
      if (!options.apiKey?.trim() || !options.connection || !options.profile) return 0;
      const now = Date.now();
      cleanupPrewarmedReminderSupplements(now);

      const { sessions, activeSessionId } = await loadChatState();
      const active = sessions.find((session) => session.id === activeSessionId);
      if (!active) return 0;

      const occurrences = await loadUpcomingUndeliveredOccurrences(now + AI_REMINDER_RELEASE_WAIT_MS, now + AI_REMINDER_PREWARM_WINDOW_MS);
      for (const occurrence of occurrences) {
        const key = reminderPrewarmKey(occurrence);
        if (prewarmedReminderSupplements.has(key)) continue;

        const entry: PrewarmedReminderEntry = {
          reminderAt: occurrence.reminderAt,
          task: Promise.resolve([]),
        };
        entry.task = observeRuntimeWorkload(
          'schedule.reminder_supplement_actual',
          () => buildReminderSupplements(
            occurrence,
            active.messages,
            options,
            occurrence.reminderAt,
            AI_REMINDER_PREWARM_TIMEOUT_MS,
          ),
          (value) => ({ itemCount: value.length }),
          { parentToken: span?.token },
        )
          .then((supplements) => {
            entry.resolved = supplements;
            return supplements;
          })
          .catch(() => {
            prewarmedReminderSupplements.delete(key);
            return [];
          });
        prewarmedReminderSupplements.set(key, entry);
      }
      return occurrences.length;
    },
    (value) => ({ itemCount: value }),
    { parentToken: options.diagnosticParentToken },
  ).then(() => undefined);
}

function occurrenceFromBackendEvent(event: BackendEvent): ScheduleOccurrence | null {
  if (event.type !== 'schedule_due') return null;
  const payload = event.payload;
  const title = typeof payload.title === 'string' ? payload.title : '';
  const triggerAt = typeof payload.triggerAt === 'number' ? payload.triggerAt : event.created_at;
  const scheduledStartAt = typeof payload.scheduledStartAt === 'number' ? payload.scheduledStartAt : triggerAt;
  if (!title) return null;
  return {
    id: `backend:${event.id}`,
    itemId: typeof payload.scheduleId === 'string' ? payload.scheduleId : event.id,
    scheduledStartAt,
    reminderAt: triggerAt,
    status: 'pending',
    title,
    reminderText: '',
    reminderIntensity:
      payload.reminderIntensity === 'strong' || payload.reminderIntensity === 'blast' ? payload.reminderIntensity : 'gentle',
    source: payload.source === 'ai' ? 'ai' : 'manual',
    companionEnabled: false,
    notes: typeof payload.notes === 'string' ? payload.notes : '',
    reminderMinutesBefore: typeof payload.reminderMinutesBefore === 'number' ? payload.reminderMinutesBefore : 0,
    recurrence:
      payload.recurrence === 'daily' ||
      payload.recurrence === 'weekdays' ||
      payload.recurrence === 'legalWorkday' ||
      payload.recurrence === 'weekly' ||
      payload.recurrence === 'monthly' ||
      payload.recurrence === 'yearly' ||
      payload.recurrence === 'lunarYearly'
        ? payload.recurrence
        : 'none',
  };
}

async function deliverOccurrences(occurrences: ScheduleOccurrence[], options: ReminderDeliveryOptions, markDelivered: (occurrence: ScheduleOccurrence) => Promise<void>): Promise<ScheduleMessageDeliveryResult> {
  if (!occurrences.length) return emptyScheduleMessageDelivery();

  const { sessions, activeSessionId } = await loadChatState();
  const existingOccurrenceIds = new Set(
    sessions.flatMap((session) =>
      session.messages
        .map((message) => message.scheduleOccurrenceId)
        .filter((id): id is string => typeof id === 'string'),
    ),
  );
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return emptyScheduleMessageDelivery();
  const pendingOccurrences = occurrences.filter((entry) => !existingOccurrenceIds.has(entry.id));
  const fallbackAdditions: SubjectiveMessage[] = pendingOccurrences.map((occurrence) =>
    createSubjectiveMessage('I', getScheduleReminderLeadText(occurrence), {
      scheduleOccurrenceId: occurrence.id,
      source: 'schedule-reminder',
    }),
  );
  let baseMessages = active.messages;
  const persistedIds = new Set<string>();

  if (fallbackAdditions.length) {
    const saved = await appendMessagesToChatSession(active.id, fallbackAdditions, { activeSessionId });
    fallbackAdditions.forEach((message) => {
      if (saved.messages.some((candidate) => candidate.id === message.id)) persistedIds.add(message.id);
    });
    baseMessages = saved.messages.length ? saved.messages : [...active.messages, ...fallbackAdditions];
    options.onFallbackMessages?.(fallbackAdditions);
  }

  const supplementAdditions: SubjectiveMessage[] = [];

  for (const occurrence of pendingOccurrences) {
    const prewarmedSupplements = await consumePrewarmedReminderSupplements(occurrence);
    const supplements =
      prewarmedSupplements ??
      (await buildReminderSupplements(occurrence, baseMessages, options, occurrence.reminderAt, AI_REMINDER_TIMEOUT_MS));
    supplementAdditions.push(
      ...supplements.map((bubble) =>
        createSubjectiveMessage('I', bubble.content, {
          scheduleOccurrenceId: occurrence.id,
          scheduleReminderPersona: bubble.persona,
          source: 'schedule-reminder',
        }),
      ),
    );
  }

  if (supplementAdditions.length) {
    const saved = await appendMessagesToChatSession(active.id, supplementAdditions, { activeSessionId });
    supplementAdditions.forEach((message) => {
      if (saved.messages.some((candidate) => candidate.id === message.id)) persistedIds.add(message.id);
    });
    baseMessages = saved.messages.length ? saved.messages : [...baseMessages, ...supplementAdditions];
  }
  const persistedMessages = [...fallbackAdditions, ...supplementAdditions]
    .filter((message) => persistedIds.has(message.id));
  const deliveredOccurrenceIds = new Set(
    persistedMessages.flatMap((message) => message.scheduleOccurrenceId ? [message.scheduleOccurrenceId] : []),
  );
  await Promise.all(occurrences
    .filter((occurrence) => deliveredOccurrenceIds.has(occurrence.id))
    .map(markDelivered));
  await Promise.all(pendingOccurrences.map(async (occurrence) => {
    const messages = persistedMessages.filter((message) => message.scheduleOccurrenceId === occurrence.id);
    if (!messages.length) return;
    await recordBaiyunCareDelivery({
      sourceId: `schedule-reminder:${occurrence.id}`, itemName: occurrence.title,
      occurredAt: occurrence.reminderAt, messageIds: messages.map((message) => message.id),
      links: [{ relation: 'task', targetKind: 'schedule_occurrence', targetId: occurrence.id }],
    }).catch(() => undefined);
  }));
  if (persistedMessages.length > 0) {
    await recordActiveMessageDelivery({
      messageCount: persistedMessages.length,
      priority: 'critical',
      source: 'schedule-reminder',
      topicKey: pendingOccurrences.map((occurrence) => occurrence.id).join('|'),
    });
  }
  return { inserted: persistedMessages.length, messages: persistedMessages };
}

export async function deliverDueScheduleReminderMessages(options: ReminderDeliveryOptions = {}) {
  void prewarmUpcomingScheduleReminderMessages(options).catch(() => undefined);
  const occurrences = await loadUndeliveredDueOccurrences(Date.now() - MESSAGE_LOOKBACK_MS);
  const result = await deliverOccurrences(occurrences, options, (occurrence) => markOccurrenceDelivered(occurrence.id));
  void prewarmUpcomingScheduleReminderMessages(options).catch(() => undefined);
  return result;
}

export async function deliverBackendScheduleEvents(events: BackendEvent[], options: ReminderDeliveryOptions = {}) {
  const occurrences = events.map(occurrenceFromBackendEvent).filter((occurrence): occurrence is ScheduleOccurrence => !!occurrence);
  return deliverOccurrences(occurrences, options, async () => {});
}
