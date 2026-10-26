import { memo, useMemo } from 'react';
import { Pressable, View } from 'react-native';
import { Calendar, type DateData } from 'react-native-calendars';
import { AppText as Text } from '../../components/AppText';
import { dateFromKey, monthKeysForDate, scheduleOwnerAppearance } from '../../schedule/scheduleViewUtils';
import type { ScheduleViewTask } from '../../schedule/scheduleViewTypes';
import type { TodoItem } from '../../schedule/todoStore';
import { colors } from '../../theme/colors';
import { styles } from './ScheduleScreen.styles';

function MonthScheduleViewComponent({
  markedDates,
  monthOccurrenceKeys,
  onChangeMonth,
  onOpenDay,
  selectedDate,
  todos,
}: {
  markedDates: Record<string, object>;
  monthOccurrenceKeys: string[];
  onChangeMonth: (amount: number) => void;
  onOpenDay: (date: string) => void;
  selectedDate: string;
  todos: TodoItem[];
}) {
  const todoCounts = useMemo(() => {
    const counts = new Map<string, number>();
    todos.forEach((todo) => {
      if (!todo.plannedForDate) return;
      counts.set(todo.plannedForDate, (counts.get(todo.plannedForDate) ?? 0) + 1);
    });
    return counts;
  }, [todos]);
  const titleDate = dateFromKey(selectedDate);
  const todoTotal = Array.from(todoCounts.values()).reduce((sum, count) => sum + count, 0);

  return (
    <View style={styles.scheduleViewRoot}>
      <View style={styles.weekNav}>
        <Pressable onPress={() => onChangeMonth(-1)} style={styles.weekNavButton}><Text style={styles.weekNavText}>‹</Text></Pressable>
        <Text style={styles.weekTitle}>{titleDate.getFullYear()}年 {titleDate.getMonth() + 1}月</Text>
        <Pressable onPress={() => onChangeMonth(1)} style={styles.weekNavButton}><Text style={styles.weekNavText}>›</Text></Pressable>
      </View>
      <Calendar
        markingType="multi-dot"
        current={selectedDate}
        markedDates={markedDates}
        onDayPress={(day: DateData) => onOpenDay(day.dateString)}
        onMonthChange={(month: DateData) => {
          const nextMonthKey = `${month.year}-${String(month.month).padStart(2, '0')}-01`;
          const currentMonth = dateFromKey(selectedDate);
          const nextMonth = dateFromKey(nextMonthKey);
          const delta = (nextMonth.getFullYear() - currentMonth.getFullYear()) * 12 + nextMonth.getMonth() - currentMonth.getMonth();
          if (delta) onChangeMonth(delta);
        }}
        theme={{
          calendarBackground: '#FFFFFF',
          selectedDayBackgroundColor: colors.primary,
          todayTextColor: colors.primary,
          arrowColor: colors.primary,
          monthTextColor: colors.ink,
          textDayFontWeight: '400',
          textMonthFontWeight: '600',
        }}
        style={styles.monthCalendar}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 14, paddingHorizontal: 12, paddingVertical: 8 }}>
        {(['you', 'I', 'I 和 you'] as const).map(owner => (
          <Text key={owner} style={{ color: scheduleOwnerAppearance(owner).color, fontSize: 12 }}>● {scheduleOwnerAppearance(owner).label}</Text>
        ))}
      </View>
      <View style={styles.monthSummaryRow}>
        <View style={styles.monthSummaryCard}>
          <Text style={styles.monthSummaryNumber}>{todoTotal}</Text>
          <Text style={styles.monthSummaryLabel}>待办</Text>
        </View>
        <View style={styles.monthSummaryCard}>
          <Text style={styles.monthSummaryNumber}>{monthOccurrenceKeys.length}</Text>
          <Text style={styles.monthSummaryLabel}>有日程日期</Text>
        </View>
      </View>
    </View>
  );
}

export const MonthScheduleView = memo(MonthScheduleViewComponent);
