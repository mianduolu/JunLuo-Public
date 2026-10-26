import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  setNativePhoneActivityFocusRules,
  reconcilePhoneActivityCollectorRequirement,
  type InstalledPhoneApp,
} from '../backend/phoneActivityNative';
import {
  loadRecentPhoneActivityLogs,
  saveActivityCarePolicySnapshot,
  type PhoneActivityLog,
} from '../phoneActivity/phoneActivityStore';
import { isVisiblePhoneActivityLog } from '../phoneActivity/phoneActivityVisibility';
import type { PhoneRestrictionConfiguration } from '../backend/phoneRestrictionNative';
import {
  mirrorPhoneActivitySettingsWithRestrictionConfiguration,
  PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY,
} from './phoneRestrictionSettings';

const SETTINGS_KEY = PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY;
const STATE_KEY = 'junluo.phoneActivityProactive.state';
const BLACK_THRESHOLD_MINUTES = 15;
const BLACK_RETURN_WINDOW_MINUTES = 10;
const BLACK_DAILY_LIMIT_MINUTES = 60;
const WHITE_THRESHOLD_MINUTES = 30;
const JEALOUSY_COOLDOWN_MINUTES = 2;
const JUNLUO_PACKAGE_ID = 'com.anonymous.junluo';

export type PhoneActivityRuleKind = 'blacklist' | 'whitelist' | 'jealousy';
export type PhoneActivityJealousyCandidateStatus = 'pending' | 'accepted' | 'dismissed';
export type PhoneActivityRuleEventStage =
  | 'first-warning'
  | 'repeat-warning'
  | 'return-after-overlay'
  | 'daily-limit'
  | 'first-praise'
  | 'repeat-praise'
  | 'daily-summary-praise';

export type PhoneActivityJealousyCandidate = {
  id: string;
  title: string;
  source: string;
  reason: string;
  createdAt: number;
  status: PhoneActivityJealousyCandidateStatus;
};

export type PhoneActivityRule = {
  id: string;
  kind: PhoneActivityRuleKind;
  title: string;
  source: string;
  thresholdMinutes: number;
  returnWindowMinutes?: number;
  dailyLimitMinutes?: number;
  cooldownMinutes?: number;
  /** Explicit upgrade opt-in; legacy reminders keep their approved gradual stages. */
  appLock?: boolean;
};

export type PhoneActivityProactiveSettings = {
  enabled: boolean;
  jealousyEnabled?: boolean;
  jealousyCandidateApps?: PhoneActivityJealousyCandidate[];
  jealousyPausedUntil?: number;
  rules: PhoneActivityRule[];
  restrictionConfiguration?: PhoneRestrictionConfiguration;
};

export type PhoneActivityTriggerKind = 'blacklist' | 'blacklist-return' | 'whitelist' | 'jealousy';

export type PhoneActivityTrigger = {
  appTitle: string;
  appSource: string;
  durationMs: number;
  eventStage?: PhoneActivityRuleEventStage;
  kind: PhoneActivityTriggerKind;
  lastTriggeredAt?: number;
  reason: 'current' | 'accumulated' | 'return' | 'jealousy';
  ruleId: string;
  ruleKind: PhoneActivityRuleKind;
  stage: 1 | 2 | 3;
  triggerCount?: number;
  triggerId?: string;
  triggeredAt?: number;
  windowSummary?: string;
};

export type PhoneActivityRuleEventState = {
  firstTriggeredAt: number;
  lastAppTitle: string;
  lastAssistantMessageAt: number;
  lastKind: PhoneActivityTriggerKind | '';
  lastOutcome: 'message-sent' | '';
  lastTriggeredAt: number;
  lastExitAt: number;
  triggerCount: number;
};

type PhoneActivityProactiveState = {
  byRule: Record<string, PhoneActivityRuleEventState>;
};

export const defaultPhoneActivityProactiveSettings: PhoneActivityProactiveSettings = {
  enabled: true,
  jealousyEnabled: false,
  rules: [],
};

