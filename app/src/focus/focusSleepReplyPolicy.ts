import { numberCareMessages } from '../ai/behavior/chatCareUpdates';
import type { FocusLogEntry } from './focusStore';

type RuntimeLog = Omit<FocusLogEntry, 'sessionId'>;
const RECEIPT_TRIGGER = 'focus-sleep-reply-receipt';
const REPLY_TRIGGER = 'focus-sleep-reply';
const SOURCE_TRIGGER = 'sleeping-you-message';
const MAX_CONTENT_LENGTH = 40_000;

type Receipt = { version: 1; part: number; parts: number; sourceIds: string[]; replyIds: string[] };

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240;
const uniqueIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0
  && value.every(validId) && new Set(value).size === value.length;
const isSource = (log: RuntimeLog) => log.role === 'you' && log.trigger === SOURCE_TRIGGER;
const isReply = (log: RuntimeLog) => log.role === 'I' && log.trigger === REPLY_TRIGGER;

export function isFocusSleepReplyReceipt(log: RuntimeLog) {
  return log.trigger === RECEIPT_TRIGGER;
}

function parseReceipt(log: RuntimeLog): Receipt | null {
  if (!isFocusSleepReplyReceipt(log) || log.role !== 'system' || !validId(log.id) || log.content.length > MAX_CONTENT_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(log.content);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'part,parts,replyIds,sourceIds,version'
      || record.version !== 1 || !Number.isSafeInteger(record.part) || !Number.isSafeInteger(record.parts)
      || (record.part as number) < 0 || (record.parts as number) < 1 || (record.part as number) >= (record.parts as number)
      || !uniqueIds(record.sourceIds) || !uniqueIds(record.replyIds)) return null;
    return { version: 1, part: record.part as number, parts: record.parts as number,
      sourceIds: record.sourceIds, replyIds: record.replyIds };
  } catch { return null; }
}

/** Only a complete saved reply + receipt batch settles the immutable raw sources. */
export function selectFocusSleepReplySources(logs: readonly RuntimeLog[]) {
  const byId = new Map<string, RuntimeLog>();
  const conflictingIds = new Set<string>();
  let blocked = false;
  for (const log of logs) {
    const previous = byId.get(log.id);
    if (!previous) byId.set(log.id, log);
    else if (previous.role !== log.role || previous.trigger !== log.trigger || previous.content !== log.content
      || previous.createdAt !== log.createdAt || previous.elapsedSeconds !== log.elapsedSeconds) {
      conflictingIds.add(log.id); blocked = true;
    }
  }
  const sources = [...byId.values()].filter(isSource);
  const groups = new Map<string, Receipt[]>();
  for (const log of byId.values()) {
    if (log.trigger !== RECEIPT_TRIGGER) continue;
    const receipt = parseReceipt(log);
    if (!receipt || conflictingIds.has(log.id)) { blocked = true; continue; }
    const key = JSON.stringify(receipt.replyIds);
    groups.set(key, [...(groups.get(key) ?? []), receipt]);
  }
  const settled = new Set<string>(), acknowledgedReplies = new Set<string>();
  for (const receipts of groups.values()) {
    const first = receipts[0];
    const parts = new Set<number>(), batchSources = new Set<string>();
    let complete = receipts.length === first.parts;
    for (const receipt of receipts) {
      if (receipt.parts !== first.parts || parts.has(receipt.part)) complete = false;
      parts.add(receipt.part);
      for (const id of receipt.sourceIds) {
        if (batchSources.has(id) || conflictingIds.has(id) || !byId.has(id) || !isSource(byId.get(id)!)) complete = false;
        batchSources.add(id);
      }
    }
    if (parts.size !== first.parts || first.replyIds.some(id => conflictingIds.has(id) || !byId.has(id) || !isReply(byId.get(id)!)
      || acknowledgedReplies.has(id))) complete = false;
    if (!complete) { blocked = true; continue; }
    for (const id of batchSources) settled.add(id);
    for (const id of first.replyIds) acknowledgedReplies.add(id);
  }
  // Sync may deliver I bubbles before their receipt. Never treat that as permission for another HTTP.
  if ([...byId.values()].some(log => isReply(log) && !acknowledgedReplies.has(log.id))) blocked = true;
  return { pending: sources.filter(log => !settled.has(log.id)), blocked };
}

