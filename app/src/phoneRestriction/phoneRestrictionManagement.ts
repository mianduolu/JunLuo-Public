import {
  deletePhoneRestrictionPlan,
  readPhoneRestrictionState,
  savePhoneRestrictionAppTimeRules,
  savePhoneRestrictionPlan,
  setPhoneRestrictionPlanEnabled,
  type PhoneRestrictionResult,
  type PhoneRestrictionState,
} from '../backend/phoneRestrictionNative';
import {
  parsePhoneRestrictionAppTimeRule,
  parsePhoneRestrictionPlanInput,
  type PhoneRestrictionAppTimeRule,
  type PhoneRestrictionPlanInput,
} from '../proactive/phoneRestrictionSchedule';

// The source uses the existing settings/ZIP path. Titles never enter execution inputs.
export type PhoneRestrictionManagedPlan = { input: PhoneRestrictionPlanInput; title: string };
export type PhoneRestrictionManagement = {
  plans: PhoneRestrictionManagedPlan[];
  appTimeRules: PhoneRestrictionAppTimeRule[];
};

export function parsePhoneRestrictionManagement(value: unknown): PhoneRestrictionManagement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<PhoneRestrictionManagement>;
  if (!Array.isArray(record.plans) || !Array.isArray(record.appTimeRules)) return null;
  const plans: PhoneRestrictionManagedPlan[] = [];
  const appTimeRules: PhoneRestrictionAppTimeRule[] = [];
  for (const entry of record.plans) {
    if (!entry || typeof entry.title !== 'string' || !entry.title.trim()) return null;
    const input = parsePhoneRestrictionPlanInput(entry.input);
    if (!input) return null;
    plans.push({ input, title: entry.title });
  }
  for (const entry of record.appTimeRules) {
    const rule = parsePhoneRestrictionAppTimeRule(entry);
    if (!rule) return null;
    appTimeRules.push(rule);
  }
  return new Set(plans.map((plan) => plan.input.schedule.id)).size === plans.length
    && new Set(appTimeRules.map((rule) => rule.id)).size === appTimeRules.length ? { plans, appTimeRules } : null;
}

export function phoneRestrictionManagementFromNative(state: PhoneRestrictionState | null): PhoneRestrictionManagement | null {
  // An older native bridge without these fields is unknown, never an empty list.
  if (!state?.plans || !state.appTimeRules) return null;
  return parsePhoneRestrictionManagement({
    plans: state.plans.map((plan) => ({ input: plan, title: plan.schedule.id })),
    appTimeRules: state.appTimeRules,
  });
}

function planValue(input: PhoneRestrictionPlanInput, includeEnabled = true) {
  const parsed = parsePhoneRestrictionPlanInput(input)!;
  return JSON.stringify({ ...parsed, packages: [...parsed.packages].sort(), schedule: {
    ...parsed.schedule,
    ...(includeEnabled ? {} : { enabled: undefined }),
    windows: [...parsed.schedule.windows].sort((a, b) => a.id.localeCompare(b.id)),
  } });
}

function appRulesValue(rules: PhoneRestrictionAppTimeRule[]) {
  return JSON.stringify(rules.map((rule) => parsePhoneRestrictionAppTimeRule(rule)!)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((rule) => ({ ...rule, times: { ...rule.times,
      allowed: [...rule.times.allowed].sort((a, b) => a.id.localeCompare(b.id)),
      blocked: [...rule.times.blocked].sort((a, b) => a.id.localeCompare(b.id)),
    } })));
}

export async function synchronizePhoneRestrictionManagement(management: PhoneRestrictionManagement): Promise<PhoneRestrictionResult> {
  let result = await readPhoneRestrictionState();
  if (!result.state || !phoneRestrictionManagementFromNative(result.state)) {
    return { ...result, stateSaved: false, reason: result.reason ?? 'INVALID_STATE' };
  }
  // Existing native operations retain active occurrence deadlines and only edit future rounds.
  for (const { input } of management.plans) {
    const current = result.state!.plans!.find((plan) => plan.schedule.id === input.schedule.id);
    if (current && planValue(current) === planValue(input)) continue;
    result = current && planValue(current, false) === planValue(input, false)
      ? await setPhoneRestrictionPlanEnabled(input.schedule.id, input.schedule.enabled)
      : await savePhoneRestrictionPlan(input);
    const saved = result.state?.plans?.find((plan) => plan.schedule.id === input.schedule.id);
    if (!result.stateSaved || !phoneRestrictionManagementFromNative(result.state) || !saved || planValue(saved) !== planValue(input)) {
      return { ...result, stateSaved: false };
    }
  }
  for (const plan of [...result.state!.plans!]) {
    if (management.plans.some((entry) => entry.input.schedule.id === plan.schedule.id)) continue;
    result = await deletePhoneRestrictionPlan(plan.schedule.id, 'you');
    if (!result.stateSaved || !phoneRestrictionManagementFromNative(result.state)
      || result.state!.plans!.some((entry) => entry.schedule.id === plan.schedule.id)) {
      return { ...result, stateSaved: false };
    }
  }
  if (appRulesValue(result.state!.appTimeRules!) !== appRulesValue(management.appTimeRules)) {
    result = await savePhoneRestrictionAppTimeRules(management.appTimeRules);
    if (!result.stateSaved || !result.state?.appTimeRules
      || appRulesValue(result.state.appTimeRules) !== appRulesValue(management.appTimeRules)) {
      return { ...result, stateSaved: false };
    }
  }
  return { ...result, stateSaved: true };
}
