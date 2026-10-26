import type { ScreenName } from '../types/navigation';

export const AUTOMATIC_REMOTE_AI_POLICY_KEY =
  'junluo.runtime.automaticRemoteAiPolicy.v1' as const;

export type AutomaticRemoteAiPolicy = {
  enabled: boolean;
  version: 1;
  costSaving?: CostSavingSettings;
};

export type CostSavingWindow = { enabled: boolean; startMinute: number; endMinute: number };
export type CostSavingSettings = {
  enabled: boolean;
  weekdays: number[];
  windows: [CostSavingWindow, CostSavingWindow];
};

export type AutomaticAiPurpose =
  | 'proactive-contact' | 'inner-wants' | 'inner-affect' | 'home-status'
  | 'dream' | 'life-diary' | 'web-voyage' | 'manual-chat' | 'day-plan' | 'sleep-decision' | 'shiying-pickup' | 'shiying-review' | 'other';

export const defaultCostSavingSettings: CostSavingSettings = {
  enabled: false,
  weekdays: [1, 2, 3, 4, 5],
  windows: [
    { enabled: true, startMinute: 9 * 60, endMinute: 12 * 60 },
    { enabled: true, startMinute: 14 * 60, endMinute: 18 * 60 },
  ],
};

export function normalizeCostSavingSettings(value: unknown): CostSavingSettings {
  const fallback = (): CostSavingSettings => ({
    ...defaultCostSavingSettings,
    weekdays: [...defaultCostSavingSettings.weekdays],
    windows: defaultCostSavingSettings.windows.map(window => ({ ...window })) as CostSavingSettings['windows'],
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback();
  const candidate = value as Partial<CostSavingSettings>;
  if (typeof candidate.enabled !== 'boolean' || !Array.isArray(candidate.weekdays)
    || !candidate.weekdays.every(day => Number.isInteger(day) && day >= 0 && day <= 6)
    || !Array.isArray(candidate.windows) || candidate.windows.length !== 2
    || !candidate.windows.every(window => window && typeof window === 'object'
      && typeof window.enabled === 'boolean'
      && Number.isInteger(window.startMinute) && window.startMinute >= 0 && window.startMinute < 1440
      && Number.isInteger(window.endMinute) && window.endMinute >= 0 && window.endMinute < 1440
      && window.startMinute !== window.endMinute)) return fallback();
  return {
    enabled: candidate.enabled,
    weekdays: [...new Set(candidate.weekdays)].sort((a, b) => a - b),
    windows: candidate.windows.map(({ enabled, startMinute, endMinute }) => ({ enabled, startMinute, endMinute })) as CostSavingSettings['windows'],
  };
}

export function getAutomaticCostRestriction(input: {
  policy: AutomaticRemoteAiPolicy;
  baseUrl: string;
  now: number;
  purpose: AutomaticAiPurpose;
}): { restricted: boolean; mode: 'allow' | 'wait' | 'limited'; retryAt?: number } {
  const allowed = { restricted: false, mode: 'allow' as const };
  const settings = normalizeCostSavingSettings(input.policy.costSaving);
  if (!settings.enabled || !Number.isFinite(input.now)) return allowed;
  try {
    const url = new URL(input.baseUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'api.deepseek.com'
      || url.username || url.password || (url.port && url.port !== '443')) return allowed;
  } catch { return allowed; }

  // All weekday and clock arithmetic uses fixed Beijing time, never the device timezone.
  const dayMs = 24 * 60 * 60 * 1000;
  const offset = 8 * 60 * 60 * 1000;
  const today = Math.floor((input.now + offset) / dayMs) * dayMs - offset;
  const intervals: Array<{ start: number; end: number }> = [];
  for (let day = -1; day <= 7; day += 1) {
    const midnight = today + day * dayMs;
    if (!settings.weekdays.includes(new Date(midnight + offset).getUTCDay())) continue;
    for (const window of settings.windows) {
      if (!window.enabled) continue;
      intervals.push({ start: midnight + window.startMinute * 60_000,
        end: midnight + window.endMinute * 60_000 + (window.endMinute < window.startMinute ? dayMs : 0) });
    }
  }
  intervals.sort((a, b) => a.start - b.start);
  let end: number | undefined;
  for (const interval of intervals) {
    if (end === undefined) {
      if (interval.start <= input.now && input.now < interval.end) end = interval.end;
    } else if (interval.start <= end) end = Math.max(end, interval.end);
    else break;
  }
  if (end === undefined) return allowed;
  const mode = input.purpose === 'inner-wants' || input.purpose === 'inner-affect' || input.purpose === 'home-status'
    ? 'limited' : input.purpose === 'proactive-contact' || input.purpose === 'dream' || input.purpose === 'life-diary' || input.purpose === 'web-voyage' || input.purpose === 'shiying-pickup' || input.purpose === 'shiying-review'
      ? 'wait' : 'allow';
  // A full repeating week can be continuously restricted; it has no finite next allowed instant.
  return { restricted: true, mode, ...(end < input.now + 7 * dayMs ? { retryAt: end } : {}) };
}

export const defaultAutomaticRemoteAiPolicy: AutomaticRemoteAiPolicy = Object.freeze({
  enabled: false,
  version: 1,
});

const TECHNICAL_RUNTIME_SILENT_SCREENS = new Set<ScreenName>([
  'settings',
  'device-sync',
  'tool-settings',
  'appearance',
  'ai-settings',
  'ai-diagnostics',
  'phone-manager',
  'memory-settings',
  'proactive-settings',
  'relationship-settings',
  'prompt-diagnostics',
  'voice-call-settings',
  'camera-perception',
  'nearby-world',
  'body-signal',
  'backup',
]);

export function normalizeAutomaticRemoteAiPolicy(
  value: unknown,
): AutomaticRemoteAiPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultAutomaticRemoteAiPolicy;
  }
  const candidate = value as Partial<AutomaticRemoteAiPolicy>;
  if (candidate.version !== 1 || typeof candidate.enabled !== 'boolean') {
    return defaultAutomaticRemoteAiPolicy;
  }
  return { enabled: candidate.enabled, version: 1,
    ...(candidate.costSaving === undefined ? {} : { costSaving: normalizeCostSavingSettings(candidate.costSaving) }) };
}

export function parseAutomaticRemoteAiPolicy(
  raw: string | null,
): AutomaticRemoteAiPolicy {
  if (!raw) return defaultAutomaticRemoteAiPolicy;
  try {
    return normalizeAutomaticRemoteAiPolicy(JSON.parse(raw) as unknown);
  } catch {
    return defaultAutomaticRemoteAiPolicy;
  }
}

export function isTechnicalRuntimeSilentScreen(screen: ScreenName) {
  return TECHNICAL_RUNTIME_SILENT_SCREENS.has(screen);
}

export function isAutomaticRemoteAiAllowed(
  policy: AutomaticRemoteAiPolicy,
  screen?: ScreenName,
) {
  return policy.enabled && (!screen || !isTechnicalRuntimeSilentScreen(screen));
}
