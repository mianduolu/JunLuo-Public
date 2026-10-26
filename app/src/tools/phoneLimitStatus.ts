import { parsePhoneRestrictionConfiguration, type PhoneRestrictionInstance } from '../backend/phoneRestrictionNative';
import type { OwnAppPhoneUsageResult } from '../backend/phoneActivityNative';
import { isVisiblePhoneUsageApp } from '../phoneActivity/phoneActivityVisibility';
import { parsePhoneRestrictionManagement } from '../phoneRestriction/phoneRestrictionManagement';
import { formatPhoneUsageDuration } from '../phoneRestriction/phoneUsageFormatting';
import { parsePhoneRestrictionAppTimeRule, parsePhoneRestrictionPlanInput } from '../proactive/phoneRestrictionSchedule';
import { phoneLimitCanAdjust, phoneLimitCanCreatePlan, phoneLimitCanReleasePackage,
  phoneLimitNewStartOptions, phoneLimitPlanEditable } from './phoneLimitEligibility';

type Row = Record<string, unknown>;
export function phoneLimitObject(value: unknown): Row | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
}
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const time = (v: unknown, zero = false): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= (zero ? 0 : 1);
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every(text) && new Set(v).size === v.length;
const map = (pairs: [string, unknown][]) => Object.fromEntries(pairs);

function appName(s: PhoneLimitStatusSources, pkg: string): string | null {
  const installed = s.names?.[pkg];
  if (text(installed) && installed !== pkg) return installed;
  const focus = phoneLimitObject(s.query?.focusSettings);
  for (const value of Array.isArray(focus?.rules) ? focus.rules : []) {
    const rule = phoneLimitObject(value);
    if (rule?.source === pkg && text(rule.title) && rule.title !== pkg) return rule.title;
  }
  for (const value of s.logs?.available ? s.logs.logs : []) {
    const log = phoneLimitObject(value);
    if (log?.device_id === 'junluo-android' && log.source === pkg && text(log.title) && log.title !== pkg) return log.title;
  }
  return null;
}

export type PhoneLimitQuerySource = {
  schemaVersion: 1; observedAt: number; timeZoneId: string; localDate: string; dayStart: number;
  state: unknown; focusSettings: unknown; usage: unknown; display: unknown; timeBlockedApps: unknown;
};
export type PhoneLimitStatusSources = {
  query: PhoneLimitQuerySource | null;
  names: Record<string, string> | null;
  logs: { available: boolean; truncated: boolean; logs: unknown[] } | null;
  ownUsage: OwnAppPhoneUsageResult | null;
  settings: unknown;
};
export type PhoneLimitStatusReceipt = {
  ok: boolean; status: 'success' | 'error'; summary: string; data: Row | null;
};

// Each instant uses the phone's actual zone, including historical/future DST.
export function phoneLimitLocalInstant(value: unknown, zone: string): string | null {
  if (!time(value, true) || value > 8_640_000_000_000_000) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(value);
    const p = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const wall = new Date(0);
    wall.setUTCFullYear(Number(p.year), Number(p.month) - 1, Number(p.day));
    wall.setUTCHours(Number(p.hour), Number(p.minute), Number(p.second), 0);
    const offset = (wall.getTime() - Math.floor(value / 1000) * 1000) / 60_000;
    if (!Number.isInteger(offset) || Math.abs(offset) > 24 * 60 || p.year.length !== 4) return null;
    const abs = Math.abs(offset);
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset < 0 ? '-' : '+'}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  } catch { return null; }
}

export function parsePhoneLimitQuery(value: unknown): PhoneLimitQuerySource | null {
  const q = phoneLimitObject(value);
  if (!q || q.schemaVersion !== 1 || !time(q.observedAt) || !time(q.dayStart)
    || q.dayStart > q.observedAt || !text(q.timeZoneId) || !text(q.localDate)
    || phoneLimitLocalInstant(q.observedAt, q.timeZoneId)?.slice(0, 10) !== q.localDate
    || phoneLimitLocalInstant(q.dayStart, q.timeZoneId)?.slice(0, 10) !== q.localDate) return null;
  return q as PhoneLimitQuerySource;
}

