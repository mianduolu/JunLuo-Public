// @refresh reset
import { useEffect, useState } from 'react';
import { AppState, Pressable, StyleSheet, View } from 'react-native';

import { getLocalDateKey, loadAssistantLifeDays } from '../ai/assistantLifeTimeline';
import { AppText as Text } from '../components/AppText';
import { LIFE_RHYTHM_STATE_KEY } from '../life/lifeRhythm';
import { readRelevantSleepNight } from '../life/sleepPlanStore';
import { presentTodaySleep, sleepBriefTime, type TodaySleepPresentation } from '../life/sleepSchedulePresentation';
import { assistantLifeStateStorageBridge } from '../sync/syncAssistantLifeStateStorageBridge';
import { colors } from '../theme/colors';

async function readTodaySleep() {
  const now = Date.now();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const [[previous, today], relevant, rhythmRaw] = await Promise.all([
    loadAssistantLifeDays([getLocalDateKey(yesterday), getLocalDateKey(new Date(now))]),
    readRelevantSleepNight(now),
    assistantLifeStateStorageBridge.getItem(LIFE_RHYTHM_STATE_KEY),
  ]);
  return { ...presentTodaySleep({ now, previous, today, relevant, rhythmRaw }), readAt: now };
}

export function TodaySleepScheduleCard({ refreshVersion }: { refreshVersion: number }) {
  const [snapshot, setSnapshot] = useState<(TodaySleepPresentation & { readAt: number }) | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') setRefresh(value => value + 1);
    });
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    let active = true;
    setStatus('loading');
    const timer = setTimeout(() => { if (active) setStatus('error'); }, 15_000);
    void readTodaySleep().then(value => {
      if (active) { setSnapshot(value); setStatus('ready'); }
    }).catch(() => { if (active) setStatus('error'); }).finally(() => clearTimeout(timer));
    return () => { active = false; clearTimeout(timer); };
  }, [refresh, refreshVersion]);
  return <View style={styles.card}>
    <View style={styles.header}>
      <View>
        <Text style={styles.title}>今日作息</Text>
        {snapshot ? <Text style={styles.note}>{snapshot.date.slice(5).replace('-', '月')}日 · 更新于 {sleepBriefTime(snapshot.readAt, snapshot.readAt)}</Text> : null}
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="刷新今日作息" disabled={status === 'loading'}
        onPress={() => setRefresh(value => value + 1)} style={styles.button}>
        <Text style={styles.link}>{status === 'loading' ? '读取中' : '刷新'}</Text>
      </Pressable>
    </View>
    {status !== 'ready' ? <Text style={styles.note}>{status === 'error'
      ? '暂时未能读全作息，请点本栏刷新。' : '正在读取已存作息。'}{snapshot ? '下方暂为上次读取结果。' : ''}</Text> : null}
    {snapshot ? <>
      {snapshot.previousSleep ? <Text style={styles.actualText}>最近入睡 · {snapshot.previousSleep}</Text> : null}
      <View style={styles.timeCards}>
        {[{ title: '☀️ 起床', data: snapshot.wake }, { title: '🌙 入睡', data: snapshot.sleep }].map((item, index) => (
          <View key={item.title} style={[styles.timeCard, index === 1 && styles.sleepCard]}>
            <Text style={styles.timeTitle}>{item.title}</Text>
            <Text style={styles.clock}>{item.data.planned}</Text>
            <Text style={styles.planLabel}>计划时间</Text>
            <View style={styles.actualRows}>{item.data.actual.map(row => (
              <Text key={row.label} style={styles.actualText}>{row.label} · {row.value}</Text>
            ))}</View>
          </View>
        ))}
      </View>
      {snapshot.nextWake !== snapshot.wake.planned ? <View style={styles.nextWake}>
        <Text style={styles.label}>下次计划起床</Text>
        <Text style={styles.nextWakeTime}>{snapshot.nextWake}</Text>
      </View> : null}
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(value => !value)} style={styles.details}>
        <Text style={styles.link}>{expanded ? '收起详细作息 ▴' : '睡醒经过与数值 ▾'}</Text>
      </Pressable>
      {expanded ? <>
        <Text style={styles.subtitle}>今天的睡醒经过</Text>
        {snapshot.timeline.length ? <View>{snapshot.timeline.map((row, index) => (
          <View key={`${row.label}:${index}`} style={styles.eventRow}>
            <Text style={styles.eventTime}>{row.value}</Text>
            <View style={styles.eventCopy}>
              <Text style={styles.eventLabel}>● {row.label}</Text>
              {row.note ? <Text style={styles.note}>{row.note}</Text> : null}
            </View>
          </View>
        ))}</View> : <Text style={styles.note}>今天还没有睡醒记录。</Text>}
        {snapshot.changes.length ? <View style={styles.changes}>
          <Text style={styles.subtitle}>计划有过调整</Text>
          {snapshot.changes.map(row => <View key={row.label} style={styles.changeRow}>
            <Text style={styles.label}>{row.label}</Text><Text style={styles.actualText}>{row.value}</Text>
          </View>)}
        </View> : null}
        <Text style={styles.subtitle}>作息数值</Text>
        {snapshot.rhythmRecordedAt ? <>
          <Text style={styles.note}>记录于 {snapshot.rhythmRecordedAt}</Text>
          <View style={styles.metrics}>{snapshot.metrics.map(row => <View key={row.label} style={styles.metric}>
            <View style={styles.metricHeader}>
              <Text style={styles.label}>{row.label}</Text><Text style={styles.metricValue}>{row.value}</Text>
            </View>
            <View style={styles.track}>{row.amount !== undefined
              ? <View style={[styles.fill, { width: `${row.amount}%` }]} /> : null}</View>
          </View>)}</View>
        </> : <Text style={styles.note}>暂无可读的已存数值。</Text>}
      </> : null}
    </> : null}
  </View>;
}

