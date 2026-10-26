export const SCHEDULE_DATA_CHANGED_EVENT = 'junluo:schedule-data-changed';

export type ScheduleDataChangedPayload = {
  dateKey?: string;
  reason?: 'schedule' | 'todo' | 'habit' | 'goal' | 'challenge';
};
