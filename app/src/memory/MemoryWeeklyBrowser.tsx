import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { AppText as Text, AppTextInput as TextInput } from '../components/AppText';
import { MemoryWeeklyRefreshPanel } from './MemoryWeeklyRefreshPanel';
import { latestDueWeeklyPeriod } from './memoryWeeklySchedule';
import { weeklyRangeFromKey } from './memoryWeeklyBasis';

export function MemoryWeeklyBrowser({ onSaved }: { onSaved: () => Promise<void> }) {
  const [weekKey, setWeekKey] = useState(() => latestDueWeeklyPeriod().weekKey);
  const week = weeklyRangeFromKey(weekKey);
  const move = (days: number) => {
    if (!week) return;
    const date = new Date(week.start);
    date.setDate(date.getDate() + days);
    setWeekKey(`${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`);
  };
  return <View style={styles.panel}>
    <Text>周回顾 · 历史与待审</Text>
    <Text>输入这一周的周一日期，或按周翻页。一次只处理一张待审稿。</Text>
    <View style={styles.row}>
      <Pressable disabled={!week} onPress={() => move(-7)}><Text>上一周</Text></Pressable>
      <TextInput accessibilityLabel="周回顾周一日期" placeholder="YYYY-MM-DD" value={weekKey} onChangeText={setWeekKey} style={styles.input} />
      <Pressable disabled={!week || weekKey >= latestDueWeeklyPeriod().weekKey} onPress={() => move(7)}><Text>下一周</Text></Pressable>
    </View>
    {!week ? <Text>请填写有效的周一日期。</Text> : null}
    <MemoryWeeklyRefreshPanel weekKey={week?.key} onSaved={onSaved} />
  </View>;
}

const styles = StyleSheet.create({
  panel: { paddingVertical: 12, gap: 10 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { flex: 1, backgroundColor: '#FFF', padding: 10, borderRadius: 10 },
});
