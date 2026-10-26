import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import type { ScheduleViewTask } from '../../schedule/scheduleViewTypes';
import { colors } from '../../theme/colors';
import { ScheduleViewTaskCard } from './ScheduleViewTaskCard';

type Props = {
  collapsed?: boolean;
  countLabel: string;
  emptyText?: string;
  onOpenTask: (task: ScheduleViewTask) => void;
  onToggleTask: (task: ScheduleViewTask) => void;
  onToggleCollapsed?: () => void;
  scrollable?: boolean;
  stripeColor?: string;
  tasks: ScheduleViewTask[];
  title: string;
};

export const ScheduleTaskSection = memo(function ScheduleTaskSection({
  collapsed,
  countLabel,
  emptyText,
  onOpenTask,
  onToggleTask,
  onToggleCollapsed,
  scrollable,
  stripeColor,
  tasks,
  title,
}: Props) {
  const taskList = !tasks.length ? (
    <Text style={styles.displayEmpty}>{emptyText ?? '这里暂时空着。'}</Text>
  ) : collapsed && tasks.length > 3 ? (
    <Text style={styles.completedSummary}>已完成 {tasks.length} 件，先收起来给今天留点清爽。</Text>
  ) : (
    tasks.map((task) => (
      <ScheduleViewTaskCard
        key={task.id}
        onPress={() => onOpenTask(task)}
        onToggleComplete={() => onToggleTask(task)}
        task={task}
      />
    ))
  );

  return (
    <View style={styles.displaySection}>
      <View style={styles.displaySectionHeader}>
        <View style={[styles.displaySectionMark, stripeColor ? { backgroundColor: stripeColor } : null]} />
        <Text style={styles.displaySectionTitle}>{title}</Text>
        <Text style={styles.displaySectionCount}>{countLabel} {tasks.length}</Text>
      </View>
      {scrollable ? (
        <ScrollView
          contentContainerStyle={styles.groupLimitedContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator={tasks.length > 6}
          style={styles.groupLimitedScroll}
        >
          {taskList}
        </ScrollView>
      ) : taskList}
      {onToggleCollapsed && tasks.length > 3 ? (
        <Pressable onPress={onToggleCollapsed} style={styles.collapseButton}>
          <Text style={styles.collapseButtonText}>{collapsed ? `展开全部 ${tasks.length} 条` : '收起已完成'}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  displaySection: { backgroundColor: '#FFFFFF', borderColor: '#ECE8F3', borderRadius: 16, borderWidth: 1, gap: 9, padding: 10 },
  displaySectionHeader: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 28 },
  displaySectionMark: { backgroundColor: '#817AE4', borderRadius: 3, height: 18, width: 4 },
  displaySectionTitle: { color: colors.ink, flex: 1, fontSize: 16, fontWeight: '600' },
  displaySectionCount: { color: '#A4A0B2', fontSize: 12, fontWeight: '400' },
  displayEmpty: { color: colors.muted, fontSize: 13, fontWeight: '400', paddingHorizontal: 8, paddingVertical: 12 },
  completedSummary: { backgroundColor: '#F7F5FF', borderColor: '#E6E1FF', borderRadius: 13, borderWidth: 1, color: '#746BDD', fontSize: 13, fontWeight: '400', lineHeight: 19, padding: 12 },
  collapseButton: { alignItems: 'center', backgroundColor: '#F0EEFF', borderRadius: 13, paddingVertical: 9 },
  collapseButtonText: { color: '#746BDD', fontSize: 12, fontWeight: '500' },
  groupLimitedScroll: { maxHeight: 224 },
  groupLimitedContent: { gap: 8, paddingBottom: 4 },
});