const defaultState: PhoneActivityProactiveState = {
  byRule: {},
};

function clampMinutes(value: unknown, fallback: number) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(24 * 60, Math.round(value)));
}

function normalizeSettings(value: unknown): PhoneActivityProactiveSettings {
  if (!value || typeof value !== 'object') return defaultPhoneActivityProactiveSettings;
  const candidate = value as Partial<PhoneActivityProactiveSettings>;
  const rules = Array.isArray(candidate.rules)
    ? candidate.rules
        .map((rule) => normalizeRule(rule))
        .filter((rule): rule is PhoneActivityRule => !!rule)
    : [];
  return {
    enabled: typeof candidate.enabled === 'boolean' ? candidate.enabled : defaultPhoneActivityProactiveSettings.enabled,
    jealousyEnabled: candidate.jealousyEnabled === true,
    jealousyCandidateApps: normalizeJealousyCandidates(candidate.jealousyCandidateApps),
    jealousyPausedUntil: typeof candidate.jealousyPausedUntil === 'number' ? candidate.jealousyPausedUntil : undefined,
    rules,
    ...(candidate.restrictionConfiguration !== undefined
      ? { restrictionConfiguration: candidate.restrictionConfiguration } : {}),
  };
}

function normalizeJealousyCandidates(value: unknown): PhoneActivityJealousyCandidate[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): PhoneActivityJealousyCandidate | null => {
      if (!item || typeof item !== 'object') return null;
      const candidate = item as Partial<PhoneActivityJealousyCandidate>;
      const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
      const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
      if (isJunLuoPhoneApp(source, title)) return null;
      if (!source && !title) return null;
      const status: PhoneActivityJealousyCandidateStatus =
        candidate.status === 'accepted' || candidate.status === 'dismissed' ? candidate.status : 'pending';
      return {
        id: typeof candidate.id === 'string' && candidate.id.trim()
          ? candidate.id
          : buildRuleId('jealousy', source, title),
        title: title || source,
        source,
        reason: typeof candidate.reason === 'string' ? candidate.reason.trim().slice(0, 140) : '',
        createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
        status,
      };
    })
    .filter((item): item is PhoneActivityJealousyCandidate => !!item)
    .slice(-80);
}

function normalizeRule(value: unknown): PhoneActivityRule | null {
  if (!value || typeof value !== 'object') return null;
  const rule = value as Partial<PhoneActivityRule>;
  const kind = rule.kind === 'whitelist'
    ? 'whitelist'
    : rule.kind === 'blacklist'
      ? 'blacklist'
      : rule.kind === 'jealousy'
        ? 'jealousy'
        : null;
  const source = typeof rule.source === 'string' ? rule.source.trim() : '';
  const title = typeof rule.title === 'string' ? rule.title.trim() : '';
  if (isJunLuoPhoneApp(source, title)) return null;
  if (!kind || (!source && !title)) return null;
  const blocksScreen = kind === 'blacklist' || kind === 'jealousy';
  return {
    id: typeof rule.id === 'string' && rule.id.trim() ? rule.id : buildRuleId(kind, source, title),
    kind,
    source,
    title: title || source,
    thresholdMinutes: clampMinutes(rule.thresholdMinutes, blocksScreen ? BLACK_THRESHOLD_MINUTES : WHITE_THRESHOLD_MINUTES),
    returnWindowMinutes:
      blocksScreen
        ? clampMinutes(rule.returnWindowMinutes, BLACK_RETURN_WINDOW_MINUTES)
        : undefined,
    dailyLimitMinutes:
      blocksScreen
        ? clampMinutes(rule.dailyLimitMinutes, BLACK_DAILY_LIMIT_MINUTES)
        : undefined,
    cooldownMinutes: undefined,
    ...(kind === 'blacklist' && rule.appLock === true ? { appLock: true } : {}),
  };
}

