import type { DailyReadingProgress, ReadingChapter, ReadingSegmentMeta } from './readingTypes';

export const READING_INTERVAL_MS = 25 * 60_000;
export type ReadingFocusClock = { sessionId: string; effectiveWorkMs: number; paused: boolean; ended: boolean; remainingWorkMs?: number | null };

export function createReadingProgress(now: number, chapterIndex = 0, segmentIndex = 0): DailyReadingProgress {
  return { version: 1, confirmedAt: now, start: { chapterIndex, segmentIndex }, cursor: { chapterIndex, segmentIndex },
    remainderMs: 0, updatedAt: now, events: [] };
}

export function settleReadingClock(input: DailyReadingProgress, now: number, focus?: ReadingFocusClock) {
  const state: DailyReadingProgress = { ...input, activity: input.activity ? { ...input.activity } : undefined };
  const activity = state.activity;
  const hasNewFocusWork = !!activity && !!focus && focus.sessionId === activity.focusId && focus.effectiveWorkMs > (activity.focusWorkMs ?? 0);
  const focusEnded = !!activity && !!focus?.ended && focus.sessionId === activity.focusId;
  if (!activity || (now <= activity.checkpointAt && !hasNewFocusWork && !focusEnded) || activity.status === 'ended') return { state, overflowMs: 0 };
  let elapsed = 0;
  if (activity.status === 'reading') {
    if (activity.focusId) {
      if (focus?.sessionId === activity.focusId) elapsed = Math.max(0, focus.effectiveWorkMs - (activity.focusWorkMs ?? 0));
    } else elapsed = now - activity.checkpointAt;
  }
  if (focus && focus.sessionId === activity.focusId) activity.focusWorkMs = Math.max(activity.focusWorkMs ?? 0, focus.effectiveWorkMs);
  const used = Math.min(elapsed, activity.remainingMs ?? elapsed);
  activity.elapsedMs = (activity.elapsedMs ?? 0) + used;
  const total = state.remainderMs + used;
  if (total >= READING_INTERVAL_MS) state.opportunityAt = now - Math.max(0, elapsed - used) - (total % READING_INTERVAL_MS);
  state.remainderMs = total % READING_INTERVAL_MS;
  if (activity.remainingMs !== null) activity.remainingMs = Math.max(0, activity.remainingMs - used);
  activity.checkpointAt = now;
  activity.updatedAt = now;
  state.updatedAt = now;
  if (activity.remainingMs === 0 || (focus?.ended && activity.jointOnly && activity.focusId === focus.sessionId)) {
    activity.status = 'ended';
    activity.endReason = activity.remainingMs === 0 ? 'duration' : 'focus';
    activity.endedAt = now - Math.max(0, elapsed - used);
    state.events = [...state.events, { id: `${activity.id}:end`, at: now - Math.max(0, elapsed - used), change: '本次活动结束' as const }].slice(-8);
  } else if (focus?.ended && activity.focusId === focus.sessionId) {
    delete activity.focusId;
    delete activity.focusWorkMs;
  }
  return { state, overflowMs: Math.max(0, elapsed - used) };
}

/** Version selected source only. Descriptions, other segments and growing results are not source changes. */
export function readingSegmentSourceVersion(chapter: ReadingChapter, segment: ReadingSegmentMeta) {
  const range = segment.contentRange;
  const selected = range && chapter.contentBlocks ? chapter.contentBlocks.slice(range.startBlock, range.endBlock + 1)
    .map((block, index) => {
      const start = index === 0 ? range.startOffset : 0;
      const end = range.startBlock + index === range.endBlock ? range.endOffset : undefined;
      if (end === 0) return null;
      if (block.kind === 'text') return [block.paragraphIndex,
        chapter.paragraphs[block.paragraphIndex]?.slice(block.startOffset, block.endOffset).slice(start, end)];
      const image = chapter.images?.find(item => item.id === block.imageId);
      return [block.imageId, image?.contentVersion ?? null];
    }) : undefined;
  const text = JSON.stringify([chapter.bookId, chapter.index, segment.segmentIndex, segment.startP, segment.endP,
    ...(selected ? [range, selected] : [chapter.paragraphs.slice(segment.startP, segment.endP + 1)])]);
  let a = 2166136261;
  let b = 5381;
  for (let i = 0; i < text.length; i += 1) { a = Math.imul(a ^ text.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ text.charCodeAt(i); }
  return `${text.length}:${(a >>> 0).toString(16)}:${(b >>> 0).toString(16)}`;
}

export function formatReadingPosition(chapterIndex: number, segmentIndex: number) {
  return `第 ${chapterIndex + 1} 章·第 ${segmentIndex + 1} 段`;
}

export function formatReadingTime(at: number) {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  const offset = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${offset >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}
