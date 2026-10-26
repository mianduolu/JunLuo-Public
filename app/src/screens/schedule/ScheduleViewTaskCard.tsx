import { memo, useRef } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { AppText as Text } from '../../components/AppText';
import { colors } from '../../theme/colors';
import { getCategoryConfig, getQuadrantConfig, priorityLabels } from '../../schedule/taskMeta';
import { taskTimeLabel, scheduleOwnerAppearance, scheduleExecutionLabel, scheduleTaskGesture, type ScheduleTaskGestureState } from '../../schedule/scheduleViewUtils';
import type { ScheduleViewTask } from '../../schedule/scheduleViewTypes';

type Props = {
  compact?: boolean;
  dragging?: boolean;
  onDragStart?: (task: ScheduleViewTask, x: number, y: number) => void;
  onPress: () => void;
  onToggleComplete?: () => void;
  task: ScheduleViewTask;
};

export const ScheduleViewTaskCard = memo(function ScheduleViewTaskCard({
  compact,
  dragging,
  onDragStart,
  onPress,
  onToggleComplete,
  task,
}: Props) {
  const gesture = useRef<ScheduleTaskGestureState>({ long: false, moved: false, cancelled: false, dragged: false, x: 0, y: 0 });
  const quadrant = getQuadrantConfig(task.quadrant);
  const category = getCategoryConfig(task.category);
  const owner = task.occurrence ? scheduleOwnerAppearance(task.occurrence.owner) : undefined;
  const ownActivity = task.occurrence?.owner === 'I';
  const completedDate = task.completedAt ? new Date(task.completedAt) : null;
  const completedDateKey = completedDate
    ? `${completedDate.getFullYear()}-${String(completedDate.getMonth() + 1).padStart(2, '0')}-${String(completedDate.getDate()).padStart(2, '0')}`
    : undefined;
  const completedEarly = !!completedDateKey && completedDateKey < task.dateKey;

  return (
    <Pressable
      {...scheduleTaskGesture(gesture.current, onPress, onDragStart ? (x, y) => onDragStart(task, x, y) : undefined)}
      style={[styles.card, compact ? styles.cardCompact : null, task.completed ? styles.cardDone : null, dragging ? styles.cardDragging : null]}
    >
      <View style={[styles.stripe, { backgroundColor: owner?.color ?? quadrant.textColor }]} />
      {onToggleComplete && !ownActivity ? (
        <Pressable
          accessibilityLabel={task.completed ? '取消完成' : '标记完成'}
          onTouchStart={(event) => { event.stopPropagation(); gesture.current.cancelled = true; }}
          onLongPress={(event) => { event.stopPropagation(); gesture.current.cancelled = true; }}
          onPress={(event) => { event.stopPropagation(); onToggleComplete(); }}
          style={[styles.check, task.completed ? styles.checkDone : null]}
        >
          <Text style={[styles.checkText, task.completed ? styles.checkTextDone : null]}>{task.completed ? '✓' : ''}</Text>
        </Pressable>
      ) : null}
      <View style={styles.copy}>
        <View style={styles.topRow}>
          <Text numberOfLines={compact ? 3 : 2} style={[styles.title, compact ? styles.titleCompact : null, task.completed ? styles.titleDone : null]}>{task.title}</Text>
          <Text style={[styles.kind, task.kind !== 'todo' ? styles.kindSchedule : null, owner ? { color: owner.color, backgroundColor: owner.background } : null]}>
            {owner?.label ?? (task.kind === 'template' ? '作息' : '待办')}
          </Text>
        </View>
        <Text numberOfLines={1} style={styles.meta}>
          {taskTimeLabel(task)} · {category.icon} {category.label} · {priorityLabels[task.priority]}{completedEarly ? ' · 已提前完成' : ''}
        </Text>
        {task.occurrence && task.occurrence.owner !== 'you' && task.occurrence.owner !== undefined ? (
          <Text style={[styles.execution, { color: owner?.color }]}>{task.executionLabel ?? scheduleExecutionLabel(task.occurrence)}</Text>
        ) : null}
      </View>
    </Pressable>
  );
});

const styles = StyleSheet.create({
  card: { alignItems: 'stretch', backgroundColor: 'rgba(255,255,255,0.9)', borderColor: 'rgba(255,255,255,0.95)', borderRadius: 14, borderWidth: 1, flexDirection: 'row', minHeight: 64, overflow: 'hidden' },
  cardCompact: { minHeight: 74 },
  cardDone: { opacity: 0.58 },
  cardDragging: { opacity: 0.28 },
  stripe: { width: 5 },
  check: { alignItems: 'center', borderColor: '#AAA5B6', borderRadius: 10, borderWidth: 1.5, height: 20, justifyContent: 'center', marginLeft: 10, marginTop: 12, width: 20 },
  checkDone: { backgroundColor: '#817AE4', borderColor: '#817AE4' }, checkText: { color: 'transparent', fontSize: 13, lineHeight: 16 }, checkTextDone: { color: '#FFFFFF' },
  copy: { flex: 1, gap: 5, paddingHorizontal: 11, paddingVertical: 9 },
  topRow: { alignItems: 'flex-start', flexDirection: 'row', gap: 8 },
  title: { color: colors.ink, flex: 1, fontSize: 15, fontWeight: '500', lineHeight: 21 },
  titleCompact: { fontSize: 13, lineHeight: 18 },
  titleDone: { color: '#9A96A5', textDecorationLine: 'line-through' },
  kind: { backgroundColor: '#EEF7FF', borderRadius: 10, color: '#557CA1', fontSize: 10, fontWeight: '500', overflow: 'hidden', paddingHorizontal: 7, paddingVertical: 2 },
  kindSchedule: { backgroundColor: '#F0EEFF', color: '#746BDD' },
  meta: { color: colors.muted, fontSize: 11, fontWeight: '400' },
  execution: { color: '#7D788A', fontSize: 11, fontWeight: '400', lineHeight: 15 },
  executionActive: { color: '#746BDD', fontWeight: '500' },
});
