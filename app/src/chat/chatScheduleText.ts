import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { ClassifiedTask, ScheduleConstraint } from '../schedule/dayScheduler';
import type { Habit } from '../schedule/habitStore';
import { looksLikeScheduleCompletionCommand, resolveScheduleDate } from '../schedule/schedulePlanner';
import { dateKey, type ScheduleDraft, type ScheduleOccurrence } from '../schedule/scheduleStore';
import type { TodoItem } from '../schedule/todoStore';

export const DAY_MS = 24 * 60 * 60 * 1000;

export function formatScheduleDraftDateTime(draft: ScheduleDraft) {
  return new Date(draft.startAt).toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatScheduleDraftReminder(draft: ScheduleDraft) {
  if (draft.reminderMinutesBefore <= 0) return '到点提醒';
  return `提前 ${draft.reminderMinutesBefore} 分钟提醒`;
}

export function scheduleTextScore(occurrence: ScheduleOccurrence, text: string) {
  const haystack = `${occurrence.title} ${occurrence.notes}`.toLowerCase();
  const normalized = text.toLowerCase();
  let score = 0;
  if (normalized.includes(occurrence.title.toLowerCase())) score += 8;
  for (const token of normalized.split(/[^\u3400-\u9fff\w]+/).filter((entry) => entry.length >= 2)) {
    if (haystack.includes(token)) score += 2;
  }
  if (/今晚|晚上|夜里/.test(text)) {
    const hour = new Date(occurrence.scheduledStartAt).getHours();
    if (hour >= 18 && hour <= 23) score += 2;
  }
  if (/明天/.test(text)) {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
    if (new Date(occurrence.scheduledStartAt).toDateString() === tomorrow.toDateString()) score += 2;
  }
  return score;
}

const TODO_COMPLETION_ACK_PATTERN = /^(?:完成了|做完了|搞定了|弄完了|好了|结束了)(?:啦|喽|咯|啊|呀|！|!|。|~|～)?$/;
const TODO_COMPLETION_QUESTION_PATTERN = /(?:完成|做完|搞定|处理完).{0,6}(?:吗|嘛|么|\?|？|没有|没)/;

export function looksLikeTodoCompletionAck(text: string, replyingToMessage?: SubjectiveMessage | null) {
  const normalized = text.trim();
  if (!normalized || normalized.length > 90) return false;
  if (TODO_COMPLETION_QUESTION_PATTERN.test(normalized)) return false;
  if (looksLikeScheduleCompletionCommand(normalized)) return true;
  const isReplyingToReminder = replyingToMessage?.source === 'schedule-companion'
    || replyingToMessage?.source === 'schedule-reminder'
    || replyingToMessage?.source === 'todo-reminder';
  return !!isReplyingToReminder && TODO_COMPLETION_ACK_PATTERN.test(normalized);
}

export function todoTextScore(item: TodoItem, text: string) {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  const title = item.title.replace(/\s+/g, '').toLowerCase();
  if (!normalized || !title) return 0;
  let score = normalized.includes(title) ? 10 : 0;
  for (const token of title.split(/[^\u3400-\u9fff\w]+/).filter((entry) => entry.length >= 2)) {
    if (normalized.includes(token)) score += token.length >= 4 ? 3 : 2;
  }
  if (item.notes) {
    const notes = item.notes.replace(/\s+/g, '').toLowerCase();
    if (notes && normalized.includes(notes.slice(0, 18))) score += 2;
  }
  return score;
}

const CHINESE_HOUR_MAP: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
};

function parseChineseHour(value: string) {
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (value === '十') return 10;
  if (value.startsWith('十')) return 10 + (CHINESE_HOUR_MAP[value.slice(1)] ?? 0);
  if (value.endsWith('十')) return (CHINESE_HOUR_MAP[value.slice(0, -1)] ?? 0) * 10;
  if (value.includes('十')) {
    const [left, right] = value.split('十');
    return (CHINESE_HOUR_MAP[left] ?? 1) * 10 + (CHINESE_HOUR_MAP[right] ?? 0);
  }
  return CHINESE_HOUR_MAP[value];
}

