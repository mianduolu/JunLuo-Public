import { buildCompiledSystemPrompt } from '../ai/builtInSystemPrompt';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
} from '../ai/promptContextProfile';
import { buildGlobalCognitionContext } from '../ai/globalCognition';
import { sendChatCompletionResult } from '../ai/openAiCompatibleProvider';
import { buildChatModelParameterPayload, buildToolProviderTransportParameters } from '../ai/modelParameters';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import type { ApiChatMessage } from '../ai/subjectiveMessages';
import type { AssistantState } from '../ai/assistantState';
import { listAssistantLifeDays, loadAssistantLifeDay } from '../ai/assistantLifeTimeline';
import { formatSleepLocalTime } from '../life/sleepPlanPolicy';
import { loadJunluoDesirePromptPaper } from '../life/junluoDesireRuntime';
import type { AiConnection, AiProfile } from '../ai/types';
import {
  buildJunluoFocusFactPaper,
  buildFocusTimerStatePaper,
  buildFocusActivityOpeningPaper,
  parseFocusNextActivityChoice,
  formatJunluoFocusProgress,
  JUNLUO_FOCUS_COMPANION_TASK_PROMPT,
  JUNLUO_FOCUS_INVITATION_TASK_PROMPT,
  JUNLUO_FOCUS_CURRENT_READING_INVITATION_PROMPT,
  JUNLUO_FOCUS_ACTIVITY_OPENING_PROMPT,
  type FocusNextActivityChoice,
} from './focusGenerationPolicy';
import { loadFocusReadingContext } from './focusReadingRuntime';
import type { FocusLogEntry, FocusMode } from './focusStore';
import { buildFocusCareRequestMessages } from './focusChatProtocol';
import type { FocusSleepLogKind } from './focusSleepPolicy';
import { classifyFocusGenerationFailure, focusEmptyReplyFailure, reportFocusGenerationFailure, type FocusGenerationFailure } from './focusGenerationFailure';
import type { FocusMemoryRequest, FocusMemoryReceipt } from './focusMemoryRuntime';

export {
  buildJunluoFocusFactPaper,
  formatJunluoFocusProgress,
  JUNLUO_FOCUS_COMPANION_TASK_PROMPT,
  JUNLUO_FOCUS_INVITATION_TASK_PROMPT,
  selectJunluoFocusDueMilestones,
} from './focusGenerationPolicy';

type AiOptions = {
  apiKey: string;
  connection?: AiConnection;
  profile: AiProfile;
  skipGlobalCognition?: boolean;
  shortRequestThinkingMode?: 'disabled';
  onFailure?: (failure: FocusGenerationFailure) => void;
  readTimerPaused?: () => boolean;
  memoryRequest?: FocusMemoryRequest;
  onMemoryPrepared?: (receipt: FocusMemoryReceipt) => void;
};

type FocusContext = {
  mode: FocusMode;
  userActivity: string;
  baiyunActivity: string;
  elapsedSeconds: number;
  logs: Pick<FocusLogEntry, 'content' | 'role'>[];
  openingActivity?: { remainingActivityMinutes: number; focusMinutes: number | null; elapsedWorkMinutes?: number };
  onNextActivity?: (choice: FocusNextActivityChoice) => Promise<void>;
};

type GenerateFocusReplyOptions = AiOptions & Omit<FocusContext, 'logs'> & {
  logs: Omit<FocusLogEntry, 'sessionId'>[];
  fixedResponseInstruction?: string;
  forceNudge?: boolean;
  userMessage: string;
  sleepReplySources?: Omit<FocusLogEntry, 'sessionId'>[];
  canStartRequest?: () => Promise<boolean>;
};

const FOCUS_REQUEST_TIMEOUT_MS = 20_000;
type FocusShortRequestTimeout = { stage: 'prepare' | 'transport' | 'body' | 'payload'; occurredAt: number };
let lastFocusShortRequestTimeout: FocusShortRequestTimeout | null = null;

