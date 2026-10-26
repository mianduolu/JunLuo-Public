export type ReminderAlarmIntentRoute = {
  candidateTools: string[];
  reason: 'reminder_create' | 'alarm_create' | 'alarm_strong_create' | 'alarm_list';
};

const EXPLICIT_TIMESTAMP_PATTERN = /(?:timestamp|时间戳)\s*[:：=]?\s*(\d{10,13})/i;
const ISO_LIKE_PATTERN = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T日]?\s*(\d{1,2})[:：点](\d{1,2})?/;
const TODAY_TOMORROW_TIME_PATTERN = /(今天|明天)\s*(\d{1,2})[:：点](\d{1,2})?/;
const DATE_CLOCK_TIME_PATTERN = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|号)?\s*(凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*([零〇一二两三四五六七八九十]{1,3}|\d{1,2})\s*(?:[:：点时])\s*(?:(半)|([零〇一二两三四五六七八九十]{1,3}|[0-5]?\d)\s*(?:分)?)?/;
const NATURAL_CLOCK_TIME_PATTERN = /(今天|明天|后天|明早|明晚)?\s*(凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*([零〇一二两三四五六七八九十]{1,3}|\d{1,2})\s*(?:[:：点时])\s*(?:(半)|([零〇一二两三四五六七八九十]{1,3}|[0-5]?\d)\s*(?:分)?)?/;
const RELATIVE_TIME_PATTERN = /(\d{1,3}|[零〇一二两三四五六七八九十百]{1,8}|半)\s*(分钟|分|小时|个小时|h|hour|hours)\s*后/i;
const MUSIC_ALARM_PATTERN = /(?:音乐闹钟|放歌|播放.{0,24}(?:叫醒|叫我|提醒|闹钟)|用.{0,24}(?:歌|音乐).{0,16}(?:叫醒|叫我|提醒|闹钟)|(?:叫醒|提醒).{0,24}(?:放歌|播放|音乐))/;
const STRONG_ALARM_PATTERN = /(?:强闹钟|强提醒|大声闹钟|大声(?:叫醒|叫我)|一定(?:叫醒|叫我)|用力(?:叫醒|叫我)|睡死.{0,10}(?:叫醒|叫我)|叫不醒|真(?:的)?闹钟)/;
const STRONG_ALARM_TITLE_PATTERN = /强闹钟|强提醒|大声闹钟|大声(?:叫醒|叫我)?|一定(?:叫醒|叫我)?|用力(?:叫醒|叫我)?|睡死.{0,10}(?:叫醒|叫我)|叫不醒|真(?:的)?闹钟/g;

function startOfToday(now = Date.now()) {
  const value = new Date(now);
  value.setHours(0, 0, 0, 0);
  return value;
}

function parseChineseAmount(raw: string): number | undefined {
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === '半') return 0.5;
  const digits: Record<string, number> = {
    零: 0,
    '〇': 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (raw.length === 1) return digits[raw];
  if (raw.includes('百')) {
    const [hundredsRaw, restRaw = ''] = raw.split('百');
    const hundreds = hundredsRaw ? digits[hundredsRaw] : 1;
    const rest: number | undefined = restRaw ? parseChineseAmount(restRaw) : 0;
    return typeof hundreds === 'number' && typeof rest === 'number' ? hundreds * 100 + rest : undefined;
  }
  if (raw.includes('十')) {
    const [tensRaw, onesRaw = ''] = raw.split('十');
    const tens = tensRaw ? digits[tensRaw] : 1;
    const ones = onesRaw ? digits[onesRaw] : 0;
    return typeof tens === 'number' && typeof ones === 'number' ? tens * 10 + ones : undefined;
  }
  return undefined;
}

function normalizeClockHour(hour: number, period?: string) {
  if (!period) return hour;
  if (/下午|傍晚|晚上/.test(period) && hour < 12) return hour + 12;
  if (/中午/.test(period) && hour >= 1 && hour <= 10) return hour + 12;
  if (/凌晨|清晨|早上|早晨|上午|夜里/.test(period) && hour === 12) return 0;
  return hour;
}

function parseClockParts(rawHour: string, half?: string, rawMinute?: string, period?: string) {
  const hourAmount = parseChineseAmount(rawHour);
  if (typeof hourAmount !== 'number' || !Number.isInteger(hourAmount)) return null;
  const minuteAmount = half ? 30 : rawMinute ? parseChineseAmount(rawMinute) : 0;
  if (typeof minuteAmount !== 'number' || !Number.isInteger(minuteAmount)) return null;
  const hour = normalizeClockHour(hourAmount, period);
  if (hour < 0 || hour > 23 || minuteAmount < 0 || minuteAmount > 59) return null;
  return { hour, minute: minuteAmount };
}

function parseDateClockTime(text: string, now: number) {
  const match = DATE_CLOCK_TIME_PATTERN.exec(text);
  if (!match) return undefined;
  const [, rawYear, rawMonth, rawDay, rawPeriod, rawHour, half, rawMinute] = match;
  const parts = parseClockParts(rawHour, half, rawMinute, rawPeriod);
  if (!parts) return undefined;
  const nowDate = new Date(now);
  const year = rawYear ? Number(rawYear) : nowDate.getFullYear();
  const value = new Date(year, Number(rawMonth) - 1, Number(rawDay), parts.hour, parts.minute, 0, 0);
  if (!rawYear && value.getTime() <= now) value.setFullYear(value.getFullYear() + 1);
  const timestamp = value.getTime();
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function parseNaturalClockTime(text: string, now: number) {
  const match = NATURAL_CLOCK_TIME_PATTERN.exec(text);
  if (!match) return undefined;
  const [, rawDay, rawPeriod, rawHour, half, rawMinute] = match;
  const parts = parseClockParts(rawHour, half, rawMinute, rawPeriod);
  if (!parts) return undefined;

  const value = startOfToday(now);
  if (rawDay === '明天' || rawDay === '明早' || rawDay === '明晚') value.setDate(value.getDate() + 1);
  if (rawDay === '后天') value.setDate(value.getDate() + 2);
  value.setHours(parts.hour, parts.minute, 0, 0);
  if (!rawDay && value.getTime() <= now) value.setDate(value.getDate() + 1);
  return value.getTime();
}

export function parseReminderAlarmTriggerAtFromText(text: string, now = Date.now()) {
  const timestampMatch = EXPLICIT_TIMESTAMP_PATTERN.exec(text);
  if (timestampMatch) {
    const raw = Number(timestampMatch[1]);
    return raw < 10_000_000_000 ? raw * 1000 : raw;
  }

  const isoMatch = ISO_LIKE_PATTERN.exec(text);
  if (isoMatch) {
    const [, year, month, day, hour, minute] = isoMatch;
    const value = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute ?? 0), 0, 0);
    const timestamp = value.getTime();
    return Number.isFinite(timestamp) ? timestamp : undefined;
  }

  const dateClockTime = parseDateClockTime(text, now);
  if (dateClockTime) return dateClockTime;

  const dayTimeMatch = TODAY_TOMORROW_TIME_PATTERN.exec(text);
  if (dayTimeMatch) {
    const [, dayText, hour, minute] = dayTimeMatch;
    const value = startOfToday(now);
    if (dayText === '明天') value.setDate(value.getDate() + 1);
    value.setHours(Number(hour), Number(minute ?? 0), 0, 0);
    return value.getTime();
  }

  const naturalClockTime = parseNaturalClockTime(text, now);
  if (naturalClockTime) return naturalClockTime;

  const relativeMatch = RELATIVE_TIME_PATTERN.exec(text);
  if (relativeMatch) {
    const amount = parseChineseAmount(relativeMatch[1]);
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) return undefined;
    const unit = relativeMatch[2];
    const multiplier = /小时|h|hour/i.test(unit) ? 60 * 60 * 1000 : 60 * 1000;
    return now + amount * multiplier;
  }

  return undefined;
}

