import type { AiConnection, AiProfile } from '../ai/types';
import { buildChatModelParameterPayload, chatModelParameterDefinitions } from '../ai/modelParameters';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { compilePersonaPrompt } from '../ai/persona/promptCompiler';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
} from '../ai/promptContextProfile';
import { SUBJECTIVE_IDENTITY_PROTOCOL } from '../ai/subjectiveMessages';
import {
  buildAnnotateText,
  loadReadingAnnotations,
  loadReadingChapter,
} from './readingStore';
import type { ReadingAnnotation, ReadingBook, ReadingChapter, ReadingSegmentMeta, ReadingSegmentSummary } from './readingTypes';
import { formatReadingPosition, formatReadingTime, readingSegmentSourceVersion } from './readingDailyPolicy';
import { requestIllustratedReading } from './readingIllustratedRequest';
import { estimateReadingTokens } from './readingContent';
import { buildProgrammeMetadata } from './readingProgrammePolicy';
import { readReadingResponseContent, tagReadingRequestFailure, tagReadingResponseFailure } from './readingRequestFailure';

type ChatCompletionResponse = {
  usage?: unknown;
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string }>;
    };
  }>;
  error?: {
    message?: string;
  };
};

export type ReadingAiRuntime = {
  apiKey: string;
  connection?: AiConnection;
  profile: AiProfile;
  visionConnection?: AiConnection;
  visionKey?: string;
};

export type ReadingTransport = { connection: AiConnection; connections: AiConnection[]; index: number };

/** Annotation capacity checks and the wire request must reserve the same output budget. */
export function readingAnnotationMaxTokens(connection?: AiConnection) {
  return buildChatModelParameterPayload(connection?.modelParameters).max_tokens
    ?? chatModelParameterDefinitions.maxTokens.defaultValue;
}

type AnnotationPayload = {
  annotations?: Array<{
    p?: unknown;
    text?: unknown;
  }>;
  summary?: unknown;
};

export type ParsedReadingAnnotationResponse = {
  annotations: Array<Pick<ReadingAnnotation, 'p' | 'text'>>;
  summary: string;
  warnings: string[];
};

function ensureConfigured(runtime: ReadingAiRuntime): asserts runtime is ReadingAiRuntime & { connection: AiConnection } {
  if (!runtime.connection?.baseUrl.trim() || !runtime.connection.model.trim() || !runtime.apiKey.trim()) {
    throw new Error('请先在“白云与连接”里配置模型连接。');
  }
}

function clampText(value: unknown, maxLength: number) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, maxLength);
}

function readableTextLength(value: string) {
  return value.replace(/【[^】]*】/g, '').replace(/\s+/g, '').length;
}

