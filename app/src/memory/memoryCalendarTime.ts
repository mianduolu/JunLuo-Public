import type {
  MemoryEventTime,
  MemoryEventTimeBasis,
  MemoryEventTimePrecision,
} from './memoryAtomicity';

export type MemoryCalendarSourceMessage = {
  content: string;
  createdAt: number;
  id: string;
};

export type MemoryCalendarResolution = {
  blocksModelFallback: boolean;
  eventTime?: MemoryEventTime;
};

const WEEKDAY_INDEX: Record<string, number> = {
  一: 0,
  二: 1,
  三: 2,
  四: 3,
  五: 4,
  六: 5,
  日: 6,
  天: 6,
};

const MONTH_TOKEN_PATTERN = '(?:1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])';
const CALENDAR_EXPRESSION_PATTERN = new RegExp([
  `(?:上周|本周|这周|下周)(?:周|星期)?[一二三四五六日天]\\s*(?:到|至|—|-|～|~)\\s*(?:(?:上周|本周|这周|下周))?(?:周|星期)?[一二三四五六日天]`,
  '(?:上上个月|上个月|本月|这个月|这月|下个月)(?:的)?(?:整个)?(?:上旬|中旬|下旬)',
  `(?:(?:20\\d{2})年|今年|去年|前年)${MONTH_TOKEN_PATTERN}月(?:的)?(?:整个)?(?:上旬|中旬|下旬)`,
  '20\\d{2}(?:年\\d{1,2}月\\d{1,2}日?|[-/.]\\d{1,2}[-/.]\\d{1,2})',
  '(?:上周|本周|这周|下周)(?:周|星期)?[一二三四五六日天]',
  '大前天|前天|昨天|今天|明天|后天|大后天',
  '上周|本周|这周|下周',
  '上上个月|上个月|本月|这个月|这月|下个月',
  `${MONTH_TOKEN_PATTERN}月(?:的)?(?:整个)?(?:上旬|中旬|下旬)`,
  '(?:整个)?(?:上旬|中旬|下旬)',
  '(?:周|星期)[一二三四五六日天](?:\\s*(?:到|至|—|-|～|~)\\s*(?:周|星期)?[一二三四五六日天])?',
].join('|'), 'gu');

const VAGUE_CALENDAR_EXPRESSION_PATTERN =
  /^(?:(?:整个)?(?:上旬|中旬|下旬)|(?:周|星期)[一二三四五六日天](?:\s*(?:到|至|—|-|～|~)\s*(?:周|星期)?[一二三四五六日天])?|(?:1[0-2]|0?[1-9]|十[一二]?|[一二三四五六七八九])月(?:的)?(?:整个)?(?:上旬|中旬|下旬)|月初|月底|月末|前阵子|前段时间|最近|这几天|那天|后来|之前)$/u;

const UNSUPPORTED_CALENDAR_HINT_PATTERN = /(?:年|月|周|星期|礼拜|旬|今天|昨天|前天|前几天|明天|后天|那天|最近|后来|之前)/u;

type ParsedCalendarExpression =
  | { kind: 'ambiguous' }
  | { eventTime: MemoryEventTime; kind: 'resolved' }
  | { kind: 'unsupported' };

function compactExpression(value: string) {
  return value.replace(/\s+/g, '').trim();
}