// JS request phases only: React Native fetch may resolve after the complete response.
export function getLastFocusShortRequestTimeout(): Readonly<FocusShortRequestTimeout> | null {
  return lastFocusShortRequestTimeout ? { ...lastFocusShortRequestTimeout } : null;
}

function formatRecentFocusConversation(logs: FocusContext['logs']) {
  return logs
    .filter((log) => log.role === 'I' || log.role === 'you')
    .slice(-5)
    .map((log) => `${log.role}：${log.content}`)
    .join('\n');
}


function normalizeFocusText(content: string, singleLine = false) {
  return content
    .trim()
    .replace(/^["“]|["”]$/g, '')
    .replace(/^I\s*[:：]\s*/i, '')
    .replace(/(^|[\s，。！？、；：])I(?=[:：\s，。！？、；]|[\u4e00-\u9fff])/g, '$1我')
    .replace(/\r\n?/g, '\n')
    .replace(singleLine ? /\s+/g : /[^\S\r\n]+/g, ' ')
    .trim();
}

function normalizeFocusOpeningText(content: string) {
  // Leave you in quoted/code material alone; only repair the observed address in plain opening prose.
  const text = /["'“”‘’「」『』`]|~{3}/u.test(content) ? content
    : content.replace(/(^|[\u4e00-\u9fff，。！？、；：])[ \t]*you[ \t]+那边/gu, '$1你那边');
  return normalizeFocusText(text);
}

function stripJsonFence(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
  return (fenced?.[1] ?? trimmed).trim();
}

function parseFocusMessageEnvelope(content: string, onFailure?: AiOptions['onFailure'], normalize = normalizeFocusText) {
  if (!content.trim()) return '';
  const invalid = () => { reportFocusGenerationFailure(onFailure, { code: 'visible_envelope_invalid' }); return ''; };
  try {
    const parsed = JSON.parse(stripJsonFence(content)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid();
    const keys = Object.keys(parsed);
    if (keys.length !== 1 || keys[0] !== 'message') return invalid();
    const message = (parsed as { message?: unknown }).message;
    if (typeof message !== 'string') return invalid();
    const text = normalize(message);
    if (!text) reportFocusGenerationFailure(onFailure, { code: 'model_visible_text_missing' });
    return text;
  } catch {
    return invalid();
  }
}

async function requestRawText({ apiKey, connection, skipGlobalCognition, shortRequestThinkingMode, onFailure, memoryRequest }: AiOptions, messages: ApiChatMessage[],
  readTimerPaused?: () => boolean, memory?: Awaited<ReturnType<typeof import('./focusMemoryRuntime')['prepareFocusMemory']>>,
  onMemoryPrepared?: AiOptions['onMemoryPrepared']) {
  lastFocusShortRequestTimeout = null;
  if (!connection || !apiKey.trim()) { reportFocusGenerationFailure(onFailure, { code: 'focus_configuration_missing' }); return ''; }
  if (memoryRequest && (!memoryRequest.canCommit() || memoryRequest.signal?.aborted)) return '';
  let timedOut = false;
  let stage: FocusShortRequestTimeout['stage'] = 'prepare';
  try {
    const latestUserMessage = [...messages].reverse().find((message) => message.role === 'user');
    const cognition = skipGlobalCognition
      ? null
      : await buildGlobalCognitionContext(latestUserMessage?.content ?? '', 'focus');
    const sharedContext = cognition
      ? [
        cognition.runtimeContext,
        cognition.memoryContext ? `【可以参考的已确认记忆】\n${cognition.memoryContext}` : '',
      ].filter(Boolean).join('\n\n')
      : '';
    const requestMessages = sharedContext
      ? messages.map((message, index) =>
          index === 0 && message.role === 'system'
            ? { ...message, content: `${message.content}\n\n${sharedContext}` }
            : message,
        )
      : messages;
    const memoryText = await memory?.refresh().catch(() => '');
    if (memoryRequest && (!memoryRequest.canCommit() || memoryRequest.signal?.aborted)) return '';
    if (memory && !memory.receipt.canCommit()) return '';
    if (memoryText) requestMessages.splice(-1, 0, { role: 'system', content: memoryText });
    if (readTimerPaused) requestMessages.splice(-1, 0, { role: 'system', content: buildFocusTimerStatePaper(readTimerPaused()) });
    const controller = new AbortController();
    const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, FOCUS_REQUEST_TIMEOUT_MS);
    let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
    try {
      stage = 'transport';
      const body = JSON.stringify({
        model: connection.model.trim(), messages: requestMessages,
        ...buildChatModelParameterPayload(connection.modelParameters),
        ...(shortRequestThinkingMode === undefined ? {} : buildToolProviderTransportParameters(connection, shortRequestThinkingMode)),
      });
      cacheMetric = beginPromptCacheMetric({ connection, contextProfile: 'light-companion', contextSource: 'focus.short-text' });
      if (memoryRequest && (!memoryRequest.canCommit() || memoryRequest.signal?.aborted)) return '';
      if (memory) {
        if (!memory.receipt.canCommit()) return '';
        try { onMemoryPrepared?.(memory.markSent()); } catch { /* Host observation cannot change the request. */ }
      }
      const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
        body,
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) {
        reportFocusGenerationFailure(onFailure, classifyFocusGenerationFailure({ name: 'AiRequestError',
          kind: response.status === 401 || response.status === 403 ? 'authentication' : 'provider_http',
          httpStatus: response.status }, FOCUS_REQUEST_TIMEOUT_MS));
        return '';
      }
      stage = 'body';
      if (controller.signal.aborted) throw new Error('Focus request aborted');
      let stopBodyRead!: () => void;
      const bodyAborted = new Promise<never>((_, reject) => {
        stopBodyRead = () => reject(new Error('Focus request aborted'));
        controller.signal.addEventListener('abort', stopBodyRead, { once: true });
      });
      let payload: unknown;
      try {
        // RN can detach fetch's abort listener before its Blob/JSON read has finished.
        payload = await Promise.race([bodyAborted, Promise.resolve().then(() => response.json())]);
      } finally {
        controller.signal.removeEventListener('abort', stopBodyRead);
      }
      if (payload && typeof payload === 'object') cacheMetric.recordUsage((payload as { usage?: unknown }).usage);
      stage = 'payload';
      const invalidPayload = () => {
        reportFocusGenerationFailure(onFailure, { code: 'provider_payload_invalid' });
        return '';
      };
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalidPayload();
      const choices = (payload as { choices?: unknown }).choices;
      if (!Array.isArray(choices)) return invalidPayload();
      if (!choices.length) {
        reportFocusGenerationFailure(onFailure, { code: 'model_visible_text_missing' });
        return '';
      }
      const first: unknown = choices[0];
      if (!first || typeof first !== 'object' || Array.isArray(first)) return invalidPayload();
      const message = (first as { message?: unknown }).message;
      if (!message || typeof message !== 'object' || Array.isArray(message)
        || !Object.hasOwn(message, 'content')) return invalidPayload();
      const content = (message as { content: unknown }).content;
      if (content !== null && typeof content !== 'string' && !Array.isArray(content)) return invalidPayload();
      if (Array.isArray(content) && content.some(part => !part || typeof part !== 'object'
        || Array.isArray(part) || typeof part.text !== 'string')) return invalidPayload();
      const text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.map((part: { text: string }) => part.text).join('') : '';
      if (text.trim()) return text;
      reportFocusGenerationFailure(onFailure, { code: 'model_visible_text_missing' });
      return '';
    } finally {
      void cacheMetric?.finish();
      clearTimeout(timeoutId);
    }
  } catch (error) {
    if (timedOut) lastFocusShortRequestTimeout = { stage, occurredAt: Date.now() };
    reportFocusGenerationFailure(onFailure, classifyFocusGenerationFailure(timedOut
      ? { name: 'AiRequestError', kind: 'timeout', stopCause: 'timeout' }
      : stage === 'body' || stage === 'payload'
        ? { name: 'AiRequestError', kind: 'empty_response', bodyParseFailure: stage === 'payload' ? 'invalid_payload'
          : error instanceof SyntaxError ? 'invalid_json' : 'body_read_failed' }
        : stage === 'transport' ? { name: 'AiRequestError', kind: 'network' } : error, FOCUS_REQUEST_TIMEOUT_MS));
    return '';
  }
}

