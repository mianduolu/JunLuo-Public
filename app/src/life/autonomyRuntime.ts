import AsyncStorage from '@react-native-async-storage/async-storage';

export const AUTONOMY_RUNTIME_KEY = 'junluo.autonomy.runtime.v1';

type AutonomyRuntimeState = {
  dateKey: string;
  recordedSkipKeys: string[];
};

function dateKey(now = Date.now()) {
  const date = new Date(now);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function normalizeRuntime(value: unknown, now = Date.now()): AutonomyRuntimeState {
  const today = dateKey(now);
  const candidate = value && typeof value === 'object' ? value as Partial<AutonomyRuntimeState> : {};
  if (candidate.dateKey !== today) {
    return { dateKey: today, recordedSkipKeys: [] };
  }
  const keys = Array.isArray(candidate.recordedSkipKeys)
    ? candidate.recordedSkipKeys.filter((item): item is string => typeof item === 'string').slice(-120)
    : [];
  return { dateKey: today, recordedSkipKeys: keys };
}

async function loadAutonomyRuntime(now = Date.now()) {
  const raw = await AsyncStorage.getItem(AUTONOMY_RUNTIME_KEY);
  if (!raw) return normalizeRuntime(undefined, now);
  try {
    return normalizeRuntime(JSON.parse(raw) as unknown, now);
  } catch {
    return normalizeRuntime(undefined, now);
  }
}

async function saveAutonomyRuntime(state: AutonomyRuntimeState) {
  const normalized = normalizeRuntime(state);
  await AsyncStorage.setItem(AUTONOMY_RUNTIME_KEY, JSON.stringify(normalized));
  return normalized;
}

export async function shouldRecordAutonomySkip(key: string, now = Date.now()) {
  const clean = key.replace(/\s+/g, '-').slice(0, 120);
  if (!clean) return false;
  const state = await loadAutonomyRuntime(now);
  if (state.recordedSkipKeys.includes(clean)) return false;
  await saveAutonomyRuntime({ ...state, recordedSkipKeys: [...state.recordedSkipKeys, clean] });
  return true;
}
