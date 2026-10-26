import {
  proactiveLedgerStorageBridge as AsyncStorage,
} from '../sync/syncProactiveLedgerStorageBridge';

import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';

export type ActiveMessagePriority = 'critical' | 'contextual' | 'soft';

export type ActiveMessageSource =
  | NonNullable<SubjectiveMessage['source']>
  | 'agent-task'
  | 'life-project-share'
  | 'nearby-world-active'
  | 'phone-activity'
  | 'social-share'
  | 'web-voyage-share'
  | 'voice-call-autonomous';

export type ActiveMessageSlotRequest = {
  bypassQuietHour?: boolean;
  messageCount?: number;
  now?: number;
  priority: ActiveMessagePriority;
  source: ActiveMessageSource;
  topicKey?: string;
};

export type ActiveMessageSlotDecision = {
  allowed: boolean;
  reason?: string;
};

export type ActiveMessageDeliveryRecord = {
  deliveredAt: number;
  messageCount: number;
  priority: ActiveMessagePriority;
  source: ActiveMessageSource;
  topicKey?: string;
};

export type ActiveMessageCoordinatorSnapshot = {
  lastDecision?: ActiveMessageSlotRequest & ActiveMessageSlotDecision & { decidedAt: number };
  records: ActiveMessageDeliveryRecord[];
  updatedAt: number;
  version: 1;
};

const COORDINATOR_KEY = 'junluo.activeMessageCoordinator.v1';
const MAX_RECORDS = 80;
const CRITICAL_CONTEXTUAL_GAP_MS = 5 * 60 * 1000;
const CONTEXTUAL_SAME_SOURCE_GAP_MS = 8 * 60 * 1000;
const SOFT_ANY_ACTIVE_GAP_MS = 12 * 60 * 1000;
const MAX_DAILY_SOFT_MESSAGES = 6;

let coordinatorQueue = Promise.resolve();

function todayKey(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

function isQuietHour(now = Date.now()) {
  const hour = new Date(now).getHours();
  return hour >= 23 || hour < 7;
}

function normalizePriority(value: unknown): ActiveMessagePriority | null {
  return value === 'critical' || value === 'contextual' || value === 'soft' ? value : null;
}

function normalizeRecord(value: unknown): ActiveMessageDeliveryRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<ActiveMessageDeliveryRecord>;
  const priority = normalizePriority(item.priority);
  if (!priority || typeof item.source !== 'string' || typeof item.deliveredAt !== 'number') return null;
  return {
    deliveredAt: item.deliveredAt,
    messageCount: typeof item.messageCount === 'number' && item.messageCount > 0 ? item.messageCount : 1,
    priority,
    source: item.source as ActiveMessageSource,
    topicKey: typeof item.topicKey === 'string' ? item.topicKey : undefined,
  };
}

function normalizeSnapshot(value: unknown): ActiveMessageCoordinatorSnapshot {
  const candidate = value && typeof value === 'object' ? value as Partial<ActiveMessageCoordinatorSnapshot> : {};
  const records = Array.isArray(candidate.records)
    ? candidate.records.map(normalizeRecord).filter((record): record is ActiveMessageDeliveryRecord => !!record).slice(-MAX_RECORDS)
    : [];
  return {
    lastDecision: candidate.lastDecision,
    records,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    version: 1,
  };
}

async function loadSnapshot(): Promise<ActiveMessageCoordinatorSnapshot> {
  try {
    const raw = await AsyncStorage.getItem(COORDINATOR_KEY);
    if (!raw) return { records: [], updatedAt: Date.now(), version: 1 };
    return normalizeSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return { records: [], updatedAt: Date.now(), version: 1 };
  }
}

async function saveSnapshot(snapshot: ActiveMessageCoordinatorSnapshot) {
  await AsyncStorage.setItem(COORDINATOR_KEY, JSON.stringify({
    ...snapshot,
    records: snapshot.records.slice(-MAX_RECORDS),
    updatedAt: Date.now(),
  }));
}

function recentRecords(snapshot: ActiveMessageCoordinatorSnapshot, now: number) {
  return snapshot.records.filter((record) => record.deliveredAt <= now);
}

function softCountForToday(snapshot: ActiveMessageCoordinatorSnapshot, now: number) {
  const key = todayKey(now);
  return snapshot.records
    .filter((record) => record.priority === 'soft' && todayKey(record.deliveredAt) === key)
    .reduce((sum, record) => sum + Math.max(1, record.messageCount), 0);
}

function decideSlot(snapshot: ActiveMessageCoordinatorSnapshot, request: ActiveMessageSlotRequest): ActiveMessageSlotDecision {
  const now = request.now ?? Date.now();
  const records = recentRecords(snapshot, now);
  const latestAny = records.at(-1);
  const latestCritical = [...records].reverse().find((record) => record.priority === 'critical');
  const latestSameContextual = [...records].reverse().find((record) =>
    record.priority === 'contextual' &&
    (record.source === request.source || (!!record.topicKey && record.topicKey === request.topicKey)),
  );

  if (request.priority !== 'critical' && isChatReplyInFlight()) {
    return { allowed: false, reason: 'chat-in-flight' };
  }

  if (request.priority === 'critical') return { allowed: true };

  if (!request.bypassQuietHour && isQuietHour(now)) {
    return { allowed: false, reason: 'quiet-hour' };
  }

  if (request.priority === 'contextual') {
    if (latestCritical && now - latestCritical.deliveredAt < CRITICAL_CONTEXTUAL_GAP_MS) {
      return { allowed: false, reason: 'recent-critical' };
    }
    if (latestSameContextual && now - latestSameContextual.deliveredAt < CONTEXTUAL_SAME_SOURCE_GAP_MS) {
      return { allowed: false, reason: 'recent-contextual' };
    }
    return { allowed: true };
  }

  if (latestAny && now - latestAny.deliveredAt < SOFT_ANY_ACTIVE_GAP_MS) {
    return { allowed: false, reason: 'recent-any-active' };
  }
  if (softCountForToday(snapshot, now) + Math.max(1, request.messageCount ?? 1) > MAX_DAILY_SOFT_MESSAGES) {
    return { allowed: false, reason: 'daily-soft-cap' };
  }
  return { allowed: true };
}

function enqueue<T>(task: () => Promise<T>) {
  const run = coordinatorQueue.then(task, task);
  coordinatorQueue = run.then(() => undefined, () => undefined);
  return run;
}

export function requestActiveMessageSlot(request: ActiveMessageSlotRequest): Promise<ActiveMessageSlotDecision> {
  return enqueue(async () => {
    const now = request.now ?? Date.now();
    const snapshot = await loadSnapshot();
    const decision = decideSlot(snapshot, { ...request, now });
    await saveSnapshot({
      ...snapshot,
      lastDecision: { ...request, ...decision, decidedAt: now, now },
    }).catch(() => undefined);
    return decision;
  });
}

export function recordActiveMessageDelivery(delivery: Omit<ActiveMessageDeliveryRecord, 'deliveredAt'> & { deliveredAt?: number }) {
  return enqueue(async () => {
    const snapshot = await loadSnapshot();
    const deliveredAt = delivery.deliveredAt ?? Date.now();
    await saveSnapshot({
      ...snapshot,
      records: [
        ...snapshot.records,
        {
          deliveredAt,
          messageCount: Math.max(1, delivery.messageCount),
          priority: delivery.priority,
          source: delivery.source,
          topicKey: delivery.topicKey,
        },
      ].slice(-MAX_RECORDS),
    }).catch(() => undefined);
  });
}

export function loadActiveMessageCoordinatorSnapshot() {
  return loadSnapshot();
}

