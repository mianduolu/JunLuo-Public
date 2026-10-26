import { estimateApiMessagesTokens } from '../chat/contextCompression';
import {
  buildChatModelParameterPayload,
  buildOpenAiCompatibilityPayload,
} from '../ai/modelParameters';
import {
  beginPromptCacheMetric,
  type PromptCacheUsageLike,
} from '../ai/promptCacheMetrics';
import { isOfficialDeepSeekV4Connection } from '../ai/toolProviderCapabilities';
import type { AiConnection, AiProfile } from '../ai/types';
import {
  SHIYING_CATEGORIES,
  type ShiyingCategory,
  type ShiyingEntryV1,
} from './shiyingContract';
import type { ShiyingChatMaterialV1 } from './shiyingChatSource';
import { buildShiyingExtractionApiMessages } from './shiyingPrompt';
import { parseShiyingModelJson } from './shiyingModelJson';

const SHIYING_EXTRACTION_TIMEOUT_MS = 60_000;
const SHIYING_EXTRACTION_MAX_TOKENS = 1_024;
const SHIYING_BODY_MAX_LENGTH = 2_000;

export type ShiyingModelSourceRefV1 = {
  sessionId: string;
  messageId: string;
};

export type ShiyingValidatedCandidateV1 = {
  category: ShiyingCategory;
  body: string;
  sourceMaterials: ShiyingChatMaterialV1[];
};

export type ShiyingBatchCandidateV1 = ShiyingValidatedCandidateV1 & {
  chunkIndex: number;
  modelOrder: number;
};

export type ShiyingProjectedModelResultV1 =
  | { kind: 'entries'; candidates: ShiyingValidatedCandidateV1[] }
  | { kind: 'zero'; candidates: [] }
  | { kind: 'invalid'; candidates: [] };

export class ShiyingExtractionRequestError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(`shiying_extraction_${code}`);
    this.name = 'ShiyingExtractionRequestError';
    this.code = code;
  }
}

function sourceIdentity(source: Pick<ShiyingModelSourceRefV1, 'sessionId' | 'messageId'>) {
  return JSON.stringify([source.sessionId, source.messageId]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function projectCandidate(
  value: unknown,
  materialsById: ReadonlyMap<string, ShiyingChatMaterialV1>,
  materialOrder: ReadonlyMap<string, number>,
): ShiyingValidatedCandidateV1 | null {
  if (!isPlainRecord(value)) return null;
  if (
    typeof value.category !== 'string'
    || !SHIYING_CATEGORIES.includes(value.category as ShiyingCategory)
  ) {
    return null;
  }
  if (typeof value.body !== 'string') return null;
  const body = value.body.trim();
  if (
    !body
    || body.length > SHIYING_BODY_MAX_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body)
  ) {
    return null;
  }
  if (!Array.isArray(value.sourceRefs) || value.sourceRefs.length < 1) return null;

  const seen = new Set<string>();
  const sourceMaterials: ShiyingChatMaterialV1[] = [];
  for (const rawRef of value.sourceRefs) {
    if (
      !isPlainRecord(rawRef)
      || typeof rawRef.sessionId !== 'string'
      || typeof rawRef.messageId !== 'string'
      || !rawRef.sessionId
      || !rawRef.messageId
    ) {
      return null;
    }
    const identity = sourceIdentity(rawRef as ShiyingModelSourceRefV1);
    const material = materialsById.get(identity);
    if (!material) return null;
    if (!seen.has(identity)) {
      seen.add(identity);
      sourceMaterials.push(material);
    }
  }
  if (!sourceMaterials.some((source) => source.role === 'you')) return null;
  sourceMaterials.sort((left, right) => (
    (materialOrder.get(sourceIdentity(left)) ?? 0)
    - (materialOrder.get(sourceIdentity(right)) ?? 0)
  ));
  return {
    category: value.category as ShiyingCategory,
    body,
    sourceMaterials,
  };
}

function primaryYouIdentities(candidate: ShiyingValidatedCandidateV1) {
  return new Set(
    candidate.sourceMaterials
      .filter((source) => source.role === 'you')
      .map(sourceIdentity),
  );
}

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function candidateStart(candidate: ShiyingValidatedCandidateV1) {
  return Math.min(...candidate.sourceMaterials.map((source) => source.messageCreatedAt));
}

function candidateEnd(candidate: ShiyingValidatedCandidateV1) {
  return Math.max(...candidate.sourceMaterials.map((source) => source.messageCreatedAt));
}

function rangesGapMs(left: ShiyingValidatedCandidateV1, right: ShiyingValidatedCandidateV1) {
  return Math.max(0, Math.max(candidateStart(left), candidateStart(right)) - Math.min(
    candidateEnd(left),
    candidateEnd(right),
  ));
}

function collapseRepeatedCharacters(value: string) {
  const output: string[] = [];
  let previous = '';
  let repetitions = 0;
  for (const character of Array.from(value)) {
    if (character === previous) {
      repetitions += 1;
      if (repetitions >= 2) continue;
    } else {
      previous = character;
      repetitions = 0;
    }
    output.push(character);
  }
  return output.join('');
}

function normalizeSimilarityText(value: string) {
  return collapseRepeatedCharacters(
    value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\s]+/gu, ''),
  );
}

