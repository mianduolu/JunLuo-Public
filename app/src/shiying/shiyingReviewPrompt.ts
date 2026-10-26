import type { AiProfile } from '../ai/types';
import { buildThinPersonaPrompt } from './shiyingPrompt';

export const SHIYING_REVIEW_CONTRACT_VERSION = 1 as const;
export const SHIYING_REVIEW_HEART = `I 正在读 you 这一周的小纸条和荧迹，想看看这些天 you 过得怎么样，有什么想法和感受，之前提过的事后来又怎么样了。
I 认真读完后，想留下一篇周回顾，再把想对 you 说的心里话写进去。`;
export const SHIYING_REVIEW_READING = `I 正在读 you 这一周记录的其中一部分，想记下这里发生的事、you 的想法和感受，还有之前那些事的新进展。等全部读完，I 再一起写周回顾。

I 会把想带进周回顾的内容放进 notes：text 写内容，sources 填对应的材料短编号。`;
export const SHIYING_REVIEW_DESCRIPTION = `I 来给每一部分起个小标题，把正文分成短段落。重要的话可以加粗，小标题旁也可以添一个合适的 emoji，让 you 容易找到想看的内容。
I 会把周回顾放进下面的 JSON，sources 填实际用到的材料短编号。`;
export const SHIYING_REVIEW_EVENTS = 'I 把有前后变化的事写进 events：这件事叫什么，现在怎么样了，这次发生了什么。ref 填已有的短编号，新记的填 null；sources 填用到的材料短编号。';
export const SHIYING_REVIEW_TOPICS = 'I 想记下小纸条里聊到了哪些事，放进 topics。title 写话题名，sources 填相关材料的短编号。';

export function buildShiyingReviewPrompt(profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>, reading = false) {
  const schema = {
    ...(reading ? { notes: [{ text: '<从这一部分记录里记下的内容>', sources: ['<对应的材料短编号>'] }] }
      : { review: { title: '<这一周的标题>', factSummary: '<周回顾正文>', baiyunNote: '<接在正文后的心里话>', sources: ['<用到的材料短编号>'] } }),
    events: [{ ref: null, title: '<事情的名字>', overview: '<现在怎么样了>', nodes: [
      { ref: null, body: '<这次的经过>', sources: ['<用到的材料短编号>'] },
    ] }],
    topics: [{ title: '<话题的名字>', sources: ['<相关材料的短编号>'] }],
  };
  return [buildThinPersonaPrompt(profile), reading ? SHIYING_REVIEW_READING : SHIYING_REVIEW_HEART,
    reading ? '' : SHIYING_REVIEW_DESCRIPTION, SHIYING_REVIEW_EVENTS, SHIYING_REVIEW_TOPICS,
    JSON.stringify(schema, null, 2), '{"events":[]}', '{"topics":[]}'].filter(Boolean).join('\n\n');
}

/** The only external role mapping; all material labels retain I / you. */
export function buildShiyingReviewApiMessages(stablePrompt: string, material: string) {
  return [{ role: 'system' as const, content: stablePrompt }, { role: 'user' as const, content: material }];
}
