export const BLOCKED_PHRASES = [
  '给自己的生活找一条主线',
  '自己的长期主线',
  '主线起点',
  '起点和鼠的影子',
  '慢慢推进的线',
  '让白云小姐的一天有前因后果',
  '常驻的角落留言',
  '值得被坚定选择',
  '不需要你变好',
  '监督表情',
  '又不会跑掉',
  '跑不掉',
];

export const BLOCKED_STYLE_RULES = [
  '不要把小仓鼠的不安、脆弱、自我怀疑、请求、隐私或原话写成白云小姐要完成的任务。',
  '不要生成监督感、治疗感、心理报告感、承诺口号或“你值得/你不需要变好”式安抚模板。',
  '不要使用“X又不会跑掉 / X跑不掉 / X不会因为Y就跑掉”这类静态不会消失安抚；它是在重复显而易见的稳定性，不是具体回应。',
  '不要让白云小姐像客服、心理医生、旁观记录员或任务管理器；她的日常应是具体生活动作和自然牵挂。',
  '如果内容需要提到小仓鼠，只写有证据的近况和轻轻想起，不推断疾病、人格、动机或未说出口的情绪。',
];

export function containsBlockedPhrase(text: string): boolean {
  return BLOCKED_PHRASES.some((phrase) => text.includes(phrase));
}

export function getBlockedStyleInstruction(): string {
  return `生活感护栏：\n${BLOCKED_STYLE_RULES.map((rule) => `- ${rule}`).join('\n')}`;
}
