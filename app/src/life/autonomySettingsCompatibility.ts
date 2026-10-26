const KEY = 'junluo.autonomy.settings.v1';

export function preserveDailyPlanningSettings(currentRaw: string | null | undefined, incomingRaw: string) {
  const read = (raw?: string | null): Record<string, unknown> => {
    try { const value = JSON.parse(raw ?? '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  };
  const current = read(currentRaw), incoming = read(incomingRaw);
  let changed = false;
  if (!('dailyPlanningEnabled' in incoming) && typeof current.dailyPlanningEnabled === 'boolean') {
    incoming.dailyPlanningEnabled = current.dailyPlanningEnabled;
    changed = true;
  }
  if (Number.isSafeInteger(current.dailyPlanningActivatedAt) && Number(current.dailyPlanningActivatedAt) >= 0) {
    const first = Number.isSafeInteger(incoming.dailyPlanningActivatedAt) && Number(incoming.dailyPlanningActivatedAt) >= 0
      ? Math.min(Number(current.dailyPlanningActivatedAt), Number(incoming.dailyPlanningActivatedAt)) : Number(current.dailyPlanningActivatedAt);
    changed ||= incoming.dailyPlanningActivatedAt !== first;
    incoming.dailyPlanningActivatedAt = first;
  }
  return changed ? JSON.stringify(incoming) : incomingRaw;
}

export function restoreDailyPlanningSettings(current: Record<string, string>, incoming: Record<string, string>) {
  const preserved = preserveDailyPlanningSettings(current[KEY], incoming[KEY] ?? '{}');
  return preserved === (incoming[KEY] ?? '{}') ? incoming : { ...incoming, [KEY]: preserved };
}
