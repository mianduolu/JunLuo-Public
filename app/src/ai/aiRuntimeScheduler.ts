import AsyncStorage from '@react-native-async-storage/async-storage';

export type AiRuntimePriority = 'background' | 'critical' | 'night' | 'normal' | 'urgent';

export type AiRuntimeStatus = 'aborted' | 'failed' | 'running' | 'skipped' | 'success';

export type AiRuntimeRecord = {
  durationMs?: number;
  endedAt?: number;
  kind: string;
  priority: AiRuntimePriority;
  reason?: string;
  startedAt: number;
  status: AiRuntimeStatus;
};

export type AiRuntimeSnapshot = {
  current: AiRuntimeRecord | null;
  records: AiRuntimeRecord[];
  updatedAt: number;
  version: 1;
};

const AI_RUNTIME_SCHEDULER_KEY = 'junluo.aiRuntimeScheduler.v1';
const MAX_RECORDS = 80;
const AI_RUNTIME_PERSISTENCE_BUDGET_MS = 3000;

let currentTask: AiRuntimeRecord | null = null;
const scheduledTasks = new Set<AiRuntimeRecord>();
let chatTask: AiRuntimeRecord | null = null;
let criticalDepth = 0;
let persistenceInFlight = false;

async function persistWithinBudget(task: () => Promise<void>) {
  if (persistenceInFlight) return;
  persistenceInFlight = true;
  const operation = task()
    .catch(() => undefined)
    .finally(() => {
      persistenceInFlight = false;
    });
  await Promise.race([
    operation,
    new Promise<void>((resolve) => setTimeout(resolve, AI_RUNTIME_PERSISTENCE_BUDGET_MS)),
  ]);
}

function priorityRank(priority: AiRuntimePriority) {
  switch (priority) {
    case 'critical':
      return 5;
    case 'urgent':
      return 4;
    case 'normal':
      return 3;
    case 'night':
      return 2;
    case 'background':
    default:
      return 1;
  }
}

function refreshCurrentTask() {
  let next = criticalDepth > 0 ? chatTask : null;
  for (const task of scheduledTasks) {
    if (!next || priorityRank(task.priority) > priorityRank(next.priority)) next = task;
  }
  currentTask = next;
}

function normalizeRecord(value: unknown): AiRuntimeRecord | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<AiRuntimeRecord>;
  if (
    typeof item.kind !== 'string' ||
    typeof item.startedAt !== 'number' ||
    (item.priority !== 'background' && item.priority !== 'critical' && item.priority !== 'night' && item.priority !== 'normal' && item.priority !== 'urgent') ||
    (item.status !== 'aborted' && item.status !== 'failed' && item.status !== 'running' && item.status !== 'skipped' && item.status !== 'success')
  ) {
    return null;
  }
  return {
    durationMs: typeof item.durationMs === 'number' ? item.durationMs : undefined,
    endedAt: typeof item.endedAt === 'number' ? item.endedAt : undefined,
    kind: item.kind,
    priority: item.priority,
    reason: typeof item.reason === 'string' ? item.reason : undefined,
    startedAt: item.startedAt,
    status: item.status,
  };
}

function normalizeSnapshot(value: unknown): AiRuntimeSnapshot {
  const candidate = value && typeof value === 'object' ? value as Partial<AiRuntimeSnapshot> : {};
  const records = Array.isArray(candidate.records)
    ? candidate.records.map(normalizeRecord).filter((record): record is AiRuntimeRecord => !!record).slice(-MAX_RECORDS)
    : [];
  return {
    current: normalizeRecord(candidate.current) ?? currentTask,
    records,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : Date.now(),
    version: 1,
  };
}

async function loadSnapshot(): Promise<AiRuntimeSnapshot> {
  const raw = await AsyncStorage.getItem(AI_RUNTIME_SCHEDULER_KEY);
  if (!raw) {
    return { current: currentTask, records: [], updatedAt: Date.now(), version: 1 };
  }
  try {
    return normalizeSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return { current: currentTask, records: [], updatedAt: Date.now(), version: 1 };
  }
}

async function saveSnapshot(snapshot: AiRuntimeSnapshot) {
  await AsyncStorage.setItem(AI_RUNTIME_SCHEDULER_KEY, JSON.stringify({
    ...snapshot,
    records: snapshot.records.slice(-MAX_RECORDS),
    updatedAt: Date.now(),
  }));
}

