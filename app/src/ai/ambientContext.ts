import { loadScheduleItemsForDate } from '../schedule/scheduleStore';
import { loadOpenTodoItems, loadTodayTodoItems } from '../schedule/todoStore';
import { fetchCurrentWeather, loadStoredWeather } from '../utils/weather';
import type { WeatherState } from '../types/weather';
import {
  buildSystemStatusAmbientContext,
  getCachedSystemStatusAmbientContext,
} from './systemStatusAmbientContext';
import { buildAmbientLifeMaterialFingerprint } from './ambientLifeMaterialFingerprint';
import { resolvePromiseWithFallback } from '../utils/promiseDeadline';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';

export type AmbientSnapshot = {
  fetchedAt: number;
  openTodos: Awaited<ReturnType<typeof loadOpenTodoItems>>;
  phoneActivityContext?: string;
  systemStatusContext?: string;
  todaySchedule: Awaited<ReturnType<typeof loadScheduleItemsForDate>>;
  todayTodos: Awaited<ReturnType<typeof loadTodayTodoItems>>;
  weather?: WeatherState;
};

export type AmbientContextOptions = {
  allowNetwork?: boolean;
  backupRestoreLeaseHeld?: boolean;
  categories?: AmbientContextCategory[];
  diagnosticParentToken?: number;
  forceRefresh?: boolean;
  includeUnavailable?: AmbientContextCategory[];
};

export type AmbientContextCategory =
  | 'time'
  | 'weather'
  | 'location'
  | 'schedule'
  | 'systemStatus'
  | 'todos'
  | 'phoneActivity';

const ALL_AMBIENT_CATEGORIES: AmbientContextCategory[] = [
  'time',
  'weather',
  'location',
  'schedule',
  'systemStatus',
  'todos',
  'phoneActivity',
];
const AMBIENT_CACHE_TTL_MS = 60 * 1000;
const AMBIENT_REFRESH_TIMEOUT_MS = 20 * 1000;
let cachedAmbientSnapshot: AmbientSnapshot | undefined;
export function getCachedAmbientSnapshot(): AmbientSnapshot | undefined {
  return cachedAmbientSnapshot;
}
let pendingAmbientRefresh: Promise<AmbientSnapshot> | undefined;
let pendingAmbientAllowsNetwork = false;
let pendingAmbientRefreshLeaseHeld = false;
let ambientRefreshGeneration = 0;

function buildAmbientFallbackSnapshot(): AmbientSnapshot {
  return cachedAmbientSnapshot ?? {
    fetchedAt: Date.now(),
    openTodos: [],
    phoneActivityContext: undefined,
    systemStatusContext: getCachedSystemStatusAmbientContext(),
    todaySchedule: [],
    todayTodos: [],
    weather: undefined,
  };
}

function getDayPeriod(date: Date) {
  const hour = date.getHours();
  if (hour < 5) return '深夜';
  if (hour < 7) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '深夜';
}

function formatDateTime(date: Date) {
  return date.toLocaleString('zh-CN', {
    hour: '2-digit',
    hour12: false,
    minute: '2-digit',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    year: 'numeric',
  });
}

