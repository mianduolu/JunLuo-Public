import type { AiConnection } from '../ai/types';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { InteractionManager } from 'react-native';
import { createSubjectiveMessage, type SubjectiveMessage } from '../ai/subjectiveMessages';
import {
  findChatSessionContainingMessage,
  loadChatSessionMessage,
  loadChatSessionMessagePage,
  loadChatStateFast,
  mergeAndSaveChatSessionMessages,
} from '../chat/chatStorage';
import { recordActiveMessageDelivery, requestActiveMessageSlot } from '../proactive/activeMessageCoordinator';
import {
  deleteGoalTimeCreditCardLocator,
  loadGoalTimeCreditDeliveryWork,
  saveGoalTimeCreditEstimate,
  saveGoalTimeCreditCardLocator,
  type GoalTimeCreditRequest,
} from './goalProgressStore';
import {
  decideGoalTimeCreditDeliveryStart,
  makeGoalTimeCreditCardMessageId,
  runGoalTimeCreditCardDelivery,
  type LocatedGoalTimeCreditCardMessage,
} from './goalTimeCreditDeliveryCore';
import { loadTodoItemById } from './todoStore';

type EstimateResponse = { requestId?: unknown; minutes?: unknown; reason?: unknown };

function stripJsonFence(value: string) {
  return value.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export async function estimateGoalTimeCredits({
  apiKey,
  connection,
  requests,
}: {
  apiKey: string;
  connection: AiConnection;
  requests: GoalTimeCreditRequest[];
}) {
  const pending = requests.filter((request) => request.status === 'pending');
  if (!pending.length) return;
  const tasks = await Promise.all(pending.map(async (request) => {
    const todo = await loadTodoItemById(request.todoId);
    return {
      requestId: request.id,
      title: request.todoTitle,
      notes: todo?.notes ?? '',
      category: todo?.category ?? 'other',
    };
  }));
  const body = JSON.stringify({
      model: connection.model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: `【目标任务估时】
当前任务：估算每项任务相对宽松的参考专注分钟。

只依据标题、备注和分类。
这是参考值，不是小仓鼠真实花掉的时间。
只有小仓鼠确认后，才算进目标进度。

返回严格 JSON 数组：
[{"requestId":"原值","minutes":30,"reason":"简短依据"}]

minutes 是 1 到 1440 的整数。
按输入任务逐项返回，不新增任务。`,
        },
        { role: 'user', content: JSON.stringify(tasks) },
      ],
  });
  const cacheMetric = beginPromptCacheMetric({ contextProfile: 'schedule-planner', contextSource: 'goal.time-credit', connection });
  let payload: { usage?: unknown; choices?: Array<{ message?: { content?: string } }> };
  try {
    const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!response.ok) throw new Error('目标任务估时暂时失败。');
    payload = (await response.json()) as typeof payload;
    cacheMetric.recordUsage(payload?.usage);
  } finally { cacheMetric.finish(); }
  const raw = payload.choices?.[0]?.message?.content;
  if (!raw) throw new Error('目标任务估时没有返回内容。');
  const parsed = JSON.parse(stripJsonFence(raw)) as EstimateResponse[];
  if (!Array.isArray(parsed)) throw new Error('目标任务估时格式不正确。');
  const allowedIds = new Set(pending.map((request) => request.id));
  await Promise.all(parsed.map(async (item) => {
    if (typeof item.requestId !== 'string' || !allowedIds.has(item.requestId)) return;
    if (typeof item.minutes !== 'number' || !Number.isFinite(item.minutes) || item.minutes < 1 || item.minutes > 1440) return;
    await saveGoalTimeCreditEstimate(
      item.requestId,
      Math.round(item.minutes),
      typeof item.reason === 'string' ? item.reason : '',
    );
  }));
}

let goalTimeCreditDeliveryInFlight: Promise<SubjectiveMessage[]> | null = null;

export function deliverPendingGoalTimeCreditCards(options: {
  apiKey?: string;
  connection?: AiConnection;
} = {}) {
  if (goalTimeCreditDeliveryInFlight) return goalTimeCreditDeliveryInFlight;
  const delivery = deliverPendingGoalTimeCreditCardsOnce(options)
    .finally(() => {
      if (goalTimeCreditDeliveryInFlight === delivery) goalTimeCreditDeliveryInFlight = null;
    });
  goalTimeCreditDeliveryInFlight = delivery;
  return delivery;
}

