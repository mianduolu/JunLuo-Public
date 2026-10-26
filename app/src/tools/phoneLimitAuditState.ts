import { isPhoneLimitToolId, type PhoneLimitToolId } from './phoneLimitContract';
import { parsePhoneRestrictionPlanInput } from '../proactive/phoneRestrictionSchedule';
import type { PhoneLimitPreparedAction } from './phoneLimitExecution';
import type { PhoneLimitPreparedPlan } from './phoneLimitPlanExecution';
import type { JunLuoToolResult } from './toolTypes';

/** Device-local continuation in the existing tool audit; never a model or sync field. */
export type PhoneLimitSave = {
  dataEpoch: number;
  toolId: PhoneLimitToolId;
  inputHash: string;
  prepared: PhoneLimitPreparedAction | PhoneLimitPreparedPlan | null;
  result: JunLuoToolResult | null;
};

const row = (value: unknown): Record<string, unknown> | null => value !== null
  && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const only = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
const id = (value: unknown): value is string => typeof value === 'string' && !!value.trim();
const time = (value: unknown, zero = false): value is number => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= (zero ? 0 : 1);
const packages = (value: unknown): value is string[] => Array.isArray(value)
  && value.every(id) && new Set(value).size === value.length;

function preparedAction(value: unknown, callId: string, toolId: PhoneLimitToolId): PhoneLimitPreparedAction | null {
  const record = row(value); const action = row(record?.action); const input = row(action?.input);
  if (!record || !action || !input || !only(record, ['callId', 'toolId', 'action'])
    || !only(action, ['kind', 'input']) || record.callId !== callId || record.toolId !== toolId) return null;
  const durationValid = input.durationMs === undefined || time(input.durationMs);
  if (toolId === 'phone_limit.start' && action.kind === 'start' && durationValid
    && only(input, ['id', 'authorizationId', 'scope', 'packages', 'durationMs'])
    && input.id === `phone_limit:${callId}` && id(input.authorizationId) && packages(input.packages)
    && (input.scope === 'phone' ? input.packages.length === 0 : input.scope === 'apps' && input.packages.length > 0)) {
    return { callId, toolId, action: { kind: 'start', input: { id: input.id, authorizationId: input.authorizationId,
      scope: input.scope as 'phone' | 'apps', packages: [...input.packages], ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs as number }) } } };
  }
  if (toolId === 'phone_limit.shorten' && action.kind === 'shorten' && id(input.id)
    && only(input, ['id', 'expectedEndsAt', 'until']) && time(input.expectedEndsAt) && time(input.until)) {
    return { callId, toolId, action: { kind: 'shorten', input: { id: input.id, expectedEndsAt: input.expectedEndsAt, until: input.until } } };
  }
  if (toolId === 'phone_limit.end' && action.kind === 'end' && only(input, ['id']) && id(input.id)) {
    return { callId, toolId, action: { kind: 'end', input: { id: input.id } } };
  }
  if (toolId === 'phone_limit.release_app' && action.kind === 'release' && durationValid
    && only(input, ['id', 'packageName', 'durationMs']) && input.id === `phone_limit:${callId}` && id(input.packageName)) {
    return { callId, toolId, action: { kind: 'release', input: { id: input.id, packageName: input.packageName,
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs as number }) } } };
  }
  return null;
}

function preparedPlan(value: unknown, callId: string): PhoneLimitPreparedPlan | null {
  const record = row(value); const input = parsePhoneRestrictionPlanInput(record?.input);
  if (!record || !only(record, ['observedAt', 'input', 'title', 'previous', 'expected'])
    || !time(record.observedAt) || !input || input.actor !== 'I' || !id(record.title)) return null;
  if (record.previous === null && record.expected === null) {
    return input.schedule.id === `phone_limit:${callId}`
      ? { observedAt: record.observedAt, input, title: record.title, previous: null, expected: null } : null;
  }
  const prior = row(record.previous); const previous = parsePhoneRestrictionPlanInput(prior?.input);
  const expectedRow = row(record.expected); const expected = parsePhoneRestrictionPlanInput(record.expected);
  if (!prior || !only(prior, ['input', 'title']) || !previous || previous.actor !== 'I' || !id(prior.title)
    || !expectedRow || !expected || expected.actor !== 'I' || !time(expectedRow.createdAt)
    || expectedRow.createdAt > record.observedAt || !time(expectedRow.futureFrom, true)
    || previous.schedule.id !== input.schedule.id || expected.schedule.id !== input.schedule.id
    || previous.authorizationId !== input.authorizationId || expected.authorizationId !== input.authorizationId
    || prior.title !== record.title || previous.scope !== input.scope || expected.scope !== input.scope
    || JSON.stringify([...previous.packages].sort()) !== JSON.stringify([...input.packages].sort())
    || JSON.stringify([...expected.packages].sort()) !== JSON.stringify([...input.packages].sort())
    || previous.schedule.mode !== input.schedule.mode || expected.schedule.mode !== input.schedule.mode
    || previous.schedule.warningMs !== input.schedule.warningMs || expected.schedule.warningMs !== input.schedule.warningMs
    || previous.schedule.enabled !== input.schedule.enabled || expected.schedule.enabled !== input.schedule.enabled) return null;
  return { observedAt: record.observedAt, input, title: record.title,
    previous: { input: previous, title: prior.title }, expected: { ...expected, createdAt: expectedRow.createdAt, futureFrom: expectedRow.futureFrom } };
}

function json(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => json(item, depth + 1));
  const record = row(value);
  return !!record && Object.values(record).every(item => json(item, depth + 1));
}
function savedResult(value: unknown, callId: string, toolId: string): JunLuoToolResult | null {
  const record = row(value); const error = record?.error === undefined ? null : row(record.error);
  if (!record || !only(record, ['callId', 'toolId', 'ok', 'status', 'summary', 'data', 'error', 'startedAt', 'finishedAt'])
    || record.callId !== callId || record.toolId !== toolId || typeof record.ok !== 'boolean'
    || !['success', 'error', 'permission_denied', 'cancelled'].includes(String(record.status))
    || typeof record.summary !== 'string' || !time(record.startedAt, true) || !time(record.finishedAt, true)
    || record.finishedAt < record.startedAt || (record.data !== undefined && !json(record.data))
    || (record.error !== undefined && (!error || !only(error, ['code', 'message', 'details'])
      || !id(error.code) || typeof error.message !== 'string' || (error.details !== undefined && !json(error.details))))) return null;
  return JSON.parse(JSON.stringify(record)) as JunLuoToolResult;
}

export function normalizePhoneLimitSave(value: unknown, callId: string, toolId: string): PhoneLimitSave | null {
  const record = row(value);
  if (!record || !only(record, ['dataEpoch', 'toolId', 'inputHash', 'prepared', 'result'])
    || !id(callId) || !isPhoneLimitToolId(toolId) || record.toolId !== toolId || !time(record.dataEpoch, true)
    || typeof record.inputHash !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(record.inputHash)) return null;
  const prepared = record.prepared === null ? null : toolId === 'phone_limit.set_plan'
    ? preparedPlan(record.prepared, callId) : preparedAction(record.prepared, callId, toolId);
  const result = record.result === null ? null : savedResult(record.result, callId, toolId);
  if ((record.prepared !== null && !prepared) || (record.result !== null && !result)) return null;
  return { dataEpoch: record.dataEpoch, toolId: record.toolId as PhoneLimitToolId,
    inputHash: record.inputHash, prepared, result };
}
