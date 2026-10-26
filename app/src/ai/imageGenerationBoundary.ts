export type GeneratedImageUseSource =
  | 'gift'
  | 'avatar'
  | 'background'
  | 'chatAttachment'
  | 'sticker'
  | 'writingIllustration'
  | 'other';

export type GeneratedImageAssetMetadata = {
  id: string;
  localUri: string;
  prompt: string;
  modelName: string;
  generatedAt: number;
  source: GeneratedImageUseSource;
  width?: number;
  height?: number;
  mimeType?: string;
};

export const imageGenerationBoundary = {
  connectionPurpose: 'imageGeneration',
  defaultResultStorage: 'local-uri',
  shouldUseChatCompletions: false,
  supportsChatFallback: false,
  notes: [
    '生图模型只预留槽位；当前不调用任何图片生成 API。',
    '未来需要单独 provider，不默认走 /chat/completions。',
    '生图失败时不能让聊天模型假装已经生成图片。',
    '生成结果应先落为本地 URI，再按礼物、背景、表情包或聊天附件场景消费。',
  ],
} as const;

export function createGeneratedImageAssetMetadata(input: GeneratedImageAssetMetadata) {
  return input;
}