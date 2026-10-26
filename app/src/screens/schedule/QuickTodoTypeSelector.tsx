import { memo, useEffect, useState } from 'react';
import { InteractionManager, Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import type { TodoType } from '../../schedule/todoStore';

export const QuickTodoTypeSelector = memo(function QuickTodoTypeSelector({
  onCommit,
  onImmediate,
  value,
}: {
  onCommit: (value: TodoType) => void;
  onImmediate: (value: TodoType) => void;
  value: TodoType;
}) {
  const [selected, setSelected] = useState(value);

  useEffect(() => setSelected(value), [value]);

  const choose = (next: TodoType) => {
    if (next === selected) return;
    setSelected(next);
    onImmediate(next);
    InteractionManager.runAfterInteractions(() => onCommit(next));
  };

  return (
    <View style={styles.row}>
      <Pressable onPress={() => choose('normal')} style={[styles.chip, styles.normalBorder, selected === 'normal' && styles.normalSelected]}>
        <Text style={styles.text}>普通任务</Text>
      </Pressable>
      <Pressable onPress={() => choose('inhibit')} style={[styles.chip, styles.inhibitBorder, selected === 'inhibit' && styles.inhibitSelected]}>
        <Text style={styles.text}>提醒自己别做</Text>
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: 10 },
  chip: { alignItems: 'center', borderRadius: 16, borderWidth: 1.4, justifyContent: 'center', minHeight: 46, paddingHorizontal: 16 },
  normalBorder: { borderColor: '#C8C3DD' },
  inhibitBorder: { borderColor: '#A9D3BA' },
  normalSelected: { backgroundColor: '#F0EEFA' },
  inhibitSelected: { backgroundColor: '#E6F4EC' },
  text: { color: '#343149', fontSize: 14, fontWeight: '400' },
});
