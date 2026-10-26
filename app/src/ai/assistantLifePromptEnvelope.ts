import { buildCompiledSystemPromptResult } from './builtInSystemPrompt';
import type { AssistantLifeGenerationFailureReason } from './assistantLifeGenerationShared';
import {
  beginPromptCacheMetric,
  extractPromptCacheUsageFromResponseUsage,
  fingerprintPromptText,
  recordPromptCacheMetricFromResponseUsage,
  type PromptCacheUsageLike,
} from './promptCacheMetrics';
import { recordPromptRuntimeSnapshot } from './promptDiagnostics';
import {
  SUBJECTIVE_IDENTITY_PROTOCOL,
  type ApiChatMessage,
} from './subjectiveMessages';
import type { AiConnection, AiProfile } from './types';
import type { OpenAiCompatibleRequestMessage } from './openAiCompatibleProvider';
import {
  getPromptContextProfileForSource,
  getPromptOutputAudienceForSource,
  type PromptContextSource,
} from './promptContextProfile';

export const ASSISTANT_LIFE_REQUEST_TIMEOUT_MS = 20_000;

export type AssistantLifePromptEnvelopeOptions = {
  contextSource: Extract<PromptContextSource, `assistant-life.${string}`>;
  dynamicSystemPrompt?: string;
  profile: AiProfile;
  taskPrompt: string;
};

export type AssistantLifePromptEnvelope = {
  apiMessages: ApiChatMessage[];
  contextProfile: 'assistant-life' | 'assistant-state';
  promptBreakdown: {
    dynamicSystemPrompt: string;
    stableSystemPrompt: string;
    taskPromptText: string;
  };
  stablePrefixFingerprint: string;
  stablePrefixText: string;
  stableSystemPrompt: string;
  taskPromptText: string;
};

export class AssistantLifeRequestError extends Error {
  readonly failureReason: Extract<AssistantLifeGenerationFailureReason, 'timeout' | 'rate-limited' | 'http-transient' | 'auth-or-config' | 'aborted'>;
  readonly httpStatus?: number;

  constructor(
    failureReason: AssistantLifeRequestError['failureReason'],
    message: string,
    httpStatus?: number,
  ) {
    super(message);
    this.name = 'AssistantLifeRequestError';
    this.failureReason = failureReason;
    this.httpStatus = httpStatus;
  }
}

type AssistantLifeCompletionUsage = PromptCacheUsageLike & {
  completion_tokens?: number;
};

export async function buildAssistantLifePromptEnvelope({
  contextSource,
  dynamicSystemPrompt,
  profile,
  taskPrompt,
}: AssistantLifePromptEnvelopeOptions): Promise<AssistantLifePromptEnvelope> {
  const compiledPrompt = await buildCompiledSystemPromptResult({
    contextProfile: getPromptContextProfileForSource(contextSource),
    moduleInstruction: taskPrompt,
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
    promptMode: 'identityOnly',
  });
  const stableSystemPrompt = compiledPrompt.stablePrompt;
  const taskPromptText = compiledPrompt.sections.scenario || taskPrompt.trim();
  const dynamicPrompt = [
    compiledPrompt.sections.personaState,
    compiledPrompt.sections.memory,
    compiledPrompt.sections.environment,
    compiledPrompt.sections.expression,
    dynamicSystemPrompt?.trim(),
  ].filter(Boolean).join('\n\n');
  const apiMessages: ApiChatMessage[] = [
    { role: 'system', content: stableSystemPrompt },
    { role: 'system', content: taskPromptText },
    ...(dynamicPrompt ? [{ role: 'system' as const, content: dynamicPrompt }] : []),
  ];
  return {
    apiMessages,
    contextProfile: getPromptContextProfileForSource(contextSource) as 'assistant-life' | 'assistant-state',
    promptBreakdown: {
      dynamicSystemPrompt: dynamicPrompt,
      stableSystemPrompt,
      taskPromptText,
    },
    stablePrefixFingerprint: fingerprintPromptText(stableSystemPrompt),
    stablePrefixText: stableSystemPrompt,
    stableSystemPrompt,
    taskPromptText,
  };
}

