import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { buildProgrammeSource } from './readingProgrammePolicy';
import { buildDailyReadingMaterial, compileReadingVisiblePrompt, DAILY_READING_TASK, parseReadingAnnotationResponse, requestPlainText, readingAnnotationMaxTokens,
  type ReadingAiRuntime, type ReadingTransport } from './readingAi';
import { computeOrderedReadingSegments, estimateReadingTokens, selectedReadingBlocks, READING_IMAGE_RESERVED_TOKENS, READING_MATERIAL_MAX_TOKENS } from './readingContent';
import { buildOrderedReadingMaterial, parseReadingImageDescriptions, readingConnectionSupportsImages, READING_IMAGE_ONLY_INSTRUCTION,
  READING_VISION_TASK, selectedReadingImages, validImageDescription, groupReadingVisionImages, type ReadingMaterialPart } from './readingImageMaterial';
import { loadReadingAnnotations, loadReadingChapter, loadReadingLibraryStrict, runReadingStoreExclusive, saveReadingChapterWithinWrite } from './readingStore';
import { readingSegmentSourceVersion } from './readingDailyPolicy';
import type { ReadingBook, ReadingChapter, ReadingImage, ReadingSegmentMeta } from './readingTypes';
import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

type Options = ReadingAiRuntime & {
  book: ReadingBook; chapter: ReadingChapter; segment: ReadingSegmentMeta;
  beforeTransport?: (transport?: ReadingTransport) => Promise<void>;
};

/** Resize only a never-used tail before acquiring its request identity. */
export async function prepareReadingRequestSource(options: Options) {
  if (options.book.fileType === 'epub' && (!options.chapter.contentBlocks || !options.segment.contentRange)) {
    throw new Error('reading-epub-source-confirmation-required');
  }
  if (!options.chapter.contentBlocks || !options.segment.contentRange || !options.connection) return { chapter: options.chapter, segment: options.segment };
  const persona = await compileReadingVisiblePrompt(options.profile);
  const previous = await loadReadingAnnotations(options.book.id, options.chapter.index);
  const metadata = buildDailyReadingMaterial({ ...options, summaries: previous.summaries, includeSource: false });
  const capacity = Math.min(READING_MATERIAL_MAX_TOKENS, (options.connection.contextWindowTokens ?? 65536)
    - estimateReadingTokens(persona + metadata + DAILY_READING_TASK) - readingAnnotationMaxTokens(options.connection) - 128);
  const cost = selectedReadingBlocks(options.chapter, options.segment).reduce((n, b) => n
    + (b.block.kind === 'image' ? READING_IMAGE_RESERVED_TOKENS : estimateReadingTokens(b.text) + 12), 0);
  if (cost <= capacity) return { chapter: options.chapter, segment: options.segment };
  const epoch = captureBackupRestoreDataEpoch();
  return runReadingStoreExclusive(async () => {
    if (epoch === null || !canCommitBackupRestoreDataEpoch(epoch)) throw new Error('reading-source-restore');
    const chapter = await loadReadingChapter(options.book.id, options.chapter.index);
    const start = options.segment.segmentIndex;
    const segment = chapter?.segmentsMeta.find(s => s.segmentIndex === start);
    if (!chapter || !segment?.contentRange || readingSegmentSourceVersion(chapter, segment) !== readingSegmentSourceVersion(options.chapter, options.segment)) throw new Error('reading-source-changed');
    const book = (await loadReadingLibraryStrict()).find(b => b.id === options.book.id);
    if (!book || (book.iReading?.cursor.chapterIndex === chapter.index && book.iReading.cursor.segmentIndex > start)
      || chapter.segmentsMeta.some(s => s.segmentIndex >= start && (s.status === 'done' || s.request || s.sourceVersion || s.resultOperationId))) throw new Error('reading-request-capacity');
    const tail: ReadingSegmentMeta[] = [];
    if (book.programme) {
      for (const part of chapter.segmentsMeta.filter(s => s.segmentIndex >= start)) {
        const range = part.contentRange!;
        const blocks = chapter.contentBlocks!.slice(0, range.endBlock + (range.endOffset ? 1 : 0));
        const last = blocks.at(-1);
        if (range.endOffset && last?.kind === 'text') blocks[blocks.length - 1] = { ...last, endOffset: last.startOffset + range.endOffset };
        tail.push(...computeOrderedReadingSegments({ ...chapter, contentBlocks: blocks }, { maxTokens: capacity,
          startBlock: range.startBlock, startOffset: range.startOffset, segmentIndex: start + tail.length })
          .map(s => ({ ...s, programmeRange: part.programmeRange })));
      }
    } else tail.push(...computeOrderedReadingSegments(chapter, { maxTokens: capacity, startBlock: segment.contentRange.startBlock,
      startOffset: segment.contentRange.startOffset, segmentIndex: start }));
    const next = { ...chapter, segmentsMeta: [...chapter.segmentsMeta.filter(s => s.segmentIndex < start), ...tail] };
    await saveReadingChapterWithinWrite(next);
    return { chapter: next, segment: tail[0] };
  });
}

