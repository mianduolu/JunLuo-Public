export type PostponeTarget =
  | { kind: 'tomorrow' }
  | { kind: 'next_week' }
  | { kind: 'specific_date'; date: string }
  | { kind: 'after_deadline'; goalId: string };

export type PostponeIntent = { target?: PostponeTarget; needsDate: boolean; subjectHint: string };

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function validDate(year: number, month: number, day: number) {
  const date = new Date(year, month - 1, day, 12);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null;
}

export function nextMondayKey(now = new Date()) {
  const day = now.getDay() || 7;
  return localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + (8 - day), 12));
}

export function parsePostponeIntent(text: string, now = new Date()): PostponeIntent | null {
  const normalized = text.trim();
  if (!/(?:推到|挪到|延期|延后|再说|改到|先不|等.+再)/.test(normalized)) return null;
  const subjectHint = normalized.replace(/白云[，,\s]*/g, '').replace(/(?:推到|挪到|延期到|延后到|改到|下周再说|明天再说|今天不做|先不).*/g, '').trim();
  if (/明天|明日/.test(normalized)) return { target: { kind: 'tomorrow' }, needsDate: false, subjectHint };
  if (/下周/.test(normalized)) return { target: { kind: 'next_week' }, needsDate: false, subjectHint };
  const explicit = normalized.match(/(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/);
  if (explicit) {
    const date = validDate(Number(explicit[1]), Number(explicit[2]), Number(explicit[3]));
    return date ? { target: { kind: 'specific_date', date: localDateKey(date) }, needsDate: false, subjectHint } : { needsDate: true, subjectHint };
  }
  const monthDay = normalized.match(/(\d{1,2})月(\d{1,2})[号日]?/);
  if (monthDay) {
    let date = validDate(now.getFullYear(), Number(monthDay[1]), Number(monthDay[2]));
    if (date && date.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) date = validDate(now.getFullYear() + 1, Number(monthDay[1]), Number(monthDay[2]));
    return date ? { target: { kind: 'specific_date', date: localDateKey(date) }, needsDate: false, subjectHint } : { needsDate: true, subjectHint };
  }
  const weekday = normalized.match(/(?:周|星期)([一二三四五六日天])/);
  if (weekday) {
    const targetDay = '日一二三四五六'.indexOf(weekday[1] === '天' ? '日' : weekday[1]);
    let distance = (targetDay - now.getDay() + 7) % 7;
    if (!distance) distance = 7;
    return { target: { kind: 'specific_date', date: localDateKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + distance, 12)) }, needsDate: false, subjectHint };
  }
  return { needsDate: true, subjectHint };
}
