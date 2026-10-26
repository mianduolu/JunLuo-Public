import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text } from '../components/AppText';
import { colors } from '../theme/colors';
import type { PeriodObservation } from './periodStore';

const flows = { none: '无', spotting: '点滴', light: '少', medium: '中', heavy: '多' };

export function PeriodObservationList({ observations, onEdit }: {
  observations: PeriodObservation[];
  onEdit: (observation: PeriodObservation) => void;
}) {
  if (!observations.length) return null;
  const peak = Math.max(...observations.map((entry) => entry.painLevel));
  return (
    <View style={styles.list}>
      <Text style={styles.heading}>当天 {observations.length} 次记录 · 最高疼痛 {peak}/5</Text>
      {observations.map((entry) => (
        <View key={entry.id} style={styles.row}>
          <View style={styles.content}>
            <Text style={styles.time}>{entry.timeText ?? '时间未标注'} · 疼痛 {entry.painLevel}/5</Text>
            <Text style={styles.detail}>
              流量 {flows[entry.flow]} · {entry.symptoms.join('、') || '无症状标记'}
            </Text>
            {entry.note ? <Text style={styles.note}>{entry.note}</Text> : null}
          </View>
          <Pressable accessibilityLabel={`修改 ${entry.timeText ?? '时间未标注'} 的身体记录`}
            accessibilityRole="button" onPress={() => onEdit(entry)} style={styles.edit}>
            <Text style={styles.editText}>修改</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  list: { marginTop: 16 },
  heading: { color: colors.muted, fontSize: 13, lineHeight: 20, marginBottom: 6 },
  row: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 8,
    borderTopColor: 'rgba(56,64,82,0.12)', borderTopWidth: 1, paddingVertical: 12,
  },
  content: { flex: 1 },
  time: { color: colors.ink, fontSize: 14, fontWeight: '600', lineHeight: 21 },
  detail: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 4 },
  note: { color: colors.ink, fontSize: 14, lineHeight: 21, marginTop: 6 },
  edit: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  editText: { color: colors.ink, fontSize: 13, fontWeight: '600' },
});
