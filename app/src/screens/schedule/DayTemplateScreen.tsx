import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DateTimePickerSheet } from '../../components/DateTimePickerSheet';
import { AppText as Text } from '../../components/AppText';
import { dateKey } from '../../schedule/scheduleStore';
import { DEFAULT_DAY_TEMPLATE, loadDayTemplate, type DayTemplate, type MealTemplate } from '../../schedule/dayTemplate';
import { saveUserRoutineTemplate } from '../../schedule/userRoutineStore';
import { loadUserRoutineOverlaps } from '../../schedule/userRoutineContext';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../../backup/backupRestoreCoordinator';
import { DayRoutineOverrides } from './DayRoutineOverrides';
import type { DateTimeSelection } from '../../schedule/dateTimeSelection';
import { colors } from '../../theme/colors';

type TimeTarget = 'wakeTime' | 'sleepTime' | 'breakfast' | 'lunch' | 'dinner' | 'napStart' | 'napEnd';

const timeTargetLabels: Record<TimeTarget, string> = {
  wakeTime: '起床时间',
  sleepTime: '睡觉时间',
  breakfast: '早餐开始',
  lunch: '午餐开始',
  dinner: '晚餐开始',
  napStart: '午休开始',
  napEnd: '午休结束',
};

function timeForTarget(template: DayTemplate, target: TimeTarget) {
  if (target === 'breakfast' || target === 'lunch' || target === 'dinner') return template[target].startTime;
  if (target === 'napStart') return template.nap.startTime;
  if (target === 'napEnd') return template.nap.endTime;
  return template[target];
}

function pickerValue(time: string): DateTimeSelection {
  return {
    date: dateKey(new Date()),
    time,
    recurrence: 'none',
    reminderChoice: 'none',
    reminderClock: time,
    reminderIntensity: 'gentle',
  };
}