function normalizeState(value: unknown): PhoneActivityProactiveState {
  if (!value || typeof value !== 'object') return defaultState;
  const candidate = value as Partial<PhoneActivityProactiveState>;
  const byRule: Record<string, PhoneActivityRuleEventState> = {};
  if (candidate.byRule && typeof candidate.byRule === 'object') {
    Object.entries(candidate.byRule).forEach(([key, state]) => {
      if (!state || typeof state !== 'object') return;
      const entry = state as Partial<PhoneActivityRuleEventState>;
      byRule[key] = {
        firstTriggeredAt: typeof entry.firstTriggeredAt === 'number' ? entry.firstTriggeredAt : 0,
        lastAppTitle: typeof entry.lastAppTitle === 'string' ? entry.lastAppTitle : '',
        lastAssistantMessageAt: typeof entry.lastAssistantMessageAt === 'number' ? entry.lastAssistantMessageAt : 0,
        lastKind: normalizeTriggerKind(entry.lastKind),
        lastOutcome: entry.lastOutcome === 'message-sent' ? 'message-sent' : '',
        lastTriggeredAt: typeof entry.lastTriggeredAt === 'number' ? entry.lastTriggeredAt : 0,
        lastExitAt: typeof entry.lastExitAt === 'number' ? entry.lastExitAt : 0,
        triggerCount: typeof entry.triggerCount === 'number' ? Math.max(0, Math.round(entry.triggerCount)) : 0,
      };
    });
  }
  return { byRule };
}

function normalizeTriggerKind(value: unknown): PhoneActivityTriggerKind | '' {
  return value === 'blacklist' || value === 'blacklist-return' || value === 'whitelist' || value === 'jealousy' ? value : '';
}

function buildRuleId(kind: PhoneActivityRuleKind, source: string, title: string) {
  return `${kind}:${source || title}`.toLowerCase();
}

export function isJunLuoPhoneApp(source?: string, title?: string) {
  const normalizedSource = source?.trim().toLowerCase();
  const normalizedTitle = title?.trim().toLowerCase();
  return normalizedSource === JUNLUO_PACKAGE_ID || normalizedTitle === '君落' || normalizedTitle === 'junluo';
}

function isForegroundLog(log: PhoneActivityLog) {
  return log.kind === 'foreground_app' && log.sensitive_level !== 'blocked' && isVisiblePhoneActivityLog(log);
}

function isDurationLog(log: PhoneActivityLog) {
  return log.kind === 'foreground_app_duration' && log.sensitive_level !== 'blocked' && isVisiblePhoneActivityLog(log);
}

function matchesRule(log: PhoneActivityLog, rule: PhoneActivityRule) {
  const source = log.source?.trim();
  const title = log.title?.trim();
  if (rule.source && source === rule.source) return true;
  if (!rule.source && rule.title && title === rule.title) return true;
  return false;
}

function latestForeground(logs: PhoneActivityLog[]) {
  const latest = logs
    .filter(isForegroundLog)
    .sort((a, b) => b.created_at - a.created_at)[0];
  if (!latest || isJunLuoPhoneApp(latest.source, latest.title)) return undefined;
  return latest;
}

function currentDurationMs(log: PhoneActivityLog, now: number) {
  const startedAt = log.started_at || log.created_at;
  return Math.max(0, now - startedAt);
}

function accumulatedDurationMs(logs: PhoneActivityLog[], rule: PhoneActivityRule) {
  return logs.filter((log) => isDurationLog(log) && matchesRule(log, rule)).reduce((sum, log) => sum + Math.max(0, log.duration_ms || 0), 0);
}

function windowSummaryFor(logs: PhoneActivityLog[], rule: PhoneActivityRule, current?: PhoneActivityLog) {
  const source = rule.source || current?.source || '';
  const title = rule.title || current?.title || '';
  return logs
    .filter((log) => log.sensitive_level !== 'blocked')
    .filter((log) => {
      if (source && log.source === source) return true;
      if (!source && title && log.title === title) return true;
      return current?.id === log.id;
    })
    .map((log) => log.summary?.trim())
    .find((summary) => summary && summary !== title && summary !== source);
}