function localDayStart(timestamp: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localDayRange(timestamp: number) {
  const startAt = localDayStart(timestamp);
  const date = new Date(startAt);
  return {
    endAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() - 1,
    startAt,
  };
}

function addLocalDays(timestamp: number, days: number) {
  const date = new Date(timestamp);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

function localMonday(timestamp: number) {
  const sourceDay = localDayStart(timestamp);
  return addLocalDays(sourceDay, -((new Date(sourceDay).getDay() + 6) % 7));
}

function localMonthRange(year: number, monthIndex: number, segment?: '上旬' | '中旬' | '下旬') {
  const startDay = segment === '中旬' ? 11 : segment === '下旬' ? 21 : 1;
  const endExclusive = segment === '上旬'
    ? new Date(year, monthIndex, 11).getTime()
    : segment === '中旬'
      ? new Date(year, monthIndex, 21).getTime()
      : new Date(year, monthIndex + 1, 1).getTime();
  return {
    endAt: endExclusive - 1,
    startAt: new Date(year, monthIndex, startDay).getTime(),
  };
}

function parseMonthToken(value: string) {
  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 12) return numeric;
  return ({
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    十一: 11,
    十二: 12,
  } as Record<string, number>)[value];
}

function resolved(
  basis: MemoryEventTimeBasis,
  expression: string,
  source: MemoryCalendarSourceMessage,
  precision: MemoryEventTimePrecision,
  startAt: number,
  endAt?: number,
): ParsedCalendarExpression {
  return {
    eventTime: {
      basis,
      ...(endAt === undefined ? {} : { endAt }),
      precision,
      startAt,
      timeExpression: expression,
      timeSourceMessageId: source.id,
    },
    kind: 'resolved',
  };
}

function parseExpression(
  rawExpression: string,
  source: MemoryCalendarSourceMessage,
): ParsedCalendarExpression {
  const expression = compactExpression(rawExpression);
  const dayOffset = ({
    大前天: -3,
    前天: -2,
    昨天: -1,
    今天: 0,
    明天: 1,
    后天: 2,
    大后天: 3,
  } as Record<string, number>)[expression];
  if (dayOffset !== undefined) {
    const range = localDayRange(addLocalDays(source.createdAt, dayOffset));
    return resolved('relative', expression, source, 'day', range.startAt, range.endAt);
  }

  const weekRange = expression.match(
    /^(上周|本周|这周|下周)(?:周|星期)?([一二三四五六日天])(?:到|至|—|-|～|~)(?:(上周|本周|这周|下周))?(?:周|星期)?([一二三四五六日天])$/u,
  );
  if (weekRange) {
    const offsets: Record<string, number> = { 上周: -7, 本周: 0, 这周: 0, 下周: 7 };
    const monday = localMonday(source.createdAt);
    const startAt = addLocalDays(monday, offsets[weekRange[1]] + WEEKDAY_INDEX[weekRange[2]]);
    const endAt = addLocalDays(
      monday,
      offsets[weekRange[3] || weekRange[1]] + WEEKDAY_INDEX[weekRange[4]] + 1,
    ) - 1;
    if (endAt < startAt) return { kind: 'ambiguous' };
    return resolved('relative', expression, source, 'range', startAt, endAt);
  }

  const weekday = expression.match(/^(上周|本周|这周|下周)(?:周|星期)?([一二三四五六日天])$/u);
  if (weekday) {
    const offsets: Record<string, number> = { 上周: -7, 本周: 0, 这周: 0, 下周: 7 };
    const range = localDayRange(addLocalDays(
      localMonday(source.createdAt),
      offsets[weekday[1]] + WEEKDAY_INDEX[weekday[2]],
    ));
    return resolved('relative', expression, source, 'day', range.startAt, range.endAt);
  }

  const wholeWeek = expression.match(/^(上周|本周|这周|下周)$/u);
  if (wholeWeek) {
    const offsets: Record<string, number> = { 上周: -7, 本周: 0, 这周: 0, 下周: 7 };
    const startAt = addLocalDays(localMonday(source.createdAt), offsets[wholeWeek[1]]);
    return resolved('relative', expression, source, 'range', startAt, addLocalDays(startAt, 7) - 1);
  }

  const relativeMonth = expression.match(
    /^(上上个月|上个月|本月|这个月|这月|下个月)(?:的)?(?:整个)?(上旬|中旬|下旬)?$/u,
  );
  if (relativeMonth) {
    const offsets: Record<string, number> = {
      上上个月: -2,
      上个月: -1,
      本月: 0,
      这个月: 0,
      这月: 0,
      下个月: 1,
    };
    const reference = new Date(source.createdAt);
    const monthStart = new Date(reference.getFullYear(), reference.getMonth() + offsets[relativeMonth[1]], 1);
    const range = localMonthRange(
      monthStart.getFullYear(),
      monthStart.getMonth(),
      relativeMonth[2] as '上旬' | '中旬' | '下旬' | undefined,
    );
    return resolved('relative', expression, source, 'range', range.startAt, range.endAt);
  }

  const anchoredMonthSegment = expression.match(
    new RegExp(`^(?:(20\\d{2})年|(今年|去年|前年))(${MONTH_TOKEN_PATTERN})月(?:的)?(?:整个)?(上旬|中旬|下旬)$`, 'u'),
  );
  if (anchoredMonthSegment) {
    const referenceYear = new Date(source.createdAt).getFullYear();
    const year = anchoredMonthSegment[1]
      ? Number(anchoredMonthSegment[1])
      : referenceYear + ({ 今年: 0, 去年: -1, 前年: -2 } as Record<string, number>)[anchoredMonthSegment[2]];
    const month = parseMonthToken(anchoredMonthSegment[3]);
    if (!month) return { kind: 'unsupported' };
    const range = localMonthRange(
      year,
      month - 1,
      anchoredMonthSegment[4] as '上旬' | '中旬' | '下旬',
    );
    return resolved('explicit', expression, source, 'range', range.startAt, range.endAt);
  }

  const explicitDate = expression.match(/^20(\d{2})(?:年(\d{1,2})月(\d{1,2})日?|[-/.](\d{1,2})[-/.](\d{1,2}))$/u);
  if (explicitDate) {
    const year = 2000 + Number(explicitDate[1]);
    const month = Number(explicitDate[2] ?? explicitDate[4]);
    const day = Number(explicitDate[3] ?? explicitDate[5]);
    const timestamp = new Date(year, month - 1, day).getTime();
    const date = new Date(timestamp);
    if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
      return { kind: 'ambiguous' };
    }
    const range = localDayRange(timestamp);
    return resolved('explicit', expression, source, 'day', range.startAt, range.endAt);
  }

  return VAGUE_CALENDAR_EXPRESSION_PATTERN.test(expression)
    ? { kind: 'ambiguous' }
    : { kind: 'unsupported' };
}