export async function buildAssistantStatePairEnvelope({
  contextSource,
  materialPrompt,
  profile,
}: {
  contextSource: 'assistant-life.afterglow' | 'assistant-life.state' | 'assistant-life.post' | 'assistant-life.post-reply';
  materialPrompt: string;
  profile: AiProfile;
}): Promise<AssistantLifePromptEnvelope> {
  const compiledPrompt = await buildCompiledSystemPromptResult({
    contextProfile: getPromptContextProfileForSource(contextSource),
    outputAudience: getPromptOutputAudienceForSource(contextSource),
    profile,
  });
  const sharedSystemPrompt = [
    SUBJECTIVE_IDENTITY_PROTOCOL,
    compiledPrompt.stablePrompt,
    compiledPrompt.sections.expression,
  ].filter(Boolean).join('\n\n');
  const material = materialPrompt.trim();
  const stablePrefixText = [SUBJECTIVE_IDENTITY_PROTOCOL, compiledPrompt.stablePrompt].filter(Boolean).join('\n\n');
  return {
    apiMessages: [
      { role: 'system', content: sharedSystemPrompt },
      { role: 'user', content: material },
    ],
    contextProfile: 'assistant-state',
    promptBreakdown: {
      dynamicSystemPrompt: compiledPrompt.sections.expression,
      stableSystemPrompt: compiledPrompt.stablePrompt,
      taskPromptText: material,
    },
    stablePrefixFingerprint: fingerprintPromptText(stablePrefixText),
    stablePrefixText,
    stableSystemPrompt: sharedSystemPrompt,
    taskPromptText: material,
  };
}

export function buildAssistantLifeApiMessages(envelope: AssistantLifePromptEnvelope, userPrompt: string): ApiChatMessage[] {
  return [
    ...envelope.apiMessages,
    { role: 'user', content: userPrompt },
  ];
}

export function recordAssistantLifePromptCacheMetric({
  apiMessages,
  connection,
  contextSource,
  payload,
  stablePrefixText,
}: {
  apiMessages: OpenAiCompatibleRequestMessage[];
  connection: AiConnection;
  contextSource: string;
  payload: unknown;
  stablePrefixText: string;
}) {
  void recordPromptCacheMetricFromResponseUsage({
    contextProfile: contextSource === 'assistant-life.state' || contextSource === 'assistant-life.afterglow'
      ? 'assistant-state'
      : 'assistant-life',
    contextSource,
    messages: apiMessages,
    model: connection.model.trim(),
    baseUrl: connection.baseUrl,
    stablePrefixText,
    usage: (payload as { usage?: PromptCacheUsageLike | null } | null | undefined)?.usage,
  }).catch(() => undefined);
}

function createAssistantLifeRequestSignal(externalSignal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abortFromExternalSignal = () => controller.abort();

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal);
  }

  return {
    signal: controller.signal,
    throwIfAborted: () => {
      // Native completion can race a delayed JS timer; the response still has the same deadline.
      if (Date.now() >= deadline) { timedOut = true; controller.abort(); }
      if (controller.signal.aborted) {
        const error = new Error('assistant-life-request-aborted');
        error.name = 'AbortError';
        throw error;
      }
    },
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener('abort', abortFromExternalSignal);
    },
    didTimeOut: () => timedOut,
  };
}

