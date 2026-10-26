import type { PhoneLimitActionReceipt } from '../backend/phoneLimitActionNative';
import { parsePhoneRestrictionConfiguration } from '../backend/phoneRestrictionNative';
import { parsePhoneRestrictionManagement, type PhoneRestrictionManagedPlan,
  type PhoneRestrictionManagement } from '../phoneRestriction/phoneRestrictionManagement';
import { parsePhoneRestrictionOccurrence, parsePhoneRestrictionPlanInput,
  type PhoneRestrictionPlanInput, type PhoneRestrictionSavedPlan } from '../proactive/phoneRestrictionSchedule';
import { parsePhoneLimitToolInput, type PhoneLimitSetPlanInput } from './phoneLimitContract';
import { phoneLimitCanCreatePlan, phoneLimitPlanEditable, phoneLimitScheduleCovered } from './phoneLimitEligibility';
import { parsePhoneLimitQuery, phoneLimitLocalInstant, phoneLimitObject, projectPhoneLimitStatus, type PhoneLimitQuerySource } from './phoneLimitStatus';

type Row = Record<string, unknown>;
export type PhoneLimitPlanNativePorts = {
  validate(input: PhoneRestrictionPlanInput, expected: PhoneRestrictionSavedPlan | null): Promise<PhoneLimitActionReceipt>;
  put(input: PhoneRestrictionPlanInput, expected: PhoneRestrictionSavedPlan | null): Promise<PhoneLimitActionReceipt>;
  query(): Promise<PhoneLimitQuerySource | null>;
};
export type PhoneLimitPreparedPlan = {
  observedAt: number;
  input: PhoneRestrictionPlanInput;
  title: string;
  previous: PhoneRestrictionManagedPlan | null;
  expected: PhoneRestrictionSavedPlan | null;
};
export type PhoneLimitPlanExecutionResult = {
  outcome: 'saved' | 'unchanged' | 'rejected' | 'source_saved' | 'unknown';
  data: { plans: Record<string, unknown> | null };
  prepared?: PhoneLimitPreparedPlan;
  sourceSaved?: boolean;
  nativeDispatched?: boolean;
};
export type PhoneLimitPlanExecutionPorts = {
  native: PhoneLimitPlanNativePorts;
  readSettings(): Promise<Row | null>;
  writeSettings(settings: Row, management: PhoneRestrictionManagement): Promise<void>;
  isCurrent(): boolean;
  beforeWrite?(prepared: PhoneLimitPreparedPlan): Promise<void>;
};

const safeTime = (value: unknown, zero = false): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= (zero ? 0 : 1);
const result = (outcome: PhoneLimitPlanExecutionResult['outcome'],
  prepared?: PhoneLimitPreparedPlan, sourceSaved = false, nativeDispatched = false): PhoneLimitPlanExecutionResult =>
  ({ outcome, data: { plans: null }, ...(prepared ? { prepared } : {}), sourceSaved, nativeDispatched });

