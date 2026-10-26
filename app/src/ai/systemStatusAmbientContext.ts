import type { JunLuoToolResult } from '../tools/toolTypes';
import { observeRuntimeWorkload } from '../runtime/runtimeWorkloadDiagnostics';

export type SystemStatusAmbientSource = 'background' | 'proactive';

export type SystemStatusBatterySnapshot = {
  checkedAt?: number;
  isLowPowerModeEnabled?: boolean;
  level: number | null;
  percentage: number | null;
  state: 'unknown' | 'unplugged' | 'charging' | 'full';
};

export type SystemStatusAmbientSnapshot = {
  appState?: string;
  battery: SystemStatusBatterySnapshot;
  checkedAt: number;
  displayTime?: string;
  fetchedAt: number;
  stale: boolean;
};

export type SystemStatusAmbientOptions = {
  allowStaleOnError?: boolean;
  backupRestoreLeaseHeld?: boolean;
  diagnosticParentToken?: number;
  forceRefresh?: boolean;
  now?: number;
  requestedBy?: SystemStatusAmbientSource;
};

export type LowBatteryNudgeDecision = {
  bucket?: number;
  percentage?: number;
  reason?: string;
  shouldSend: boolean;
};

const SYSTEM_STATUS_AMBIENT_TTL_MS = 5 * 60 * 1000;
export const LOW_BATTERY_NUDGE_THRESHOLD_PERCENT = 35;
export const LOW_BATTERY_NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const LOW_BATTERY_NUDGE_BUCKETS = [8, 15, 25, 35] as const;

let cachedSystemStatus: SystemStatusAmbientSnapshot | undefined;
let pendingSystemStatusRefresh: Promise<SystemStatusAmbientSnapshot | null> | undefined;
let pendingSystemStatusRefreshLeaseHeld = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function normalizeBattery(value: unknown): SystemStatusBatterySnapshot | null {
  if (!isRecord(value)) return null;
  const state = value.state === 'unplugged' || value.state === 'charging' || value.state === 'full' || value.state === 'unknown'
    ? value.state
    : 'unknown';
  const percentage = typeof value.percentage === 'number' && Number.isFinite(value.percentage)
    ? Math.max(0, Math.min(100, Math.round(value.percentage)))
    : null;
  const level = typeof value.level === 'number' && Number.isFinite(value.level)
    ? Math.max(0, Math.min(1, value.level))
    : null;
  return {
    checkedAt: typeof value.checkedAt === 'number' && Number.isFinite(value.checkedAt) ? value.checkedAt : undefined,
    isLowPowerModeEnabled: typeof value.isLowPowerModeEnabled === 'boolean' ? value.isLowPowerModeEnabled : undefined,
    level,
    percentage,
    state,
  };
}

function normalizeSystemStatusData(data: unknown, fetchedAt: number): SystemStatusAmbientSnapshot | null {
  if (!isRecord(data)) return null;
  const battery = normalizeBattery(data.battery);
  if (!battery) return null;
  const time = isRecord(data.time) ? data.time : {};
  return {
    appState: typeof data.appState === 'string' ? data.appState : undefined,
    battery,
    checkedAt: typeof data.checkedAt === 'number' && Number.isFinite(data.checkedAt) ? data.checkedAt : fetchedAt,
    displayTime: typeof time.displayText === 'string' ? time.displayText : undefined,
    fetchedAt,
    stale: false,
  };
}

async function executeSystemStatusTool(
  requestedBy: SystemStatusAmbientSource,
  now: number,
  backupRestoreLeaseHeld?: boolean,
  diagnosticParentToken?: number,
) {
  const { executeAgentToolCall } = await observeRuntimeWorkload(
    'tools.agent_runtime_import',
    () => import('../tools/toolAgentExecution'),
    undefined,
    { parentToken: diagnosticParentToken },
  );
  return executeAgentToolCall({
    callId: `ambient-system-status-${requestedBy}-${now}`,
    createdAt: now,
    input: { locale: 'zh-CN' },
    requestedBy,
    sourceMessageId: `ambient-system-status:${requestedBy}`,
    toolId: 'system_status.get_device_status',
  }, {
    backupRestoreLeaseHeld,
    deferAuditPersistenceUntilFinal: true,
    diagnosticParentToken,
  });
}

function markStale(snapshot: SystemStatusAmbientSnapshot): SystemStatusAmbientSnapshot {
  return { ...snapshot, stale: true };
}

export function getCachedSystemStatusAmbientSnapshot(now = Date.now()) {
  if (!cachedSystemStatus) return null;
  return {
    ...cachedSystemStatus,
    stale: cachedSystemStatus.stale || now - cachedSystemStatus.fetchedAt > SYSTEM_STATUS_AMBIENT_TTL_MS,
  };
}