export async function fetchAssistantLifeCompletion({
  apiKey,
  connection,
  contextSource,
  metricContextSource,
  envelope,
  request = {},
  onRequestStart,
  onTransportAttempt,
  toolCapabilitySource,
  refreshMemoryMaterials,
  signal,
  timeoutMs = ASSISTANT_LIFE_REQUEST_TIMEOUT_MS,
  userPrompt,
  apiMessagesOverride,
}: {
  apiKey: string;
  connection: AiConnection;
  contextSource: string;
  metricContextSource?: string;
  envelope: AssistantLifePromptEnvelope;
  request?: Record<string, unknown>;
  onRequestStart?: (assertTransportReady?: () => void | Promise<void>) => Promise<void>;
  onTransportAttempt?: (transport: import('./assistantLifeGenerationShared').AssistantLifeTransportDiagnostic) => void;
  toolCapabilitySource?: import('./toolProviderCapabilities').ToolProviderCapabilitySource;
  refreshMemoryMaterials?: () => Promise<string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  userPrompt: string;
  apiMessagesOverride?: OpenAiCompatibleRequestMessage[];
}) {
  let apiMessages = apiMessagesOverride ?? buildAssistantLifeApiMessages(envelope, userPrompt);
  let requestSignal: ReturnType<typeof createAssistantLifeRequestSignal> | undefined;
  let metric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  const responseFormatRequested = connection.chatJsonOutputEnabled === true;
  let transport: import('./assistantLifeGenerationShared').AssistantLifeTransportDiagnostic | undefined;
  const assertTransportReady = () => {
    if (signal?.aborted) { const error = new Error('assistant-life-request-aborted'); error.name = 'AbortError'; throw error; }
  };
  const report = () => {
    if (!transport) return;
    try { void Promise.resolve(onTransportAttempt?.({ ...transport })).catch(() => undefined); } catch { /* Diagnostic only. */ }
  };
  const finish = (outcome: NonNullable<typeof transport>['outcome'], httpStatus?: number) => {
    if (!transport || transport.finishedAt !== undefined) return;
    transport = { ...transport, outcome, finishedAt: Date.now(), ...(httpStatus === undefined ? {} : { httpStatus }) };
    report();
  };
  try {
    let response: Response;
    try {
      const serialize = () => JSON.stringify({
        model: connection.model.trim(), messages: apiMessages, ...request,
        ...(responseFormatRequested ? { response_format: { type: 'json_object' as const } } : {}),
      });
      let body = serialize();
      let prepared = false;
      const prepareTransport = async () => {
        assertTransportReady();
        if (!prepared) {
          if (refreshMemoryMaterials) apiMessages = buildAssistantLifeApiMessages(envelope, await refreshMemoryMaterials());
          body = serialize();
          prepared = true;
        }
        assertTransportReady();
      };
      // Local preparation is not network time. Recheck cancellation before registering transport.
      assertTransportReady();
      await onRequestStart?.(prepareTransport);
      // Legacy callers do not use admission; still refresh after their preflight.
      if (!prepared) await prepareTransport();
      requestSignal = createAssistantLifeRequestSignal(signal, timeoutMs);
      // Admission is durable now. Preserve a last-moment cancellation on the
      // actual fetch instead of inventing an unsent refund after sync capture.
      const transmitted = JSON.parse(body) as { tools?: unknown[] };
      transport = { startedAt: Date.now(), outcome: 'started',
        offeredToolCount: Array.isArray(transmitted.tools) ? transmitted.tools.length : 0,
        ...(toolCapabilitySource ? { toolCapabilitySource } : {}) };
      report();
      metric = beginPromptCacheMetric({ connection, contextProfile: envelope.contextProfile,
        contextSource: metricContextSource ?? contextSource, stablePrefixText: envelope.stablePrefixText });
      response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
        body,
        headers: { Authorization: `Bearer ${apiKey.trim()}`, 'Content-Type': 'application/json' },
        method: 'POST',
        signal: requestSignal.signal,
      });
      requestSignal.throwIfAborted();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const reason = requestSignal?.didTimeOut() && !signal?.aborted ? 'timeout' : 'aborted';
        finish(reason);
        throw new AssistantLifeRequestError(reason, `${contextSource}-${reason}`);
      }
      finish('network-error');
      throw new AssistantLifeRequestError(
        'http-transient',
        error instanceof Error && error.message ? error.message : `${contextSource}-network-error`,
      );
    }
    if (!response.ok) {
      finish('http-error', response.status);
      const reason: AssistantLifeRequestError['failureReason'] = response.status === 429
        ? 'rate-limited'
        : response.status === 408 || response.status >= 500
          ? 'http-transient'
          : 'auth-or-config';
      throw new AssistantLifeRequestError(reason, `${contextSource}-http-${response.status}`, response.status);
    }
    let payload: {
      choices?: Array<{
        finish_reason?: string;
        message?: { content?: string; reasoning_content?: string };
      }>;
      usage?: AssistantLifeCompletionUsage | null;
    };
    try {
      payload = await response.json() as typeof payload;
      metric.recordUsage(payload?.usage);
      requestSignal.throwIfAborted();
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        const reason = requestSignal.didTimeOut() && !signal?.aborted ? 'timeout' : 'aborted';
        finish(reason, response.status);
        throw new AssistantLifeRequestError(reason, `${contextSource}-${reason}`, response.status);
      }
      finish('response', response.status);
      throw new AssistantLifeRequestError('http-transient', `${contextSource}-invalid-response-json`, response.status);
    }
    finish('response', response.status);
    try {
      recordPromptRuntimeSnapshot({ contextProfile: envelope.contextProfile, contextSource,
        messages: apiMessages, model: connection.model.trim() });
    } catch { /* Diagnostics cannot change the business result. */ }
    const choice = payload.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const reasoningContent = typeof choice?.message?.reasoning_content === 'string'
      ? choice.message.reasoning_content
      : '';
    const cacheUsage = extractPromptCacheUsageFromResponseUsage(payload.usage);
    return {
      apiMessages,
      content,
      finishReason: choice?.finish_reason,
      payload,
      reasoningContent,
      responseFormatRequested,
      usage: {
        cachedPromptTokens: cacheUsage.hitTokens ?? undefined,
        completionTokens: payload.usage?.completion_tokens,
        promptTokens: payload.usage?.prompt_tokens,
      },
    };
  } finally {
    void metric?.finish();
    requestSignal?.cleanup();
  }
}
