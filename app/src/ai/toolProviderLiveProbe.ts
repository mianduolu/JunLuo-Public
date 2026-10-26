import {
  buildCapabilityReportFromProbe,
  buildToolProviderConnectionFingerprint,
  isOfficialDeepSeekV4Connection,
  type ToolProviderCapabilityReport,
  type ToolProviderProbeEvidence,
} from './toolProviderCapabilities';
import type { AiConnection } from './types';

export const DEEPSEEK_V4_TOOL_PROBE_ENABLE = 'JUNLUO_DEEPSEEK_V4_TOOL_PROBE';
export const DEEPSEEK_V4_TOOL_PROBE_CONFIRM = 'JUNLUO_DEEPSEEK_V4_TOOL_PROBE_CONFIRM';
export const DEEPSEEK_V4_TOOL_PROBE_CONFIRM_VALUE = 'MAX_6_REQUESTS';

const MAX_LIVE_PROBE_REQUESTS = 6;
const REQUEST_TIMEOUT_MS = 60_000;
const PROBE_USER_MESSAGE = '查一下明天会不会下雨。';
const PROBE_ASSISTANT_PREFIX = '<state>\n{"semantic":{"signals":[{"kind":"';
const SIMULATED_TOOL_RESULT = '{"ok":true,"status":"success"}';
const PROBE_TOOL_NAME = 'weather__get_forecast';

type JsonObject = Record<string, unknown>;

type ProbeFetch = (
  input: string,
  init: {
    body: string;
    headers: Record<string, string>;
    method: 'POST';
    signal: AbortSignal;
  },
) => Promise<{
  json(): Promise<unknown>;
  ok: boolean;
  status: number;
}>;

type ProbeCheckStatus = 'passed' | 'failed' | 'skipped';

export interface DeepSeekV4ToolProbeCheck {
  finishReason?: string;
  httpStatus?: number;
  status: ProbeCheckStatus;
  toolCallCount: number;
}

export interface DeepSeekV4ToolProbeReport {
  version: 1;
  connectionFingerprint: string;
  endpointHost: 'api.deepseek.com';
  model: string;
  requestCount: number;
  evidence: ToolProviderProbeEvidence;
  checks: {
    thinkingToolCall: DeepSeekV4ToolProbeCheck;
    thinkingContinuation: DeepSeekV4ToolProbeCheck;
    strictBeta: DeepSeekV4ToolProbeCheck;
    prefixWithTools: DeepSeekV4ToolProbeCheck;
    nonThinkingToolChoice: DeepSeekV4ToolProbeCheck;
  };
  capabilityReport?: ToolProviderCapabilityReport;
}

export interface DeepSeekV4ToolProbeOptions {
  apiKey: string;
  connection: AiConnection;
  fetchImpl?: ProbeFetch;
  timeoutMs?: number;
}

export interface DeepSeekV4ToolProbeEnvironment {
  [key: string]: string | undefined;
  EXPO_PUBLIC_DEEPSEEK_BASE_URL?: string;
  EXPO_PUBLIC_DEEPSEEK_MODEL?: string;
  JUNLUO_DEEPSEEK_API_KEY?: string;
  JUNLUO_DEEPSEEK_V4_TOOL_PROBE?: string;
  JUNLUO_DEEPSEEK_V4_TOOL_PROBE_CONFIRM?: string;
}

function probeTool(strict: boolean) {
  return {
    type: 'function',
    function: {
      name: PROBE_TOOL_NAME,
      parameters: strict
        ? {
            type: 'object',
            required: ['days'],
            additionalProperties: false,
            properties: {
              days: {
                type: ['number', 'null'],
              },
            },
          }
        : {
            type: 'object',
            additionalProperties: false,
            properties: {
              days: {
                type: 'number',
              },
            },
          },
      ...(strict ? { strict: true } : {}),
    },
  };
}

function normalizeOfficialRoot(baseUrl: string) {
  const url = new URL(baseUrl.trim());
  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/u, '');
}

function completionUrl(connection: AiConnection, beta = false) {
  return `${normalizeOfficialRoot(connection.baseUrl)}${beta ? '/beta' : ''}/chat/completions`;
}

function asObject(value: unknown): JsonObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function readChoice(payload: unknown) {
  const root = asObject(payload);
  const choices = Array.isArray(root?.choices) ? root.choices : [];
  return asObject(choices[0]);
}

function readMessage(payload: unknown) {
  return asObject(readChoice(payload)?.message);
}

function readFinishReason(payload: unknown) {
  const value = readChoice(payload)?.finish_reason;
  return typeof value === 'string' ? value : undefined;
}

function readToolCalls(payload: unknown) {
  const calls = readMessage(payload)?.tool_calls;
  return Array.isArray(calls) ? calls.map(asObject).filter((item): item is JsonObject => Boolean(item)) : [];
}

function readToolCallId(call: JsonObject | undefined) {
  return typeof call?.id === 'string' && call.id.trim() ? call.id : undefined;
}

