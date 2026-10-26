import type { BaiyunChatCareEvidence, BaiyunContinuityEvent } from './continuityEvent';
import type { BaiyunContinuityEventLink } from './continuityLedger';
import { isHeartCareMatter, type CareContextEvent } from './heartCareMatter';

export const CHAT_CARE_GUIDANCE = `【I 还惦记着的事】

you 身体不舒服、心里难受、被一件事卡住、有事拖着没做，或希望 I 继续留意时，I 把需要挂念的具体事情记进 careUpdates。

普通闲聊、亲昵、只是提起的打算，以及已经做完且没有留下困扰的日常事情，不另记成照护事项。I 自己的担心或改善建议，不能单独作为新增事项的依据。同一件事有了后续，就更新原来的记录。

careUpdates 每项填写：
item：已有事情填事项序号，新事情填 null。
from：本轮 you 新消息的序号。
quote：从这条消息里原样摘出说明这件事或新进展的片段。
state：继续／结束。
继续：这件事还有后续需要留意，比如 you 仍不舒服、希望 I 继续留意，或已经说好之后再跟进。
结束：you 说事情已经做完、已经不难受，或不用 I 再跟进，就结束这次跟进。

如果这件事已经聊过，之后没有什么需要继续留意，也没有新的异常情况需要跟进，即使还不知道当时为什么会那样，也可以结束。

每轮最多记录三件事的变化，同一件事合并填写。
没有需要新增或更新的事情时，careUpdates 填 []。`;

export type CareSourceMessage = { id: string; role: 'I' | 'you'; text: string; sentAt: number };
export type ChatCareItem = { id: string; revision: number; evidence?: BaiyunChatCareEvidence; deviceRecord?: string; updatedAt: number };

export function toChatCareItem(event: CareContextEvent): ChatCareItem {
  return { id: event.id, revision: event.revision, evidence: event.careEvidence,
    deviceRecord: event.deviceRecord, updatedAt: event.updatedAt };
}
export type ChatCareUpdate = {
  eventId?: string;
  expectedRevision?: number;
  quote: string;
  state: '继续' | '结束';
  sourceMessageId: string;
  occurredAt: number;
};

export function formatCareLocalTime(time: number) {
  const date = new Date(time);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function numberCareMessages(messages: readonly CareSourceMessage[]) {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  }).map((message, index) => ({ ...message, messageIndex: index + 1,
    content: `消息序号 ${index + 1}｜发送时间 ${formatCareLocalTime(message.sentAt)}\n${message.text}` }));
}

export function selectChatCareItems(input: {
  events: readonly CareContextEvent[];
  links: readonly BaiyunContinuityEventLink[];
  messages: readonly CareSourceMessage[];
  directReplyTargetId?: string;
  now: number;
}): ChatCareItem[] {
  const messageIds = new Set(input.messages.map((message) => message.id));
  const rank = (event: BaiyunContinuityEvent) => {
    const sources = [event.careEvidence?.origin.messageId, event.careEvidence?.latest?.messageId,
      ...input.links.filter((link) => link.eventId === event.id && link.relation === 'message').map((link) => link.targetId)];
    if (input.directReplyTargetId && sources.includes(input.directReplyTargetId)) return 0;
    return sources.some((id) => id && messageIds.has(id)) ? 1 : 2;
  };
  return input.events.filter((event) => ((event.schemaVersion === 3 && event.kind === 'care_process'
    && event.careEvidence) || (isHeartCareMatter(event) && event.deviceRecord)) && ['open', 'waiting'].includes(event.status))
    .sort((left, right) => rank(left) - rank(right) || right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
    .slice(0, 6).map(toChatCareItem);
}

export function buildChatCareGuidance(items: readonly ChatCareItem[]) {
  return items.length < 6 ? CHAT_CARE_GUIDANCE : CHAT_CARE_GUIDANCE.replace(
    'item：已有事情填事项序号，新事情填 null。', 'item：已有事情填事项序号。',
  );
}

export function buildChatCareContext(items: readonly ChatCareItem[]) {
  const section = (start: number, end: number, heading: string) => {
    const lines = items.slice(start, end).map((item, index) => [
      `事项序号：${start + index + 1}`,
      item.deviceRecord ? `最初的设备记录：${item.deviceRecord}` : `最初 you 的原话：${item.evidence!.origin.quote}`,
      (item.evidence?.latest || item.deviceRecord && item.evidence?.origin)
        ? `最新 you 的原话：${(item.evidence!.latest ?? item.evidence!.origin).quote}` : '',
    ].filter(Boolean).join('\n'));
    return lines.length ? `${heading}\n${lines.join('\n\n')}` : '';
  };
  return [section(0, 3, '【仍在留意的事】'), section(3, 6, '【其他仍在留意的事】')].filter(Boolean).join('\n\n');
}

export function parseChatCareUpdates(input: {
  value: unknown;
  items: readonly ChatCareItem[];
  messages: readonly CareSourceMessage[];
  newMessages: readonly CareSourceMessage[];
}) {
  const rejectionCodes: string[] = [];
  const updates: ChatCareUpdate[] = [];
  const seen = new Set<string>();
  const messages = numberCareMessages(input.messages);
  const current = new Map(input.newMessages.filter((message) => message.role === 'you').map((message) => [message.id, message]));
  if (!Array.isArray(input.value)) return { status: 'unresolved' as const, updates, diagnostic: { rejectionCodes: ['care_updates_not_array'] } };
  for (const raw of input.value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || Object.keys(raw).length !== 4 || Object.keys(raw).some((key) => !['item', 'from', 'quote', 'state'].includes(key))) {
      rejectionCodes.push('care_update_invalid_shape'); continue;
    }
    const existing = Number.isInteger(raw.item) && raw.item > 0 ? input.items[raw.item - 1] : undefined;
    if (raw.item !== null && !existing) { rejectionCodes.push('care_item_unknown'); continue; }
    if (raw.item === null && input.items.length >= 6) { rejectionCodes.push('care_capacity_at_request'); continue; }
    if (raw.state !== '继续' && raw.state !== '结束') { rejectionCodes.push('care_state_invalid'); continue; }
    if (raw.item === null && raw.state === '结束') { rejectionCodes.push('care_new_item_ended'); continue; }
    const numbered = Number.isInteger(raw.from) && raw.from > 0 ? messages[raw.from - 1] : undefined;
    const source = numbered && current.get(numbered.id);
    if (!source || source.role !== 'you' || source.text !== numbered?.text || source.sentAt !== numbered.sentAt) {
      rejectionCodes.push('care_source_not_current_you'); continue;
    }
    if (typeof raw.quote !== 'string' || !raw.quote.trim() || !source.text.includes(raw.quote)) {
      rejectionCodes.push('care_quote_not_verbatim'); continue;
    }
    const key = existing?.id ?? JSON.stringify([source.id, raw.quote]);
    if (seen.has(key)) { rejectionCodes.push('care_item_duplicate'); continue; }
    if (updates.length === 3) { rejectionCodes.push('care_update_limit'); continue; }
    seen.add(key);
    updates.push({ ...(existing ? { eventId: existing.id, expectedRevision: existing.revision } : {}),
      quote: raw.quote, state: raw.state, sourceMessageId: source.id, occurredAt: source.sentAt });
  }
  return { status: rejectionCodes.length ? 'partial' as const : 'valid' as const, updates, diagnostic: { rejectionCodes } };
}