function characterBigrams(value: string) {
  const characters = Array.from(normalizeSimilarityText(value));
  if (characters.length < 2) return characters.length ? [characters[0]] : [];
  return characters.slice(0, -1).map((character, index) => `${character}${characters[index + 1]}`);
}

function diceSimilarity(left: string, right: string) {
  const leftBigrams = characterBigrams(left);
  const rightBigrams = characterBigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) return leftBigrams.length === rightBigrams.length ? 1 : 0;
  const counts = new Map<string, number>();
  leftBigrams.forEach((bigram) => counts.set(bigram, (counts.get(bigram) ?? 0) + 1));
  let intersection = 0;
  rightBigrams.forEach((bigram) => {
    const count = counts.get(bigram) ?? 0;
    if (count > 0) {
      intersection += 1;
      counts.set(bigram, count - 1);
    }
  });
  return (2 * intersection) / (leftBigrams.length + rightBigrams.length);
}

function primaryEvidenceText(candidate: ShiyingValidatedCandidateV1) {
  return candidate.sourceMaterials
    .filter((source) => source.role === 'you')
    .map((source) => source.text)
    .join('\n');
}

function sharesPrimaryYou(
  left: ShiyingValidatedCandidateV1,
  right: ShiyingValidatedCandidateV1,
) {
  const leftYou = primaryYouIdentities(left);
  return right.sourceMaterials.some(
    (source) => source.role === 'you' && leftYou.has(sourceIdentity(source)),
  );
}

function candidateNearAnother(
  left: ShiyingValidatedCandidateV1,
  right: ShiyingValidatedCandidateV1,
  materialOrder: ReadonlyMap<string, number>,
) {
  if (left.category !== right.category) return false;
  const textSimilar = diceSimilarity(left.body, right.body) >= 0.76
    || diceSimilarity(primaryEvidenceText(left), primaryEvidenceText(right)) >= 0.84;
  if (!textSimilar) return false;
  const timeNear = rangesGapMs(left, right) <= 20 * 60 * 1_000;
  const leftYou = left.sourceMaterials.filter((source) => source.role === 'you');
  const rightYou = right.sourceMaterials.filter((source) => source.role === 'you');
  const positionNear = leftYou.some((leftSource) => rightYou.some((rightSource) => (
    leftSource.sessionId === rightSource.sessionId
    && Math.abs(
      (materialOrder.get(sourceIdentity(leftSource)) ?? Number.MAX_SAFE_INTEGER)
      - (materialOrder.get(sourceIdentity(rightSource)) ?? 0)
    ) <= 4
  )));
  return timeNear || positionNear;
}

function entryAsCandidate(entry: ShiyingEntryV1): ShiyingValidatedCandidateV1 {
  return {
    category: entry.category,
    body: entry.body,
    sourceMaterials: entry.sources.map((source) => ({
      sessionId: source.sessionId,
      messageId: source.messageId,
      role: source.role,
      messageCreatedAt: source.messageCreatedAt,
      text: source.excerptSnapshot,
      textKind: 'message_text',
      textTruncated: false,
      contentHash: source.contentHash,
    })),
  };
}

function candidateMatchesExisting(
  candidate: ShiyingValidatedCandidateV1,
  existingEntries: readonly ShiyingEntryV1[],
  materialOrder: ReadonlyMap<string, number>,
) {
  return existingEntries.some((entry) => {
    const historical = entryAsCandidate(entry);
    return sharesPrimaryYou(candidate, historical)
      || (
        entry.category === candidate.category
        && rangesGapMs(candidate, historical) <= 20 * 60 * 1_000
        && candidateNearAnother(candidate, historical, materialOrder)
      );
  });
}

function evidenceRank(candidate: ShiyingBatchCandidateV1) {
  return [
    candidate.sourceMaterials.filter((source) => source.role === 'you').length,
    candidate.sourceMaterials.length,
  ] as const;
}