function contents(value: unknown) {
  const plan = parsePhoneRestrictionPlanInput(value);
  return plan && JSON.stringify({ ...plan, packages: [...plan.packages].sort(), schedule: {
    ...plan.schedule, windows: [...plan.schedule.windows].sort((a, b) => a.id.localeCompare(b.id)),
  } });
}
function sourceMatches(value: PhoneRestrictionManagedPlan | undefined, expected: PhoneRestrictionManagedPlan | null) {
  return expected === null ? value === undefined : !!value && value.title === expected.title
    && contents(value.input) === contents(expected.input);
}
function nativePlans(query: PhoneLimitQuerySource): PhoneRestrictionSavedPlan[] | null {
  const state = phoneLimitObject(query.state);
  if (!Array.isArray(state?.plans)) return null;
  const plans: PhoneRestrictionSavedPlan[] = [];
  for (const value of state.plans) {
    const record = phoneLimitObject(value); const input = parsePhoneRestrictionPlanInput(value);
    if (!record || !input || !safeTime(record.createdAt) || record.createdAt > query.observedAt
      || !safeTime(record.futureFrom, true) || plans.some(plan => plan.schedule.id === input.schedule.id)) return null;
    plans.push({ ...input, createdAt: record.createdAt, futureFrom: record.futureFrom });
  }
  return plans;
}
function nativeMatches(query: PhoneLimitQuerySource, prepared: PhoneLimitPreparedPlan, adopted = false) {
  const plans = nativePlans(query); if (!plans) return false;
  const actual = plans.find(plan => plan.schedule.id === prepared.input.schedule.id);
  return adopted ? !!actual && contents(actual) === contents(prepared.input)
    && (prepared.expected ? actual.createdAt === prepared.expected.createdAt : actual.createdAt >= prepared.observedAt)
    : prepared.expected === null ? actual === undefined : !!actual
      && contents(actual) === contents(prepared.expected)
      && actual.createdAt === prepared.expected.createdAt && actual.futureFrom === prepared.expected.futureFrom;
}
function allowed(query: PhoneLimitQuerySource, prepared: PhoneLimitPreparedPlan) {
  const state = phoneLimitObject(query.state);
  const config = state?.configurationKnown === true && state.durationsKnown === true
    ? parsePhoneRestrictionConfiguration(state) : null;
  const grant = config?.authorizations.find(value => value.id === prepared.input.authorizationId);
  if (!config || !grant?.planAllowance || !phoneLimitScheduleCovered(prepared.input.schedule, grant.planAllowance)) return false;
  return prepared.previous ? phoneLimitPlanEditable(prepared.previous.input, config, query.observedAt)
    : phoneLimitCanCreatePlan(grant, config, query.observedAt)
      && prepared.input.schedule.mode === (config.defaultMode ?? 'warning')
      && prepared.input.schedule.warningMs === (prepared.input.schedule.mode === 'warning' ? config.durations.warningMs : 0);
}

/** Only prepares real source/native bindings; it does not write or calculate phone wall-time epochs. */
export function preparePhoneLimitPlan(callId: string, rawInput: PhoneLimitSetPlanInput,
  settings: Row, query: PhoneLimitQuerySource): PhoneLimitPreparedPlan | null {
  const parsed = parsePhoneLimitToolInput('phone_limit.set_plan', rawInput);
  const management = parsePhoneRestrictionManagement(settings.restrictionManagement);
  const plans = nativePlans(query); const state = phoneLimitObject(query.state);
  const config = state?.configurationKnown === true && state.durationsKnown === true
    ? parsePhoneRestrictionConfiguration(state) : null;
  if (!callId.trim() || !parsed.ok || !management || !plans || !config || !Array.isArray(state?.instances)) return null;
  const input = parsed.input;
  const id = input.id ?? `phone_limit:${callId}`;
  const previous = management.plans.find(plan => plan.input.schedule.id === id) ?? null;
  const expected = plans.find(plan => plan.schedule.id === id) ?? null;
  if (input.id ? !previous || !expected || contents(previous.input) !== contents(expected)
    || !phoneLimitPlanEditable(previous.input, config, query.observedAt) : previous !== null || expected !== null) return null;
  const grant = config.authorizations.find(value => value.id === (previous?.input.authorizationId ?? input.optionId));
  if (!grant || (!previous && !phoneLimitCanCreatePlan(grant, config, query.observedAt))) return null;
  const packages = previous?.input.packages ?? input.packages ?? [];
  if (grant.scope === 'phone' ? packages.length !== 0 : packages.length === 0 || packages.some(pkg => !grant.packages.includes(pkg))) return null;
  const used = new Set(previous?.input.schedule.windows.map(window => window.id));
  for (const value of state.instances) {
    const record = phoneLimitObject(value);
    if (!record || record.occurrence === undefined) return null;
    if (record.occurrence === null) continue;
    const occurrence = parsePhoneRestrictionOccurrence(record.occurrence);
    if (!occurrence) return null;
    if (occurrence.scheduleId === id) {
      if (!previous) return null; // A previously used deleted id cannot be rebuilt here.
      used.add(occurrence.windowId);
    }
  }
  const pairs = [...new Map(input.times.map(pair => [JSON.stringify(pair), pair])).values()];
  const prefix = `${id}:window:`;
  const indices = [...used].filter(value => value.startsWith(prefix)).map(value => Number(value.slice(prefix.length)))
    .filter(value => Number.isSafeInteger(value) && value >= 0);
  let index = indices.length ? Math.max(...indices) + 1 : 0;
  if (!Number.isSafeInteger(index + pairs.length)) return null;
  const windows = pairs.map(([startTime, endTime]) => {
    const old = previous?.input.schedule.windows.find(window => window.startTime === startTime && window.endTime === endTime);
    if (old) return { ...old };
    while (used.has(`${id}:window:${index}`)) index += 1;
    const windowId = `${id}:window:${index++}`; used.add(windowId);
    return { id: windowId, startTime, endTime };
  });
  const plan = parsePhoneRestrictionPlanInput({ actor: previous?.input.actor ?? 'I',
    authorizationId: grant.id, scope: previous?.input.scope ?? grant.scope, packages,
    schedule: { id, enabled: previous?.input.schedule.enabled ?? true,
      mode: previous?.input.schedule.mode ?? config.defaultMode ?? 'warning',
      warningMs: previous?.input.schedule.warningMs ?? ((config.defaultMode ?? 'warning') === 'warning' ? config.durations.warningMs : 0),
      dates: input.date !== undefined ? { localDate: input.date } : { weekdays: input.weekdays }, windows } });
  if (!plan) return null;
  const prepared = { observedAt: query.observedAt, input: plan,
    title: previous?.title ?? pairs.map(pair => pair.join('–')).join('、'), previous, expected };
  return allowed(query, prepared) ? prepared : null;
}

