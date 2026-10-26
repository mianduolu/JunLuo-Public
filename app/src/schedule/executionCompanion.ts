import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import { cancelNotifications, syncScheduleNotifications } from './scheduleNotifications';
import {
  loadPendingScheduleCompanionResponse as loadLatestPendingCompanionResponse,
  loadScheduleCompanionResponseById,
  closeScheduleCompanionOccurrence,
  respondToScheduleCompanionEvent,
  removeScheduleCompanionEvents,
} from './scheduleCompanionStore';
import { extendSchedulePlanSlot, loadScheduleOccurrence, postponeScheduleOccurrenceToTomorrow } from './scheduleStore';
import { completeScheduleOccurrenceOnce } from './scheduleCompletionOnce';
import { postponeTodoToTomorrow } from './todoStore';
import { type ParsedScheduleCompanionResponse } from './companionResponseLogic';
export { parseScheduleCompanionResponse } from './companionResponseLogic';
export type { ParsedScheduleCompanionResponse, ScheduleCompanionResponse } from './companionResponseLogic';

export async function loadPendingScheduleCompanionResponse(eventId?: string) {
  return eventId ? loadScheduleCompanionResponseById(eventId) : loadLatestPendingCompanionResponse();
}

export async function applyScheduleCompanionResponse(
  eventId: string,
  parsed: ParsedScheduleCompanionResponse,
) {
  const pending = await loadScheduleCompanionResponseById(eventId);
  if (!pending) return { ok: false as const, message: '这个时间块已经安静下来啦。' };
  const occurrence = await loadScheduleOccurrence(pending.occurrenceId);
  if (!occurrence) return { ok: false as const, message: '这个时间块已经找不到了，可能刚刚被调整过。' };

  if (parsed.kind === 'done') {
    await completeScheduleOccurrenceOnce(occurrence.id);
    const notificationIds = await closeScheduleCompanionOccurrence(occurrence.id);
    await cancelNotifications(notificationIds);
    return { ok: true as const, message: '收到，白云帮鼠把这一格稳稳地收好啦。' };
  }

  if (parsed.kind === 'extend') {
    const minutes = Math.max(5, parsed.extendMinutes ?? 30);
    const result = await extendSchedulePlanSlot(occurrence.id, minutes);
    if (!result.ok) return { ok: false as const, message: result.reason };
    const notificationIds = await removeScheduleCompanionEvents(result.invalidatedOccurrenceIds);
    await cancelNotifications([...notificationIds, ...result.notificationIds]);
    await syncScheduleNotifications();
    return { ok: true as const, message: `好，给“${occurrence.title}”再留 ${minutes} 分钟，后面的同组安排也一起顺延了。` };
  }

  if (parsed.kind === 'tomorrow') {
    if (occurrence.todoId) await postponeTodoToTomorrow(occurrence.todoId);
    const moved = await postponeScheduleOccurrenceToTomorrow(occurrence.id);
    if (!moved.ok) return { ok: false as const, message: '这条不是可以单独推到明天的 AI 时间块，我先没有改数据库。' };
    const notificationIds = await closeScheduleCompanionOccurrence(occurrence.id);
    await cancelNotifications([...notificationIds, ...moved.notificationIds]);
    await syncScheduleNotifications();
    return { ok: true as const, message: '好，这个时间块和关联待办一起放到明天。今天不再追着鼠问啦。' };
  }

  const notificationIds = await respondToScheduleCompanionEvent(eventId);
  await cancelNotifications(notificationIds);
  return {
    ok: true as const,
    message: parsed.kind === 'stuck'
      ? '卡住也算重要进度。鼠愿意的话，把卡住的那一步发给我，我们一起拆小一点。'
      : '好，先停在这里喘口气。白云不会偷偷改掉后面的安排。',
  };
}

export function companionReplyMessage(content: string): SubjectiveMessage {
  return createSubjectiveMessage('I', content, { source: 'schedule-companion' });
}