async function deliverPendingGoalTimeCreditCardsOnce({
  apiKey,
  connection,
}: {
  apiKey?: string;
  connection?: AiConnection;
}): Promise<SubjectiveMessage[]> {
  let work = await loadGoalTimeCreditDeliveryWork();
  const start = decideGoalTimeCreditDeliveryStart(work, !!apiKey?.trim() && !!connection);
  if (start === 'idle' || start === 'wait-for-estimator') return [];
  const pending = work.filter(({ request }) => request.status === 'pending').map(({ request }) => request);
  if (start === 'estimate') {
    await estimateGoalTimeCredits({ apiKey: apiKey!.trim(), connection: connection!, requests: pending });
    work = await loadGoalTimeCreditDeliveryWork();
  }

  return runGoalTimeCreditCardDelivery(work, {
    createMessage: (request) => ({
      ...createSubjectiveMessage(
        'I',
        `“${request.todoTitle}”完成啦。我先给它估了一个参考值，鼠确认后再算进目标。`,
        {
          source: 'goal-time-credit',
          goalTimeCreditCard: {
            requestId: request.id,
            todoId: request.todoId,
            goalId: request.goalId,
            todoTitle: request.todoTitle,
            suggestedMinutes: request.suggestedMinutes!,
            reason: request.reason,
            status: 'pending',
          },
        },
      ),
      id: makeGoalTimeCreditCardMessageId(request.id),
    }),
    deleteLocator: deleteGoalTimeCreditCardLocator,
    findLegacyMessage: findLegacyGoalTimeCreditCardMessage,
    findSessionContainingMessage: findChatSessionContainingMessage,
    loadActiveSessionId: async () => {
      const state = await loadChatStateFast({ activeMessageLimit: 1 });
      return state.sessions.some((session) => session.id === state.activeSessionId)
        ? state.activeSessionId
        : null;
    },
    loadMessage: loadChatSessionMessage,
    persistMessages: async (sessionId, messages) => !!await mergeAndSaveChatSessionMessages(
      sessionId,
      messages,
    ),
    recordDelivery: async (messages) => recordActiveMessageDelivery({
      messageCount: messages.length,
      priority: 'contextual',
      source: 'goal-time-credit',
      topicKey: messages.map((message) => message.goalTimeCreditCard?.requestId).filter(Boolean).join('|'),
    }),
    requestDeliverySlot: async (requests) => (await requestActiveMessageSlot({
      priority: 'contextual',
      source: 'goal-time-credit',
      topicKey: requests.map((request) => request.id).join('|'),
    })).allowed,
    saveLocator: saveGoalTimeCreditCardLocator,
  });
}

const legacyGoalTimeCreditScans = new Map<string, Promise<LocatedGoalTimeCreditCardMessage | null>>();

function yieldUntilInteractionsFinish() {
  return new Promise<void>((resolve) => {
    InteractionManager.runAfterInteractions(() => resolve());
  });
}

async function scanLegacyGoalTimeCreditCardMessage(requestId: string) {
  const state = await loadChatStateFast({ activeMessageLimit: 1 });
  for (const session of state.sessions) {
    let beforeIndex = session.messageCount ?? session.messages.length;
    while (beforeIndex > 0) {
      const page = await loadChatSessionMessagePage(session.id, {
        beforeIndex,
        limit: 30,
      });
      const message = page.messages.find((item) => item.goalTimeCreditCard?.requestId === requestId);
      if (message) return { sessionId: session.id, message };
      if (page.startIndex <= 0 || page.startIndex >= beforeIndex) break;
      beforeIndex = page.startIndex;
      await yieldUntilInteractionsFinish();
    }
  }
  return null;
}

function findLegacyGoalTimeCreditCardMessage(requestId: string) {
  const existing = legacyGoalTimeCreditScans.get(requestId);
  if (existing) return existing;
  const scan = scanLegacyGoalTimeCreditCardMessage(requestId)
    .finally(() => legacyGoalTimeCreditScans.delete(requestId));
  legacyGoalTimeCreditScans.set(requestId, scan);
  return scan;
}
