import type {
  JunluoAffectStateV1,
  JunluoInnerThoughtV2,
  RelationshipChoiceMovement,
} from './junluoInnerState';

export const JUNLUO_PROACTIVE_TASK_PROMPT = `【主动探头】

此刻，I 想主动联系上 you。

I 把想说的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON，you 就能看到啦。`;

export const JUNLUO_FOCUS_TASK_PROMPT = `【共同专注中的一小段话】

和 you 一起专注时，I 偶尔也想抬头说说自己这边的动静，再听听 you 那边怎么样了。

I 把想说的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON，you 就能看到啦。`;

export const JUNLUO_LETTER_REPLY_PROMPT = `【you 来信后的回信】

I 收到 you 寄来的信，认真读完后，也想写一封信寄给 you。

I 从信里此刻最留在心上的地方写起，再把想对 you 说的话自然写下去。

I 用书信体写，保留称呼、自然分段的正文和落款。

写好后，I 只发送这封回信。`;

export const JUNLUO_ACTIVE_LETTER_PROMPT = `【I 主动写给 you 的信】

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

type RecordValue = Record<string, unknown>;

function recordOf(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function hasExactKeys(record: RecordValue, expected: readonly string[]) {
  const actual = Object.keys(record).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function parseObject(raw: string) {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return recordOf(JSON.parse(clean) as unknown);
  } catch {
    return null;
  }
}

function text(value: unknown, maximum = 8000) {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean.length > 0 && clean.length <= maximum ? clean : null;
}

export function parseJunluoSingleMessage(raw: string) {
  const root = parseObject(raw);
  if (!root || !hasExactKeys(root, ['message'])) return null;
  const message = text(root.message);
  return message ? { message } : null;
}

export type JunluoLetterDraft = { content: string; title: string };
export type JunluoFutureLetterDraft = JunluoLetterDraft & {
  openWhen:
    | { kind: 'after_days'; days: number }
    | { kind: 'date_ticket'; dateId: string };
};

function parseLetter(value: unknown): JunluoLetterDraft | null {
  const item = recordOf(value);
  if (!item || !hasExactKeys(item, ['title', 'content'])) return null;
  const title = text(item.title, 200);
  const content = text(item.content, 20000);
  return title && content ? { content, title } : null;
}

function parseFutureLetter(
  value: unknown,
  offeredDateIds: ReadonlySet<string>,
): JunluoFutureLetterDraft | null {
  const item = recordOf(value);
  if (!item || !hasExactKeys(item, ['title', 'content', 'openWhen'])) return null;
  const title = text(item.title, 200);
  const content = text(item.content, 20000);
  const openWhen = recordOf(item.openWhen);
  if (!title || !content || !openWhen) return null;
  if (openWhen.kind === 'after_days' && hasExactKeys(openWhen, ['kind', 'days'])) {
    return Number.isInteger(openWhen.days) && Number(openWhen.days) >= 1 && Number(openWhen.days) <= 90
      ? { content, openWhen: { kind: 'after_days', days: Number(openWhen.days) }, title }
      : null;
  }
  if (openWhen.kind === 'date_ticket' && hasExactKeys(openWhen, ['kind', 'dateId'])) {
    const dateId = text(openWhen.dateId, 256);
    return dateId && offeredDateIds.has(dateId)
      ? { content, openWhen: { kind: 'date_ticket', dateId }, title }
      : null;
  }
  return null;
}

export function parseJunluoActiveLetters(input: {
  offeredDateIds: readonly string[];
  raw: string;
}) {
  const root = parseObject(input.raw);
  if (!root || !hasExactKeys(root, ['currentLetter', 'futureLetter'])) return null;
  const currentLetter = root.currentLetter === null ? null : parseLetter(root.currentLetter);
  const futureLetter = root.futureLetter === null
    ? null
    : parseFutureLetter(root.futureLetter, new Set(input.offeredDateIds));
  return {
    currentLetter,
    currentStatus: root.currentLetter === null ? 'empty' as const : currentLetter ? 'adopted' as const : 'invalid' as const,
    futureLetter,
    futureStatus: root.futureLetter === null ? 'empty' as const : futureLetter ? 'adopted' as const : 'invalid' as const,
  };
}

export function buildJunluoProactiveFacts(input: {
  currentTime: string;
  idleDuration: string;
  lastIMessage?: string | null;
  lastYouMessage?: string | null;
}) {
  return [
    '【这次 I 能看见的近况】',
    '',
    `现在是 ${input.currentTime}。`,
    `I 已经有 ${input.idleDuration} 没有在聊天里听见 you 说话了。`,
    input.lastYouMessage ? `you 最近说：${input.lastYouMessage}` : '',
    input.lastIMessage ? `I 最近说：${input.lastIMessage}` : '',
  ].filter((line, index) => index < 2 || line).join('\n');
}

export function buildJunluoFocusFacts(input: {
  baiyunActivity: string;
  focusMode: string;
  focusProgress: string;
  recentConversation?: string | null;
  userActivity: string;
}) {
  return `【I 和 you 这次的专注】

