import { dateKey, isLegalWorkday as isScheduleLegalWorkday } from '../schedule/calendarRules';
import type {
  AiWallet,
  WalletDecision,
  WalletDecisionReview,
  WalletHolding,
  WalletSnapshot,
} from './walletStore';
import type { WalletWatchlistResult } from './walletWatchlistService';

export type WalletObservationReminderStatus = 'ok' | 'due' | 'warning';
export type WalletObservationReminderLevel = 'quiet' | 'notice' | 'attention';
export type WalletObservationReminderAction =
  | 'refresh_watchlist'
  | 'refresh_valuation'
  | 'refresh_reviews'
  | 'review_decisions'
  | 'none';
export type WalletObservationCalendarSource = 'schedule_calendar_rules' | 'fallback_weekday';

export type WalletObservationReminderItem = {
  action: WalletObservationReminderAction;
  detail: string;
  id: string;
  label: string;
  status: WalletObservationReminderStatus;
};

export type WalletObservationReminderReport = {
  calendarSource: WalletObservationCalendarSource;
  dateKey: string;
  generatedAt: number;
  isLegalWorkday: boolean;
  items: WalletObservationReminderItem[];
  level: WalletObservationReminderLevel;
  shouldAutoRefresh: boolean;
  summary: string;
  warnings: string[];
};

export type BuildWalletObservationReminderInput = {
  decisions: WalletDecision[];
  decisionReviews: WalletDecisionReview[];
  holdings: WalletHolding[];
  lastAutoRefreshAt?: number | null;
  now?: Date | number;
  snapshots: WalletSnapshot[];
  wallet: AiWallet | null;
  watchlist: WalletWatchlistResult | null;
};

export const WALLET_OBSERVATION_AUTO_REFRESH_COOLDOWN_MS = 30 * 60 * 1000;

const WATCHLIST_STALE_MS = 6 * 60 * 60 * 1000;
const VALUATION_STALE_MS = 12 * 60 * 60 * 1000;
const REVIEW_STALE_MS = 24 * 60 * 60 * 1000;
const KNOWN_SCHEDULE_CALENDAR_YEARS = new Set([2026]);

function toTimestamp(value: Date | number | undefined) {
  if (value instanceof Date) return value.getTime();
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now();
}

