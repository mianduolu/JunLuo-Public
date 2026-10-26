import {
  assertShiyingLifeDate,
  parseShiyingMessageCursorV1,
  type ShiyingMessageCursorV1,
} from './shiyingContract';

export const SHIYING_LIFE_DAY_BOUNDARY_HOUR = 5;
export const SHIYING_LIVE_RECONCILIATION_LIFE_DAYS = 31;

export type ShiyingWindowBoundaryV1 = {
  lifeDateStart: string;
  lifeDateEnd: string;
  scanFloorAt: number;
  windowStartCursor: ShiyingMessageCursorV1 | null;
  historyGapBeforeLifeDate: string | null;
};

function windowError(code: string): never {
  throw new Error(`shiying_window_${code}`);
}

function assertTimestamp(value: number, code: string) {
  if (!Number.isSafeInteger(value) || value < 0) windowError(code);
}

function formatLocalDate(date: Date) {
  return [
    String(date.getFullYear()).padStart(4, '0'),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function lifeDateParts(lifeDate: string) {
  assertShiyingLifeDate(lifeDate, 'window_life_date_invalid');
  const [year, month, day] = lifeDate.split('-').map(Number);
  return { year, month, day };
}

function compareStableText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareShiyingMessageCursor(
  left: ShiyingMessageCursorV1,
  right: ShiyingMessageCursorV1,
) {
  if (left.messageCreatedAt !== right.messageCreatedAt) {
    return left.messageCreatedAt - right.messageCreatedAt;
  }
  const sessionOrder = compareStableText(left.sessionId, right.sessionId);
  return sessionOrder || compareStableText(left.messageId, right.messageId);
}

export function getShiyingLifeDate(timestamp: number) {
  assertTimestamp(timestamp, 'timestamp_invalid');
  const date = new Date(timestamp);
  if (date.getHours() < SHIYING_LIFE_DAY_BOUNDARY_HOUR) {
    date.setDate(date.getDate() - 1);
  }
  return formatLocalDate(date);
}

export function getShiyingLifeDateStartAt(lifeDate: string) {
  const { year, month, day } = lifeDateParts(lifeDate);
  const timestamp = new Date(
    year,
    month - 1,
    day,
    SHIYING_LIFE_DAY_BOUNDARY_HOUR,
    0,
    0,
    0,
  ).getTime();
  assertTimestamp(timestamp, 'life_date_start_invalid');
  if (getShiyingLifeDate(timestamp) !== lifeDate) windowError('life_date_start_mismatch');
  return timestamp;
}

export function addShiyingLifeDates(lifeDate: string, offset: number) {
  if (!Number.isSafeInteger(offset)) windowError('life_date_offset_invalid');
  const { year, month, day } = lifeDateParts(lifeDate);
  const date = new Date(year, month - 1, day + offset, 12, 0, 0, 0);
  return formatLocalDate(date);
}

export function getShiyingRecentLifeDateStart(triggeredAt: number) {
  const currentLifeDate = getShiyingLifeDate(triggeredAt);
  return addShiyingLifeDates(
    currentLifeDate,
    -(SHIYING_LIVE_RECONCILIATION_LIFE_DAYS - 1),
  );
}

export function deriveShiyingWindowBoundary(input: {
  triggeredAt: number;
  firstLiveLifeDate: string | null;
  latestLiveEndCursor: ShiyingMessageCursorV1 | null;
}): ShiyingWindowBoundaryV1 {
  assertTimestamp(input.triggeredAt, 'triggered_at_invalid');
  if ((input.firstLiveLifeDate === null) !== (input.latestLiveEndCursor === null)) {
    windowError('live_metadata_inconsistent');
  }

  const lifeDateEnd = getShiyingLifeDate(input.triggeredAt);
  if (input.firstLiveLifeDate === null || input.latestLiveEndCursor === null) {
    return {
      lifeDateStart: lifeDateEnd,
      lifeDateEnd,
      scanFloorAt: getShiyingLifeDateStartAt(lifeDateEnd),
      windowStartCursor: null,
      historyGapBeforeLifeDate: null,
    };
  }

  assertShiyingLifeDate(input.firstLiveLifeDate, 'window_first_live_life_date_invalid');
  const latestLiveEndCursor = parseShiyingMessageCursorV1(input.latestLiveEndCursor);
  if (input.firstLiveLifeDate > lifeDateEnd) windowError('first_live_life_date_future');

  const recentLifeDateStart = getShiyingRecentLifeDateStart(input.triggeredAt);
  const lifeDateStart = input.firstLiveLifeDate > recentLifeDateStart
    ? input.firstLiveLifeDate
    : recentLifeDateStart;
  const latestLiveLifeDate = getShiyingLifeDate(latestLiveEndCursor.messageCreatedAt);

  return {
    lifeDateStart,
    lifeDateEnd,
    scanFloorAt: getShiyingLifeDateStartAt(lifeDateStart),
    windowStartCursor: latestLiveEndCursor,
    historyGapBeforeLifeDate: latestLiveLifeDate < recentLifeDateStart
      ? addShiyingLifeDates(recentLifeDateStart, -1)
      : null,
  };
}
