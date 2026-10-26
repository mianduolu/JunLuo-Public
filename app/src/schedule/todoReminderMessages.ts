import { createSubjectiveMessage } from '../ai/subjectiveMessages';
import { recordBaiyunCareDelivery } from '../ai/behavior/actionExecutionRuntime';
import { appendMessagesToChatSession, loadChatState } from '../chat/chatStorage';
import { recordActiveMessageDelivery } from '../proactive/activeMessageCoordinator';
import { loadDueTodoReminderItems, markTodoReminderDelivered, type TodoItem } from './todoStore';
import { emptyScheduleMessageDelivery, type ScheduleMessageDeliveryResult } from './scheduleDeliveryTypes';

function reminderText(item: TodoItem) {
  if (item.reminderStage <= 0) {
    return `小仓鼠，今天的待办里有“${item.title}”。准备好了吗？^^`;
  }
  return `小仓鼠，“${item.title}”现在怎么样啦？要不要放到明天，或者拆成一个更小的小动作？இ௰இ`;
}

export async function deliverDueTodoReminderMessages(): Promise<ScheduleMessageDeliveryResult> {
  const items = await loadDueTodoReminderItems();
  if (!items.length) return emptyScheduleMessageDelivery();

  const { sessions, activeSessionId } = await loadChatState();
  const active = sessions.find((session) => session.id === activeSessionId);
  if (!active) return emptyScheduleMessageDelivery();

  const additions = items.map((item) => createSubjectiveMessage('I', reminderText(item), {
    source: 'todo-reminder',
  }));
  const saved = await appendMessagesToChatSession(active.id, additions, { activeSessionId });
  const savedIds = new Set(saved.messages.map((message) => message.id));
  const persisted = additions.filter((message) => savedIds.has(message.id));
  if (persisted.length) {
    await Promise.all(items.map((item) => markTodoReminderDelivered(item.id, Math.min(item.reminderStage + 1, 2))));
    await recordActiveMessageDelivery({
      messageCount: persisted.length,
      priority: 'critical',
      source: 'todo-reminder',
      topicKey: items.map((item) => item.id).join('|'),
    });
  }
  await Promise.all(items.map(async (item, index) => {
    const message = additions[index];
    if (!savedIds.has(message.id)) return;
    await recordBaiyunCareDelivery({
      sourceId: `todo-reminder:${item.id}`, itemName: item.title,
      messageIds: [message.id],
      links: [{ relation: 'task', targetKind: 'todo_item', targetId: item.id }],
    }).catch(() => undefined);
  }));
  return { inserted: persisted.length, messages: persisted };
}
