import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { buildCompiledSystemPrompt } from '../ai/builtInSystemPrompt';
import { buildAssistantLifeShortJsonRequest } from '../ai/assistantLifeShortJsonRequest';
import { AiCostDeferredError, checkAutomaticRequestCost } from '../ai/aiCallBudget';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';
import { loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { getAutomaticCostRestriction } from '../runtime/automaticRemoteAiPolicyCore';
import { buildChatModelParameterPayload } from '../ai/modelParameters';
import { withRequestBodyDeadline } from '../utils/requestBodyDeadline';
import type { WebSearchProviderSearchResult } from './webSearchProvider';

export const WEB_VOYAGE_TOPIC_INSTRUCTION = `【这次想出去看看什么】

I 结合最近的交流、已有见闻和此刻的兴趣，决定这次想去哪里看看、想找什么。

可以接着之前的好奇，也可以探索新东西。

想看公开网页时：
{"target":"web","query":"想搜索的内容"}

想逛 GitHub 项目时：
{"target":"github","query":"想搜索的内容"}

暂时没有想看的内容时：
{"query":""}

搜索时，用想了解的主题作为关键词，省去私人身份、联系方式和私密聊天原文。`;

export const WEB_VOYAGE_PAGE_INSTRUCTION = `【挑一篇想看的网页】

I 看看这些网页的标题和摘要，选一篇此刻想继续读的。

可以沿着刚才的问题找答案，也可以被其中的新东西吸引。

想点开时，填写对应编号：
{"item":2}

这次没有想点开的：
{"item":null}

标题和摘要只是网页预览，读到正文后，再形成对内容的理解。`;

export const GITHUB_VOYAGE_PAGE_INSTRUCTION = `【挑一个想看的项目】

I 看看这些项目的名称和简介，选一个此刻想继续了解的。

可以沿着刚才的问题探索，也可以被其中的新东西吸引。

想点开时，填写对应编号：
{"item":2}

这次没有想点开的：
{"item":null}

名称和简介只是项目预览，读到项目介绍后，再形成对内容的理解。`;

export type GeneratedWebVoyageQuery = { ok: true; query: string; target?: 'web' | 'github' }
  | { ok: false; reason: string; detail: string };

export function isValidExplorationQuery(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && !/[\u0000-\u001f\u007f]/.test(value);
}

function readDecisionJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return JSON.parse(fence ? fence[1] : trimmed);
}

export function parseGeneratedSearchQuery(text: string): GeneratedWebVoyageQuery {
  const invalid = (detail: string): GeneratedWebVoyageQuery => ({ ok: false, reason: 'query_response_invalid', detail });
  if (!text.trim()) return invalid('选题答卷没有返回正式内容。');
  let value: unknown;
  try {
    value = readDecisionJson(text);
  } catch { return invalid('选题答卷不是完整 JSON。'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid('选题答卷不是单个对象。');
  const answer = value as { query?: unknown; target?: unknown };
  if (!isValidExplorationQuery(answer.query)) return invalid('选题答卷的 query 不是有效搜索词。');
  if (!answer.query.trim()) return { ok: true, query: answer.query };
  if (answer.target !== 'web' && answer.target !== 'github') return invalid('选题答卷的 target 不是 web 或 github。');
  return { ok: true, query: answer.query, target: answer.target };
}

export function parseWebVoyagePageChoice(text: string, count: number): number | null | undefined {
  try {
    const value = JSON.parse(text);
    if (!value || Array.isArray(value)) return undefined;
    if (value.item === null) return null;
    if (Number.isInteger(value.item) && value.item >= 1 && value.item <= count) return value.item;
  } catch { /* No default first result. */ }
  return undefined;
}

export function isPublicWebVoyageUrl(value: string) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
      && !!host && host !== 'localhost' && !host.endsWith('.local')
      && !/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
      && !/^\[(?:::1|::|::ffff:.*|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)\]$/i.test(host);
  } catch { return false; }
}