function compareStableCandidateOrder(left: ShiyingBatchCandidateV1, right: ShiyingBatchCandidateV1) {
  const leftSource = left.sourceMaterials[0];
  const rightSource = right.sourceMaterials[0];
  return candidateStart(left) - candidateStart(right)
    || left.chunkIndex - right.chunkIndex
    || left.modelOrder - right.modelOrder
    || compareStrings(sourceIdentity(leftSource), sourceIdentity(rightSource));
}

function mergeCandidateSources(
  winner: ShiyingBatchCandidateV1,
  other: ShiyingBatchCandidateV1,
) {
  const byIdentity = new Map<string, ShiyingChatMaterialV1>();
  [...winner.sourceMaterials, ...other.sourceMaterials].forEach((source) => {
    byIdentity.set(sourceIdentity(source), source);
  });
  return {
    ...winner,
    sourceMaterials: [...byIdentity.values()].sort((left, right) => (
      left.messageCreatedAt - right.messageCreatedAt
      || compareStrings(left.sessionId, right.sessionId)
      || compareStrings(left.messageId, right.messageId)
    )),
  };
}

function preferredCandidate(
  left: ShiyingBatchCandidateV1,
  right: ShiyingBatchCandidateV1,
) {
  const leftRank = evidenceRank(left);
  const rightRank = evidenceRank(right);
  if (leftRank[0] !== rightRank[0]) return leftRank[0] > rightRank[0] ? left : right;
  if (leftRank[1] !== rightRank[1]) return leftRank[1] > rightRank[1] ? left : right;
  return compareStableCandidateOrder(left, right) <= 0 ? left : right;
}

export function finalizeShiyingBatchCandidates(input: {
  candidates: readonly ShiyingBatchCandidateV1[];
  existingEntries?: readonly ShiyingEntryV1[];
  materials: readonly ShiyingChatMaterialV1[];
}) {
  const materialOrder = new Map<string, number>();
  [...input.materials]
    .sort((left, right) => (
      left.messageCreatedAt - right.messageCreatedAt
      || compareStrings(left.sessionId, right.sessionId)
      || compareStrings(left.messageId, right.messageId)
    ))
    .forEach((material, index) => materialOrder.set(sourceIdentity(material), index));
  const eligible = [...input.candidates]
    .filter((candidate) => !candidateMatchesExisting(
      candidate,
      input.existingEntries ?? [],
      materialOrder,
    ))
    .sort(compareStableCandidateOrder);
  const deduplicated: ShiyingBatchCandidateV1[] = [];
  for (const candidate of eligible) {
    let merged = candidate;
    let foundDuplicate = true;
    while (foundDuplicate) {
      foundDuplicate = false;
      for (let index = deduplicated.length - 1; index >= 0; index -= 1) {
        const current = deduplicated[index];
        if (
          !sharesPrimaryYou(current, merged)
          && !candidateNearAnother(current, merged, materialOrder)
        ) {
          continue;
        }
        const winner = preferredCandidate(current, merged);
        const other = winner === current ? merged : current;
        merged = mergeCandidateSources(winner, other);
        deduplicated.splice(index, 1);
        foundDuplicate = true;
      }
    }
    deduplicated.push(merged);
  }
  deduplicated.sort(compareStableCandidateOrder);

  const selected: ShiyingBatchCandidateV1[] = [];
  const selectedCategories = new Set<ShiyingCategory>();
  for (const candidate of deduplicated) {
    if (selectedCategories.has(candidate.category)) continue;
    selected.push(candidate);
    selectedCategories.add(candidate.category);
    if (selected.length === 3) return selected;
  }
  for (const candidate of deduplicated) {
    if (selected.includes(candidate)) continue;
    selected.push(candidate);
    if (selected.length === 3) break;
  }
  return selected;
}

export function projectShiyingModelChunkResult(input: {
  rawText: string;
  materials: readonly ShiyingChatMaterialV1[];
}): ShiyingProjectedModelResultV1 {
  let parsed: unknown;
  try {
    parsed = parseShiyingModelJson(input.rawText);
  } catch {
    return { kind: 'invalid', candidates: [] };
  }
  if (!isPlainRecord(parsed) || !Array.isArray(parsed.entries)) {
    return { kind: 'invalid', candidates: [] };
  }
  if (parsed.entries.length === 0) return { kind: 'zero', candidates: [] };

  const materialsById = new Map<string, ShiyingChatMaterialV1>();
  const materialOrder = new Map<string, number>();
  input.materials.forEach((material, index) => {
    const identity = sourceIdentity(material);
    materialsById.set(identity, material);
    materialOrder.set(identity, index);
  });
  const candidates = parsed.entries
    .map((entry) => projectCandidate(entry, materialsById, materialOrder))
    .filter((candidate): candidate is ShiyingValidatedCandidateV1 => !!candidate);
  if (!candidates.length) return { kind: 'invalid', candidates: [] };

  return candidates.length
    ? { kind: 'entries', candidates: candidates.slice(0, 3) }
    : { kind: 'zero', candidates: [] };
}

