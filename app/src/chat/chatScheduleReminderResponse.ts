import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { ParsedScheduleCompanionResponse } from '../schedule/companionResponseLogic';

// 引用只确定回应对象，含义仍交给现有模型；普通聊天不查找最近提醒。
export async function resolveChatScheduleReminderResponse<Pending extends { id: string }>(options: {
  replyingToMessage: SubjectiveMessage | null | undefined;
  text: string;
  configured: boolean;
  isCurrent: () => boolean;
  loadPending: (eventId: string) => Promise<Pending | null>;
  classify: (text: string) => Promise<ParsedScheduleCompanionResponse>;
}): Promise<{ pending: Pending; parsed: ParsedScheduleCompanionResponse } | null> {
  const message = options.replyingToMessage;
  const eventId = message?.source === 'schedule-companion' ? message.scheduleCompanionEventId : undefined;
  if (!eventId || !options.configured || !options.isCurrent()) return null;
  try {
    const pending = await options.loadPending(eventId);
    if (!pending || pending.id !== eventId || !options.isCurrent()) return null;
    const parsed = await options.classify(options.text);
    if (!options.isCurrent() || parsed.kind === 'unknown') return null;
    return { pending, parsed };
  } catch {
    return null;
  }
}
