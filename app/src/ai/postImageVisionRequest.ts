export type PostVisionImage = { imageDataUrl: string; mimeType: string };
export type VisionContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type VisionRequestMessage = { role: 'system'; content: string } | { role: 'user'; content: VisionContentPart[] };

// Approved group-image wording; external protocol roles are assigned only in this request adapter.
export function buildPostImageVisionMessages(images: readonly PostVisionImage[]): VisionRequestMessage[] {
  if (!Array.isArray(images) || images.length < 1 || images.length > 9) throw new Error('baiyun-post-vision-image-count');
  const content: VisionContentPart[] = [{
    type: 'text',
    text: 'I 按图片顺序，把主体、可见文字、环境、颜色、表情和构图中的重要细节，整理成一份简短的整组记录。\n\n需要区分图片时，I 用图片编号说明。如果是截图，I 也记下界面结构和其中重要的文字。',
  }];
  images.forEach((image, index) => {
    const value = image?.imageDataUrl?.trim();
    if (!value || (value.startsWith('data:') && (value.indexOf(',') < 0 || !value.slice(value.indexOf(',') + 1).trim()))) throw new Error('baiyun-post-vision-empty-image');
    content.push({ type: 'text', text: `图片 ${index + 1}` });
    content.push({ type: 'image_url', image_url: { url: value.startsWith('data:') ? value : `data:${image.mimeType};base64,${value}` } });
  });
  return [
    { role: 'system', content: '【图片理解】\nI 正在看这组图片，整理其中实际可见的内容，供后续回应 you 时参考。不确定的部分标明不确定。' },
    { role: 'user', content },
  ];
}
