import { Linking, NativeModules, Platform } from 'react-native';
import type { PhoneGuardEvent, PhoneGuardStatus } from '../proactive/phoneGuardDelivery';

export type InstalledPhoneApp = {
  source: string;
  title: string;
};

export type PhoneLaunchableAppEntry = {
  packageName: string; componentName: string; profileSerial: string;
  isCurrentProfile: boolean; profileType?: string; title: string;
  badgeLabel?: string; iconUri?: string;
};
export type PhoneLaunchableAppInventory = {
  available: boolean; complete: boolean; reason?: string; entries: PhoneLaunchableAppEntry[];
};
export type PhoneAppEntryLaunchResult = { available: boolean; launched: boolean; reason?: string };

export type OwnAppPhoneUsageResult = {
  available: boolean;
  source: string;
  title: string;
  days: Array<{ dateKey: string; durationMs: number }>;
  reason?: string;
};

export type PhoneActivityPermissionStatus = {
  usageAccess: boolean;
  notificationListener: boolean;
  accessibility: boolean;
  overlay: boolean;
  collectorRunning: boolean;
  windowSummaryEnabled: boolean;
  pausedUntil: number;
};

export type PhoneActivityPermissionStatusResult = {
  available: boolean;
  status: PhoneActivityPermissionStatus;
};

export type AccessibilityActionResult = {
  ok: boolean;
  reason: string;
};

export type AccessibilitySnapshotNode = {
  className?: string;
  clickable?: boolean;
  description?: string;
  editable?: boolean;
  scrollable?: boolean;
  text?: string;
  viewId?: string;
};

export type AccessibilitySnapshot = AccessibilityActionResult & {
  className?: string;
  nodes?: AccessibilitySnapshotNode[];
  packageName?: string;
};

type JunLuoPhoneActivityNative = {
  getLaunchableAppEntries?: () => Promise<PhoneLaunchableAppInventory | string>;
  launchAppEntry?: (entry: Pick<PhoneLaunchableAppEntry, 'packageName' | 'componentName' | 'profileSerial'>) => Promise<PhoneAppEntryLaunchResult | string>;
  getPhoneCareFollowUp?: () => Promise<string | null>;
  compareAndSetPhoneCareFollowUp?: (revision: number, valueJson: string) => Promise<boolean>;
  releasePhoneCareFollowUpDispatch?: () => Promise<boolean>;
  getPhoneCareUsageSnapshot?: () => Promise<string | null>;
  initialLaunchRequest?: string;
  clickAccessibilityText: (text: string) => Promise<string>;
  getPermissionStatus: () => Promise<PhoneActivityPermissionStatus>;
  getPhoneActivityLogs: (sinceMs: number, limit: number) => Promise<string>;
  getOwnAppUsageStats?: (days: number) => Promise<string>;
  getAccessibilitySnapshot: (maxNodes: number) => Promise<string>;
  inputAccessibilityText: (text: string) => Promise<string>;
  launchInstalledApp: (packageName: string) => Promise<string>;
  openAccessibilitySettings: () => void;
  openOverlaySettings: () => void;
  openNotificationListenerSettings: () => void;
  openUsageAccessSettings: () => void;
  performAccessibilityBack: () => Promise<string>;
  runXiaohongshuBrowseAutomation: (packageName: string) => Promise<string>;
  scrollAccessibilityWindow: (direction: string) => Promise<string>;
  swipeAccessibilityPoint: (startX: number, startY: number, endX: number, endY: number, durationMs: number) => Promise<string>;
  tapAccessibilityPoint: (x: number, y: number) => Promise<string>;
  canDrawOverlays: () => Promise<boolean>;
  consumeLastFocusOverlayExit: () => Promise<{ ruleId: string; exitedAt: number } | null>;
  consumePhoneGuardLaunchRequest: () => Promise<string>;
  consumePendingFocusTrigger: () => Promise<string>;
  peekPendingFocusTrigger?: () => Promise<string>;
  clearPendingFocusTrigger?: (triggerId: string) => Promise<boolean>;
  getFocusTriggerState?: (triggerId: string) => Promise<string | null>;
  claimFocusTriggerAttempt?: (triggerId: string) => Promise<string | null>;
  finishFocusTrigger?: (triggerId: string, status: string) => Promise<boolean>;
  updateFocusOverlayMessageForTrigger?: (ruleId: string, triggerId: string, message: string) => Promise<boolean>;
  dismissFocusOverlay: () => Promise<boolean>;
  getInstalledApps: () => Promise<InstalledPhoneApp[]>;
  getFocusDebugStatus: () => Promise<string>;
  setFocusRules: (settingsJson: string) => Promise<boolean>;
  setPausedUntil: (pausedUntil: number) => Promise<boolean>;
  setWindowSummaryEnabled: (enabled: boolean) => Promise<boolean>;
  showFocusOverlay: (resourceName: string, stage: number, message: string, ruleId: string) => Promise<boolean>;
  startPhoneGuardMessageTask: (payloadJson: string) => Promise<boolean>;
  startCollector: () => Promise<boolean>;
  reconcileCollectorRequirement?: () => Promise<boolean>;
  quiesceCollectorForRestore?: () => Promise<boolean>;
  getPhoneActivityLogsPageForRestore?: (afterCreatedAt: number, afterId: string, limit: number) => Promise<string>;
  discardPhoneActivityLogsForRestore?: () => Promise<boolean>;
  resumeCollectorAfterRestore?: () => Promise<boolean>;
  stopCollector: () => Promise<boolean>;
  updateFocusOverlayMessage: (ruleId: string, message: string) => Promise<boolean>;
};

