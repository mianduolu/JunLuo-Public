import { NativeModules, Platform } from 'react-native';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { PhoneRestrictionPlanInput } from '../proactive/phoneRestrictionSchedule';
import { parsePhoneLimitQuery, phoneLimitLocalInstant, phoneLimitObject,
  type PhoneLimitQuerySource } from '../tools/phoneLimitStatus';

export type PhoneLimitActionReceipt = {
  outcome: 'validated' | 'saved' | 'unchanged' | 'ended' | 'rejected' | 'unknown';
  stateSaved: boolean;
  state: Record<string, unknown> | null;
  observedAt: number | null;
  timeZoneId: string | null;
  localDate?: string;
  dayStart?: number;
  priorEndsAt?: number;
  reason?: string;
};
export type PhoneLimitNativeAction =
  | { kind: 'start'; input: { id: string; authorizationId: string; scope: 'phone' | 'apps'; packages: string[]; durationMs?: number } }
  | { kind: 'shorten'; input: { id: string; expectedEndsAt: number; until: number } }
  | { kind: 'end'; input: { id: string } }
  | { kind: 'release'; input: { id: string; packageName: string; durationMs?: number } }
  | { kind: 'validate_plan' | 'put_plan'; input: { input: PhoneRestrictionPlanInput; expected: PhoneRestrictionPlanInput | null } };

const METHODS = {
  start: 'startPhoneRestrictionInstanceForI', shorten: 'shortenPhoneRestrictionInstanceForI',
  end: 'endPhoneRestrictionInstanceForI', release: 'releasePhoneRestrictionAppForI',
  validate_plan: 'validatePhoneRestrictionPlanForI', put_plan: 'putPhoneRestrictionPlanForI',
} as const;
type ActionNative = Partial<Record<(typeof METHODS)[keyof typeof METHODS], (json: string) => Promise<string>>> & {
  getPhoneRestrictionQuery?: () => Promise<string>;
};
const nativeModule = () => Platform.OS === 'android' ? NativeModules.JunLuoPhoneActivity as ActionNative | undefined : undefined;
/** Host capabilities only; never fall back to an older mutation method. */
export function availablePhoneLimitToolIds(): import('../tools/phoneLimitContract').PhoneLimitToolId[] {
  const native = nativeModule();
  if (typeof native?.getPhoneRestrictionQuery !== 'function') return [];
  const ids: import('../tools/phoneLimitContract').PhoneLimitToolId[] = ['phone_limit.get_status'];
  const actions = { start: 'start', shorten: 'shorten', end: 'end', release_app: 'release' } as const;
  for (const [tool, action] of Object.entries(actions)) {
    if (typeof native[METHODS[action]] === 'function') ids.push(`phone_limit.${tool}` as typeof ids[number]);
  }
  if (typeof native[METHODS.validate_plan] === 'function' && typeof native[METHODS.put_plan] === 'function') ids.push('phone_limit.set_plan');
  return ids;
}
const decode = (raw: unknown) => typeof raw === 'string' ? JSON.parse(raw) : raw;
const receipt = (outcome: 'rejected' | 'unknown', reason: string): PhoneLimitActionReceipt =>
  ({ outcome, reason, stateSaved: false, state: null, observedAt: null, timeZoneId: null });

function parseReceipt(raw: unknown): PhoneLimitActionReceipt | null {
  const r = phoneLimitObject(decode(raw));
  if (!r || !['validated', 'saved', 'unchanged', 'ended', 'rejected', 'unknown'].includes(String(r.outcome))
    || typeof r.stateSaved !== 'boolean' || !(r.state === null || phoneLimitObject(r.state))
    || typeof r.observedAt !== 'number' || !Number.isSafeInteger(r.observedAt) || r.observedAt <= 0
    || typeof r.timeZoneId !== 'string' || !phoneLimitLocalInstant(r.observedAt, r.timeZoneId)
    || (['validated', 'saved', 'unchanged', 'ended'].includes(String(r.outcome)) && (!r.stateSaved || !r.state))) return null;
  return { outcome: r.outcome as PhoneLimitActionReceipt['outcome'], stateSaved: r.stateSaved,
    state: phoneLimitObject(r.state), observedAt: r.observedAt, timeZoneId: r.timeZoneId,
    ...(typeof r.localDate === 'string' && r.localDate === phoneLimitLocalInstant(r.observedAt, r.timeZoneId)?.slice(0, 10)
      && typeof r.dayStart === 'number' && Number.isSafeInteger(r.dayStart) && r.dayStart > 0 && r.dayStart <= r.observedAt
      && phoneLimitLocalInstant(r.dayStart, r.timeZoneId)?.slice(0, 10) === r.localDate
      ? { localDate: r.localDate, dayStart: r.dayStart } : {}),
    ...(typeof r.priorEndsAt === 'number' && Number.isSafeInteger(r.priorEndsAt) && r.priorEndsAt > 0
      ? { priorEndsAt: r.priorEndsAt } : {}), ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) };
}

/** Read actual native facts without the old getter's reconciliation or writes. */
export async function readPhoneLimitActionQuery(epoch = captureBackupRestoreDataEpoch()): Promise<PhoneLimitQuerySource | null> {
  if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
  try {
    const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
      const native = nativeModule();
      if (typeof native?.getPhoneRestrictionQuery !== 'function') return null;
      return parsePhoneLimitQuery(decode(await native.getPhoneRestrictionQuery()));
    });
    return committed.committed && canCommitBackupRestoreDataEpoch(epoch) ? committed.value : null;
  } catch { return null; }
}

/** Only this boundary dispatches. A catch after dispatch never means 'not executed'. */
export async function executePhoneLimitNativeAction(
  action: PhoneLimitNativeAction,
  epoch = captureBackupRestoreDataEpoch(),
): Promise<PhoneLimitActionReceipt> {
  if (!canCommitBackupRestoreDataEpoch(epoch)) return receipt('rejected', 'STALE_DATA_EPOCH');
  const native = nativeModule();
  const method = native?.[METHODS[action.kind]];
  if (typeof method !== 'function') return receipt('rejected', 'UNAVAILABLE');
  let dispatched = false;
  try {
    const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
      if (!canCommitBackupRestoreDataEpoch(epoch)) return receipt('rejected', 'STALE_DATA_EPOCH');
      const payload = JSON.stringify(action.input);
      dispatched = true;
      const result = parseReceipt(await method.call(native, payload));
      return result ?? receipt('unknown', 'INVALID_NATIVE_RECEIPT');
    });
    if (!committed.committed) return receipt('rejected', 'STALE_DATA_EPOCH');
    return canCommitBackupRestoreDataEpoch(epoch) ? committed.value : receipt(dispatched ? 'unknown' : 'rejected', 'STALE_DATA_EPOCH');
  } catch { return receipt(dispatched ? 'unknown' : 'rejected', 'NATIVE_FAILURE'); }
}
