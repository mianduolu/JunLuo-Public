import type { ShiyingSummaryAnyV3, ShiyingSummaryImageCoverageV1 } from './shiyingSummaryContract';
import { listShiyingClosedPeriods, SHIYING_PERIOD_REVIEW_FLOOR } from './shiyingPeriodReview';
import { getShiyingReviewWeek } from './shiyingReviewPolicy';
import { splitShiyingReviewTitle } from './shiyingReviewPresentation';

export const SHIYING_REVIEW_KIND_LABELS = { week: '周回顾', month: '月回顾', year: '年回顾' } as const;
export function getShiyingReviewArticle(summary: ShiyingSummaryAnyV3) {
  return summary.payloadVersion === 3 ? { title: summary.title, body: summary.factSummary } : splitShiyingReviewTitle(summary.factSummary);
}
export function canDisplayShiyingReview(summary: ShiyingSummaryAnyV3, hasAvailableSource: boolean) {
  return hasAvailableSource || summary.payloadVersion === 3 && summary.editedAt !== null;
}
export function getShiyingReviewPeriodChoices(kind: 'week' | 'month' | 'year', now = Date.now()) {
  if (kind !== 'week') return listShiyingClosedPeriods(kind, now);
  const latest = getShiyingReviewWeek(now); const result: Array<{ start: string; end: string }> = []; let cursor = latest;
  while (cursor.end >= SHIYING_PERIOD_REVIEW_FLOOR) {
    result.push(cursor); cursor = getShiyingReviewWeek(new Date(`${cursor.start}T05:00:00`).getTime());
  }
  return result;
}
export function getShiyingReviewImageGaps(coverage: ShiyingSummaryImageCoverageV1) {
  return coverage.records.filter(value => value.state !== 'ready').map(value => ({
    recordId: value.recordId, date: value.recordDate,
    state: value.state === 'unfinished' ? '图片尚未读完' : value.state === 'skipped' ? '图片暂时跳过' : '图片记录待核对',
    completed: value.units.filter(unit => unit.completed).length, total: value.units.length,
    imageNumbers: value.images.filter(image => !value.units.length || value.units.some(unit => !unit.completed && unit.imageIds.includes(image.id)))
      .map(image => image.ordinal + 1),
    captionRanges: [...new Map(value.units.filter(unit => !unit.completed)
      .map(unit => [`${unit.captionStart}:${unit.captionEnd}`, { start: unit.captionStart, end: unit.captionEnd }])).values()],
  }));
}
