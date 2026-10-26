import type { AiConnection } from '../ai/types';
import { beginPromptCacheMetric } from '../ai/promptCacheMetrics';

export type MemoryRecallRouteMode = 'background_only' | 'recall' | 'detail_recall';
export type MemoryRecallCareNeed =
  | 'ordinary'
  | 'low_energy'
  | 'needs_companionship'
  | 'needs_being_remembered'
  | 'sensitive';
export type MemoryRecallRouteSource = 'ai' | 'local';

export type MemoryRecallRoute = {
  mode: MemoryRecallRouteMode;
  needsRecall: boolean;
  needsSourceDetail: boolean;
  topic: string;
  keywords: string[];
  // 仅兼容旧本地路由；AI 查找只返回 mode、topic、keywords。
  reason?: string;
  confidence?: number;
  careNeed?: MemoryRecallCareNeed;
  careIntensity?: number;
  allowGentleMention?: boolean;
  routeSource: MemoryRecallRouteSource;
};

type RecentRouteMessage = {
  role: 'you' | 'I' | string;
  content: string;
  createdAt?: number;
};

type RouteMemoryRecallInput = {
  apiKey: string;
  connection: AiConnection;
  userText: string;
  recentMessages?: RecentRouteMessage[];
  signal?: AbortSignal;
  source?: 'chat' | 'life' | 'focus' | 'schedule' | 'letter' | 'proactive';
};

const ROUTE_TIMEOUT_MS = 1800;
const STOP_KEYWORDS = new Set([
  '我',
  '你',
  '鼠',
  '小仓鼠',
  '白云',
  '白云小姐',
  '老师',
  '记忆',
  '聊天',
  '之前',
  '上次',
  '以前',
  '这个',
  '那个',
]);

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function extractJsonObject(text: string) {
  const cleaned = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return cleaned.slice(start, end + 1);
}

