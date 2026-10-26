import { composeTheaterPersona, DEFAULT_THEATER_OPENING_PROMPT } from './theaterTemplates';

export const DEFAULT_THEATER_PERSONA =
  '这是 I 和 you 的轻量小剧场；I 保持自己的说话方式，自然回应 you。';

export function buildTheaterSystemPrompt({
  anchorBlock,
  names,
  openingPrompt,
  persona,
  storyState,
}: {
  anchorBlock?: string;
  names?: { I: string; you: string };
  openingPrompt?: string;
  persona: string;
  storyState?: string;
}) {
  const cleanPersona = persona.trim() || composeTheaterPersona({ world: '', youIdentity: '', baiyunIdentity: '', tone: '' });
  const cleanStoryState = storyState?.trim();

  return [
    '【小剧场】\nI 以本场设定中的身份，带着自己的性格、经历和当下的感受，与 you 互动。言语、动作和描写承接已有剧情；I 既回应 you，也会主动表达、作出选择，让故事在彼此的互动中继续发展。',
    `【当前剧场设定】\n${cleanPersona}`,
    `【戏内称呼】\nI：${names?.I.trim() || '白云小姐'}\nyou：${names?.you.trim() || '小仓鼠'}`,
    openingPrompt === undefined ? anchorBlock : '',
    openingPrompt === undefined && cleanStoryState ? `【当前剧情小抄】\n${storyState}` : '',
    openingPrompt !== undefined ? '【本次开场】\n本次由 I 写出开场正文。' : '',
    openingPrompt !== undefined ? `【开场提示】\n${openingPrompt.trim() || DEFAULT_THEATER_OPENING_PROMPT}` : '',
  ].filter(Boolean).join('\n\n');
}
