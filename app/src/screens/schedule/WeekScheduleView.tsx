import { memo, useMemo, useRef, type ComponentProps } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { AppText as Text } from '../../components/AppText';
import type { TaskExecutionSession } from '../../schedule/taskExecutionStore';
import { dateFromKey, taskTimeLabel, weekKeysForDate, scheduleOwnerAppearance, scheduleExecutionLabel, scheduleTaskGesture, type ScheduleTaskGestureState } from '../../schedule/scheduleViewUtils';
import type { ScheduleViewTask } from '../../schedule/scheduleViewTypes';
import { ScheduleViewTaskCard } from './ScheduleViewTaskCard';
import { styles } from './ScheduleScreen.styles';

const weekDayLabels = ['一', '二', '三', '四', '五', '六', '日'];

function WeekTaskPressable({ onOpen, ...props }: ComponentProps<typeof Pressable> & { onOpen: () => void }) {
  const gesture = useRef<ScheduleTaskGestureState>({ long: false, moved: false, cancelled: false, dragged: false, x: 0, y: 0 });
  return <Pressable {...props} {...scheduleTaskGesture(gesture.current, onOpen)} />;
}

function WeekScheduleViewComponent({
  onNextWeek,
  onOpenTask,
  onPrevWeek,
  onSelectDate,
  selectedDate,
  tasks,
}: {
  onNextWeek: () => void;
  onOpenTask: (task: ScheduleViewTask) => void;
  onPrevWeek: () => void;
  onSelectDate: (date: string) => void;
  selectedDate: string;
  tasks: ScheduleViewTask[];
}) {
  const days = useMemo(() => weekKeysForDate(selectedDate), [selectedDate]);
  const byDay = useMemo(() => {
    const grouped = new Map<string, ScheduleViewTask[]>();
    days.forEach((day) => grouped.set(day, []));
    tasks.forEach((task) => grouped.get(task.dateKey)?.push(task));
    return grouped;
  }, [days, tasks]);
  const weekStart = days[0].slice(5);
  const weekEnd = days[6].slice(5);

  return (
    <View style={styles.scheduleViewRoot}>
      <View style={styles.weekNav}>
        <Pressable onPress={onPrevWeek} style={styles.weekNavButton}><Text style={styles.weekNavText}>‹</Text></Pressable>
        <Text style={styles.weekTitle}>{weekStart} - {weekEnd}</Text>
        <Pressable onPress={onNextWeek} style={styles.weekNavButton}><Text style={styles.weekNavText}>›</Text></Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={styles.weekGrid}>
          <View style={styles.weekHeaderRow}>
            <View style={styles.weekTimeColumn} />
            {days.map((day) => {
              const date = dateFromKey(day);
              const active = day === selectedDate;
              return (
                <Pressable key={day} onPress={() => onSelectDate(day)} style={[styles.weekDayHeader, active ? styles.weekDayHeaderActive : null]}>
                  <Text style={[styles.weekDayText, active ? styles.weekDayTextActive : null]}>{weekDayLabels[(date.getDay() + 6) % 7]}</Text>
                  <Text style={[styles.weekDateText, active ? styles.weekDayTextActive : null]}>{date.getDate()}</Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.weekTodoRow}>
            <View style={styles.weekTimeColumn}><Text style={styles.weekTodoLabel}>待办</Text></View>
            {days.map((day) => {
              const todoTasks = (byDay.get(day) ?? []).filter((task) => !task.startAt);
              return (
                <View key={day} style={styles.weekTodoCell}>
                  {todoTasks.slice(0, 3).map((task) => (
                    <WeekTaskPressable key={task.id} onOpen={() => onOpenTask(task)} style={styles.weekTodoChip}>
                      <Text numberOfLines={1} style={styles.weekTodoChipText}>{task.title}</Text>
                    </WeekTaskPressable>
                  ))}
                  {todoTasks.length > 3 ? <Text style={styles.weekMoreText}>+{todoTasks.length - 3}</Text> : null}
                </View>
              );
            })}
          </View>
          <ScrollView showsVerticalScrollIndicator={false} style={styles.weekTimeline}>
            {Array.from({ length: 24 }, (_, hour) => (
              <View key={hour} style={styles.weekHourRow}>
                <View style={styles.weekTimeColumn}>
                  <Text style={styles.weekHourText}>{String(hour).padStart(2, '0')}:00</Text>
                </View>
                {days.map((day) => {
                  const hourTasks = (byDay.get(day) ?? []).filter((task) => task.startAt && new Date(task.startAt).getHours() === hour);
                  return (
                    <View key={`${day}-${hour}`} style={styles.weekHourCell}>
                      {hourTasks.map((task) => (
                        <WeekTaskPressable key={task.id} onOpen={() => onOpenTask(task)} style={[styles.weekScheduleBlock,
                          task.occurrence ? { backgroundColor: scheduleOwnerAppearance(task.occurrence.owner).background,
                            borderLeftColor: scheduleOwnerAppearance(task.occurrence.owner).color, borderLeftWidth: 3 } : null]}>
                          {task.occurrence ? <Text style={[styles.weekScheduleTime, { color: scheduleOwnerAppearance(task.occurrence.owner).color }]}>{scheduleOwnerAppearance(task.occurrence.owner).label}</Text> : null}
                          <Text numberOfLines={1} style={styles.weekScheduleTime}>{taskTimeLabel(task)}</Text>
                          <Text numberOfLines={2} style={styles.weekScheduleTitle}>{task.title}</Text>
                          {task.occurrence?.owner === 'I' ? <Text style={styles.weekScheduleTime}>{task.executionLabel ?? scheduleExecutionLabel(task.occurrence)}</Text> : null}
                        </WeekTaskPressable>
                      ))}
                    </View>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </View>
      </ScrollView>
    </View>
  );
}

export const WeekScheduleView = memo(WeekScheduleViewComponent);
