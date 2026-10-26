import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { executePhoneLimitNativeAction, readPhoneLimitActionQuery,
  type PhoneLimitNativeAction, type PhoneLimitActionReceipt } from '../backend/phoneLimitActionNative';
import { readPhoneLimitStatus } from '../backend/phoneLimitStatusNative';
import { savePhoneRestrictionManagedPlanForI } from '../proactive/phoneRestrictionSettings';
import { isPhoneLimitToolId, parsePhoneLimitToolInput, type PhoneLimitToolId,
  type PhoneLimitSetPlanInput } from './phoneLimitContract';
import { phoneLimitPreExecutionResult } from './phoneLimitModelResult';
import { phoneLimitLocalInstant, phoneLimitObject, projectPhoneLimitActionDisplay,
  projectPhoneLimitActionLock, type PhoneLimitQuerySource } from './phoneLimitStatus';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';
import type { PhoneLimitPreparedPlan } from './phoneLimitPlanExecution';

type ImmediateTool = Exclude<PhoneLimitToolId, 'phone_limit.get_status' | 'phone_limit.set_plan'>;
export type PhoneLimitPreparedAction = { callId: string; toolId: ImmediateTool;
  action: Exclude<PhoneLimitNativeAction, { kind: 'validate_plan' | 'put_plan' }> };
export type PhoneLimitExecutionOptions = {
  // Registration must freeze these first execution facts in the existing audit,
  // then settle/reconcile the same call. This callback never reaches the model.
  beforeDispatch?: (prepared: PhoneLimitPreparedAction) => Promise<void>;
  beforePlanWrite?: (prepared: PhoneLimitPreparedPlan) => Promise<void>;
  beforePlanSourceSave?: () => Promise<void>;
};
const operationId = (callId: string) => `phone_limit:${callId}`;
const minutes = (value: number | undefined) => value === undefined ? undefined
  : Number.isSafeInteger(value * 60_000) && value >= 1 ? value * 60_000 : null;

/** Freeze the native phone clock for shortening; never recompute it on replay. */
export function preparePhoneLimitAction(call: JunLuoToolCall, query: PhoneLimitQuerySource | null): PhoneLimitPreparedAction | null {
  if (!call.callId.trim() || !isPhoneLimitToolId(call.toolId)) return null;
  const parsed = parsePhoneLimitToolInput(call.toolId, call.input);
  if (!parsed.ok) return null;
  const state = phoneLimitObject(query?.state);
  switch (call.toolId) {
    case 'phone_limit.start': {
      const input = parsed.input as import('./phoneLimitContract').PhoneLimitStartInput;
      const durationMs = minutes(input.durationMinutes);
      if (durationMs === null) return null;
      const id = operationId(call.callId);
      const existing = Array.isArray(state?.instances) ? state.instances.filter(row => phoneLimitObject(row)?.id === id) : [];
      if (existing.length > 1) return null;
      const original = existing.length === 1 ? phoneLimitObject(existing[0]) : null;
      const grants = state?.configurationKnown === true && Array.isArray(state.authorizations)
        ? state.authorizations.filter(row => phoneLimitObject(row)?.id === input.optionId) : [];
      // For a retry use the original request's scope, even if its grant was removed.
      // Native still verifies the exact original request before returning it.
      const scope = original?.scope ?? (grants.length === 1 ? phoneLimitObject(grants[0])?.scope : null);
      if (scope !== 'phone' && scope !== 'apps') return null;
      return { callId: call.callId, toolId: call.toolId, action: { kind: 'start', input: {
        id, authorizationId: input.optionId, scope, packages: input.packages ?? [],
        ...(durationMs === undefined ? {} : { durationMs }),
      } } };
    }
    case 'phone_limit.shorten': {
      const input = parsed.input as import('./phoneLimitContract').PhoneLimitShortenInput;
      const durationMs = minutes(input.remainingMinutes);
      const records = Array.isArray(state?.instances) ? state.instances.filter(row => phoneLimitObject(row)?.id === input.id) : [];
      const record = records.length === 1 ? phoneLimitObject(records[0]) : null;
      const expectedEndsAt = record?.endsAt;
      if (!query || durationMs == null || typeof expectedEndsAt !== 'number'
        || !Number.isSafeInteger(expectedEndsAt) || expectedEndsAt <= 0
        || !Number.isSafeInteger(query.observedAt + durationMs)) return null;
      return { callId: call.callId, toolId: call.toolId, action: { kind: 'shorten', input: {
        id: input.id, expectedEndsAt, until: query.observedAt + durationMs,
      } } };
    }
    case 'phone_limit.end':
      return { callId: call.callId, toolId: call.toolId, action: { kind: 'end', input: parsed.input as { id: string } } };
    case 'phone_limit.release_app': {
      const input = parsed.input as import('./phoneLimitContract').PhoneLimitReleaseAppInput;
      const durationMs = minutes(input.durationMinutes);
      return durationMs === null ? null : { callId: call.callId, toolId: call.toolId, action: { kind: 'release', input: {
        id: operationId(call.callId), packageName: input.packageName, ...(durationMs === undefined ? {} : { durationMs }),
      } } };
    }
    default: return null;
  }
}

