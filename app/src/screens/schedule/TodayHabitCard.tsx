import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import type { Goal } from '../../schedule/goalStore';
import type { HabitForDate, HabitSummaryForDate } from '../../schedule/habitStore';
import { getCategoryConfig } from '../../schedule/taskMeta';
import { colors } from '../../theme/colors';

type Props = {
  goals: Goal[];
  habitSummary: HabitSummaryForDate;
  onCreate: () => void;
  onManage: () => void;
  onToggle: (habit: HabitForDate) => void;
  onUndo: (habit: HabitForDate) => void;
};

export const TodayHabitCard = memo(function TodayHabitCard({ goals, habitSummary, onCreate, onManage, onToggle, onUndo }: Props) {
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.titleBlock}>
          <Text style={styles.title}>◌ 今日习惯</Text>
          <Text style={styles.focus}>{habitSummary.total ? `完成 ${habitSummary.done}/${habitSummary.total}` : '还没有今日习惯'}</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable onPress={onCreate} style={styles.smallButton}><Text style={styles.smallButtonText}>新建</Text></Pressable>
          <Pressable onPress={onManage} style={styles.smallButton}><Text style={styles.smallButtonText}>管理</Text></Pressable>
        </View>
      </View>
      {habitSummary.habits.length ? (
        <View style={styles.list}>
          {habitSummary.habits.map((habit) => {
            const category = getCategoryConfig(habit.category);
            const goal = habit.goalId ? goalsById.get(habit.goalId) : undefined;
            const completedCount = habit.log?.completedCount ?? 0;
            const timeLabel = habit.reminderTimes.length ? ` · ${habit.reminderTimes.join(' / ')}` : '';
            return (
              <View key={habit.id} style={[styles.row, habit.completedToday && styles.rowDone]}>
                <Pressable disabled={habit.completedToday} onPress={() => onToggle(habit)} style={[styles.check, habit.completedToday && styles.checkDone]}>
                  <Text style={styles.checkText}>{habit.completedToday ? '✓' : ''}</Text>
                </Pressable>
                <Pressable disabled={habit.completedToday} onPress={() => onToggle(habit)} style={styles.rowCopy}>
                  <Text numberOfLines={1} style={[styles.rowTitle, habit.completedToday && styles.rowTitleDone]}>{category.icon} {habit.title}</Text>
                  <Text numberOfLines={1} style={styles.rowMeta}>{completedCount}/{habit.targetCount} 次{timeLabel} · 连续 {habit.streak} 天{goal ? ` · ${goal.title}` : ''}</Text>
                </Pressable>
                {habit.completedToday ? <Pressable onPress={() => onUndo(habit)}><Text style={styles.undo}>撤销</Text></Pressable> : null}
              </View>
            );
          })}
        </View>
      ) : <Text style={styles.empty}>可以先放一个很小很小的坚持，比如喝水、散步、读两页书。</Text>}
    </View>
  );
});

const styles = StyleSheet.create({
  card: { backgroundColor: '#F3FFF5', borderColor: '#D7F0DA', borderRadius: 18, borderWidth: 1, gap: 10, marginBottom: 10, padding: 13 },
  header: { alignItems: 'flex-start', flexDirection: 'row', gap: 10, justifyContent: 'space-between' },
  titleBlock: { flex: 1 },
  title: { color: colors.ink, fontSize: 15, fontWeight: '600', lineHeight: 20 },
  focus: { color: '#5E9164', fontSize: 12, fontWeight: '400', lineHeight: 17, marginTop: 2 },
  headerActions: { flexDirection: 'row', gap: 7 },
  smallButton: { backgroundColor: '#FFFFFF', borderColor: '#CFE9D3', borderRadius: 14, borderWidth: 1, paddingHorizontal: 10, paddingVertical: 6 },
  smallButtonText: { color: '#5D9B65', fontSize: 12, fontWeight: '500' },
  list: { gap: 8 },
  row: { alignItems: 'center', backgroundColor: '#FFFFFF', borderColor: '#DCEFE0', borderRadius: 14, borderWidth: 1, flexDirection: 'row', gap: 10, minHeight: 52, paddingHorizontal: 10, paddingVertical: 8 },
  rowDone: { backgroundColor: '#F8FFF8' },
  check: { alignItems: 'center', borderColor: '#BFDCC4', borderRadius: 11, borderWidth: 1, height: 22, justifyContent: 'center', width: 22 },
  checkDone: { backgroundColor: '#7BC67E', borderColor: '#7BC67E' },
  checkText: { color: '#FFFFFF', fontSize: 14, fontWeight: '600', lineHeight: 18 },
  rowCopy: { flex: 1 },
  rowTitle: { color: colors.ink, fontSize: 14, fontWeight: '500', lineHeight: 19 },
  rowTitleDone: { color: '#7D8189' },
  rowMeta: { color: colors.muted, fontSize: 11, fontWeight: '400', lineHeight: 16, marginTop: 1 },
  undo: { color: '#6D8E71', fontSize: 11, fontWeight: '500', paddingHorizontal: 4, paddingVertical: 5 },
  empty: { color: '#6E796F', fontSize: 13, fontWeight: '400', lineHeight: 20 },
});