export async function requestPlainText(runtime: ReadingAiRuntime, messages: Array<{ role: 'system' | 'user'; content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> }>, maxTokens: number, beforeTransport?: () => Promise<void>) {
  ensureConfigured(runtime);
  const baseUrl = runtime.connection.baseUrl.trim().replace(/\/+$/, '');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  let stage: 'request-build' | 'transport' | 'response-json' | 'response-shape' | undefined;
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;

  try {
    await beforeTransport?.();
    stage = 'request-build';
    const body = JSON.stringify({
      model: runtime.connection.model.trim(),
      messages,
      ...buildChatModelParameterPayload(runtime.connection.modelParameters),
      max_tokens: maxTokens,
    });
    stage = 'transport';
    cacheMetric = beginPromptCacheMetric({ contextProfile: getPromptContextProfileForSource('reading.companion'),
      contextSource: 'reading.completion', connection: runtime.connection });
    const response = await fetch(`${baseUrl}/chat/completions`, {
      body,
      headers: {
        Authorization: `Bearer ${runtime.apiKey.trim()}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: controller.signal,
    });
    let payload: ChatCompletionResponse = {};
    stage = 'response-json';
    try {
      payload = (await response.json()) as ChatCompletionResponse;
      cacheMetric.recordUsage(payload?.usage);
    } catch (error) {
      // Compatible services sometimes return non-JSON error bodies.
      if (response.ok) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        throw tagReadingResponseFailure(new Error('阅读接口返回的数据不是可解析的 JSON，没有取得正文。'), 'response-json', null, response.status, maxTokens);
      }
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw tagReadingRequestFailure(new Error('API Key 无效或没有调用权限，请回到设置检查连接。'), `http-${response.status}`);
      }
      throw tagReadingRequestFailure(new Error(payload?.error?.message || `服务返回错误状态 ${response.status}。`), `http-${response.status}`);
    }
    stage = 'response-shape';
    return readReadingResponseContent(payload, response.status, maxTokens);
  } catch (error) {
    // Admission failures are local deferrals, not transport failures.
    if (!stage) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw tagReadingRequestFailure(new Error('连接超时，请检查网络或服务地址。'), 'timeout');
    }
    if (error instanceof Error && 'readingFailureCode' in error) throw error;
    throw tagReadingRequestFailure(error, stage);
  } finally {
    cacheMetric?.finish();
    clearTimeout(timeoutId);
  }
}

function extractJsonObject(raw: string) {
  const direct = raw.trim();
  const codeBlock = direct.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const braceStart = direct.indexOf('{');
  const braceEnd = direct.lastIndexOf('}');
  const braceText = braceStart >= 0 && braceEnd > braceStart ? direct.slice(braceStart, braceEnd + 1) : '';
  return [direct, codeBlock, braceText].filter((item): item is string => !!item);
}

export function parseReadingAnnotationResponse(
  raw: string,
  startP: number,
  endP: number,
): ParsedReadingAnnotationResponse {
  try { return parseReadingAnnotationPayload(raw, startP, endP); }
  catch (error) {
    if (error instanceof Error && 'readingFailureCode' in error) throw error;
    throw tagReadingRequestFailure(error, 'annotation-shape');
  }
}

function parseReadingAnnotationPayload(raw: string, startP: number, endP: number): ParsedReadingAnnotationResponse {
  let parsed: AnnotationPayload | null = null;
  const warnings: string[] = [];
  for (const candidate of extractJsonObject(raw)) {
    try {
      parsed = JSON.parse(candidate) as AnnotationPayload;
      break;
    } catch {
      // Try the next recovery strategy.
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    throw tagReadingRequestFailure(new Error('白云小姐这次没有按共读格式返回，可以重试这一段。'), 'annotation-json');
  }

  const annotations = Array.isArray(parsed.annotations)
    ? parsed.annotations.flatMap((item) => {
      const p = Number(item.p);
      const text = clampText(item.text, 260);
      if (!Number.isInteger(p) || p < startP || p > endP) {
        warnings.push('dropped-invalid-p');
        return [];
      }
      if (!text) {
        warnings.push('dropped-empty-annotation');
        return [];
      }
      return [{
        p,
        text,
      }];
    })
    : [];
  const summary = clampText(parsed.summary, 700);
  if (!annotations.length && summary) warnings.push('summary-only');
  if (!annotations.length && !summary) {
    throw tagReadingRequestFailure(new Error('白云小姐这次没有留下可保存的共读内容，可以重试这一段。'), 'annotation-empty');
  }

  return {
    annotations,
    summary,
    warnings: Array.from(new Set(warnings)),
  };
}

const READING_COMPANION_PROMPT = `【一起读到这里】

I 和 you 正一起读书。读到这里，I 也有自己的感受、疑问、联想和想说的话，想和 you 聊聊。`;

const READING_ANNOTATION_PROMPT = `【共读批注】

I 刚和 you 读完下面这段文字，想在其中几处留下批注，再和 you 聊聊读后的感受。

I 把它们写进这个 JSON：
{"annotations":[],"summary":"..."}

annotations 放段落旁的批注，选 3 到 8 处想说话的地方，每条写 20 到 90 字。
每条填写：
p：对应的原文段落编号。
text：I 想留在这里的话。

summary 写 I 读完这一段的感想，用第一人称写 100 到 260 字。

I 和 you 读到哪里，就聊到哪里；还没读到的情节，留到读到时再一起看。

写好后，I 只发送这个 JSON。`;

export function compileReadingVisiblePrompt(profile: AiProfile) {
  const contextSource = 'reading.companion' as const;
  return compilePersonaPrompt({
    contextProfile: getPromptContextProfileForSource(contextSource),
    moduleInstruction: SUBJECTIVE_IDENTITY_PROTOCOL,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
  });
}

export function buildReadingAnnotationPrompt(options: {
  book: ReadingBook;
  chapter: ReadingChapter;
  previousSummaries: string[];
  segment: ReadingSegmentMeta;
  profile: AiProfile;
}) {
  const { book, chapter, previousSummaries, segment } = options;
  const sourceText = buildAnnotateText(chapter.paragraphs, segment.startP, segment.endP);
  return [
    READING_COMPANION_PROMPT,
    READING_ANNOTATION_PROMPT,
    `【书】${book.title}`,
    `【作者】${book.author}`,
    `【章节】${chapter.title}`,
    previousSummaries.length ? `【I 读过前文后留下的感想】\n\n${previousSummaries.join('\n')}` : '',
    sourceText.trim() ? `【这次已经读到的原文】\n\n${sourceText}` : '',
  ].filter(Boolean).join('\n\n');
}

export async function requestReadingAnnotation(options: ReadingAiRuntime & {
  book: ReadingBook;
  chapter: ReadingChapter;
  segment: ReadingSegmentMeta;
  beforeTransport?: (transport?: ReadingTransport) => Promise<void>;
}) {
  if (options.chapter.contentBlocks && options.segment.contentRange) return requestIllustratedReading(options);
  const previous = await loadReadingAnnotations(options.book.id, options.chapter.index);
  const previousSummaries = previous.summaries
    .filter((summary) => !summary.sourceAnchor && summary.segmentIndex < options.segment.segmentIndex)
    .sort((left, right) => left.segmentIndex - right.segmentIndex)
    .map((summary) => summary.summary)
    .slice(-4);
  const readingPrompt = buildReadingAnnotationPrompt({
    book: options.book,
    chapter: options.chapter,
    previousSummaries,
    segment: options.segment,
    profile: options.profile,
  });
  const systemPrompt = await compileReadingVisiblePrompt(options.profile);
  const outputTokens = readingAnnotationMaxTokens(options.connection);
  if (estimateReadingTokens(systemPrompt + readingPrompt) + outputTokens > (options.connection?.contextWindowTokens ?? 65536)) {
    throw new Error('reading-request-capacity');
  }
  const raw = await requestPlainText(options, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: readingPrompt },
  ], outputTokens, options.beforeTransport);
  const parsed = parseReadingAnnotationResponse(raw, options.segment.startP, options.segment.endP);
  return parsed;
}

export const DAILY_READING_TASK = `【阅读批注】

I 读到了下面这段内容，想在其中几处留下批注，也记下读后的感受。

I 把它们写进这个 JSON：
{"annotations":[],"summary":"..."}

annotations 放段落旁的批注，选 3 到 8 处想说话的地方，每条写 20 到 90 字。
每条填写：
p：对应的原文段落编号。
text：I 想留在这里的话。

summary 写 I 读完这一段的感想，用第一人称写 100 到 260 字。

I 读到哪里，就写到哪里；还没读到的情节，留到读到时再看。

写好后，I 只发送这个 JSON。`;

export function buildDailyReadingMaterial(input: {
  book: ReadingBook; chapter: ReadingChapter; segment: ReadingSegmentMeta; summaries: ReadingSegmentSummary[];
  includeSource?: boolean;
}) {
  const { book, chapter, segment } = input;
  const prior = input.summaries.filter(item => {
    if (item.sourceAnchor) return false;
    const original = chapter.segmentsMeta.find(s => s.segmentIndex === item.segmentIndex);
    return item.bookId === book.id && item.chapterIndex === chapter.index && item.segmentIndex < segment.segmentIndex
      && original && item.sourceVersion === readingSegmentSourceVersion(chapter, original);
  }).sort((a, b) => a.segmentIndex - b.segmentIndex).slice(-4);
  return [
    book.programme ? buildProgrammeMetadata(book, segment, chapter.index) : [`【书】${book.title}`, book.author ? `【作者】${book.author}` : '', chapter.title ? `【章节】${chapter.title}` : '',
      `【本次阅读位置】${formatReadingPosition(chapter.index, segment.segmentIndex)}`].filter(Boolean).join('\n'),
    prior.length ? `【I 读过前文后留下的感想】\n${prior.map(s => `${formatReadingPosition(s.chapterIndex, s.segmentIndex)}｜${formatReadingTime(s.createdAt)}\n${s.summary}`).join('\n\n')}` : '',
    input.includeSource === false ? '' : `【这次读到的原文】\n${buildAnnotateText(chapter.paragraphs, segment.startP, segment.endP)}`,
  ].filter(Boolean).join('\n\n');
}

export async function requestDailyReadingAnnotation(options: ReadingAiRuntime & {
  book: ReadingBook; chapter: ReadingChapter; segment: ReadingSegmentMeta; beforeTransport: (transport?: ReadingTransport) => Promise<void>;
}) {
  if (options.chapter.contentBlocks && options.segment.contentRange) return requestIllustratedReading(options);
  const previous = await loadReadingAnnotations(options.book.id, options.chapter.index);
  const persona = await compileReadingVisiblePrompt(options.profile);
  const material = buildDailyReadingMaterial({ ...options, summaries: previous.summaries });
  const outputTokens = readingAnnotationMaxTokens(options.connection);
  if (estimateReadingTokens(persona + material + DAILY_READING_TASK) + outputTokens > (options.connection?.contextWindowTokens ?? 65536)) {
    throw new Error('reading-request-capacity');
  }
  const raw = await requestPlainText(options, [
    { role: 'system', content: persona }, { role: 'system', content: material }, { role: 'system', content: DAILY_READING_TASK },
  ], outputTokens, options.beforeTransport);
  return parseReadingAnnotationResponse(raw, options.segment.startP, options.segment.endP);
}

export async function buildSpoilerSafeReadingContext(book: ReadingBook, chapterIndex: number, paragraphIndex: number) {
  const pieces: string[] = [];
  for (let index = 0; index <= chapterIndex; index += 1) {
    const chapter = await loadReadingChapter(book.id, index);
    if (!chapter) continue;
    if (index < chapterIndex) {
      const annotations = await loadReadingAnnotations(book.id, index);
      const summaries = annotations.summaries
        .filter(summary => !summary.sourceAnchor)
        .sort((left, right) => left.segmentIndex - right.segmentIndex)
        .map((summary) => summary.summary)
        .join('\n');
      if (summaries) pieces.push(`【I 读过前文后留下的感想】\n\n【章节】${chapter.title}\n${summaries}`);
      continue;
    }
    const safeParagraphIndex = Math.max(0, Math.min(paragraphIndex, chapter.paragraphs.length - 1));
    const text = chapter.paragraphs.slice(0, safeParagraphIndex + 1).join('\n\n');
    if (text.trim()) {
      pieces.push(`【这次已经读到的原文】\n\n${text.slice(-3000)}`);
    }
  }
  return pieces.join('\n\n').slice(-5000);
}

export function buildReadingSelectionPrompt(options: {
  book: ReadingBook;
  chapter: ReadingChapter;
  context: string;
  paragraphIndex: number;
  profile: AiProfile;
  question: string;
  selectedText: string;
}) {
  const selectedText = clampText(options.selectedText, 2200);
  const question = clampText(options.question, 420);
  const context = options.context.trim();
  return [
    READING_COMPANION_PROMPT,
    '',
    '【聊聊这一段】',
    '',
    'you 问起了书里的这一段，I 也想说说自己的看法。',
    '',
    'I 依着这段文字和已经读过的内容，说说自己的理解和感受。需要读到后面才能知道的事，就留到读到那里再聊。',
    '',
    '【这次读到的位置】',
    '',
    `第 ${options.chapter.index + 1} 章，段落 P${options.paragraphIndex}。`,
    '',
    `【书】${options.book.title}`,
    `【作者】${options.book.author}`,
    `【章节】${options.chapter.title}`,
    ...(selectedText ? [`【you 选中的原文】\n\n${selectedText}`] : []),
    ...(question ? [`【you 的问题】\n\n${question}`] : []),
    ...(context ? ['', '【已读上下文】', context] : []),
  ].join('\n');
}

export async function askBaiyunAboutReadingSelection(options: ReadingAiRuntime & {
  book: ReadingBook;
  chapter: ReadingChapter;
  paragraphIndex: number;
  question: string;
  selectedText: string;
}) {
  const context = await buildSpoilerSafeReadingContext(options.book, options.chapter.index, options.paragraphIndex);
  if (readableTextLength(options.selectedText) + readableTextLength(context) < 20) {
    throw new Error('先读一点再问白云。');
  }
  const prompt = buildReadingSelectionPrompt({
    book: options.book,
    chapter: options.chapter,
    context,
    paragraphIndex: options.paragraphIndex,
    profile: options.profile,
    question: options.question,
    selectedText: options.selectedText,
  });
  const systemPrompt = await compileReadingVisiblePrompt(options.profile);
  return requestPlainText(options, [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: prompt },
  ], 900);
}
