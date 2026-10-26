export type DayReviewMetrics = {
  plannedCount: number;
  plannedCompletedCount: number;
  actualCompletedCount: number;
  schedulePlannedCount: number;
  scheduleCompletedCount: number;
  templatePlannedCount: number;
  templateCompletedCount: number;
  habitsDone: number;
  habitsTotal: number;
  goalsProgressed: number;
  completedPlannedMinutes: number;
};

export type DayReviewComparison = {
  plannedCompletedDelta: number;
  actualCompletedDelta: number;
  habitRateDelta: number;
};

export type WeekReviewMetrics = {
  plannedCount: number;
  plannedCompletedCount: number;
  actualCompletedCount: number;
  habitDone: number;
  habitTotal: number;
  goalsProgressed: number;
  goalsStalled: number;
  completedPlannedMinutes: number;
};

export type WeekReviewComparison = {
  completionRateDelta: number;
  actualCompletedDelta: number;
  habitRateDelta: number;
  goalsProgressedDelta: number;
};

function rate(done: number, total: number) {
  return total > 0 ? done / total : 0;
}

export function compareDayReviewMetrics(current: DayReviewMetrics, previous?: DayReviewMetrics): DayReviewComparison | undefined {
  if (!previous) return undefined;
  return {
    plannedCompletedDelta: current.plannedCompletedCount - previous.plannedCompletedCount,
    actualCompletedDelta: current.actualCompletedCount - previous.actualCompletedCount,
    habitRateDelta: rate(current.habitsDone, current.habitsTotal) - rate(previous.habitsDone, previous.habitsTotal),
  };
}

export function compareWeekReviewMetrics(current: WeekReviewMetrics, previous?: WeekReviewMetrics): WeekReviewComparison | undefined {
  if (!previous) return undefined;
  return {
    completionRateDelta: rate(current.plannedCompletedCount, current.plannedCount) - rate(previous.plannedCompletedCount, previous.plannedCount),
    actualCompletedDelta: current.actualCompletedCount - previous.actualCompletedCount,
    habitRateDelta: rate(current.habitDone, current.habitTotal) - rate(previous.habitDone, previous.habitTotal),
    goalsProgressedDelta: current.goalsProgressed - previous.goalsProgressed,
  };
}