function releaseData(state: unknown, id: string, packageName: string, zone: string): { release: Record<string, string> | null } {
  const rows = phoneLimitObject(state)?.appReleases;
  const matches = Array.isArray(rows) ? rows.filter(row => phoneLimitObject(row)?.id === id) : [];
  const release = matches.length === 1 ? phoneLimitObject(matches[0]) : null;
  const until = release?.actor === 'I' && release.packageName === packageName
    && typeof release.startedAt === 'number' && Number.isSafeInteger(release.startedAt) && release.startedAt > 0
    && typeof release.until === 'number' && release.until > release.startedAt
    ? phoneLimitLocalInstant(release.until, zone) : null;
  return { release: until ? { [packageName]: until } : null };
}

function actionResult(call: JunLuoToolCall, prepared: PhoneLimitPreparedAction, native: PhoneLimitActionReceipt,
  query: PhoneLimitQuerySource | null, startedAt: number): JunLuoToolResult {
  const base = { callId: call.callId, toolId: call.toolId, startedAt, finishedAt: Date.now() };
  if (native.outcome === 'rejected') return phoneLimitPreExecutionResult({ ...base, ok: false, status: 'error', summary: '' });
  const state = native.state ?? query?.state;
  const at = native.observedAt ?? query?.observedAt;
  const zone = native.timeZoneId ?? query?.timeZoneId;
  const trusted = native.stateSaved && ['saved', 'unchanged', 'ended'].includes(native.outcome);
  const action = prepared.action;
  if (action.kind === 'release') {
    const data = releaseData(state, action.input.id, action.input.packageName, zone ?? '');
    const row = phoneLimitObject(state);
    const record = Array.isArray(row?.appReleases)
      ? row.appReleases.find(r => phoneLimitObject(r)?.id === action.input.id) : null;
    const ended = typeof at === 'number' && typeof phoneLimitObject(record)?.until === 'number'
      && at >= (record as Record<string, number>).until;
    return { ...base, ok: trusted && data.release !== null, status: trusted && data.release !== null ? 'success' : 'error',
      summary: trusted && data.release !== null ? ended ? '这次 App 放行已经结束。' : '本次 App 放行已设置。'
        : '暂时无法确认调整结果。', data };
  }
  const lock = typeof at === 'number' && zone && 'id' in action.input
    ? projectPhoneLimitActionLock(state, action.input.id, at, zone) : null;
  const valid = trusted && lock !== null;
  const ended = lock?.phase === 'ended';
  let summary = call.toolId === 'phone_limit.start' ? '暂时无法确认锁定结果。' : '暂时无法确认调整结果。';
  let ok = valid;
  if (valid && ended) summary = '这次锁定已经结束。';
  else if (valid && call.toolId === 'phone_limit.start') summary = '本次锁定已设置。';
  else if (valid && call.toolId === 'phone_limit.shorten') {
    if (native.outcome === 'unchanged') summary = '这次锁定的时间没有改变。';
    else if (action.kind === 'shorten' && native.priorEndsAt === action.input.expectedEndsAt
      && action.input.until < native.priorEndsAt
      && Array.isArray(phoneLimitObject(state)?.instances)
      && (phoneLimitObject(state)!.instances as unknown[]).some(row =>
        phoneLimitObject(row)?.id === action.input.id && phoneLimitObject(row)?.endsAt === action.input.until))
      summary = '这次锁定的时间已缩短。';
    else ok = false;
  } else if (valid) ok = false; // end needs an actual ended record.
  return { ...base, ok, status: ok ? 'success' : 'error', summary,
    data: call.toolId === 'phone_limit.start' ? { lock, display: projectPhoneLimitActionDisplay(query) } : { lock } };
}

