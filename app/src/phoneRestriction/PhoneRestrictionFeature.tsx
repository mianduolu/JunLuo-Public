import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, Image, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { defaultPhoneActivityProactiveSettings, createPhoneActivityRuleFromApp, type PhoneActivityRule, type PhoneActivityRuleKind } from '../proactive/phoneActivityRules';
import type { PhoneRestrictionAppTimes } from '../proactive/phoneRestrictionSchedule';
import { phoneRestrictionRecoveryIssueStates } from '../proactive/phoneRestrictionRecovery';
import { getOverlayTextStyle, type HomeBackgroundReadability } from '../theme/homeReadability';
import type { Navigate } from '../types/navigation';
import { PhoneCareEditor, PhoneLockSettingsEditor, PhonePlanEditor, PhoneRuleEditor } from './PhoneRestrictionEditors';
import { PhoneAppPicker, PhoneCard, PhoneIcon, PhoneRow, PhoneSave, PhoneSection, PhoneSwitch, phoneUi } from './PhoneRestrictionUi';
import { emptyPhoneAppTimes, phoneAllowlist, phoneCareDraft, phoneDateKey, phoneRestrictionSummary, phoneRuleSummary, phoneWindowsSummary, type PhonePlanDraft } from './phoneRestrictionFeatureModel';
import { PhoneUsagePanel } from './PhoneUsagePanel';
import { usePhoneUsagePanel } from './usePhoneUsagePanel';
import { formatPhoneUsageDuration, formatPhoneUsageUpdatedAt } from './phoneUsageFormatting';
import { usePhoneJealousySettings } from './usePhoneJealousySettings';
import { usePhoneRestrictionFeature } from './usePhoneRestrictionFeature';

type Page = 'home' | 'usage' | 'settings' | 'plans' | 'care' | 'rule' | 'plan' | 'praise' | 'jealousy' | 'status' | 'lockSettings';
type RuleDraft = { rule: PhoneActivityRule; times: PhoneRestrictionAppTimes };
type Picker = { title: string; selected: string[]; onSelect: (packages: string[]) => void };
const titles: Record<Page, string> = { home: '交出手机', usage: '手机使用', settings: '限制设置', plans: '锁机计划', care: '交给云云', rule: 'App限制', plan: '编辑计划', praise: '夸夸名单', jealousy: '会吃醋', status: '运行状态', lockSettings: '锁机设置' };
const editable: Page[] = ['care', 'rule', 'plan', 'lockSettings'];

function UsageNumber({ durationMs }: { durationMs: number }) {
  const minutes = Math.max(0, Math.round(durationMs / 60000));
  const hours = Math.floor(minutes / 60);
  return <Text style={styles.usageNumber}>{hours ? <>{hours}<Text style={styles.usageUnit}>小时</Text></> : null}{!hours || minutes % 60 ? <>{minutes % 60}<Text style={styles.usageUnit}>分钟</Text></> : null}</Text>;
}

