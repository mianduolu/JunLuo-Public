export type ChatScheduleRepeat = { frequency: 'daily' | 'weekly' | 'interval'; weekDays?: number[]; intervalDays?: number };
export type DayPlanEntry = {
  id: string;
  action: 'schedule' | 'inbox' | 'cancel';
  title: string;
  notes: string;
  occurrenceId?: string;
  todoId?: string;
  startAt?: number;
  endAt?: number;
  durationMinutes?: number;
  endMode?: 'duration' | 'fixed';
  startReminderEnabled?: boolean;
  habitId?: string | null;
  repeat?: ChatScheduleRepeat;
  scope?: 'once' | 'future';
  targetHabitId?: string;
  sourceHabitUpdatedAt?: number;
  parentTodoId?: string;
  parentOccurrenceId?: string;
  stepOrder?: number;
  savedOccurrenceId?: string;
  steps?: Array<Partial<DayPlanEntry>>;
  startSuggested: boolean;
  endSuggested: boolean;
  reminderMinutesBefore: number;
  companionEnabled: boolean;
  sourceUpdatedAt?: number;
  sourceTodoUpdatedAt?: number;
  targetScheduleId: string;
  targetTodoId: string;
  saved?: boolean;
  scheduleSaved?: boolean;
  /** Actual habit-store receipt; not a model-filled field or a calendar success claim. */
  habitSaved?: boolean;
  error?: string;
};

export type DayPlan = {
  entries: DayPlanEntry[];
};

export type DayPlanChange = Partial<Pick<DayPlanEntry,
  'title' | 'notes' | 'startAt' | 'endAt' | 'durationMinutes' | 'endMode' | 'repeat' | 'scope' | 'startReminderEnabled' | 'reminderMinutesBefore' | 'companionEnabled'
>>;