function receiptQuery(base: PhoneLimitQuerySource, receipt: PhoneLimitActionReceipt): PhoneLimitQuerySource | null {
  if (!receipt.state || !safeTime(receipt.observedAt) || !receipt.timeZoneId
    || !phoneLimitLocalInstant(receipt.observedAt, receipt.timeZoneId)) return null;
  const clock = receipt as PhoneLimitActionReceipt & { localDate?: string; dayStart?: number };
  const actualClock = typeof clock.localDate === 'string' && safeTime(clock.dayStart);
  if (!actualClock && receipt.timeZoneId !== base.timeZoneId) return null;
  return parsePhoneLimitQuery({ ...base, observedAt: receipt.observedAt, timeZoneId: receipt.timeZoneId,
    ...(actualClock ? { localDate: clock.localDate, dayStart: clock.dayStart } : {}), state: receipt.state });
}
function projectedPlan(settings: Row, query: PhoneLimitQuerySource, id: string) {
  // Consume only the existing plan projection. Unrelated usage/clock/display facts are not returned.
  const projection = projectPhoneLimitStatus({ query, settings, names: null, logs: null, ownUsage: null });
  const plans = phoneLimitObject(projection.data?.plans);
  return plans && phoneLimitObject(plans[id]) ? { [id]: plans[id] } : null;
}

/** Recovery never writes, including when the original plan was deleted. */
export function reconcilePhoneLimitPlan(prepared: PhoneLimitPreparedPlan, settings: Row | null,
  query: PhoneLimitQuerySource | null): PhoneLimitPlanExecutionResult {
  const actual = parsePhoneRestrictionManagement(settings?.restrictionManagement)?.plans
    .find(plan => plan.input.schedule.id === prepared.input.schedule.id);
  if (!settings || !sourceMatches(actual, { input: prepared.input, title: prepared.title })) return result('unknown', prepared);
  // A pending new-plan call has no confirmed native creation identity. Do not
  // adopt a later same-ID recreation merely because its contents match.
  if (!query || prepared.expected === null || !nativeMatches(query, prepared, true)) return result('source_saved', prepared, true);
  const plans = projectedPlan(settings, query, prepared.input.schedule.id);
  return plans ? { ...result('saved', prepared, true), data: { plans } } : result('source_saved', prepared, true);
}

