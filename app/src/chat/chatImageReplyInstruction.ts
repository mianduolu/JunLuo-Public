export type ResolvedChatImageReplyMaterial = {
  name: string;
  visionStatus: 'ready' | 'metadata_only' | 'error';
  visionSummary?: string;
};

function buildVisionLine(image: ResolvedChatImageReplyMaterial) {
  const summary = image.visionSummary?.trim();
  if (image.visionStatus === 'ready' && summary) {
    return `I 从图片中看到：\n${summary}`;
  }
  if (image.visionStatus === 'metadata_only') {
    return 'I 这次只拿到了图片文件信息，看图连接尚未配置。';
  }
  return 'I 这次没有看清图片，看图请求没有成功。';
}

export function buildImageReplyInstruction(
  image: ResolvedChatImageReplyMaterial,
  userText: string,
) {
  const trimmedUserText = userText.trim();
  const userLine = trimmedUserText
    ? `you 同时说：\n${trimmedUserText}`
    : 'you 只发来了图片，没有附带文字。';

  return [
    '【图片消息】',
    'you 刚发来一张图片。',
    `图片文件名：${image.name}`,
    '',
    buildVisionLine(image),
    '',
    userLine,
    '',
    '本轮围绕这张图片和 you 同时说的话自然回应。',
  ].join('\n');
}