function cleanTitle(text: string) {
  return text
    .replace(EXPLICIT_TIMESTAMP_PATTERN, '')
    .replace(ISO_LIKE_PATTERN, '')
    .replace(DATE_CLOCK_TIME_PATTERN, '')
    .replace(TODAY_TOMORROW_TIME_PATTERN, '')
    .replace(NATURAL_CLOCK_TIME_PATTERN, '')
    .replace(RELATIVE_TIME_PATTERN, '')
    .replace(STRONG_ALARM_TITLE_PATTERN, '')
    .replace(/(^|\s)强(?=\s|$)/g, ' ')
    .replace(/帮我|请|到点|到时候|记得|提醒我|提醒一下我|提醒|叫醒我|叫我|闹钟|音乐闹钟|放歌|播放|用|当|作为|设(?:个|一个)?|安排|白云|来找我|找我|说一句|跟我说/g, '')
    .replace(/[：:，,。.!！?？]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMusicKeyword(text: string) {
  const cleaned = cleanTitle(text);
  const patterns = [
    /用(.{1,40}?)(?:叫醒|叫我|提醒|当闹钟|做闹钟)/,
    /(?:播放|放)(?:一首)?(.{1,40}?)(?:叫醒|叫我|提醒|当闹钟|做闹钟|$)/,
    /(?:音乐闹钟|放歌|播放)(?:[:： ]+)(.{1,40})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const value = match?.[1]?.trim();
    if (value) return cleanTitle(value);
  }
  return cleaned && !/^(歌|音乐)$/.test(cleaned) ? cleaned : undefined;
}

export function routeReminderAlarmIntent(text: string): ReminderAlarmIntentRoute | null {
  if (STRONG_ALARM_PATTERN.test(text)) {
    return { candidateTools: ['alarm.strong_create'], reason: 'alarm_strong_create' };
  }
  if (MUSIC_ALARM_PATTERN.test(text)) {
    return { candidateTools: ['alarm.create'], reason: 'alarm_create' };
  }
  if (/(?:闹钟|叫醒我|叫我起床|起床叫我|看一下闹钟|列出闹钟|闹钟列表)/.test(text)) {
    if (/(?:看一下|列出|列表|有哪些|还有哪些)/.test(text)) {
      return { candidateTools: ['alarm.list'], reason: 'alarm_list' };
    }
    return { candidateTools: ['alarm.create'], reason: 'alarm_create' };
  }
  if (/(?:提醒我|提醒一下我|记得提醒|别忘了提醒|到时候提醒|到点提醒)/.test(text)) {
    return { candidateTools: ['reminder.create'], reason: 'reminder_create' };
  }
  return null;
}

export function parseReminderCreateInputFromText(text: string) {
  const triggerAt = parseReminderAlarmTriggerAtFromText(text);
  if (!triggerAt) return null;
  const title = cleanTitle(text) || '提醒';
  return {
    title,
    triggerAt,
    reminderText: title,
  };
}

export function parseAlarmCreateInputFromText(text: string) {
  const triggerAt = parseReminderAlarmTriggerAtFromText(text);
  if (!triggerAt) return null;
  const title = cleanTitle(text) || '君落闹钟';
  const isMusicAlarm = MUSIC_ALARM_PATTERN.test(text);
  const musicKeyword = isMusicAlarm ? extractMusicKeyword(text) : undefined;
  return {
    title,
    triggerAt,
    message: title,
    ...(isMusicAlarm ? { musicKeyword, soundMode: 'music' } : {}),
  };
}

export function parseStrongAlarmCreateInputFromText(text: string) {
  const triggerAt = parseReminderAlarmTriggerAtFromText(text);
  if (!triggerAt) return null;
  const title = cleanTitle(text) || '闹钟';
  return {
    title,
    triggerAt,
    message: title,
    vibrate: !/(?:不震动|不要震动|别震动)/.test(text),
  };
}
