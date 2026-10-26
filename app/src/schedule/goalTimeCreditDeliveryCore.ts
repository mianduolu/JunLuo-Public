import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';

export type GoalTimeCreditRequestStatus = 'pending' | 'proposed' | 'confirmed' | 'skipped' | 'cancelled';

type GoalTimeCreditCardStatus = 'pending' | 'confirmed' | 'skipped' | 'cancelled';

export type GoalTimeCreditDeliveryMessage = {
  id: string;
  role: 'I' | 'you';
  content: string;
  createdAt: number;
  goalTimeCreditCard?: {
    requestId: string;
    todoId: string;
    goalId: string;
    todoTitle: string;
    suggestedMinutes: number;
    reason: string;
    status: GoalTimeCreditCardStatus;
  };
};

export type GoalTimeCreditDeliveryRequest = {
  id: string;
  todoId: string;
  goalId: string;
  todoTitle: string;
  suggestedMinutes?: number;
  reason: string;
  status: GoalTimeCreditRequestStatus;
  createdAt: number;
  updatedAt: number;
};

const GOAL_TIME_CREDIT_MESSAGE_ID_CONTEXT = 'junluo.goal-time-credit-card.v1';

export type GoalTimeCreditCardLocator = {
  requestId: string;
  sessionId: string;
  messageId: string;
  appliedStatus: GoalTimeCreditRequestStatus;
  updatedAt: number;
};

export type GoalTimeCreditDeliveryWork = {
  request: GoalTimeCreditDeliveryRequest;
  locator: GoalTimeCreditCardLocator | null;
};

export type LocatedGoalTimeCreditCardMessage = {
  sessionId: string;
  message: GoalTimeCreditDeliveryMessage;
};

export type GoalTimeCreditDeliveryPorts = {
  createMessage(request: GoalTimeCreditDeliveryRequest): GoalTimeCreditDeliveryMessage;
  deleteLocator(requestId: string): Promise<void>;
  findLegacyMessage(requestId: string): Promise<LocatedGoalTimeCreditCardMessage | null>;
  findSessionContainingMessage(messageId: string): Promise<string | null>;
  loadActiveSessionId(): Promise<string | null>;
  loadMessage(sessionId: string, messageId: string): Promise<GoalTimeCreditDeliveryMessage | null>;
  persistMessages(sessionId: string, messages: GoalTimeCreditDeliveryMessage[]): Promise<boolean>;
  recordDelivery(messages: GoalTimeCreditDeliveryMessage[]): Promise<void>;
  requestDeliverySlot(requests: GoalTimeCreditDeliveryRequest[]): Promise<boolean>;
  saveLocator(locator: Omit<GoalTimeCreditCardLocator, 'updatedAt'>): Promise<void>;
};

export function makeGoalTimeCreditCardMessageId(requestId: string) {
  const digest = Buffer.from(sha256(Buffer.from(
    JSON.stringify([GOAL_TIME_CREDIT_MESSAGE_ID_CONTEXT, requestId]),
    'utf8',
  ))).toString('base64url');
  return `I-goal-time-credit-${digest}`;
}

export function goalTimeCreditCardDisplayStatus(
  status: GoalTimeCreditRequestStatus,
): GoalTimeCreditCardStatus | null {
  if (status === 'proposed') return 'pending';
  if (status === 'confirmed' || status === 'skipped' || status === 'cancelled') return status;
  return null;
}

export function decideGoalTimeCreditDeliveryStart(
  work: GoalTimeCreditDeliveryWork[],
  canEstimate: boolean,
) {
  if (!work.length) return 'idle' as const;
  if (work.some(({ request }) => request.status === 'pending')) {
    return canEstimate ? 'estimate' as const : 'wait-for-estimator' as const;
  }
  return 'deliver' as const;
}

