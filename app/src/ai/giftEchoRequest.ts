import type { AiConnection } from './types';
import { AUDIO_INPUT_BASE64_LIMIT, audioInputAdapterFor, audioOriginalFormat } from './audioInputCompatibility';
import { buildChatModelParameterPayload } from './modelParameters';
import { beginPromptCacheMetric } from './promptCacheMetrics';

type GiftEchoInput = {
  apiKey: string;
  connection: AiConnection;
  systemMessages: readonly string[];
  messages: readonly { subject: 'I' | 'you'; content: string }[];
  tools?: readonly unknown[];
  original?: { kind: 'audio' | 'image'; mimeType: string; base64: string; format?: string };
  signal?: AbortSignal;
  beforeRequest?: () => Promise<void>;
};
type GiftEchoResult = { kind: 'reply'; content: string } | { kind: 'tool'; name: string; arguments: unknown };
type Payload = Record<string, unknown>;
function fail(suffix: string): never { throw Error(`gift-echo-request-${suffix}`); }
const object = (value: unknown): value is Payload => !!value && typeof value === 'object' && !Array.isArray(value);

function validate(input: GiftEchoInput) {
  if (!input?.apiKey?.trim() || input.connection?.provider !== 'openai-compatible'
    || !input.connection.model?.trim() || !input.connection.baseUrl?.trim()) fail('invalid-config');
  let url: URL;
  try { url = new URL(input.connection.baseUrl.trim()); } catch { return fail('invalid-config'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('invalid-config');
  if (!Array.isArray(input.systemMessages) || !input.systemMessages.length
    || input.systemMessages.some(value => typeof value !== 'string' || !value.trim())
    || !Array.isArray(input.messages) || !input.messages.length
    || input.messages.some(value => !value || !['I', 'you'].includes(value.subject)
      || typeof value.content !== 'string' || !value.content.trim())
    || input.tools !== undefined && (!Array.isArray(input.tools) || input.tools.some(value => !object(value)))) fail('invalid-input');
  const original = input.original;
  if (!original) return;
  if (input.messages.at(-1)?.subject !== 'you' || !['audio', 'image'].includes(original.kind)
    || typeof original.mimeType !== 'string' || typeof original.base64 !== 'string' || !original.base64
    || original.base64.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(original.base64)) fail('invalid-input');
  if (original.kind === 'image') {
    if (!/^image\/(?:png|jpe?g|gif|webp)$/i.test(original.mimeType)) fail('invalid-input');
  } else {
    if (original.base64.length >= AUDIO_INPUT_BASE64_LIMIT || !original.format) fail('invalid-input');
    try {
      if (audioOriginalFormat({ mimeType: original.mimeType, originalName: `original.${original.format}` },
        audioInputAdapterFor(input.connection)) !== original.format) fail('invalid-input');
    } catch { fail('invalid-input'); }
  }
}

function parseJson(raw: string): Payload {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail('invalid-response'); }
  if (!object(value)) fail('invalid-response');
  return value;
}
function choiceZero(payload: Payload): Payload | undefined {
  if (payload.error) fail('provider-error');
  if (payload.choices === undefined) return undefined;
  if (!Array.isArray(payload.choices) || payload.choices.some(value => !object(value))) fail('invalid-response');
  const choices = payload.choices as Payload[];
  if (choices.filter(value => value.index === 0).length > 1) fail('invalid-response');
  return choices.find(value => value.index === 0) ?? (choices[0]?.index === undefined ? choices[0] : undefined);
}

/** Keep usage observation numeric; provider strings and arbitrary details never enter metrics. */
function numericUsage(value: unknown): Payload | undefined {
  if (!object(value)) return undefined;
  const usage: Payload = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens',
    'cached_tokens', 'cached_input_tokens']) {
    if (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0) usage[key] = value[key];
  }
  const details = value.prompt_tokens_details;
  if (object(details) && Number.isSafeInteger(details.cached_tokens) && Number(details.cached_tokens) >= 0) {
    usage.prompt_tokens_details = { cached_tokens: details.cached_tokens };
  }
  return Object.keys(usage).length ? usage : undefined;
}
function complete(content: string, finish: unknown, tool: { name: string; arguments: string } | undefined,
  toolsAllowed: boolean): GiftEchoResult {
  if (finish === 'tool_calls') {
    if (!toolsAllowed || !tool?.name.trim() || !tool.arguments.trim()) fail('invalid-response');
    let args: unknown;
    try { args = JSON.parse(tool.arguments); } catch { return fail('invalid-response'); }
    return { kind: 'tool', name: tool.name, arguments: args };
  }
  if (finish !== 'stop' && finish !== 'end_turn') fail('incomplete-response');
  if (tool) fail('invalid-response');
  if (!content.trim()) fail('empty-response');
  return { kind: 'reply', content: content.trim() };
}
function responseTool(value: unknown) {
  if (value == null || Array.isArray(value) && !value.length) return undefined;
  if (!Array.isArray(value) || value.length !== 1 || !object(value[0])) fail('invalid-response');
  const tool = value[0], fn = tool.function;
  if (tool.type !== 'function' || !object(fn) || typeof fn.name !== 'string' || !fn.name.trim()
    || typeof fn.arguments !== 'string') fail('invalid-response');
  return { name: fn.name, arguments: fn.arguments };
}
function parseResponse(raw: string, sse: boolean, toolsAllowed: boolean, usage: (value: unknown) => void): GiftEchoResult {
  const observe = (payload: Payload) => { const value = numericUsage(payload.usage); if (value) usage(value); };
  if (!sse) {
    const payload = parseJson(raw); observe(payload);
    const choice = choiceZero(payload);
    if (!choice) return fail('empty-response');
    const message = choice.message;
    if (!object(message) || message.content != null && typeof message.content !== 'string') fail('invalid-response');
    return complete(typeof message.content === 'string' ? message.content : '', choice.finish_reason,
      responseTool(message.tool_calls), toolsAllowed);
  }
  let content = '', finish: unknown = null, done = false;
  let tool: { name: string; arguments: string } | undefined;
  for (const event of raw.replace(/\r\n?/g, '\n').split(/\n\n/)) {
    const lines = event.split('\n').filter(line => line.startsWith('data:'));
    if (!lines.length) continue;
    const data = lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim()) continue;
    if (done) fail('invalid-response');
    if (data.trim() === '[DONE]') { done = true; continue; }
    const payload = parseJson(data); observe(payload);
    const choice = choiceZero(payload);
    if (!choice) continue;
    const delta = choice.delta;
    if (delta !== undefined && !object(delta)) fail('invalid-response');
    if (object(delta)) {
      if (delta.content != null && typeof delta.content !== 'string') fail('invalid-response');
      if (typeof delta.content === 'string' && delta.content) {
        if (finish !== null) fail('invalid-response');
        content += delta.content;
      }
      if (delta.tool_calls != null) {
        if (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 1) fail('invalid-response');
        for (const part of delta.tool_calls) {
          if (finish !== null || !object(part) || part.index !== undefined && part.index !== 0
            || part.type !== undefined && part.type !== 'function' || !object(part.function)) fail('invalid-response');
          const fn = part.function;
          if (fn.name !== undefined && typeof fn.name !== 'string'
            || fn.arguments !== undefined && typeof fn.arguments !== 'string') fail('invalid-response');
          tool ??= { name: '', arguments: '' };
          tool.name += fn.name ?? ''; tool.arguments += fn.arguments ?? '';
        }
      }
    }
    if (choice.finish_reason != null) {
      if (!['stop', 'end_turn', 'tool_calls'].includes(String(choice.finish_reason))) fail('incomplete-response');
      if (finish !== null) fail('invalid-response');
      finish = choice.finish_reason;
    }
  }
  if (!done) fail('incomplete-response');
  return complete(content, finish, tool, toolsAllowed);
}

