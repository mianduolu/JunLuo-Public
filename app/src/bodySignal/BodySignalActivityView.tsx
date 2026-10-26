import { useState } from 'react';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { Navigate } from '../types/navigation';
import { activityCoverageLabel, type ActivityDayView } from './bodySignalActivitySummary';
import type { BodySignalActivityOverview } from './bodySignalActivityOverview';
import { useBodySignalActivitySnapshot } from './useBodySignalActivitySnapshot';

const count = (value?: number) => value === undefined ? '--' : value.toLocaleString('zh-CN');
const time = (value?: number) => value === undefined ? '暂无记录' : new Date(value).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function ActivityDayMetrics({ day }: { day: ActivityDayView }) {
  return <View style={styles.metrics}>
    <Text style={styles.label}>{day.dateKey} · 已记录步数</Text>
    <Text style={styles.value}>{count(day.steps)}<Text style={styles.unit}> 步</Text></Text>
    <Text style={styles.note}>{activityCoverageLabel[day.coverage]}</Text>
    <Text style={styles.note}>有步数的分钟：{count(day.steppingMinutes)}</Text>
    <Text style={styles.note}>记录覆盖：{count(day.coveredMinutes)} 分钟{day.expectedMinutes ? ` / 全天 ${count(day.expectedMinutes)} 分钟` : ''}</Text>
    <Text style={styles.note}>记录至：{time(day.lastRecordedAt)}</Text>
  </View>;
}

export function BodySignalActivitySummary({ navigate }: { navigate: Navigate }) {
  const { data, loading, error } = useBodySignalActivitySnapshot();
  const device = data?.devices.find(item => item.id === data.deviceProfileId);
  return <View style={styles.summary}>
    <View style={styles.headingRow}>
      <Text style={styles.heading}>今日活动</Text>
      <Pressable accessibilityRole="button" onPress={() => navigate('body-signal-activity')} style={styles.link}>
        <Text style={styles.linkText}>活动详情 ›</Text>
      </Pressable>
    </View>
    {loading ? <ActivityIndicator color="#648B70" /> : <>
      <Text style={styles.label}>{device?.displayName ?? '暂无穿戴活动记录'}</Text>
      <Text style={styles.value}>{count(data?.today.steps)}<Text style={styles.unit}> 步已记录</Text></Text>
      <Text style={styles.note}>{data?.today.dateKey} · 记录至 {time(data?.today.lastRecordedAt)}</Text>
    </>}
    {error ? <Text style={styles.error}>{error}{data ? '，显示上次读取结果' : ''}</Text> : null}
  </View>;
}

