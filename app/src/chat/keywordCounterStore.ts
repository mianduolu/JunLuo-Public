import { chatRelationshipStorageBridge as AsyncStorage } from '../sync/syncChatRelationshipStorageBridge';

import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { AfterglowCounterIdea } from '../life/junluoInnerStateGeneration';
import { createSerialRuntimeQueue } from '../runtime/appRuntimeSchedulerCore';

export type KeywordCounterTaskType = 'nth_occurrence' | 'period_count';
export type KeywordCounterStatus = 'active' | 'completed' | 'disabled';
export type KeywordCounterPeriod = 'custom' | 'today' | 'this_month' | 'this_week' | 'this_year';

export type KeywordCounterTask = {
  completedAt?: number;
  count: number;
  createdAt: number;
  endAt?: number;
  firstMatchedAt?: number;
  id: string;
  keywords: string[];
  lastMatchedAt?: number;
  matchCaseSensitive: boolean;
  period: KeywordCounterPeriod;
  requestedByMessageId?: string;
  startAt: number;
  status: KeywordCounterStatus;
  targetCount?: number;
  title: string;
  type: KeywordCounterTaskType;
  updatedAt: number;
};

export type KeywordCounterEvent = {
  count: number;
  keyword: string;
  matchedText: string;
  messageCreatedAt: number;
  messageId: string;
  taskId: string;
};

export type KeywordCounterInsight = {
  consumedAt?: number;
  createdAt: number;
  id: string;
  message: string;
  taskId: string;
};

export type PreparedKeywordCounterInsights = {
  insightIds: string[];
  prompt: string;
  preparedAt: number;
  taskIds: string[];
};

export type KeywordCounterSettings = {
  enabled: boolean;
};

export type KeywordCounterSnapshot = {
  events: KeywordCounterEvent[];
  insights: KeywordCounterInsight[];
  settings: KeywordCounterSettings;
  tasks: KeywordCounterTask[];
};

export type KeywordCounterRequest = {
  endAt?: number;
  keywords: string[];
  matchCaseSensitive?: boolean;
  period?: KeywordCounterPeriod;
  startAt?: number;
  targetCount?: number;
  title?: string;
  type: KeywordCounterTaskType;
};

const KEYWORD_COUNTER_KEY = 'junluo.chat.keywordCounters.v1';
const COUNTER_MARKER_PATTERN = /\[\[COUNTER_REQUEST:([\s\S]*?)\]\]/g;
const MAX_EVENTS = 1200;
const MAX_INSIGHTS = 80;
// Chat counting and background creation must not overwrite each other's snapshot.
const counterMutations = createSerialRuntimeQueue();

export const defaultKeywordCounterSettings: KeywordCounterSettings = {
  enabled: true,
};

