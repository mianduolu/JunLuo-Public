import { memo } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import { colors } from '../../theme/colors';
import { formatTime } from '../../schedule/scheduleViewUtils';
import type { ScheduleViewTask } from '../../schedule/scheduleViewTypes';
import type { DailyChallengeForDate } from '../../schedule/dailyChallengeStore';
import { ScheduleViewTaskCard } from './ScheduleViewTaskCard';

type Props = {
  emptyText: string;
  floatingChallenges: DailyChallengeForDate[];
  onOpenTask: (task: ScheduleViewTask) => void;
  onToggleTask: (task: ScheduleViewTask) => void;
  scrollEnabled?: boolean;
  timedTasks: ScheduleViewTask[];
};

export const ScheduleTimelineList = memo(function ScheduleTimelineList({
  emptyText,
  floatingChallenges,
  onOpenTask,
  onToggleTask,
  scrollEnabled = true,
  timedTasks,
}: Props) {
  const content = (
    <>
      {floatingChallenges.length ? (
        <View style={styles.floatingSection}>
          <Text style={styles.floatingHeading}>找时间做</Text>
          {floatingChallenges.map((entry) => {
            const streakMark = entry.streak >= 30 ? '★' : entry.streak >= 3 ? '🔥' : '';
            const task: ScheduleViewTask = {
              category: entry.todo.category,
              completed: entry.completed,
              completedAt: entry.todo.completedAt,
              dateKey: entry.todo.plannedForDate ?? '',
              id: `todo-${entry.todo.id}`,
              kind: 'todo',
              priority: entry.todo.priority,
              quadrant: entry.todo.quadrant,
              sourceId: entry.todo.id,
              title: entry.todo.title,
              todo: entry.todo,
            };
            return (
              <Pressable key={entry.challenge.id} onPress={() => onOpenTask(task)} style={[styles.floatingRow, entry.completed && styles.floatingRowDone]}>
                <Pressable
                  accessibilityLabel={entry.completed ? '取消完成挑战' : '完成挑战'}
                  onPress={(event) => { event.stopPropagation(); onToggleTask(task); }}
                  style={[styles.floatingCheck, entry.completed && styles.floatingCheckDone]}
                >
                  <Text style={styles.floatingCheckText}>{entry.completed ? '✓' : ''}</Text>
                </Pressable>
                <View style={styles.floatingCopy}>
                  <Text numberOfLines={1} style={[styles.floatingTitle, entry.completed && styles.floatingTitleDone]}>{entry.challenge.title}</Text>
                  <Text style={styles.floatingMeta}>{entry.challenge.estimatedMinutes} 分钟 · 连续 {entry.streak} 天 {streakMark}</Text>
                </View>
                <Text style={styles.floatingStatus}>{entry.completed ? '完成' : '待做'}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {timedTasks.length ? timedTasks.map((task) => (
        <View key={task.id} style={styles.row}>
          <View style={styles.timeBlock}>
            <Text style={styles.timeStrong}>{formatTime(task.startAt ?? 0)}</Text>
            <View style={styles.dot} />
            <View style={styles.line} />
          </View>
          <View style={styles.cardWrap}>
            <ScheduleViewTaskCard onPress={() => onOpenTask(task)} onToggleComplete={() => onToggleTask(task)} task={task} />
          </View>
        </View>
      )) : floatingChallenges.length ? null : <Text style={styles.empty}>{emptyText}</Text>}
    </>
  );

  if (!scrollEnabled) {
    return <View style={[styles.list, styles.content, styles.embeddedList]}>{content}</View>;
  }

  return (
    <ScrollView showsVerticalScrollIndicator={false} style={styles.list} contentContainerStyle={styles.content}>
      {content}
    </ScrollView>
  );
});

const styles = StyleSheet.create({
  list: { flex: 1, marginTop: 12 },
  content: { gap: 4, paddingBottom: 28 },
  embeddedList: { flex: 0 },
  row: { flexDirection: 'row', gap: 10, minHeight: 82 },
  timeBlock: { alignItems: 'center', width: 56 },
  timeStrong: { color: '#817AE4', fontSize: 12, fontWeight: '500', marginTop: 2 },
  dot: { backgroundColor: '#817AE4', borderRadius: 4, height: 8, marginTop: 8, width: 8 },
  line: { backgroundColor: '#DED9FA', flex: 1, marginTop: 4, minHeight: 36, width: 1 },
  cardWrap: { flex: 1 },
  empty: { color: colors.muted, fontSize: 13, fontWeight: '400', paddingHorizontal: 8, paddingVertical: 12 },
  floatingSection: { borderBottomColor: '#E7E3F2', borderBottomWidth: 1, gap: 6, marginBottom: 10, paddingBottom: 12 },
  floatingHeading: { color: colors.ink, fontSize: 14, fontWeight: '500' },
  floatingRow: { alignItems: 'center', backgroundColor: '#F8F7FF', borderRadius: 10, flexDirection: 'row', gap: 9, minHeight: 52, paddingHorizontal: 11, paddingVertical: 8 },
  floatingRowDone: { opacity: 0.62 },
  floatingDot: { backgroundColor: '#C7C2EB', borderRadius: 4, height: 8, width: 8 },
  floatingDotStrong: { backgroundColor: '#F2A65A' },
  floatingCheck: { alignItems: 'center', borderColor: '#A8A3B4', borderRadius: 10, borderWidth: 1.5, height: 20, justifyContent: 'center', width: 20 },
  floatingCheckDone: { backgroundColor: '#817AE4', borderColor: '#817AE4' },
  floatingCheckText: { color: '#FFFFFF', fontSize: 12, lineHeight: 15 },
  floatingCopy: { flex: 1, gap: 2 },
  floatingTitle: { color: colors.ink, fontSize: 14, fontWeight: '500' },
  floatingTitleDone: { textDecorationLine: 'line-through' },
  floatingMeta: { color: colors.muted, fontSize: 11, fontWeight: '400' },
  floatingStatus: { color: '#817AE4', fontSize: 11, fontWeight: '500' },
});
