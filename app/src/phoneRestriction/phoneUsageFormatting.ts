import type { OwnAppPhoneUsageResult } from '../backend/phoneActivityNative';
import type { PhoneUsageAppSummary, PhoneUsageSummary } from '../phoneActivity/phoneActivityStore';

// Display only: the original summary remains the reviewed daily-comment input.
export function includeOwnAppPhoneUsage(summary: PhoneUsageSummary, own: OwnAppPhoneUsageResult): PhoneUsageSummary {
  if (!own.available) return summary;
  const amounts = new Map(own.days.map(day => [day.dateKey, day.durationMs]));
  const add = (apps: PhoneUsageAppSummary[], durationMs: number) => durationMs > 0
    ? [...apps.filter(app => app.source !== own.source), { source: own.source, title: own.title, durationMs, segments: 0 }]
      .sort((a, b) => b.durationMs - a.durationMs)
    : apps;
  const days = summary.days.map(day => {
    const durationMs = amounts.get(day.dateKey) ?? 0;
    return { ...day, totalDurationMs: day.totalDurationMs + durationMs, topApps: add(day.topApps, durationMs).slice(0, 2) };
  });
  return { ...summary, days, todayTopApps: add(summary.todayTopApps, amounts.get(days[0]?.dateKey) ?? 0),
    weekTopApps: add(summary.weekTopApps, summary.days.reduce((total, day) => total + (amounts.get(day.dateKey) ?? 0), 0)) };
}

// The legacy format remains the source of the existing daily-comment material.
export function formatUsageDuration(durationMs: number) {
  const minutes = Math.max(0, Math.round(durationMs / 60000));
  if (minutes <= 0) return '0m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function formatPhoneUsageDuration(durationMs: number) {
  if (durationMs > 0 && durationMs < 60000) return '不到一分钟';
  const minutes = Math.max(0, Math.round(durationMs / 60000));
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}小时${rest ? `${rest}分钟` : ''}`;
}

export function formatPhoneUsageUpdatedAt(value: number) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function todayCommentKey(now = Date.now()) {
  const date = new Date(now);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

export function normalizePhoneUsageComment(value: string) {
  const clean = value.replace(/^白云小姐[：:，,]\s*/, '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const clipped = clean.slice(0, 70);
  return /[。！？!?…~～]$/.test(clipped) ? clipped : `${clipped}。`;
}