/** Only actual same-request records may settle a pending call. No native mutation. */
export function reconcilePhoneLimitAction(call: JunLuoToolCall, prepared: PhoneLimitPreparedAction,
  query: PhoneLimitQuerySource | null): JunLuoToolResult {
  const state = phoneLimitObject(query?.state); const action = prepared.action;
  let proven = false;
  let outcome: PhoneLimitActionReceipt['outcome'] = 'unknown';
  if (state && query) {
    const rows = action.kind === 'release' ? state.appReleases : state.instances;
    const matches = Array.isArray(rows) ? rows.filter(row => phoneLimitObject(row)?.id === action.input.id) : [];
    const row = matches.length === 1 ? phoneLimitObject(matches[0]) : null;
    if (row && action.kind === 'release') {
      proven = row.actor === 'I' && row.packageName === action.input.packageName
        && (row.durationMs ?? undefined) === action.input.durationMs;
    } else if (row && action.kind === 'start') {
      const original = phoneLimitObject(row.originalRequest);
      const packages = original?.packages;
      proven = row.actor === 'I' && row.authorizationId === action.input.authorizationId
        && original?.scope === action.input.scope
        && Array.isArray(packages) && JSON.stringify([...packages].sort()) === JSON.stringify([...action.input.packages].sort())
        && (original.durationMs ?? undefined) === action.input.durationMs;
    } else if (row && (action.kind === 'end' || action.kind === 'shorten')) {
      const lock = projectPhoneLimitActionLock(state, action.input.id, query.observedAt, query.timeZoneId);
      proven = lock?.phase === 'ended' || action.kind === 'shorten'
        && row.endsAt === action.input.until && row.lastChangedBy === 'I';
    }
    if (proven) outcome = 'saved';
  }
  return actionResult(call, prepared, { outcome, stateSaved: proven, state: state ?? null,
    observedAt: query?.observedAt ?? null, timeZoneId: query?.timeZoneId ?? null,
    ...(action.kind === 'shorten' ? { priorEndsAt: action.input.expectedEndsAt } : {}) }, query, Date.now());
}

/** Domain execution; the ordinary-chat host owns same-call replay settlement. */
async function execute(call: JunLuoToolCall, options: PhoneLimitExecutionOptions): Promise<JunLuoToolResult> {
  const startedAt = Date.now();
  const base = { callId: call.callId, toolId: call.toolId, startedAt, finishedAt: startedAt };
  const rejected = () => phoneLimitPreExecutionResult({ ...base, ok: false, status: 'error', summary: '' });
  if (!isPhoneLimitToolId(call.toolId) || !call.callId.trim()) return rejected();
  const parsed = parsePhoneLimitToolInput(call.toolId, call.input);
  if (!parsed.ok) return rejected();
  if (call.toolId === 'phone_limit.get_status') return { ...base, ...await readPhoneLimitStatus(), finishedAt: Date.now() };
  const epoch = captureBackupRestoreDataEpoch();
  if (!canCommitBackupRestoreDataEpoch(epoch)) return rejected();
  const committed = await runBackupRestoreDataEpochCommit(epoch, async () => {
    if (call.toolId === 'phone_limit.set_plan') {
      const result = await savePhoneRestrictionManagedPlanForI(call.callId, parsed.input as PhoneLimitSetPlanInput, {
        query: () => readPhoneLimitActionQuery(epoch),
        validate: (input, expected) => executePhoneLimitNativeAction({ kind: 'validate_plan', input: { input, expected } }, epoch),
        put: (input, expected) => executePhoneLimitNativeAction({ kind: 'put_plan', input: { input, expected } }, epoch),
      }, { beforeWrite: options.beforePlanWrite, beforeSourceSave: options.beforePlanSourceSave });
      const summaries = { saved: '计划已保存。', unchanged: '计划没有改变。', rejected: '本次计划设置未执行。',
        source_saved: '计划设置已保存，暂时无法确认手机是否采用。', unknown: '暂时无法确认计划设置结果。' } as const;
      const ok = result.outcome === 'saved' || result.outcome === 'unchanged';
      return { ...base, ok, status: ok ? 'success' as const : 'error' as const,
        summary: summaries[result.outcome], data: result.data, finishedAt: Date.now() };
    }
    const query = call.toolId === 'phone_limit.start' || call.toolId === 'phone_limit.shorten'
      ? await readPhoneLimitActionQuery(epoch) : null;
    const prepared = preparePhoneLimitAction(call, query);
    if (!prepared || !canCommitBackupRestoreDataEpoch(epoch)) return rejected();
    try { await options.beforeDispatch?.(prepared); }
    catch { return rejected(); } // No native dispatch occurred.
    const native = await executePhoneLimitNativeAction(prepared.action, epoch);
    const observed = await readPhoneLimitActionQuery(epoch);
    return actionResult(call, prepared, native, observed, startedAt);
  });
  if (committed.committed && canCommitBackupRestoreDataEpoch(epoch)) return committed.value;
  return { ...base, ok: false, status: 'error', summary: call.toolId === 'phone_limit.start'
    ? '暂时无法确认锁定结果。' : call.toolId === 'phone_limit.set_plan' ? '暂时无法确认计划设置结果。' : '暂时无法确认调整结果。',
    finishedAt: Date.now() };
}

export async function executePhoneLimitCall(call: JunLuoToolCall, options: PhoneLimitExecutionOptions = {}): Promise<JunLuoToolResult> {
  const startedAt = Date.now();
  try { return await execute(call, options); }
  catch {
    return { callId: call.callId, toolId: call.toolId, ok: false, status: 'error', startedAt, finishedAt: Date.now(),
      summary: call.toolId === 'phone_limit.start' ? '暂时无法确认锁定结果。'
        : call.toolId === 'phone_limit.set_plan' ? '暂时无法确认计划设置结果。'
          : call.toolId === 'phone_limit.get_status' ? '暂时读不到手机情况。' : '暂时无法确认调整结果。' };
  }
}
