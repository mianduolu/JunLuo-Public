import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import { BodySignalSummaryCard } from './BodySignalSummaryCard';
import { BodySignalActivityView } from './BodySignalActivityView';
import { activityCoverageLabel } from './bodySignalActivitySummary';
import { BodySignalSleepView } from './BodySignalSleepView';
import type { BodySignalSleepSummary } from './bodySignalSleepSummary';
import { miBand6SleepPercentages } from './miBand6SleepStages';
import { useBodySignalActivitySnapshot } from './useBodySignalActivitySnapshot';
import { useBodySignalSleepSnapshot } from './useBodySignalSleepSnapshot';
import { useSleepHeartRateSnapshot } from './useSleepHeartRateSnapshot';
import { SleepHeartRateSection } from './SleepHeartRateSection';
import { useBodyDataSync } from './useBodyDataSync';

export type BodyDataDestination = { section?: 'activity' | 'sleep'; deviceProfileId?: string };
const duration = (minutes: number) => `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
const recordedAt = (at?: number) => at === undefined ? '暂无记录' : new Date(at).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

function LocalReadState({ loading, error, retry }: { loading: boolean; error?: string; retry(): void }) {
  return <>
    {loading ? <ActivityIndicator accessibilityLabel="正在读取本地记录" color="#607D65" /> : null}
    {error ? <View style={styles.gap}><Text style={styles.error}>{error}</Text>
      <Pressable accessibilityRole="button" onPress={retry} style={styles.action}><Text style={styles.link}>重试读取本地记录</Text></Pressable>
    </View> : null}
  </>;
}

function Devices({ devices, selected, onSelect }: {
  devices: { id: string; displayName: string; isPrimary: boolean }[];
  selected?: string; onSelect(id: string): void;
}) {
  return <View style={styles.devices}>{devices.map((device, index) => <Pressable key={device.id}
    accessibilityRole="button" accessibilityState={{ selected: selected === device.id }}
    onPress={() => onSelect(device.id)} style={[styles.device, selected === device.id && styles.selected]}>
    <Text style={styles.note}>{selected === device.id ? '✓ ' : ''}{device.displayName}
      {devices.filter(other => other.displayName === device.displayName).length > 1 ? ` · 记录 ${index + 1}` : ''}
      {device.isPrimary ? ' · 主设备' : ''}</Text>
  </Pressable>)}</View>;
}

export function SavedSleepRows({ data }: { data: BodySignalSleepSummary }) {
  return <View testID="body-data-sleep-list" style={styles.gap}>
    <Text style={styles.heading}>近七天 · 主要睡眠</Text>
    {[...data.days].reverse().map(day => {
      const percentages = day.deepMinutes !== undefined && day.lightMinutes !== undefined
        ? miBand6SleepPercentages(day.deepMinutes, day.lightMinutes) : undefined;
      const total = (day.deepMinutes ?? 0) + (day.lightMinutes ?? 0);
      return <View key={day.dateKey} style={styles.sleepRow}>
        <Text style={styles.date}>{day.dateKey}</Text>
        <View style={styles.sleepValue}><Text style={styles.rowValue}>{day.text}</Text>
          {percentages ? <View style={styles.gap}>
            <View style={styles.stageBar} accessible={false} importantForAccessibility="no-hide-descendants">
              <View style={[styles.deep, { width: `${total ? day.deepMinutes! / total * 100 : 0}%` }]} />
              <View style={[styles.light, { width: `${total ? day.lightMinutes! / total * 100 : 0}%` }]} />
            </View>
            <Text style={styles.note}>深睡 {duration(day.deepMinutes!)} · {percentages.deep}%</Text>
            <Text style={styles.note}>浅睡 {duration(day.lightMinutes!)} · {percentages.light}%</Text>
          </View> : day.totalMinutes !== undefined ? <Text style={styles.note}>仅有时长</Text> : null}
          {day.note ? <Text style={styles.note}>{day.note}</Text> : null}
        </View>
      </View>;
    })}
  </View>;
}

function SleepDetails({ snapshot, date, setDate, selectDevice, navigate }: {
  snapshot: ReturnType<typeof useBodySignalSleepSnapshot>; date?: string;
  setDate(date: string): void; selectDevice(id: string): void; navigate: Navigate;
}) {
  // This component is mounted only while sleep is expanded.
  const heartRate = useSleepHeartRateSnapshot(snapshot.data?.deviceProfileId, snapshot.data);
  return <View style={styles.details}>
    {snapshot.data ? <SavedSleepRows data={snapshot.data} /> : null}
    <BodySignalSleepView {...snapshot} embedded devices={[]} selectedDate={date} onSelectDate={setDate}
      selectDevice={selectDevice} goBack={() => navigate('period')}
      renderHeartRate={dateKey => <SleepHeartRateSection key={`${snapshot.data?.deviceProfileId}:${dateKey}`} dateKey={dateKey} snapshot={heartRate} />} />
  </View>;
}

export function BodyDataFeature({ navigate, onOpenFeatureDrawer, initialDestination }: {
  navigate: Navigate; onOpenFeatureDrawer(): void; initialDestination?: BodyDataDestination;
}) {
  const insets = useSafeAreaInsets();
  const [clock, setClock] = useState(Date.now);
  const [activityDevice, setActivityDevice] = useState(initialDestination?.section === 'activity' ? initialDestination.deviceProfileId : undefined);
  const [sleepDevice, setSleepDevice] = useState(initialDestination?.section === 'sleep' ? initialDestination.deviceProfileId : undefined);
  const [activityExpanded, setActivityExpanded] = useState(initialDestination?.section === 'activity');
  const [sleepExpanded, setSleepExpanded] = useState(initialDestination?.section === 'sleep');
  const [activitySelection, setActivitySelection] = useState<{ date?: string; hour?: number }>({});
  const [sleepDate, setSleepDate] = useState<string>();
  useEffect(() => {
    const timer = setInterval(() => { if (AppState.currentState === 'active') setClock(Date.now()); }, 60_000);
    return () => clearInterval(timer);
  }, []);
  const activity = useBodySignalActivitySnapshot(activityDevice, { readOnly: true, clock });
  const sleep = useBodySignalSleepSnapshot(sleepDevice, clock);
  const sync = useBodyDataSync();
  const latest = sleep.data?.days.filter(day => day.totalMinutes !== undefined).at(-1);
  const changeActivity = (id: string) => { setActivitySelection({}); setActivityDevice(id); };
  const changeSleep = (id: string) => { setSleepDate(undefined); setSleepDevice(id); };
  const button = (kind: 'activity' | 'sleep', profile?: string) => {
    const sameTarget = Boolean(profile && profile === sync.target);
    const disabled = !sameTarget || Boolean(sync.busy) || sync.sleep.busy
      || sync.activity?.status === 'syncing' || sync.activity?.status === 'pending_save' || (kind === 'activity' && sync.activity?.formallyVerified !== true);
    return <Pressable testID={`body-data-sync-${kind}`} accessibilityRole="button" disabled={disabled}
      accessibilityState={{ disabled }} onPress={() => { void sync.sync(kind, profile); }}
      style={[styles.sync, disabled && styles.disabled]}>
      <Text style={styles.syncText}>{sync.busy === kind || (kind === 'sleep' && sync.sleep.busy)
        ? '正在同步…' : kind === 'activity' ? '同步活动' : '同步睡眠'}</Text>
    </Pressable>;
  };
  const connectionNote = (profile?: string) => profile && profile !== sync.target
    ? <Text style={styles.note}>{sync.target ? '正在查看历史设备记录；同步仅用于当前连接的手环。' : '手环未就绪，仍可查看已保存的历史。'}</Text> : null;
  return <ScrollView testID="body-data-scroll" contentContainerStyle={[styles.content, {
    paddingTop: Math.max(18, insets.top + 8), paddingBottom: Math.max(28, insets.bottom + 20),
  }]} keyboardShouldPersistTaps="handled">
    <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="打开与你功能栏" onPress={onOpenFeatureDrawer} style={styles.menu}>
        <Text style={styles.menuText}>☰</Text>
      </Pressable>
      <View style={styles.headerCopy}><Text style={styles.title}>身体数据</Text><Text style={styles.note}>心率 · 活动 · 睡眠</Text></View>
      <Pressable accessibilityRole="button" onPress={() => navigate('body-signal')} style={styles.action}><Text style={styles.link}>设备设置 ›</Text></Pressable>
    </View>
    <BodySignalSummaryCard navigate={navigate} />
    <View testID="body-data-activity" style={styles.region}>
      <View style={styles.headingRow}><View style={styles.headerCopy}><Text style={styles.eyebrow}>活动</Text><Text style={styles.heading}>今天的走动记录</Text></View>
        {button('activity', activity.data?.deviceProfileId)}</View>
      <Devices devices={activity.data?.devices ?? []} selected={activity.data?.deviceProfileId} onSelect={changeActivity} />
      <LocalReadState {...activity} />
      {activity.data ? <View style={styles.gap}>
        <Text style={styles.value}>{activity.data.today.steps === undefined ? '暂无记录' : activity.data.today.steps.toLocaleString('zh-CN')}<Text style={styles.unit}>{activity.data.today.steps === undefined ? '' : ' 步已记录'}</Text></Text>
        <Text style={styles.note}>{activity.data.today.dateKey} · 记录至 {recordedAt(activity.data.today.lastRecordedAt)}</Text>
        <Text style={styles.note}>{activityCoverageLabel[activity.data.today.coverage]} · 覆盖 {activity.data.today.coveredMinutes ?? '—'} 分钟</Text>
      </View> : !activity.loading && !activity.error ? <Text style={styles.note}>暂无穿戴活动记录</Text> : null}
      {connectionNote(activity.data?.deviceProfileId)}
      {activity.data?.deviceProfileId === sync.target && sync.errors.activity ? <Text style={styles.error}>{sync.errors.activity}</Text> : null}
      <Pressable testID="body-data-toggle-activity" accessibilityRole="button" accessibilityState={{ expanded: activityExpanded }}
        onPress={() => setActivityExpanded(value => !value)} style={styles.expand}><Text style={styles.link}>{activityExpanded ? '收起活动详情 −' : '展开七天趋势与24小时记录 ＋'}</Text></Pressable>
      {activityExpanded ? <BodySignalActivityView {...activity} embedded selection={activitySelection} onSelection={setActivitySelection}
        navigate={navigate} selectDevice={changeActivity} /> : null}
    </View>
    <View testID="body-data-sleep" style={styles.region}>
      <View style={styles.headingRow}><View style={styles.headerCopy}><Text style={styles.eyebrow}>睡眠</Text><Text style={styles.heading}>最近的主要睡眠</Text></View>
        {button('sleep', sleep.data?.deviceProfileId)}</View>
      <Devices devices={sleep.devices} selected={sleep.data?.deviceProfileId} onSelect={changeSleep} />
      <LocalReadState {...sleep} />
      {latest ? <View style={styles.gap}><Text style={styles.note}>最近已存 · {latest.dateKey}</Text><Text style={styles.value}>{latest.text}</Text>
        {latest.note ? <Text style={styles.note}>{latest.note}</Text> : null}</View>
        : !sleep.loading && !sleep.error ? <Text style={styles.note}>暂无已保存的主要睡眠记录</Text> : null}
      {sleep.data?.averageMinutes !== undefined ? <Text style={styles.note}>近七天平均 {duration(sleep.data.averageMinutes)} · 按 {sleep.data.recordedNights} 晚记录计算</Text> : null}
      {sleep.data && sleep.data.unreviewedNights > 0 ? <Text style={styles.note}>包含 {sleep.data.unreviewedNights} 晚本次尚未复核的记录</Text> : null}
      {connectionNote(sleep.data?.deviceProfileId)}
      {sleep.data?.deviceProfileId === sync.target && sync.errors.sleep ? <Text style={styles.error}>{sync.errors.sleep}</Text> : null}
      <Pressable testID="body-data-toggle-sleep" accessibilityRole="button" accessibilityState={{ expanded: sleepExpanded }}
        onPress={() => setSleepExpanded(value => !value)} style={styles.expand}><Text style={styles.link}>{sleepExpanded ? '收起睡眠详情 −' : '展开七天记录、趋势与心率参考 ＋'}</Text></Pressable>
      {sleepExpanded ? <SleepDetails snapshot={sleep} date={sleepDate} setDate={setSleepDate} selectDevice={changeSleep} navigate={navigate} /> : null}
    </View>
  </ScrollView>;
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, gap: 18, width: '100%', maxWidth: 720, alignSelf: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 8, padding: 10, backgroundColor: colors.cardStrong },
  headerCopy: { flex: 1, minWidth: 130, gap: 4 },
  menu: { minWidth: 44, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  menuText: { fontSize: 25, color: colors.ink },
  title: { fontSize: 27, lineHeight: 38, fontWeight: '700', color: colors.ink },
  region: { backgroundColor: colors.cardStrong, padding: 18, borderTopWidth: 1, borderTopColor: '#CBD8D1', gap: 12 },
  eyebrow: { fontSize: 12, lineHeight: 20, color: '#617F6D', letterSpacing: 2 },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 18, lineHeight: 27, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  value: { fontSize: 29, lineHeight: 42, fontWeight: '700', color: colors.ink, flexShrink: 1 },
  unit: { fontSize: 14, fontWeight: '400' },
  note: { fontSize: 13, lineHeight: 21, color: colors.muted, flexShrink: 1 },
  link: { fontSize: 14, lineHeight: 23, color: '#456D57', flexShrink: 1 },
  action: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 6 },
  sync: { minHeight: 44, paddingVertical: 10, paddingHorizontal: 14, backgroundColor: '#607D65', borderRadius: 8 },
  syncText: { fontSize: 14, lineHeight: 23, color: '#FFFFFF', flexShrink: 1 },
  disabled: { opacity: 0.45 },
  expand: { minHeight: 48, justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DCE3D8', paddingTop: 8 },
  gap: { gap: 5 }, details: { gap: 24 },
  devices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  device: { paddingVertical: 9, paddingHorizontal: 10, minHeight: 44, borderRadius: 6, maxWidth: '100%', backgroundColor: '#EEF2EB' },
  selected: { backgroundColor: '#E0EADD' },
  error: { fontSize: 13, lineHeight: 22, color: '#8B5247', flexShrink: 1 },
  sleepRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#DCE3D8' },
  date: { fontSize: 13, lineHeight: 24, color: colors.muted },
  sleepValue: { flex: 1, minWidth: 135, gap: 5 },
  rowValue: { fontSize: 16, lineHeight: 24, color: colors.ink },
  stageBar: { height: 8, width: '100%', flexDirection: 'row', borderRadius: 4, overflow: 'hidden' },
  deep: { backgroundColor: '#526E59' }, light: { backgroundColor: '#B5C9A9' },
});