const nativeModule = NativeModules.JunLuoPhoneActivity as JunLuoPhoneActivityNative | undefined;

export async function readPhoneLaunchableAppEntries(): Promise<PhoneLaunchableAppInventory> {
  const fail = (reason: string): PhoneLaunchableAppInventory => ({ available: false, complete: false, reason, entries: [] });
  if (Platform.OS !== 'android' || !nativeModule?.getLaunchableAppEntries || !nativeModule.launchAppEntry) return fail('NATIVE_UNAVAILABLE');
  try {
    const raw = await nativeModule.getLaunchableAppEntries();
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value.available !== 'boolean' || typeof value.complete !== 'boolean' || !Array.isArray(value.entries)) return fail('INVALID_NATIVE_RESULT');
    for (const entry of value.entries) {
      if (!entry || !['packageName', 'componentName', 'profileSerial', 'title'].every(key => typeof entry[key] === 'string' && entry[key].trim())
        || !/^\d+$/.test(entry.profileSerial) || typeof entry.isCurrentProfile !== 'boolean'
        || ['profileType', 'badgeLabel', 'iconUri'].some(key => entry[key] !== undefined && typeof entry[key] !== 'string')) return fail('INVALID_NATIVE_RESULT');
    }
    return value as PhoneLaunchableAppInventory;
  } catch { return fail('APP_LIST_READ_FAILED'); }
}

export async function launchPhoneAppEntry(entry: PhoneLaunchableAppEntry): Promise<PhoneAppEntryLaunchResult> {
  if (Platform.OS !== 'android' || !nativeModule?.launchAppEntry) return { available: false, launched: false, reason: 'NATIVE_UNAVAILABLE' };
  try {
    const raw = await nativeModule.launchAppEntry({ packageName: entry.packageName, componentName: entry.componentName, profileSerial: entry.profileSerial });
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value.available !== 'boolean' || typeof value.launched !== 'boolean') throw new Error('INVALID_NATIVE_RESULT');
    return value;
  } catch { return { available: true, launched: false, reason: 'LAUNCH_OUTCOME_UNKNOWN' }; }
}