function stageFor(durationMs: number, thresholdMinutes: number): 1 | 2 | 3 {
  const extraMinutes = durationMs / 60000 - thresholdMinutes;
  if (extraMinutes >= 10 / 60) return 3;
  if (extraMinutes >= 5 / 60) return 2;
  return 1;
}

export function formatPhoneActivityDuration(durationMs: number) {
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}

export function createPhoneActivityRule(kind: PhoneActivityRuleKind, log: PhoneActivityLog): PhoneActivityRule {
  const source = log.source?.trim() || '';
  const title = log.title?.trim() || log.summary?.trim() || source || '未知 App';
  const blocksScreen = kind === 'blacklist' || kind === 'jealousy';
  if (isJunLuoPhoneApp(source, title)) {
    return {
      id: buildRuleId(kind, source, title),
      kind,
      source,
      title,
      thresholdMinutes: blocksScreen ? BLACK_THRESHOLD_MINUTES : WHITE_THRESHOLD_MINUTES,
    };
  }
  return {
    id: buildRuleId(kind, source, title),
    kind,
    source,
    title,
    thresholdMinutes: blocksScreen ? BLACK_THRESHOLD_MINUTES : WHITE_THRESHOLD_MINUTES,
    returnWindowMinutes: blocksScreen ? BLACK_RETURN_WINDOW_MINUTES : undefined,
    dailyLimitMinutes: blocksScreen ? BLACK_DAILY_LIMIT_MINUTES : undefined,
    cooldownMinutes: undefined,
  };
}

export function createPhoneActivityRuleFromApp(kind: PhoneActivityRuleKind, app: InstalledPhoneApp): PhoneActivityRule {
  const source = app.source?.trim() || '';
  const title = app.title?.trim() || source || '未知 App';
  const blocksScreen = kind === 'blacklist' || kind === 'jealousy';
  return {
    id: buildRuleId(kind, source, title),
    kind,
    source,
    title,
    thresholdMinutes: blocksScreen ? BLACK_THRESHOLD_MINUTES : WHITE_THRESHOLD_MINUTES,
    returnWindowMinutes: blocksScreen ? BLACK_RETURN_WINDOW_MINUTES : undefined,
    dailyLimitMinutes: blocksScreen ? BLACK_DAILY_LIMIT_MINUTES : undefined,
    cooldownMinutes: undefined,
  };
}

export async function loadPhoneActivityProactiveSettings() {
  const raw = await AsyncStorage.getItem(SETTINGS_KEY);
  if (!raw) return defaultPhoneActivityProactiveSettings;
  try {
    return normalizeSettings(JSON.parse(raw) as unknown);
  } catch {
    return defaultPhoneActivityProactiveSettings;
  }
}

export async function mirrorPhoneActivityProactiveSettings(
  settings: PhoneActivityProactiveSettings,
) {
  const normalized = normalizeSettings(settings);
  const result = await mirrorPhoneActivitySettingsWithRestrictionConfiguration(normalized, async (payload) => {
    if (!await setNativePhoneActivityFocusRules(payload)) throw new Error('NATIVE_FOCUS_NOT_SAVED');
    await reconcilePhoneActivityCollectorRequirement(Boolean(normalized.enabled ||
      (normalized.jealousyEnabled && normalized.rules.some((rule) => rule.kind === 'jealousy'))));
  });
  if (!result.storageSaved || (result.configuration && !result.nativeSaved) || result.reason) {
    throw new Error(result.reason ?? 'STORAGE_FAILURE');
  }
}

export async function savePhoneActivityProactiveSettings(
  settings: PhoneActivityProactiveSettings,
) {
  const normalized = normalizeSettings(settings);
  await saveActivityCarePolicySnapshot(normalized, 'android');
  await mirrorPhoneActivityProactiveSettings(normalized);
}

async function loadState() {
  const raw = await AsyncStorage.getItem(STATE_KEY);
  if (!raw) return defaultState;
  try {
    return normalizeState(JSON.parse(raw) as unknown);
  } catch {
    return defaultState;
  }
}

