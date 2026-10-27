import {
  cleanAssistantMessageContent,
  parseAssistantMessageBubbles,
} from '../ai/subjectiveMessages';
import { extractVisibleReplyFromRaw } from '../ai/visibleReplyExtraction';

export const COMPLETE_PROACTIVE_END_PATTERN =
  /(?:[。！？!?…~～]|[）)】」』”’]|uwu|ovo|\^\^|T\s*T|\p{Extended_Pictographic}\uFE0F?)$/iu;
export const UNSUPPORTED_USER_ACTION_CLAIM_PATTERN =
  /(?:你|小仓鼠|鼠)(?:刚刚|刚才|之前|曾经|已经|截过|发过|评论过|发布过|回复过|收藏过|点赞过|转发过|分享过|给我看过|让我看过|给我发过|发给我).{0,24}(?:截图|截屏|帖子|笔记|评论|草稿|图片|链接|小红书|AI写作|风险)|(?:看到|看见|发现).{0,12}(?:你|小仓鼠|鼠).{0,24}(?:截过|发过|评论过|发布过|回复过|分享过)/;
export const EXTERNAL_ACTION_COMPLETION_CLAIM_PATTERN =
  /(?:(?:我|白云小姐|云云)?(?:刚刚|刚才|这次|今天|方才).{0,12}(?:搜到|搜索到|看到|看见|刷到|读到|翻到|找到|查到).{0,28}(?:帖子|笔记|评论|小红书|微博|网页|文章|资料|AI写作|风险)|(?:我|白云小姐|云云).{0,16}(?:去)?(?:小红书|微博|网上|外面|人间).{0,18}(?:搜了|搜索了|看了|刷了|读了|翻了|逛了|看见|看到))/;

export type ProactiveLiteNormalizationDiagnostics = {
  rawMessageCount: number;
  keptMessageCount: number;
  reasons: string[];
};

export type ProactiveLiteParseResult = ProactiveLiteNormalizationDiagnostics & {
  messages: string[];
  rawContentChars: number;
};




export function formatProactiveIdleDuration(durationMs: number) {
  const minutes = Math.max(1, Math.round(durationMs / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`;
}


export function normalizeProactiveLiteMessages(
  messages: string[],
  options: { allowExternalActionClaims?: boolean; maxChars?: number; maxMessages?: number } = {},
) {
  return normalizeProactiveLiteMessagesWithDiagnostics(messages, options).messages;
}

export function normalizeProactiveLiteMessagesWithDiagnostics(
  messages: string[],
  options: { allowExternalActionClaims?: boolean; maxChars?: number; maxMessages?: number } = {},
): { messages: string[]; diagnostics: ProactiveLiteNormalizationDiagnostics } {
  const reasonSet = new Set<string>();
  const accepted = messages
    .map((raw) => ({
      clean: cleanAssistantMessageContent(raw).trim(),
      raw: raw.trim(),
    }))
    .filter(({ clean, raw }) => {
      const reasons: string[] = [];
      if (!clean) reasons.push('清洗为空');
      if (
        !options.allowExternalActionClaims &&
        (EXTERNAL_ACTION_COMPLETION_CLAIM_PATTERN.test(clean) || EXTERNAL_ACTION_COMPLETION_CLAIM_PATTERN.test(raw))
      ) {
        reasons.push('外部动作完成声称');
      }
      reasons.forEach((reason) => reasonSet.add(reason));
      return reasons.length === 0;
    })
    .map(({ clean }) => clean);
  return {
    diagnostics: {
      rawMessageCount: messages.length,
      keptMessageCount: accepted.length,
      reasons: [...reasonSet],
    },
    messages: accepted,
  };
}

export function parseOrdinaryProactiveLiteResponse(content: string) {
  return parseOrdinaryProactiveLiteResponseWithDiagnostics(content).messages;
}

/** Complete visible structure only; never adopts internal fields or tool calls. */
export function extractCompleteProactiveLiteMessages(content: string): string[] | null {
  const visible = extractVisibleReplyFromRaw({
    raw: content.trim()
      .replace(/^`+(?:json)?\s*/iu, '')
      .replace(/\s*`+$/u, ''),
    allowPlainText: false,
    expectedStructure: 'single_root_json',
  });
  return visible.status === 'visible' ? visible.messages : null;
}

export function recoverCompleteProactiveLiteResponse(
  content: string,
  options: { allowExternalActionClaims?: boolean } = {},
): ProactiveLiteParseResult | null {
  const messages = extractCompleteProactiveLiteMessages(content);
  if (!messages) return null;
  const result = normalizeProactiveLiteMessagesWithDiagnostics(messages, options);
  return { ...result.diagnostics, messages: result.messages, rawContentChars: content.length };
}

export function parseOrdinaryProactiveLiteResponseWithDiagnostics(
  content: string,
  options: { allowExternalActionClaims?: boolean } = {},
): ProactiveLiteParseResult {
  const raw = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const parsed = JSON.parse(raw) as { message?: unknown; messages?: unknown };
    if (Array.isArray(parsed) || typeof parsed === 'string') {
      // The root is already parsed JSON: reuse strict array normalization, not loose legacy-tag recovery.
      const visible = extractVisibleReplyFromRaw({ raw: typeof parsed === 'string' ? JSON.stringify([parsed]) : raw,
        allowPlainText: false, expectedStructure: 'single_root_json' });
      const result = normalizeProactiveLiteMessagesWithDiagnostics(visible.status === 'visible' ? visible.messages : [], options);
      return { ...result.diagnostics, messages: result.messages, rawContentChars: content.length };
    }
    if (typeof parsed.message === 'string') {
      const result = normalizeProactiveLiteMessagesWithDiagnostics([parsed.message], options);
      return { ...result.diagnostics, messages: result.messages, rawContentChars: content.length };
    }
    const parsedMessages = Array.isArray(parsed.messages)
      ? parsed.messages.filter((message): message is string => typeof message === 'string')
      : [];
    const result = normalizeProactiveLiteMessagesWithDiagnostics(parsedMessages, options);
    return { ...result.diagnostics, messages: result.messages, rawContentChars: content.length };
  } catch {
    const recovered = recoverCompleteProactiveLiteResponse(content, options);
    if (recovered) return { ...recovered, reasons: recovered.reasons.length
      ? recovered.reasons : ['JSON 解析失败，已保留完整正文'] };
    const parsedMessages = parseAssistantMessageBubbles(content);
    const result = normalizeProactiveLiteMessagesWithDiagnostics(parsedMessages, options);
    return {
      ...result.diagnostics,
      messages: result.messages,
      rawContentChars: content.length,
      reasons: result.diagnostics.reasons.length ? result.diagnostics.reasons : ['JSON 解析失败，已尝试按气泡恢复'],
    };
  }
}