function instance(value: unknown, at: number): PhoneRestrictionInstance | null {
  const r = phoneLimitObject(value);
  if (!r || !text(r.id) || !text(r.authorizationId) || !['I', 'you'].includes(String(r.actor))
    || !['phone', 'apps'].includes(String(r.scope)) || !strings(r.packages)
    || (r.scope === 'phone' ? r.packages.length !== 0 : r.packages.length === 0)
    || !['warning', 'direct'].includes(String(r.mode)) || !time(r.createdAt) || r.createdAt > at
    || !time(r.warningUntil) || r.warningUntil < r.createdAt || !time(r.endsAt)
    || r.endsAt < r.createdAt || !time(r.originalEndsAt) || r.endsAt > r.originalEndsAt
    || !(r.endedAt === null || time(r.endedAt))
    || (r.phoneAllowlist !== undefined && !strings(r.phoneAllowlist))) return null;
  return { ...r, phase: r.endedAt !== null || at >= r.endsAt ? 'ended'
    : at < r.warningUntil ? 'warning' : 'restriction_due' } as PhoneRestrictionInstance;
}

// Action receipts identify the exact record, including an ended original call.
// Saving a record is separate from observing an actual blocking window.
export function projectPhoneLimitActionLock(state: unknown, id: string, at: number, zone: string): Row | null {
  const rows = phoneLimitObject(state)?.instances;
  if (!Array.isArray(rows)) return null;
  const matches = rows.filter(row => phoneLimitObject(row)?.id === id);
  if (matches.length !== 1) return null;
  const lock = instance(matches[0], at);
  if (!lock) return null;
  if (lock.phase === 'ended') return { id: lock.id, phase: 'ended' };
  const until = phoneLimitLocalInstant(lock.endsAt, zone);
  if (!until) return null;
  return { id: lock.id, target: lock.scope === 'phone' ? 'phone' : lock.packages,
    phase: lock.phase === 'warning' ? 'warning' : 'due', ...(lock.phase === 'warning'
      ? { lockAt: lock.warningUntil < lock.endsAt ? phoneLimitLocalInstant(lock.warningUntil, zone) : null } : {}), until };
}

export function projectPhoneLimitActionDisplay(query: PhoneLimitQuerySource | null): Row | null {
  const display = phoneLimitObject(query?.display);
  const at = query && display && phoneLimitLocalInstant(display.observedAt, query.timeZoneId);
  return at ? { at, phonePageShown: typeof display.phonePageShown === 'boolean' ? display.phonePageShown : null,
    appLockShown: typeof display.appLockShown === 'boolean' ? display.appLockShown : null } : null;
}

function planContents(value: unknown): string | null {
  const input = parsePhoneRestrictionPlanInput(value);
  return input ? JSON.stringify({ ...input, packages: [...input.packages].sort(), schedule: { ...input.schedule,
    windows: [...input.schedule.windows].sort((a, b) => a.id.localeCompare(b.id)) } }) : null;
}

