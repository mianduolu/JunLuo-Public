import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import type { useSleepHeartRateSnapshot } from './useSleepHeartRateSnapshot';

type Snapshot = ReturnType<typeof useSleepHeartRateSnapshot>;
const emptyMessages = {
  no_sleep: '这一天暂无已保存的主要睡眠记录，暂不能关联心率。',
  no_stages: '这晚只有时长或没有完整有效的分段，暂不能关联心率。',
  no_readings: '这晚的算法估计睡眠时段内，暂无可关联的心率记录。',
  raw_expired: '这晚可用于回填的原始心率已超出保留期，无法补回关联。',
};
const timeText = (at: number) => new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(5, 16).replace('T', ' ');

export function SleepHeartRateSection({ dateKey, snapshot }: { dateKey: string; snapshot: Snapshot }) {
  // The screen keys this section by profile/date so switching either closes the details.
  const [expanded, setExpanded] = useState(false);
  const night = snapshot.data?.nights[dateKey];
  const reference = snapshot.data?.reference;
  return <View testID="sleep-heart-rate" style={styles.root}>
    <Text style={styles.heading}>所选晚 · 睡眠心率</Text>
    <Text style={styles.note}>{dateKey} · 按醒来日期</Text>
    {snapshot.loading ? <ActivityIndicator accessibilityLabel="正在读取本地睡眠心率" color="#526E59" /> : null}
    {snapshot.error ? <View>
      <Text accessibilityRole="alert" style={styles.error}>{snapshot.error}</Text>
      <Pressable testID="sleep-heart-rate-retry" accessibilityRole="button" onPress={snapshot.retry} style={styles.button}>
        <Text style={styles.link}>重试读取本地心率</Text>
      </Pressable>
    </View> : null}
    {snapshot.data?.refreshError ? <Text accessibilityRole="alert" style={styles.error}>
      {snapshot.data.refreshError}
    </Text> : null}
    {night ? <View testID="sleep-heart-rate-night" style={styles.group}>
      {night.status === 'available' ? <>
        <Text style={styles.value}>代表心率 {Math.round(night.median!)} bpm</Text>
        <Text style={styles.note}>{night.buckets.length} 个五分钟样本 · 各区间代表值的中位数</Text>
        <Pressable testID="sleep-heart-rate-expand" accessibilityRole="button" accessibilityState={{ expanded }}
          onPress={() => setExpanded(value => !value)} style={styles.button}>
          <Text style={styles.link}>{expanded ? '收起五分钟明细' : '展开五分钟明细'}</Text>
        </Pressable>
        {expanded ? <View testID="sleep-heart-rate-buckets" style={styles.group}>
          <Text style={styles.note}>时间按东八区（UTC+8）；以下是采样分组，不是精确睡醒边界。每组只含算法估计睡眠时段内的读数。</Text>
          {night.buckets.map(bucket => <View key={bucket.bucketStartedAt} accessible style={styles.bucket}>
            <Text style={styles.note}>{timeText(bucket.bucketStartedAt)}–{timeText(bucket.bucketStartedAt + 5 * 60 * 1000)}</Text>
            <Text style={styles.detail}>{Math.round(bucket.value)} bpm · {bucket.readingCount} 条原始记录</Text>
          </View>)}
        </View> : null}
      </> : <Text style={styles.note}>{emptyMessages[night.status]}</Text>}
      {night.unreviewed ? <Text style={styles.note}>包含本次尚未复核的睡眠来源。</Text> : null}
    </View> : null}
    {reference ? <View testID="sleep-heart-rate-reference" style={styles.reference}>
      <Text style={styles.heading}>28天睡眠心率参考</Text>
      {reference.readiness === 'mature' && reference.median !== undefined
        ? <Text style={styles.value}>个人参考心率 {Math.round(reference.median)} bpm</Text>
        : <Text style={styles.detail}>学习中</Text>}
      <Text style={styles.note}>已有 {reference.dateCount} 个不同采样日期 · {reference.bucketCount} 个五分钟样本</Text>
      <Text style={styles.note}>形成参考需要至少 7 个不同采样日期、20 个五分钟样本。采样日期按东八区计算，不等同于睡眠晚数。</Text>
      {reference.unreviewed ? <Text style={styles.note}>参考数据包含尚未复核的睡眠来源。</Text> : null}
    </View> : null}
    <Text style={styles.note}>按设备算法估计的睡眠时段关联心率，仅供个人参考，不用于异常判断。</Text>
  </View>;
}

const styles = StyleSheet.create({
  root: { paddingVertical: 14, gap: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#DCE3D8' },
  heading: { fontSize: 18, fontWeight: '700', color: '#455348', flexShrink: 1 },
  note: { fontSize: 13, lineHeight: 21, color: '#667466', flexShrink: 1 },
  value: { fontSize: 22, lineHeight: 32, fontWeight: '700', color: '#455348', flexShrink: 1 },
  detail: { fontSize: 15, lineHeight: 24, color: '#455348', flexShrink: 1 },
  group: { gap: 6 }, bucket: { gap: 2, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#DCE3D8' },
  reference: { padding: 14, borderRadius: 10, backgroundColor: '#EEF2EB', gap: 6, marginVertical: 6 },
  button: { minHeight: 44, paddingVertical: 10, alignSelf: 'flex-start' },
  link: { fontSize: 15, lineHeight: 23, color: '#456D57', flexShrink: 1 },
  error: { color: '#8B5247', fontSize: 14, lineHeight: 22, flexShrink: 1 },
});
