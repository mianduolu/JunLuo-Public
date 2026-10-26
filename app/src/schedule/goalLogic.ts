export type GoalFacts = { number?: number; unit?: string; estimatedHours?: number };

export function determineGoalType(goal: GoalFacts): 'countdown' | 'time_based' | 'direction' {
  if (goal.number && goal.number > 0 && goal.unit?.trim()) return 'countdown';
  if (goal.estimatedHours && goal.estimatedHours > 0) return 'time_based';
  return 'direction';
}
