import type { AiConnection } from '../ai/types';
import { estimateReadingTokens, READING_IMAGE_RESERVED_TOKENS, selectedReadingBlocks } from './readingContent';
import type { ReadingChapter, ReadingImage, ReadingImageDescription, ReadingSegmentMeta } from './readingTypes';

/** Determine the complete transport plan before the first paid request. */
export function groupReadingVisionImages(images: ReadingImage[], encoded: Map<string, string>, availableTokens: number) {
  const groups: ReadingImage[][] = [];
  let group: ReadingImage[] = [], bytes = 0;
  for (const image of images) {
    const size = encoded.get(image.id)?.length ?? Infinity;
    if (size > 46 * 1024 * 1024 || availableTokens < READING_IMAGE_RESERVED_TOKENS * 2) throw new Error('reading-vision-capacity');
    if (group.length && (bytes + size > 46 * 1024 * 1024
      || (group.length + 1) * READING_IMAGE_RESERVED_TOKENS * 2 > availableTokens)) {
      groups.push(group); group = []; bytes = 0;
    }
    group.push(image); bytes += size;
  }
  if (group.length) groups.push(group);
  return groups;
}

export type ReadingMaterialPart = { type: 'text'; text: string } | { type: 'image'; imageId: string; dataUrl: string };
export const READING_VISION_TASK = `【书中插图】

I 正在看书中的插图，记下实际可见的内容，供接着阅读时参考。

按图片编号分别记录画面、可辨认的文字和图表关系；看不清或不能确定的地方如实记下，不补猜。`;
export const READING_IMAGE_ONLY_INSTRUCTION = '这一段只有插图，annotations 写 []，感想写进 summary。';

export function readingConnectionSupportsImages(connection: AiConnection, selectedVision?: AiConnection) {
  const address = connection.baseUrl.trim().replace(/\/+$/, '');
  if (selectedVision && address === selectedVision.baseUrl.trim().replace(/\/+$/, '')
    && connection.model.trim() === selectedVision.model.trim()) return true;
  return /^https:\/\/api\.deepseek\.com(?:\/v1)?$/.test(address)
    && ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-vision-exp'].includes(connection.model.trim());
}

export function selectedReadingImages(chapter: ReadingChapter, segment: ReadingSegmentMeta) {
  const selected = selectedReadingBlocks(chapter, segment).filter(item => item.block.kind === 'image');
  if (selected.some(item => !item.image)) throw new Error('reading-image-source-missing');
  return [...new Map(selected.map(item => [item.image!.id, item.image!])).values()];
}

export function validImageDescription(chapter: ReadingChapter, imageId: string) {
  const image = chapter.images?.find(item => item.id === imageId);
  return chapter.imageDescriptions?.find(d => d.imageId === imageId && d.contentVersion === image?.contentVersion);
}

export function buildOrderedReadingMaterial(chapter: ReadingChapter, segment: ReadingSegmentMeta,
  route: 'direct' | 'description', imageData: Map<string, string> = new Map()): ReadingMaterialPart[] {
  const parts: ReadingMaterialPart[] = [{ type: 'text', text: route === 'direct'
    ? '【这次读到的内容】\n\n以下是书中的原文与插图。'
    : '【这次读到的内容】\n\n以下是书中的原文；插图位置提供的是图片描述。' }];
  const selected = selectedReadingBlocks(chapter, segment);
  const images = selectedReadingImages(chapter, segment);
  for (const item of selected) {
    if (item.block.kind === 'text') { parts.push({ type: 'text', text: `[${item.block.paragraphIndex}] ${item.text}` }); continue; }
    const imageId = item.block.imageId;
    const n = images.findIndex(image => image.id === imageId) + 1;
    if (route === 'description') {
      const description = validImageDescription(chapter, item.image!.id);
      if (!description) throw new Error('reading-image-description-missing');
      parts.push({ type: 'text', text: `[图${n}·图片描述]\n${description.text}` });
    } else {
      const dataUrl = imageData.get(item.image!.id);
      if (!dataUrl) throw new Error('reading-image-data-missing');
      parts.push({ type: 'text', text: `[图${n}]` }, { type: 'image', imageId: item.image!.id, dataUrl });
    }
  }
  return parts;
}

/** Numbered prose is the approved contract; an ambiguous group is not silently assigned to every image. */
export function parseReadingImageDescriptions(raw: string, images: NonNullable<ReadingChapter['images']>, savedAt: number): ReadingImageDescription[] {
  if (!raw.trim() || !images.length) throw new Error('reading-image-description-empty');
  const headings = [...raw.matchAll(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?(?:\[|【)?(?:图(?:片)?\s*)(\d+)(?:\]|】)?(?:\*\*)?[：:.、]?\s*/g)];
  if (images.length > 1 && (headings.length !== images.length || headings.some((m, i) => Number(m[1]) !== i + 1))) {
    throw new Error('reading-image-description-numbering');
  }
  return images.map((image, index) => {
    const text = headings.length === images.length
      ? raw.slice(headings[index].index! + headings[index][0].length, headings[index + 1]?.index ?? raw.length).trim() : raw.trim();
    if (!text || estimateReadingTokens(text) > READING_IMAGE_RESERVED_TOKENS) throw new Error('reading-image-description-capacity');
    return { imageId: image.id, contentVersion: image.contentVersion, text, savedAt };
  });
}