async function buildFocusSystem(profile: AiProfile, moduleInstruction: string) {
  const contextSource = 'focus.companion' as const;
  return buildCompiledSystemPrompt({
    contextProfile: getPromptContextProfileForSource(contextSource),
    moduleInstruction,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
  });
}

export async function generateFocusOpening(options: AiOptions & FocusContext) {
  const memory = options.memoryRequest && options.connection && options.apiKey.trim()
    ? await (await import('./focusMemoryRuntime')).prepareFocusMemory({ request: options.memoryRequest,
      userActivity: options.userActivity, logs: options.logs }) : null;
  const reading = await loadFocusReadingContext().catch(() => null);
  const openingPaper = options.openingActivity ? buildFocusActivityOpeningPaper({
    ...options.openingActivity, userActivity: options.userActivity, currentActivity: options.baiyunActivity,
  }) : '';
  const task = openingPaper ? JUNLUO_FOCUS_ACTIVITY_OPENING_PROMPT : JUNLUO_FOCUS_COMPANION_TASK_PROMPT;
  const content = await requestRawText({ ...options, skipGlobalCognition: true }, [
    {
      role: 'system',
      content: await buildFocusSystem(options.profile, ''),
    },
    {
      role: 'system',
      content: openingPaper || buildJunluoFocusFactPaper({
        baiyunActivity: options.baiyunActivity,
        focusMode: options.mode === 'cowork' ? 'I 和 you 各忙各的' : 'I 和 you 正一起专注',
        focusProgress: '刚刚开始',
        recentConversation: formatRecentFocusConversation(options.logs),
        userActivity: options.userActivity,
      }),
    },
    ...(reading?.backgroundPaper ? [{ role: 'system' as const, content: reading.backgroundPaper }] : []),
    ...(openingPaper && reading?.catalogPaper ? [{ role: 'system' as const, content: reading.catalogPaper }] : []),
    { role: 'system', content: task },
  ], options.readTimerPaused, memory, options.onMemoryPrepared);
  if (openingPaper) {
    if (!content.trim()) return '';
    try {
      const parsed = JSON.parse(stripJsonFence(content)) as Record<string, unknown>;
      const message = typeof parsed?.message === 'string' ? normalizeFocusOpeningText(parsed.message) : '';
      if (!message) { reportFocusGenerationFailure(options.onFailure, { code: typeof parsed?.message === 'string'
        ? 'model_visible_text_missing' : 'visible_envelope_invalid' }); return ''; }
      const choice = parseFocusNextActivityChoice(parsed, reading?.books ?? []);
      if (choice) await options.onNextActivity?.(choice).catch(() => undefined);
      return message;
    } catch { reportFocusGenerationFailure(options.onFailure, { code: 'visible_envelope_invalid' }); return ''; }
  }
  return parseFocusMessageEnvelope(content, options.onFailure, normalizeFocusOpeningText);
}

