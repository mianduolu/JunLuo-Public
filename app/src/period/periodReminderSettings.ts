import AsyncStorage from '@react-native-async-storage/async-storage';
import { sanitizeRetiredAssistantStorage } from '../ai/retiredAssistantFeatureData';
import {
  loadPeriodReminderSettingsRecord,
  savePeriodReminderSettingsRecord,
} from './periodStore';

const PERIOD_REMINDER_SETTINGS_KEY = 'junluo.period.reminderSettings.v1';

export type PeriodReminderSettings = {
  careEnabled: boolean;
  careFrequency: 'standard';
  mutedDateKey?: string;
};

export const defaultPeriodReminderSettings: PeriodReminderSettings = {
  careEnabled: true,
  careFrequency: 'standard',
};

function normalizePeriodReminderSettings(
  value: Partial<PeriodReminderSettings>,
): PeriodReminderSettings {
  return {
    careEnabled: value.careEnabled !== false,
    careFrequency: 'standard',
    mutedDateKey: typeof value.mutedDateKey === 'string'
      ? value.mutedDateKey
      : undefined,
  };
}

export async function loadPeriodReminderSettings(): Promise<PeriodReminderSettings> {
  const raw = await AsyncStorage.getItem(PERIOD_REMINDER_SETTINGS_KEY);
  if (raw) {
    const cleaned = sanitizeRetiredAssistantStorage({ [PERIOD_REMINDER_SETTINGS_KEY]: raw }).storage[PERIOD_REMINDER_SETTINGS_KEY];
    if (cleaned !== raw) await AsyncStorage.setItem(PERIOD_REMINDER_SETTINGS_KEY, cleaned);
  }
  const shared = await loadPeriodReminderSettingsRecord();
  if (shared) {
    return {
      careEnabled: shared.careEnabled,
      careFrequency: 'standard',
      mutedDateKey: shared.mutedDateKey ?? undefined,
    };
  }
  let settings = defaultPeriodReminderSettings;
  try {
    if (raw) {
      settings = normalizePeriodReminderSettings(
        JSON.parse(raw) as Partial<PeriodReminderSettings>,
      );
    }
  } catch {
    settings = defaultPeriodReminderSettings;
  }
  await savePeriodReminderSettingsRecord({
    ...settings,
    mutedDateKey: settings.mutedDateKey ?? null,
  });
  return settings;
}

export async function savePeriodReminderSettings(settings: PeriodReminderSettings) {
  const normalized = normalizePeriodReminderSettings(settings);
  await savePeriodReminderSettingsRecord({
    ...normalized,
    mutedDateKey: normalized.mutedDateKey ?? null,
  });
  await AsyncStorage.setItem(
    PERIOD_REMINDER_SETTINGS_KEY,
    JSON.stringify(normalized),
  );
}
