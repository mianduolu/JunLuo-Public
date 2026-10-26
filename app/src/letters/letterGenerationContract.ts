export const JUNLUO_LETTER_REPLY_PROMPT = `【you 来信后的回信】

I 收到 you 寄来的信，认真读完后，也想写一封信寄给 you。

I 从信里此刻最留在心上的地方写起，再把想对 you 说的话自然写下去。

I 用书信体写，保留称呼、自然分段的正文和落款。

写好后，I 只发送这封回信。`;

export const JUNLUO_PROACTIVE_LETTER_PROMPT = `【I 主动写给 you 的信】

此刻，I 想主动写一封信给 you。I 可以把它寄给现在的 you，也可以藏给未来的 you。

I 把想写的信放进这个 JSON：
{"currentLetter":null,"futureLetter":null}

写给现在的信使用：
{"title":"...","content":"..."}

写给未来的信使用：
{"title":"...","content":"...","openWhen":{...}}

未来信可以系在材料中的日期票上：
{"kind":"date_ticket","dateId":"..."}

也可以由 I 自由选择过几天再打开：
{"kind":"after_days","days":30}

date_ticket 只能使用材料中真正出现的 dateId。after_days 只能填写 1 到 90 之间的整数。

两封信都使用书信体，保留称呼、自然分段的正文和落款。

只写其中一封时，另一个位置写 null；两封都写时，两个位置都填写。

写好后，I 只发送这个 JSON。`;

export type LetterOpenWhen =
  | { kind: 'date_ticket'; dateId: string }
  | { kind: 'after_days'; days: number };

export type GeneratedLetterBasket = {
  title: string;
  content: string;
};

export type GeneratedFutureLetterBasket = GeneratedLetterBasket & {
  openWhen: LetterOpenWhen;
};

export type ParsedGeneratedLetters = {
  currentLetter: GeneratedLetterBasket | null;
  futureLetter: GeneratedFutureLetterBasket | null;
  rootValid: boolean;
};

export type LetterDateTicketMaterial = {
  dateId: string;
  dateTime: string;
  eventTitle: string;
  eventNote?: string;
};

function stripOneJsonFence(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function readObject(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readLetter(value: unknown): GeneratedLetterBasket | null {
  const record = readObject(value);
  if (!record) return null;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const content = typeof record.content === 'string' ? record.content.trim() : '';
  return title && content ? { title, content } : null;
}

function readOpenWhen(value: unknown, dateIds: ReadonlySet<string>): LetterOpenWhen | null {
  const record = readObject(value);
  if (!record) return null;
  if (record.kind === 'date_ticket') {
    return typeof record.dateId === 'string' && dateIds.has(record.dateId)
      ? { kind: 'date_ticket', dateId: record.dateId }
      : null;
  }
  if (record.kind === 'after_days') {
    return Number.isInteger(record.days) && Number(record.days) >= 1 && Number(record.days) <= 90
      ? { kind: 'after_days', days: Number(record.days) }
      : null;
  }
  return null;
}

export function parseGeneratedLetters(
  content: string,
  allowedDateIds: readonly string[],
): ParsedGeneratedLetters {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripOneJsonFence(content)) as unknown;
  } catch {
    return { currentLetter: null, futureLetter: null, rootValid: false };
  }
  const root = readObject(parsed);
  if (!root) return { currentLetter: null, futureLetter: null, rootValid: false };
  const dateIds = new Set(allowedDateIds);
  const currentLetter = root.currentLetter === null ? null : readLetter(root.currentLetter);
  const futureBase = root.futureLetter === null ? null : readLetter(root.futureLetter);
  const futureRecord = readObject(root.futureLetter);
  const openWhen = futureRecord ? readOpenWhen(futureRecord.openWhen, dateIds) : null;
  return {
    currentLetter,
    futureLetter: futureBase && openWhen ? { ...futureBase, openWhen } : null,
    rootValid: true,
  };
}

export function buildLetterDateTicketMaterial(ticket: LetterDateTicketMaterial) {
  return `【这次可以系住未来信的日期票】

dateId：${ticket.dateId}
时间：${ticket.dateTime}
事情：${ticket.eventTitle}${ticket.eventNote?.trim() ? `
备注：${ticket.eventNote.trim()}` : ''}`;
}

