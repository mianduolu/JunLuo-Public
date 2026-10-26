import { relationshipAuthorizationStorageBridge as AsyncStorage } from '../sync/syncRelationshipAuthorizationStorageBridge';

export const AUTONOMY_SETTINGS_KEY = 'junluo.autonomy.settings.v1';
const AUTONOMY_SETTINGS_SCHEMA_VERSION = 2;

export type AutonomySettings = {
  dailyPlanningEnabled: boolean;
  dailyPlanningActivatedAt?: number;
  desireDrivenBehaviorEnabled: boolean;
  dreamSleepLoopEnabled: boolean;
  githubVoyageEnabled: boolean;
  masterEnabled: boolean;
  publicPostingEnabled: boolean;
  realtimeRhythmEnabled: boolean;
  schemaVersion: 2;
  webVoyageEnabled: boolean;
  xiaohongshuEnabled: boolean;
};

export const defaultAutonomySettings: AutonomySettings = {
  dailyPlanningEnabled: false,
  desireDrivenBehaviorEnabled: true,
  dreamSleepLoopEnabled: true,
  githubVoyageEnabled: true,
  masterEnabled: true,
  publicPostingEnabled: true,
  realtimeRhythmEnabled: true,
  schemaVersion: AUTONOMY_SETTINGS_SCHEMA_VERSION,
  webVoyageEnabled: true,
  xiaohongshuEnabled: false,
};

function normalizeBoolean(value: unknown, fallback: boolean) {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeAutonomySettings(value: unknown): AutonomySettings {
  const candidate = value && typeof value === 'object' ? value as Partial<AutonomySettings> & { schemaVersion?: unknown } : {};
  const isVersioned = candidate.schemaVersion === AUTONOMY_SETTINGS_SCHEMA_VERSION;
  return {
    dailyPlanningEnabled: normalizeBoolean(candidate.dailyPlanningEnabled, false),
    ...(Number.isSafeInteger(candidate.dailyPlanningActivatedAt) && Number(candidate.dailyPlanningActivatedAt) >= 0
      ? { dailyPlanningActivatedAt: candidate.dailyPlanningActivatedAt } : {}),
    desireDrivenBehaviorEnabled: normalizeBoolean(candidate.desireDrivenBehaviorEnabled, defaultAutonomySettings.desireDrivenBehaviorEnabled),
    dreamSleepLoopEnabled: normalizeBoolean(candidate.dreamSleepLoopEnabled, defaultAutonomySettings.dreamSleepLoopEnabled),
    githubVoyageEnabled: normalizeBoolean((candidate as { githubVoyageEnabled?: unknown }).githubVoyageEnabled, defaultAutonomySettings.githubVoyageEnabled),
    masterEnabled: normalizeBoolean(candidate.masterEnabled, defaultAutonomySettings.masterEnabled),
    publicPostingEnabled: isVersioned
      ? normalizeBoolean(candidate.publicPostingEnabled, defaultAutonomySettings.publicPostingEnabled)
      : defaultAutonomySettings.publicPostingEnabled,
    realtimeRhythmEnabled: normalizeBoolean(candidate.realtimeRhythmEnabled, defaultAutonomySettings.realtimeRhythmEnabled),
    schemaVersion: AUTONOMY_SETTINGS_SCHEMA_VERSION,
    webVoyageEnabled: normalizeBoolean(candidate.webVoyageEnabled, defaultAutonomySettings.webVoyageEnabled),
    xiaohongshuEnabled: normalizeBoolean(candidate.xiaohongshuEnabled, defaultAutonomySettings.xiaohongshuEnabled),
  };
}

function readAutonomySettings(raw: string | null, strict = false) {
  if (raw === null) return defaultAutonomySettings;
  try {
    const value: unknown = JSON.parse(raw);
    if (strict) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-autonomy-settings');
      const record = value as Record<string, unknown>;
      if (typeof record.masterEnabled !== 'boolean') throw new Error('invalid-autonomy-settings');
      if (record.schemaVersion !== undefined && record.schemaVersion !== 1 && record.schemaVersion !== 2) {
        throw new Error('unknown-autonomy-settings-version');
      }
      for (const key of Object.keys(defaultAutonomySettings)) {
        if (key !== 'schemaVersion' && record[key] !== undefined && typeof record[key] !== 'boolean') {
          throw new Error('invalid-autonomy-settings-boolean');
        }
      }
    }
    const normalized = normalizeAutonomySettings(value);
    // Missing legacy route switches are not permission to reopen an outing.
    return strict ? { ...normalized,
      webVoyageEnabled: (value as AutonomySettings).webVoyageEnabled === true,
      githubVoyageEnabled: (value as AutonomySettings).githubVoyageEnabled === true,
    } : normalized;
  } catch (error) {
    if (strict) throw error;
    return defaultAutonomySettings;
  }
}

export async function loadAutonomySettings(options: { strict?: boolean } = {}) {
  return readAutonomySettings(await AsyncStorage.getItem(AUTONOMY_SETTINGS_KEY), options.strict);
}

export async function setPublicExplorationEnabled(enabled: boolean) {
  const raw = await AsyncStorage.getItem(AUTONOMY_SETTINGS_KEY);
  readAutonomySettings(raw, true);
  // Preserve unrelated legacy fields verbatim; this toggle is not a settings migration.
  const current = raw === null ? defaultAutonomySettings : JSON.parse(raw) as AutonomySettings;
  const next = { ...current, webVoyageEnabled: enabled, githubVoyageEnabled: enabled };
  await AsyncStorage.setItem(AUTONOMY_SETTINGS_KEY, JSON.stringify(next));
  return loadAutonomySettings({ strict: true });
}

export async function saveAutonomySettings(settings: AutonomySettings) {
  const current = await loadAutonomySettings();
  const normalized = normalizeAutonomySettings({ ...current, ...settings,
    dailyPlanningActivatedAt: current.dailyPlanningActivatedAt ?? settings.dailyPlanningActivatedAt,
  });
  await AsyncStorage.setItem(AUTONOMY_SETTINGS_KEY, JSON.stringify(normalized));
  return loadAutonomySettings();
}

export async function setDailyPlanningEnabled(enabled: boolean, now = Date.now()) {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid-daily-planning-activation-time');
  const current = await loadAutonomySettings();
  return saveAutonomySettings({ ...current, dailyPlanningEnabled: enabled,
    dailyPlanningActivatedAt: current.dailyPlanningActivatedAt ?? (enabled ? now : undefined),
  });
}

export function isAutonomyFeatureEnabled(settings: AutonomySettings, key: Exclude<keyof AutonomySettings, 'schemaVersion' | 'dailyPlanningActivatedAt'>) {
  if (key === 'masterEnabled') return settings.masterEnabled;
  return settings.masterEnabled && settings[key] === true;
}
