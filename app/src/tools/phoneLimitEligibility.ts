import type {
  PhoneRestrictionAuthorization, PhoneRestrictionConfiguration, PhoneRestrictionInstance,
} from '../backend/phoneRestrictionNative';
import type {
  PhoneRestrictionPlanAllowance, PhoneRestrictionPlanInput, PhoneRestrictionSchedule,
  PhoneRestrictionTimeWindow,
} from '../proactive/phoneRestrictionSchedule';

const MAX_SAFE_TIME = Number.MAX_SAFE_INTEGER;
const MINUTE_MS = 60_000;

function validObservation(at: number) {
  return Number.isSafeInteger(at) && at > 0;
}

function currentIGrant(grant: PhoneRestrictionAuthorization, at: number) {
  return validObservation(at) && grant.actors.includes('I') && grant.validFrom <= at && at < grant.validUntil;
}

function active(instance: PhoneRestrictionInstance, at: number) {
  return instance.endedAt === null && at < instance.endsAt;
}

function validTarget(grant: PhoneRestrictionAuthorization) {
  return grant.scope === 'phone' ? grant.packages.length === 0 : grant.scope === 'apps' && grant.packages.length > 0;
}

export type PhoneLimitNewStartOption = {
  grant: PhoneRestrictionAuthorization;
  packages: string[];
  maximumMs: number;
  defaultMs: number | null;
};

// Inputs must already be known, validated source facts. Missing sources are not empty arrays.
export function phoneLimitNewStartOptions(
  config: PhoneRestrictionConfiguration,
  instances: readonly PhoneRestrictionInstance[],
  at: number,
  paused: boolean,
): PhoneLimitNewStartOption[] {
  if (paused || !validObservation(at)) return [];
  const mode = config.defaultMode ?? 'warning';
  const warningMs = mode === 'warning' ? config.durations.warningMs : 0;
  const current = instances.filter(instance => active(instance, at));
  return config.authorizations.flatMap(grant => {
    if (!currentIGrant(grant, at) || grant.allowTemporary === false || !validTarget(grant)
      || !grant.modes.includes(mode)) return [];
    const maximumMs = Math.min(config.durations.maximumTemporaryMs, grant.maximumTemporaryMs,
      grant.validUntil - at - warningMs, MAX_SAFE_TIME - at - warningMs);
    if (Math.floor(maximumMs / MINUTE_MS) < 1) return [];
    let packages: string[];
    if (grant.scope === 'phone') {
      if (current.some(instance => instance.scope === 'phone'
        || instance.packages.some(pkg => !grant.phoneAllowlist.includes(pkg)))) return [];
      packages = [];
    } else {
      packages = grant.packages.filter(pkg => !current.some(instance => instance.scope === 'apps'
        ? instance.packages.includes(pkg) : instance.phoneAllowlist?.includes(pkg) !== true));
      if (!packages.length) return [];
    }
    return [{ grant, packages, maximumMs,
      defaultMs: config.durations.temporaryMs <= maximumMs ? config.durations.temporaryMs : null }];
  });
}

export function phoneLimitCanAdjust(
  instance: PhoneRestrictionInstance,
  config: PhoneRestrictionConfiguration,
  at: number,
): boolean {
  if (!validObservation(at) || !active(instance, at)) return false;
  const original = config.authorizations.find(grant => grant.id === instance.authorizationId);
  if (!original) return false;
  if (original.actors.includes('I')) return currentIGrant(original, at);
  if (instance.actor !== 'you') return false;
  const management = config.authorizations.filter(grant => currentIGrant(grant, at) && grant.scope === instance.scope);
  return instance.scope === 'phone' ? management.length > 0
    : instance.packages.length > 0 && instance.packages.every(pkg => management.some(grant => grant.packages.includes(pkg)));
}