export function DayTemplateScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const [template, setTemplate] = useState<DayTemplate>(DEFAULT_DAY_TEMPLATE);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [timeTarget, setTimeTarget] = useState<TimeTarget | null>(null);
  const [scope, setScope] = useState<'usual' | 'day'>('usual');
  const [readFailed, setReadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const baseline = useRef<DayTemplate>(DEFAULT_DAY_TEMPLATE);
  const epoch = useRef(captureBackupRestoreDataEpoch());
  const active = useRef(true);

  useEffect(() => {
    let alive = true;
    active.current = true; epoch.current = captureBackupRestoreDataEpoch();
    setLoading(true); setReadFailed(false);
    loadDayTemplate().then((value) => {
      if (alive) { setTemplate(value); baseline.current = value; }
    }).catch(() => { if (alive) setReadFailed(true); }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; active.current = false; };
  }, [reload]);

  const selectedTime = useMemo(() => timeTarget ? timeForTarget(template, timeTarget) : '08:00', [template, timeTarget]);

  const applyTime = (selection: DateTimeSelection | null) => {
    if (!timeTarget || !selection?.time) {
      setTimeTarget(null);
      return;
    }
    const time = selection.time;
    setTemplate((current) => {
      if (timeTarget === 'breakfast' || timeTarget === 'lunch' || timeTarget === 'dinner') {
        return { ...current, [timeTarget]: { ...current[timeTarget], startTime: time,
          enabled: current[timeTarget].startTime ? current[timeTarget].enabled : true } };
      }
      if (timeTarget === 'napStart') return { ...current, nap: { ...current.nap, startTime: time, durationMinutes: undefined,
        enabled: current.nap.startTime ? current.nap.enabled : true } };
      if (timeTarget === 'napEnd') return { ...current, nap: { ...current.nap, endTime: time, durationMinutes: undefined } };
      const enabledKey = timeTarget === 'wakeTime' ? 'wakeEnabled' : 'sleepEnabled';
      return { ...current, [timeTarget]: time, [enabledKey]: current[timeTarget] ? current[enabledKey] : true };
    });
    setTimeTarget(null);
  };

  const updateMeal = (key: 'breakfast' | 'lunch' | 'dinner', patch: Partial<MealTemplate>) => {
    setTemplate((current) => ({ ...current, [key]: { ...current[key], ...patch } }));
  };

  const save = async () => {
    if (readFailed || loading || saving || epoch.current === null) return;
    setSaving(true);
    try {
      const result = await saveUserRoutineTemplate(template, { expectedTemplate: baseline.current,
        dataEpoch: epoch.current, operationId: `routine-page:${Date.now()}`, isCurrent: () => active.current && canCommitBackupRestoreDataEpoch(epoch.current) });
      if (result.status !== 'saved') {
        Alert.alert(result.status === 'unknown' ? '作息保存结果暂时无法确认。' : '这次还没保存好，作息暂时还是原来的安排。');
        return;
      }
      const saved = await loadDayTemplate().catch(() => null);
      if (!saved) { setReadFailed(true); Alert.alert('作息已保存。', '作息暂时无法读取。'); return; }
      baseline.current = saved;
      setTemplate(saved);
      const now = new Date(); now.setHours(0, 0, 0, 0);
      const end = new Date(now); end.setDate(end.getDate() + 2);
      const overlaps = await loadUserRoutineOverlaps(now.getTime(), end.getTime()).catch(() => null);
      Alert.alert(
        saved.enabled ? '作息保存好啦' : '作息模板已关闭',
        saved.enabled
          ? `作息是计划，不是完成记录。${overlaps?.length ? `\n与「${[...new Set(overlaps.map(item => item.title))].join('、')}」重叠，两份安排都保留。` : ''}`
          : '平常安排已停用；历史记录和单独保存的日期安排仍保留。',
      );
    } catch {
      Alert.alert('作息保存结果暂时无法确认。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={[styles.header, { paddingTop: Math.max(insets.top + 12, 28) }]}>
        <Pressable accessibilityLabel="返回日程" onPress={onClose} style={styles.backButton}><Text style={styles.backText}>‹</Text></Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>作息</Text>
          <Text style={styles.subtitle}>给排程留一副熟悉的日常骨架</Text>
        </View>
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom + 40, 64) }]} showsVerticalScrollIndicator={false}>
        <View style={styles.tabs}>{(['usual', 'day'] as const).map(value => <Pressable key={value}
          accessibilityRole="tab" accessibilityState={{ selected: scope === value }} disabled={saving}
          onPress={() => { setScope(value); if (value === 'usual') setReload(v => v + 1); }} style={[styles.tab, scope === value && styles.activeTab]}>
          <Text style={styles.rowLabel}>{value === 'usual' ? '平常作息' : '指定日期'}</Text>
        </Pressable>)}</View>
        {scope === 'day' ? <DayRoutineOverrides /> : readFailed ? <View>
          <Text style={styles.hint}>作息暂时无法读取。</Text>
          <Pressable onPress={() => setReload(v => v + 1)} style={styles.saveButton}><Text style={styles.saveText}>重新读取</Text></Pressable>
        </View> : <>
        {loading ? <Text style={styles.hint}>正在读取鼠的作息...</Text> : (
          <>
            <SectionTitle title="排程模板" />
            <View style={styles.settingRow}>
              <Pressable onPress={() => setTemplate((current) => ({ ...current, enabled: !current.enabled }))} style={[styles.toggle, template.enabled && styles.toggleActive]}>
                <View style={[styles.toggleThumb, template.enabled && styles.toggleThumbActive]} />
              </Pressable>
              <View style={styles.rowMain}>
                <Text style={styles.rowLabel}>启用作息模板</Text>
                <Text style={styles.rowNote}>{template.enabled ? '用于一键排程避让吃饭、午休，并在时间轴显示作息条目' : '平常安排已停用，单独保存的日期安排仍保留'}</Text>
              </View>
            </View>
            {!template.enabled && <Text style={styles.hint}>总开关已关闭，仍可修改平常时间；保存不会自动打开开关。历史和日期例外继续保留。</Text>}
            <SectionTitle title="一天的边界" />
            <TimeRow label="起床" onPress={() => setTimeTarget('wakeTime')} value={template.wakeTime} />
            <Pressable onPress={() => setTemplate(current => ({ ...current, wakeEnabled: !(current.wakeEnabled ?? !!current.wakeTime) }))} style={styles.settingRow}>
              <Text style={styles.rowNote}>{template.wakeEnabled ? '起床安排已启用 · 点击停用' : '起床安排未启用 · 点击启用'}</Text></Pressable>
            <TimeRow label="睡觉" note={template.sleepTime <= template.wakeTime ? '视为次日' : undefined} onPress={() => setTimeTarget('sleepTime')} value={template.sleepTime} />
            <Pressable onPress={() => setTemplate(current => ({ ...current, sleepEnabled: !(current.sleepEnabled ?? !!current.sleepTime) }))} style={styles.settingRow}>
              <Text style={styles.rowNote}>{template.sleepEnabled ? '睡觉安排已启用 · 点击停用' : '睡觉安排未启用 · 点击启用'}</Text></Pressable>

            <SectionTitle title="吃饭与午休" />
            <MealRow label="早餐" meal={template.breakfast} onChange={(patch) => updateMeal('breakfast', patch)} onTime={() => setTimeTarget('breakfast')} />
            <MealRow label="午餐" meal={template.lunch} onChange={(patch) => updateMeal('lunch', patch)} onTime={() => setTimeTarget('lunch')} />
            <MealRow label="晚餐" meal={template.dinner} onChange={(patch) => updateMeal('dinner', patch)} onTime={() => setTimeTarget('dinner')} />
            <View style={styles.settingRow}>
              <Pressable onPress={() => setTemplate((current) => ({ ...current, nap: { ...current.nap, enabled: !current.nap.enabled } }))} style={[styles.toggle, template.nap.enabled && styles.toggleActive]}>
                <View style={[styles.toggleThumb, template.nap.enabled && styles.toggleThumbActive]} />
              </Pressable>
              <View style={styles.rowMain}><Text style={styles.rowLabel}>午休</Text><Text style={styles.rowNote}>{template.nap.enabled ? template.nap.endTime ? '已设置结束时间' : '未设置时长' : '关闭'}</Text></View>
              {template.nap.enabled ? <View style={styles.inlineTimes}><Pressable onPress={() => setTimeTarget('napStart')}><Text style={styles.timeLink}>{template.nap.startTime || '设置时间'}</Text></Pressable><Text style={styles.timeDash}>—</Text><Pressable onPress={() => setTimeTarget('napEnd')}><Text style={styles.timeLink}>{template.nap.endTime || '未设置'}</Text></Pressable></View> : null}
            </View>

            <SectionTitle title="任务之间" />
            <View style={styles.settingRow}>
              <Pressable onPress={() => setTemplate((current) => ({ ...current, autoBreaks: !current.autoBreaks }))} style={[styles.toggle, template.autoBreaks && styles.toggleActive]}><View style={[styles.toggleThumb, template.autoBreaks && styles.toggleThumbActive]} /></Pressable>
              <View style={styles.rowMain}><Text style={styles.rowLabel}>自动留休息</Text><Text style={styles.rowNote}>脑力与体力任务分别留一点缓冲</Text></View>
            </View>
            {template.autoBreaks ? (
              <>
                <MinuteStepper label="脑力休息" onChange={(value) => setTemplate((current) => ({ ...current, focusBreakMinutes: value }))} value={template.focusBreakMinutes} />
                <MinuteStepper label="体力休息" onChange={(value) => setTemplate((current) => ({ ...current, physicalBreakMinutes: value }))} value={template.physicalBreakMinutes} />
              </>
            ) : null}
            <Text style={styles.hint}>排程可用区间会从起床后 30 分钟开始，到睡前 30 分钟结束。</Text>
            <Pressable disabled={saving} onPress={() => void save()} style={[styles.saveButton, saving && styles.saveDisabled]}><Text style={styles.saveText}>{saving ? '保存中...' : '保存作息'}</Text></Pressable>
          </>
        )}
        </>}
      </ScrollView>
      <DateTimePickerSheet
        onClose={() => setTimeTarget(null)}
        onConfirm={applyTime}
        timeOnly
        title={timeTarget ? timeTargetLabels[timeTarget] : '选择时间'}
        value={pickerValue(selectedTime || '12:00')}
        visible={!!timeTarget}
      />
    </View>
  );
}