/** UI-only system usage. Existing activity logs and model material retain their original filters. */
export async function readOwnAppPhoneUsage(days = 7): Promise<OwnAppPhoneUsageResult> {
  const unavailable = (reason: string): OwnAppPhoneUsageResult => ({
    available: false, source: 'com.anonymous.junluo', title: '君落', days: [], reason,
  });
  if (!isPhoneActivityNativeAvailable() || typeof nativeModule?.getOwnAppUsageStats !== 'function') {
    return unavailable('NATIVE_UNAVAILABLE');
  }
  try {
    const count = Number.isFinite(days) ? Math.max(1, Math.min(14, Math.round(days))) : 7;
    const parsed: unknown = JSON.parse(await nativeModule.getOwnAppUsageStats(count));
    if (!parsed || typeof parsed !== 'object') return unavailable('SYSTEM_USAGE_INVALID');
    const result = parsed as Partial<OwnAppPhoneUsageResult>;
    if (typeof result.available !== 'boolean' || typeof result.source !== 'string' || !result.source.trim()
      || typeof result.title !== 'string' || !result.title.trim() || !Array.isArray(result.days)
      || (result.reason !== undefined && typeof result.reason !== 'string')
      || result.days.length > count || !result.days.every(day => day && typeof day.dateKey === 'string'
        && /^\d{4}-\d{2}-\d{2}$/.test(day.dateKey) && Number.isSafeInteger(day.durationMs) && day.durationMs >= 0)
      || new Set(result.days.map(day => day.dateKey)).size !== result.days.length
      || (result.available && !result.days.length)) return unavailable('SYSTEM_USAGE_INVALID');
    return { available: result.available, source: result.source, title: result.title,
      days: result.available ? result.days : [], ...(result.reason ? { reason: result.reason } : {}) };
  } catch {
    return unavailable('SYSTEM_USAGE_READ_FAILED');
  }
}

export async function readNativePhoneCareFollowUp() {
  const raw = await nativeModule?.getPhoneCareFollowUp?.();
  return raw ? JSON.parse(raw) as import('../proactive/phoneCareFollowUp').PhoneCareFollowUp : null;
}

export async function writeNativePhoneCareFollowUp(revision: number, value: import('../proactive/phoneCareFollowUp').PhoneCareFollowUp) {
  return await nativeModule?.compareAndSetPhoneCareFollowUp?.(revision, JSON.stringify(value)) ?? false;
}

export async function releaseNativePhoneCareDispatch() {
  await nativeModule?.releasePhoneCareFollowUpDispatch?.();
}

export async function readNativePhoneCareUsage() {
  const raw = await nativeModule?.getPhoneCareUsageSnapshot?.();
  return raw ? JSON.parse(raw) as { observedAt: number; usingManagedApp: boolean } : null;
}

function parsePhoneGuardEvent(raw: string | null | undefined, triggerId: string): PhoneGuardEvent | null {
  if (!raw) return null;
  const parsed = JSON.parse(raw) as Partial<PhoneGuardEvent> & { createdAt?: number };
  const item = {
    ...parsed,
    triggeredAt: parsed.triggeredAt ?? parsed.createdAt,
    attempts: parsed.attempts ?? 0,
    status: parsed.status ?? 'pending',
  } as PhoneGuardEvent;
  return item.triggerId === triggerId && typeof item.ruleId === 'string'
    && Number.isFinite(item.triggeredAt) && Number.isInteger(item.attempts)
    && item.attempts >= 0 && item.attempts <= 2
    && ['pending', 'succeeded', 'failed', 'disabled', 'blocked', 'cancelled'].includes(item.status)
    ? item : null;
}

export async function getPhoneGuardEvent(triggerId: string) {
  return parsePhoneGuardEvent(await nativeModule?.getFocusTriggerState?.(triggerId), triggerId);
}

export async function claimPhoneGuardAttempt(triggerId: string) {
  return parsePhoneGuardEvent(await nativeModule?.claimFocusTriggerAttempt?.(triggerId), triggerId);
}

