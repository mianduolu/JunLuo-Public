import type { ScheduleOccurrence } from '../schedule/scheduleStore';
import type { TodoItem } from '../schedule/todoStore';
import type { WeatherState } from '../types/weather';

function localDateKey(timestamp: number) {
  const date = new Date(timestamp);
  return [
    date.getFullYear(),
    `${date.getMonth() + 1}`.padStart(2, '0'),
    `${date.getDate()}`.padStart(2, '0'),
  ].join('-');
}

function getDayPeriod(timestamp: number) {
  const hour = new Date(timestamp).getHours();
  if (hour < 5) return 'late-night';
  if (hour < 7) return 'early-morning';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'noon';
  if (hour < 18) return 'afternoon';
  if (hour < 23) return 'evening';
  return 'late-night';
}

function temperatureBand(temperature: number | undefined) {
  return typeof temperature === 'number' && Number.isFinite(temperature)
    ? Math.round(temperature / 5) * 5
    : null;
}

export function buildAmbientLifeMaterialFingerprint(input: {
  now: number;
  openTodos: TodoItem[];
  todaySchedule: ScheduleOccurrence[];
  todayTodos: TodoItem[];
  weather?: WeatherState;
}) {
  const schedule = input.todaySchedule
    .map((item) => ({
      endAt: item.endAt ?? null,
      id: item.id,
      notes: item.notes,
      scheduledStartAt: item.scheduledStartAt,
      status: item.status,
      title: item.title,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const todos = [...input.todayTodos, ...input.openTodos]
    .map((item) => ({
      dueDate: item.dueDate ?? null,
      id: item.id,
      plannedForDate: item.plannedForDate ?? null,
      status: item.status,
      title: item.title,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({
    date: localDateKey(input.now),
    period: getDayPeriod(input.now),
    schedule,
    todos,
    weather: input.weather
      ? {
          kind: input.weather.kind,
          place: input.weather.placeLabel ?? null,
          temperatureBand: temperatureBand(input.weather.temperature),
        }
      : null,
  });
}
