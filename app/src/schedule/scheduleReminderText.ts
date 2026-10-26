import type { ScheduleOccurrence } from './scheduleStore';

export function getScheduleReminderLeadText(occurrence: ScheduleOccurrence, referenceTime = Date.now()) {
  const minutesUntilSchedule = Math.round((occurrence.scheduledStartAt - referenceTime) / 60000);

  if (minutesUntilSchedule > 0) {
    return `小仓鼠，离**${occurrence.title}**还有 ${minutesUntilSchedule} 分钟啦，我们先慢慢准备一下吧！☁♪`;
  }

  return `小仓鼠，**${occurrence.title}**的时间已经到咯！☁💦该去做这件事啦！💞`;
}

export function reminderLeadLooksSpecific(text: string, occurrence: ScheduleOccurrence) {
  const hasTitle = text.includes(occurrence.title);
  const hasTiming = /还有\s*\d+\s*分钟|已经到|到时间|到咯|快到|该去|开始|准备/.test(text);
  return hasTitle && hasTiming;
}