export function extractClockFromText(text: string) {
  const digital = text.match(/(?:^|[^\d])([01]?\d|2[0-3])[:：点]([0-5]\d)(?:分)?/);
  if (digital) {
    const hour = Number(digital[1]);
    const minute = Number(digital[2]);
    return Number.isFinite(hour) && Number.isFinite(minute) ? { hour, minute } : undefined;
  }
  const half = text.match(/([零一二两三四五六七八九十]{1,3}|\d{1,2})点半/);
  if (half) {
    const hour = parseChineseHour(half[1]);
    return hour !== undefined && hour >= 0 && hour <= 23 ? { hour, minute: 30 } : undefined;
  }
  const hourOnly = text.match(/([零一二两三四五六七八九十]{1,3}|\d{1,2})点/);
  if (hourOnly) {
    const hour = parseChineseHour(hourOnly[1]);
    return hour !== undefined && hour >= 0 && hour <= 23 ? { hour, minute: 0 } : undefined;
  }
  return undefined;
}

export function dateAtClockFromKey(day: string, clock: { hour: number; minute: number }) {
  const date = new Date(`${day}T12:00:00`);
  date.setHours(clock.hour, clock.minute, 0, 0);
  return date.getTime();
}

type BulkScheduleDeleteScope = {
  startAt: number;
  endAt: number;
  label: string;
};

function dayRangeFromKey(day: string, label: string): BulkScheduleDeleteScope {
  const startAt = dateAtClockFromKey(day, { hour: 0, minute: 0 });
  return { startAt, endAt: startAt + DAY_MS, label };
}

export function resolveBulkScheduleDeleteScope(text: string, now = Date.now()): BulkScheduleDeleteScope | null {
  const normalized = text.replace(/\s+/g, '');
  const hasScheduleNoun = /日程|安排|提醒/.test(normalized);
  const hasDeleteVerb = /删|删除|取消|清除|清空|撤掉|去掉|移除|不用/.test(normalized);
  const hasBulkWord = /全部|所有|已有|现有|当前|清空|清除|一并|都/.test(normalized);
  if (!hasScheduleNoun || !hasDeleteVerb || !hasBulkWord) return null;

  if (/昨天/.test(normalized)) return dayRangeFromKey(dateKey(now - DAY_MS), '昨天的日程');
  if (/今天|今日/.test(normalized)) return dayRangeFromKey(dateKey(now), '今天的日程');
  if (/明天/.test(normalized)) return dayRangeFromKey(dateKey(now + DAY_MS), '明天的日程');
  if (/后天/.test(normalized)) return dayRangeFromKey(dateKey(now + 2 * DAY_MS), '后天的日程');

  const explicitDate = resolveScheduleDate(text);
  if (explicitDate) return dayRangeFromKey(explicitDate, `${explicitDate} 的日程`);

  return {
    startAt: now - DAY_MS,
    endAt: now + 90 * DAY_MS,
    label: '已有未完成日程',
  };
}

export function clockToHHMM(clock: { hour: number; minute: number }, context: string) {
  let hour = clock.hour;
  if (/下午|晚上|傍晚|夜里/.test(context) && hour >= 1 && hour <= 11) hour += 12;
  if (/中午/.test(context) && hour >= 1 && hour <= 5) hour += 12;
  return `${String(hour).padStart(2, '0')}:${String(clock.minute).padStart(2, '0')}`;
}

