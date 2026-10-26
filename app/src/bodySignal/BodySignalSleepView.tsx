import { useState, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import type { BodySignalDeviceProfile } from './device/bodySignalDeviceTypes';
import type { BodySignalSleepSummary, SleepTrendDay } from './bodySignalSleepSummary';
import { miBand6SleepPercentages } from './miBand6SleepStages';

const CHART_HEIGHT = 180;
const duration = (minutes: number) => `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
function hasStages(day: SleepTrendDay) {
  return day.deepMinutes !== undefined && day.lightMinutes !== undefined;
}
function dayLabel(day: SleepTrendDay) {
  const stages = hasStages(day) ? `，深睡${duration(day.deepMinutes!)}，浅睡${duration(day.lightMinutes!)}`
    : day.totalMinutes !== undefined ? '，仅有时长' : '';
  return `${day.dateKey}，${day.text}${stages}${day.note ? `，${day.note}` : ''}`;
}

export function BodySignalSleepView({ data, devices, loading, error, retry, selectDevice, goBack, renderHeartRate, embedded = false, selectedDate: controlledDate, onSelectDate }: {
  data?: BodySignalSleepSummary;
  devices: BodySignalDeviceProfile[];
  loading: boolean;
  error?: string;
  retry(): void;
  selectDevice(id: string): void;
  goBack(): void;
  renderHeartRate?(dateKey: string): ReactNode;
  embedded?: boolean;
  selectedDate?: string;
  onSelectDate?(date: string): void;
}) {
  const [localDate, setLocalDate] = useState<string>();
  const selectedDate = onSelectDate ? controlledDate : localDate;
  const setSelectedDate = onSelectDate ?? setLocalDate;
  const day = data?.days.find(item => item.dateKey === selectedDate)
    ?? data?.days.find(item => item.dateKey === data.defaultDateKey);
  const percentages = day && hasStages(day) ? miBand6SleepPercentages(day.deepMinutes!, day.lightMinutes!) : undefined;
  const Container = embedded ? View : ScrollView;
  return <View style={embedded ? styles.embedded : styles.root}>
    {!embedded ? <View style={styles.header}>
      <Pressable accessibilityRole="button" accessibilityLabel="返回身体数据" onPress={goBack} style={styles.back}>
        <Text style={styles.backText}>‹</Text>
      </Pressable>
      <Text style={styles.title}>睡眠趋势</Text><View style={styles.back} />
    </View> : null}
    <Container {...(embedded ? { style: styles.embedded } : { contentContainerStyle: styles.content })}>
      <Text style={styles.heading}>近七天 · 主要睡眠</Text>
      <Text style={styles.note}>按醒来日期记录 · 日期按东八区（UTC+8）</Text>
      {!embedded ? <View style={styles.devices}>{devices.map((device, index) => <Pressable key={device.id}
        accessibilityRole="button" accessibilityState={{ selected: data?.deviceProfileId === device.id }}
        onPress={() => selectDevice(device.id)} style={[styles.device, data?.deviceProfileId === device.id && styles.selected]}>
        <Text style={styles.note}>{data?.deviceProfileId === device.id ? '✓ ' : ''}{device.displayName}
          {devices.filter(item => item.displayName === device.displayName).length > 1 ? ` · 记录 ${index + 1}` : ''}
          {device.isPrimary ? ' · 主设备' : ''}</Text>
      </Pressable>)}</View> : null}
      {loading ? <ActivityIndicator accessibilityLabel="正在读取本地睡眠记录" color="#526E59" /> : null}
      {error ? <View style={styles.section}>
        <Text style={styles.error}>{error}</Text>
        <Pressable accessibilityRole="button" onPress={retry} style={styles.device}><Text style={styles.link}>重试读取本地记录</Text></Pressable>
      </View> : null}
      {!loading && !error && !data ? <Text style={styles.note}>暂无 Mi Band 6 设备档案</Text> : null}
      {data ? <>
        {!embedded ? <View style={styles.section}>
          <Text style={styles.note}>已有记录的平均主要睡眠时长</Text>
          {data.averageMinutes !== undefined ? <Text style={styles.average}>{duration(data.averageMinutes)}</Text> : null}
          <Text style={styles.note}>{data.recordedNights ? `按 ${data.recordedNights} 晚记录计算` : '暂无已保存记录'}</Text>
          {data.unreviewedNights > 0 ? <Text style={styles.note}>包含 {data.unreviewedNights} 晚本次尚未复核的记录</Text> : null}
        </View> : null}
        <View style={styles.legend}>
          <View style={styles.legendItem}><View style={[styles.swatch, styles.deep]} /><Text style={styles.note}>深睡</Text></View>
          <View style={styles.legendItem}><View style={[styles.swatch, styles.light]} /><Text style={styles.note}>浅睡</Text></View>
          <View style={styles.legendItem}><View style={[styles.swatch, styles.durationOnly]} /><Text style={styles.note}>仅有时长</Text></View>
        </View>
        <View style={styles.chart}>
          <View style={styles.axis} accessible={false} importantForAccessibility="no-hide-descendants">
            <Text style={styles.axisText}>{data.axisHours}小时</Text>
            <Text style={styles.axisText}>{data.axisHours / 2}小时</Text>
            <Text style={styles.axisText}>0小时</Text>
          </View>
          <ScrollView horizontal style={styles.chartScroll} contentContainerStyle={styles.columns}>
            {data.days.map(item => <Pressable key={item.dateKey} testID={`sleep-day-${item.dateKey}`}
              accessibilityRole="button" accessibilityLabel={dayLabel(item)}
              accessibilityState={{ selected: item.dateKey === day?.dateKey }}
              onPress={() => setSelectedDate(item.dateKey)} style={[styles.column, item.dateKey === day?.dateKey && styles.selected]}>
              <View style={styles.track} accessible={false} importantForAccessibility="no-hide-descendants">
                {item.totalMinutes !== undefined ? <View style={styles.stack}>
                  {hasStages(item) ? <>
                    <View testID={`sleep-deep-${item.dateKey}`} style={[styles.deep, { height: item.deepMinutes! / (data.axisHours * 60) * CHART_HEIGHT }]} />
                    <View testID={`sleep-light-${item.dateKey}`} style={[styles.light, { height: item.lightMinutes! / (data.axisHours * 60) * CHART_HEIGHT }]} />
                  </> : <View testID={`sleep-duration-${item.dateKey}`} style={[styles.durationOnly, { height: item.totalMinutes / (data.axisHours * 60) * CHART_HEIGHT }]} />}
                </View> : <Text style={styles.note}>—</Text>}
              </View>
              <Text style={styles.date}>{item.dateKey.slice(5).replace('-', '/')}</Text>
              <Text style={styles.columnNote}>{item.totalMinutes === undefined ? '暂无记录' : hasStages(item) ? '深／浅' : '仅有时长'}</Text>
            </Pressable>)}
          </ScrollView>
        </View>
        <Text style={styles.note}>点选日期查看详情；没有记录的日期不计入平均。</Text>
        {day ? <View testID="sleep-selected-day" style={styles.section}>
          <Text style={styles.heading}>{day.dateKey} · 主要睡眠</Text>
          <Text style={styles.average}>{day.text}</Text>
          {percentages ? <>
            <Text style={styles.note}>深睡 {duration(day.deepMinutes!)} · {percentages.deep}%</Text>
            <Text style={styles.note}>浅睡 {duration(day.lightMinutes!)} · {percentages.light}%</Text>
          </> : day.totalMinutes !== undefined ? <Text style={styles.note}>仅有时长</Text> : null}
          {day.note ? <Text style={styles.note}>{day.note}</Text> : null}
        </View> : null}
        {day ? renderHeartRate?.(day.dateKey) : null}
      </> : null}
      <Text style={styles.note}>深浅睡为设备算法估计，仅供参考。</Text>
      <Text style={styles.note}>当天等待记录完整后再保存；暂未包含午睡和补觉合计。没有记录不表示没有睡。</Text>
    </Container>
  </View>;
}

const styles = StyleSheet.create({
  embedded: { gap: 12 },
  root: { flex: 1, backgroundColor: '#F7FAF5' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 8 },
  back: { width: 48, minHeight: 48, alignItems: 'center', justifyContent: 'center' },
  backText: { fontSize: 34, color: '#455348' }, title: { flex: 1, fontSize: 22, fontWeight: '700', textAlign: 'center', color: '#455348' },
  content: { padding: 20, paddingBottom: 32, gap: 12, maxWidth: 680, width: '100%', alignSelf: 'center' },
  heading: { fontSize: 18, fontWeight: '700', color: '#455348', flexShrink: 1 },
  note: { fontSize: 13, lineHeight: 21, color: '#667466', flexShrink: 1 },
  average: { fontSize: 24, lineHeight: 34, fontWeight: '700', color: '#455348', flexShrink: 1 },
  section: { paddingVertical: 14, gap: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DCE3D8' },
  devices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  device: { padding: 10, minHeight: 44, borderRadius: 8, backgroundColor: '#EEF2EB' },
  selected: { backgroundColor: '#E0EADD' }, error: { color: '#8B5247', fontSize: 14, lineHeight: 22 },
  link: { color: '#456D57', fontSize: 15, lineHeight: 23 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
  deep: { backgroundColor: '#526E59' }, light: { backgroundColor: '#B5C9A9' }, durationOnly: { backgroundColor: '#929BA5' },
  chart: { flexDirection: 'row', gap: 6 }, chartScroll: { flex: 1 },
  axis: { height: CHART_HEIGHT, width: 56, justifyContent: 'space-between' },
  axisText: { fontSize: 12, color: '#667466' },
  columns: { flexGrow: 1, gap: 4 }, column: { flex: 1, minWidth: 60, paddingHorizontal: 6, paddingBottom: 8, borderRadius: 6 },
  track: { height: CHART_HEIGHT, justifyContent: 'flex-end', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: '#C3CFC1' },
  stack: { width: 30, flexDirection: 'column-reverse' },
  date: { fontSize: 13, lineHeight: 22, color: '#455348', textAlign: 'center', marginTop: 6 },
  columnNote: { fontSize: 12, lineHeight: 19, color: '#667466', textAlign: 'center' },
});