export function selectWebVoyageCandidates(results: WebSearchProviderSearchResult[]) {
  const seen = new Set<string>();
  return results.filter(result => {
    if (!isPublicWebVoyageUrl(result.url)) return false;
    const url = new URL(result.url);
    url.hash = '';
    const key = url.href;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

// Only the actual answer channel; reasoning is deliberately not a fallback.
function answerText(payload: any): string {
  const read = (value: any): string => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(read).join('')
      : value && typeof value === 'object' ? read(value.text ?? value.content ?? value.output_text) : '';
  const choice = payload?.choices?.[0];
  return [choice?.message?.content, choice?.text, choice?.output_text, payload?.output_text,
    payload?.text, choice?.message?.answer].map(read).find(text => text.trim())?.trim() ?? '';
}

export class WebVoyageDecisionResponseError extends Error {
  constructor(readonly reason: 'decision_response_empty' | 'decision_response_truncated', detail: string) {
    super(detail);
    this.name = 'WebVoyageDecisionResponseError';
  }
}

/** No retries and no follow-up reading request. Callers revalidate after every wait. */
export async function checkWebVoyageCost() {
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  await checkAutomaticRequestCost({ connection: resolveLifeCreativeConfig(snapshot).connection, purpose: 'web-voyage' });
}

export async function requestWebVoyageDecision(
  instruction: string, material: string, isCurrent: () => Promise<boolean>,
  onRequestStart?: () => Promise<void>,
  onUnsent?: () => Promise<void>,
) {
  const snapshot = await loadAiConfigPreferencesSnapshot({ maxAgeMs: 0 });
  const config = resolveLifeCreativeConfig(snapshot);
  const connection = config.connection;
  if (!connection?.baseUrl.trim() || !connection.model.trim() || !config.apiKey?.trim()) {
    throw new Error('query_config_missing');
  }
  const persona = await buildCompiledSystemPrompt({ contextProfile: 'proactive-lite', profile: snapshot.profile,
    outputAudience: 'internal_structured', readOnly: true });
  if (!await isCurrent()) throw new Error('web_voyage_source_invalid');
  await checkAutomaticRequestCost({ connection, purpose: 'web-voyage' });
  await onRequestStart?.();
  try {
    const policy = await loadAutomaticRemoteAiPolicy();
    if (!await isCurrent()) throw new Error('web_voyage_source_invalid');
    // Local preparation/persistence can straddle the price boundary. Never test
    // the price after fetch: an already-paid answer must still be saved.
    const cost = getAutomaticCostRestriction({ policy, baseUrl: connection.baseUrl,
      now: Date.now(), purpose: 'web-voyage' });
    if (cost.mode === 'wait') throw new AiCostDeferredError('cost-window', cost.retryAt);
  } catch (error) { await onUnsent?.(); throw error; }
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    const payload = await withRequestBodyDeadline(async signal => {
      const body = JSON.stringify({ model: connection.model.trim(), ...buildAssistantLifeShortJsonRequest(connection, 0.45), max_tokens: buildChatModelParameterPayload(connection.modelParameters).max_tokens,
        messages: [{ role: 'system', content: persona }, { role: 'system', content: instruction },
          { role: 'system', content: material }] });
      cacheMetric = beginPromptCacheMetric({ contextProfile: 'proactive-lite',
        contextSource: instruction === WEB_VOYAGE_TOPIC_INSTRUCTION ? 'voyage.topic' : 'voyage.selection', connection });
      const response = await fetch(`${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST', signal,
        headers: { Authorization: `Bearer ${config.apiKey.trim()}`, 'Content-Type': 'application/json' },
        body,
      });
      if (signal.aborted) throw new Error('timeout');
      if (!response.ok) throw new Error(`query_http_${response.status}`);
      return response.json();
    }, 60_000);
    cacheMetric?.recordUsage(payload?.usage);
    const text = answerText(payload);
    const choice = payload?.choices?.[0];
    const rawFinish = choice?.finish_reason;
    const finish = ['stop', 'length', 'tool_calls', 'content_filter'].includes(rawFinish) ? rawFinish : 'unknown';
    const reasoning = !!(choice?.message?.reasoning_content || choice?.message?.reasoning);
    const metadata = `finish=${finish}, answerChars=${text.length}, reasoning=${reasoning ? 'yes' : 'no'}`;
    if (!text) throw new WebVoyageDecisionResponseError(finish === 'length' ? 'decision_response_truncated' : 'decision_response_empty',
      `${finish === 'length' ? '探索答卷输出到顶，未取得完整答卷。' : '探索答卷没有返回正式内容。'}${metadata}`);
    if (finish === 'length') {
      // A complete paid JSON answer remains usable. Never fill in a cut-off answer.
      try { readDecisionJson(text); }
      catch { throw new WebVoyageDecisionResponseError('decision_response_truncated', `探索答卷输出到顶，未取得完整答卷。${metadata}`); }
    }
    return text;
  } finally { cacheMetric?.finish(); }
}
