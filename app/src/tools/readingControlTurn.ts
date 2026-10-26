import { canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { controlReadingActivity, loadCurrentReadingActivity } from '../reading/readingDailyRuntime';
import { readSleepSchedule } from '../life/sleepPlanStore';
import { createToolError } from './toolErrors';
import { createToolErrorResult, createToolSuccessResult } from './toolResult';
import type { JunLuoToolCall } from './toolTypes';
import { Platform } from 'react-native';
import { loadActiveFocusSession } from '../focus/focusStore';
import { makeFocusSessionId } from '../focus/focusIdentity';
import { projectFocusReadingClock } from '../focus/focusReadingPolicy';
import type { ReadingFocusClock } from '../reading/readingDailyPolicy';
import { loadReadingLibraryStrict } from '../reading/readingStore';

export async function createReadingControlTurn(input: { dataEpoch: number; signal?: AbortSignal }) {
  if (Platform.OS !== 'android') return null;
  let expectedActivityId: string | null;
  try { expectedActivityId = (await loadCurrentReadingActivity())?.activityId ?? null; }
  catch { return null; }
  return async (call: JunLuoToolCall) => {
    if (input.signal?.aborted || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return createToolErrorResult(call,
      createToolError('STALE_DATA_EPOCH', 'reading-turn-stale'), '');
    const action = call.input.action;
    if (!['start', 'pause', 'resume', 'end'].includes(String(action))
      || (action !== 'start' && (call.input.bookId !== undefined || call.input.episodeId !== undefined || call.input.minutes !== undefined))
      || (action === 'start' && (typeof call.input.bookId === 'string') === (typeof call.input.episodeId === 'string'))) {
      return createToolErrorResult(call, createToolError('INVALID_ARGUMENTS', 'reading-arguments'), '阅读参数无效。');
    }
    let sleeping: boolean;
    let focus: ReadingFocusClock | undefined;
    const now = Date.now();
    try {
      const [sleep, session] = await Promise.all([readSleepSchedule(now), loadActiveFocusSession(true)]);
      sleeping = sleep?.actualPhase === 'sleeping';
      if (session) {
        const clock = projectFocusReadingClock(session, now);
        focus = { sessionId: makeFocusSessionId(session), effectiveWorkMs: clock.effectiveWorkMs,
          paused: session.paused || clock.inBreak, ended: clock.completed };
      }
    }
    catch { return createToolErrorResult(call, createToolError('EXECUTION_FAILED', 'reading-state-unavailable'), '阅读记录暂时无法读取。'); }
    const targetId = typeof call.input.episodeId === 'string' ? call.input.episodeId : typeof call.input.bookId === 'string' ? call.input.bookId : undefined;
    if (action === 'start') {
      const target = (await loadReadingLibraryStrict()).find(b => b.id === targetId);
      if (!target || !!target.programme !== (typeof call.input.episodeId === 'string')) return createToolErrorResult(call,
        createToolError('INVALID_ARGUMENTS', 'reading-target-not-found'), typeof call.input.episodeId === 'string' ? '未找到这期节目。' : '未找到这本书。');
    }
    const result = await controlReadingActivity({ action: action as 'start' | 'pause' | 'resume' | 'end',
      bookId: targetId,
      minutes: typeof call.input.minutes === 'number' ? call.input.minutes : undefined,
      operationId: call.callId, expectedActivityId, sleeping, focus, now });
    if (!result.ok || !result.activity) return createToolErrorResult(call,
      createToolError(result.reason === '阅读参数无效。' ? 'INVALID_ARGUMENTS' : 'EXECUTION_FAILED', 'reading-control-failed'),
      result.reason ?? '阅读安排的保存结果暂时无法确认。');
    const activity = result.activity;
    expectedActivityId = activity.status === 'ended' ? null : activity.activityId;
    if (activity.status === 'preparing') await (await import('../life/readingActivityRuntime')).runReadingActivityTick(Date.now(), false);
    // Reconcile only existing native tasks; starting an activity never requests a note.
    await (await import('../life/sleepPlanRuntime')).reconcileSleepPlanLocally().catch(() => undefined);
    const summary = activity.status === 'preparing' ? '字幕正在准备。' : action === 'start' ? '本次阅读已开始。' : action === 'pause' ? '本次阅读已暂停。'
      : action === 'resume' ? '本次阅读已继续。' : '本次阅读已结束。';
    return createToolSuccessResult(call, summary, { subject: 'I', ...(activity.contentType === 'programme' ? { episodeId: activity.bookId } : { bookId: activity.bookId }), title: activity.title,
      status: activity.status, remainingMinutes: activity.status === 'ended' ? 0 : activity.remainingMs === null ? null : activity.remainingMs / 60000 });
  };
}
