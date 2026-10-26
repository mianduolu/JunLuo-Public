import type { ShiyingChatMaterialV1 } from './shiyingChatSource';

export const SHIYING_CHUNK_MESSAGE_LIMIT = 60;
export const SHIYING_CHUNK_CONTINUITY_OVERLAP = 2;
export const SHIYING_CHUNK_CLEAR_GAP_MS = 45 * 60 * 1_000;

export type ShiyingMaterialChunkV1 = {
  chunkIndex: number;
  startIndex: number;
  endIndex: number;
  overlapFromPrevious: number;
  estimatedTokens: number;
  messages: ShiyingChatMaterialV1[];
};

export type ShiyingSegmentationPlanV1 =
  | { kind: 'ready'; chunks: ShiyingMaterialChunkV1[] }
  | {
      kind: 'blocked';
      chunks: ShiyingMaterialChunkV1[];
      blockedMessageIndex: number;
      estimatedTokens: number;
    };

type SegmentOptions = {
  messages: readonly ShiyingChatMaterialV1[];
  tokenLimit: number;
  estimateTokens(messages: readonly ShiyingChatMaterialV1[]): number;
};

type PlannedSlice = Omit<ShiyingMaterialChunkV1, 'chunkIndex' | 'messages'>;

function isSafeTokenCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0;
}

function hasYou(messages: readonly ShiyingChatMaterialV1[], start: number, end: number) {
  for (let index = start; index < end; index += 1) {
    if (messages[index]?.role === 'you') return true;
  }
  return false;
}

function nextYouIndex(messages: readonly ShiyingChatMaterialV1[], start: number) {
  for (let index = start; index < messages.length; index += 1) {
    if (messages[index]?.role === 'you') return index;
  }
  return -1;
}

function isClearBoundary(messages: readonly ShiyingChatMaterialV1[], endIndex: number) {
  if (endIndex <= 0 || endIndex >= messages.length) return false;
  const left = messages[endIndex - 1];
  const right = messages[endIndex];
  return left.sessionId !== right.sessionId
    || right.messageCreatedAt - left.messageCreatedAt >= SHIYING_CHUNK_CLEAR_GAP_MS;
}

function boundaryStrength(messages: readonly ShiyingChatMaterialV1[], endIndex: number) {
  if (!isClearBoundary(messages, endIndex)) return 0;
  const left = messages[endIndex - 1];
  const right = messages[endIndex];
  return left.sessionId !== right.sessionId
    ? Number.MAX_SAFE_INTEGER
    : right.messageCreatedAt - left.messageCreatedAt;
}

function totalOverlap(slices: readonly PlannedSlice[]) {
  return slices.reduce((sum, slice) => sum + slice.overlapFromPrevious, 0);
}

function renumber(
  messages: readonly ShiyingChatMaterialV1[],
  slices: readonly PlannedSlice[],
): ShiyingMaterialChunkV1[] {
  return slices.map((slice, chunkIndex) => ({
    ...slice,
    chunkIndex,
    messages: messages.slice(slice.startIndex, slice.endIndex),
  }));
}

