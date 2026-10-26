import type { AiConnection } from './types';
import { AUDIO_INPUT_BASE64_LIMIT, audioInputAdapterFor } from './audioInputCompatibility';
import { buildChatModelParameterPayload } from './modelParameters';
import { beginPromptCacheMetric } from './promptCacheMetrics';

type OriginalPart = { type: 'text'; text: string }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'image_url'; image_url: { url: string } };
type RequestInput = {
  apiKey: string;
  connection: AiConnection;
  systemMessages: readonly string[];
  material: { role: 'you'; content: readonly OriginalPart[] };
  kind: 'audio' | 'image';
  signal?: AbortSignal;
  beforeRequest?: () => Promise<void>;
};
type CompiledRequestInput = Omit<RequestInput, 'kind' | 'material'> & {
  kind: RequestInput['kind'] | 'reception'; material?: RequestInput['material'];
};
function fail(suffix: string): never { throw Error(`gift-original-request-${suffix}`); }

function validate(input: CompiledRequestInput) {
  if (!input.apiKey?.trim() || input.connection?.provider !== 'openai-compatible'
    || !input.connection.model?.trim() || !input.connection.baseUrl?.trim()) fail('invalid-config');
  let url: URL;
  try { url = new URL(input.connection.baseUrl.trim()); } catch { return fail('invalid-config'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail('invalid-config');
  if (!['audio', 'image', 'reception'].includes(input.kind) || !Array.isArray(input.systemMessages) || !input.systemMessages.length
    || input.systemMessages.some(message => typeof message !== 'string' || !message.trim())) fail('invalid-input');
  if (input.kind === 'reception' && input.material === undefined) return;
  if (input.material?.role !== 'you' || !Array.isArray(input.material.content) || input.material.content.length !== 2) fail('invalid-input');
  const [label, original] = input.material.content;
  if (label?.type !== 'text' || typeof label.text !== 'string' || !label.text.trim()) fail('invalid-input');
  if (input.kind !== 'audio') {
    if (original?.type !== 'image_url' || typeof original.image_url?.url !== 'string' || !original.image_url.url.trim()) fail('invalid-input');
  } else {
    if (original?.type !== 'input_audio' || typeof original.input_audio?.data !== 'string'
      || typeof original.input_audio.format !== 'string' || !original.input_audio.format.trim()) fail('invalid-input');
    const qwen = audioInputAdapterFor(input.connection) === 'qwen-omni';
    const data = original.input_audio.data;
    const base64 = qwen ? data.startsWith('data:;base64,') ? data.slice(13) : '' : data;
    if (!base64 || base64.length >= AUDIO_INPUT_BASE64_LIMIT || base64.length % 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) fail('invalid-input');
  }
}

function choiceZero(payload: Record<string, unknown>) {
  if (payload.error) fail('provider-error');
  if (payload.choices === undefined) return undefined;
  if (!Array.isArray(payload.choices)) fail('invalid-response');
  const choices = payload.choices as Array<Record<string, unknown>>;
  if (choices.some(choice => !choice || typeof choice !== 'object' || Array.isArray(choice))) fail('invalid-response');
  return choices.find(choice => choice.index === 0)
    ?? (choices[0]?.index === undefined ? choices[0] : undefined);
}

function payloadJson(value: string): Record<string, unknown> {
  let payload: unknown;
  try { payload = JSON.parse(value); } catch { return fail('invalid-response'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail('invalid-response');
  return payload as Record<string, unknown>;
}

function completeText(content: string, finish: unknown) {
  if (finish !== 'stop' && finish !== 'end_turn') fail('incomplete-response');
  if (!content.trim()) fail('empty-response');
  return content.trim();
}

function parseResponse(body: string, sse: boolean, usage: (value: unknown) => void) {
  if (!sse) {
    const payload = payloadJson(body);
    usage(payload.usage);
    const choice = choiceZero(payload);
    if (!choice) return fail('empty-response');
    const message = choice.message as { content?: unknown } | undefined;
    if (message?.content != null && typeof message.content !== 'string') fail('invalid-response');
    return completeText(typeof message?.content === 'string' ? message.content : '', choice.finish_reason);
  }
  let content = '', finish: unknown = null, done = false;
  for (const event of body.replace(/\r\n?/g, '\n').split(/\n\n/)) {
    const lines = event.split('\n').filter(line => line.startsWith('data:'));
    if (!lines.length) continue;
    const data = lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data.trim()) continue;
    if (done) fail('invalid-response');
    if (data.trim() === '[DONE]') { done = true; continue; }
    const payload = payloadJson(data);
    usage(payload.usage);
    const choice = choiceZero(payload);
    if (!choice) continue;
    const delta = choice.delta as { content?: unknown } | undefined;
    if (delta?.content != null && typeof delta.content !== 'string') fail('invalid-response');
    if (typeof delta?.content === 'string' && delta.content) {
      if (finish !== null) fail('invalid-response');
      content += delta.content;
    }
    if (choice.finish_reason != null) {
      if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'end_turn') fail('incomplete-response');
      finish = choice.finish_reason;
    }
  }
  if (!done) fail('incomplete-response');
  return completeText(content, finish);
}

/** Compiled messages enter unchanged; only this outbound adapter maps you to user. */
export function requestGiftOriginalUnderstanding(input: RequestInput): Promise<string> {
  return requestCompiledGift(input);
}

export function requestGiftReceptionChoice(input: Omit<RequestInput, 'kind' | 'material'> & {
  material?: RequestInput['material'];
}): Promise<string> {
  return requestCompiledGift({ ...input, kind: 'reception' });
}

async function requestCompiledGift(input: CompiledRequestInput): Promise<string> {
  const ready = () => { if (input.signal?.aborted) fail('cancelled'); };
  ready();
  try { validate(input); } catch (error) {
    if (error instanceof Error && /^gift-original-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('invalid-input');
  }
  try { await input.beforeRequest?.(); } catch (error) {
    ready();
    if (error instanceof Error && /^gift-[a-z-]+$/.test(error.message)) throw error;
    return fail('preflight-failed');
  }
  ready();
  let body: string;
  let qwenAudio = false;
  try {
    validate(input);
    qwenAudio = input.kind === 'audio' && audioInputAdapterFor(input.connection) === 'qwen-omni';
    // beforeRequest can refresh the same systemMessages array. Read it only now.
    body = JSON.stringify({ model: input.connection.model.trim(), max_tokens: 2048,
      ...buildChatModelParameterPayload(input.connection.modelParameters),
      messages: [...input.systemMessages.map(content => ({ role: 'system', content })),
        ...(input.material ? [{ role: 'user', content: input.material.content }] : [])],
      stream: qwenAudio,
      ...(input.kind === 'audio' ? { modalities: ['text'] } : {}),
      ...(qwenAudio ? { stream_options: { include_usage: true } } : {}),
    });
  } catch (error) {
    if (error instanceof Error && /^gift-original-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('invalid-input');
  }
  const controller = new AbortController();
  let timedOut = false;
  const cancel = () => controller.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  let metric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  let rejectAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(Error('gift-original-request-interrupted'));
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
  });
  try {
    ready();
    metric = beginPromptCacheMetric({ connection: { model: input.connection.model, baseUrl: input.connection.baseUrl },
      contextProfile: 'chat-full', contextSource: input.kind === 'reception' ? 'gift.reception' : 'gift.original' });
    const response = await Promise.race([fetch(`${input.connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.apiKey.trim()}`, 'Content-Type': 'application/json' },
      body, signal: controller.signal,
    }), aborted]);
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'auth'
      : response.status === 429 ? 'rate-limited' : 'http-error');
    const raw = await Promise.race([response.text(), aborted]);
    ready();
    if (timedOut) fail('timeout');
    return parseResponse(raw, qwenAudio, value => metric?.recordUsage(value));
  } catch (error) {
    if (input.signal?.aborted) return fail('cancelled');
    if (timedOut) return fail('timeout');
    if (error instanceof Error && /^gift-original-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('network');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', rejectAbort);
    void metric?.finish();
  }
}
