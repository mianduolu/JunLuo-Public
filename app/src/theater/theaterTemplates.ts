export type TheaterTemplate = {
  baiyunIdentity: string;
  openingPrompt: string;
  title: string;
  tone: string;
  world: string;
  youIdentity: string;
};

export function composeTheaterPersona(input: {
  baiyunIdentity: string;
  tone: string;
  world: string;
  youIdentity: string;
}) {
  return [
    `【世界设定】\n${input.world.trim() || '这是 I 和 you 共同进入的一段平行故事。'}`,
    `【you 的故事身份】\n${input.youIdentity.trim() || 'you 仍是 you，也可以在故事中自然补充身份细节。'}`,
    `【I 的故事身份】\n${input.baiyunIdentity.trim() || 'I 仍是 I，也可以在故事中自然补充身份细节。'}`,
    `【故事语气】\n${input.tone.trim() || '自然延续 I 和 you 在当前故事里的互动。'}`,
  ].join('\n\n');
}

export const DEFAULT_THEATER_OPENING_PROMPT = '从当前剧场设定开始这段故事。';

export const defaultTheaterDraft: TheaterTemplate = {
  baiyunIdentity: '',
  openingPrompt: '',
  title: '',
  tone: '',
  world: '',
  youIdentity: '',
};
