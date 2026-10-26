export type MediaImageIntentRoute = {
  candidateTools: string[];
  reason: string;
};

const CACHE_ID_PATTERN = /\bfile-[a-z0-9-]+\b/i;

function trimPrompt(text: string) {
  return text
    .replace(/帮我|请|可以|能不能|一下|一张|一个|生成图片|生成视频|生图|生视频|画|画个|画一张|做个视频|视频生成/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function routeMediaImageIntent(text: string): MediaImageIntentRoute | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (/生成视频|生视频|视频生成|做个视频|做一段视频/.test(trimmed)) {
    return { candidateTools: ['video.generate'], reason: 'video_generate_unsupported' };
  }

  if (/生成图片|生图|画一张|画个|帮我画|画张|画幅/.test(trimmed)) {
    return { candidateTools: ['image.generate'], reason: 'image_generate_unsupported' };
  }

  if (/截图|截屏|屏幕截图/.test(trimmed)) {
    return { candidateTools: ['media.take_screenshot'], reason: 'media_take_screenshot' };
  }

  if (/打开相机|拍一张|拍张|拍照|照相/.test(trimmed)) {
    return { candidateTools: ['media.open_camera'], reason: 'media_open_camera' };
  }

  if (/描述.*(?:图片|照片|图)|看看.*(?:图片|照片|图)|这张图|这张照片|图片里|照片里|图里|看图|我给你看张图|给你看张图|给你看照片|看张照片/.test(trimmed)) {
    return { candidateTools: ['image.describe_local'], reason: 'image_describe_local' };
  }

  if (/选.*(?:图片|照片|图)|打开相册|相册选/.test(trimmed)) {
    return { candidateTools: ['media.pick_image'], reason: 'media_pick_image' };
  }

  return null;
}

export function parseImageCacheIdFromText(text: string) {
  return text.match(CACHE_ID_PATTERN)?.[0];
}

export function parseImageDescribeInputFromText(text: string): Record<string, unknown> | null {
  const cacheId = parseImageCacheIdFromText(text);
  return cacheId ? { cacheId } : null;
}

export function parseImageGenerateInputFromText(text: string): Record<string, unknown> {
  return { prompt: trimPrompt(text) || text.trim() };
}

export function parseVideoGenerateInputFromText(text: string): Record<string, unknown> {
  return { prompt: trimPrompt(text) || text.trim() };
}