export function PhoneRestrictionFeature({ active, backgroundReadability, navigate, onOpenFeatureDrawer }: {
  active: boolean; backgroundReadability: HomeBackgroundReadability; navigate: Navigate; onOpenFeatureDrawer: () => void;
}) {
  const feature = usePhoneRestrictionFeature(active);
  const [page, setPage] = useState<Page>('home');
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [planDraft, setPlanDraft] = useState<PhonePlanDraft | null>(null);
  const [picker, setPicker] = useState<Picker | null>(null);
  const [switchDraft, setSwitchDraft] = useState<{ enabled: boolean; jealousyEnabled: boolean } | null>(null);
  const editEpoch = useRef<number | null>(null);
  const dirty = useRef(false);
  const save = useRef<(() => void) | undefined>(undefined);
  const leaving = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const insets = useSafeAreaInsets();
  const labelColor = getOverlayTextStyle(backgroundReadability.exposedLabelText).color as string;
  const headerText = getOverlayTextStyle(backgroundReadability.headerText);
  const usage = usePhoneUsagePanel({ active: active && (page === 'home' || page === 'usage'), allowComment: page === 'usage' });
  const jealousy = usePhoneJealousySettings({ settings: feature.rules ?? defaultPhoneActivityProactiveSettings, apps: feature.apps,
    loadApps: feature.loadApps, onSave: next => feature.saveRules(next), onNotice: notice => feature.setNotice(notice.text), active: active && page === 'jealousy' && !!feature.rules });
  const onDirty = useCallback((value: boolean) => { dirty.current = value; }, []);
  const onSaveReady = useCallback((handler?: () => void) => { save.current = handler; }, []);
  const onError = useCallback((message: string) => { if (mounted.current) feature.setNotice(message); }, [feature.setNotice]);
  const common = { color: labelColor, busy: feature.busy, onDirty, onSaveReady, onError };
  const editorKnown = page === 'home' ? !!feature.rules : page === 'care' || page === 'lockSettings' ? !!feature.configuration
    : !!feature.configuration && !!feature.rules && !!feature.management;
  const action = (work: () => Promise<unknown>) => { void work().catch(error => onError(error instanceof Error ? error.message : '操作未完成，请重试。')); };
  const open = (next: Page) => { dirty.current = false; setSwitchDraft(null); save.current = undefined; editEpoch.current = captureBackupRestoreDataEpoch(); feature.setNotice(''); setPage(next); };
  const parentPage = () => page === 'rule' ? ruleDraft?.rule.kind === 'whitelist' ? 'praise' : ruleDraft?.rule.kind === 'jealousy' ? 'jealousy' : 'settings' : page === 'plan' ? 'plans' : page === 'lockSettings' || page === 'praise' || page === 'jealousy' ? 'settings' : 'home';
  const leave = (work: () => void) => {
    if (feature.busy || jealousy.busy) return;
    if (!dirty.current) { work(); return; }
    if (leaving.current) return;
    leaving.current = true;
    Alert.alert('放弃这次修改？', undefined, [
      { text: '继续编辑', style: 'cancel', onPress: () => { leaving.current = false; } },
      { text: '放弃修改', style: 'destructive', onPress: () => { leaving.current = false; work(); } },
    ], { cancelable: true, onDismiss: () => { leaving.current = false; } });
  };
  const back = () => leave(() => { if (page === 'home') { open('home'); navigate('home'); } else open(parentPage()); });
  const changeSwitch = (key: 'enabled' | 'jealousyEnabled', value: boolean) => {
    if (!feature.rules || feature.busy) return;
    if (!dirty.current) editEpoch.current = captureBackupRestoreDataEpoch();
    dirty.current = true;
    setSwitchDraft(old => ({ enabled: feature.rules!.enabled, jealousyEnabled: feature.rules!.jealousyEnabled === true, ...old, [key]: value }));
  };
  const latestBack = useRef(back); latestBack.current = back;
  useEffect(() => {
    if (!active) return;
    const listener = BackHandler.addEventListener('hardwareBackPress', () => { if (page === 'home' && !dirty.current) return false; latestBack.current(); return true; });
    return () => listener.remove();
  }, [active, page]);
  const pickApps = (title: string, packages: string[], onSelect: (packages: string[]) => void) => {
    setPicker({ title, selected: packages, onSelect }); if (!feature.apps.length) void feature.loadApps();
  };
  const appNames = (packages: string[]) => packages.length ? packages.map(source => feature.apps.find(app => app.source === source)?.title ?? feature.rules?.rules.find(rule => rule.source === source)?.title ?? source).join('、') : '未选择';
  const editRule = (rule: PhoneActivityRule) => { setRuleDraft({ rule, times: feature.management?.appTimeRules.find(item => item.packageName === rule.source)?.times ?? emptyPhoneAppTimes() }); open('rule'); };
  const selectRule = (kind: PhoneActivityRuleKind, packages: string[]) => {
    const app = feature.apps.find(item => item.source === packages[packages.length - 1]);
    if (!app) return;
    setPicker(null); editRule(feature.rules?.rules.find(rule => rule.kind === kind && rule.source === app.source) ?? createPhoneActivityRuleFromApp(kind, app));
  };
  const latestRuleSelection = useRef(selectRule); latestRuleSelection.current = selectRule;
  const addRule = (kind: PhoneActivityRuleKind) => pickApps('添加应用', [], packages => latestRuleSelection.current(kind, packages));
  const newPlan = () => {
    const id = `phone-ui:plan:${Date.now()}`;
    setPlanDraft({ title: '', input: { actor: 'you', authorizationId: id, scope: 'phone', packages: [], schedule: { id, enabled: true, dates: { localDate: phoneDateKey() }, windows: [{ id: 'main', startTime: '', endTime: '' }], mode: feature.configuration?.defaultMode ?? 'warning', warningMs: feature.configuration?.durations.warningMs ?? 180000 } } }); open('plan');
  };
  const summary = phoneRestrictionSummary(feature.state, feature.now);
  const issueStates = phoneRestrictionRecoveryIssueStates(feature.status, feature.now);
  const faults = Object.values(issueStates).some(state => state === 'fault');
  const runtimeText = faults ? '限制服务需要恢复' : Object.values(issueStates).some(state => state === 'unknown') ? '运行状态待读取' : feature.status?.restorePaused ? '数据恢复中' : '当前所需权限与服务正常';
  const currentPlan = feature.management?.plans.find(plan => plan.input.schedule.enabled);
  const retry = (error: string) => <PhoneCard><View style={styles.pad}><Text style={phoneUi.error}>{error || '正在读取…'}</Text><Pressable onPress={() => void feature.reload()}><Text style={phoneUi.link}>重新读取 ›</Text></Pressable></View></PhoneCard>;
  const ruleList = (kind: PhoneActivityRuleKind) => <>
    {feature.rules && feature.management ? <PhoneCard>{feature.rules.rules.filter(rule => rule.kind === kind).map(rule => {
      const reason = kind === 'jealousy' ? jealousy.findCandidateForRule(rule)?.reason : undefined;
      return <View key={rule.id}><PhoneRow label={rule.title} sub={[phoneRuleSummary(rule), reason ? `吃醋理由：${reason}` : undefined].filter(Boolean).join('\n')} onPress={() => editRule(rule)} />{kind === 'jealousy' ? <View style={styles.planActions}><Pressable disabled={feature.busy || jealousy.busy} onPress={() => action(() => jealousy.removeRule(rule.id))}><Text style={phoneUi.link}>删除</Text></Pressable></View> : null}</View>;
    })}{!feature.rules.rules.some(rule => rule.kind === kind) ? <View style={styles.pad}><Text style={phoneUi.sub}>还没有添加应用</Text></View> : null}<PhoneRow label="＋ 添加应用" onPress={() => addRule(kind)} /></PhoneCard> : retry(feature.errors.rules || feature.errors.management)}
  </>;
  const afterSave = (target: Page) => { if (mounted.current) { dirty.current = false; open(target); } };
  const deleteRule = () => {
    if (!ruleDraft || !feature.rules || !feature.management) return;
    const rule = ruleDraft.rule;
    Alert.alert(`删除${rule.title}的设置？`, rule.kind === 'blacklist' ? '这个App的使用时长与全部时段设置都会删除。' : undefined, [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => action(async () => {
      await feature.removeRule(rule.id, editEpoch.current); afterSave(rule.kind === 'whitelist' ? 'praise' : 'settings');
    }) }]);
  };

  let content;
  if (page === 'home') content = <>
    <PhoneCard><View style={styles.hero}><View style={styles.state}><PhoneIcon name="lock" /><Text style={styles.stateText}>{summary.title}</Text></View><Image source={require('../../assets/images/baiyun-status/calm.png')} style={styles.calm} /><Text style={styles.usageLabel}>{summary.until ? '还剩' : '今天用了'}</Text>{summary.until || usage.summary ? <UsageNumber durationMs={summary.until ? Math.ceil(Math.max(0, summary.until - feature.now) / 60000) * 60000 : usage.summary!.days[0]?.totalDurationMs ?? 0} /> : <Text style={[styles.usageNumber, styles.usagePending]}>{usage.error ? '统计待读取' : '读取中…'}</Text>}
      {usage.summary?.todayTopApps.length ? <ScrollView accessibilityLabel="今日App使用时长" nestedScrollEnabled showsVerticalScrollIndicator style={styles.usageScroll} contentContainerStyle={styles.miniStats}>
        {usage.summary.todayTopApps.map(app => <View key={app.source || app.title} style={styles.mini}>
          <Text style={phoneUi.sub} numberOfLines={1}>{app.title}</Text>
          <Text style={styles.appDuration} numberOfLines={1}>{formatPhoneUsageDuration(app.durationMs)}</Text>
          <View style={styles.track}><View style={[styles.fill, { width: `${Math.min(100, app.durationMs / Math.max(1, usage.summary!.days[0]?.totalDurationMs ?? 0) * 100)}%` }]} /></View>
        </View>)}
      </ScrollView> : null}
      {!summary.until && usage.summary ? <Text style={[phoneUi.sub, styles.updatedAt]}>{usage.loading ? '更新中 · 上次' : '更新于'} {formatPhoneUsageUpdatedAt(usage.summary.updatedAt)}</Text> : null}
      {usage.error && usage.summary ? <Text style={phoneUi.error}>{usage.error}</Text> : null}
      {feature.state?.configurationKnown && (feature.state.instances.some(instance => instance.phase !== 'ended' && instance.endsAt > feature.now) || feature.state.paused) ? <Pressable disabled={feature.busy} onPress={() => action(() => feature.pause(!feature.state!.paused))}><Text style={phoneUi.link}>{feature.state.paused ? '恢复当前限制' : '暂停当前限制'}</Text></Pressable> : null}
    </View></PhoneCard>
    {!summary.until && usage.summary && usage.ownUsageNote ? <Text style={[phoneUi.sub, { color: labelColor, marginHorizontal: 5, marginBottom: 8 }]}>{usage.ownUsageNote}</Text> : null}
    {feature.rules ? <View pointerEvents={feature.busy ? 'none' : 'auto'}><PhoneCard><PhoneSwitch label="时长提醒与限制" sub="App时长锁 · 原提醒 · 夸夸" value={switchDraft?.enabled ?? feature.rules.enabled} onChange={value => changeSwitch('enabled', value)} /><PhoneSwitch label="会吃醋" value={switchDraft?.jealousyEnabled ?? feature.rules.jealousyEnabled === true} onChange={value => changeSwitch('jealousyEnabled', value)} /></PhoneCard></View> : retry(feature.errors.rules)}
    <Pressable style={styles.next} onPress={() => leave(() => open('plans'))}><PhoneIcon name="calendar" /><Text style={styles.nextText}>{currentPlan ? `${currentPlan.title} · ${phoneWindowsSummary(currentPlan.input.schedule.windows)}` : feature.management ? '还没有启用计划' : '计划待读取'}</Text><Text style={phoneUi.arrow}>›</Text></Pressable>
    <PhoneCard>{([{ label: '手机使用', sub: '今天 · 最近一周', icon: 'usage', page: 'usage' }, { label: '限制设置', sub: 'App锁 · 原提醒 · 放行应用', icon: 'lock', page: 'settings' }, { label: '锁机计划', sub: '查看和编辑安排', icon: 'calendar', page: 'plans' }, { label: '交给云云', sub: '范围 · 模式 · 默认时长', icon: 'heart', page: 'care' }] as const).map(item => <PhoneRow key={item.page} label={item.label} sub={item.sub} onPress={() => leave(() => open(item.page))} leading={<View style={styles.menuIcon}><PhoneIcon name={item.icon} /></View>} />)}</PhoneCard>
    <Pressable style={styles.status} onPress={() => leave(() => { if (faults) { open('home'); navigate('phone-manager'); } else open('status'); })}><Text style={[styles.statusText, { color: labelColor }]}>• {runtimeText}</Text><Text style={{ color: labelColor }}>{faults ? '去恢复 ›' : '›'}</Text></Pressable>
  </>;
  else if (page === 'usage') content = <PhoneUsagePanel panel={usage} onOpenManager={() => navigate('phone-manager')} />;
  else if (page === 'settings') content = <>
    <PhoneSection title="受限应用" color={labelColor} />{ruleList('blacklist')}<PhoneSection title="锁机" color={labelColor} /><PhoneCard><PhoneRow label="放行应用与应急解锁" onPress={() => open('lockSettings')} /></PhoneCard><PhoneSection title="其他名单" color={labelColor} /><PhoneCard><PhoneRow label="夸夸名单" onPress={() => open('praise')} /><PhoneRow label="会吃醋" onPress={() => open('jealousy')} /></PhoneCard>
  </>;
  else if (page === 'praise') content = ruleList('whitelist');
  else if (page === 'jealousy') content = <>{ruleList('jealousy')}{feature.rules ? <PhoneCard><PhoneRow label="让ta自己挑" sub={jealousy.busy ? '白云在看…' : undefined} onPress={() => { if (!jealousy.busy) action(jealousy.pickApps); }} /><PhoneRow label="玩闹半小时" onPress={() => action(() => jealousy.pause(30))} /><PhoneRow label="今天放纵" onPress={() => action(jealousy.indulgeToday)} />{feature.rules.jealousyPausedUntil && feature.rules.jealousyPausedUntil > feature.now ? <View style={styles.pad}><Text style={phoneUi.sub}>暂停至{new Date(feature.rules.jealousyPausedUntil).toLocaleString('zh-CN')}</Text></View> : null}{(feature.rules.jealousyCandidateApps ?? []).filter(candidate => candidate.status === 'pending').map(candidate => <PhoneRow key={candidate.id} label={candidate.title} sub={candidate.reason}><Pressable onPress={() => action(() => jealousy.acceptCandidate(candidate))}><Text style={phoneUi.link}>确认</Text></Pressable><Pressable onPress={() => action(() => jealousy.dismissCandidate(candidate))}><Text style={phoneUi.link}>关掉</Text></Pressable></PhoneRow>)}</PhoneCard> : null}</>;
  else if (page === 'plans') content = feature.management && feature.configuration ? <PhoneCard>{feature.management.plans.map(plan => <View key={plan.input.schedule.id}><PhoneRow label={plan.title} sub={`${plan.input.schedule.dates.weekdays ? '每周重复' : plan.input.schedule.dates.localDate} · ${phoneWindowsSummary(plan.input.schedule.windows)}`} onPress={() => { setPlanDraft(plan); open('plan'); }} /><View style={styles.planActions}><Pressable disabled={feature.busy} onPress={() => action(() => feature.enablePlan(plan.input.schedule.id, !plan.input.schedule.enabled))}><Text style={phoneUi.link}>{plan.input.schedule.enabled ? '停用后续计划' : '启用计划'}</Text></Pressable><Pressable disabled={feature.busy} onPress={() => Alert.alert('删除后续计划？', '当前这一轮仍按原截止结束。', [{ text: '取消', style: 'cancel' }, { text: '删除', style: 'destructive', onPress: () => action(() => feature.removePlan(plan.input.schedule.id)) }])}><Text style={phoneUi.link}>删除</Text></Pressable></View></View>)}<PhoneRow label="＋ 新建计划" onPress={newPlan} /></PhoneCard> : retry(feature.errors.management || feature.errors.configuration);
  else if (page === 'rule') content = ruleDraft ? <PhoneRuleEditor {...common} rule={ruleDraft.rule} times={ruleDraft.times} usageEnabled={ruleDraft.rule.kind === 'jealousy' || feature.rules?.enabled === true} additionalTimeRules={Math.max(0, (feature.management?.appTimeRules.filter(item => item.packageName === ruleDraft.rule.source).length ?? 0) - 1)} onDelete={ruleDraft.rule.kind === 'jealousy' ? undefined : deleteRule} onSave={async (rule, times) => { await feature.saveRule(rule, times, editEpoch.current); afterSave(rule.kind === 'whitelist' ? 'praise' : rule.kind === 'jealousy' ? 'jealousy' : 'settings'); }} /> : null;
  else if (page === 'plan') content = planDraft ? <PhonePlanEditor {...common} initial={planDraft} pickApps={pickApps} appNames={appNames} onSave={async draft => { await feature.savePlan(draft, editEpoch.current); afterSave('plans'); }} /> : null;
  else if (page === 'care') content = feature.configuration ? <PhoneCareEditor {...common} configuration={feature.configuration} pickApps={pickApps} appNames={appNames} onSave={async draft => { await feature.saveCare(draft, editEpoch.current); afterSave('home'); }} onWithdraw={() => Alert.alert('撤回云云的手机限制授权？', '云云发起的当前限制也会结束。', [{ text: '取消', style: 'cancel' }, { text: '撤回', style: 'destructive', onPress: () => action(async () => { const draft = phoneCareDraft(feature.configuration!); await feature.saveCare({ ...draft, allowPhone: false, allowApps: false, allowPlans: false }, editEpoch.current); afterSave('home'); }) }])} /> : retry(feature.errors.configuration);
  else if (page === 'lockSettings') content = feature.configuration ? <PhoneLockSettingsEditor {...common} initialAllowlist={phoneAllowlist(feature.configuration)} emergencyMinutes={String(feature.configuration.durations.emergencyMs / 60000)} pickApps={pickApps} appNames={appNames} onSave={async (packages, minutes) => { await feature.saveLockSettings(packages, minutes, editEpoch.current); afterSave('settings'); }} /> : retry(feature.errors.configuration);
  else content = <PhoneCard>{feature.status ? <><PhoneRow label="使用情况访问" sub={feature.status.permissions.usageAccess === null ? '未知' : feature.status.permissions.usageAccess ? '已允许' : '未允许'} /><PhoneRow label="无障碍连接" sub={feature.status.permissions.accessibility === null ? '未知' : feature.status.accessibilityConnected ? '已连接' : '未连接'} /><PhoneRow label="悬浮窗" sub={feature.status.permissions.overlay === null ? '未知' : feature.status.permissions.overlay ? '已允许' : '未允许'} /><PhoneRow label="记录服务" sub={feature.status.collector.running ? '运行中' : feature.status.collector.starting ? '正在启动' : '未运行'} /></> : <View style={styles.pad}><Text style={phoneUi.sub}>运行状态未知</Text></View>}<PhoneRow label="前往本机小管家" onPress={() => navigate('phone-manager')} /></PhoneCard>;

  return <View style={styles.root}><View style={[styles.header, { paddingTop: Math.max(12, insets.top + 8) }]}><Pressable style={styles.headerButton} accessibilityLabel={page === 'home' ? '功能' : '返回'} onPress={page === 'home' ? () => leave(() => { open('home'); onOpenFeatureDrawer(); }) : back}><PhoneIcon name={page === 'home' ? 'menu' : 'back'} color={headerText.color as string} /></Pressable><Text style={[styles.title, headerText]}>{titles[page]}</Text></View><ScrollView key={page} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingBottom: Math.max(110, insets.bottom + 85) }]}>{feature.notice ? <PhoneCard><View style={styles.pad}><Text style={phoneUi.rowLabel}>{feature.notice}</Text></View></PhoneCard> : null}{content}</ScrollView>{(editable.includes(page) || page === 'home' && switchDraft !== null) && editorKnown ? <PhoneSave busy={feature.busy} onSave={() => {
    if (page === 'home') { if (feature.rules && switchDraft) action(async () => { await feature.saveRules({ ...feature.rules!, ...switchDraft }, editEpoch.current); afterSave('home'); }); }
    else save.current?.();
  }} /> : null}<PhoneAppPicker visible={!!picker && active} title={picker?.title ?? '选择应用'} selected={picker?.selected ?? []} apps={feature.apps} loading={feature.appsLoading} error={feature.appsError} onReload={() => void feature.loadApps()} onClose={() => setPicker(null)} onSelect={packages => { if (picker) { picker.onSelect(packages); setPicker(previous => previous ? { ...previous, selected: packages } : null); } }} /></View>;
}

