import { loadCompletedScheduleEffortForDate } from './scheduleStore';
import { loadExecutionCutoverAt, loadExecutionSummaryForDate, type TaskExecutionSummary } from './taskExecutionStore';

export async function loadEffortSummaryForDate(day: string): Promise<TaskExecutionSummary> {
  const [legacy, cutoverAt] = await Promise.all([
    loadExecutionSummaryForDate(day),
    loadExecutionCutoverAt(),
  ]);
  const completedSchedules = await loadCompletedScheduleEffortForDate(day, cutoverAt ?? Number.MAX_SAFE_INTEGER);
  const minutesByTodoId = { ...legacy.minutesByTodoId };
  let totalMinutes = legacy.totalMinutes;
  completedSchedules.forEach((entry) => {
    const key = entry.todoId ?? `schedule:${entry.occurrenceId}`;
    minutesByTodoId[key] = (minutesByTodoId[key] ?? 0) + entry.minutes;
    totalMinutes += entry.minutes;
  });
  return { date: legacy.date, totalMinutes, minutesByTodoId };
}