function buildGreedySlices(
  options: SegmentOptions,
  initialStart = 0,
  initialOverlap = 0,
): ShiyingSegmentationPlanV1 {
  const { messages } = options;
  const slices: PlannedSlice[] = [];
  let startIndex = initialStart;
  let overlapFromPrevious = initialOverlap;

  while (startIndex < messages.length) {
    const upcomingYou = nextYouIndex(messages, startIndex);
    if (upcomingYou < 0) break;
    if (upcomingYou - startIndex >= SHIYING_CHUNK_MESSAGE_LIMIT) {
      startIndex = Math.max(startIndex, upcomingYou - SHIYING_CHUNK_CONTINUITY_OVERLAP);
      overlapFromPrevious = 0;
    }

    const maximumEnd = Math.min(messages.length, startIndex + SHIYING_CHUNK_MESSAGE_LIMIT);
    let endIndex = maximumEnd;
    let estimatedTokens = -1;
    while (endIndex > startIndex) {
      if (hasYou(messages, startIndex, endIndex)) {
        const estimate = options.estimateTokens(messages.slice(startIndex, endIndex));
        if (!isSafeTokenCount(estimate)) throw new Error('shiying_segmentation_token_estimate');
        if (estimate <= options.tokenLimit) {
          estimatedTokens = estimate;
          break;
        }
      }
      endIndex -= 1;
    }

    if (estimatedTokens < 0) {
      const blockedMessageIndex = upcomingYou;
      const singleEstimate = options.estimateTokens([messages[blockedMessageIndex]]);
      if (!isSafeTokenCount(singleEstimate)) throw new Error('shiying_segmentation_token_estimate');
      return {
        kind: 'blocked',
        chunks: renumber(messages, slices),
        blockedMessageIndex,
        estimatedTokens: singleEstimate,
      };
    }

    slices.push({
      startIndex,
      endIndex,
      overlapFromPrevious,
      estimatedTokens,
    });
    if (endIndex >= messages.length) break;

    const overlap = isClearBoundary(messages, endIndex)
      ? 0
      : Math.min(
          SHIYING_CHUNK_CONTINUITY_OVERLAP,
          Math.max(0, endIndex - startIndex - 1),
        );
    startIndex = endIndex - overlap;
    overlapFromPrevious = overlap;
  }

  return { kind: 'ready', chunks: renumber(messages, slices) };
}

function improveClearBoundaries(
  options: SegmentOptions,
  chunks: readonly ShiyingMaterialChunkV1[],
) {
  let slices: PlannedSlice[] = chunks.map(({ messages: _messages, chunkIndex: _index, ...slice }) => slice);
  for (let chunkIndex = 0; chunkIndex < slices.length - 1; chunkIndex += 1) {
    const current = slices[chunkIndex];
    const suffixCount = slices.length - chunkIndex;
    let best: PlannedSlice[] | null = null;
    let bestStrength = 0;
    let bestBoundary = -1;

    for (let endIndex = current.endIndex - 1; endIndex > current.startIndex; endIndex -= 1) {
      if (!isClearBoundary(options.messages, endIndex)) continue;
      if (!hasYou(options.messages, current.startIndex, endIndex)) continue;
      const currentMessages = options.messages.slice(current.startIndex, endIndex);
      const estimatedTokens = options.estimateTokens(currentMessages);
      if (!isSafeTokenCount(estimatedTokens)) throw new Error('shiying_segmentation_token_estimate');
      if (estimatedTokens > options.tokenLimit) continue;

      const remainder = buildGreedySlices(options, endIndex, 0);
      if (remainder.kind !== 'ready') continue;
      const alternative: PlannedSlice[] = [
        {
          startIndex: current.startIndex,
          endIndex,
          overlapFromPrevious: current.overlapFromPrevious,
          estimatedTokens,
        },
        ...remainder.chunks.map(({ messages: _messages, chunkIndex: _index, ...slice }) => slice),
      ];
      if (alternative.length > suffixCount) continue;

      const strength = boundaryStrength(options.messages, endIndex);
      if (
        !best
        || alternative.length < best.length
        || (
          alternative.length === best.length
          && totalOverlap(alternative) < totalOverlap(best)
        )
        || (
          alternative.length === best.length
          && totalOverlap(alternative) === totalOverlap(best)
          && strength > bestStrength
        )
        || (
          alternative.length === best.length
          && totalOverlap(alternative) === totalOverlap(best)
          && strength === bestStrength
          && endIndex > bestBoundary
        )
      ) {
        best = alternative;
        bestStrength = strength;
        bestBoundary = endIndex;
      }
    }

    if (best) slices = [...slices.slice(0, chunkIndex), ...best];
  }
  return renumber(options.messages, slices);
}

export function planShiyingMaterialSegments(options: SegmentOptions): ShiyingSegmentationPlanV1 {
  if (!Number.isSafeInteger(options.tokenLimit) || options.tokenLimit < 1) {
    throw new Error('shiying_segmentation_token_limit');
  }
  const initial = buildGreedySlices(options);
  if (initial.kind !== 'ready' || initial.chunks.length < 2) return initial;
  return {
    kind: 'ready',
    chunks: improveClearBoundaries(options, initial.chunks),
  };
}