function makeId(prefix: string, now = Date.now()) {
  return `${prefix}-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function startOfWeek(date: Date) {
  const day = date.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + mondayOffset).getTime();
}

function addDays(timestamp: number, days: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

function resolvePeriod(period: KeywordCounterPeriod | undefined, now: number, startAt?: number, endAt?: number) {
  const date = new Date(now);
  switch (period) {
    case 'today': {
      const start = startOfDay(date);
      return { endAt: addDays(start, 1), period: 'today' as const, startAt: start };
    }
    case 'this_week': {
      const start = startOfWeek(date);
      return { endAt: addDays(start, 7), period: 'this_week' as const, startAt: start };
    }
    case 'this_year': {
      const start = new Date(date.getFullYear(), 0, 1).getTime();
      const end = new Date(date.getFullYear() + 1, 0, 1).getTime();
      return { endAt: end, period: 'this_year' as const, startAt: start };
    }
    case 'custom':
      return {
        endAt: Number.isFinite(endAt) ? endAt : undefined,
        period: 'custom' as const,
        startAt: Number.isFinite(startAt) ? startAt! : now,
      };
    case 'this_month':
    default: {
      const start = new Date(date.getFullYear(), date.getMonth(), 1).getTime();
      const end = new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
      return { endAt: end, period: 'this_month' as const, startAt: start };
    }
  }
}

function normalizeSettings(value: unknown): KeywordCounterSettings {
  if (!value || typeof value !== 'object') return defaultKeywordCounterSettings;
  const settings = value as Partial<KeywordCounterSettings>;
  return { enabled: settings.enabled !== false };
}

function normalizeKeywords(value: unknown) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))].slice(0, 8);
}

function normalizeTask(value: unknown): KeywordCounterTask | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<KeywordCounterTask>;
  const keywords = normalizeKeywords(item.keywords);
  if (
    typeof item.id !== 'string' ||
    !keywords.length ||
    (item.type !== 'period_count' && item.type !== 'nth_occurrence') ||
    typeof item.createdAt !== 'number' ||
    typeof item.startAt !== 'number'
  ) {
    return null;
  }
  return {
    completedAt: typeof item.completedAt === 'number' ? item.completedAt : undefined,
    count: typeof item.count === 'number' ? Math.max(0, item.count) : 0,
    createdAt: item.createdAt,
    endAt: typeof item.endAt === 'number' ? item.endAt : undefined,
    firstMatchedAt: typeof item.firstMatchedAt === 'number' ? item.firstMatchedAt : undefined,
    id: item.id,
    keywords,
    lastMatchedAt: typeof item.lastMatchedAt === 'number' ? item.lastMatchedAt : undefined,
    matchCaseSensitive: item.matchCaseSensitive === true,
    period: item.period === 'today' || item.period === 'this_week' || item.period === 'this_month' || item.period === 'this_year' || item.period === 'custom'
      ? item.period
      : 'custom',
    requestedByMessageId: typeof item.requestedByMessageId === 'string' ? item.requestedByMessageId : undefined,
    startAt: item.startAt,
    status: item.status === 'completed' || item.status === 'disabled' ? item.status : 'active',
    targetCount: typeof item.targetCount === 'number' ? Math.max(1, Math.floor(item.targetCount)) : undefined,
    title: typeof item.title === 'string' && item.title.trim() ? item.title.trim() : keywords.join('、'),
    type: item.type,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : item.createdAt,
  };
}

function normalizeEvent(value: unknown): KeywordCounterEvent | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<KeywordCounterEvent>;
  if (
    typeof item.taskId !== 'string' ||
    typeof item.messageId !== 'string' ||
    typeof item.keyword !== 'string' ||
    typeof item.messageCreatedAt !== 'number'
  ) {
    return null;
  }
  return {
    count: typeof item.count === 'number' ? Math.max(1, Math.floor(item.count)) : 1,
    keyword: item.keyword,
    matchedText: typeof item.matchedText === 'string' ? item.matchedText : item.keyword,
    messageCreatedAt: item.messageCreatedAt,
    messageId: item.messageId,
    taskId: item.taskId,
  };
}

function normalizeInsight(value: unknown): KeywordCounterInsight | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<KeywordCounterInsight>;
  if (
    typeof item.id !== 'string' ||
    typeof item.taskId !== 'string' ||
    typeof item.message !== 'string' ||
    typeof item.createdAt !== 'number'
  ) {
    return null;
  }
  return {
    consumedAt: typeof item.consumedAt === 'number' ? item.consumedAt : undefined,
    createdAt: item.createdAt,
    id: item.id,
    message: item.message,
    taskId: item.taskId,
  };
}

function normalizeSnapshot(value: unknown): KeywordCounterSnapshot {
  const candidate = value && typeof value === 'object' ? value as Partial<KeywordCounterSnapshot> : {};
  const tasks = Array.isArray(candidate.tasks)
    ? candidate.tasks.map(normalizeTask).filter((task): task is KeywordCounterTask => !!task)
    : [];
  const events = Array.isArray(candidate.events)
    ? candidate.events.map(normalizeEvent).filter((event): event is KeywordCounterEvent => !!event).slice(-MAX_EVENTS)
    : [];
  const insights = Array.isArray(candidate.insights)
    ? candidate.insights.map(normalizeInsight).filter((insight): insight is KeywordCounterInsight => !!insight).slice(-MAX_INSIGHTS)
    : [];
  return {
    events,
    insights,
    settings: normalizeSettings(candidate.settings),
    tasks,
  };
}

async function loadSnapshot(): Promise<KeywordCounterSnapshot> {
  const raw = await AsyncStorage.getItem(KEYWORD_COUNTER_KEY);
  if (!raw) return { events: [], insights: [], settings: defaultKeywordCounterSettings, tasks: [] };
  try {
    return normalizeSnapshot(JSON.parse(raw) as unknown);
  } catch {
    return { events: [], insights: [], settings: defaultKeywordCounterSettings, tasks: [] };
  }
}

async function saveSnapshot(snapshot: KeywordCounterSnapshot) {
  await AsyncStorage.setItem(KEYWORD_COUNTER_KEY, JSON.stringify({
    ...snapshot,
    events: snapshot.events.slice(-MAX_EVENTS),
    insights: snapshot.insights.slice(-MAX_INSIGHTS),
  }));
}

function countKeyword(content: string, keyword: string, caseSensitive: boolean) {
  if (!keyword) return 0;
  const source = caseSensitive ? content : content.toLocaleLowerCase();
  const needle = caseSensitive ? keyword : keyword.toLocaleLowerCase();
  let count = 0;
  let index = source.indexOf(needle);
  while (index >= 0) {
    count += 1;
    index = source.indexOf(needle, index + needle.length);
  }
  return count;
}

function formatDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    day: 'numeric',
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'long',
    year: 'numeric',
  });
}

function formatPeriodLabel(task: KeywordCounterTask) {
  const date = new Date(task.startAt);
  switch (task.period) {
    case 'today':
      return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    case 'this_week':
      return `${date.getFullYear()}年${date.getMonth() + 1}月第${Math.ceil(date.getDate() / 7)}周`;
    case 'this_year':
      return `${date.getFullYear()}年`;
    case 'this_month':
      return `${date.getFullYear()}年${date.getMonth() + 1}月`;
    case 'custom':
    default:
      return task.endAt ? `${formatDateTime(task.startAt)} 到 ${formatDateTime(task.endAt)}` : `从 ${formatDateTime(task.startAt)} 起`;
  }
}

function buildInsight(task: KeywordCounterTask, now: number): KeywordCounterInsight {
  const keywords = task.keywords.map((keyword) => `“${keyword}”`).join('、');
  const startedAt = formatDateTime(task.startAt);
  const completedAt = formatDateTime(task.type === 'nth_occurrence'
    ? task.lastMatchedAt ?? task.completedAt ?? now
    : task.endAt ?? task.completedAt ?? now);
  const timeRange = `开始记录：${startedAt}\n${task.type === 'nth_occurrence' ? '数够次数' : '统计结束'}：${completedAt}\n\n这些次数是从 ${startedAt} 到 ${completedAt} 累计起来的。`;
  const message = task.type === 'nth_occurrence'
    ? `【关键词计数结果】\nI 在 ${formatDateTime(task.lastMatchedAt ?? now)} 数到 you 第 ${task.targetCount ?? task.count} 次说出 ${keywords}。这是 I 等到的结果，可以按此刻的心情自然回应 you。`
    : `【关键词计数结果】\nI 之前想知道 you 在 ${formatPeriodLabel(task)} 说 ${keywords} 的次数。这段时间已经结束，共数到 ${task.count} 次。这是 I 等到的结果，可以按此刻的心情自然回应 you。`;
  return {
    createdAt: now,
    id: makeId('keyword-insight', now),
    message: `${message}\n\n${timeRange}`,
    taskId: task.id,
  };
}

function completeTask(task: KeywordCounterTask, now: number) {
  return {
    ...task,
    completedAt: now,
    status: 'completed' as const,
    updatedAt: now,
  };
}

function refreshDueTasks(snapshot: KeywordCounterSnapshot, now: number) {
  let changed = false;
  const existingInsightTaskIds = new Set(snapshot.insights.map((insight) => insight.taskId));
  const insights = [...snapshot.insights];
  const tasks = snapshot.tasks.map((task) => {
    if (task.status !== 'active' || task.type !== 'period_count' || !task.endAt || now < task.endAt) {
      return task;
    }
    changed = true;
    const completed = completeTask(task, now);
    if (!existingInsightTaskIds.has(task.id)) {
      insights.push(buildInsight(completed, now));
      existingInsightTaskIds.add(task.id);
    }
    return completed;
  });
  return changed ? { ...snapshot, insights, tasks } : snapshot;
}

function applyMessageToSnapshot(snapshot: KeywordCounterSnapshot, message: SubjectiveMessage, now: number) {
  if (!snapshot.settings.enabled) return snapshot;
  if (message.role !== 'you') return refreshDueTasks(snapshot, now);
  const existingEventKeys = new Set(snapshot.events.map((event) => `${event.taskId}:${event.messageId}:${event.keyword}`));
  const insights = [...snapshot.insights];
  const insightTaskIds = new Set(insights.map((insight) => insight.taskId));
  const events = [...snapshot.events];
  let changed = false;
  const tasks = snapshot.tasks.map((task) => {
    if (task.status !== 'active' || message.createdAt < task.startAt || (task.endAt && message.createdAt >= task.endAt)) {
      return task;
    }
    let addedCount = 0;
    const nextEvents: KeywordCounterEvent[] = [];
    for (const keyword of task.keywords) {
      const eventKey = `${task.id}:${message.id}:${keyword}`;
      if (existingEventKeys.has(eventKey)) continue;
      const count = countKeyword(message.content, keyword, task.matchCaseSensitive);
      if (!count) continue;
      addedCount += count;
      existingEventKeys.add(eventKey);
      nextEvents.push({
        count,
        keyword,
        matchedText: keyword,
        messageCreatedAt: message.createdAt,
        messageId: message.id,
        taskId: task.id,
      });
    }
    if (!addedCount) return task;
    changed = true;
    events.push(...nextEvents);
    const nextTask: KeywordCounterTask = {
      ...task,
      count: task.count + addedCount,
      firstMatchedAt: task.firstMatchedAt ?? message.createdAt,
      lastMatchedAt: message.createdAt,
      updatedAt: now,
    };
    if (nextTask.type === 'nth_occurrence' && nextTask.targetCount && nextTask.count >= nextTask.targetCount) {
      const completed = completeTask(nextTask, now);
      if (!insightTaskIds.has(task.id)) {
        insights.push(buildInsight(completed, message.createdAt));
        insightTaskIds.add(task.id);
      }
      return completed;
    }
    return nextTask;
  });
  const nextSnapshot = changed ? { ...snapshot, events, insights, tasks } : snapshot;
  return refreshDueTasks(nextSnapshot, now);
}

function readRequestObject(value: unknown): KeywordCounterRequest | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const rawType = item.type ?? item.kind ?? item.goal;
  const type = rawType === 'period_count' || rawType === 'period' || rawType === 'count_until_time'
    ? 'period_count'
    : rawType === 'nth_occurrence' || rawType === 'nth' || rawType === 'milestone'
      ? 'nth_occurrence'
      : null;
  const keywords = normalizeKeywords(item.keywords ?? item.keyword);
  if (!type || !keywords.length) return null;
  const rawPeriod = item.period ?? item.range;
  const period: KeywordCounterPeriod | undefined =
    rawPeriod === 'today' || rawPeriod === 'this_week' || rawPeriod === 'this_month' || rawPeriod === 'this_year' || rawPeriod === 'custom'
      ? rawPeriod
      : undefined;
  const targetCount = Number(item.targetCount ?? item.target ?? item.nth ?? item.count);
  const startAt = Number(item.startAt ?? item.startsAt);
  const endAt = Number(item.endAt ?? item.endsAt);
  return {
    endAt: Number.isFinite(endAt) ? endAt : undefined,
    keywords,
    matchCaseSensitive: item.matchCaseSensitive === true,
    period,
    startAt: Number.isFinite(startAt) ? startAt : undefined,
    targetCount: Number.isFinite(targetCount) ? Math.max(1, Math.floor(targetCount)) : undefined,
    title: typeof item.title === 'string' ? item.title.trim() : undefined,
    type,
  };
}

export function extractKeywordCounterRequests(contents: string[]) {
  const requests: KeywordCounterRequest[] = [];
  const cleanedContents = contents
    .map((content) => content.replace(COUNTER_MARKER_PATTERN, (_match, rawJson: string) => {
      try {
        const parsed = JSON.parse(rawJson.trim()) as unknown;
        const entries = Array.isArray(parsed) ? parsed : [parsed];
        entries.forEach((entry) => {
          const request = readRequestObject(entry);
          if (request) requests.push(request);
        });
      } catch {
        // Bad hidden directives are ignored; visible chat should continue normally.
      }
      return '';
    }).trim())
    .filter(Boolean);
  return { cleanedContents, requests };
}

export async function loadKeywordCounterSnapshot() {
  const loaded = await loadSnapshot();
  return loaded.settings.enabled ? refreshDueTasks(loaded, Date.now()) : loaded;
}

export async function canOfferAfterglowCounterIdea() {
  const snapshot = await loadKeywordCounterSnapshot();
  return snapshot.settings.enabled && snapshot.tasks.filter((task) => task.status === 'active').length < 3;
}

export async function saveKeywordCounterSettings(settings: KeywordCounterSettings) {
  return counterMutations.enqueue(async () => {
    const snapshot = await loadSnapshot();
    await saveSnapshot({ ...snapshot, settings: normalizeSettings(settings) });
  });
}

export async function createKeywordCounterTasks(
  requests: KeywordCounterRequest[],
  options: { now?: number; requestedByMessageId?: string; seedMessages?: SubjectiveMessage[]; shouldCommit?: () => boolean | Promise<boolean> } = {},
) {
  return counterMutations.enqueue(async () => {
    if (!requests.length) return [];
    const now = options.now ?? Date.now();
    let snapshot = refreshDueTasks(await loadSnapshot(), now);
    if (!snapshot.settings.enabled) return [];
    const created: KeywordCounterTask[] = [];
    const nextTasks = [...snapshot.tasks];
    for (const request of requests) {
      const period = resolvePeriod(
        request.type === 'period_count' ? request.period ?? 'this_month' : 'custom',
        now,
        request.startAt,
        request.endAt,
      );
      if (request.type === 'nth_occurrence' && !request.targetCount) continue;
      const duplicate = options.requestedByMessageId
        ? nextTasks.find((task) => (
            task.requestedByMessageId === options.requestedByMessageId
            && task.type === request.type
            && task.period === period.period
            && task.targetCount === (request.type === 'nth_occurrence' ? request.targetCount : undefined)
            && task.keywords.length === request.keywords.length
            && task.keywords.every((keyword, index) => keyword === request.keywords[index])
          ))
        : undefined;
      if (duplicate) {
        created.push(duplicate);
        continue;
      }
      if (nextTasks.filter((task) => task.status === 'active').length >= 3) continue;
      const task: KeywordCounterTask = {
        count: 0,
        createdAt: now,
        endAt: request.type === 'period_count' ? period.endAt : undefined,
        id: makeId('keyword-counter', now),
        keywords: request.keywords,
        matchCaseSensitive: request.matchCaseSensitive === true,
        period: period.period,
        requestedByMessageId: options.requestedByMessageId,
        startAt: request.type === 'period_count' ? period.startAt : now,
        status: 'active',
        targetCount: request.type === 'nth_occurrence' ? request.targetCount : undefined,
        title: request.title || `${request.keywords.join('、')}${request.type === 'nth_occurrence' ? `第 ${request.targetCount} 次` : '计数'}`,
        type: request.type,
        updatedAt: now,
      };
      nextTasks.push(task);
      created.push(task);
    }
    snapshot = { ...snapshot, tasks: nextTasks };
    for (const message of options.seedMessages ?? []) {
      if (message.role === 'you') {
        snapshot = applyMessageToSnapshot(snapshot, message, now);
      }
    }
    if (options.shouldCommit && !await options.shouldCommit()) return [];
    await saveSnapshot(snapshot);
    return created;
  });
}

export async function createAfterglowKeywordCounterTask(
  idea: AfterglowCounterIdea,
  options: { generationKey: string; now: number; shouldCommit: () => boolean | Promise<boolean> },
) {
  const end = new Date(options.now);
  const endAt = idea.days === null ? undefined : end.setDate(end.getDate() + idea.days);
  if (endAt !== undefined && (!Number.isFinite(endAt) || endAt <= options.now)) {
    throw new Error('keyword_counter_invalid_end_time');
  }
  return createKeywordCounterTasks([{
    keywords: [idea.keyword],
    period: 'custom',
    startAt: options.now,
    endAt,
    targetCount: idea.targetCount ?? undefined,
    type: idea.targetCount === null ? 'period_count' : 'nth_occurrence',
  }], {
    now: options.now,
    requestedByMessageId: `${options.generationKey}:counterIdea`,
    shouldCommit: options.shouldCommit,
  });
}

export async function recordKeywordCounterMessage(message: SubjectiveMessage) {
  return counterMutations.enqueue(async () => {
    const snapshot = applyMessageToSnapshot(await loadSnapshot(), message, Date.now());
    await saveSnapshot(snapshot);
  });
}

export async function refreshKeywordCounterDeadlines(now = Date.now()) {
  return counterMutations.enqueue(async () => {
    const loaded = await loadSnapshot();
    const snapshot = loaded.settings.enabled ? refreshDueTasks(loaded, now) : loaded;
    await saveSnapshot(snapshot);
  });
}

export async function prepareKeywordCounterInsights(maxCount = 3): Promise<PreparedKeywordCounterInsights> {
  const loaded = await loadSnapshot();
  const preparedAt = Date.now();
  const snapshot = loaded.settings.enabled ? refreshDueTasks(loaded, preparedAt) : loaded;
  if (!snapshot.settings.enabled) {
    return { insightIds: [], prompt: '', preparedAt, taskIds: [] };
  }
  const pending = snapshot.insights.filter((insight) => !insight.consumedAt).slice(0, maxCount);
  return {
    insightIds: pending.map((insight) => insight.id),
    prompt: pending.map((insight) => insight.message).join('\n'),
    preparedAt,
    taskIds: pending.map((insight) => insight.taskId),
  };
}

export async function commitKeywordCounterInsights(insightIds: string[]) {
  return counterMutations.enqueue(async () => {
    const ids = new Set(insightIds);
    if (!ids.size) return;
    const snapshot = await loadSnapshot();
    const consumedAt = Date.now();
    await saveSnapshot({
      ...snapshot,
      insights: snapshot.insights.map((insight) =>
        ids.has(insight.id) && !insight.consumedAt ? { ...insight, consumedAt } : insight,
      ),
    });
  });
}

export async function updateKeywordCounterTaskStatus(taskId: string, status: KeywordCounterStatus) {
  return counterMutations.enqueue(async () => {
    const snapshot = refreshDueTasks(await loadSnapshot(), Date.now());
    if (status === 'active' && snapshot.tasks.some((task) => task.id === taskId && task.status !== 'active')
      && snapshot.tasks.filter((task) => task.status === 'active').length >= 3) return false;
    await saveSnapshot({
      ...snapshot,
      tasks: snapshot.tasks.map((task) =>
        task.id === taskId ? { ...task, status, updatedAt: Date.now() } : task,
      ),
    });
    return true;
  });
}

export async function commitPreparedKeywordCounterInsights(
  preparation: PreparedKeywordCounterInsights,
) {
  return counterMutations.enqueue(async () => {
    const insightIds = new Set(preparation.insightIds);
    const taskIds = new Set(preparation.taskIds);
    if (!insightIds.size && !taskIds.size) return;
    const latest = await loadSnapshot();
    const refreshed = latest.settings.enabled
      ? refreshDueTasks(latest, preparation.preparedAt)
      : latest;
    const consumedAt = Date.now();
    await saveSnapshot({
      ...refreshed,
      insights: refreshed.insights.map((insight) =>
        (insightIds.has(insight.id) || taskIds.has(insight.taskId)) && !insight.consumedAt
          ? { ...insight, consumedAt }
          : insight,
      ),
    });
  });
}

export async function deleteKeywordCounterTask(taskId: string) {
  return counterMutations.enqueue(async () => {
    const snapshot = await loadSnapshot();
    await saveSnapshot({
      ...snapshot,
      events: snapshot.events.filter((event) => event.taskId !== taskId),
      insights: snapshot.insights.filter((insight) => insight.taskId !== taskId),
      tasks: snapshot.tasks.filter((task) => task.id !== taskId),
    });
  });
}