async function appendRecord(record: AiRuntimeRecord) {
  const snapshot = await loadSnapshot();
  await saveSnapshot({
    current: currentTask,
    records: [...snapshot.records, record].slice(-MAX_RECORDS),
    updatedAt: Date.now(),
    version: 1,
  });
}

function shouldSkipForActiveTask(priority: AiRuntimePriority) {
  if (criticalDepth > 0 && priority !== 'critical') return 'chat-in-flight';
  if (!currentTask) return '';
  if (priorityRank(priority) <= priorityRank(currentTask.priority)) {
    return `busy:${currentTask.kind}`;
  }
  return '';
}

export function isChatReplyInFlight() {
  return criticalDepth > 0;
}

export async function markChatReplyStarted() {
  const previousChatTask = chatTask;
  criticalDepth += 1;
  const chatReplyTask: AiRuntimeRecord = {
    kind: 'chatReply',
    priority: 'critical',
    startedAt: Date.now(),
    status: 'running',
  };
  chatTask = chatReplyTask;
  refreshCurrentTask();
  try {
    await persistWithinBudget(async () => {
      const snapshot = await loadSnapshot();
      await saveSnapshot({ ...snapshot, current: currentTask, updatedAt: Date.now() });
    });
  } catch (error) {
    criticalDepth = Math.max(0, criticalDepth - 1);
    if (chatTask === chatReplyTask) chatTask = previousChatTask;
    refreshCurrentTask();
    throw error;
  }
}

export async function markChatReplyFinished(
  reason = 'finished',
  options: { persist?: boolean } = {},
) {
  criticalDepth = Math.max(0, criticalDepth - 1);
  if (criticalDepth > 0) return;
  const finished = chatTask
    ? {
      ...chatTask,
      durationMs: Date.now() - chatTask.startedAt,
      endedAt: Date.now(),
      reason,
      status: reason === 'aborted' ? 'aborted' as const : 'success' as const,
    }
    : null;
  chatTask = null;
  refreshCurrentTask();
  if (options.persist === false) return;
  if (finished) {
    await persistWithinBudget(() => appendRecord(finished));
  } else {
    await persistWithinBudget(async () => {
      const snapshot = await loadSnapshot();
      await saveSnapshot({ ...snapshot, current: currentTask, updatedAt: Date.now() });
    });
  }
}

export async function runScheduledAiCall<T>(
  kind: string,
  priority: AiRuntimePriority,
  fn: () => Promise<T>,
): Promise<{ ok: true; skipped: false; value: T } | { ok: false; reason: string; skipped: true }> {
  const skippedReason = shouldSkipForActiveTask(priority);
  if (skippedReason) {
    await persistWithinBudget(() => appendRecord({
      durationMs: 0,
      endedAt: Date.now(),
      kind,
      priority,
      reason: skippedReason,
      startedAt: Date.now(),
      status: 'skipped',
    }));
    return { ok: false, reason: skippedReason, skipped: true };
  }

  const startedAt = Date.now();
  const task: AiRuntimeRecord = { kind, priority, startedAt, status: 'running' };
  scheduledTasks.add(task);
  refreshCurrentTask();
  await persistWithinBudget(async () => {
    const snapshot = await loadSnapshot();
    await saveSnapshot({ ...snapshot, current: currentTask, updatedAt: startedAt });
  });

  try {
    const value = await fn();
    const endedAt = Date.now();
    await persistWithinBudget(() => appendRecord({
      durationMs: endedAt - startedAt,
      endedAt,
      kind,
      priority,
      startedAt,
      status: 'success',
    }));
    return { ok: true, skipped: false, value };
  } catch (error) {
    const endedAt = Date.now();
    await persistWithinBudget(() => appendRecord({
      durationMs: endedAt - startedAt,
      endedAt,
      kind,
      priority,
      reason: error instanceof Error ? error.message : 'failed',
      startedAt,
      status: 'failed',
    }));
    throw error;
  } finally {
    // A finishing task releases only itself, including when higher-priority work overlaps.
    scheduledTasks.delete(task);
    refreshCurrentTask();
    await persistWithinBudget(async () => {
      const latest = await loadSnapshot();
      await saveSnapshot({ ...latest, current: currentTask, updatedAt: Date.now() });
    });
  }
}

export async function loadAiRuntimeSnapshot() {
  const snapshot = await loadSnapshot();
  // Persisted diagnostics do not own a task in this process (also after a non-persisting abort).
  return { ...snapshot, current: currentTask };
}
