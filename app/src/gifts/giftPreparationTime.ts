/** A tool supplies calendar text; the device supplies its time zone and timestamp. */
export function resolveGiftPreparationTime(date: string, time: string, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
    throw new Error('gift-invalid-time');
  }
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const value = new Date(0);
  value.setFullYear(year, month - 1, day);
  value.setHours(hour, minute, 0, 0);
  // Date normally repairs overflow and missing daylight-saving times. A gift must
  // keep the selected calendar time instead of silently delivering on another day.
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day
    || value.getHours() !== hour || value.getMinutes() !== minute
    || !Number.isFinite(now) || value.getTime() <= now) throw new Error('gift-invalid-time');
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!timeZone) throw new Error('gift-invalid-time');
  return { at: value.getTime(), timeZone };
}
