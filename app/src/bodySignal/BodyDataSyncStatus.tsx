import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { getMiBand6SleepSyncState, miBand6SleepSyncError, subscribeMiBand6SleepSync } from './miBand6SleepSync';

/** Settings keeps transfer status; saved history is displayed in With You. */
export function BodyDataSyncStatus({ onOpen }: { onOpen(): void }) {
  const [sync, setSync] = useState(getMiBand6SleepSyncState);
  useEffect(() => subscribeMiBand6SleepSync(() => setSync(getMiBand6SleepSyncState())), []);
  return <View style={styles.section}>
    <Text style={styles.title}>睡眠同步</Text>
    <Text style={styles.note}>{sync.busy ? '正在同步睡眠记录…' : '已保存的睡眠记录在「与你 · 身体数据」查看。'}</Text>
    {sync.error ? <Text style={styles.note}>{miBand6SleepSyncError(sync.error)}</Text> : null}
    <Pressable accessibilityRole="button" onPress={onOpen} style={styles.button}><Text style={styles.link}>查看身体数据 ›</Text></Pressable>
  </View>;
}
const styles = StyleSheet.create({
  section: { marginTop: 16, paddingTop: 16, borderTopWidth: 1, borderTopColor: '#edf0e9', gap: 8 },
  title: { fontSize: 14, fontWeight: '700', color: '#737b86' },
  note: { fontSize: 14, lineHeight: 22, color: '#788272', flexShrink: 1 },
  button: { minHeight: 44, paddingVertical: 10 }, link: { fontSize: 15, lineHeight: 23, color: '#456D57' },
});
