import type { AiConnection } from '../ai/types';
import { buildChatModelParameterPayload, buildOpenAiCompatibilityPayload } from '../ai/modelParameters';
import { isOfficialDeepSeekV4Connection } from '../ai/toolProviderCapabilities';
import { estimateApiMessagesTokens } from '../chat/contextCompression';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { buildShiyingReviewApiMessages } from './shiyingReviewPrompt';

export type ShiyingReviewRequestStage = { kind: 'week' | 'month' | 'year'; reading?: boolean; legacy?: boolean };
export function shiyingReviewOutputTokens(connection: AiConnection, stage?: ShiyingReviewRequestStage) {
  const maximum = !stage || stage.legacy || stage.reading ? 8192 : stage.kind === 'week' ? 12288 : stage.kind === 'month' ? 16384 : 24576;
  return Math.min(buildChatModelParameterPayload(connection.modelParameters).max_tokens ?? maximum, maximum);
}
export function shiyingReviewFits(connection: AiConnection, prompt: string, material: string, stage?: ShiyingReviewRequestStage) {
  return estimateApiMessagesTokens(buildShiyingReviewApiMessages(prompt, material)) + shiyingReviewOutputTokens(connection, stage) + 512
    <= (connection.contextWindowTokens ?? 65536);
}
export async function requestShiyingWeeklyReview(input: { apiKey: string; connection: AiConnection; prompt: string; material: string; stage?: ShiyingReviewRequestStage }) {
  const timeout = !input.stage || input.stage.legacy || input.stage.reading ? 120_000
    : input.stage.kind === 'week' ? 180_000 : input.stage.kind === 'month' ? 300_000 : 600_000;
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
  let metric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    const parameters = buildChatModelParameterPayload(input.connection.modelParameters);
    const messages = buildShiyingReviewApiMessages(input.prompt, input.material);
    let response: Response;
    try {
      const body = JSON.stringify({ model: input.connection.model.trim(), messages, ...buildOpenAiCompatibilityPayload(input.connection), ...parameters,
        temperature: Math.min(parameters.temperature ?? .3, .3), max_tokens: shiyingReviewOutputTokens(input.connection, input.stage), stream: false,
        ...(isOfficialDeepSeekV4Connection(input.connection) ? { thinking: { type: 'disabled' } } : {}),
      });
      metric = beginPromptCacheMetric({ contextProfile: 'shiying', contextSource: input.stage?.kind === 'month' ? 'shiying.monthlyReview'
        : input.stage?.kind === 'year' ? 'shiying.yearlyReview' : 'shiying.weeklyReview', connection: input.connection, stablePrefixText: input.prompt });
      response = await fetch(`${input.connection.baseUrl.trim().replace(/\/+$/u, '')}/chat/completions`, {
        method: 'POST', signal: controller.signal, headers: { Authorization: `Bearer ${input.apiKey.trim()}`, 'Content-Type': 'application/json' },
        body,
      });
    } catch { throw new Error(`shiying_review_${controller.signal.aborted ? 'timeout' : 'network'}`); }
    if (!response.ok) throw new Error(`shiying_review_http_${response.status}`);
    let payload: { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | Array<{ text?: string }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number } };
    try { payload = await response.json(); } catch { throw new Error('shiying_review_response_json'); }
    metric.recordUsage(payload?.usage);
    const finishReason = payload.choices?.[0]?.finish_reason;
    if (finishReason === 'length' || finishReason === 'max_tokens') throw new Error('shiying_review_output_truncated');
    if (finishReason && finishReason !== 'stop' && finishReason !== 'end_turn') throw new Error('shiying_review_finish_failed');
    const content = payload.choices?.[0]?.message?.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
    if (!text.trim()) throw new Error('shiying_review_empty');
    return text;
  } finally { void metric?.finish(); clearTimeout(timer); }
}
