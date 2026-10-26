function dateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Calendar arithmetic preserves Sunday 21:00 through local DST changes. */
export function latestDueWeeklyPeriod(now = Date.now()) {
  const date = new Date(now);
  const sunday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay(), 21);
  if (sunday.getTime() > now) sunday.setDate(sunday.getDate() - 7);
  const monday = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() - 6);
  return { weekKey: dateKey(monday), dueAt: sunday.getTime() };
}

export function nextWeeklyPeriodDueAt(now = Date.now()) {
  const latest = new Date(latestDueWeeklyPeriod(now).dueAt);
  latest.setDate(latest.getDate() + 7);
  return latest.getTime();
}