export function makeFocusSleepReplyReceipts(sources: readonly RuntimeLog[], replyLogs: readonly RuntimeLog[]): RuntimeLog[] {
  if (!sources.length || !replyLogs.length || sources.some(log => !isSource(log)) || replyLogs.some(log => !isReply(log))) {
    throw new Error('Invalid focus sleep reply batch');
  }
  const sourceIds = sources.map(log => log.id), replyIds = replyLogs.map(log => log.id);
  if (!uniqueIds(sourceIds) || !uniqueIds(replyIds)) throw new Error('Invalid focus sleep reply IDs');
  const encode = (ids: string[], part: number, parts: number) => JSON.stringify({ version: 1, part, parts, sourceIds: ids, replyIds });
  let partCount = 1, chunks: string[][];
  // Measure the actual serialized JSON; a later part count can add a digit to the envelope.
  for (;;) {
    chunks = [];
    let current: string[] = [];
    for (const id of sourceIds) {
      if (encode([...current, id], chunks.length, partCount).length > MAX_CONTENT_LENGTH) {
        if (!current.length) throw new Error('Focus sleep receipt exceeds storage limit');
        chunks.push(current); current = [];
      }
      current.push(id);
      if (encode(current, chunks.length, partCount).length > MAX_CONTENT_LENGTH) throw new Error('Focus sleep receipt exceeds storage limit');
    }
    chunks.push(current);
    if (chunks.length === partCount) break;
    partCount = chunks.length;
  }
  const first = replyLogs[0];
  return chunks.map((ids, part) => {
    const id = `${first.id}:sleep-receipt:${part}`;
    if (!validId(id)) throw new Error('Focus sleep receipt ID exceeds storage limit');
    return { id, role: 'system', trigger: RECEIPT_TRIGGER, content: encode(ids, part, partCount),
      createdAt: first.createdAt, elapsedSeconds: first.elapsedSeconds };
  });
}

function isSleepRecord(log: RuntimeLog) {
  return log.role === 'I' && (log.trigger === 'focus-sleep-opening' || log.trigger === 'focus-sleep-motion'
    || ['focus-sleep-preparing', 'focus-sleep-waking'].some(trigger => log.trigger === trigger || log.trigger.startsWith(`${trigger}:`)));
}

export function buildFocusSleepReplyInstruction(input: {
  logs: readonly RuntimeLog[]; sources: readonly RuntimeLog[]; userActivity: string;
}) {
  const numbered = numberCareMessages(input.logs.flatMap(log => !isFocusSleepReplyReceipt(log) && (log.role === 'I' || log.role === 'you')
    ? [{ id: log.id, role: log.role, text: log.content, sentAt: log.createdAt }] : []));
  const indices = new Map(numbered.map(message => [message.id, message.messageIndex]));
  const actual = new Map<string, RuntimeLog>();
  for (const log of input.logs) {
    if (!isFocusSleepReplyReceipt(log) && (log.role === 'I' || log.role === 'you') && !actual.has(log.id)) actual.set(log.id, log);
  }
  if (!input.sources.length || !uniqueIds(input.sources.map(log => log.id))) throw new Error('Missing focus sleep reply sources');
  const sources = input.sources.map(source => {
    const present = actual.get(source.id);
    if (!isSource(source) || !present || !isSource(present) || present.content !== source.content || present.createdAt !== source.createdAt
      || !indices.has(source.id)) throw new Error('Focus sleep reply source is absent from request history');
    return indices.get(source.id)!;
  });
  const motions = numbered.filter(message => {
    const log = actual.get(message.id);
    return log && isSleepRecord(log);
  }).map(message => message.messageIndex);
  return `【这次专注的已确认状态】

I 此刻：醒着
you 这次要做：${input.userActivity}
专注阶段：进行中
I 还没回应的 you 留言：消息序号 ${sources.join('、')}
I 的睡眠动静与过渡记录：消息序号 ${motions.length ? motions.join('、') : '无'}
这些 I 记录不是对上述 you 留言的回复。

【I 醒来，读到 you 的留言】

I 读到 you 在 I 睡着时留下的话啦。
I 想把这一路的变化一起接住，回应此刻的 you。

正文用自然中文，不写 I／you。`;
}
