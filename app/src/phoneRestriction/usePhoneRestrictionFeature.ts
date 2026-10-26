import AsyncStorage from '@react-native-async-storage/async-storage';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit, subscribeBackupRestoreRuntimeState } from '../backup/backupRestoreCoordinator';
import { getInstalledPhoneApps, type InstalledPhoneApp } from '../backend/phoneActivityNative';
import { readPhoneRestrictionState, setPhoneRestrictionPaused, type PhoneRestrictionConfiguration, type PhoneRestrictionState } from '../backend/phoneRestrictionNative';
import { readPhoneRestrictionExecutionStatus, type PhoneRestrictionExecutionStatus } from '../backend/phoneRestrictionRecoveryNative';
import { createPhoneActivityRuleFromApp, isJunLuoPhoneApp, loadPhoneActivityProactiveSettings, savePhoneActivityProactiveSettings, type PhoneActivityProactiveSettings, type PhoneActivityRule } from '../proactive/phoneActivityRules';
import { loadPhoneRestrictionConfigurationSettings, loadPhoneRestrictionManagementSettings, PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY, savePhoneRestrictionConfigurationSettings, savePhoneRestrictionManagedAppTimeRules, savePhoneRestrictionManagedPlan, deletePhoneRestrictionManagedPlan, setPhoneRestrictionManagedPlanEnabled } from '../proactive/phoneRestrictionSettings';
import type { PhoneRestrictionManagement } from './phoneRestrictionManagement';
import type { PhoneRestrictionAppTimes } from '../proactive/phoneRestrictionSchedule';
import { withSettingsTimeout, SETTINGS_READ_TIMEOUT_MS } from '../screens/useSettingsRead';
import { localPhoneAuthorization, PHONE_LOCAL_APP_PREFIX, PHONE_LOCAL_PLAN_PREFIX, phoneCareConfiguration, phoneRuleMinutes, validatePhoneAppTimes, validatePhonePlan, type PhoneCareDraft, type PhonePlanDraft } from './phoneRestrictionFeatureModel';

// This editor owns legacy rules, never a stale copy of the separately saved authorization.
function withoutRestrictionConfiguration(settings: PhoneActivityProactiveSettings) {
  const { restrictionConfiguration: _configuration, ...rules } = settings;
  return rules;
}