const styles = StyleSheet.create({
  card: { borderRadius: 24, padding: 18, backgroundColor: colors.cardStrong, gap: 10 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  title: { color: colors.ink, fontSize: 19, fontWeight: '700' },
  subtitle: { color: colors.ink, fontSize: 15, fontWeight: '700', marginTop: 4 },
  label: { color: colors.muted, fontSize: 13 },
  note: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  timeCards: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  timeCard: { flexGrow: 1, flexBasis: 125, padding: 14, borderRadius: 18, backgroundColor: '#FFF3E7' },
  sleepCard: { backgroundColor: '#F0EEFA' },
  timeTitle: { color: colors.ink, fontSize: 15, fontWeight: '600' },
  clock: { color: colors.ink, fontSize: 28, fontWeight: '700', marginTop: 8, fontVariant: ['tabular-nums'] },
  planLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  actualRows: { marginTop: 12, gap: 5 },
  actualText: { color: colors.muted, fontSize: 12, lineHeight: 19 },
  nextWake: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingVertical: 5 },
  nextWakeTime: { color: colors.ink, fontSize: 16, fontWeight: '600' },
  eventRow: { flexDirection: 'row', gap: 12, paddingVertical: 7 },
  eventTime: { color: colors.muted, fontSize: 13, minWidth: 44, fontVariant: ['tabular-nums'] },
  eventCopy: { flex: 1, gap: 2 },
  eventLabel: { color: colors.ink, fontSize: 14 },
  changes: { gap: 7 },
  changeRow: { gap: 3 },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  metric: { flexGrow: 1, flexBasis: 125, padding: 10, gap: 8, borderRadius: 12, backgroundColor: '#F5F8F7' },
  metricHeader: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', gap: 5 },
  metricValue: { color: colors.ink, fontSize: 12, fontWeight: '600' },
  track: { height: 4, backgroundColor: '#E5EDEA', borderRadius: 2 },
  fill: { height: 4, backgroundColor: '#88B6AA', borderRadius: 2 },
  button: { minHeight: 44, minWidth: 48, justifyContent: 'center', alignItems: 'center' },
  details: { minHeight: 44, justifyContent: 'center' },
  link: { color: '#598783', fontSize: 14, fontWeight: '600' },
});