export function BodySignalActivityView({ data, loading, error, navigate, selectDevice, embedded = false, selection, onSelection, retry, goBack }: {
  data?: BodySignalActivityOverview; loading: boolean; error?: string; navigate: Navigate;
  selectDevice(id: string): void;
  embedded?: boolean;
  selection?: { date?: string; hour?: number };
  onSelection?(selection: { date?: string; hour?: number }): void;
  retry?(): void;
  goBack?(): void;
}) {
  const [localDate, setLocalDate] = useState<string>();
  const [localHour, setLocalHour] = useState<number>();
  const selectedDate = selection ? selection.date : localDate;
  const selectedHour = selection ? selection.hour : localHour;
  const setSelectedDate = (date: string) => onSelection ? onSelection({ ...selection, date }) : setLocalDate(date);
  const setSelectedHour = (hour: number) => onSelection ? onSelection({ ...selection, hour }) : setLocalHour(hour);
  const [menuOpen, setMenuOpen] = useState(false);
  const day = data?.days.find(item => item.dateKey === selectedDate) ?? data?.today;
  const device = data?.devices.find(item => item.id === data.deviceProfileId);
  const hourDetail = data?.hours.find(item => item.startedAt === selectedHour);
  const maximum = Math.max(1, ...(data?.days.map(item => item.steps ?? 0) ?? []));
  const hourMaximum = Math.max(1, ...(data?.hours.map(item => item.steps ?? 0) ?? []));
  const Container = embedded ? View : ScrollView;
  return <View style={embedded ? styles.embedded : styles.root}>
    {!embedded ? <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回身体数据" onPress={goBack ?? (() => navigate('period'))} style={styles.back}>
        <Text style={styles.backText}>‹</Text>
      </Pressable>
      <Text style={styles.title}>活动记录</Text>
      <View style={styles.back} />
    </View> : null}
    <Container {...(embedded ? {} : { contentContainerStyle: styles.content })}>
      {!embedded ? <Pressable accessibilityRole="button" accessibilityLabel="选择历史设备" disabled={!data?.devices.length}
        onPress={() => setMenuOpen(true)} style={styles.device}>
        <Text style={styles.deviceText}>{device?.displayName ?? '暂无穿戴活动记录'}{device?.isPrimary ? ' · 主设备' : ''}</Text>
        <Text style={styles.note}>⌄</Text>
      </Pressable> : null}
      {loading ? <ActivityIndicator color="#648B70" /> : null}
      {error ? <Text style={styles.error}>{error}{data ? '，显示上次读取结果' : ''}</Text> : null}
      {error && retry ? <Pressable accessibilityRole="button" onPress={retry} style={styles.link}><Text style={styles.linkText}>重试读取本地记录</Text></Pressable> : null}
      {data ? <>
        {!embedded ? <ActivityDayMetrics day={data.today} /> : null}
        <View style={styles.section}>
          <Text style={styles.heading}>最近七天</Text>
          <ScrollView horizontal contentContainerStyle={styles.week}>
            {data.days.map(item => <Pressable key={item.dateKey} accessibilityRole="button"
              accessibilityLabel={`${item.dateKey}，${item.steps === undefined ? '暂无记录' : `已记录 ${item.steps} 步`}，${activityCoverageLabel[item.coverage]}`}
              accessibilityState={{ selected: day?.dateKey === item.dateKey }} onPress={() => setSelectedDate(item.dateKey)}
              style={[styles.dayColumn, day?.dateKey === item.dateKey && styles.selected]}>
              <Text numberOfLines={1} adjustsFontSizeToFit style={styles.barNumber}>{count(item.steps)}</Text>
              <View style={styles.barTrack}>
                {item.steps === undefined ? <Text style={styles.missing}>缺</Text> :
                  <View style={[styles.dayBar, { height: Math.max(2, item.steps / maximum * 100) },
                    item.coverage !== 'complete' && styles.partialBar]} />}
              </View>
              <Text style={styles.barDate}>{item.dateKey.slice(5).replace('-', '/')}</Text>
            </Pressable>)}
          </ScrollView>
          {day ? <ActivityDayMetrics day={day} /> : null}
        </View>
        <View style={styles.section}>
          <Text style={styles.heading}>最近24小时</Text>
          <View style={styles.hours} accessibilityLabel="每小时已记录步数">
            {data.hours.map(hour => <Pressable key={hour.startedAt} accessibilityRole="button"
              accessibilityState={{ selected: selectedHour === hour.startedAt }}
              onPress={() => setSelectedHour(hour.startedAt)}
              accessibilityLabel={`${time(hour.startedAt)} 至 ${time(hour.endedAt)}，${hour.steps === undefined ? '暂无记录' : `${hour.steps} 步，覆盖 ${hour.coveredMinutes} 分钟`}`}
              style={[styles.hourTrack, selectedHour === hour.startedAt && styles.selected]}>
              <View style={[styles.hourBar, { height: hour.steps === undefined ? 0 : Math.max(2, hour.steps / hourMaximum * 76) }]} />
              {hour.steps === undefined ? <View style={styles.hourMissing} /> : null}
            </Pressable>)}
          </View>
          <View style={styles.axis}><Text style={styles.note}>{time(data.hours[0]?.startedAt)}</Text>
            <Text style={styles.note}>{time(data.hours[23]?.endedAt)}</Text></View>
          <Text style={styles.note}>已覆盖 {data.hours.reduce((sum, item) => sum + item.coveredMinutes, 0)} 分钟 · 灰点为缺记录</Text>
          {hourDetail ? <Text style={styles.note}>{time(hourDetail.startedAt)} 至 {time(hourDetail.endedAt)}：
            {hourDetail.steps === undefined ? '暂无记录' : `${count(hourDetail.steps)} 步 · 覆盖 ${hourDetail.coveredMinutes} 分钟`}</Text> : null}
        </View>
      </> : !loading ? <Text style={styles.note}>暂无活动摘要</Text> : null}
      {!embedded ? <Pressable accessibilityRole="button" onPress={() => navigate('body-signal')} style={styles.settings}>
        <Text style={styles.linkText}>设备与同步 ›</Text>
      </Pressable> : null}
    </Container>
    <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
      <View style={styles.shade}><View style={styles.menu}>
        <Text style={styles.heading}>历史设备</Text>
        <ScrollView>{data?.devices.map((option, index) => <Pressable key={option.id} accessibilityRole="radio"
          accessibilityState={{ selected: option.id === data.deviceProfileId }} style={styles.option}
          onPress={() => { setMenuOpen(false); selectDevice(option.id); }}>
          <Text style={styles.deviceText}>{option.id === data.deviceProfileId ? '● ' : '○ '}{option.displayName}
            {data.devices.filter(other => other.displayName === option.displayName).length > 1 ? ` · 记录 ${index + 1}` : ''}
            {option.isPrimary ? ' · 主设备' : ''}</Text>
        </Pressable>)}</ScrollView>
        <Pressable accessibilityRole="button" accessibilityLabel="关闭设备选择" onPress={() => setMenuOpen(false)} style={styles.link}>
          <Text style={styles.linkText}>关闭</Text>
        </Pressable>
      </View></View>
    </Modal>
  </View>;
}