async function saveState(state: PhoneActivityProactiveState) {
  await AsyncStorage.setItem(STATE_KEY, JSON.stringify(state));
}

export async function recordPhoneActivityOverlayExit(ruleId: string, now = Date.now()) {
  const state = await loadState();
  const current = state.byRule[ruleId] ?? defaultRuleState();
  await saveState({
    byRule: {
      ...state.byRule,
      [ruleId]: { ...current, lastExitAt: now },
    },
  });
}

export async function markPhoneActivityTrigger(trigger: PhoneActivityTrigger, now = Date.now()) {
  const state = await loadState();
  const current = state.byRule[trigger.ruleId] ?? defaultRuleState();
  const nextCount = current.triggerCount + 1;
  await saveState({
    byRule: {
      ...state.byRule,
      [trigger.ruleId]: {
        ...current,
        firstTriggeredAt: current.firstTriggeredAt || now,
        lastAppTitle: trigger.appTitle,
        lastAssistantMessageAt: now,
        lastKind: trigger.kind,
        lastOutcome: 'message-sent',
        lastTriggeredAt: now,
        lastExitAt: trigger.kind === 'blacklist-return' ? 0 : current.lastExitAt,
        triggerCount: nextCount,
      },
    },
  });
  const { captureActivityFocusTriggerFact } =
    await import('../sync/syncActivityObservationsCapture');
  await captureActivityFocusTriggerFact({
    trigger: {
      triggerId: trigger.triggerId,
      ruleId: trigger.ruleId,
      ruleKind: trigger.ruleKind,
      kind: trigger.kind,
      reason: trigger.reason,
      eventStage: trigger.eventStage,
      appSource: trigger.appSource,
      appTitle: trigger.appTitle,
      durationMs: trigger.durationMs,
      stage: trigger.stage,
      triggeredAt: trigger.triggeredAt ?? now,
    },
    outcome: 'message-sent',
    updatedAt: now,
  }).catch(() => undefined);
}

function defaultRuleState(): PhoneActivityRuleEventState {
  return {
    firstTriggeredAt: 0,
    lastAppTitle: '',
    lastAssistantMessageAt: 0,
    lastKind: '',
    lastOutcome: '',
    lastTriggeredAt: 0,
    lastExitAt: 0,
    triggerCount: 0,
  };
}

function eventStageFor(trigger: Omit<PhoneActivityTrigger, 'eventStage' | 'lastTriggeredAt' | 'triggerCount'>, state: PhoneActivityRuleEventState): PhoneActivityRuleEventStage | undefined {
  if (trigger.ruleKind === 'blacklist') {
    if (trigger.kind === 'blacklist-return') return 'return-after-overlay';
    if (trigger.reason === 'accumulated') return 'daily-limit';
    return state.triggerCount > 0 ? 'repeat-warning' : 'first-warning';
  }
  if (trigger.ruleKind === 'whitelist') {
    if (trigger.reason === 'accumulated') return 'daily-summary-praise';
    return state.triggerCount > 0 ? 'repeat-praise' : 'first-praise';
  }
  return undefined;
}

function withEventState(trigger: Omit<PhoneActivityTrigger, 'eventStage' | 'lastTriggeredAt' | 'triggerCount'>, state: PhoneActivityRuleEventState): PhoneActivityTrigger {
  return {
    ...trigger,
    eventStage: eventStageFor(trigger, state),
    lastTriggeredAt: state.lastTriggeredAt || undefined,
    triggerCount: state.triggerCount,
  };
}

export async function attachPhoneActivityTriggerEventState(trigger: PhoneActivityTrigger, now = Date.now()) {
  const state = await loadState();
  const current = state.byRule[trigger.ruleId] ?? defaultRuleState();
  return {
    ...trigger,
    eventStage: trigger.eventStage ?? eventStageFor(trigger, current),
    lastTriggeredAt: trigger.lastTriggeredAt ?? (current.lastTriggeredAt || undefined),
    triggerCount: trigger.triggerCount ?? current.triggerCount,
  };
}

