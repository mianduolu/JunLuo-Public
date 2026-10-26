import type { ReadingChapter, ReadingContentBlock, ReadingContentRange, ReadingSegmentMeta } from './readingTypes';

export const READING_MATERIAL_NOMINAL_TOKENS = 6000;
export const READING_MATERIAL_SOFT_TOKENS = 3600;
export const READING_MATERIAL_MAX_TOKENS = 4500;
// Covers an outbound image or its bounded description, not a provider billing claim.
export const READING_IMAGE_RESERVED_TOKENS = 1024;

export function estimateReadingTokens(text: string) {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/g)?.length ?? 0;
  return Math.ceil(cjk * 1.05 + (text.length - cjk) / 3.5);
}

export function readingBlockText(chapter: ReadingChapter, block: ReadingContentBlock) {
  return block.kind === 'text'
    ? (chapter.paragraphs[block.paragraphIndex] ?? '').slice(block.startOffset, block.endOffset) : '';
}

/** New imports only. Existing segment identities and annotations are never renumbered. */
export function computeOrderedReadingSegments(chapter: Pick<ReadingChapter, 'paragraphs' | 'contentBlocks'>,
  options: { maxTokens?: number; startBlock?: number; startOffset?: number; segmentIndex?: number } = {}): ReadingSegmentMeta[] {
  const maxTokens = Math.min(READING_MATERIAL_MAX_TOKENS, options.maxTokens ?? READING_MATERIAL_MAX_TOKENS);
  if (!Number.isFinite(maxTokens) || maxTokens < 32) throw new Error('reading-request-capacity');
  const source = chapter as ReadingChapter;
  const blocks = chapter.contentBlocks ?? [];
  const segments: ReadingSegmentMeta[] = [];
  let startBlock = options.startBlock ?? 0, startOffset = options.startOffset ?? 0, blockIndex = startBlock, offset = startOffset;
  let cost = 0, chars = 0;
  let paragraphIds: number[] = [];
  const close = (endBlock: number, endOffset: number) => {
    if (!cost) return;
    segments.push({ segmentIndex: (options.segmentIndex ?? 0) + segments.length, startP: paragraphIds.length ? Math.min(...paragraphIds) : 0,
      endP: paragraphIds.length ? Math.max(...paragraphIds) : 0, charCount: chars, status: 'pending',
      contentRange: { startBlock, startOffset, endBlock, endOffset } });
    cost = 0; chars = 0; paragraphIds = [];
    startBlock = blockIndex; startOffset = offset;
  };
  while (blockIndex < blocks.length) {
    const block = blocks[blockIndex];
    const text = readingBlockText(source, block);
    const length = block.kind === 'image' ? 1 : text.length;
    if (offset >= length) { blockIndex += 1; offset = 0; if (!cost) { startBlock = blockIndex; startOffset = 0; } continue; }
    const remaining = block.kind === 'image' ? READING_IMAGE_RESERVED_TOKENS : estimateReadingTokens(text.slice(offset)) + 12;
    if (block.kind === 'image' && maxTokens < READING_IMAGE_RESERVED_TOKENS) throw new Error('reading-request-capacity');
    if (cost && cost + remaining > maxTokens) {
      close(blockIndex, offset);
      continue;
    }
    if (block.kind === 'image') {
      cost += remaining; offset = 1;
    } else {
      let end = text.length;
      if (remaining > maxTokens) {
        let low = offset + 1, high = text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (estimateReadingTokens(text.slice(offset, mid)) + 12 <= maxTokens) low = mid;
          else high = mid - 1;
        }
        end = low;
        const piece = text.slice(offset, end);
        const boundaries = [...piece.matchAll(/[。！？!?；;\n](?:[”’"']|\s)*/g)];
        const boundary = boundaries[boundaries.length - 1];
        if (boundary && boundary.index! + boundary[0].length > piece.length / 2) end = offset + boundary.index! + boundary[0].length;
        // Never cut a UTF-16 surrogate pair.
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
      }
      const piece = text.slice(offset, end);
      cost += estimateReadingTokens(piece) + 12; chars += piece.length;
      paragraphIds.push(block.paragraphIndex); offset = end;
    }
    const lastBlock = blockIndex, lastOffset = offset;
    if (offset === length) { blockIndex += 1; offset = 0; }
    // Keep a following short caption with its picture when it fits.
    const next = blocks[blockIndex];
    const captionFits = block.kind === 'image' && next?.kind === 'text'
      && cost + estimateReadingTokens(readingBlockText(source, next)) + 12 <= maxTokens;
    if (cost >= Math.min(READING_MATERIAL_SOFT_TOKENS, maxTokens * 0.8) && !captionFits) close(lastBlock, lastOffset);
  }
  if (cost) close(blocks.length - 1, blocks[blocks.length - 1]?.kind === 'image' ? 1 : readingBlockText(source, blocks[blocks.length - 1]).length);
  return segments;
}

export function selectedReadingBlocks(chapter: ReadingChapter, segment: ReadingSegmentMeta) {
  const range = segment.contentRange;
  if (!range || !chapter.contentBlocks) return [];
  return chapter.contentBlocks.slice(range.startBlock, range.endBlock + 1).flatMap((block, index) => {
    const absolute = range.startBlock + index;
    const start = absolute === range.startBlock ? range.startOffset : 0;
    const text = readingBlockText(chapter, block);
    const end = absolute === range.endBlock ? range.endOffset : block.kind === 'image' ? 1 : text.length;
    if (end <= start) return [];
    return [{ block, text: text.slice(start, end), image: block.kind === 'image' ? chapter.images?.find(image => image.id === block.imageId) : undefined }];
  });
}

export function validReadingRange(value: unknown): ReadingContentRange | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const r = value as ReadingContentRange;
  if (![r.startBlock, r.startOffset, r.endBlock, r.endOffset].every(n => Number.isSafeInteger(n) && n >= 0)
    || r.endBlock < r.startBlock || (r.endBlock === r.startBlock && r.endOffset <= r.startOffset)) return undefined;
  return { startBlock: r.startBlock, startOffset: r.startOffset, endBlock: r.endBlock, endOffset: r.endOffset };
}

export function normalizeReadingContent(item: Partial<ReadingChapter>, paragraphs: string[]) {
  if (item.contentBlocks === undefined) return {};
  if (!Array.isArray(item.contentBlocks) || !Array.isArray(item.images)) throw new Error('reading-content-invalid');
  const images = item.images.map(image => {
    if (!image || !['id', 'uri', 'sourcePath', 'contentVersion'].every(k => typeof image[k as keyof typeof image] === 'string' && image[k as keyof typeof image])
      || ![image.width, image.height].every(n => Number.isFinite(n) && n > 0)) throw new Error('reading-image-invalid');
    return { id: image.id, uri: image.uri, sourcePath: image.sourcePath, contentVersion: image.contentVersion, width: image.width, height: image.height };
  });
  if (new Set(images.map(i => i.id)).size !== images.length) throw new Error('reading-image-duplicate');
  const contentBlocks = item.contentBlocks.map(block => {
    if (block.kind === 'image' && images.some(image => image.id === block.imageId)) return { kind: 'image' as const, imageId: block.imageId };
    if (block.kind === 'text' && Number.isSafeInteger(block.paragraphIndex) && block.paragraphIndex >= 0
      && [block.startOffset, block.endOffset].every(Number.isSafeInteger) && block.startOffset >= 0
      && block.endOffset > block.startOffset && block.endOffset <= (paragraphs[block.paragraphIndex]?.length ?? 0)) return { ...block };
    throw new Error('reading-block-invalid');
  });
  const imageDescriptions = (item.imageDescriptions ?? []).filter(d => images.some(i => i.id === d.imageId && i.contentVersion === d.contentVersion)
    && typeof d.text === 'string' && !!d.text.trim() && Number.isFinite(d.savedAt)).map(d => ({ ...d }));
  return { contentBlocks, images, imageDescriptions };
}
