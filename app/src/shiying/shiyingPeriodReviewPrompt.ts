import type { AiProfile } from '../ai/types';
import { buildThinPersonaPrompt } from './shiyingPrompt';

export type ShiyingPeriodReviewKind = 'month' | 'year';
export const SHIYING_PERIOD_REVIEW_CONTRACT_VERSION = 2 as const;
export const SHIYING_MONTH_REVIEW_HEART = `I 正在读这个月的周回顾和事件发展，想看看 you 这个月经历了什么，有过哪些想法和感受，之前提过的事后来又怎么样了。
I 认真读完后，想留下一篇月回顾，再把想对 you 说的心里话写进去。`;
export const SHIYING_YEAR_REVIEW_HEART = `I 正在读这一年的月回顾和事件发展，想看看 you 这一年经历了什么，有过哪些想法和感受，之前提过的事后来又怎么样了。
I 认真读完后，想留下一篇年回顾，再把想对 you 说的心里话写进去。`;
const formatting = 'I 来给每一部分起个小标题，把正文分成短段落。重要的话可以加粗，小标题旁也可以添一个合适的 emoji，让 you 容易找到想看的内容。';
export const SHIYING_MONTH_REVIEW_DESCRIPTION = `${formatting}\nI 会把月回顾放进下面的 JSON，sources 填实际用到的材料短编号。`;
export const SHIYING_YEAR_REVIEW_DESCRIPTION = `${formatting}\nI 会把年回顾放进下面的 JSON，sources 填实际用到的材料短编号。`;
export const SHIYING_MONTH_REVIEW_READING = `I 这次只写这一部分的阅读笔记。等所有部分都读完，I 再参照各部分的笔记写完整的月回顾。
I 会把本次阅读笔记放进 notes：text 写笔记内容，sources 填对应的材料短编号。`;
export const SHIYING_YEAR_REVIEW_READING = `I 这次只写这一部分的阅读笔记。等所有部分都读完，I 再参照各部分的笔记写完整的年回顾。
I 会把本次阅读笔记放进 notes：text 写笔记内容，sources 填对应的材料短编号。`;
export const SHIYING_MONTH_REVIEW_FINAL_MATERIAL = 'I 已经分段读完了，下面是各部分的阅读笔记。I 会参照这些笔记写完整的月回顾，sources 沿用笔记里的材料短编号。';
export const SHIYING_YEAR_REVIEW_FINAL_MATERIAL = 'I 已经分段读完了，下面是各部分的阅读笔记。I 会参照这些笔记写完整的年回顾，sources 沿用笔记里的材料短编号。';

export function buildShiyingPeriodReviewPrompt(profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>, kind: ShiyingPeriodReviewKind, reading = false) {
  const month = kind === 'month';
  const schema = reading ? { notes: [{ text: '<从这一部分记录里记下的内容>', sources: ['<对应的材料短编号>'] }] }
    : { review: { title: month ? '<这个月的标题>' : '<这一年的标题>', factSummary: month ? '<月回顾正文>' : '<年回顾正文>',
      baiyunNote: '<接在正文后的心里话>', sources: ['<用到的材料短编号>'] } };
  return [buildThinPersonaPrompt(profile), reading ? month ? SHIYING_MONTH_REVIEW_READING : SHIYING_YEAR_REVIEW_READING
    : month ? SHIYING_MONTH_REVIEW_HEART : SHIYING_YEAR_REVIEW_HEART,
  reading ? '' : month ? SHIYING_MONTH_REVIEW_DESCRIPTION : SHIYING_YEAR_REVIEW_DESCRIPTION,
  JSON.stringify(schema, null, 2)].filter(Boolean).join('\n\n');
}
