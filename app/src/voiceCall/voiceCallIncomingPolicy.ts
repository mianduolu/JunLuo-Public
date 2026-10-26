type AutonomousCallDesire = {
  intent?: { driveKey?: string };
};

type AutonomousCallDayTemplate = {
  enabled: boolean;
  nap: { enabled: boolean; endTime: string; startTime: string };
  sleepTime: string;
  wakeTime: string;
};

export const AUTONOMOUS_CALL_URGE_THRESHOLD = 0.72;
export const AUTONOMOUS_CALL_DAILY_LIMIT = 2;
export const AUTONOMOUS_CALL_COOLDOWN_MS = 3 * 60 * 60 * 1000;
export const AUTONOMOUS_CALL_MIN_DELAY_MS = 60 * 1000;
export const AUTONOMOUS_CALL_MAX_DELAY_MS = 8 * 60 * 1000;

function clockMinutes(value: string) {
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

function isInsideWindow(current: number, start: number, end: number) {
  return start <= end ? current >= start && current < end : current >= start || current < end;
}

export function isAutonomousCallTimeAllowed(now: number, template: AutonomousCallDayTemplate) {
  const date = new Date(now);
  const current = date.getHours() * 60 + date.getMinutes();
  if (!template.enabled || !template.wakeTime || !template.sleepTime) return current >= 8 * 60 && current < 23 * 60;
  if (!isInsideWindow(current, clockMinutes(template.wakeTime), clockMinutes(template.sleepTime))) return false;
  if (template.nap.enabled && isInsideWindow(current, clockMinutes(template.nap.startTime), clockMinutes(template.nap.endTime))) return false;
  return true;
}

export function isAutonomousCallRoutineTimeAllowed(now: number, records: ReadonlyArray<{
  kind: string; startAt?: number; endAt?: number; enabled: boolean; source?: 'usual' | 'day';
}> | null, usualEnabled = true) {
  const effective = (records ?? []).filter(item => item.enabled && item.startAt !== undefined
    && (usualEnabled || item.source === 'day'));
  const boundaries = effective.filter(item => item.kind === 'wake' || item.kind === 'sleep')
    .sort((a, b) => a.startAt! - b.startAt!);
  const hasPair = boundaries.some(item => item.kind === 'wake') && boundaries.some(item => item.kind === 'sleep');
  const latest = boundaries.filter(item => item.startAt! <= now).at(-1);
  const next = boundaries.find(item => item.startAt! > now);
  const local = new Date(now); const minute = local.getHours() * 60 + local.getMinutes();
  const awakeWindow = hasPair && (latest || next)
    ? latest ? latest.kind === 'wake' : next!.kind === 'sleep'
    : minute >= 480 && minute < 1380;
  return awakeWindow && !effective.some(item => item.kind === 'nap' && item.endAt !== undefined
    && now >= item.startAt! && now < item.endAt);
}

export function shouldScheduleAutonomousCall(input: {
  dailyCount: number;
  desire: AutonomousCallDesire | null;
  desireId?: string | null;
  lastCallAt: number;
  now: number;
  relationshipPhase?: RelationshipPhase;
  urge: number;
}) {
  const driveKey = input.desireId ?? input.desire?.intent?.driveKey;
  if (![
    'attachment',
    'libido',
    'stress',
    'miss_you',
    'be_chosen',
    'care_for_you',
    'speak_to_you',
    'affection_with_you',
    'desire_you',
  ].includes(driveKey ?? '')) return false;
  if (!isJunluoAutomaticRelationshipOutletAllowed({
    driveKey,
    outlet: 'autonomous_call',
    phase: input.relationshipPhase ?? 'together',
  })) return false;
  if (input.urge < AUTONOMOUS_CALL_URGE_THRESHOLD) return false;
  if (input.dailyCount >= AUTONOMOUS_CALL_DAILY_LIMIT) return false;
  return !input.lastCallAt || input.now - input.lastCallAt >= AUTONOMOUS_CALL_COOLDOWN_MS;
}

export function randomAutonomousCallDelay(random = Math.random) {
  return Math.round(AUTONOMOUS_CALL_MIN_DELAY_MS + random() * (AUTONOMOUS_CALL_MAX_DELAY_MS - AUTONOMOUS_CALL_MIN_DELAY_MS));
}
import type { RelationshipPhase } from '../life/junluoInnerState';
import { isJunluoAutomaticRelationshipOutletAllowed } from '../life/junluoRelationshipPolicy';