function usageProjection(s: PhoneLimitStatusSources, q: PhoneLimitQuerySource, iso: (v: unknown) => string | null) {
  const missing: string[] = [];
  const apps: [string, unknown][] = [];
  const logsKnown = s.logs?.available === true && s.logs.truncated === false && s.logs.logs.every(value => {
    const log = phoneLimitObject(value);
    return log && text(log.kind) && text(log.source) && text(log.device_id) && time(log.created_at)
      && (log.kind !== 'foreground_app_duration' || (time(log.started_at) && time(log.ended_at)
        && log.ended_at >= log.started_at && time(log.duration_ms, true) && typeof log.sensitive_level === 'string'));
  });
  if (!logsKnown) missing.push('today_app_usage');
  else {
    const amounts = new Map<string, number>();
    for (const value of s.logs!.logs) {
      const log = value as Row;
      if (log.kind !== 'foreground_app_duration' || log.device_id !== 'junluo-android' || log.sensitive_level === 'blocked'
        || !isVisiblePhoneUsageApp(log.source as string, typeof log.title === 'string' ? log.title : null)) continue;
      const amount = Math.max(0, Math.min(log.ended_at as number, q.observedAt) - Math.max(log.started_at as number, q.dayStart));
      if (amount > 0) amounts.set(log.source as string, (amounts.get(log.source as string) ?? 0) + amount);
    }
    for (const [pkg, amount] of [...amounts].sort((a, b) => b[1] - a[1])) {
      const name = appName(s, pkg);
      apps.push([pkg, `${name ? `${name}：` : ''}${formatPhoneUsageDuration(amount)}`]);
    }
  }
  const own = s.ownUsage?.available && s.ownUsage.source === 'com.anonymous.junluo'
    ? s.ownUsage.days.find(day => day.dateKey === q.localDate) : undefined;
  if (!own || !time(own.durationMs, true)) missing.push('junluo_usage');
  else if (own.durationMs > 0) apps.push(['com.anonymous.junluo', `${s.ownUsage!.title}：${formatPhoneUsageDuration(own.durationMs)}`]);
  const u = phoneLimitObject(s.query?.usage);
  const observation = u?.restorePaused === false ? phoneLimitObject(u.usageObservation) : null;
  let current: Row | null = null;
  const at = observation && iso(observation.observedAt);
  if (at) {
    if (observation!.ongoing === null) current = { at };
    else {
      const ongoing = phoneLimitObject(observation!.ongoing);
      const from = ongoing && iso(ongoing.from);
      const until = ongoing && iso(ongoing.until);
      if (ongoing && text(ongoing.packageName) && from && until && (ongoing.until as number) >= (ongoing.from as number)
        && (ongoing.until as number) <= (observation!.observedAt as number)) {
        current = { app: ongoing.packageName, from, at,
          ...(ongoing.until === observation!.observedAt ? {} : { until }) };
      }
    }
  }
  if (!current) missing.push('current_usage');
  return !logsKnown && !own && !current ? null : { subject: 'you', date: q.localDate,
    apps: logsKnown ? map(apps) : null, current, ...(missing.length ? { missing } : {}), complete: null };
}