function findExpressions(value: string) {
  return Array.from(new Set(
    Array.from(value.matchAll(CALENDAR_EXPRESSION_PATTERN))
      .map((match) => compactExpression(match[0]))
      .filter(Boolean),
  ));
}

export function resolveMemoryCalendarTime({
  candidateText,
  requestedExpression,
  requestedSourceId,
  sourceMessages,
}: {
  candidateText?: string;
  requestedExpression?: string;
  requestedSourceId?: string;
  sourceMessages: MemoryCalendarSourceMessage[];
}): MemoryCalendarResolution {
  const exactRequestedSource = requestedSourceId
    ? sourceMessages.find((message) => message.id === requestedSourceId)
    : undefined;
  if (requestedSourceId && !exactRequestedSource) return { blocksModelFallback: true };
  if (
    requestedExpression
    && exactRequestedSource
    && !compactExpression(exactRequestedSource.content).includes(compactExpression(requestedExpression))
  ) return { blocksModelFallback: true };
  const orderedSources = requestedSourceId
    ? [
        ...sourceMessages.filter((message) => message.id === requestedSourceId),
        ...sourceMessages.filter((message) => message.id !== requestedSourceId),
      ]
    : sourceMessages;

  const resolveExpression = (expression: string): MemoryCalendarResolution => {
    const compact = compactExpression(expression);
    const allMatchingSources = orderedSources.filter((source) =>
      compactExpression(source.content).includes(compact));
    const requestedSource = requestedSourceId
      ? allMatchingSources.find((source) => source.id === requestedSourceId)
      : undefined;
    const matchingSources = requestedSource ? [requestedSource] : allMatchingSources;
    if (!matchingSources.length) return { blocksModelFallback: false };
    const outcomes = matchingSources.map((source) => parseExpression(compact, source));
    if (outcomes.some((outcome) => outcome.kind === 'ambiguous')) {
      return { blocksModelFallback: true };
    }
    const resolvedItems = outcomes
      .filter((outcome): outcome is Extract<ParsedCalendarExpression, { kind: 'resolved' }> =>
        outcome.kind === 'resolved')
      .map((outcome) => outcome.eventTime);
    if (!resolvedItems.length) {
      return {
        blocksModelFallback: VAGUE_CALENDAR_EXPRESSION_PATTERN.test(compact)
          || UNSUPPORTED_CALENDAR_HINT_PATTERN.test(compact),
      };
    }
    const first = resolvedItems[0];
    const allSame = resolvedItems.every((item) =>
      item.startAt === first.startAt && item.endAt === first.endAt && item.precision === first.precision);
    return allSame
      ? { blocksModelFallback: false, eventTime: first }
      : { blocksModelFallback: true };
  };

  if (requestedExpression) {
    const requested = resolveExpression(requestedExpression);
    if (requested.eventTime || requested.blocksModelFallback) return requested;
  }

  const candidateExpressions = findExpressions(candidateText ?? '');
  if (candidateExpressions.length > 1) return { blocksModelFallback: true };
  if (candidateExpressions.length === 1) {
    const candidate = resolveExpression(candidateExpressions[0]);
    if (candidate.eventTime || candidate.blocksModelFallback) return candidate;
  }

  const sourceExpressions = Array.from(new Set(
    orderedSources.flatMap((source) => findExpressions(source.content)),
  ));
  if (sourceExpressions.length !== 1) {
    return { blocksModelFallback: sourceExpressions.length > 1 };
  }
  return resolveExpression(sourceExpressions[0]);
}

