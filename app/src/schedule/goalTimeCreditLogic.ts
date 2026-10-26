type GoalType = 'countdown' | 'time_based' | 'direction';

export type GoalTimeCreditAction =
  | { kind: 'none' }
  | { kind: 'credit'; minutes: number }
  | { kind: 'request' };

export function normalizeGoalTimeCreditMinutes(value?: number | null) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const minutes = Math.round(value);
  return minutes > 0 ? minutes : null;
}

export function determineTodoTimeCreditAction(input: {
  goalType: GoalType;
  estimatedMinutes?: number;
  completedBySchedule?: boolean;
}): GoalTimeCreditAction {
  if (input.goalType !== 'time_based' || input.completedBySchedule) return { kind: 'none' };
  const minutes = normalizeGoalTimeCreditMinutes(input.estimatedMinutes);
  return minutes ? { kind: 'credit', minutes } : { kind: 'request' };
}