export async function generateFocusLog(options: AiOptions & FocusContext) {
  const reading = await loadFocusReadingContext().catch(() => null);
  const content = await requestRawText({ ...options, skipGlobalCognition: true }, [
    {
      role: 'system',
      content: await buildFocusSystem(options.profile, ''),
    },
    {
      role: 'system',
      content: buildJunluoFocusFactPaper({
        baiyunActivity: options.baiyunActivity,
        focusMode: options.mode === 'cowork' ? 'I 和 you 各忙各的' : 'I 和 you 正一起专注',
        focusProgress: formatJunluoFocusProgress(options.elapsedSeconds),
        recentConversation: formatRecentFocusConversation(options.logs),
        userActivity: options.userActivity,
      }),
    },
    ...(reading?.backgroundPaper ? [{ role: 'system' as const, content: reading.backgroundPaper }] : []),
    { role: 'system', content: JUNLUO_FOCUS_COMPANION_TASK_PROMPT },
  ], options.readTimerPaused);
  return parseFocusMessageEnvelope(content, options.onFailure);
}

export async function generateFocusSleepLog(options: AiOptions & { kind: FocusSleepLogKind; userActivity: string }) {
  const { buildFocusSleepStatePaper, JUNLUO_FOCUS_SLEEP_TASK_PROMPTS } = await import('./focusSleepPolicy');
  const content = await requestRawText({ ...options, skipGlobalCognition: true }, [
    { role: 'system', content: await buildFocusSystem(options.profile, '') },
    { role: 'system', content: buildFocusSleepStatePaper(options) },
    { role: 'system', content: JUNLUO_FOCUS_SLEEP_TASK_PROMPTS[options.kind] },
  ], options.readTimerPaused);
  return parseFocusMessageEnvelope(content, options.onFailure);
}

