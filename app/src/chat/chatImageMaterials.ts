import type { MessageImage } from '../ai/subjectiveMessages';
import type { JunLuoToolInputSchema, JunLuoToolResult } from '../tools/toolTypes';

export const CHAT_IMAGE_TOOL_ID = 'image.describe_local';
export const CHAT_IMAGE_FAILURE = '这次没有取得图片观察结果。';
export const CHAT_IMAGE_MISSING = '这次没能读取到原图。';
export const CHAT_IMAGE_UNCONFIGURED = '看图连接尚未配置。';
export const CHAT_IMAGE_SCHEMA: JunLuoToolInputSchema & { type: 'object' } = {
  type: 'object', additionalProperties: false,
  properties: {
    image: { type: 'number', description: '要查看的图片编号，沿用本轮图片资料中的编号。' },
    question: { type: 'string', description: '这次想从图片中确认的内容。' },
  }, required: ['image', 'question'],
};

export function chatImageObservation(number: number, sentAt: number, summary: string, observedAt?: number) {
  const observed = observedAt === undefined ? undefined : new Date(observedAt);
  const observedLine = observed && Number.isFinite(observed.getTime()) ? `观察时间：${observed.toISOString()}\n` : '';
  return `【图片观察结果】\n\n图片：${number}\n原图发送时间：${new Date(sentAt).toISOString()}\n${observedLine}本次看图结果：\n${summary}`;
}

export function chatImageMaterial(number: number, sentAt: number, image: MessageImage) {
  const first = image.visionStatus === 'ready' && image.visionSummary
    ? image.visionSummary : image.visionError === CHAT_IMAGE_MISSING ? CHAT_IMAGE_MISSING
    : image.visionStatus === 'metadata_only' ? CHAT_IMAGE_UNCONFIGURED : CHAT_IMAGE_FAILURE;
  return [chatImageObservation(number, sentAt, first, image.visionStatus === 'ready' && image.visionSummary ? image.visionObservedAt : undefined), ...(image.visionReview ? [
    `【I 这次想确认的问题】\n\n${image.visionReview.question}`,
    chatImageObservation(number, sentAt, image.visionReview.summary, image.visionReview.observedAt),
  ] : [])].join('\n\n');
}

/** All observation text stays in data: the standard whole-result omission can remove it atomically. */
export function projectChatImageResult(result: JunLuoToolResult): JunLuoToolResult {
  if (result.toolId !== CHAT_IMAGE_TOOL_ID) return result;
  if (result.ok) return { ...result, summary: '', data: { observation: (result.data as { observation?: string })?.observation } };
  return { ...result, data: undefined, summary: [CHAT_IMAGE_FAILURE, CHAT_IMAGE_MISSING, CHAT_IMAGE_UNCONFIGURED].includes(result.summary)
    ? result.summary : CHAT_IMAGE_FAILURE, error: result.error ? { code: result.error.code, message: result.error.code } : undefined };
}