export function inferScheduleConstraintsFromText(tasks: ClassifiedTask[], text: string): ScheduleConstraint[] {
  const chunks = text
    .split(/[\n。；;，,、]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const constraints: ScheduleConstraint[] = [];
  tasks.forEach((task) => {
    const normalizedTitle = task.title.replace(/\s+/g, '');
    const chunk = chunks.find((item) => {
      const normalized = item.replace(/\s+/g, '');
      return normalized.includes(normalizedTitle) || normalizedTitle.includes(normalized);
    });
    if (!chunk) return;
    const clock = extractClockFromText(chunk);
    const preferredPeriod = /上午|早上|早晨/.test(chunk)
      ? 'morning'
      : /下午|午后/.test(chunk)
        ? 'afternoon'
        : /晚上|傍晚|夜里/.test(chunk)
          ? 'evening'
          : undefined;
    if (clock || preferredPeriod) {
      constraints.push({
        taskId: task.id,
        fixedStartTime: clock ? clockToHHMM(clock, chunk) : undefined,
        preferredPeriod,
      });
    }
  });
  return constraints;
}

export function formatChatDateTime(value: number) {
  return new Date(value).toLocaleString('zh-CN', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function formatTodoDate(value?: string) {
  return value ? value : '待办池';
}

export function selectClearCandidate<T extends { score: number }>(candidates: T[]) {
  const ranked = candidates.filter((item) => item.score > 0).sort((left, right) => right.score - left.score);
  if (!ranked.length) return undefined;
  if (ranked.length === 1 || ranked[0].score >= ranked[1].score + 2) return ranked[0];
  return undefined;
}

const HABIT_RULE_CHANGE_PATTERN = /(?:习惯|打卡|每日|每天).{0,36}(?:改成|改为|调整|修改|设置|设成|变成|换成|改到)|(?:改成|改为|调整|修改|设置|设成|变成|换成|改到).{0,36}(?:习惯|打卡|每日|每天)/;

export function looksLikeHabitRuleChange(text: string) {
  const normalized = text.trim();
  if (!normalized) return false;
  if (!/(?:习惯|打卡|每日|每天)/.test(normalized)) return false;
  if (!HABIT_RULE_CHANGE_PATTERN.test(normalized)) return false;
  return /(?:次|点|:|：|每天|每日|每周|自定义|中午|上午|下午|晚上|早上)/.test(normalized);
}

function parseChineseCount(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  return parseChineseHour(value);
}

export function extractHabitTargetCount(text: string) {
  const match = text.match(/(?:每天|每日|一天|每一天).{0,12}?([零一二两三四五六七八九十\d]{1,3})\s*次/);
  if (!match) return undefined;
  const count = parseChineseCount(match[1]);
  return count !== undefined && count >= 1 && count <= 12 ? count : undefined;
}

export function extractHabitReminderTimes(text: string) {
  const results: string[] = [];
  const seen = new Set<string>();
  const clockPattern = /(?:凌晨|早上|上午|中午|下午|傍晚|晚上|夜里)?\s*([零一二两三四五六七八九十]{1,3}|\d{1,2})(?:[:：点])(?:(半)|([0-5]\d)(?:分)?)?/g;
  for (const match of text.matchAll(clockPattern)) {
    const hour = parseChineseHour(match[1]);
    if (hour === undefined || hour < 0 || hour > 23) continue;
    const minute = match[2] ? 30 : match[3] ? Number(match[3]) : 0;
    if (!Number.isFinite(minute) || minute < 0 || minute > 59) continue;
    const context = text.slice(Math.max(0, (match.index ?? 0) - 4), (match.index ?? 0) + match[0].length);
    const value = clockToHHMM({ hour, minute }, context);
    if (!seen.has(value)) {
      seen.add(value);
      results.push(value);
    }
  }
  return results;
}

export function habitTextScore(habit: Habit, text: string) {
  const normalized = text.replace(/\s+/g, '').toLowerCase();
  const title = habit.title.replace(/\s+/g, '').toLowerCase();
  if (!normalized || !title) return 0;
  let score = normalized.includes(title) ? 20 : 0;
  const uniqueChars = [...new Set(title.split(''))].filter((char) => /[\u3400-\u9fff\w]/.test(char));
  score += uniqueChars.filter((char) => normalized.includes(char)).length;
  if (/习惯|打卡/.test(normalized)) score += 1;
  return score;
}

export function looksLikeHabitListQuery(text: string) {
  const normalized = text.trim();
  if (!normalized || !/(?:习惯|打卡)/.test(normalized)) return false;
  if (looksLikeHabitRuleChange(normalized)) return false;
  return /(?:现在|当前|目前|已有|有哪些|有什么|列表|都有什么|都有哪些|还剩|还在|日程现在).{0,20}(?:习惯|打卡)|(?:习惯|打卡).{0,20}(?:现在|当前|目前|已有|有哪些|有什么|列表|都有什么|都有哪些|还剩|还在)/.test(normalized);
}

export function formatHabitFrequency(frequency: Habit['frequency'], weekDays: number[]) {
  if (frequency === 'daily') return '每天';
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (frequency === 'weekly') return weekDays.length ? `每周 ${weekDays.map((day) => labels[day] ?? `周${day}`).join('、')}` : '每周';
  return weekDays.length ? `自定义 ${weekDays.map((day) => labels[day] ?? `周${day}`).join('、')}` : '自定义';
}

function pickTodoCompletionCandidate(items: TodoItem[], text: string, messages: SubjectiveMessage[]) {
  const context = messages
    .slice(-8)
    .map((message) => message.content)
    .join('\n');
  if (items.length === 1) return items[0];
  const ranked = items
    .map((item) => ({
      item,
      score: todoTextScore(item, `${text}\n${context}`) + (item.reminderStage > 0 ? 2 : 0),
    }))
    .sort((left, right) => right.score - left.score || right.item.updatedAt - left.item.updatedAt);
  const best = ranked[0];
  const second = ranked[1];
  if (!best || best.score < 2) return null;
  if (second && best.score === second.score) return null;
  return best.item;
}
