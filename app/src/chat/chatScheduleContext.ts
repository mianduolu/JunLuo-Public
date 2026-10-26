import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  loadPendingScheduleOccurrencesBetween,
  loadScheduleOccurrence,
  type ScheduleOccurrence,
} from '../schedule/scheduleStore';

const SCHEDULE_NUDGE_LOOKAHEAD_MS = 10 * 60 * 1000;
const SCHEDULE_NUDGE_LOOKBEHIND_MS = 6 * 60 * 60 * 1000;
const SCHEDULE_NUDGE_OVERDUE_MS = 45 * 60 * 1000;
const SCHEDULE_NUDGE_COOLDOWN_MS = 5 * 60 * 1000;

export type ScheduleNudgeState = {
  occurrenceId: string;
  nudgedAt: number;
};

export type ScheduleNudgeContext = {
  context: string;
  occurrenceId: string;
};

export function formatScheduleDateTime(timestamp: number) {
  return new Date(timestamp).toLocaleString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function describeScheduleTiming(occurrence: ScheduleOccurrence, now = Date.now()) {
  const minutesToStart = Math.round((occurrence.scheduledStartAt - now) / 60000);
  const reminderLead = occurrence.reminderMinutesBefore;
  const leadText = reminderLead > 0 ? `提前 ${reminderLead} 分钟提醒` : '到点提醒';

  if (minutesToStart > 0) {
    return `${leadText}，现在距离正式日程还有约 ${minutesToStart} 分钟`;
  }
  if (minutesToStart === 0) {
    return `${leadText}，现在正接近正式日程时间`;
  }
  return `${leadText}，正式日程已过去约 ${Math.abs(minutesToStart)} 分钟`;
}

export async function buildRecentScheduleReminderContext(messages: SubjectiveMessage[]) {
  const occurrenceIds = [
    ...new Set(
      messages
        .slice(-24)
        .reverse()
        .map((message) => (message.source === 'schedule-reminder' ? message.scheduleOccurrenceId : undefined))
        .filter((id): id is string => !!id),
    ),
  ].slice(0, 3);

  if (!occurrenceIds.length) return '';

  const occurrences = (await Promise.all(occurrenceIds.map(loadScheduleOccurrence))).filter(
    (occurrence): occurrence is ScheduleOccurrence => !!occurrence,
  );

  if (!occurrences.length) return '';

  const lines = occurrences.map((occurrence, index) => {
    const notes = occurrence.notes.trim() ? `\n  备注：${occurrence.notes.trim()}` : '';
    return `${index + 1}. 标题：${occurrence.title}
  正式日程时间：${formatScheduleDateTime(occurrence.scheduledStartAt)}
  提醒触发时间：${formatScheduleDateTime(occurrence.reminderAt)}
  提醒关系：${describeScheduleTiming(occurrence)}${notes}`;
  });

  return `【最近触发的日程提醒】
聊天里刚出现过日程提醒时，小仓鼠后续说“刚才那个提醒”“不是九点整”“提前二十分钟”“看动画片”等内容，要优先参考这里的真实日程信息，不要只根据聊天文字猜测时间。
${lines.join('\n')}`;
}

function getOccurrenceEndAt(occurrence: ScheduleOccurrence) {
  return occurrence.endAt ?? occurrence.scheduledStartAt + 30 * 60 * 1000;
}

function getCurrentScheduleNudgeReason(occurrence: ScheduleOccurrence, now: number) {
  const minutesToStart = Math.round((occurrence.scheduledStartAt - now) / 60000);
  const endAt = getOccurrenceEndAt(occurrence);
  if (occurrence.scheduledStartAt <= now && endAt >= now) {
    const minutesToEnd = Math.max(0, Math.round((endAt - now) / 60000));
    return `这项正在进行中，距离计划结束约 ${minutesToEnd} 分钟`;
  }
  if (occurrence.scheduledStartAt <= now) {
    return `这项已经到点约 ${Math.abs(minutesToStart)} 分钟，还没有标记完成`;
  }
  return `这项还有约 ${minutesToStart} 分钟开始，可以先收一下心、准备第一步`;
}

function getScheduleNudgePriority(occurrence: ScheduleOccurrence, now: number) {
  const endAt = getOccurrenceEndAt(occurrence);
  if (occurrence.scheduledStartAt <= now && endAt >= now) return 0;
  if (occurrence.scheduledStartAt <= now) return 1;
  return 2;
}

export function buildScheduleNudgeLifeModeInstruction(lifeMode: string) {
  if (lifeMode === 'self-time') {
    return '我现在忙自己的事；如果顺手催促这项日程，要像提前留下的小纸条，不要说自己刚刚赶来现场。';
  }
  if (lifeMode === 'sleeping') {
    return '我现在睡着或半梦半醒；如果必须提到这项日程，只能很短地像迷糊梦话，不能假装完全清醒或长篇催促。';
  }
  return '我现在在线；如果自然提到这项日程，可以温柔催一下，但不要羞辱、施压或长篇说教。';
}

export async function buildCurrentScheduleNudgeContext(
  lastNudge: ScheduleNudgeState | null,
  readOnly = false,
): Promise<ScheduleNudgeContext | null> {
  const now = Date.now();
  if (lastNudge && now - lastNudge.nudgedAt < SCHEDULE_NUDGE_COOLDOWN_MS) return null;

  const occurrences = await loadPendingScheduleOccurrencesBetween(
    now - SCHEDULE_NUDGE_LOOKBEHIND_MS,
    now + SCHEDULE_NUDGE_LOOKAHEAD_MS,
    readOnly,
  );
  const candidates = occurrences.filter((occurrence) => {
    if (occurrence.owner === 'I') return false;
    const endAt = getOccurrenceEndAt(occurrence);
    const isUpcoming = occurrence.scheduledStartAt > now && occurrence.scheduledStartAt - now <= SCHEDULE_NUDGE_LOOKAHEAD_MS;
    const isActive = occurrence.scheduledStartAt <= now && endAt >= now;
    const isRecentlyOverdue = occurrence.scheduledStartAt <= now && now - occurrence.scheduledStartAt <= SCHEDULE_NUDGE_OVERDUE_MS;
    return isUpcoming || isActive || isRecentlyOverdue;
  });
  if (!candidates.length) return null;

  candidates.sort((left, right) => {
    const priorityDiff = getScheduleNudgePriority(left, now) - getScheduleNudgePriority(right, now);
    if (priorityDiff) return priorityDiff;
    return Math.abs(left.scheduledStartAt - now) - Math.abs(right.scheduledStartAt - now);
  });
  const occurrence = candidates[0];
  if (lastNudge?.occurrenceId === occurrence.id && now - lastNudge.nudgedAt < SCHEDULE_NUDGE_COOLDOWN_MS) return null;

  const notes = occurrence.notes.trim() ? `\n备注：${occurrence.notes.trim()}` : '';
  return {
    occurrenceId: occurrence.id,
    context: `【当前日程催促】
现在有一项日程需要白云温柔看住小仓鼠：
标题：${occurrence.title}
时间：${formatScheduleDateTime(occurrence.scheduledStartAt)}${occurrence.endAt ? ` - ${formatScheduleDateTime(occurrence.endAt)}` : ''}
状态：${getCurrentScheduleNudgeReason(occurrence, now)}${notes}
回复规则：如果小仓鼠正在聊无关内容或停在原地，可以自然带一句很短的催促，把她引向最小下一步；不要羞辱、不要施压、不要长篇说教。若她明显在求安抚或很崩溃，先接住情绪，再轻轻给一个可以开始的微动作。`,
  };
}
