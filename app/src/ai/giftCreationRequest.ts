import type { AiConnection } from './types';
import { buildChatModelParameterPayload } from './modelParameters';
import { beginPromptCacheMetric } from './promptCacheMetrics';
import { parseOpenAiToolCalls, toolDefinitionToOpenAiTool, type JunLuoToolInvocation } from '../tools/toolCallProtocol';
import type { JunLuoToolDefinition } from '../tools/toolTypes';
import type { JunLuoToolAgentContinuationMessage } from '../tools/toolAgentMessages';

export type GiftCreationResponse = { content: string; calls: JunLuoToolInvocation[] };
type Input = {
  apiKey: string; connection: AiConnection; systemMessages: readonly string[];
  messages: readonly { subject: 'I' | 'you'; content: string }[];
  continuation: readonly JunLuoToolAgentContinuationMessage[]; tools: JunLuoToolDefinition[];
  beforeRequest: () => Promise<void>; onResult: (value: GiftCreationResponse) => void; signal?: AbortSignal;
};
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(code: string): never { throw Error(`gift-creation-request-${code}`); }

/** Only the final provider adapter maps actual I/you statements and internal tool receipts. */
export async function requestGiftCreation(input: Input): Promise<GiftCreationResponse> {
  if (input.signal?.aborted) fail('cancelled');
  if (input.connection.provider !== 'openai-compatible' || !input.apiKey.trim() || !input.connection.model.trim()) fail('config');
  let base: URL;
  try { base = new URL(input.connection.baseUrl.trim()); } catch { return fail('config'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) fail('config');
  if (!input.systemMessages.length || input.systemMessages.some(line => typeof line !== 'string' || !line.trim())
    || input.messages.some(line => !['I', 'you'].includes(line.subject) || typeof line.content !== 'string' || !line.content.trim())) fail('input');
  await input.beforeRequest();
  if (input.signal?.aborted) fail('cancelled');
  const messages = [
    ...input.systemMessages.map(content => ({ role: 'system', content })),
    ...input.messages.map(line => ({ role: line.subject === 'I' ? 'assistant' : 'user', content: line.content })),
    ...input.continuation.map(line => line.kind === 'tool_result'
      ? { role: 'tool', tool_call_id: line.callId, content: line.content }
      : { role: 'assistant', content: line.content, tool_calls: line.toolCalls.map(call => ({
        id: call.callId, type: call.type, function: { name: call.rawName, arguments: call.rawArguments },
      })) }),
  ];
  const body = JSON.stringify({ model: input.connection.model, max_tokens: 8192,
    ...buildChatModelParameterPayload(input.connection.modelParameters), messages, stream: false,
    ...(input.tools.length ? { tools: input.tools.map(tool => toolDefinitionToOpenAiTool(tool)),
      tool_choice: 'auto', parallel_tool_calls: false } : {}) });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  input.signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 120_000);
  let abort!: () => void;
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(Error('gift-creation-request-interrupted'));
    controller.signal.addEventListener('abort', abort, { once: true });
  });
  const metric = beginPromptCacheMetric({ connection: input.connection,
    contextProfile: 'chat-full', contextSource: 'gift.creation' });
  try {
    if (input.signal?.aborted) fail('cancelled');
    const response = await Promise.race([fetch(`${base.href.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST', headers: { Authorization: `Bearer ${input.apiKey}`, 'Content-Type': 'application/json' },
      body, signal: controller.signal,
    }), interrupted]);
    if (!response.ok) fail(response.status === 401 || response.status === 403 ? 'auth'
      : response.status === 429 ? 'rate-limited' : 'http');
    const raw = await Promise.race([response.text(), interrupted]);
    if (input.signal?.aborted) fail('cancelled');
    if (timedOut) fail('timeout');
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return fail('response'); }
    if (!object(payload) || payload.error || !Array.isArray(payload.choices)) fail('response');
    const choices = payload.choices as unknown[];
    if (choices.filter(value => object(value) && value.index === 0).length > 1) fail('response');
    const choice = choices.find(value => object(value) && value.index === 0) ?? choices[0];
    if (!object(choice) || !object(choice.message) || !['stop', 'end_turn', 'tool_calls'].includes(String(choice.finish_reason))) fail('incomplete');
    const message = choice.message;
    if (message.content != null && typeof message.content !== 'string') fail('response');
    const parsed = parseOpenAiToolCalls(message, input.tools);
    if (parsed.errors.length || parsed.invocations.length > 3
      || (choice.finish_reason === 'tool_calls') !== (parsed.invocations.length > 0)) fail('tools');
    if (object(payload.usage)) {
      const usage: Record<string, unknown> = {};
      for (const key of ['prompt_tokens', 'completion_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']) {
        if (Number.isSafeInteger(payload.usage[key]) && Number(payload.usage[key]) >= 0) usage[key] = Number(payload.usage[key]);
      }
      const details = payload.usage.prompt_tokens_details;
      if (object(details) && Number.isSafeInteger(details.cached_tokens) && Number(details.cached_tokens) >= 0) {
        usage.prompt_tokens_details = { cached_tokens: Number(details.cached_tokens) };
      }
      metric.recordUsage(usage);
    }
    const result = { content: typeof message.content === 'string' ? message.content : '', calls: parsed.invocations };
    input.onResult(result);
    return result;
  } catch (error) {
    if (input.signal?.aborted) return fail('cancelled');
    if (timedOut) return fail('timeout');
    if (error instanceof Error && /^gift-creation-request-[a-z-]+$/.test(error.message)) throw error;
    return fail('network');
  } finally {
    clearTimeout(timer); input.signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', abort); void metric.finish();
  }
}