function isExpectedToolCall(call: JsonObject | undefined) {
  const fn = asObject(call?.function);
  if (fn?.name !== PROBE_TOOL_NAME || typeof fn.arguments !== 'string') return false;
  try {
    const input = JSON.parse(fn.arguments) as unknown;
    return Boolean(asObject(input));
  } catch {
    return false;
  }
}

function safeCheck(
  status: ProbeCheckStatus,
  response?: { payload?: unknown; status?: number },
): DeepSeekV4ToolProbeCheck {
  return {
    ...(response?.payload ? { finishReason: readFinishReason(response.payload) } : {}),
    ...(typeof response?.status === 'number' ? { httpStatus: response.status } : {}),
    status,
    toolCallCount: response?.payload ? readToolCalls(response.payload).length : 0,
  };
}

function skippedCheck(): DeepSeekV4ToolProbeCheck {
  return safeCheck('skipped');
}

export function readDeepSeekV4ToolProbeEnvironment(
  env: DeepSeekV4ToolProbeEnvironment,
): Pick<DeepSeekV4ToolProbeOptions, 'apiKey' | 'connection'> {
  if (env[DEEPSEEK_V4_TOOL_PROBE_ENABLE] !== '1') {
    throw new Error(`真实探针默认关闭；需显式设置 ${DEEPSEEK_V4_TOOL_PROBE_ENABLE}=1。`);
  }
  if (env[DEEPSEEK_V4_TOOL_PROBE_CONFIRM] !== DEEPSEEK_V4_TOOL_PROBE_CONFIRM_VALUE) {
    throw new Error(`真实探针需再确认 ${DEEPSEEK_V4_TOOL_PROBE_CONFIRM}=${DEEPSEEK_V4_TOOL_PROBE_CONFIRM_VALUE}。`);
  }
  const apiKey = env.JUNLUO_DEEPSEEK_API_KEY?.trim() ?? '';
  if (!apiKey) throw new Error('真实探针没有读到 JUNLUO_DEEPSEEK_API_KEY；未发送请求。');
  const connection: AiConnection = {
    id: 'deepseek-v4-live-probe',
    name: 'DeepSeek V4 live probe',
    provider: 'openai-compatible',
    preset: 'deepseek',
    baseUrl: env.EXPO_PUBLIC_DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    model: env.EXPO_PUBLIC_DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash',
  };
  if (!isOfficialDeepSeekV4Connection(connection)) {
    throw new Error('真实探针只允许官方 api.deepseek.com 的 DeepSeek V4 Flash/Pro 连接。');
  }
  return { apiKey, connection };
}