export function usePhoneRestrictionFeature(active: boolean) {
  const [rules, setRules] = useState<PhoneActivityProactiveSettings | null>(null);
  const [configuration, setConfiguration] = useState<PhoneRestrictionConfiguration | null>(null);
  const [management, setManagement] = useState<PhoneRestrictionManagement | null>(null);
  const [state, setState] = useState<PhoneRestrictionState | null>(null);
  const [status, setStatus] = useState<PhoneRestrictionExecutionStatus | null>(null);
  const [apps, setApps] = useState<InstalledPhoneApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState('');
  const [errors, setErrors] = useState({ rules: '', configuration: '', management: '' });
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const session = useRef({ active: false, version: 0, runtimeVersion: 0, appsVersion: 0, saving: false });
  const visible = useRef(active); visible.current = active;
  const values = useRef({ rules, configuration, management }); values.current = { rules, configuration, management };
  const readRuntime = useCallback(async () => {
    const version = session.current.version;
    const request = ++session.current.runtimeVersion;
    const epoch = captureBackupRestoreDataEpoch();
    const current = () => session.current.active && version === session.current.version && request === session.current.runtimeVersion && canCommitBackupRestoreDataEpoch(epoch);
    const results = await Promise.allSettled([
      withSettingsTimeout(readPhoneRestrictionState(), SETTINGS_READ_TIMEOUT_MS, '限制状态读取超时'),
      withSettingsTimeout(readPhoneRestrictionExecutionStatus(), SETTINGS_READ_TIMEOUT_MS, '运行状态读取超时'),
    ]);
    if (!current()) return;
    setState(results[0].status === 'fulfilled' ? results[0].value.state : null);
    setStatus(results[1].status === 'fulfilled' ? results[1].value : null);
  }, []);
  const reload = useCallback(async () => {
    const version = ++session.current.version;
    const epoch = captureBackupRestoreDataEpoch();
    const current = () => session.current.active && version === session.current.version && canCommitBackupRestoreDataEpoch(epoch);
    async function readRules() {
      const raw = await AsyncStorage.getItem(PHONE_ACTIVITY_PROACTIVE_SETTINGS_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw);
        // A first configuration save can precede the first legacy-rule save in this shared key.
        const configurationOnly = parsed && !Array.isArray(parsed) && parsed.enabled === undefined && parsed.rules === undefined
          && (parsed.restrictionConfiguration !== undefined || parsed.restrictionManagement !== undefined);
        if (!parsed || (!configurationOnly && (typeof parsed.enabled !== 'boolean' || !Array.isArray(parsed.rules)))) throw new Error('设置格式不可读');
      }
      return loadPhoneActivityProactiveSettings();
    }
    const tasks = [
      withSettingsTimeout(readRules(), SETTINGS_READ_TIMEOUT_MS, '规则读取超时').then(value => { if (current()) { setRules(value); setErrors(old => ({ ...old, rules: '' })); } }).catch(() => { if (current()) { setRules(null); setErrors(old => ({ ...old, rules: '提醒设置读取失败，请重试。' })); } }),
      withSettingsTimeout(loadPhoneRestrictionConfigurationSettings(), SETTINGS_READ_TIMEOUT_MS, '配置读取超时').then(async result => {
        if (!current()) return;
        if (result.reason) throw new Error(result.reason);
        if (result.configuration) { setConfiguration(result.configuration); setErrors(old => ({ ...old, configuration: '' })); return; }
        const native = await withSettingsTimeout(readPhoneRestrictionState(), SETTINGS_READ_TIMEOUT_MS, '配置读取超时');
        if (!current()) return;
        if (!native.state?.configurationKnown || native.state.durationsKnown === false) throw new Error('配置未知');
        setConfiguration({ durations: native.state.durations, authorizations: native.state.authorizations, defaultMode: native.state.defaultMode }); setErrors(old => ({ ...old, configuration: '' }));
      }).catch(() => { if (current()) { setConfiguration(null); setErrors(old => ({ ...old, configuration: '限制配置读取失败，请重试。' })); } }),
      withSettingsTimeout(loadPhoneRestrictionManagementSettings(), SETTINGS_READ_TIMEOUT_MS, '计划读取超时').then(result => {
        if (!current()) return;
        setManagement(result.management); setErrors(old => ({ ...old, management: result.reason || !result.management ? '计划与时段读取失败，请重试。' : '' }));
      }).catch(() => { if (current()) { setManagement(null); setErrors(old => ({ ...old, management: '计划与时段读取失败，请重试。' })); } }),
      readRuntime(),
    ];
    await Promise.all(tasks);
  }, [readRuntime]);
  useEffect(() => {
    session.current.active = active && AppState.currentState === 'active';
    setBusy(session.current.saving); setAppsLoading(false);
    if (session.current.active) void reload();
    const subscription = AppState.addEventListener('change', next => { session.current.active = visible.current && next === 'active'; session.current.version++; if (session.current.active) { setBusy(session.current.saving); void reload(); } });
    const restoreSubscription = subscribeBackupRestoreRuntimeState(() => { session.current.version++; setState(null); setStatus(null); setConfiguration(null); setManagement(null); setRules(null); if (session.current.active) void reload(); });
    const clock = setInterval(() => { if (session.current.active) setNow(Date.now()); }, 1000);
    const runtime = setInterval(() => { if (session.current.active && !session.current.saving) void readRuntime(); }, 5000);
    return () => { session.current.active = false; session.current.version++; session.current.appsVersion++; subscription.remove(); restoreSubscription(); clearInterval(clock); clearInterval(runtime); };
  }, [active, reload, readRuntime]);
  async function loadApps() {
    const version = ++session.current.appsVersion; const epoch = captureBackupRestoreDataEpoch();
    setAppsLoading(true); setAppsError('');
    try {
      const loaded = await withSettingsTimeout(getInstalledPhoneApps(), 12000, '应用读取超时');
      if (version === session.current.appsVersion && canCommitBackupRestoreDataEpoch(epoch)) {
        const filtered = loaded.filter(app => !isJunLuoPhoneApp(app.source, app.title)); setApps(filtered); if (!filtered.length) setAppsError('没有读到可启动应用'); return filtered;
      }
      return [];
    } catch { if (version === session.current.appsVersion) setAppsError('应用读取失败'); return []; }
    finally { if (version === session.current.appsVersion) setAppsLoading(false); }
  }
  async function write(work: () => Promise<void>, draftEpoch: number | null) {
    if (session.current.saving) throw new Error('正在保存，请稍候。');
    if (!session.current.active || !canCommitBackupRestoreDataEpoch(draftEpoch)) throw new Error('数据已恢复或页面已离开，请重新打开编辑。');
    session.current.saving = true; setBusy(true); setNotice('');
    try { const result = await runBackupRestoreDataEpochCommit(draftEpoch, work); if (!result.committed || !canCommitBackupRestoreDataEpoch(draftEpoch)) throw new Error('数据已恢复，请重新读取。'); if (session.current.active) { setNotice('已保存'); await reload(); } }
    catch (error) { if (session.current.active) setNotice(error instanceof Error ? error.message : '保存未完成，请重试。'); throw error; }
    finally { session.current.saving = false; if (session.current.active) setBusy(false); }
  }
  function checkSaved(result: { storageSaved: boolean; nativeSaved: boolean; reason?: string }) {
    if (!result.storageSaved || !result.nativeSaved || result.reason) throw new Error(result.storageSaved ? `本机设置已保存，原生执行未确认，请重试（${result.reason ?? 'UNKNOWN'}）。` : `设置未保存，请重试（${result.reason ?? 'UNKNOWN'}）。`);
  }
  const saveRules = (next: PhoneActivityProactiveSettings, epoch = captureBackupRestoreDataEpoch()) => write(async () => { await savePhoneActivityProactiveSettings(withoutRestrictionConfiguration(next)); }, epoch);
  const saveCare = (draft: PhoneCareDraft, epoch: number | null) => write(async () => {
    const source = values.current.configuration; if (!source) throw new Error('请先重试读取限制配置。');
    checkSaved(await savePhoneRestrictionConfigurationSettings(phoneCareConfiguration(source, draft)));
  }, epoch);
  const saveRule = (rule: PhoneActivityRule, times: PhoneRestrictionAppTimes, epoch: number | null) => write(async () => {
    const current = values.current; if (!current.rules || !current.configuration || !current.management) throw new Error('请先重试读取设置。');
    const parsedTimes = rule.kind === 'blacklist' ? validatePhoneAppTimes(times) : null;
    let config = current.configuration;
    const authId = `${PHONE_LOCAL_APP_PREFIX}${rule.id}`;
    const previous = current.management.appTimeRules.find(item => item.packageName === rule.source);
    if (parsedTimes?.enabled) { config = localPhoneAuthorization(config, authId, 'apps', [rule.source]); checkSaved(await savePhoneRestrictionConfigurationSettings(config)); }
    await savePhoneActivityProactiveSettings(withoutRestrictionConfiguration({ ...current.rules, rules: [...current.rules.rules.filter(item => item.id !== rule.id), rule] }));
    if (parsedTimes && (parsedTimes.enabled || previous)) {
      const next = { id: previous?.id ?? `phone-ui:time:${rule.source}`, authorizationId: parsedTimes.enabled ? authId : previous!.authorizationId, packageName: rule.source, times: parsedTimes };
      const updated = previous ? current.management.appTimeRules.map(item => item.id === previous.id ? next : item) : [...current.management.appTimeRules, next];
      checkSaved(await savePhoneRestrictionManagedAppTimeRules(updated));
    }
  }, epoch);
  const savePlan = (draft: PhonePlanDraft, epoch: number | null) => write(async () => {
    const current = values.current.configuration; if (!current) throw new Error('请先重试读取配置。');
    let input = validatePhonePlan(draft);
    const previous = values.current.management?.plans.find(plan => plan.input.schedule.id === input.schedule.id)?.input;
    if (JSON.stringify(previous) !== JSON.stringify(input)) {
      // A changed future plan gets its own you grant; the current occurrence keeps its original grant and deadline.
      input = { ...input, actor: 'you', authorizationId: `${PHONE_LOCAL_PLAN_PREFIX}${input.schedule.id}:${Date.now()}` };
      checkSaved(await savePhoneRestrictionConfigurationSettings(localPhoneAuthorization(current, input.authorizationId, input.scope, input.packages, { dates: input.schedule.dates, windows: input.schedule.windows })));
    }
    checkSaved(await savePhoneRestrictionManagedPlan(input, draft.title.trim()));
  }, epoch);
  const removePlan = (id: string) => write(async () => { checkSaved(await deletePhoneRestrictionManagedPlan(id)); }, captureBackupRestoreDataEpoch());
  const removeRule = (id: string, epoch: number | null) => write(async () => {
    const current = values.current; if (!current.rules || !current.management) throw new Error('请先重试读取设置。');
    const rule = current.rules.rules.find(item => item.id === id);
    await savePhoneActivityProactiveSettings(withoutRestrictionConfiguration({ ...current.rules, rules: current.rules.rules.filter(item => item.id !== id) }));
    if (rule?.kind === 'blacklist' && current.management.appTimeRules.some(item => item.packageName === rule.source)) {
      checkSaved(await savePhoneRestrictionManagedAppTimeRules(current.management.appTimeRules.filter(item => item.packageName !== rule.source)));
    }
  }, epoch);
  const enablePlan = (id: string, enabled: boolean) => write(async () => { checkSaved(await setPhoneRestrictionManagedPlanEnabled(id, enabled)); }, captureBackupRestoreDataEpoch());
  const pause = (paused: boolean) => write(async () => { const result = await setPhoneRestrictionPaused(paused); if (!result.stateSaved || result.state?.paused !== paused) throw new Error('暂停状态未确认，请重试。'); }, captureBackupRestoreDataEpoch());
  const saveLockSettings = (allowlist: string[], emergency: string, epoch: number | null) => write(async () => {
    const current = values.current.configuration; if (!current) throw new Error('请先重试读取配置。');
    const emergencyMs = phoneRuleMinutes(emergency, '应急解锁') * 60000;
    const phoneGrants = current.authorizations.filter(grant => grant.scope === 'phone');
    const next = phoneGrants.length ? current : localPhoneAuthorization(current, 'phone-ui:you:allowlist', 'phone', []);
    checkSaved(await savePhoneRestrictionConfigurationSettings({ ...next, durations: { ...next.durations, emergencyMs }, authorizations: next.authorizations.map(grant => grant.scope === 'phone' ? { ...grant, phoneAllowlist: allowlist } : grant) }));
  }, epoch);
  function addApp(source: string) { const app = apps.find(item => item.source === source); return app ? createPhoneActivityRuleFromApp('blacklist', app) : null; }
  return { rules, configuration, management, state, status, apps, appsLoading, appsError, errors, notice, setNotice, busy, now,
    reload, loadApps, saveRules, saveCare, saveRule, savePlan, removeRule, removePlan, enablePlan, pause, saveLockSettings, addApp };
}