export async function findPhoneActivityTrigger(now = Date.now()) {
  const settings = await loadPhoneActivityProactiveSettings();
  if ((!settings.enabled && !settings.jealousyEnabled) || !settings.rules.length) return null;

  const logs = await loadRecentPhoneActivityLogs(100);
  if (!logs.length) return null;

  const state = await loadState();
  const current = latestForeground(logs);
  const triggers: PhoneActivityTrigger[] = [];

  for (const rule of settings.rules) {
    const ruleState = state.byRule[rule.id] ?? defaultRuleState();
    const thresholdMs = rule.thresholdMinutes * 60000;

    if (rule.kind === 'jealousy') {
      if (!settings.jealousyEnabled || (settings.jealousyPausedUntil ?? 0) > now || !current || !matchesRule(current, rule)) continue;
      const cooldownMs = (rule.cooldownMinutes ?? JEALOUSY_COOLDOWN_MINUTES) * 60000;
      if (ruleState.lastTriggeredAt && now - ruleState.lastTriggeredAt < cooldownMs) continue;
      const durationMs = currentDurationMs(current, now);
      triggers.push(withEventState({
        appTitle: rule.title,
        appSource: rule.source,
        durationMs,
        kind: 'jealousy',
        reason: 'jealousy',
        ruleId: rule.id,
        ruleKind: rule.kind,
        stage: 1,
        windowSummary: windowSummaryFor(logs, rule, current),
      }, ruleState));
      continue;
    }

    if (!settings.enabled) continue;

    if (rule.kind === 'blacklist' && current && matchesRule(current, rule)) {
      const returnWindowMs = (rule.returnWindowMinutes ?? BLACK_RETURN_WINDOW_MINUTES) * 60000;
      if (ruleState.lastExitAt && now - ruleState.lastExitAt <= returnWindowMs) {
        triggers.push(withEventState({
          appTitle: rule.title,
          appSource: rule.source,
          durationMs: currentDurationMs(current, now),
          kind: 'blacklist-return',
          reason: 'return',
          ruleId: rule.id,
          ruleKind: rule.kind,
          stage: 3,
        }, ruleState));
        continue;
      }
    }

    if (current && matchesRule(current, rule)) {
      const durationMs = currentDurationMs(current, now);
      if (durationMs >= thresholdMs) {
        triggers.push(withEventState({
          appTitle: rule.title,
          appSource: rule.source,
          durationMs,
          kind: rule.kind === 'blacklist' ? 'blacklist' : 'whitelist',
          reason: 'current',
          ruleId: rule.id,
          ruleKind: rule.kind,
          stage: rule.appLock ? 3 : stageFor(durationMs, rule.thresholdMinutes),
        }, ruleState));
        continue;
      }
    }

    const accumulatedMs = accumulatedDurationMs(logs, rule);
    if (accumulatedMs >= thresholdMs) {
      triggers.push(withEventState({
        appTitle: rule.title,
        appSource: rule.source,
        durationMs: accumulatedMs,
        kind: rule.kind === 'blacklist' ? 'blacklist' : 'whitelist',
        reason: 'accumulated',
        ruleId: rule.id,
        ruleKind: rule.kind,
        stage: rule.appLock ? 3 : stageFor(accumulatedMs, rule.thresholdMinutes),
      }, ruleState));
    }
  }

  const returnTrigger = triggers.find((trigger) => trigger.kind === 'blacklist-return');
  if (returnTrigger) return returnTrigger;
  const jealousyTrigger = triggers.find((trigger) => trigger.kind === 'jealousy');
  if (jealousyTrigger) return jealousyTrigger;
  const blackTrigger = triggers.find((trigger) => trigger.kind === 'blacklist');
  if (blackTrigger) return blackTrigger;
  return triggers.find((trigger) => trigger.kind === 'whitelist') ?? null;
}
