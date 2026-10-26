import { DEFAULT_THEATER_PERSONA } from './theaterPrompt';
import { composeTheaterPersona } from './theaterTemplates';

export type TheaterStoryStateMessage = {
  content: string;
  role: 'you' | 'I' | 'system';
};

export const THEATER_STORY_STATE_SYSTEM_PROMPT = [
  '【剧情小抄整理】\n将 I 和 you 在本剧场的有效小抄与后续台词合成一份完整的新小抄；没有小抄时，从本次台词整理。',
  '保留身份、关系、当前处境与目标、重要变化及其起因、约定和未解决的事。合并重复内容，更新已变化的状态。',
  '只整理已有剧情，不把设定或打算写成已发生的事，不续写。输出简明的小抄正文，可以写成一段话，也可以按要点逐条列出。',
].join('\n\n');

export const THEATER_STORY_STATE_CANDIDATE_PROMPT = '【候选剧情锚点】\n从已有剧情中提出值得长期保留的身份来由、重要变化、世界规则或关键关系，不重复已有锚点；没有合适内容就不提。\n候选仅供 you 确认，不修改已固定的锚点。';

export const THEATER_STORY_STATE_TASK_PROMPT = [
  '【本次整理】',
  '输出一个包含 summary 和 anchor_candidates 两个字段的 JSON 对象。',
  'summary：更新后的完整剧情小抄。',
  'anchor_candidates：候选锚点数组；没有候选时为 []。',
  '每条候选包含 content 和 source_message_index。content 是锚点正文；source_message_index 是发生台词在本次实际台词中的序号，从 1 开始，仅见于旧小抄或不能确定时填 null。',
].join('\n');

export function buildTheaterStoryStateSystemPrompt(input: {
  anchorBlock?: string;
  persona: string;
  names?: { I: string; you: string };
  previousStoryState?: string;
}) {
  const persona = input.persona.trim()
    || composeTheaterPersona({ world: '', youIdentity: '', baiyunIdentity: '', tone: '' });
  return [
    THEATER_STORY_STATE_SYSTEM_PROMPT,
    THEATER_STORY_STATE_CANDIDATE_PROMPT,
    `【当前剧场设定】\n${persona}`,
    `【戏内称呼】\nI：${input.names?.I.trim() || '白云小姐'}\nyou：${input.names?.you.trim() || '小仓鼠'}`,
    input.anchorBlock,
    input.previousStoryState?.trim() ? `【上一份剧情小抄】\n${input.previousStoryState}` : '',
  ].filter(Boolean).join('\n\n');
}

export function formatTheaterStoryStateMessages(messages: TheaterStoryStateMessage[]) {
  return messages
    .filter((message) => (message.role === 'I' || message.role === 'you') && message.content.trim().length > 0)
    .map((message) => `${message.role}：${message.content.trim()}`)
    .join('\n');
}

export function buildTheaterStoryStateUserPrompt(input: {
  messages: TheaterStoryStateMessage[];
  persona: string;
  previousStoryState?: string;
}) {
  const cleanPersona = input.persona.trim() || DEFAULT_THEATER_PERSONA;
  const recentMessages = formatTheaterStoryStateMessages(input.messages);

  return [
    `【当前剧场设定】\n${cleanPersona}`,
    input.previousStoryState?.trim()
      ? `【上一份剧情小抄】\n${input.previousStoryState.trim()}`
      : '',
    `【最近对话】\n${recentMessages || '本剧场还没有对话。'}`,
  ].filter(Boolean).join('\n\n');
}