export async function finishPhoneGuardEvent(triggerId: string, status: PhoneGuardStatus) {
  return await nativeModule?.finishFocusTrigger?.(triggerId, status) ?? false;
}

export async function updatePhoneGuardEventMessage(ruleId: string, triggerId: string, message: string) {
  return await nativeModule?.updateFocusOverlayMessageForTrigger?.(ruleId, triggerId, message) ?? false;
}

function hasPhoneActivityRestoreNativeContract(
  module: JunLuoPhoneActivityNative | undefined,
): module is JunLuoPhoneActivityNative & Required<Pick<
  JunLuoPhoneActivityNative,
  | 'quiesceCollectorForRestore'
  | 'getPhoneActivityLogsPageForRestore'
  | 'discardPhoneActivityLogsForRestore'
  | 'resumeCollectorAfterRestore'
>> {
  return !!module
    && typeof module.quiesceCollectorForRestore === 'function'
    && typeof module.getPhoneActivityLogsPageForRestore === 'function'
    && typeof module.discardPhoneActivityLogsForRestore === 'function'
    && typeof module.resumeCollectorAfterRestore === 'function';
}

export type PhoneGuardLaunchRequest = {
  createdAt: number;
  ruleId: string;
  source: 'phone-guard';
  targetScreen: 'chat';
  triggerId: string;
};

function parsePhoneGuardLaunchRequest(raw: string | undefined | null) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PhoneGuardLaunchRequest;
    return parsed?.targetScreen === 'chat' ? parsed : null;
  } catch {
    return null;
  }
}

let initialPhoneGuardLaunchRequestConsumed = false;

const unavailableStatus: PhoneActivityPermissionStatus = {
  usageAccess: false,
  notificationListener: false,
  accessibility: false,
  overlay: false,
  collectorRunning: false,
  windowSummaryEnabled: true,
  pausedUntil: 0,
};

export function isPhoneActivityNativeAvailable() {
  return Platform.OS === 'android' && !!nativeModule;
}

export async function getPhoneActivityPermissionStatusResult(): Promise<PhoneActivityPermissionStatusResult> {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) {
    return { available: false, status: unavailableStatus };
  }
  try {
    return {
      available: true,
      status: await nativeModule.getPermissionStatus(),
    };
  } catch {
    return { available: false, status: unavailableStatus };
  }
}

export async function getPhoneActivityPermissionStatus() {
  return (await getPhoneActivityPermissionStatusResult()).status;
}

export function openPhoneUsageAccessSettings() {
  if (typeof nativeModule?.openUsageAccessSettings === 'function') nativeModule.openUsageAccessSettings();
}

export function openPhoneNotificationListenerSettings() {
  if (typeof nativeModule?.openNotificationListenerSettings === 'function') nativeModule.openNotificationListenerSettings();
}

export function openPhoneAccessibilitySettings() {
  if (typeof nativeModule?.openAccessibilitySettings === 'function') nativeModule.openAccessibilitySettings();
}

export function openPhoneOverlaySettings() {
  if (typeof nativeModule?.openOverlaySettings === 'function') {
    nativeModule.openOverlaySettings();
    return;
  }
  void Linking.openSettings();
}

export async function canDrawPhoneActivityOverlay() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.canDrawOverlays();
  } catch {
    return false;
  }
}

export async function showPhoneActivityOverlay(resourceName: string, stage: number, message: string, ruleId: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.showFocusOverlay(resourceName, stage, message, ruleId);
  } catch {
    return false;
  }
}

export async function updatePhoneActivityOverlayMessage(ruleId: string, message: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.updateFocusOverlayMessage !== 'function') return false;
  try {
    return await nativeModule.updateFocusOverlayMessage(ruleId, message);
  } catch {
    return false;
  }
}

export async function startPhoneGuardMessageTask(payloadJson: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.startPhoneGuardMessageTask !== 'function') return false;
  try {
    return await nativeModule.startPhoneGuardMessageTask(payloadJson);
  } catch {
    return false;
  }
}