function normalizeKeyword(value: unknown) {
  if (typeof value !== 'string') return '';
  const keyword = value
    .replace(/[，。！？、,.!?;；:："'“”‘’`()[\]{}<>《》]/g, '')
    .replace(/\s+/g, '')
    .trim();
  if (!keyword || STOP_KEYWORDS.has(keyword) || keyword.length > 24) return '';
  return keyword;
}

function normalizeRoute(value: unknown, routeSource: MemoryRecallRouteSource = 'ai'): MemoryRecallRoute | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<Record<keyof MemoryRecallRoute, unknown>>;
  let mode: MemoryRecallRouteMode;
  if (raw.mode === 'recall' || raw.mode === 'detail_recall' || raw.mode === 'background_only') {
    mode = raw.mode;
  } else {
    return null;
  }

  const needsSourceDetail = mode === 'detail_recall';
  const needsRecall = mode !== 'background_only';
  const keywords = Array.isArray(raw.keywords)
    ? [...new Set(raw.keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 5)
    : [];
  return {
    keywords,
    mode,
    needsRecall,
    needsSourceDetail,
    routeSource,
    topic: typeof raw.topic === 'string' ? raw.topic.trim().slice(0, 40) : '',
  };
}

function createLocalRoute({
  allowGentleMention = false,
  careIntensity = 0,
  careNeed = 'ordinary',
  confidence = 0.62,
  keywords = [],
  mode = 'background_only',
  reason,
  topic = '',
}: {
  allowGentleMention?: boolean;
  careIntensity?: number;
  careNeed?: MemoryRecallCareNeed;
  confidence?: number;
  keywords?: string[];
  mode?: MemoryRecallRouteMode;
  reason: string;
  topic?: string;
}): MemoryRecallRoute {
  const needsSourceDetail = mode === 'detail_recall';
  return {
    allowGentleMention,
    careIntensity: clamp(careIntensity, 0, 1),
    careNeed,
    confidence: clamp(confidence, 0, 1),
    keywords: [...new Set(keywords.map(normalizeKeyword).filter(Boolean))].slice(0, 5),
    mode,
    needsRecall: mode !== 'background_only',
    needsSourceDetail,
    reason,
    routeSource: 'local',
    topic,
  };
}

function hasAny(text: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(text));
}

function localKeywords(text: string) {
  const candidates = [
    '校园霸凌',
    '校园暴力',
    '创伤',
    '星图',
    '卡顿',
    '早睡',
    '熬夜',
    '冰饮',
    '喜欢',
    '不喜欢',
    '偏好',
    '讨厌',
    '边界',
    '称呼',
    '约定',
    '白云心声',
    '阶段记忆',
    '周脉络',
  ];
  return candidates.filter((keyword) => text.includes(keyword)).slice(0, 5);
}

export function routeMemoryRecallLocally({
  source = 'chat',
  userText,
}: Omit<RouteMemoryRecallInput, 'apiKey' | 'connection'>): MemoryRecallRoute | null {
  const text = userText.trim();
  if (!text) return null;
  if (source !== 'chat') {
    return createLocalRoute({
      confidence: 0.48,
      reason: '非聊天来源，保持轻量背景判断。',
      topic: '',
    });
  }

  const keywords = localKeywords(text);
  const asksDetail = hasAny(text, [
    /具体/,
    /原文/,
    /原话/,
    /细节/,
    /当时.*(怎么|如何|说了|做了|修)/,
    /步骤/,
    /证据/,
    /来源/,
    /追溯/,
  ]);
  const asksRecall = hasAny(text, [
    /还记得/,
    /记不记得/,
    /之前/,
    /上次/,
    /以前/,
    /曾经/,
    /当时/,
    /我是不是说过/,
    /我们.*聊过/,
  ]);
  const wantsBeingRemembered = hasAny(text, [
    /想被记得/,
    /想被(记得|记住|看见|惦记|关心)/,
    /想被好好(记得|记住|看见|惦记|关心)/,
    /希望.*(记得|记住|惦记|关心)/,
    /不要忘记我/,
    /别忘了我/,
    /别忘记我/,
  ]);
  const wantsCompanionship = hasAny(text, [
    /抱抱鼠/,
    /抱抱/,
    /陪陪/,
    /陪我/,
    /陪一下/,
    /孤独/,
    /寂寞/,
    /没人/,
    /没人陪/,
    /没有朋友/,
    /想你/,
    /需要你/,
  ]);
  const lowEnergy = hasAny(text, [
    /好累/,
    /很累/,
    /累累/,
    /鼠累/,
    /鼠累累/,
    /(?:我|鼠|本鼠|小仓鼠).{0,3}累/,
    /累了/,
    /累(?:呀|啊|啦|哦|噢|惹)/,
    /累死/,
    /疲惫/,
    /疲劳/,
    /好困/,
    /困困/,
    /鼠困/,
    /鼠困困/,
    /(?:我|鼠|本鼠|小仓鼠).{0,3}困/,
    /困了/,
    /困死/,
    /困(?:呀|啊|啦|哦|噢|惹)/,
    /没精神/,
    /崩溃/,
    /撑不住/,
    /没力气/,
    /低精力/,
    /精神状态.*差/,
    /难受/,
  ]);
  const sensitive = hasAny(text, [
    /校园(霸凌|暴力)/,
    /创伤/,
    /被欺负/,
    /伤害/,
    /自伤/,
    /自杀/,
    /轻生/,
    /霸凌/,
  ]);
  const newFactSave = hasAny(text, [
    /记一下/,
    /帮我记/,
    /记住/,
    /我喜欢/,
    /我不喜欢/,
  ]) && !asksRecall && !asksDetail && !wantsBeingRemembered;

  if (asksDetail) {
    return createLocalRoute({
      careNeed: sensitive ? 'sensitive' : 'ordinary',
      confidence: 0.78,
      keywords,
      mode: 'detail_recall',
      reason: sensitive ? '用户在追问敏感旧事的具体细节，需要谨慎回到细节。' : '用户在追问旧事的具体细节或原文。',
      topic: keywords[0] ?? '旧事细节',
    });
  }
  if (asksRecall) {
    return createLocalRoute({
      allowGentleMention: true,
      careNeed: sensitive ? 'sensitive' : 'ordinary',
      careIntensity: sensitive ? 0.78 : 0.25,
      confidence: 0.74,
      keywords,
      mode: 'recall',
      reason: sensitive ? '用户主动提起敏感旧事，适合召回但不要逼问。' : '用户在问之前提过的事。',
      topic: keywords[0] ?? '旧事',
    });
  }
  if (newFactSave) {
    return createLocalRoute({
      confidence: 0.64,
      keywords,
      reason: '用户像是在提供新事实，不是追问旧记忆。',
      topic: keywords[0] ?? '新事实',
    });
  }
  if (wantsBeingRemembered) {
    return createLocalRoute({
      allowGentleMention: true,
      careIntensity: 0.86,
      careNeed: 'needs_being_remembered',
      confidence: 0.72,
      keywords,
      reason: '用户表达想被记住，需要保留陪伴感而不是精准翻旧账。',
      topic: '想被记住',
    });
  }
  if (wantsCompanionship || lowEnergy || sensitive) {
    return createLocalRoute({
      allowGentleMention: wantsCompanionship || lowEnergy,
      careIntensity: sensitive ? 0.74 : lowEnergy ? 0.7 : 0.62,
      careNeed: sensitive ? 'sensitive' : wantsCompanionship ? 'needs_companionship' : 'low_energy',
      confidence: 0.68,
      keywords,
      reason: sensitive ? '用户提到敏感内容，需要温柔避雷。' : '用户更像需要陪伴和承接。',
      topic: sensitive ? (keywords[0] ?? '敏感旧事') : lowEnergy ? '低精力陪伴' : '想被陪伴',
    });
  }

  return createLocalRoute({
    confidence: 0.52,
    keywords,
    reason: '没有明显追问旧事，先按背景记忆处理。',
    topic: keywords[0] ?? '',
  });
}

function formatRecentMessages(messages: RecentRouteMessage[] = []) {
  return messages
    .filter((message) => (message.role === 'I' || message.role === 'you') && message.content.trim())
    .slice(-6)
    .map((message) => {
      const content = message.content.trim();
      const end = content.length > 220 && content.charCodeAt(219) >= 0xD800 && content.charCodeAt(219) <= 0xDBFF
        && content.charCodeAt(220) >= 0xDC00 && content.charCodeAt(220) <= 0xDFFF ? 219 : 220;
      return `${message.role}：${content.slice(0, end)}${content.length > 220 ? '（后文省略）' : ''}`;
    })
    .join('\n');
}

function buildRoutePrompt() {
  return `【顺着聊天想起以前】
I 会主动找找和 you 现在说的事有关的记忆，看看以前的经历、喜好或约定能不能帮 I 更理解 you 的话。
想确认细节时，I 再翻记忆正文，或找当时的原话。
找到的事只在合适时带进现在的话里，不必为了提起记忆硬搬旧事。
没查到的事，I 不能凭空补上。

I 顺着这段聊天，想想要不要翻记忆、想找什么，用 JSON 记下来。

JSON 格式：
{
  "mode": "background_only" | "recall" | "detail_recall",
  "topic": string,
  "keywords": string[]
}

mode：background_only：暂不追加查找；recall：查相关记忆；detail_recall：查相关记忆及原话片段。
topic：I 这次想查的主题；不查则填空字符串。
keywords：从聊天中提取有区分度的查找词，最多 5 个；没有则填空数组，不猜聊天里没有的事实。`;
}

export type MemoryRecallRouteResult = {
  route: MemoryRecallRoute | null;
  status: 'ready' | 'not_started' | 'failed' | 'timeout' | 'cancelled';
  reason?: string;
  startedAt: number;
  finishedAt: number;
};

export async function routeMemoryRecallWithAi(input: RouteMemoryRecallInput): Promise<MemoryRecallRoute | null> {
  return (await routeMemoryRecallWithAiDetailed(input)).route;
}

export async function routeMemoryRecallWithAiDetailed({
  apiKey,
  connection,
  recentMessages = [],
  signal,
  source = 'chat',
  userText,
  timeoutMs = ROUTE_TIMEOUT_MS,
}: RouteMemoryRecallInput & { timeoutMs?: number }): Promise<MemoryRecallRouteResult> {
  const startedAt = Date.now();
  const result = (status: MemoryRecallRouteResult['status'], reason?: string, route: MemoryRecallRoute | null = null): MemoryRecallRouteResult =>
    ({ route, status, reason, startedAt, finishedAt: Date.now() });
  const text = userText.trim();
  if (signal?.aborted) return result('cancelled', 'cancelled');
  if (!text) return result('not_started', 'empty_query');
  if (!apiKey.trim() || !connection.baseUrl.trim() || !connection.model.trim()) return result('not_started', 'configuration_missing');
  const recent = formatRecentMessages(recentMessages);
  // V4 defaults to thinking; this short routing budget is for the final JSON.
  const disableThinking = (connection.preset === 'deepseek' || /^https:\/\/api\.deepseek\.com(?:\/|$)/i.test(connection.baseUrl.trim()))
    && /^(?:deepseek-flash$|deepseek-v4(?:[.-]|$))/i.test(connection.model.trim());

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let stopped = false;
  let stop!: (status: 'timeout' | 'cancelled') => void;
  const stopPromise = new Promise<MemoryRecallRouteResult>((resolve) => {
    stop = (status) => {
      stopped = true;
      resolve(result(status, status));
      controller?.abort();
    };
  });
  const cancel = () => stop('cancelled');
  signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => stop('timeout'), Math.max(0, timeoutMs));
  let cacheMetric: ReturnType<typeof beginPromptCacheMetric> | undefined;
  try {
    return await Promise.race([stopPromise, (async () => {
      const requestUrl = `${connection.baseUrl.trim().replace(/\/+$/, '')}/chat/completions`;
      const request: RequestInit = {
        body: JSON.stringify({
          max_tokens: 360,
          ...(disableThinking ? { thinking: { type: 'disabled' } } : {}),
          messages: [
            { role: 'system', content: buildRoutePrompt() },
            {
              role: 'system',
              content: [
                '【本次查找的聊天资料】',
                `调用入口：${source}`,
                `当前 you 发言：${text}`,
                recent ? `最近对话片段：\n${recent}` : '',
              ].filter(Boolean).join('\n'),
            },
          ],
          model: connection.model.trim(),
          temperature: 0,
        }),
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        method: 'POST',
        signal: controller?.signal,
      };
      cacheMetric = beginPromptCacheMetric({ contextProfile: 'memory-organizer', contextSource: 'memory.recall-route', connection });
      const response = await fetch(requestUrl, request);
      if (stopped || signal?.aborted) return result('cancelled', 'cancelled');
      if (!response.ok) return result('failed', 'http_error');
      const json: unknown = await response.json();
      cacheMetric.recordUsage((json as { usage?: unknown } | null)?.usage);
      if (stopped || signal?.aborted) return result('cancelled', 'cancelled');
      if (!json || typeof json !== 'object' || !('choices' in json)
        || !Array.isArray(json.choices)) return result('failed', 'response_payload_invalid');
      const choice = json.choices[0];
      if (!choice || typeof choice !== 'object' || !choice.message || typeof choice.message !== 'object') {
        return result('failed', 'response_payload_invalid');
      }
      const { content, reasoning_content: reasoning } = choice.message;
      // Only fixed reason codes leave this function; never retain provider text.
      if (content != null && typeof content !== 'string') return result('failed', 'response_payload_invalid');
      if (!content?.trim()) return result('failed', choice.finish_reason === 'length' ? 'response_truncated'
        : typeof reasoning === 'string' && reasoning.trim() ? 'response_reasoning_only' : 'response_empty');
      const jsonText = extractJsonObject(content);
      if (!jsonText) return result('failed', choice.finish_reason === 'length' ? 'response_truncated' : 'route_json_missing');
      let parsed: unknown;
      try { parsed = JSON.parse(jsonText); }
      catch { return result('failed', choice.finish_reason === 'length' ? 'response_truncated' : 'route_json_invalid'); }
      const route = normalizeRoute(parsed, 'ai');
      return route ? result('ready', undefined, route) : result('failed', 'route_shape_invalid');
    })()]);
  } catch (error) {
    return result(signal?.aborted ? 'cancelled' : 'failed', signal?.aborted ? 'cancelled' : error instanceof SyntaxError ? 'parse_error' : 'network_error');
  } finally {
    cacheMetric?.finish();
    clearTimeout(timeout);
    signal?.removeEventListener('abort', cancel);
  }
}
