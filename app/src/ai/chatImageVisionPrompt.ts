export type ChatImageVisionMaterial = {
  kind: 'first' | 'review';
  question: string;
};

export const CHAT_IMAGE_VISION_SYSTEM_PROMPT = `【图片理解】

I 正在查看 you 发来的这张图片，整理实际可见的内容，供接着和 you 说话时参考。

有具体问题时，先查看与问题有关的部分；没有具体问题时，描述画面里的主要内容。

看不清或不能确定的地方，如实说明。`;

// Source labels stay subjective here; the provider assigns transport roles at the boundary.
export function buildChatImageVisionPrompt(material: ChatImageVisionMaterial) {
  return {
    systemPrompt: CHAT_IMAGE_VISION_SYSTEM_PROMPT,
    questionText: material.question.length
      ? `${material.kind === 'first' ? '【you 随图说的话】' : '【I 这次想确认的问题】'}\n\n${material.question}`
      : undefined,
  };
}