function formatTime(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function loadAmbientSnapshot(
  allowNetwork: boolean,
  backupRestoreLeaseHeld?: boolean,
  diagnosticParentToken?: number,
  categories = ALL_AMBIENT_CATEGORIES,
): Promise<AmbientSnapshot> {
  const now = new Date();
  const selected = new Set(categories);
  const [weather, todaySchedule, todayTodos, openTodos, systemStatusContext] = await Promise.all([
    selected.has('weather') || selected.has('location')
      ? loadWeatherForAmbientContext(allowNetwork)
      : Promise.resolve(undefined),
    selected.has('schedule') ? loadScheduleItemsForDate(now).catch(() => []) : Promise.resolve([]),
    selected.has('todos') ? loadTodayTodoItems().catch(() => []) : Promise.resolve([]),
    selected.has('todos') ? loadOpenTodoItems(8).catch(() => []) : Promise.resolve([]),
    selected.has('systemStatus')
      ? observeRuntimeWorkload(
          'ambient.system_status',
          (span) => buildSystemStatusAmbientContext({
            backupRestoreLeaseHeld,
            diagnosticParentToken: span?.token,
            requestedBy: 'background',
          }).catch(() => getCachedSystemStatusAmbientContext()),
          undefined,
          { parentToken: diagnosticParentToken },
        )
      : Promise.resolve(undefined),
  ]);
  const phoneActivityContext = selected.has('phoneActivity')
    ? await observeRuntimeWorkload(
        'ambient.phone_activity',
        (span) => loadPhoneActivityForAmbientContext(backupRestoreLeaseHeld, span?.token)
          .catch(() => undefined),
        undefined,
        { parentToken: diagnosticParentToken },
      )
    : undefined;
  return {
    fetchedAt: Date.now(),
    openTodos,
    phoneActivityContext,
    systemStatusContext,
    todaySchedule,
    todayTodos,
    weather,
  };
}

async function loadWeatherForAmbientContext(allowNetwork: boolean) {
  if (!allowNetwork) return loadStoredWeather().catch(() => undefined);
  try {
    const weather = await fetchCurrentWeather();
    if (!weather.error) return weather;
    return (await loadStoredWeather().catch(() => undefined)) ?? weather;
  } catch {
    return loadStoredWeather().catch(() => undefined);
  }
}

async function loadPhoneActivityForAmbientContext(
  backupRestoreLeaseHeld?: boolean,
  diagnosticParentToken?: number,
) {
  const { executeAgentToolCall } = await observeRuntimeWorkload(
    'tools.agent_runtime_import',
    () => import('../tools/toolAgentExecution'),
    undefined,
    { parentToken: diagnosticParentToken },
  );
  const result = await executeAgentToolCall({
    input: { minutes: 30 },
    requestedBy: 'background',
    toolId: 'phone_context.summarize_recent_activity',
  }, {
    backupRestoreLeaseHeld,
    deferAuditPersistenceUntilFinal: true,
    diagnosticParentToken,
  });
  return result.ok ? result.summary : undefined;
}

async function getAmbientSnapshot(options: AmbientContextOptions) {
  const allowNetwork = options.allowNetwork !== false;
  const backupRestoreLeaseHeld = options.backupRestoreLeaseHeld === true;
  if (options.categories?.length === 1 && options.categories[0] === 'time') {
    return buildAmbientFallbackSnapshot();
  }
  if (options.categories) {
    return loadAmbientSnapshot(
      allowNetwork,
      backupRestoreLeaseHeld,
      options.diagnosticParentToken,
      options.categories,
    );
  }
  if (
    !options.forceRefresh
    && cachedAmbientSnapshot
    && Date.now() - cachedAmbientSnapshot.fetchedAt < AMBIENT_CACHE_TTL_MS
  ) {
    return cachedAmbientSnapshot;
  }
  if (!allowNetwork && cachedAmbientSnapshot) return cachedAmbientSnapshot;
  if (
    pendingAmbientRefresh
    && pendingAmbientRefreshLeaseHeld === backupRestoreLeaseHeld
    && (!options.forceRefresh || pendingAmbientAllowsNetwork || !allowNetwork)
  ) {
    return pendingAmbientRefresh;
  }

  pendingAmbientAllowsNetwork = allowNetwork;
  const generation = ++ambientRefreshGeneration;
  const actualRefresh = observeRuntimeWorkload(
    'ambient.snapshot_actual',
    (span) => loadAmbientSnapshot(allowNetwork, backupRestoreLeaseHeld, span?.token),
    (snapshot) => ({
      itemCount: snapshot.todaySchedule.length + snapshot.todayTodos.length + snapshot.openTodos.length,
    }),
    { parentToken: options.diagnosticParentToken },
  );
  const refresh = resolvePromiseWithFallback(
    actualRefresh,
    buildAmbientFallbackSnapshot(),
    AMBIENT_REFRESH_TIMEOUT_MS,
  )
    .then((snapshot) => {
      if (generation === ambientRefreshGeneration) {
        cachedAmbientSnapshot = snapshot;
      }
      return snapshot;
    })
    .finally(() => {
      if (pendingAmbientRefresh === refresh) {
        pendingAmbientRefresh = undefined;
        pendingAmbientAllowsNetwork = false;
        pendingAmbientRefreshLeaseHeld = false;
      }
    });
  pendingAmbientRefresh = refresh;
  pendingAmbientRefreshLeaseHeld = backupRestoreLeaseHeld;
  return refresh;
}

function formatAmbientContext(
  snapshot: AmbientSnapshot,
  categories = ALL_AMBIENT_CATEGORIES,
  includeUnavailable = ALL_AMBIENT_CATEGORIES,
) {
  const now = new Date();
  const {
    openTodos,
    phoneActivityContext,
    systemStatusContext,
    todaySchedule,
    todayTodos,
    weather,
  } = snapshot;
  const upcomingSchedule = todaySchedule
    .filter((item) => item.scheduledStartAt >= Date.now() - 15 * 60 * 1000)
    .slice(0, 5)
    .map((item) => `${formatTime(item.scheduledStartAt)} ${item.title}${item.notes ? `：${item.notes}` : ''}`);
  const selected = new Set(categories);
  const showUnavailable = new Set(includeUnavailable);
  const lines: string[] = [];
  if (selected.has('time')) {
    lines.push(`时间：${formatDateTime(now)}，${getDayPeriod(now)}。`);
  }
  if (selected.has('systemStatus')) {
    if (systemStatusContext) {
      lines.push(systemStatusContext);
    } else if (showUnavailable.has('systemStatus')) {
      lines.push('时间与设备状态：暂无可用工具回执。');
    }
  }
  if (selected.has('location')) {
    if (weather?.placeLabel) lines.push(`位置：${weather.placeLabel}。`);
    else if (showUnavailable.has('location')) lines.push('位置：暂无可用信息。');
  }
  if (selected.has('weather')) {
    if (weather && !weather.error) {
      lines.push(`天气：${weather.label}${weather.temperature === undefined ? '' : ` ${weather.temperature}°C`}。`);
    } else if (weather?.label) {
      lines.push(`天气：${weather.label}${weather.temperature === undefined ? '' : ` ${weather.temperature}°C`}（可能不准确）。`);
    } else if (showUnavailable.has('weather')) {
      lines.push('天气：暂无可用信息。');
    }
  }
  if (selected.has('schedule')) {
    if (upcomingSchedule.length) lines.push(`今日日程：${upcomingSchedule.join('；')}。`);
    else if (showUnavailable.has('schedule')) lines.push('今日日程：暂无可用信息。');
  }
  if (selected.has('todos')) {
    const todoLines = [
      ...todayTodos.slice(0, 5).map((item) => item.title),
      ...openTodos.filter((item) => item.status === 'inbox').slice(0, 5).map((item) => item.title),
    ];
    if (todoLines.length) lines.push(`待办：${[...new Set(todoLines)].join('；')}。`);
    else if (showUnavailable.has('todos')) lines.push('待办：暂无可用信息。');
  }
  if (selected.has('phoneActivity')) {
    if (phoneActivityContext) lines.push(phoneActivityContext);
    else if (showUnavailable.has('phoneActivity')) lines.push('手机活动：暂无可用信息。');
  }
  return lines.length ? `【当前环境】\n${lines.join('\n')}` : '';
}

export async function buildAmbientContext(options: AmbientContextOptions = {}) {
  return formatAmbientContext(
    await getAmbientSnapshot(options),
    options.categories,
    options.categories ? options.includeUnavailable ?? [] : undefined,
  );
}

export function getCachedAmbientContext(options: Pick<AmbientContextOptions, 'categories' | 'includeUnavailable'> = {}) {
  return cachedAmbientSnapshot
    ? formatAmbientContext(
        cachedAmbientSnapshot,
        options.categories,
        options.categories ? options.includeUnavailable ?? [] : undefined,
      )
    : '';
}
export function getCachedAmbientLifeMaterialFingerprint(now = Date.now()) {
  return buildAmbientLifeMaterialFingerprint({
    now,
    openTodos: cachedAmbientSnapshot?.openTodos ?? [],
    todaySchedule: cachedAmbientSnapshot?.todaySchedule ?? [],
    todayTodos: cachedAmbientSnapshot?.todayTodos ?? [],
    weather: cachedAmbientSnapshot?.weather,
  });
}


export function getAmbientTimeContext() {
  const now = new Date();
  return `【当前环境】\n时间：${formatDateTime(now)}，${getDayPeriod(now)}。`;
}

export async function prewarmAmbientContext(diagnosticParentToken?: number) {
  return buildAmbientContext({ allowNetwork: false, diagnosticParentToken });
}