export async function dismissPhoneActivityOverlay() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.dismissFocusOverlay();
  } catch {
    return false;
  }
}

export async function consumePhoneGuardLaunchRequest() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.consumePhoneGuardLaunchRequest !== 'function') return null;
  try {
    const raw = await nativeModule.consumePhoneGuardLaunchRequest();
    return parsePhoneGuardLaunchRequest(raw);
  } catch {
    return null;
  }
}

export function consumeInitialPhoneGuardLaunchRequest() {
  if (initialPhoneGuardLaunchRequestConsumed || !isPhoneActivityNativeAvailable() || !nativeModule) return null;
  initialPhoneGuardLaunchRequestConsumed = true;
  return parsePhoneGuardLaunchRequest(nativeModule.initialLaunchRequest);
}

export async function getInstalledPhoneApps() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.getInstalledApps !== 'function') return [];
  try {
    return await nativeModule.getInstalledApps();
  } catch {
    return [];
  }
}

export async function getPhoneActivityFocusDebugStatus() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.getFocusDebugStatus !== 'function') return '当前安装包还没有调试状态接口。';
  try {
    return await nativeModule.getFocusDebugStatus();
  } catch {
    return '读取调试状态失败。';
  }
}

export async function setNativePhoneActivityFocusRules(settingsJson: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.setFocusRules !== 'function') return false;
  try {
    return await nativeModule.setFocusRules(settingsJson);
  } catch {
    return false;
  }
}

export async function consumeLastPhoneActivityOverlayExit() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return null;
  try {
    return await nativeModule.consumeLastFocusOverlayExit();
  } catch {
    return null;
  }
}

export async function consumePendingPhoneActivityFocusTrigger() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.consumePendingFocusTrigger !== 'function') return null;
  try {
    const raw = typeof nativeModule.peekPendingFocusTrigger === 'function'
      ? await nativeModule.peekPendingFocusTrigger()
      : await nativeModule.consumePendingFocusTrigger();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      appTitle: string;
      appSource: string;
      durationMs: number;
      triggerId?: string;
      triggeredAt?: number;
      createdAt?: number;
      kind: 'blacklist' | 'blacklist-return' | 'jealousy';
      ruleKind?: 'blacklist' | 'jealousy';
      ruleId: string;
      stage: 1 | 2 | 3;
    };
    const triggeredAt = parsed.triggeredAt
      ?? parsed.createdAt
      ?? Date.now();
    const { captureActivityFocusTriggerFact } =
      await import('../sync/syncActivityObservationsCapture');
    await captureActivityFocusTriggerFact({
      trigger: {
        triggerId: parsed.triggerId,
        ruleId: parsed.ruleId,
        ruleKind: parsed.ruleKind,
        kind: parsed.kind,
        appSource: parsed.appSource,
        appTitle: parsed.appTitle,
        durationMs: parsed.durationMs,
        stage: parsed.stage,
        triggeredAt,
      },
      outcome: 'observed',
      updatedAt: Date.now(),
    }).catch(() => undefined);
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingPhoneActivityFocusTrigger(triggerId: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || !triggerId.trim()) return false;
  if (typeof nativeModule.clearPendingFocusTrigger !== 'function') {
    // Older Dev Clients consumed the trigger while reading it, so there is
    // nothing left for JavaScript to acknowledge explicitly.
    return true;
  }
  try {
    return await nativeModule.clearPendingFocusTrigger(triggerId.trim());
  } catch {
    return false;
  }
}

export async function loadNativePhoneActivityLogs(sinceMs = 0, limit = 100) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.getPhoneActivityLogs !== 'function') return [];
  try {
    const raw = await nativeModule.getPhoneActivityLogs(sinceMs, limit);
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function startPhoneActivityCollector() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.startCollector();
  } catch {
    return false;
  }
}

