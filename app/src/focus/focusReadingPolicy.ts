import type { ActiveFocusSession } from './focusStore';

type FocusClock = Pick<ActiveFocusSession, 'timerMode' | 'startedAt' | 'totalPausedMs' | 'paused' | 'elapsedSeconds'
  | 'targetSeconds' | 'pomodoroWorkSeconds' | 'pomodoroShortBreakSeconds' | 'pomodoroLongBreakSeconds' | 'pomodoroGoal'>;

/** The existing focus clock includes breaks; reading only owns actual work intervals. */
export function projectFocusReadingClock(session: FocusClock, now = Date.now()) {
  const elapsedMs = Math.max(0, session.paused ? session.elapsedSeconds * 1000
    : now - session.startedAt - session.totalPausedMs);
  if (session.timerMode !== 'pomodoro') {
    const durationMs = session.timerMode === 'countdown' ? Math.max(0, session.targetSeconds ?? 0) * 1000 : null;
    return { effectiveWorkMs: durationMs === null ? elapsedMs : Math.min(durationMs, elapsedMs),
      totalWorkMs: durationMs, inBreak: false, completed: durationMs !== null && elapsedMs >= durationMs };
  }
  const workMs = Math.max(1, session.pomodoroWorkSeconds ?? 1500) * 1000;
  const shortMs = Math.max(0, session.pomodoroShortBreakSeconds ?? 300) * 1000;
  const longMs = Math.max(0, session.pomodoroLongBreakSeconds ?? 900) * 1000;
  const goal = Math.max(1, Math.floor(session.pomodoroGoal ?? 4));
  const blockMs = workMs * 4 + shortMs * 3 + longMs;
  // Skip whole groups instead of looping once per minute/session across a long suspension.
  const blocks = Math.min(Math.floor(elapsedMs / blockMs), Math.floor((goal - 1) / 4));
  let remainingMs = elapsedMs - blocks * blockMs;
  let effectiveWorkMs = blocks * workMs * 4;
  let round = blocks * 4;
  while (round < goal) {
    effectiveWorkMs += Math.min(remainingMs, workMs);
    if (remainingMs < workMs) return { effectiveWorkMs, totalWorkMs: goal * workMs, inBreak: false, completed: false };
    remainingMs -= workMs;
    round += 1;
    if (round >= goal) return { effectiveWorkMs, totalWorkMs: goal * workMs, inBreak: false, completed: true };
    const breakMs = round % 4 === 0 ? longMs : shortMs;
    if (remainingMs < breakMs) return { effectiveWorkMs, totalWorkMs: goal * workMs, inBreak: true, completed: false };
    remainingMs -= breakMs;
  }
  return { effectiveWorkMs, totalWorkMs: goal * workMs, inBreak: false, completed: true };
}

export function focusReadingSwitchLabel(activity: string) {
  return `白云小姐现在要${activity}啦。`;
}

/** End only the saved reading binding; the shared focus timer still belongs to you. */
export function finishFocusReadingBinding(session: ActiveFocusSession, activityId: string, at: number, showEnd: boolean): ActiveFocusSession {
  const binding = session.reading;
  if (!binding || binding.endedAt !== undefined
    || (binding.transition ? binding.transition.readingActivityId : binding.sourceActivityId) !== activityId) return session;
  const logId = `${activityId}:focus-reading-ended`;
  const clock = projectFocusReadingClock(session, at);
  return { ...session, baiyunActivity: '', reading: { ...binding, endedAt: at, choice: undefined },
    logs: showEnd && !clock.completed && !session.logs.some(log => log.id === logId)
      ? [...session.logs, { id: logId, role: 'system', content: '白云小姐结束了自己的活动，待在一旁看看你。',
        createdAt: at, elapsedSeconds: Math.floor(clock.effectiveWorkMs / 1000), trigger: 'activity-end-reading' }]
      : session.logs };
}

/** Translate an effective-work target onto the existing timer; no new timer is started. */
export function focusReadingWorkTargetAt(session: FocusClock, targetWorkMs: number): number | null {
  if (session.paused || !Number.isFinite(targetWorkMs) || targetWorkMs < 0) return null;
  const total = projectFocusReadingClock(session, session.startedAt).totalWorkMs;
  if (total !== null && targetWorkMs > total) return null;
  let wallMs = targetWorkMs;
  if (session.timerMode === 'pomodoro' && targetWorkMs > 0) {
    const workMs = Math.max(1, session.pomodoroWorkSeconds ?? 1500) * 1000;
    const roundsBefore = Math.max(0, Math.ceil(targetWorkMs / workMs) - 1);
    const longBreaks = Math.floor(roundsBefore / 4);
    wallMs += (roundsBefore - longBreaks) * Math.max(0, session.pomodoroShortBreakSeconds ?? 300) * 1000
      + longBreaks * Math.max(0, session.pomodoroLongBreakSeconds ?? 900) * 1000;
  }
  const at = session.startedAt + session.totalPausedMs + wallMs;
  return Number.isFinite(at) ? at : null;
}