const styles = StyleSheet.create({
  embedded: { gap: 12 },
  root: { flex: 1, backgroundColor: '#F7FAF5' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  back: { width: 48, minHeight: 48, justifyContent: 'center', alignItems: 'center' },
  backText: { fontSize: 34, color: colors.ink },
  title: { flex: 1, textAlign: 'center', fontSize: 22, fontWeight: '700', color: colors.ink },
  content: { paddingHorizontal: 20, paddingBottom: 32, width: '100%', maxWidth: 680, alignSelf: 'center' },
  summary: { backgroundColor: colors.cardStrong, borderTopWidth: 1, borderTopColor: '#CBD8D1', paddingHorizontal: 16, paddingVertical: 16, marginVertical: 12 },
  headingRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between' },
  heading: { fontSize: 18, color: colors.ink, fontWeight: '700', flexShrink: 1 },
  label: { fontSize: 14, lineHeight: 21, color: colors.muted },
  value: { fontSize: 32, lineHeight: 44, color: colors.ink, fontWeight: '700', flexShrink: 1 },
  unit: { fontSize: 15, fontWeight: '400' },
  note: { fontSize: 13, lineHeight: 21, color: colors.muted, flexShrink: 1 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
  linkText: { color: '#456D57', fontSize: 15, lineHeight: 23, fontWeight: '600' },
  error: { color: '#8B5247', fontSize: 13, lineHeight: 22, marginVertical: 8 },
  metrics: { paddingVertical: 16, gap: 4 },
  device: { flexDirection: 'row', gap: 10, alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#D9E0DB', paddingVertical: 16 },
  deviceText: { flex: 1, fontSize: 15, lineHeight: 24, color: colors.ink, flexShrink: 1 },
  section: { borderTopWidth: 1, borderTopColor: '#D9E0DB', paddingTop: 20, marginTop: 8 },
  week: { flexGrow: 1, paddingTop: 16, paddingBottom: 8, gap: 4 },
  dayColumn: { flex: 1, minWidth: 44, paddingHorizontal: 3, paddingVertical: 8, borderRadius: 4 },
  selected: { backgroundColor: '#E6EEE7' },
  barNumber: { fontSize: 12, lineHeight: 18, textAlign: 'center', color: colors.ink },
  barTrack: { height: 110, justifyContent: 'flex-end', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#BBC9C0' },
  dayBar: { width: 20, backgroundColor: '#547B67' },
  partialBar: { backgroundColor: '#92B19D' },
  missing: { color: colors.muted, fontSize: 12, marginBottom: 8 },
  barDate: { fontSize: 12, lineHeight: 20, textAlign: 'center', color: colors.ink, marginTop: 6 },
  hours: { flexDirection: 'row', gap: 3, marginTop: 16, height: 88 },
  hourTrack: { flex: 1, minWidth: 0, justifyContent: 'flex-end', alignItems: 'center', paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: '#CBD8D1' },
  hourBar: { width: '100%', maxWidth: 12, backgroundColor: '#7997B3' },
  hourMissing: { width: 3, height: 3, borderRadius: 2, backgroundColor: '#B7BEC0' },
  axis: { flexDirection: 'row', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8, paddingVertical: 8 },
  settings: { borderTopWidth: 1, borderTopColor: '#D9E0DB', marginTop: 24, minHeight: 52, justifyContent: 'center' },
  shade: { flex: 1, backgroundColor: 'rgba(30,40,35,0.35)', justifyContent: 'center', padding: 24 },
  menu: { padding: 20, backgroundColor: '#FFFFFF', borderRadius: 8, maxHeight: '75%' },
  option: { minHeight: 52, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#E3E9E5' },
});