/** Only this transport maps the real I/you statements to provider roles. */
export async function requestGiftEcho(input: GiftEchoInput): Promise<GiftEchoResult> {
  const ready = () => { if (input?.signal?.aborted) fail('cancelled'); };
  ready();
  try { validate(input); } catch (error) {
    if (error instanceof Error && /^gift-echo-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('invalid-input');
  }
  try { await input.beforeRequest?.(); } catch (error) {
    ready();
    if (error instanceof Error && /^gift-echo-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('preflight-failed');
  }
  ready();
  let body: string, qwenAudio: boolean;
  const toolsAllowed = !!input.tools?.length;
  try {
    validate(input);
    const audio = input.original?.kind === 'audio';
    qwenAudio = audio && audioInputAdapterFor(input.connection) === 'qwen-omni';
    const messages = input.messages.map((message, index) => {
      const role = message.subject === 'I' ? 'assistant' : 'user';
      const original = index === input.messages.length - 1 ? input.original : undefined;
      return { role, content: original ? [{ type: 'text', text: message.content }, original.kind === 'image'
        ? { type: 'image_url', image_url: { url: `data:${original.mimeType};base64,${original.base64}` } }
        : { type: 'input_audio', input_audio: { data: qwenAudio ? `data:;base64,${original.base64}` : original.base64, format: original.format! } }]
        : message.content };
    });
    body = JSON.stringify({ model: input.connection.model.trim(), max_tokens: 2048,
      ...buildChatModelParameterPayload(input.connection.modelParameters),
      messages: [...input.systemMessages.map(content => ({ role: 'system', content })), ...messages],
      stream: qwenAudio, ...(audio ? { modalities: ['text'] } : {}),
      ...(qwenAudio ? { stream_options: { include_usage: true } } : {}),
      ...(toolsAllowed ? { tools: input.tools, tool_choice: 'auto', parallel_tool_calls: false } : {}),
    });
  } catch (error) {
    if (error instanceof Error && /^gift-echo-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('invalid-input');
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  let metric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  let rejectAbort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(Error('gift-echo-request-interrupted'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    ready();
    metric = beginPromptCacheMetric({ connection: { model: input.connection.model, baseUrl: input.connection.baseUrl },
      contextProfile: 'chat-full', contextSource: 'gift.echo' });
    const response = await Promise.race([fetch(`${input.connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.apiKey.trim()}`, 'Content-Type': 'application/json' }, body, signal: controller.signal,
    }), interrupted]);
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'auth'
      : response.status === 429 ? 'rate-limited' : 'http-error');
    const raw = await Promise.race([response.text(), interrupted]);
    ready();
    if (timedOut) fail('timeout');
    return parseResponse(raw, qwenAudio, toolsAllowed, value => metric?.recordUsage(value));
  } catch (error) {
    if (input.signal?.aborted) return fail('cancelled');
    if (timedOut) return fail('timeout');
    if (error instanceof Error && /^gift-echo-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('network');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
    void metric?.finish();
  }
}