you 正在做：${input.userActivity}
I 正在做：${input.baiyunActivity}
专注方式：${input.focusMode}
专注进度：${input.focusProgress}${input.recentConversation ? `

最近的互动：
${input.recentConversation}` : ''}`;
}

export function presentJunluoRelationshipFeeling(value: number) {
  const targets = [
    ['warm', 0.75],
    ['mixed', 0],
    ['unhappy', -0.45],
    ['averse', -0.85],
  ] as const;
  return targets.reduce((best, current) => (
    Math.abs(current[1] - value) < Math.abs(best[1] - value) ? current : best
  ))[0];
}

export function presentJunluoStrain(value: number) {
  const targets = [
    ['clear', 0.15],
    ['tense', 0.55],
    ['blocked', 0.90],
  ] as const;
  return targets.reduce((best, current) => (
    Math.abs(current[1] - value) < Math.abs(best[1] - value) ? current : best
  ))[0];
}

export function presentJunluoRelationshipChoice(input: JunluoAffectStateV1) {
  const retracted = new Set(input.relationshipChoiceRetractions.map((entry) => entry.targetEvidenceId));
  const latest = [...input.relationshipChoiceEvidence]
    .filter((entry) => !retracted.has(entry.evidenceId))
    .sort((left, right) => right.occurredAt - left.occurredAt
      || right.operationId.localeCompare(left.operationId))[0];
  if (latest) return latest.movement;
  const fallback: Record<typeof input.relationshipPhase.phase, RelationshipChoiceMovement> = {
    considering_exit: 'consider_leaving',
    ended: 'consider_leaving',
    rebuilding: 'closer',
    taking_space: 'farther',
    together: 'steady',
  };
  return fallback[input.relationshipPhase.phase];
}

const THOUGHT_OUTCOME_TEXT = {
  blocked: '上一次尝试被现实条件挡住了',
  failed: '上一次尝试没有成功',
  incomplete: '上一次尝试还没有完成',
} as const;

export function buildJunluoFixationMaterial(thought: JunluoInnerThoughtV2 | null) {
  if (!thought || thought.state !== 'fixation' || !thought.lastOutcome) return '';
  return `【I 最近仍惦记的一件事】

内容：${thought.content}
最近一次真实结果：${THOUGHT_OUTCOME_TEXT[thought.lastOutcome]}`;
}

export function buildJunluoFinishedThoughtMaterial(
  thoughts: readonly JunluoInnerThoughtV2[],
) {
  const lines = thoughts
    .filter((thought) => thought.state === 'resolved' || thought.state === 'released')
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 3)
    .map((thought) => `- ${thought.content}｜${thought.state === 'resolved' ? '已经完成' : 'I 已经放下'}`);
  return lines.length ? `【I 今天已经有了结果的念头】\n\n${lines.join('\n')}` : '';
}

export function buildJunluoDateTicketMaterial(input: {
  dateId: string;
  dateTime: string;
  eventNote?: string | null;
  eventTitle: string;
}) {
  return `【这次可以系住未来信的日期票】

dateId：${input.dateId}
时间：${input.dateTime}
事情：${input.eventTitle}${input.eventNote ? `
备注：${input.eventNote}` : ''}`;
}