export function projectShiyingModelResult(input: {
  rawText: string;
  materials: readonly ShiyingChatMaterialV1[];
  existingEntries?: readonly ShiyingEntryV1[];
}): ShiyingProjectedModelResultV1 {
  const projected = projectShiyingModelChunkResult(input);
  if (projected.kind !== 'entries') return projected;
  const selected = finalizeShiyingBatchCandidates({
    candidates: projected.candidates.map((candidate, modelOrder) => ({
      ...candidate,
      chunkIndex: 0,
      modelOrder,
    })),
    existingEntries: input.existingEntries,
    materials: input.materials,
  });
  return selected.length ? {
    kind: 'entries',
    candidates: selected.map(({ chunkIndex: _chunkIndex, modelOrder: _modelOrder, ...candidate }) => (
      candidate
    )),
  } : { kind: 'zero', candidates: [] };
}

export function estimateShiyingExtractionPromptTokens(input: {
  profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>;
  messages: readonly ShiyingChatMaterialV1[];
}) {
  return estimateApiMessagesTokens(buildShiyingExtractionApiMessages(input).apiMessages);
}

type ShiyingCompletionPayload = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | Array<{ text?: string }> | null;
      reasoning_content?: string | null;
    };
  }>;
  usage?: PromptCacheUsageLike & { completion_tokens?: number };
};

function readCompletionText(payload: ShiyingCompletionPayload) {
  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('');
  return '';
}

export async function requestShiyingExtraction(input: {
  apiKey: string;
  connection: AiConnection;
  profile: Pick<AiProfile, 'systemPrompt' | 'corePersona'>;
  messages: readonly ShiyingChatMaterialV1[];
}) {
  const { apiMessages, stablePrompt } = buildShiyingExtractionApiMessages(input);
  const modelParameters = buildChatModelParameterPayload(input.connection.modelParameters);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHIYING_EXTRACTION_TIMEOUT_MS);
  let response: Response;
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    try {
      const body = JSON.stringify({
        model: input.connection.model.trim(), messages: apiMessages,
        ...buildOpenAiCompatibilityPayload(input.connection), ...modelParameters,
        temperature: Math.min(modelParameters.temperature ?? 0.3, 0.3),
        max_tokens: Math.min(modelParameters.max_tokens ?? SHIYING_EXTRACTION_MAX_TOKENS, SHIYING_EXTRACTION_MAX_TOKENS),
        ...(isOfficialDeepSeekV4Connection(input.connection) ? { thinking: { type: 'disabled' as const } } : {}),
        ...(input.connection.chatJsonOutputEnabled === true ? { response_format: { type: 'json_object' as const } } : {}),
        stream: false,
      });
      cacheMetric = beginPromptCacheMetric({ connection: input.connection, contextProfile: 'shiying',
        contextSource: 'shiying.extraction', stablePrefixText: stablePrompt });
      response = await fetch(
        `${input.connection.baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${input.apiKey.trim()}`,
            'Content-Type': 'application/json',
          },
          body,
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ShiyingExtractionRequestError('timeout');
      }
      throw new ShiyingExtractionRequestError('network');
    }
    if (!response.ok) {
      throw new ShiyingExtractionRequestError(
        response.status === 401 || response.status === 403
          ? 'auth'
          : response.status === 429
            ? 'rate_limited'
            : `http_${response.status}`,
      );
    }
    let payload: ShiyingCompletionPayload;
    try {
      payload = await response.json() as ShiyingCompletionPayload;
      cacheMetric.recordUsage(payload?.usage);
    } catch {
      throw new ShiyingExtractionRequestError('response_json');
    }
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason === 'length' || finishReason === 'max_tokens') {
      throw new ShiyingExtractionRequestError('output_truncated');
    }
    if (finishReason && finishReason !== 'stop' && finishReason !== 'end_turn') {
      throw new ShiyingExtractionRequestError('finish_failed');
    }
    const rawText = readCompletionText(payload);
    if (!rawText.trim()) throw new ShiyingExtractionRequestError('empty');

    return {
      rawText,
      usage: {
        completionTokens: payload.usage?.completion_tokens,
        promptTokens: payload.usage?.prompt_tokens,
      },
    };
  } finally {
    void cacheMetric?.finish();
    clearTimeout(timeout);
  }
}