function SectionTitle({ title }: { title: string }) {
  return <Text style={styles.sectionTitle}>{title}</Text>;
}

function TimeRow({ label, note, onPress, value }: { label: string; note?: string; onPress: () => void; value: string }) {
  return <Pressable onPress={onPress} style={styles.settingRow}><View style={styles.rowMain}><Text style={styles.rowLabel}>{label}</Text>{note ? <Text style={styles.rowNote}>{note}</Text> : null}</View><Text style={styles.timeValue}>{value || '未设置'}</Text><Text style={styles.arrow}>›</Text></Pressable>;
}

function MealRow({ label, meal, onChange, onTime }: { label: string; meal: MealTemplate; onChange: (patch: Partial<MealTemplate>) => void; onTime: () => void }) {
  return (
    <View style={styles.settingRow}>
      <Pressable onPress={() => onChange({ enabled: !meal.enabled })} style={[styles.toggle, meal.enabled && styles.toggleActive]}><View style={[styles.toggleThumb, meal.enabled && styles.toggleThumbActive]} /></Pressable>
      <View style={styles.rowMain}><Text style={styles.rowLabel}>{label}</Text><Text style={styles.rowNote}>{meal.enabled ? meal.durationMinutes ? `${meal.durationMinutes} 分钟` : '未设置时长' : '关闭'}</Text></View>
      <Pressable onPress={onTime}><Text style={styles.timeLink}>{meal.startTime || '设置时间'}</Text></Pressable>
      {meal.enabled ? <MinuteButtons onChange={(delta) => onChange({ durationMinutes: Math.max(0, (meal.durationMinutes ?? 0) + delta) || undefined })} /> : null}
    </View>
  );
}