function applyRequestToGoalTimeCreditCardMessage(
  message: GoalTimeCreditDeliveryMessage,
  request: GoalTimeCreditDeliveryRequest,
) {
  const card = message.goalTimeCreditCard;
  const status = goalTimeCreditCardDisplayStatus(request.status);
  if (!card || card.requestId !== request.id || !status) {
    return { changed: false, matched: false, message };
  }
  const suggestedMinutes = request.suggestedMinutes ?? card.suggestedMinutes;
  const changed = card.status !== status || card.suggestedMinutes !== suggestedMinutes;
  return {
    changed,
    matched: true,
    message: changed
      ? {
          ...message,
          goalTimeCreditCard: {
            ...card,
            status,
            suggestedMinutes,
          },
        }
      : message,
  };
}

async function persistLocatedRequest(
  work: GoalTimeCreditDeliveryWork,
  located: LocatedGoalTimeCreditCardMessage,
  ports: GoalTimeCreditDeliveryPorts,
  locatorIsCurrent = false,
) {
  const reconciled = applyRequestToGoalTimeCreditCardMessage(located.message, work.request);
  if (!reconciled.matched) return false;
  if (reconciled.changed) {
    const persisted = await ports.persistMessages(located.sessionId, [reconciled.message]);
    if (!persisted) throw new Error('goal-time-credit-target-message-missing');
  }
  if (
    !locatorIsCurrent
    || work.locator?.appliedStatus !== work.request.status
    || work.locator.sessionId !== located.sessionId
    || work.locator.messageId !== located.message.id
  ) {
    await ports.saveLocator({
      requestId: work.request.id,
      sessionId: located.sessionId,
      messageId: located.message.id,
      appliedStatus: work.request.status,
    });
  }
  return true;
}

async function resolveLocatedRequest(
  work: GoalTimeCreditDeliveryWork,
  ports: GoalTimeCreditDeliveryPorts,
) {
  if (work.locator) {
    const message = await ports.loadMessage(work.locator.sessionId, work.locator.messageId);
    if (message && await persistLocatedRequest(work, {
      sessionId: work.locator.sessionId,
      message,
    }, ports, true)) {
      return true;
    }
    await ports.deleteLocator(work.request.id);
  }

  const messageId = makeGoalTimeCreditCardMessageId(work.request.id);
  const sessionId = await ports.findSessionContainingMessage(messageId);
  if (!sessionId) return false;
  const message = await ports.loadMessage(sessionId, messageId);
  if (!message) return false;
  if (await persistLocatedRequest(work, { sessionId, message }, ports)) return true;
  throw new Error('goal-time-credit-message-id-collision');
}

export async function runGoalTimeCreditCardDelivery(
  work: GoalTimeCreditDeliveryWork[],
  ports: GoalTimeCreditDeliveryPorts,
) {
  if (!work.length) return [];

  const terminalWork = work.filter(({ request, locator }) => (
    !!locator
    && request.status !== 'pending'
    && request.status !== 'proposed'
  ));
  for (const item of terminalWork) {
    await resolveLocatedRequest(item, ports);
  }

  const proposedWork = work.filter(({ request }) => (
    request.status === 'proposed' && !!request.suggestedMinutes
  ));
  const missing: GoalTimeCreditDeliveryWork[] = [];
  for (const item of proposedWork) {
    if (!await resolveLocatedRequest(item, ports)) missing.push(item);
  }
  if (!missing.length) return [];
  if (!await ports.requestDeliverySlot(missing.map(({ request }) => request))) return [];

  const additions: GoalTimeCreditDeliveryWork[] = [];
  for (const item of missing) {
    const legacy = await ports.findLegacyMessage(item.request.id);
    if (legacy && await persistLocatedRequest(item, legacy, ports)) continue;
    additions.push(item);
  }
  if (!additions.length) return [];

  const sessionId = await ports.loadActiveSessionId();
  if (!sessionId) return [];
  const messages = additions.map(({ request }) => ports.createMessage(request));

  const persisted = await ports.persistMessages(sessionId, messages);
  if (!persisted) throw new Error('goal-time-credit-session-missing');
  for (let index = 0; index < additions.length; index += 1) {
    await ports.saveLocator({
      requestId: additions[index].request.id,
      sessionId,
      messageId: messages[index].id,
      appliedStatus: additions[index].request.status,
    });
  }

  await ports.recordDelivery(messages);
  return messages;
}
