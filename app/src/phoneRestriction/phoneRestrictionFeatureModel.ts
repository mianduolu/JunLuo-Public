import type { PhoneRestrictionAuthorization, PhoneRestrictionConfiguration, PhoneRestrictionState } from '../backend/phoneRestrictionNative';
import type { PhoneActivityRule } from '../proactive/phoneActivityRules';
import { parsePhoneRestrictionAppTimes, parsePhoneRestrictionPlanInput, type PhoneRestrictionAppTimes, type PhoneRestrictionPlanInput, type PhoneRestrictionTimeWindow, type PhoneRestrictionWeekday } from '../proactive/phoneRestrictionSchedule';

export type PhoneCareDraft = {
  allowPhone: boolean; allowApps: boolean; allowPlans: boolean; packages: string[];
  weekdays: PhoneRestrictionWeekday[]; windows: PhoneRestrictionTimeWindow[];
  mode: 'warning' | 'direct'; temporaryMinutes: string; maximumHours: string; warningMinutes: string; releaseMinutes: string;
};
export type PhonePlanDraft = { title: string; input: PhoneRestrictionPlanInput };
export const PHONE_LOCAL_PLAN_PREFIX = 'phone-ui:you:plan:';
export const PHONE_LOCAL_APP_PREFIX = 'phone-ui:you:app:';
const AI_PREFIX = 'phone-ui:I:';
const FOREVER = Number.MAX_SAFE_INTEGER;