function startOfLocalDate(value: number) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function fallbackWeekday(date: Date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function resolveCalendar(date: Date) {
  if (KNOWN_SCHEDULE_CALENDAR_YEARS.has(date.getFullYear())) {
    return {
      calendarSource: 'schedule_calendar_rules' as const,
      isLegalWorkday: isScheduleLegalWorkday(date),
      warnings: [] as string[],
    };
  }
  return {
    calendarSource: 'fallback_weekday' as const,
    isLegalWorkday: fallbackWeekday(date),
    warnings: ['\u65e5\u7a0b\u89c4\u5219\u6682\u65f6\u53ea\u8986\u76d6\u5230 2026 \u5e74\uff0c\u4eca\u5929\u5148\u6309\u666e\u901a\u5de5\u4f5c\u65e5\u53e3\u5f84\u5224\u65ad\u3002'],
  };
}

function isOlderThan(value: number | null | undefined, now: number, maxAgeMs: number) {
  return typeof value !== 'number' || !Number.isFinite(value) || now - value > maxAgeMs;
}

function mostRecentReviewAt(reviews: WalletDecisionReview[]) {
  return reviews.reduce((latest, review) => Math.max(latest, review.updatedAt || review.reviewedAt || 0), 0);
}

function buildSummary(isLegalWorkday: boolean, dueCount: number, pendingCount: number) {
  if (!isLegalWorkday) return '\u4eca\u5929\u4e0d\u662f\u4ea4\u6613\u65e5\uff0c\u767d\u4e91\u5c0f\u59d0\u53ea\u8f7b\u8f7b\u770b\u770b\u5c0f\u91d1\u5e93\u72b6\u6001\u5c31\u597d\u3002';
  if (pendingCount > 0) return '\u4eca\u5929\u53ef\u4ee5\u770b\u770b\u5f85\u786e\u8ba4\u7684\u5c0f\u5361\u7247\uff0c\u8981\u5c0f\u4ed3\u9f20\u70b9\u5934\u624d\u4f5c\u6570\u3002';
  if (dueCount > 0) return '\u4eca\u5929\u53ef\u4ee5\u770b\u57fa\u91d1\uff0c\u6709\u51e0\u9879\u6570\u636e\u503c\u5f97\u8ba9\u767d\u4e91\u5c0f\u59d0\u8f7b\u8f7b\u5237\u65b0\u4e00\u4e0b\u3002';
  return '\u5c0f\u91d1\u5e93\u770b\u8d77\u6765\u7a33\u7a33\u7684\uff0c\u6682\u65f6\u4e0d\u7528\u6025\u3002';
}

export function buildWalletObservationReminderReport(input: BuildWalletObservationReminderInput): WalletObservationReminderReport {
  const now = toTimestamp(input.now);
  const today = startOfLocalDate(now);
  const calendar = resolveCalendar(today);
  const warnings = [...calendar.warnings];
  const pendingDecisions = input.decisions.filter((decision) => decision.status === 'proposed');
  const latestSnapshot = input.snapshots[0];
  const latestReviewAt = mostRecentReviewAt(input.decisionReviews);
  const reviewableDecisionCount = input.decisions.filter((decision) => (
    decision.status === 'approved' || decision.status === 'executed'
  )).length;
  const items: WalletObservationReminderItem[] = [];

  if (!input.wallet) {
    items.push({
      action: 'none',
      detail: '\u5c0f\u91d1\u5e93\u8d26\u6237\u8fd8\u6ca1\u51c6\u5907\u597d\uff0c\u5148\u4e0d\u81ea\u52a8\u5237\u65b0\u3002',
      id: 'wallet',
      label: '\u5c0f\u91d1\u5e93\u8d26\u6237',
      status: 'warning',
    });
  }

  if (!input.watchlist) {
    items.push({
      action: 'refresh_watchlist',
      detail: '\u4eca\u5929\u8fd8\u6ca1\u6574\u7406\u89c2\u5bdf\u6c60\u3002',
      id: 'watchlist',
      label: '\u4eca\u65e5\u89c2\u5bdf\u6c60',
      status: 'due',
    });
  } else if (input.watchlist.stale || isOlderThan(input.watchlist.updatedAt, now, WATCHLIST_STALE_MS)) {
    items.push({
      action: 'refresh_watchlist',
      detail: input.watchlist.stale ? '\u89c2\u5bdf\u6c60\u6570\u636e\u504f\u65e7\uff0c\u53ea\u80fd\u5148\u5f53\u89c2\u5bdf\u3002' : '\u89c2\u5bdf\u6c60\u5df2\u7ecf\u6709\u4e00\u9635\u5b50\u6ca1\u770b\u8fc7\u4e86\u3002',
      id: 'watchlist',
      label: '\u4eca\u65e5\u89c2\u5bdf\u6c60',
      status: 'due',
    });
  } else {
    items.push({
      action: 'none',
      detail: '\u89c2\u5bdf\u6c60\u521a\u521a\u6574\u7406\u8fc7\u3002',
      id: 'watchlist',
      label: '\u4eca\u65e5\u89c2\u5bdf\u6c60',
      status: 'ok',
    });
  }

  if (input.holdings.length === 0) {
    items.push({
      action: 'none',
      detail: '\u8fd8\u6ca1\u6709\u6301\u4ed3\uff0c\u6682\u65f6\u4e0d\u7528\u5237\u65b0\u4f30\u503c\u3002',
      id: 'valuation',
      label: '\u6301\u4ed3\u4f30\u503c',
      status: 'ok',
    });
  } else if (isOlderThan(latestSnapshot?.snapshotAt, now, VALUATION_STALE_MS)) {
    items.push({
      action: 'refresh_valuation',
      detail: '\u6301\u4ed3\u4f30\u503c\u6709\u70b9\u65e7\uff0c\u9002\u5408\u91cd\u65b0\u770b\u4e00\u773c\u51c0\u503c\u3002',
      id: 'valuation',
      label: '\u6301\u4ed3\u4f30\u503c',
      status: 'due',
    });
  } else {
    items.push({
      action: 'none',
      detail: '\u6301\u4ed3\u4f30\u503c\u6700\u8fd1\u5237\u65b0\u8fc7\u3002',
      id: 'valuation',
      label: '\u6301\u4ed3\u4f30\u503c',
      status: 'ok',
    });
  }

  if (reviewableDecisionCount === 0) {
    items.push({
      action: 'none',
      detail: '\u8fd8\u6ca1\u6709\u9700\u8981\u590d\u76d8\u7684\u51b3\u5b9a\u3002',
      id: 'reviews',
      label: '\u51b3\u5b9a\u590d\u76d8',
      status: 'ok',
    });
  } else if (input.decisionReviews.some((review) => review.status !== 'ready') || isOlderThan(latestReviewAt, now, REVIEW_STALE_MS)) {
    items.push({
      action: 'refresh_reviews',
      detail: '\u6709\u51b3\u5b9a\u53ef\u4ee5\u91cd\u65b0\u6d4b\u4e00\u4e0b\u540e\u7eed\u8868\u73b0\u3002',
      id: 'reviews',
      label: '\u51b3\u5b9a\u590d\u76d8',
      status: 'due',
    });
  } else {
    items.push({
      action: 'none',
      detail: '\u590d\u76d8\u8bb0\u5f55\u6700\u8fd1\u66f4\u65b0\u8fc7\u3002',
      id: 'reviews',
      label: '\u51b3\u5b9a\u590d\u76d8',
      status: 'ok',
    });
  }

  if (pendingDecisions.length > 0) {
    items.push({
      action: 'review_decisions',
      detail: pendingDecisions.length + ' \u5f20\u5c0f\u5361\u7247\u6b63\u5728\u7b49\u5c0f\u4ed3\u9f20\u770b\u770b\u3002',
      id: 'pending_decisions',
      label: '\u5f85\u786e\u8ba4\u5361',
      status: 'due',
    });
  } else {
    items.push({
      action: 'none',
      detail: '\u6ca1\u6709\u5f85\u786e\u8ba4\u7684\u5c0f\u5361\u7247\u3002',
      id: 'pending_decisions',
      label: '\u5f85\u786e\u8ba4\u5361',
      status: 'ok',
    });
  }

  const dueCount = items.filter((item) => item.status === 'due').length;
  const hasWarning = items.some((item) => item.status === 'warning');
  const lastAutoRefreshAt = input.lastAutoRefreshAt ?? null;
  const autoRefreshCooling = typeof lastAutoRefreshAt === 'number'
    && now - lastAutoRefreshAt < WALLET_OBSERVATION_AUTO_REFRESH_COOLDOWN_MS;
  const hasRefreshAction = items.some((item) => item.status === 'due'
    && (item.action === 'refresh_watchlist' || item.action === 'refresh_valuation' || item.action === 'refresh_reviews'));

  return {
    calendarSource: calendar.calendarSource,
    dateKey: dateKey(today),
    generatedAt: now,
    isLegalWorkday: calendar.isLegalWorkday,
    items,
    level: hasWarning || pendingDecisions.length > 0 ? 'attention' : dueCount > 0 ? 'notice' : 'quiet',
    shouldAutoRefresh: calendar.isLegalWorkday && hasRefreshAction && !autoRefreshCooling,
    summary: buildSummary(calendar.isLegalWorkday, dueCount, pendingDecisions.length),
    warnings,
  };
}