/** Projection only: no model call, state transition, source repair or persistence. */
export function projectPhoneLimitStatus(s: PhoneLimitStatusSources): PhoneLimitStatusReceipt {
  const q = s.query;
  const failed: PhoneLimitStatusReceipt = { ok: false, status: 'error', summary: '暂时读不到手机情况。', data: null };
  if (!q) return failed;
  const at = q.observedAt;
  const iso = (v: unknown) => phoneLimitLocalInstant(v, q.timeZoneId);
  let partial = false;
  const unknown = () => { partial = true; return null; };
  const name = (pkg: string) => appName(s, pkg) ?? unknown();
  const targets = (packages: string[]) => map(packages.map(pkg => [pkg, name(pkg)]));
  const rawState = phoneLimitObject(q.state);
  const state = rawState?.schemaVersion === 1 ? rawState : null;
  const config = state?.configurationKnown === true && state.durationsKnown === true
    ? parsePhoneRestrictionConfiguration(state) : null;
  const durationRaw = phoneLimitObject(state?.durations);
  const releaseMinutes = state?.durationsKnown === true && durationRaw && time(durationRaw.appReleaseMs)
    ? { default: durationRaw.appReleaseMs / 60_000, max: Math.floor(durationRaw.appReleaseMs / 60_000) } : unknown();
  const rawInstances = Array.isArray(state?.instances) ? state.instances : null;
  const enumerableInstances = rawInstances && rawInstances.every(v => text(phoneLimitObject(v)?.id))
    && new Set(rawInstances.map(v => (v as Row).id)).size === rawInstances.length ? rawInstances : null;
  const parsed = enumerableInstances?.map(v => instance(v, at)) ?? null;
  const current = parsed?.filter((v): v is PhoneRestrictionInstance => v !== null && v.phase !== 'ended') ?? [];
  const instancesKnown = parsed !== null && parsed.every(v => v !== null)
    && current.every(v => v.scope !== 'phone' || strings(v.phoneAllowlist));
  const locks = enumerableInstances ? map(enumerableInstances.flatMap((r, index): [string, unknown][] => {
    const v = parsed![index];
    if (!v) return [[(r as Row).id as string, unknown()]];
    if (v.phase === 'ended') return [];
    const until = iso(v.endsAt);
    return [[v.id, until ? { by: v.actor, target: v.scope === 'phone' ? 'phone' : v.packages,
      phase: v.phase === 'warning' ? 'warning' : 'due', ...(v.phase === 'warning'
        ? { lockAt: v.warningUntil < v.endsAt ? iso(v.warningUntil) : null } : {}), until } : unknown()]];
  })) : unknown();
  const allowedApps = enumerableInstances ? map(enumerableInstances.flatMap((r, index): [string, unknown][] => {
    const v = parsed![index];
    if (!v) { partial = true; return (r as Row).scope === 'apps' ? [] : [[(r as Row).id as string, null]]; }
    return v.phase !== 'ended' && v.scope === 'phone' ? [[v.id, strings(v.phoneAllowlist) ? targets(v.phoneAllowlist) : unknown()]] : [];
  })) : unknown();
  const paused = typeof state?.paused === 'boolean' ? state.paused : unknown();
  let emergencyKnown = state?.emergency === null;
  let emergencyUntil: string | null = null;
  const emergency = phoneLimitObject(state?.emergency);
  if (emergency && time(emergency.startedAt) && time(emergency.until) && emergency.until >= emergency.startedAt) {
    emergencyKnown = true;
    if (emergency.startedAt <= at && at < emergency.until) {
      emergencyUntil = iso(emergency.until); emergencyKnown = emergencyUntil !== null;
    }
  }
  if (!emergencyKnown) partial = true;
  const releases = Array.isArray(state?.appReleases) ? state.appReleases : null;
  const released = new Map<string, number>();
  const releasesKnown = releases?.every(value => {
    const r = phoneLimitObject(value);
    if (!r || !text(r.packageName) || !time(r.startedAt) || !time(r.until) || r.until <= r.startedAt || !iso(r.until)) return false;
    if (r.startedAt <= at && at < r.until) released.set(r.packageName, Math.max(released.get(r.packageName) ?? 0, r.until));
    return true;
  }) === true;
  const access = state && (typeof paused === 'boolean' || emergencyKnown || releasesKnown) ? { paused, ...(emergencyKnown ? { emergencyUntil } : {}),
    releasedApps: releasesKnown ? map([...released].map(([pkg, until]) => [pkg, iso(until)])) : unknown() } : unknown();
  const options = config && instancesKnown && paused !== null
    ? map(phoneLimitNewStartOptions(config, current, at, paused).map(v => [v.grant.id,
      { target: v.grant.scope === 'phone' ? 'phone' : targets(v.packages), defaultMinutes: v.defaultMs === null ? null : v.defaultMs / 60_000,
        maxMinutes: Math.floor(v.maximumMs / 60_000) }])) : unknown();
  const adjustments = config && instancesKnown ? map(current.filter(v => phoneLimitCanAdjust(v, config, at))
    .map(v => [v.id, { maxRemainingMinutes: Math.floor((v.endsAt - at) / 60_000) }])) : unknown();
  const rawDisplay = phoneLimitObject(q.display);
  const displayAt = rawDisplay && iso(rawDisplay.observedAt);
  const display = displayAt ? { at: displayAt,
    phonePageShown: typeof rawDisplay!.phonePageShown === 'boolean' ? rawDisplay!.phonePageShown : unknown(),
    appLockShown: typeof rawDisplay!.appLockShown === 'boolean' ? rawDisplay!.appLockShown : unknown() } : unknown();
  const u = phoneLimitObject(q.usage);
  const observation = u?.restorePaused === false ? phoneLimitObject(u.usageObservation) : null;
  const observationAt = observation && iso(observation.observedAt);
  const rules = observation?.rulesKnown === true && Array.isArray(observation.rules) ? observation.rules : null;
  const rulesEnumerable = rules && rules.every(v => text(phoneLimitObject(v)?.packageName))
    && new Set(rules.map(v => (v as Row).packageName)).size === rules.length;
  const appLimits = observationAt && rulesEnumerable ? { at: observationAt, apps: map(rules!.map(value => {
    const r = value as Row;
    const duration = (v: unknown) => time(v, true) ? formatPhoneUsageDuration(v) : unknown();
    const knownCounts = [r.ordinaryUsedMs, r.dailyUsedMs, r.ordinaryLimitMs, r.dailyLimitMs].every(v => time(v, true));
    return [r.packageName as string, { mode: ['lock', 'reminder', 'jealousy'].includes(String(r.mode)) ? r.mode : unknown(),
      session: [duration(r.ordinaryUsedMs), duration(r.ordinaryLimitMs)], daily: [duration(r.dailyUsedMs), duration(r.dailyLimitMs)],
      reached: knownCounts ? [(r.ordinaryUsedMs as number) >= (r.ordinaryLimitMs as number) ? 'session' : null,
        (r.dailyUsedMs as number) >= (r.dailyLimitMs as number) ? 'daily' : null].filter(Boolean) : unknown(),
      cooldown: typeof r.cooldown === 'boolean' ? r.cooldown : unknown() }];
  })) } : unknown();
  const blocked = phoneLimitObject(q.timeBlockedApps);
  const blockedAt = blocked && iso(blocked.observedAt);
  const timeBlocks = blockedAt && strings(blocked!.packages) ? { at: blockedAt, apps: targets(blocked!.packages) } : unknown();
  const focus = phoneLimitObject(q.focusSettings);
  const focusKnown = focus && typeof focus.enabled === 'boolean' && (focus.enabled === false || Array.isArray(focus.rules));
  const timeRules = Array.isArray(state?.appTimeRules) ? state.appTimeRules.map(parsePhoneRestrictionAppTimeRule) : null;
  const candidates = new Set(current.flatMap(v => v.scope === 'apps' ? v.packages : s.names
    ? Object.keys(s.names).filter(pkg => !v.phoneAllowlist?.includes(pkg)) : []));
  let releaseSourcesKnown = !!focusKnown && timeRules !== null && timeRules.every(v => v !== null)
    && instancesKnown && (!current.some(v => v.scope === 'phone') || s.names !== null);
  if (focusKnown && focus!.enabled === true) {
    const selected = new Set<string>();
    const selectedIds = new Set<string>();
    for (const value of focus!.rules as unknown[]) {
      const rule = phoneLimitObject(value);
      if (!rule || !text(rule.kind)) { releaseSourcesKnown = false; continue; }
      if (rule.kind !== 'blacklist' && rule.kind !== 'jealousy') continue;
      if (rule.kind === 'jealousy') {
        if (focus!.jealousyEnabled === false) continue;
        if (focus!.jealousyEnabled !== undefined && focus!.jealousyEnabled !== true) { releaseSourcesKnown = false; continue; }
      }
      if (!text(rule.source)) { releaseSourcesKnown = false; continue; }
      if (selected.has(rule.source)) continue;
      selected.add(rule.source);
      if (rule.id !== undefined && typeof rule.id !== 'string') { releaseSourcesKnown = false; continue; }
      const id = text(rule.id) ? rule.id : `${rule.kind}:${rule.source}`;
      if (selectedIds.has(id)) continue;
      selectedIds.add(id);
      candidates.add(rule.source);
    }
  }
  if (config && timeRules) for (const rule of timeRules) {
    const grant = rule && config.authorizations.find(v => v.id === rule.authorizationId);
    if (rule?.times.enabled && grant?.scope === 'apps' && grant.actors.includes('you') && grant.modes.includes('direct')
      && grant.packages.includes(rule.packageName) && grant.validFrom <= at && at < grant.validUntil) candidates.add(rule.packageName);
  }
  const releaseApps = config && releaseSourcesKnown ? targets([...candidates].filter(pkg => phoneLimitCanReleasePackage(pkg, config, at))) : unknown();
  const savedSettings = phoneLimitObject(s.settings);
  const management = parsePhoneRestrictionManagement(savedSettings?.restrictionManagement);
  const nativePlans = Array.isArray(state?.plans) ? state.plans : null;
  const mirror = new Map<string, Row>();
  let mirrorKnown = nativePlans !== null;
  for (const raw of nativePlans ?? []) {
    const r = phoneLimitObject(raw); const input = parsePhoneRestrictionPlanInput(r);
    if (!input || mirror.has(input.schedule.id)) { mirrorKnown = false; break; }
    mirror.set(input.schedule.id, r!);
  }
  const dates = (v: { localDate?: string; weekdays?: readonly number[] }) => v.localDate !== undefined ? { date: v.localDate } : { weekdays: v.weekdays };
  const windows = (v: readonly { startTime: string; endTime: string }[]) => v.map(w => [w.startTime, w.endTime]);
  const editableIds = new Set<string>();
  const sourcePlanIds = new Set(management?.plans.map(v => v.input.schedule.id));
  const nativeOnlyIds = [...mirror.keys()].filter(id => !sourcePlanIds.has(id));
  if (nativeOnlyIds.length || !mirrorKnown) partial = true;
  const plans = management && (management.plans.length > 0 || mirrorKnown) ? map([...management.plans.map(({ input }): [string, unknown] => {
    const id = input.schedule.id;
    const m = mirrorKnown ? mirror.get(id) : undefined;
    const adopted = planContents(m) !== null && planContents(m) === planContents(input);
    const editable = input.actor === 'you' ? false : config && adopted ? phoneLimitPlanEditable(input, config, at) : unknown();
    if (editable === true) editableIds.add(input.authorizationId);
    const futureKnown = adopted && time(m?.futureFrom, true);
    if (!futureKnown) partial = true;
    const future = futureKnown && m!.futureFrom !== 0 ? iso(m!.futureFrom) : null;
    if (futureKnown && m!.futureFrom !== 0 && !future) partial = true;
    return [id, { by: input.actor, target: input.scope === 'phone' ? 'phone' : targets(input.packages), enabled: input.schedule.enabled,
      ...dates(input.schedule.dates), times: windows(input.schedule.windows), optionId: editable === true ? input.authorizationId : null,
      editable, ...(futureKnown && (m!.futureFrom === 0 || future) ? { applyFrom: future } : {}) }];
  }), ...nativeOnlyIds.map((id): [string, unknown] => [id, unknown()])]) : unknown();
  const planOptions = config && management ? map(config.authorizations.flatMap((grant): [string, unknown][] => {
    const canCreate = phoneLimitCanCreatePlan(grant, config, at);
    if (!canCreate && !editableIds.has(grant.id)) return [];
    const from = iso(grant.validFrom);
    const until = grant.validUntil === Number.MAX_SAFE_INTEGER ? null : iso(grant.validUntil);
    if (!from || (grant.validUntil !== Number.MAX_SAFE_INTEGER && !until) || !grant.planAllowance) return [[grant.id, unknown()]];
    return [[grant.id, { target: grant.scope === 'phone' ? 'phone' : targets(grant.packages), canCreate,
      ...dates(grant.planAllowance.dates), times: windows(grant.planAllowance.windows), from, until }]];
  })) : unknown();
  const usage = usageProjection(s, q, iso);
  if (!usage || usage.missing) partial = true;
  if (usage?.apps && Object.keys(usage.apps).some(pkg => pkg !== 'com.anonymous.junluo' && !appName(s, pkg))) partial = true;
  const data = { usage, locks, access, options, display, allowedApps, appLimits, timeBlocks, adjustments,
    releaseMinutes, releaseApps, planOptions, plans };
  if (Object.values(data).every(v => v === null)) return failed;
  return { ok: true, status: 'success', summary: partial ? '只读到部分手机情况。' : '手机情况已读取。', data };
}