export async function generateFocusReply(options: GenerateFocusReplyOptions): Promise<{
  contents: string[]; rawEnvelope: string; cancelled?: boolean; failure?: FocusGenerationFailure; memoryUsage?: FocusMemoryReceipt;
}> {
  if (!options.connection || !options.apiKey.trim()) {
    return { contents: [], rawEnvelope: '', failure: { code: 'focus_configuration_missing' } };
  }
  const now = Date.now();
  const messages = buildFocusCareRequestMessages(options.logs);
  const memory = options.memoryRequest && !options.sleepReplySources?.length
    ? await (await import('./focusMemoryRuntime')).prepareFocusMemory({ request: options.memoryRequest,
      userActivity: options.userActivity, userMessage: options.userMessage, logs: options.logs }) : null;
  const desirePaper = await loadJunluoDesirePromptPaper(now).catch(() => '');
  const reading = await loadFocusReadingContext().catch(() => null);
  const sleepReplyInstruction = options.sleepReplySources?.length
    ? (await import('./focusSleepReplyPolicy')).buildFocusSleepReplyInstruction({
      logs: options.logs, sources: options.sleepReplySources, userActivity: options.userActivity,
    }) : '';
  if (options.canStartRequest && !await options.canStartRequest()) {
    return { contents: [] as string[], rawEnvelope: '', cancelled: true as const };
  }
  const responseInstruction = (memoryText: string) => [
    buildJunluoFocusFactPaper({ baiyunActivity: options.baiyunActivity,
      focusMode: options.mode === 'cowork' ? 'I 和 you 各忙各的' : 'I 和 you 正一起专注',
      focusProgress: formatJunluoFocusProgress(options.elapsedSeconds), userActivity: options.userActivity }),
    options.readTimerPaused ? buildFocusTimerStatePaper(options.readTimerPaused()) : '',
    reading?.backgroundPaper, memoryText, desirePaper, options.fixedResponseInstruction, sleepReplyInstruction,
  ].filter(Boolean).join('\n\n');
  const completion = await sendChatCompletionResult({
    apiKey: options.apiKey,
    connection: options.connection,
    contextSource: 'focus.companion',
    ...(options.shortRequestThinkingMode === undefined ? {} : { thinkingMode: options.shortRequestThinkingMode }),
    messages,
    profile: options.profile,
    responseEnvelopeMode: 'messages_with_semantic',
    responseInstruction: responseInstruction(''),
    ...(options.memoryRequest && !options.sleepReplySources?.length ? { refreshMemoryMaterials: async () => {
      if (!options.memoryRequest!.canCommit() || options.memoryRequest!.signal?.aborted
        || options.canStartRequest && !await options.canStartRequest()) {
        throw Object.assign(new Error('FOCUS_MEMORY_REQUEST_CANCELLED'), { name: 'AbortError' });
      }
      const text = await memory?.refresh().catch(() => '') ?? '';
      if (!options.memoryRequest!.canCommit() || memory && !memory.receipt.canCommit()) {
        throw Object.assign(new Error('FOCUS_MEMORY_REQUEST_CANCELLED'), { name: 'AbortError' });
      }
      return { responseInstruction: responseInstruction(text) };
    }, onTransportAttempt: () => { memory?.markSent(); } } : {}),
    semanticEnvelopeProtocol: 'single_root_json',
  });
  return {
    contents: completion.contents,
    rawEnvelope: completion.rawEnvelopeForSemanticParsing ?? '',
    ...(memory?.receipt.sent ? { memoryUsage: memory.receipt } : {}),
    ...(!completion.contents.length ? { failure: focusEmptyReplyFailure(completion.diagnostics) } : {}),
  };
}