function MinuteButtons({ onChange }: { onChange: (delta: number) => void }) {
  return <View style={styles.stepButtons}><Pressable accessibilityLabel="减少五分钟" onPress={() => onChange(-5)} style={styles.stepButton}><Text style={styles.stepText}>−</Text></Pressable><Pressable accessibilityLabel="增加五分钟" onPress={() => onChange(5)} style={styles.stepButton}><Text style={styles.stepText}>＋</Text></Pressable></View>;
}

function MinuteStepper({ label, onChange, value }: { label: string; onChange: (value: number) => void; value: number }) {
  return <View style={styles.settingRow}><View style={styles.rowMain}><Text style={styles.rowLabel}>{label}</Text></View><Text style={styles.minuteValue}>{value} 分钟</Text><MinuteButtons onChange={(delta) => onChange(Math.min(60, Math.max(0, value + delta)))} /></View>;
}

const styles = StyleSheet.create({
  tabs: { flexDirection: 'row', backgroundColor: '#FFEDE0', borderRadius: 14, padding: 4, marginBottom: 12 },
  tab: { flex: 1, paddingVertical: 12, alignItems: 'center', borderRadius: 10 },
  activeTab: { backgroundColor: '#FFFFFF' },
  screen: { backgroundColor: '#F5FAFF', flex: 1 },
  header: { alignItems: 'center', flexDirection: 'row', paddingBottom: 20, paddingHorizontal: 22 },
  backButton: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: '#DEEAF5', borderRadius: 8, borderWidth: 1, height: 48, justifyContent: 'center', width: 48 },
  backText: { color: '#6484AA', fontSize: 34, lineHeight: 38 },
  headerText: { marginLeft: 14 },
  title: { color: colors.ink, fontSize: 28, fontWeight: '600' },
  subtitle: { color: colors.muted, fontSize: 14, marginTop: 3 },
  content: { paddingHorizontal: 22 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '600', marginBottom: 8, marginTop: 22 },
  settingRow: { alignItems: 'center', backgroundColor: '#FFFFFF', borderBottomColor: '#E3EDF6', borderBottomWidth: 1, flexDirection: 'row', minHeight: 70, paddingHorizontal: 14 },
  rowMain: { flex: 1, paddingVertical: 10 },
  rowLabel: { color: colors.ink, fontSize: 17, fontWeight: '500' },
  rowNote: { color: colors.muted, fontSize: 12, marginTop: 4 },
  timeValue: { color: '#6484AA', fontSize: 18, fontWeight: '500' },
  timeLink: { color: '#6484AA', fontSize: 15, paddingHorizontal: 8, paddingVertical: 8 },
  timeDash: { color: colors.muted },
  inlineTimes: { alignItems: 'center', flexDirection: 'row' },
  arrow: { color: '#A0B3C8', fontSize: 26, marginLeft: 8 },
  toggle: { backgroundColor: '#DEE8F1', borderRadius: 14, height: 28, marginRight: 12, padding: 3, width: 48 },
  toggleActive: { backgroundColor: '#F7C4A3' },
  toggleThumb: { backgroundColor: '#FFFFFF', borderRadius: 11, height: 22, width: 22 },
  toggleThumbActive: { alignSelf: 'flex-end' },
  stepButtons: { flexDirection: 'row', gap: 5, marginLeft: 4 },
  stepButton: { alignItems: 'center', backgroundColor: '#FFF0E4', borderRadius: 8, height: 34, justifyContent: 'center', width: 34 },
  stepText: { color: '#6484AA', fontSize: 19 },
  minuteValue: { color: colors.muted, fontSize: 14 },
  hint: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 16 },
  saveButton: { alignItems: 'center', backgroundColor: '#FFD2B2', borderRadius: 8, marginTop: 24, paddingVertical: 15 },
  saveDisabled: { opacity: 0.55 },
  saveText: { color: '#3B5975', fontSize: 17, fontWeight: '500' },
});