/** Called only inside the existing settings queue and restore lease. One put at most; recovery only reads. */
export async function executePhoneLimitPlan(callId: string, input: PhoneLimitSetPlanInput,
  ports: PhoneLimitPlanExecutionPorts): Promise<PhoneLimitPlanExecutionResult> {
  let settings: Row | null; let query: PhoneLimitQuerySource | null;
  try { settings = await ports.readSettings(); query = await ports.native.query(); }
  catch { return result('unknown'); }
  if (!ports.isCurrent()) return result('rejected');
  if (!settings || !query) return result('rejected');
  const prepared = preparePhoneLimitPlan(callId, input, settings, query);
  if (!prepared) return result('rejected');
  let validation: PhoneLimitActionReceipt;
  try { validation = await ports.native.validate(prepared.input, prepared.expected); }
  catch { return result('rejected', prepared); }
  const validated = receiptQuery(query, validation);
  if (!ports.isCurrent() || validation.outcome !== 'validated' || !validation.stateSaved || !validated
    || !nativeMatches(validated, prepared) || !allowed(validated, prepared)) return result('rejected', prepared);
  if (prepared.previous && contents(prepared.previous.input) === contents(prepared.input)) {
    try { settings = await ports.readSettings(); } catch { return result('unknown', prepared); }
    if (!ports.isCurrent() || !settings || !sourceMatches(parsePhoneRestrictionManagement(settings.restrictionManagement)?.plans
      .find(plan => plan.input.schedule.id === prepared.input.schedule.id), prepared.previous)) return result('unknown', prepared);
    const plans = projectedPlan(settings, validated, prepared.input.schedule.id);
    return plans ? { ...result('unchanged', prepared, true), data: { plans } } : result('unknown', prepared);
  }
  try { await ports.beforeWrite?.(prepared); settings = await ports.readSettings(); }
  catch { return result('rejected', prepared); }
  const management = parsePhoneRestrictionManagement(settings?.restrictionManagement);
  if (!ports.isCurrent() || !settings || !management
    || !sourceMatches(management.plans.find(plan => plan.input.schedule.id === prepared.input.schedule.id), prepared.previous)) return result('rejected', prepared);
  const next = { ...management, plans: [...management.plans.filter(plan => plan.input.schedule.id !== prepared.input.schedule.id),
    { input: prepared.input, title: prepared.title }] };
  let writeFailed = false;
  try { await ports.writeSettings(settings, next); } catch { writeFailed = true; }
  let actual: Row | null;
  try { actual = await ports.readSettings(); } catch { return result('unknown', prepared); }
  if (!ports.isCurrent()) return result('unknown', prepared);
  const saved = parsePhoneRestrictionManagement(actual?.restrictionManagement)?.plans.find(plan => plan.input.schedule.id === prepared.input.schedule.id);
  if (!actual || !sourceMatches(saved, { input: prepared.input, title: prepared.title })) return result('unknown', prepared);
  if (writeFailed) return result('source_saved', prepared, true);
  try { validation = await ports.native.validate(prepared.input, prepared.expected); }
  catch { return result('source_saved', prepared, true); }
  const checked = receiptQuery(query, validation);
  if (!ports.isCurrent()) return result('unknown', prepared, true);
  if (validation.outcome !== 'validated' || !validation.stateSaved || !checked
    || !nativeMatches(checked, prepared) || !allowed(checked, prepared)) return result('source_saved', prepared, true);
  try { actual = await ports.readSettings(); } catch { return result('unknown', prepared, true); }
  if (!ports.isCurrent() || !sourceMatches(parsePhoneRestrictionManagement(actual?.restrictionManagement)?.plans
    .find(plan => plan.input.schedule.id === prepared.input.schedule.id), { input: prepared.input, title: prepared.title })) return result('unknown', prepared, true);
  let put: PhoneLimitActionReceipt | null = null;
  try { put = await ports.native.put(prepared.input, prepared.expected); } catch { /* Read once; never re-put. */ }
  if (!ports.isCurrent()) return result('unknown', prepared, true, true);
  let after: PhoneLimitQuerySource | null = null;
  try { after = await ports.native.query(); } catch { /* A confirmed put receipt can still prove the native save. */ }
  if (!ports.isCurrent()) return result('unknown', prepared, true, true);
  try { actual = await ports.readSettings(); } catch { return result('unknown', prepared, true, true); }
  const final = parsePhoneRestrictionManagement(actual?.restrictionManagement)?.plans.find(plan => plan.input.schedule.id === prepared.input.schedule.id);
  if (!ports.isCurrent() || !actual || !sourceMatches(final, { input: prepared.input, title: prepared.title })) return result('unknown', prepared, true, true);
  const native = after ?? (put?.stateSaved && ['saved', 'unchanged'].includes(put.outcome) ? receiptQuery(query, put) : null);
  if (!native || !nativeMatches(native, prepared, true)) return result('source_saved', prepared, true, true);
  const plans = projectedPlan(actual, native, prepared.input.schedule.id);
  return plans ? { ...result('saved', prepared, true, true), data: { plans } } : result('source_saved', prepared, true, true);
}