export function buildFreshLetterMaterials(currentDate: string, materials: readonly string[]) {
  return `日期：${currentDate}

【I 最近新留下的片段】

${materials.slice(0, 3).join('\n\n')}`;
}

export function buildAnnualLetterMaterials(materials: readonly string[]) {
  return `【再回想起更多的片段】

${materials.slice(0, 16).join('\n\n')}`;
}

export function resolveLetterOpenAt(openWhen: LetterOpenWhen, now: number, tickets: readonly { dateId: string; at: number }[]) {
  if (openWhen.kind === 'after_days') return now + openWhen.days * 24 * 60 * 60 * 1000;
  return tickets.find((ticket) => ticket.dateId === openWhen.dateId)?.at ?? null;
}

export function resolveLetterDateTicketWindow(now: number) {
  const localNow = new Date(now);
  const startAt = new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate(),
  ).getTime();
  const endAt = new Date(
    localNow.getFullYear(),
    localNow.getMonth(),
    localNow.getDate() + 2,
  ).getTime() - 1;
  return { endAt, startAt };
}

export function resolveRelationshipDateCurrentLetterSealAt(
  now: number,
  ticket: { scheduledAt: number; source: 'relationship-date' | 'schedule' } | null,
) {
  return ticket?.source === 'relationship-date' && ticket.scheduledAt > now
    ? ticket.scheduledAt
    : null;
}

export function makeLetterGenerationKey(input: {
  dateKey: string;
  dateTicketId?: string;
  sourceIds: readonly string[];
}) {
  const source = [
    input.dateTicketId ?? 'ordinary',
    [...new Set(input.sourceIds)].sort().join(','),
  ].join(':');
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `letter-v2:${input.dateKey}:${(hash >>> 0).toString(36)}`;
}

export function selectAnnualLetterMaterials<T extends {
  id: string;
  occurredAt: number;
  importance: number;
  anchored: boolean;
  text: string;
}>(items: readonly T[], from: number, to: number) {
  const eligible = items
    .filter((item) => item.occurredAt >= from && item.occurredAt <= to)
    .sort((left, right) => right.importance - left.importance || right.occurredAt - left.occurredAt);
  const monthly: T[] = [];
  const monthKeys = new Set<string>();
  for (const item of eligible) {
    const date = new Date(item.occurredAt);
    const monthKey = `${date.getFullYear()}-${date.getMonth() + 1}`;
    if (monthKeys.has(monthKey)) continue;
    monthKeys.add(monthKey);
    monthly.push(item);
    if (monthly.length >= 12) break;
  }
  const selectedIds = new Set(monthly.map((item) => item.id));
  const anchors = eligible
    .filter((item) => item.anchored && !selectedIds.has(item.id))
    .sort((left, right) => right.importance - left.importance || right.occurredAt - left.occurredAt)
    .slice(0, 4);
  return [...monthly, ...anchors].map((item) => item.text);
}

export function resolveLetterMaterialOccurredAt(input: {
  createdAt: number;
  eventAt?: number;
  sourceStartAt?: number;
}) {
  return input.eventAt ?? input.sourceStartAt ?? input.createdAt;
}

export function selectFreshLetterMaterials<T extends {
  id: string;
  occurredAt: number;
  importance: number;
}>(items: readonly T[], settledIds: ReadonlySet<string>, limit = 3) {
  return items
    .filter((item) => !settledIds.has(item.id))
    .sort((left, right) => (
      right.occurredAt - left.occurredAt
      || right.importance - left.importance
      || left.id.localeCompare(right.id)
    ))
    .slice(0, Math.max(0, limit));
}

export function canStartProactiveLetter(input: {
  alreadyRequestedToday: boolean;
  hasDateTicket: boolean;
  hasFreshMaterial: boolean;
  hasRelatedDesire: boolean;
  lastSavedAt?: number;
  now: number;
}) {
  if (input.alreadyRequestedToday) return false;
  if (input.hasDateTicket) return true;
  if (!input.hasFreshMaterial || !input.hasRelatedDesire) return false;
  return input.lastSavedAt === undefined || input.now - input.lastSavedAt >= 120 * 60 * 60 * 1000;
}