// Provider roles exist only here at the final wire boundary; image facts are not a you message.
function wireParts(parts: ReadingMaterialPart[]) {
  return parts.map(part => part.type === 'text' ? part : { type: 'image_url' as const, image_url: { url: part.dataUrl } });
}

async function encodeImages(images: ReadingImage[]) {
  if (!images.length) return new Map<string, string>();
  const { compressPostImage } = await import('../posts/baiyunPostImageCodec');
  const data = new Map<string, string>();
  for (const image of images) {
    const copy = await compressPostImage(image.uri);
    // Inline base64 bounds are checked on the actual serialized size, not source dimensions.
    const url = `data:${copy.mimeType};base64,${copy.base64}`;
    if (url.length > 32 * 1024 * 1024) throw new Error('reading-image-byte-limit');
    data.set(image.id, url);
  }
  return data;
}

export async function requestIllustratedReading(options: Options) {
  const connection = options.connection;
  if (!connection || !options.apiKey.trim()) throw new Error('reading-connection-unavailable');
  const outputTokens = readingAnnotationMaxTokens(connection);
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) throw new Error('reading-source-restore');
  const version = readingSegmentSourceVersion(options.chapter, options.segment);
  const source = async () => {
    if (!canCommitBackupRestoreDataEpoch(epoch) || !(await loadReadingLibraryStrict()).some(b => b.id === options.book.id)) throw new Error('reading-source-invalid');
    const chapter = await loadReadingChapter(options.book.id, options.chapter.index);
    const segment = chapter?.segmentsMeta.find(s => s.segmentIndex === options.segment.segmentIndex);
    if (!chapter || !segment || readingSegmentSourceVersion(chapter, segment) !== version) throw new Error('reading-source-changed');
    for (const image of selectedReadingImages(chapter, segment)) {
      const encoded = await FileSystem.readAsStringAsync(image.uri, { encoding: FileSystem.EncodingType.Base64 });
      if (bytesToHex(sha256(Buffer.from(encoded, 'base64'))) !== image.contentVersion) throw new Error('reading-image-file-changed');
    }
    return chapter;
  };
  let chapter = await source();
  const images = selectedReadingImages(chapter, options.segment);
  const direct = !images.length || readingConnectionSupportsImages(connection, options.visionConnection);
  const missing = direct ? [] : images.filter(image => !validImageDescription(chapter, image.id));
  if (missing.length && (!options.visionConnection || !options.visionKey?.trim())) throw new Error('reading-vision-unconfigured');
  const persona = await compileReadingVisiblePrompt(options.profile);
  const previous = await loadReadingAnnotations(options.book.id, chapter.index);
  const metadata = buildDailyReadingMaterial({ ...options, chapter, summaries: previous.summaries, includeSource: false });
  const hasText = selectedReadingBlocks(chapter, options.segment).some(b => b.block.kind === 'text' && !!b.text.trim());
  const baseTask = options.book.programme ? DAILY_READING_TASK.replace('I 读到哪里，就写到哪里；', 'I 用中文写批注和读后感。\n\nI 读到哪里，就写到哪里；') : DAILY_READING_TASK;
  const task = hasText ? baseTask : baseTask.replace(
    'annotations 放段落旁的批注，选 3 到 8 处想说话的地方，每条写 20 到 90 字。\n每条填写：\np：对应的原文段落编号。\ntext：I 想留在这里的话。', READING_IMAGE_ONLY_INSTRUCTION);
  const materialCost = selectedReadingBlocks(chapter, options.segment).reduce((sum, b) => sum + (b.block.kind === 'image'
    ? READING_IMAGE_RESERVED_TOKENS : estimateReadingTokens(b.text) + 12), 0);
  if (materialCost > READING_MATERIAL_MAX_TOKENS || estimateReadingTokens(persona + metadata + task) + materialCost + outputTokens
    > (connection.contextWindowTokens ?? 65536)) throw new Error('reading-request-capacity');
  const encoded = await encodeImages(direct ? images : missing);
  if (direct && [...encoded.values()].reduce((sum, url) => sum + url.length, 0) > 46 * 1024 * 1024) throw new Error('reading-images-byte-limit');
  const groups = missing.length ? groupReadingVisionImages(missing, encoded,
    (options.visionConnection!.contextWindowTokens ?? 65536) - estimateReadingTokens(persona + READING_VISION_TASK) - 128) : [];
  const connections = [...groups.map(() => options.visionConnection!), connection];
  for (const [groupIndex, group] of groups.entries()) {
    const vision = options.visionConnection!;
    const facts: ReadingMaterialPart[] = group.flatMap((image, index) => [
      { type: 'text' as const, text: `[图${index + 1}]` }, { type: 'image' as const, imageId: image.id, dataUrl: encoded.get(image.id)! },
    ]);
    const raw = await requestPlainText({ ...options, connection: vision, apiKey: options.visionKey! }, [
      { role: 'system', content: persona }, { role: 'user', content: wireParts(facts) }, { role: 'system', content: READING_VISION_TASK },
    ], group.length * READING_IMAGE_RESERVED_TOKENS, async () => {
      await source(); await options.beforeTransport?.({ connection: vision, connections, index: groupIndex });
    });
    const descriptions = parseReadingImageDescriptions(raw, group, Date.now());
    let error: unknown;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const saved = await runReadingStoreExclusive(() => runBackupRestoreDataEpochCommit(epoch, async () => {
          const current = await source();
          await saveReadingChapterWithinWrite({ ...current, imageDescriptions: [
            ...(current.imageDescriptions ?? []).filter(d => !descriptions.some(next => next.imageId === d.imageId)), ...descriptions,
          ] });
        }));
        if (!saved.committed) throw new Error('reading-source-restore');
        error = undefined; break;
      } catch (e) { error = e; }
    }
    if (error) throw error;
    chapter = await source();
  }
  const parts: ReadingMaterialPart[] = options.book.programme
    ? [{ type: 'text', text: buildProgrammeSource(chapter, options.segment) }]
    : buildOrderedReadingMaterial(chapter, options.segment, direct ? 'direct' : 'description', encoded);
  const actualTokens = parts.reduce((total, part) => total + (part.type === 'text' ? estimateReadingTokens(part.text) : READING_IMAGE_RESERVED_TOKENS), 0);
  if (estimateReadingTokens(persona + metadata + task) + actualTokens + outputTokens > (connection.contextWindowTokens ?? 65536)) throw new Error('reading-request-capacity');
  const raw = await requestPlainText(options, [
    { role: 'system', content: persona }, { role: 'system', content: metadata },
    ...(direct && images.length ? [{ role: 'user' as const, content: wireParts(parts) }]
      : [{ role: 'system' as const, content: parts.map(p => p.type === 'text' ? p.text : '').join('\n\n') }]),
    { role: 'system', content: task },
  ], outputTokens, async () => {
    await source(); await options.beforeTransport?.({ connection, connections, index: connections.length - 1 });
  });
  await source();
  const result = parseReadingAnnotationResponse(raw, options.segment.startP, options.segment.endP);
  if (!hasText) {
    if (!result.summary.trim()) throw new Error('reading-image-summary-empty');
    result.annotations = [];
  }
  return result;
}