function parseManualPoint(value: string, rangeEnd: boolean) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/u);
  if (!match) return undefined;
  const [, yearText, monthText, dayText, hourText, minuteText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hasClock = hourText !== undefined;
  const hour = hasClock ? Number(hourText) : rangeEnd ? 23 : 0;
  const minute = hasClock ? Number(minuteText) : rangeEnd ? 59 : 0;
  if (hour > 23 || minute > 59) return undefined;
  const timestamp = new Date(year, month - 1, day, hour, minute, rangeEnd && !hasClock ? 59 : 0, rangeEnd && !hasClock ? 999 : 0).getTime();
  const parsed = new Date(timestamp);
  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
  ) return undefined;
  return { hasClock, timestamp };
}

export function parseManualMemoryEventTime(value: string): MemoryEventTime | undefined {
  const expression = value.replace(/\s+/g, ' ').trim();
  if (!expression) return undefined;
  const unresolved: MemoryEventTime = { basis: 'unknown', precision: 'unknown', timeExpression: value.trim() };
  const parts = expression.split(/\s*(?:至|到|～|~)\s*/u);
  if (parts.length > 2) return unresolved;
  const start = parseManualPoint(parts[0], false);
  if (!start) return unresolved;
  if (parts.length === 1) {
    if (start.hasClock) {
      return { basis: 'explicit', precision: 'instant', startAt: start.timestamp, timeExpression: expression };
    }
    const range = localDayRange(start.timestamp);
    return { basis: 'explicit', precision: 'day', ...range, timeExpression: expression };
  }
  const end = parseManualPoint(parts[1], true);
  if (!end || end.timestamp < start.timestamp) return unresolved;
  return {
    basis: 'explicit',
    endAt: end.timestamp,
    precision: 'range',
    startAt: start.timestamp,
    timeExpression: expression,
  };
}

function formatDatePart(timestamp: number, includeClock: boolean) {
  const value = new Date(timestamp);
  const date = [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, '0'),
    String(value.getDate()).padStart(2, '0'),
  ].join('-');
  if (!includeClock) return date;
  return `${date} ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
}

export function formatMemoryEventTimeInput(eventTime?: MemoryEventTime) {
  if (!eventTime || eventTime.precision === 'unknown' || eventTime.basis === 'unknown'
    || eventTime.startAt === undefined) return eventTime?.timeExpression ?? '';
  if (eventTime.precision === 'instant') return formatDatePart(eventTime.startAt, true);
  if (eventTime.precision === 'day' || !eventTime.endAt) return formatDatePart(eventTime.startAt, false);
  const start = new Date(eventTime.startAt);
  const end = new Date(eventTime.endAt);
  const startHasClock = start.getHours() !== 0 || start.getMinutes() !== 0;
  const endHasClock = end.getHours() !== 23 || end.getMinutes() !== 59;
  return `${formatDatePart(eventTime.startAt, startHasClock)} 至 ${formatDatePart(eventTime.endAt, endHasClock)}`;
}

const SINGLE_DAY_RELATIVE_EXPRESSION_PATTERN =
  /^(?:大前天|前天|昨天|今天|明天|后天|大后天|(?:上周|本周|这周|下周)(?:周|星期)?[一二三四五六日天])$/u;

function formatChineseDate(timestamp: number) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatStableCalendarRange(startAt: number, endAt?: number) {
  if (!endAt) return formatChineseDate(startAt);
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (
    start.getFullYear() === end.getFullYear()
    && start.getMonth() === end.getMonth()
    && start.getDate() === end.getDate()
  ) return formatChineseDate(startAt);
  if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
    return `${formatChineseDate(startAt).replace(/日$/u, '')}日至${end.getDate()}日`;
  }
  if (start.getFullYear() === end.getFullYear()) {
    return `${formatChineseDate(startAt).replace(/日$/u, '')}日至${end.getMonth() + 1}月${end.getDate()}日`;
  }
  return `${formatChineseDate(startAt).replace(/日$/u, '')}日至${formatChineseDate(endAt)}`;
}

export function stabilizeMemoryCalendarNarrative(text: string, eventTime?: MemoryEventTime) {
  if (
    !eventTime
    || eventTime.basis !== 'relative'
    || !eventTime.startAt
    || !eventTime.timeExpression
  ) return text;
  const expression = compactExpression(eventTime.timeExpression);
  if (!expression || !text.includes(expression)) return text;
  const stableExpression = SINGLE_DAY_RELATIVE_EXPRESSION_PATTERN.test(expression)
    ? formatChineseDate(eventTime.startAt)
    : formatStableCalendarRange(eventTime.startAt, eventTime.endAt);
  return text.split(expression).join(stableExpression);
}