/** Native code combines legacy collection with the saved restriction executor demand. */
export async function reconcilePhoneActivityCollectorRequirement(legacyRequired: boolean) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  if (typeof nativeModule.reconcileCollectorRequirement === 'function') {
    try { return await nativeModule.reconcileCollectorRequirement(); } catch { return false; }
  }
  // Older development APKs retain their old behavior until the new native package is installed.
  return legacyRequired ? startPhoneActivityCollector() : stopPhoneActivityCollector();
}

export async function quiescePhoneActivityCollectorForRestore() {
  if (Platform.OS !== 'android') return true;
  if (!hasPhoneActivityRestoreNativeContract(nativeModule)) return false;
  try {
    return await nativeModule.quiesceCollectorForRestore();
  } catch {
    return false;
  }
}

export async function loadNativePhoneActivityLogsPageForRestore(
  afterCreatedAt: number,
  afterId: string,
  limit: number,
): Promise<unknown[]> {
  if (Platform.OS !== 'android' || !hasPhoneActivityRestoreNativeContract(nativeModule)) {
    throw new Error('当前开发版缺少手机活动恢复分页接口。');
  }
  const raw = await nativeModule.getPhoneActivityLogsPageForRestore(afterCreatedAt, afterId, limit);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('手机活动恢复分页接口返回了无效数据。');
  return parsed;
}

export async function discardNativePhoneActivityLogsForRestore() {
  if (Platform.OS !== 'android') return true;
  if (!hasPhoneActivityRestoreNativeContract(nativeModule)) return false;
  try {
    return await nativeModule.discardPhoneActivityLogsForRestore();
  } catch {
    return false;
  }
}

export async function resumePhoneActivityCollectorAfterRestore() {
  if (Platform.OS !== 'android') return true;
  if (!hasPhoneActivityRestoreNativeContract(nativeModule)) return false;
  try {
    return await nativeModule.resumeCollectorAfterRestore();
  } catch {
    return false;
  }
}

export async function stopPhoneActivityCollector() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.stopCollector();
  } catch {
    return false;
  }
}

export async function pausePhoneActivityCollector(minutes: number) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  const pausedUntil = Date.now() + minutes * 60 * 1000;
  try {
    return await nativeModule.setPausedUntil(pausedUntil);
  } catch {
    return false;
  }
}

export async function setPhoneWindowSummaryEnabled(enabled: boolean) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.setWindowSummaryEnabled(enabled);
  } catch {
    return false;
  }
}

function parseAccessibilityResult(raw: string | undefined | null): AccessibilityActionResult {
  if (!raw) return { ok: false, reason: 'EMPTY_RESULT' };
  try {
    const parsed = JSON.parse(raw) as Partial<AccessibilityActionResult>;
    return {
      ok: parsed.ok === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : parsed.ok === true ? 'OK' : 'UNKNOWN',
    };
  } catch {
    return { ok: false, reason: 'INVALID_RESULT' };
  }
}

export async function getPhoneAccessibilitySnapshot(maxNodes = 80): Promise<AccessibilitySnapshot> {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.getAccessibilitySnapshot !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    const raw = await nativeModule.getAccessibilitySnapshot(maxNodes);
    const parsed = JSON.parse(raw) as AccessibilitySnapshot;
    return {
      ...parsed,
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      ok: parsed.ok === true,
      reason: typeof parsed.reason === 'string' ? parsed.reason : parsed.ok === true ? 'OK' : 'UNKNOWN',
    };
  } catch {
    return { ok: false, reason: 'SNAPSHOT_FAILED' };
  }
}

export async function clickPhoneAccessibilityText(text: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.clickAccessibilityText !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.clickAccessibilityText(text));
  } catch {
    return { ok: false, reason: 'CLICK_FAILED' };
  }
}

export async function inputPhoneAccessibilityText(text: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.inputAccessibilityText !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.inputAccessibilityText(text));
  } catch {
    return { ok: false, reason: 'INPUT_FAILED' };
  }
}

