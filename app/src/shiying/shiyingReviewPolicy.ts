import AsyncStorage from '@react-native-async-storage/async-storage';

export const SHIYING_WEEKLY_REVIEW_LOCAL_KEY = 'junluo.shiying.review.local.v1';
export type ShiyingWeeklyReviewState = {
  version: 1 | 2; enabled: boolean; autoFloor: string | null; day: string | null; reservedCalls: number;
  monthEnabled?: boolean; monthAutoFloor?: string | null; yearEnabled?: boolean; yearAutoFloor?: string | null;
};
const initial: ShiyingWeeklyReviewState = { version: 2, enabled: false, autoFloor: null, day: null, reservedCalls: 0,
  monthEnabled: false, monthAutoFloor: null, yearEnabled: false, yearAutoFloor: null };
let queue = Promise.resolve();
const listeners = new Set<() => void>();
function notify() { listeners.forEach(listener => { try { listener(); } catch { /* A view cannot undo a saved reservation or setting. */ } }); }
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.catch(() => undefined).then(fn); queue = next.then(() => undefined, () => undefined); return next;
}
function dateText(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
export function getShiyingReviewWeek(now = Date.now()) {
  const monday = new Date(now); monday.setHours(5, 0, 0, 0);
  monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
  if (now < monday.getTime()) monday.setDate(monday.getDate() - 7);
  const end = new Date(monday); end.setDate(end.getDate() - 1);
  const start = new Date(monday); start.setDate(start.getDate() - 7);
  return { start: dateText(start), end: dateText(end) };
}
export function shiyingWeekForDate(date: string) {
  const value = new Date(`${date}T12:00:00`); value.setDate(value.getDate() - (value.getDay() + 6) % 7);
  const start = dateText(value); value.setDate(value.getDate() + 6); return { start, end: dateText(value) };
}
async function read() {
  const raw = await AsyncStorage.getItem(SHIYING_WEEKLY_REVIEW_LOCAL_KEY);
  if (raw === null) return { ...initial };
  let state: ShiyingWeeklyReviewState;
  try { state = JSON.parse(raw); } catch { throw new Error('shiying_review_state_invalid'); }
  if (![1, 2].includes(state.version) || typeof state.enabled !== 'boolean' || !Number.isSafeInteger(state.reservedCalls)
    || state.reservedCalls < 0 || state.reservedCalls > 2 || ![state.day, state.autoFloor].every(value => value === null || /^\d{4}-\d{2}-\d{2}$/u.test(value))) {
    throw new Error('shiying_review_state_invalid');
  }
  if (state.version === 2 && (typeof state.monthEnabled !== 'boolean' || typeof state.yearEnabled !== 'boolean'
    || ![state.monthAutoFloor, state.yearAutoFloor].every(value => value === null || typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)))) {
    throw new Error('shiying_review_state_invalid');
  }
  return { ...initial, ...state, version: 2 as const };
}
export function loadShiyingWeeklyReviewState() { return serial(read); }
export function setShiyingWeeklyReviewEnabled(enabled: boolean, now = Date.now()) {
  return serial(async () => {
    const previous = await read(); const next = { ...previous, enabled,
      autoFloor: enabled && previous.autoFloor === null ? getShiyingReviewWeek(now).start : previous.autoFloor };
    await AsyncStorage.setItem(SHIYING_WEEKLY_REVIEW_LOCAL_KEY, JSON.stringify(next));
    notify(); return next;
  });
}
export type ShiyingReviewKind = 'week' | 'month' | 'year';
export function isShiyingReviewKindEnabled(state: ShiyingWeeklyReviewState, kind: ShiyingReviewKind) {
  return kind === 'week' ? state.enabled : kind === 'month' ? state.monthEnabled === true : state.yearEnabled === true;
}
export function getShiyingReviewAutoFloor(state: ShiyingWeeklyReviewState, kind: ShiyingReviewKind) {
  return kind === 'week' ? state.autoFloor : kind === 'month' ? state.monthAutoFloor ?? null : state.yearAutoFloor ?? null;
}
export function setShiyingPeriodReviewEnabled(kind: 'month' | 'year', enabled: boolean, floor: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(floor) || floor < '2026-10-01') throw new Error('shiying_review_floor_invalid');
  return serial(async () => {
    const previous = await read();
    const next = kind === 'month' ? { ...previous, monthEnabled: enabled,
      monthAutoFloor: enabled && !previous.monthAutoFloor ? floor : previous.monthAutoFloor }
      : { ...previous, yearEnabled: enabled, yearAutoFloor: enabled && !previous.yearAutoFloor ? floor : previous.yearAutoFloor };
    await AsyncStorage.setItem(SHIYING_WEEKLY_REVIEW_LOCAL_KEY, JSON.stringify(next)); notify(); return next;
  });
}
export function reserveShiyingWeeklyReviewCall(now = Date.now(), kind: ShiyingReviewKind = 'week') {
  return serial(async () => {
    const state = await read(); const currentDay = dateText(new Date(now));
    const next = state.day === null || currentDay > state.day ? { ...state, day: currentDay, reservedCalls: 0 } : { ...state };
    if (!isShiyingReviewKindEnabled(next, kind) || next.reservedCalls >= 2) return null;
    next.reservedCalls += 1;
    await AsyncStorage.setItem(SHIYING_WEEKLY_REVIEW_LOCAL_KEY, JSON.stringify(next));
    notify(); return { day: next.day!, count: next.reservedCalls };
  });
}
/** Only the caller that can prove HTTP has not started may cancel its exact reservation. */
export function cancelShiyingWeeklyReviewReservation(reservation: { day: string; count: number }) {
  return serial(async () => {
    const state = await read(); if (state.day !== reservation.day || state.reservedCalls !== reservation.count) return;
    await AsyncStorage.setItem(SHIYING_WEEKLY_REVIEW_LOCAL_KEY, JSON.stringify({ ...state, reservedCalls: state.reservedCalls - 1 }));
  });
}
export function subscribeShiyingWeeklyReviewState(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