/** The caller must separately supply a real current instance or applicable saved rule. */
export function phoneLimitCanReleasePackage(
  packageName: string,
  config: PhoneRestrictionConfiguration,
  at: number,
): boolean {
  return !!packageName.trim() && config.authorizations.some(grant => currentIGrant(grant, at)
    && (grant.scope === 'apps' ? grant.packages.includes(packageName) : !grant.phoneAllowlist.includes(packageName)));
}

export function phoneLimitCanCreatePlan(
  grant: PhoneRestrictionAuthorization,
  config: PhoneRestrictionConfiguration,
  at: number,
): boolean {
  return currentIGrant(grant, at) && validTarget(grant) && !!grant.planAllowance
    && grant.modes.includes(config.defaultMode ?? 'warning');
}

function coveredUntil(segments: readonly [number, number][], from: number): number {
  let until = from;
  for (const [start, end] of segments) {
    if (start > until) break;
    if (end > until) until = end;
  }
  return until;
}

function minute(clock: string) {
  return Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));
}

function segment(window: PhoneRestrictionTimeWindow): [number, number] {
  const start = minute(window.startTime);
  const end = minute(window.endTime);
  return [start, end < start ? end + 1440 : end];
}

function utcIntervals(windows: readonly PhoneRestrictionTimeWindow[], localDate: string): [number, number][] {
  const day = Date.parse(`${localDate}T00:00:00Z`);
  return windows.flatMap(window => {
    const [start, end] = segment(window);
    const startsAt = day + start * MINUTE_MS;
    const endsAt = day + end * MINUTE_MS;
    return startsAt > 0 && endsAt > startsAt && endsAt <= MAX_SAFE_TIME
      ? [[startsAt, endsAt] as [number, number]] : [];
  }).sort((a, b) => a[0] - b[0]);
}

// Port of PhoneRestrictionPlans.coversSchedule: UTC date spans or cyclic week minutes.
// Absolute grant validity and the phone's actual execution time zone are separate host facts.
export function phoneLimitScheduleCovered(
  schedule: PhoneRestrictionSchedule,
  allowance: PhoneRestrictionPlanAllowance,
): boolean {
  if (allowance.dates.localDate !== undefined) {
    const day = schedule.dates.localDate;
    if (day === undefined) return false;
    const dayEpoch = Date.parse(`${day}T00:00:00Z`);
    const spans = [-1, 0, 1].flatMap(offset => {
      const date = new Date(dayEpoch + offset * 1440 * MINUTE_MS).toISOString().split('T')[0];
      return date === allowance.dates.localDate ? utcIntervals(allowance.windows, date) : [];
    }).sort((a, b) => a[0] - b[0]);
    return utcIntervals(schedule.windows, day).every(([start, end]) => coveredUntil(spans, start) >= end);
  }
  const spans: [number, number][] = [];
  for (let day = -1; day <= 7; day += 1) {
    if (!allowance.dates.weekdays.includes(((day % 7 + 7) % 7 + 1) as 1 | 2 | 3 | 4 | 5 | 6 | 7)) continue;
    for (const window of allowance.windows) {
      const [start, end] = segment(window);
      spans.push([start + day * 1440, end + day * 1440]);
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const days = schedule.dates.localDate === undefined ? schedule.dates.weekdays
    : [new Date(`${schedule.dates.localDate}T00:00:00Z`).getUTCDay() || 7];
  return days.every(day => schedule.windows.every(window => {
    const [start, end] = segment(window);
    const offset = (day - 1) * 1440;
    return coveredUntil(spans, start + offset) >= end + offset;
  }));
}

export function phoneLimitPlanEditable(
  plan: PhoneRestrictionPlanInput,
  config: PhoneRestrictionConfiguration,
  at: number,
): boolean {
  const grant = config.authorizations.find(entry => entry.id === plan.authorizationId);
  return plan.actor === 'I' && !!grant && currentIGrant(grant, at) && !!grant.planAllowance
    && plan.scope === grant.scope && grant.modes.includes(plan.schedule.mode)
    && (plan.scope === 'phone' ? plan.packages.length === 0
      : plan.packages.length > 0 && plan.packages.every(pkg => grant.packages.includes(pkg)));
}