export function phoneMinutes(value: string, label: string, allowZero = false) {
  const minutes = Number(value.trim().replace(',', '.'));
  if (!value.trim() || !Number.isFinite(minutes) || minutes < (allowZero ? 0 : 1) || minutes > 1440) throw new Error(`${label}请填写${allowZero ? '0' : '1'}—1440分钟。`);
  return Math.round(minutes * 60000);
}
export function phoneRuleMinutes(value: string, label: string) { return Math.round(phoneMinutes(value, label) / 60000); }
export function phoneDateKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function emptyPhoneAppTimes(): PhoneRestrictionAppTimes { return { enabled: false, dates: null, allowed: [], blocked: [] }; }
export function phoneCareDraft(configuration: PhoneRestrictionConfiguration): PhoneCareDraft {
  const ai = configuration.authorizations.filter(grant => grant.actors.includes('I'));
  const allowance = ai.find(grant => grant.planAllowance)?.planAllowance;
  return { allowPhone: ai.some(grant => grant.scope === 'phone' && grant.allowTemporary !== false),
    allowApps: ai.some(grant => grant.scope === 'apps' && grant.allowTemporary !== false),
    allowPlans: !!allowance, packages: [...new Set(ai.flatMap(grant => grant.packages))],
    weekdays: allowance?.dates.weekdays ? [...allowance.dates.weekdays] : [], windows: allowance?.windows.map(window => ({ ...window })) ?? [],
    mode: configuration.defaultMode ?? 'warning', temporaryMinutes: String(configuration.durations.temporaryMs / 60000),
    maximumHours: String(configuration.durations.maximumTemporaryMs / 3600000), warningMinutes: String(configuration.durations.warningMs / 60000), releaseMinutes: String(configuration.durations.appReleaseMs / 60000) };
}
export function phoneCareConfiguration(configuration: PhoneRestrictionConfiguration, draft: PhoneCareDraft, now = Date.now()): PhoneRestrictionConfiguration {
  const durations = { ...configuration.durations, temporaryMs: phoneMinutes(draft.temporaryMinutes, '单次锁定'),
    maximumTemporaryMs: phoneMinutes(String(Number(draft.maximumHours) * 60), '单次上限'), warningMs: phoneMinutes(draft.warningMinutes, '提醒缓冲', true), appReleaseMs: phoneMinutes(draft.releaseMinutes, '单App临时放行') };
  if (durations.temporaryMs > durations.maximumTemporaryMs) throw new Error('单次锁定不能超过单次上限。');
  const previous = phoneCareDraft(configuration);
  const permissionKeys = ['allowPhone', 'allowApps', 'allowPlans', 'packages', 'weekdays', 'windows'] as const;
  const permissionsChanged = permissionKeys.some(key => JSON.stringify(previous[key]) !== JSON.stringify(draft[key]));
  if (!permissionsChanged) return { ...configuration, durations, defaultMode: draft.mode,
    authorizations: configuration.authorizations.map(grant => grant.actors.includes('I') ? { ...grant,
      maximumTemporaryMs: Math.max(grant.maximumTemporaryMs, durations.maximumTemporaryMs), modes: [...new Set([...grant.modes, draft.mode])] } : grant) };
  if (configuration.authorizations.some(grant => grant.actors.includes('I') && grant.actors.includes('you'))
    && (draft.allowPhone || draft.allowApps || draft.allowPlans)) throw new Error('现有共享授权不能在这里分开修改；默认时长仍可保存。');
  if (draft.allowApps && !draft.packages.length) throw new Error('请先选择允许锁定的App。');
  const allowance = draft.allowPlans ? { dates: { weekdays: draft.weekdays }, windows: draft.windows } : null;
  if (draft.allowPlans && !parsePhoneRestrictionPlanInput({ schedule: { id: 'check', enabled: true, dates: allowance!.dates, windows: allowance!.windows, mode: draft.mode, warningMs: durations.warningMs }, authorizationId: 'check', actor: 'I', scope: 'phone', packages: [] })) throw new Error('请选择可安排计划的星期和有效时段。');
  const authorizations: PhoneRestrictionAuthorization[] = [];
  const scopes = ['phone', 'apps'] as const;
  // Update existing grant IDs in place: a defaults edit must not revoke running instances.
  for (const grant of configuration.authorizations) {
    if (!grant.actors.includes('I')) { authorizations.push(grant); continue; }
    const allowTemporary = grant.scope === 'phone' ? draft.allowPhone : draft.allowApps;
    const packages = grant.scope === 'apps' ? draft.packages : [];
    const allowed = allowTemporary || (draft.allowPlans && (grant.scope === 'phone' || packages.length > 0));
    const actors = allowed ? grant.actors : grant.actors.filter(actor => actor !== 'I');
    if (!allowed && actors.length) authorizations.push({ ...grant, actors });
    else if (actors.length) authorizations.push({ ...grant, actors, packages, allowTemporary,
      maximumTemporaryMs: Math.max(grant.maximumTemporaryMs, durations.maximumTemporaryMs),
      modes: [...new Set([...grant.modes, draft.mode])], planAllowance: allowance });
  }
  for (const scope of scopes) {
    const allowTemporary = scope === 'phone' ? draft.allowPhone : draft.allowApps;
    const needed = allowTemporary || (draft.allowPlans && (scope === 'phone' || draft.packages.length > 0));
    if (!needed || authorizations.some(grant => grant.scope === scope && grant.actors.includes('I'))) continue;
    authorizations.push({ id: `${AI_PREFIX}${scope}`, scope, packages: scope === 'apps' ? draft.packages : [], phoneAllowlist: scope === 'phone' ? phoneAllowlist(configuration) : [],
      actors: ['I'], modes: [draft.mode], validFrom: now, validUntil: FOREVER, maximumTemporaryMs: durations.maximumTemporaryMs, allowTemporary, planAllowance: allowance });
  }
  return { ...configuration, durations, defaultMode: draft.mode, authorizations };
}
export function phoneAllowlist(configuration: PhoneRestrictionConfiguration): string[] {
  return [...new Set(configuration.authorizations.filter(grant => grant.scope === 'phone').flatMap(grant => grant.phoneAllowlist))];
}
export function localPhoneAuthorization(configuration: PhoneRestrictionConfiguration, id: string, scope: 'phone' | 'apps', packages: string[], allowance: PhoneRestrictionAuthorization['planAllowance'] = null, now = Date.now()): PhoneRestrictionConfiguration {
  const previous = configuration.authorizations.find(grant => grant.id === id);
  const grant: PhoneRestrictionAuthorization = { id, scope, packages: scope === 'apps' ? packages : [], actors: ['you'], modes: ['warning', 'direct'],
    phoneAllowlist: scope === 'phone' ? previous?.phoneAllowlist ?? phoneAllowlist(configuration) : [], validFrom: previous?.validFrom ?? now, validUntil: previous?.validUntil ?? FOREVER,
    maximumTemporaryMs: previous?.maximumTemporaryMs ?? configuration.durations.maximumTemporaryMs, allowTemporary: false, planAllowance: allowance };
  return { ...configuration, authorizations: [...configuration.authorizations.filter(item => item.id !== id), grant] };
}
export function validatePhoneAppTimes(times: PhoneRestrictionAppTimes) {
  const parsed = parsePhoneRestrictionAppTimes(times);
  if (!parsed) throw new Error('时段请填写HH:mm，起止不能相同；启用时请选择星期和至少一段时间。');
  return parsed;
}
export function validatePhonePlan(draft: PhonePlanDraft) {
  const parsed = parsePhoneRestrictionPlanInput(draft.input);
  if (!draft.title.trim()) throw new Error('请给计划起一个名字。');
  if (!parsed) throw new Error('请检查日期、星期、应用和时段；时间用HH:mm，起止不能相同。');
  return parsed;
}
export function phoneRestrictionSummary(state: PhoneRestrictionState | null, now: number) {
  if (!state || !state.configurationKnown || state.durationsKnown === false) return { title: '限制状态待读取', until: null as number | null };
  if (state.emergency && state.emergency.until > now) return { title: '应急解锁中', until: state.emergency.until };
  if (state.paused) return { title: '当前限制已暂停', until: null };
  const instances = state.instances.filter(instance => instance.phase !== 'ended' && instance.endsAt > now);
  if (!instances.length) return { title: '单次／计划：未锁定', until: null };
  const due = instances.filter(instance => instance.warningUntil <= now);
  return { title: due.length ? due.some(instance => instance.scope === 'phone') ? '整机限制已到点' : 'App限制已到点' : '即将限制',
    until: Math.max(...instances.map(instance => instance.warningUntil > now ? instance.warningUntil : instance.endsAt)) };
}
export function phoneWindowsSummary(windows: PhoneRestrictionTimeWindow[]) {
  return windows.length ? windows.map(window => `${window.startTime}—${window.endTime <= window.startTime ? '次日' : ''}${window.endTime}`).join(' · ') : '未设置';
}
export function phoneRuleSummary(rule: PhoneActivityRule) {
  return `${rule.appLock ? 'App锁' : rule.kind === 'whitelist' ? '夸夸' : rule.kind === 'jealousy' ? '会吃醋' : '原提醒'} · ${rule.thresholdMinutes}分钟${rule.dailyLimitMinutes ? ` · 每日${rule.dailyLimitMinutes}分钟` : ''}`;
}