const styles = StyleSheet.create({
  usagePending: { fontSize: 36, fontWeight: '700', lineHeight: 44 },
  root: { flex: 1 }, header: { paddingHorizontal: 22, paddingBottom: 18, flexDirection: 'row', alignItems: 'center', gap: 13 }, headerButton: { width: 39, height: 39, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.35)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)', alignItems: 'center', justifyContent: 'center' }, title: { fontSize: 25, fontWeight: '600', flex: 1 }, content: { paddingHorizontal: 20 },
  pad: { padding: 18 }, hero: { padding: 22, minHeight: 190 }, state: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingRight: 62 }, stateText: { color: '#384052', fontSize: 16 }, calm: { width: 85, height: 85, resizeMode: 'contain', position: 'absolute', top: 15, right: 17 }, usageLabel: { color: '#697184', fontSize: 15, marginTop: 20 }, usageNumber: { color: '#384052', fontSize: 43, fontWeight: '700', lineHeight: 52, marginTop: 6, marginBottom: 12 }, usageUnit: { fontSize: 18, fontWeight: 'normal', color: '#384052' }, usageScroll: { maxHeight: 168 }, miniStats: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', rowGap: 16, paddingRight: 6, paddingBottom: 4 }, mini: { width: '47%', gap: 4 }, appDuration: { fontSize: 12, lineHeight: 26, fontWeight: 'normal', color: '#384052' }, updatedAt: { marginTop: 12 }, track: { height: 5, borderRadius: 4, backgroundColor: '#E9EFF4', overflow: 'hidden' }, fill: { height: '100%', borderRadius: 4, backgroundColor: '#B2D9FF' },
  next: { backgroundColor: 'rgba(255,255,255,0.61)', borderRadius: 15, paddingVertical: 13, paddingHorizontal: 15, flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 16 }, nextText: { flex: 1, fontSize: 14, color: '#536779' }, menuIcon: { width: 39, height: 39, backgroundColor: '#EEF7FF', borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, status: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 }, statusText: { flex: 1, fontSize: 14 }, planActions: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18 },
});