export async function runDeepSeekV4ToolProviderLiveProbe({
  apiKey,
  connection,
  fetchImpl = fetch as ProbeFetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
}: DeepSeekV4ToolProbeOptions): Promise<DeepSeekV4ToolProbeReport> {
  if (!apiKey.trim()) throw new Error('真实探针缺少 API Key；未发送请求。');
  if (!isOfficialDeepSeekV4Connection(connection)) {
    throw new Error('真实探针只允许官方 DeepSeek V4 连接。');
  }
  let requestCount = 0;
  const request = async (beta: boolean, body: JsonObject) => {
    if (requestCount >= MAX_LIVE_PROBE_REQUESTS) throw new Error('真实探针已到 6 次请求上限。');
    requestCount += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(completionUrl(connection, beta), {
        body: JSON.stringify(body),
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller.signal,
      });
      if (!response.ok) return { ok: false as const, status: response.status };
      const payload = await response.json().catch(() => undefined);
      if (!payload) return { ok: false as const, status: response.status };
      return { ok: true as const, payload, status: response.status };
    } catch (error) {
      return {
        ok: false as const,
        status: error instanceof Error && error.name === 'AbortError' ? 408 : 0,
      };
    } finally {
      clearTimeout(timer);
    }
  };

  const checks: DeepSeekV4ToolProbeReport['checks'] = {
    thinkingToolCall: skippedCheck(),
    thinkingContinuation: skippedCheck(),
    strictBeta: skippedCheck(),
    prefixWithTools: skippedCheck(),
    nonThinkingToolChoice: skippedCheck(),
  };
  const baseMessages = [{ role: 'user', content: PROBE_USER_MESSAGE }];
  const standardTools = [probeTool(false)];
  const thinkingFirst = await request(false, {
    model: connection.model.trim(),
    messages: baseMessages,
    tools: standardTools,
    thinking: { type: 'enabled' },
    max_tokens: 512,
    stream: false,
  });
  const firstCalls = thinkingFirst.ok ? readToolCalls(thinkingFirst.payload) : [];
  const firstCall = firstCalls[0];
  const firstCallId = readToolCallId(firstCall);
  const nativeTools = thinkingFirst.ok
    && firstCalls.length > 0
    && Boolean(firstCallId)
    && isExpectedToolCall(firstCall);
  checks.thinkingToolCall = safeCheck(nativeTools ? 'passed' : 'failed', thinkingFirst.ok
    ? { payload: thinkingFirst.payload, status: thinkingFirst.status }
    : { status: thinkingFirst.status });

  if (!thinkingFirst.ok) {
    return {
      version: 1,
      connectionFingerprint: buildToolProviderConnectionFingerprint(connection),
      endpointHost: 'api.deepseek.com',
      model: connection.model.trim(),
      requestCount,
      evidence: {
        requestCount,
        nativeTools: false,
        thinkingTools: false,
        thinkingRequestOmittedToolChoice: true,
        reasoningReplayExact: false,
        assistantContentNonNull: false,
        strictBetaEndpoint: false,
        prefixWithTools: false,
        nonThinkingToolChoice: false,
      },
      checks,
    };
  }

  const firstMessage = readMessage(thinkingFirst.payload);
  const reasoningContent = typeof firstMessage?.reasoning_content === 'string'
    ? firstMessage.reasoning_content
    : undefined;
  let reasoningReplayExact = false;
  let assistantContentNonNull = false;
  let thinkingTools = false;
  if (nativeTools && firstCall && firstCallId && reasoningContent !== undefined) {
    const assistantContent = typeof firstMessage?.content === 'string' ? firstMessage.content : '';
    const assistantReplay = {
      role: 'assistant',
      content: assistantContent,
      reasoning_content: reasoningContent,
      tool_calls: [firstCall],
    };
    reasoningReplayExact = assistantReplay.reasoning_content === reasoningContent;
    assistantContentNonNull = typeof assistantReplay.content === 'string';
    const continuation = await request(false, {
      model: connection.model.trim(),
      messages: [
        ...baseMessages,
        assistantReplay,
        { role: 'tool', tool_call_id: firstCallId, content: SIMULATED_TOOL_RESULT },
      ],
      tools: standardTools,
      thinking: { type: 'enabled' },
      max_tokens: 512,
      stream: false,
    });
    thinkingTools = continuation.ok;
    checks.thinkingContinuation = safeCheck(continuation.ok ? 'passed' : 'failed', continuation.ok
      ? { payload: continuation.payload, status: continuation.status }
      : { status: continuation.status });
  }

  const strict = await request(true, {
    model: connection.model.trim(),
    messages: baseMessages,
    tools: [probeTool(true)],
    tool_choice: 'auto',
    thinking: { type: 'disabled' },
    max_tokens: 256,
    stream: false,
  });
  const strictBetaEndpoint = strict.ok && readToolCalls(strict.payload).some(isExpectedToolCall);
  checks.strictBeta = safeCheck(strictBetaEndpoint ? 'passed' : 'failed', strict.ok
    ? { payload: strict.payload, status: strict.status }
    : { status: strict.status });

  const prefix = await request(true, {
    model: connection.model.trim(),
    messages: [
      ...baseMessages,
      { role: 'assistant', content: PROBE_ASSISTANT_PREFIX, prefix: true },
    ],
    tools: standardTools,
    tool_choice: 'auto',
    thinking: { type: 'disabled' },
    max_tokens: 256,
    stream: false,
  });
  const prefixWithTools = prefix.ok && readToolCalls(prefix.payload).some(isExpectedToolCall);
  checks.prefixWithTools = safeCheck(prefixWithTools ? 'passed' : 'failed', prefix.ok
    ? { payload: prefix.payload, status: prefix.status }
    : { status: prefix.status });

  const nonThinking = await request(false, {
    model: connection.model.trim(),
    messages: baseMessages,
    tools: standardTools,
    tool_choice: 'auto',
    thinking: { type: 'disabled' },
    max_tokens: 256,
    stream: false,
  });
  const nonThinkingToolChoice = nonThinking.ok && readToolCalls(nonThinking.payload).some(isExpectedToolCall);
  checks.nonThinkingToolChoice = safeCheck(nonThinkingToolChoice ? 'passed' : 'failed', nonThinking.ok
    ? { payload: nonThinking.payload, status: nonThinking.status }
    : { status: nonThinking.status });

  const evidence: ToolProviderProbeEvidence = {
    requestCount,
    nativeTools,
    thinkingTools,
    thinkingRequestOmittedToolChoice: true,
    reasoningReplayExact,
    assistantContentNonNull,
    strictBetaEndpoint,
    prefixWithTools,
    nonThinkingToolChoice,
  };
  let capabilityReport: ToolProviderCapabilityReport | undefined;
  if (nativeTools) {
    capabilityReport = buildCapabilityReportFromProbe(connection, evidence);
  }
  return {
    version: 1,
    connectionFingerprint: buildToolProviderConnectionFingerprint(connection),
    endpointHost: 'api.deepseek.com',
    model: connection.model.trim(),
    requestCount,
    evidence,
    checks,
    ...(capabilityReport ? { capabilityReport } : {}),
  };
}
