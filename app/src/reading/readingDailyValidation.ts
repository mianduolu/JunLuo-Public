import type { DailyReadingProgress, ReadingSegmentRequest } from './readingTypes';

const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const position = (value: unknown) => !!value && typeof value === 'object'
  && Number.isSafeInteger((value as { chapterIndex: number }).chapterIndex) && (value as { chapterIndex: number }).chapterIndex >= 0
  && Number.isSafeInteger((value as { segmentIndex: number }).segmentIndex) && (value as { segmentIndex: number }).segmentIndex >= 0;

export function normalizeDailyReadingProgress(value: unknown): DailyReadingProgress | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as DailyReadingProgress;
  if (v.version !== 1 || !number(v.confirmedAt) || !number(v.updatedAt) || !position(v.start) || !position(v.cursor)
    || !number(v.remainderMs) || v.remainderMs >= 25 * 60_000) return undefined;
  if (v.needsSourceConfirmation !== undefined && typeof v.needsSourceConfirmation !== 'boolean') return undefined;
  const a = v.activity;
  if (a && (typeof a.id !== 'string' || !a.id || !['preparing', 'reading', 'paused', 'ended'].includes(a.status)
    || (a.memoryIngestionVersion !== undefined && a.memoryIngestionVersion !== 1)
    || (a.plannedMs !== null && !number(a.plannedMs)) || (a.remainingMs !== null && !number(a.remainingMs))
    || !number(a.startedAt) || !number(a.checkpointAt) || !number(a.updatedAt) || typeof a.operationId !== 'string'
    || (a.focusWorkMs !== undefined && !number(a.focusWorkMs)) || (a.focusId !== undefined && typeof a.focusId !== 'string')
    || [a.elapsedMs, a.completedUnitCount, a.endedAt].some(value => value !== undefined && !number(value))
    || (a.deferredOpportunity !== undefined && (!a.deferredOpportunity || typeof a.deferredOpportunity !== 'object'
      || Object.keys(a.deferredOpportunity).some(key => key !== 'at' && key !== 'retryAt')
      || !Number.isSafeInteger(a.deferredOpportunity.at) || a.deferredOpportunity.at < 0
      || !Number.isSafeInteger(a.deferredOpportunity.retryAt) || a.deferredOpportunity.retryAt <= a.deferredOpportunity.at))
    || (a.schedule && (typeof a.schedule.itemId !== 'string' || !a.schedule.itemId || !number(a.schedule.sourceUpdatedAt)
      || !number(a.schedule.windowEndAt) || !number(a.schedule.plannedMs)
      || [a.schedule.planRevision, a.schedule.totalPlannedMs, a.schedule.baseElapsedMs, a.schedule.baseCompletedUnitCount, a.schedule.choiceVersion]
        .some(value => value !== undefined && !number(value))
      || [a.schedule.occurrenceId, a.schedule.completionId, a.schedule.choiceSourceId, a.schedule.previousActivityId].some(value => value !== undefined && (typeof value !== 'string' || !value))
      || (a.schedule.habitId !== undefined && typeof a.schedule.habitId !== 'string'))))) return undefined;
  const changes = ['开始', '继续', '暂停', '本次活动结束', '已完成全书阅读', '已读完本期文字稿。'];
  return {
    version: 1, confirmedAt: v.confirmedAt, start: { ...v.start }, cursor: { ...v.cursor }, remainderMs: v.remainderMs,
    ...(number(v.opportunityAt) ? { opportunityAt: v.opportunityAt } : {}),
    ...(v.requestReservation && typeof v.requestReservation.id === 'string' && number(v.requestReservation.opportunityAt)
      ? { requestReservation: { id: v.requestReservation.id, opportunityAt: v.requestReservation.opportunityAt,
          ...(typeof v.requestReservation.activityId === 'string' ? { activityId: v.requestReservation.activityId } : {}) } } : {}),
    ...(v.reachedEnd ? { reachedEnd: true } : {}), ...(v.completedAll ? { completedAll: true } : {}),
    ...(v.needsSourceConfirmation !== undefined ? { needsSourceConfirmation: v.needsSourceConfirmation } : {}),
    ...(a ? { activity: { ...a } } : {}), updatedAt: v.updatedAt,
    events: Array.isArray(v.events) ? v.events.filter(e => e && typeof e.id === 'string' && number(e.at) && changes.includes(e.change)).slice(-8).map(e => ({ id: e.id, at: e.at, change: e.change })) : [],
  };
}

export function normalizeReadingSegmentRequest(value: unknown): ReadingSegmentRequest | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as ReadingSegmentRequest;
  if (typeof v.id !== 'string' || typeof v.runtimeId !== 'string' || typeof v.sourceVersion !== 'string'
    || !number(v.startedAt) || !['manual', 'daily'].includes(v.kind)) return undefined;
  if (v.resultActivityId !== undefined && v.resultActivityId !== null && (typeof v.resultActivityId !== 'string' || !v.resultActivityId)) return undefined;
  if (v.memoryIngestionVersion !== undefined && (v.memoryIngestionVersion !== 1 || !v.resultActivityId)) return undefined;
  if (v.result && (!number(v.result.savedAt) || typeof v.result.summary !== 'string' || !Array.isArray(v.result.annotations)
    || !v.result.annotations.every(a => a && Number.isInteger(a.p) && a.p >= 0 && typeof a.text === 'string'))) return undefined;
  if (v.save && (!Number.isInteger(v.save.attempts) || v.save.attempts < 0 || v.save.attempts > 4
    || !['result', 'annotations', 'done'].includes(v.save.phase)
    || !['pending', 'unknown', 'exhausted', 'complete'].includes(v.save.outcome)
    || typeof v.save.resultRetained !== 'boolean')) return undefined;
  return { id: v.id, runtimeId: v.runtimeId, sourceVersion: v.sourceVersion, startedAt: v.startedAt, kind: v.kind,
    ...(v.save ? { save: { ...v.save } } : {}),
    ...(v.resultActivityId !== undefined ? { resultActivityId: v.resultActivityId } : {}),
    ...(v.memoryIngestionVersion === 1 ? { memoryIngestionVersion: 1 as const } : {}),
    ...(number(v.transportStartedAt) ? { transportStartedAt: v.transportStartedAt } : {}),
    ...(v.result ? { result: { ...v.result, annotations: v.result.annotations.map(a => ({ p: a.p, text: a.text })) } } : {}) };
}