export async function scrollPhoneAccessibilityWindow(direction: 'backward' | 'forward' | 'up' | 'down' = 'forward') {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.scrollAccessibilityWindow !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.scrollAccessibilityWindow(direction));
  } catch {
    return { ok: false, reason: 'SCROLL_FAILED' };
  }
}

export async function performPhoneAccessibilityBack() {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.performAccessibilityBack !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.performAccessibilityBack());
  } catch {
    return { ok: false, reason: 'BACK_FAILED' };
  }
}

export async function launchPhoneApp(packageName: string) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.launchInstalledApp !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.launchInstalledApp(packageName));
  } catch {
    return { ok: false, reason: 'LAUNCH_FAILED' };
  }
}

export async function runNativeXiaohongshuBrowseAutomation(packageName: string): Promise<AccessibilityActionResult & {
  adSkipped?: boolean;
  movedCount?: number;
  openReason?: string;
  openedNote?: boolean;
  pageAfter?: string;
  pageBefore?: string;
  pageForAction?: string;
  packageName?: string;
  readSnapshot?: AccessibilitySnapshot;
  returnedHome?: boolean;
  returnedToJunLuo?: boolean;
  snapshot?: AccessibilitySnapshot;
}> {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.runXiaohongshuBrowseAutomation !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    const raw = await nativeModule.runXiaohongshuBrowseAutomation(packageName);
    const parsed = JSON.parse(raw) as Partial<AccessibilityActionResult> & {
      adSkipped?: boolean;
      movedCount?: number;
      openReason?: string;
      openedNote?: boolean;
      pageAfter?: string;
      pageBefore?: string;
      pageForAction?: string;
      packageName?: string;
      readSnapshot?: AccessibilitySnapshot;
      returnedHome?: boolean;
      returnedToJunLuo?: boolean;
      snapshot?: AccessibilitySnapshot;
    };
    return {
      adSkipped: parsed.adSkipped === true,
      movedCount: typeof parsed.movedCount === 'number' ? parsed.movedCount : 0,
      openReason: typeof parsed.openReason === 'string' ? parsed.openReason : undefined,
      openedNote: parsed.openedNote === true,
      ok: parsed.ok === true,
      pageAfter: typeof parsed.pageAfter === 'string' ? parsed.pageAfter : undefined,
      pageBefore: typeof parsed.pageBefore === 'string' ? parsed.pageBefore : undefined,
      pageForAction: typeof parsed.pageForAction === 'string' ? parsed.pageForAction : undefined,
      packageName: typeof parsed.packageName === 'string' ? parsed.packageName : undefined,
      readSnapshot: parsed.readSnapshot,
      reason: typeof parsed.reason === 'string' ? parsed.reason : parsed.ok === true ? 'OK' : 'UNKNOWN',
      returnedHome: parsed.returnedHome === true,
      returnedToJunLuo: parsed.returnedToJunLuo === true,
      snapshot: parsed.snapshot,
    };
  } catch {
    return { ok: false, reason: 'NATIVE_BROWSE_FAILED' };
  }
}

export async function tapPhoneAccessibilityPoint(x: number, y: number) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.tapAccessibilityPoint !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.tapAccessibilityPoint(Math.round(x), Math.round(y)));
  } catch {
    return { ok: false, reason: 'TAP_FAILED' };
  }
}

export async function swipePhoneAccessibilityPoint(startX: number, startY: number, endX: number, endY: number, durationMs = 420) {
  if (!isPhoneActivityNativeAvailable() || !nativeModule || typeof nativeModule.swipeAccessibilityPoint !== 'function') {
    return { ok: false, reason: 'NATIVE_UNAVAILABLE' };
  }
  try {
    return parseAccessibilityResult(await nativeModule.swipeAccessibilityPoint(
      Math.round(startX),
      Math.round(startY),
      Math.round(endX),
      Math.round(endY),
      Math.round(durationMs),
    ));
  } catch {
    return { ok: false, reason: 'SWIPE_FAILED' };
  }
}