export async function refreshSystemStatusAmbientSnapshot(
  options: SystemStatusAmbientOptions = {},
): Promise<SystemStatusAmbientSnapshot | null> {
  const now = options.now ?? Date.now();
  const requestedBy = options.requestedBy ?? 'background';
  const backupRestoreLeaseHeld = options.backupRestoreLeaseHeld === true;
  const cached = getCachedSystemStatusAmbientSnapshot(now);
  if (!options.forceRefresh && cached && !cached.stale) return cached;
  if (
    !options.forceRefresh
    && pendingSystemStatusRefresh
    && pendingSystemStatusRefreshLeaseHeld === backupRestoreLeaseHeld
  ) return pendingSystemStatusRefresh;

  const refresh = executeSystemStatusTool(
    requestedBy,
    now,
    backupRestoreLeaseHeld,
    options.diagnosticParentToken,
  )
    .then((result: JunLuoToolResult) => {
      if (!result.ok) return null;
      const snapshot = normalizeSystemStatusData(result.data, now);
      if (snapshot) cachedSystemStatus = snapshot;
      return snapshot;
    })
    .catch(() => null)
    .then((snapshot) => {
      if (snapshot) return snapshot;
      return options.allowStaleOnError && cachedSystemStatus ? markStale(cachedSystemStatus) : null;
    })
    .finally(() => {
      if (pendingSystemStatusRefresh === refresh) pendingSystemStatusRefresh = undefined;
      if (!pendingSystemStatusRefresh) pendingSystemStatusRefreshLeaseHeld = false;
    });

  pendingSystemStatusRefresh = refresh;
  pendingSystemStatusRefreshLeaseHeld = backupRestoreLeaseHeld;
  return refresh;
}

function formatBatteryState(state: SystemStatusBatterySnapshot['state']) {
  if (state === 'charging') return '充电中';
  if (state === 'full') return '已充满';
  if (state === 'unplugged') return '未充电';
  return '充电状态未知';
}

export function formatSystemStatusAmbientContext(snapshot: SystemStatusAmbientSnapshot | null) {
  if (!snapshot) return '';
  const lines: string[] = [];
  if (snapshot.displayTime) lines.push(`当前时间：${snapshot.displayTime}。`);
  if (typeof snapshot.battery.percentage === 'number') {
    lines.push(`手机电量：${snapshot.battery.percentage}%，${formatBatteryState(snapshot.battery.state)}。`);
  } else {
    lines.push(`手机电量：未知，${formatBatteryState(snapshot.battery.state)}。`);
  }
  if (typeof snapshot.battery.isLowPowerModeEnabled === 'boolean') {
    lines.push(`低电量模式：${snapshot.battery.isLowPowerModeEnabled ? '已开启' : '未开启'}。`);
  }
  if (snapshot.appState) lines.push(`App 状态：${snapshot.appState}。`);
  if (snapshot.stale) lines.push('这份系统状态来自较早的工具回执，可能已经变化；不要把它说成刚刚实时读取。');
  return lines.length ? `【时间与设备状态】\n${lines.join('\n')}` : '';
}

export async function buildSystemStatusAmbientContext(options: SystemStatusAmbientOptions = {}) {
  const snapshot = await refreshSystemStatusAmbientSnapshot({
    allowStaleOnError: true,
    ...options,
  });
  return formatSystemStatusAmbientContext(snapshot);
}

export function getCachedSystemStatusAmbientContext(now = Date.now()) {
  return formatSystemStatusAmbientContext(getCachedSystemStatusAmbientSnapshot(now));
}

export function getLowBatteryNudgeBucket(percentage: number | null | undefined) {
  if (typeof percentage !== 'number' || !Number.isFinite(percentage)) return null;
  if (percentage > LOW_BATTERY_NUDGE_THRESHOLD_PERCENT) return null;
  return LOW_BATTERY_NUDGE_BUCKETS.find((bucket) => percentage <= bucket) ?? LOW_BATTERY_NUDGE_THRESHOLD_PERCENT;
}

function sameDate(left: number, right: number) {
  const localDateKey = (value: number) => {
    const date = new Date(value);
    return [
      date.getFullYear(),
      String(date.getMonth() + 1).padStart(2, '0'),
      String(date.getDate()).padStart(2, '0'),
    ].join('-');
  };
  return localDateKey(left) === localDateKey(right);
}

export function assessLowBatteryNudge(
  snapshot: SystemStatusAmbientSnapshot | null,
  options: {
    lastBatteryNudgeBucket?: number;
    lastSystemStatusNudgeAt?: number;
    now?: number;
  } = {},
): LowBatteryNudgeDecision {
  if (!snapshot) return { shouldSend: false, reason: 'no-system-status' };
  if (snapshot.stale) return { shouldSend: false, reason: 'stale-system-status' };
  const percentage = snapshot.battery.percentage;
  const bucket = getLowBatteryNudgeBucket(percentage);
  if (!bucket || typeof percentage !== 'number') return { shouldSend: false, reason: 'battery-not-low' };
  if (snapshot.battery.state !== 'unplugged') return { bucket, percentage, shouldSend: false, reason: 'battery-charging' };

  const now = options.now ?? Date.now();
  const lastAt = options.lastSystemStatusNudgeAt;
  if (typeof lastAt === 'number' && Number.isFinite(lastAt)) {
    if (sameDate(lastAt, now) && options.lastBatteryNudgeBucket === bucket) {
      return { bucket, percentage, shouldSend: false, reason: 'same-bucket-today' };
    }
    if (now - lastAt < LOW_BATTERY_NUDGE_COOLDOWN_MS) {
      return { bucket, percentage, shouldSend: false, reason: 'cooldown' };
    }
  }
  return { bucket, percentage, shouldSend: true };
}

export function buildLowBatteryNudgeMessage(percentage: number) {
  return `小仓鼠，手机电量只剩 ${percentage}% 了！><该充电啦！如果就这样等到没电关机的话，白云小姐就看不到你了……🥺`;
}

export function clearSystemStatusAmbientCacheForTests() {
  cachedSystemStatus = undefined;
  pendingSystemStatusRefresh = undefined;
}