type GenerateFocusInvitationOptions = AiOptions & {
  previousState?: Pick<AssistantState, 'activity' | 'title'>;
};

export async function generateFocusInvitation(options: GenerateFocusInvitationOptions) {
  // A failed activity read is not proof of idleness; do not propose a replacement.
  const reading = await loadFocusReadingContext().catch(() => null);
  if (!reading) return null;
  let previousPaper = '';
  const previousState = options.previousState;
  const now = Date.now();
  try {
    if (!reading.current && previousState?.activity.trim()) {
      // A refreshed display timestamp is not the time of the saved self-report.
      // Match the existing timeline, including the preceding day across midnight.
      for (const key of await listAssistantLifeDays(90)) {
        const day = await loadAssistantLifeDay(key);
        const previous = day?.timelineEntries.filter(entry =>
          entry.activity === previousState.activity
          && entry.title === previousState.title
          && Number.isFinite(entry.at) && entry.at > 0 && entry.at <= now,
        ).at(-1);
        if (!previous) continue;
        previousPaper = `【I 上次写的近况】\n\n记录时间：${formatSleepLocalTime(previous.at).replace('T', ' ')}\n${previous.activity}`;
        break;
      }
    }
  } catch {
    return null;
  }
  const content = await requestRawText({ ...options, skipGlobalCognition: true }, [
    {
      role: 'system',
      content: await buildFocusSystem(options.profile, ''),
    },
    ...(previousPaper ? [{ role: 'system' as const, content: previousPaper }] : []),
    ...(reading.currentPaper ? [{ role: 'system' as const, content: reading.currentPaper }] : []),
    ...(!reading.current && reading.catalogPaper ? [{ role: 'system' as const, content: reading.catalogPaper }] : []),
    {
      role: 'system',
      content: reading.current ? JUNLUO_FOCUS_CURRENT_READING_INVITATION_PROMPT : JUNLUO_FOCUS_INVITATION_TASK_PROMPT,
    },
  ]);
  try {
    const parsed = JSON.parse(stripJsonFence(content)) as Record<string, unknown> | null;
    if (!parsed || Array.isArray(parsed) || typeof parsed.message !== 'string') return null;
    const message = normalizeFocusText(parsed.message);
    if (reading.current) {
      if (Object.keys(parsed).length !== 1 || !message) return null;
      return { message, baiyunActivity: `读《${reading.current.title}》`, readingId: reading.current.bookId,
        readingActivityId: reading.current.activityId };
    }
    if (Object.keys(parsed).length !== 3 || typeof parsed.activity !== 'string') return null;
    const choice = parseFocusNextActivityChoice({ next: 'switch', nextActivity: parsed.activity, readingId: parsed.readingId }, reading.books);
    const baiyunActivity = choice?.nextActivity ? normalizeFocusText(choice.nextActivity, true) : '';
    return message && baiyunActivity ? { message, baiyunActivity, readingId: choice!.readingId, readingActivityId: undefined } : null;
  } catch {
    return null;
  }
}
