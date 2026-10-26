export type FocusTimeSpan = { start: number; end: number };

export type FocusTimingEvidence = {
  version: 1;
  runs: FocusTimeSpan[];
  openStartedAt?: number;
};

export type FocusTimingConfig = {
  timerMode: 'stopwatch' | 'countdown' | 'pomodoro';
  targetSeconds?: number;
  pomodoroWorkSeconds?: number;
  pomodoroShortBreakSeconds?: number;
  pomodoroLongBreakSeconds?: number;
  pomodoroGoal?: number;
};

function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.abs(value) <= 8.64e15;
}

/** Unknown evidence stays unknown; sorting or filling gaps would invent time. */
export function parseFocusTimeSpans(value: unknown): FocusTimeSpan[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const spans: FocusTimeSpan[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || !validTime(item.start) || !validTime(item.end)
      || item.end < item.start || (spans.length > 0 && item.start < spans[spans.length - 1].end)) {
      return undefined;
    }
    spans.push({ start: item.start, end: item.end });
  }
  return spans;
}

export function parseFocusTimingEvidence(value: unknown): FocusTimingEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<FocusTimingEvidence>;
  if (input.version !== 1) return undefined;
  const runs = parseFocusTimeSpans(input.runs);
  if (!runs || (input.openStartedAt !== undefined && (!validTime(input.openStartedAt)
    || (runs.length > 0 && input.openStartedAt < runs[runs.length - 1].end)))) return undefined;
  return { version: 1, runs, ...(input.openStartedAt === undefined ? {} : { openStartedAt: input.openStartedAt }) };
}

export function startFocusTiming(at: number): FocusTimingEvidence | undefined {
  return validTime(at) ? { version: 1, runs: [], openStartedAt: at } : undefined;
}

export function pauseFocusTiming(timing: FocusTimingEvidence | undefined, at: number): FocusTimingEvidence | undefined {
  if (!timing || !validTime(at) || !parseFocusTimingEvidence(timing)) return undefined;
  if (timing.runs.length > 0 && at < timing.runs[timing.runs.length - 1].end) return undefined;
  if (timing.openStartedAt === undefined) return timing;
  if (at < timing.openStartedAt) return undefined;
  return { version: 1, runs: at === timing.openStartedAt ? timing.runs
    : [...timing.runs, { start: timing.openStartedAt, end: at }] };
}

export function resumeFocusTiming(timing: FocusTimingEvidence | undefined, at: number): FocusTimingEvidence | undefined {
  if (!timing || !validTime(at) || !parseFocusTimingEvidence(timing)) return undefined;
  if (timing.openStartedAt !== undefined) return at < timing.openStartedAt ? undefined : timing;
  if (timing.runs.length > 0 && at < timing.runs[timing.runs.length - 1].end) return undefined;
  return { ...timing, openStartedAt: at };
}

/** Read the timer at a past real instant; later pauses never subtract from that instant. */
export function focusElapsedAt(timing: FocusTimingEvidence | undefined, at: number): number | undefined {
  const evidence = parseFocusTimingEvidence(timing);
  if (!evidence || !validTime(at)) return undefined;
  const closedMs = evidence.runs.reduce((total, run) => total + Math.max(0, Math.min(run.end, at) - run.start), 0);
  const openMs = evidence.openStartedAt === undefined ? 0 : Math.max(0, at - evidence.openStartedAt);
  return Math.floor((closedMs + openMs) / 1000);
}

/** Project the active-time axis back onto real dates, without polling or counting pauses. */
export function finishFocusTiming(
  timing: FocusTimingEvidence | undefined,
  endedAt: number,
  config: FocusTimingConfig,
): FocusTimeSpan[] | undefined {
  const closed = pauseFocusTiming(timing, endedAt);
  if (!closed) return undefined;
  if (config.timerMode === 'stopwatch') return closed.runs.filter(span => span.end > span.start);
  if (config.timerMode === 'countdown') {
    const limit = (config.targetSeconds ?? NaN) * 1000;
    if (!Number.isFinite(limit) || limit < 0) return undefined;
    let remaining = limit;
    const spans: FocusTimeSpan[] = [];
    for (const run of closed.runs) {
      const length = Math.min(run.end - run.start, remaining);
      if (length > 0) spans.push({ start: run.start, end: run.start + length });
      remaining -= length;
      if (remaining <= 0) break;
    }
    return spans;
  }
  if (config.timerMode !== 'pomodoro') return undefined;
  const workMs = (config.pomodoroWorkSeconds ?? 1500) * 1000;
  const shortMs = (config.pomodoroShortBreakSeconds ?? 300) * 1000;
  const longMs = (config.pomodoroLongBreakSeconds ?? 900) * 1000;
  const goal = config.pomodoroGoal ?? 4;
  if (![workMs, shortMs, longMs].every(Number.isFinite) || workMs <= 0 || shortMs < 0 || longMs < 0
    || !Number.isSafeInteger(goal) || goal < 1) return undefined;
  const blockMs = workMs * 4 + shortMs * 3 + longMs;
  const lastRound = goal - 1;
  const limit = Math.floor(lastRound / 4) * blockMs + (lastRound % 4) * (workMs + shortMs) + workMs;
  if (!Number.isFinite(blockMs) || !Number.isFinite(limit) || blockMs <= 0 || limit <= 0) return undefined;
  const spans: FocusTimeSpan[] = [];
  let offset = 0;
  for (const run of closed.runs) {
    const activeEnd = Math.min(limit, offset + (run.end - run.start));
    const block = Math.floor(offset / blockMs);
    const firstRound = block * 4 + Math.min(3, Math.floor((offset - block * blockMs) / (workMs + shortMs)));
    for (let round = firstRound; round < goal; round += 1) {
      const workStart = Math.floor(round / 4) * blockMs + (round % 4) * (workMs + shortMs);
      if (workStart >= activeEnd) break;
      const workEnd = workStart + workMs;
      if (workEnd <= workStart) return undefined;
      const start = Math.max(offset, workStart);
      const end = Math.min(activeEnd, workEnd);
      if (end > start) spans.push({ start: run.start + (start - offset), end: run.start + (end - offset) });
    }
    offset += run.end - run.start;
    if (offset >= limit) break;
  }
  return spans;
}

/** Local midnight, not a fixed 24-hour increment: DST days may be 23 or 25 hours. */
export function focusSpanDayParts(spans: FocusTimeSpan[]): Array<{ date: string; milliseconds: number }> | undefined {
  if (!parseFocusTimeSpans(spans)) return undefined;
  const totals = new Map<string, number>();
  for (const span of spans) {
    let cursor = span.start;
    while (cursor < span.end) {
      const date = new Date(cursor);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
      if (!Number.isFinite(midnight) || midnight <= cursor) return undefined;
      const end = Math.min(span.end, midnight);
      totals.set(key, (totals.get(key) ?? 0) + end - cursor);
      cursor = end;
    }
  }
  return Array.from(totals, ([date, milliseconds]) => ({ date, milliseconds }));
}
