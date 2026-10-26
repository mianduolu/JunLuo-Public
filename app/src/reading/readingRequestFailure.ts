type ReadingFailureCode = 'transport' | 'timeout' | 'request-build' | 'response-json' | 'response-shape'
  | 'empty-content' | 'output-limit' | 'reasoning-only' | 'response-filtered' | 'response-refusal'
  | 'unexpected-tool-call' | 'response-error' | 'annotation-json' | 'annotation-shape' | 'annotation-empty' | `http-${number}`;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function count(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 9999999 ? value : -1;
}

/** Only bounded counters/enums survive; no response body, reasoning, URL or credentials. */
export function tagReadingResponseFailure(error: Error, code: ReadingFailureCode, payload: unknown, status: number, maxTokens: number) {
  const root = record(payload);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const choice = record(choices[0]); const message = record(choice.message);
  const finish = typeof choice.finish_reason === 'string' && ['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason)
    ? choice.finish_reason : choice.finish_reason == null ? 'missing' : 'other';
  const content = message.content;
  const kind = content === null ? 'null' : Array.isArray(content) ? 'parts'
    : typeof content === 'string' ? 'text' : content === undefined ? 'missing' : 'other';
  const diagnostic = `h=${count(status)};f=${finish};c=${count(choices.length)};k=${kind}`
    + `;r=${typeof message.reasoning_content === 'string' ? count(message.reasoning_content.length) : -1}`
    + `;o=${count(record(root.usage).completion_tokens)};m=${count(maxTokens)}`;
  return Object.assign(tagReadingRequestFailure(error, code), { readingResponseDiagnostic: diagnostic });
}

/** Read only the Chat Completions final content channel, never coerce objects or adopt thought text. */
export function readReadingResponseContent(payload: unknown, status: number, maxTokens: number): string {
  const root = record(payload);
  const fail = (code: ReadingFailureCode, message: string): never => {
    throw tagReadingResponseFailure(new Error(message), code, payload, status, maxTokens);
  };
  if (root.error != null) return fail('response-error', '阅读接口返回了错误，没有取得正文。');
  if (!Array.isArray(root.choices)) return fail('response-shape', '阅读接口返回格式无法识别，没有取得正文。');
  const choice = record(root.choices[0]); const message = record(choice.message);
  const content = message.content;
  let text = '';
  if (typeof content === 'string') text = content.trim();
  else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const value of content) {
      const part = record(value);
      if (typeof part.text !== 'string' || (part.type !== undefined && part.type !== 'text')) {
        return fail('response-shape', '阅读接口的正文分块格式无法识别。');
      }
      parts.push(part.text);
    }
    text = parts.join('').trim();
  } else if (content != null) return fail('response-shape', '阅读接口的正文格式无法识别。');
  // Keep a real body, even at the limit: the existing annotation parser decides whether it is usable.
  if (text) return text;
  if (choice.finish_reason === 'length') return fail('output-limit', '阅读输出已达到本次上限，但没有取得正文。');
  if (choice.finish_reason === 'content_filter') return fail('response-filtered', '阅读接口报告内容过滤，没有取得正文。');
  if (typeof message.refusal === 'string' && message.refusal.trim()) return fail('response-refusal', '阅读接口返回了拒绝标记，没有取得正文。');
  if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call'
    || (Array.isArray(message.tool_calls) && message.tool_calls.length) || message.function_call != null) {
    return fail('unexpected-tool-call', '阅读接口返回了工具调用，没有取得批注正文；未执行工具。');
  }
  if (typeof message.reasoning_content === 'string' && message.reasoning_content.trim()) {
    return fail('reasoning-only', '阅读接口只返回了思考内容，没有正式正文；未将思考内容保存为批注。');
  }
  return fail('empty-content', '阅读接口返回了空正文，原因暂时无法确认。');
}

/** Keep existing thrown messages for callers; persist only our bounded technical code, never provider text. */
export function tagReadingRequestFailure(error: unknown, code: ReadingFailureCode) {
  return Object.assign(error instanceof Error ? error : new Error('reading-request-failed'), { readingFailureCode: code });
}

export function readingRequestFailureMessage(error: unknown) {
  const code = error instanceof Error ? (error as Error & { readingFailureCode?: unknown }).readingFailureCode : undefined;
  if (typeof code !== 'string' || !/^(?:transport|timeout|request-build|response-json|response-shape|empty-content|output-limit|reasoning-only|response-filtered|response-refusal|unexpected-tool-call|response-error|annotation-json|annotation-shape|annotation-empty|http-[1-5]\d{2})$/.test(code)) return 'reading-request-failed:unknown';
  const diagnostic = (error as Error & { readingResponseDiagnostic?: unknown }).readingResponseDiagnostic;
  const valid = typeof diagnostic === 'string' && /^h=(-1|\d{1,7});f=(stop|length|content_filter|tool_calls|function_call|missing|other);c=(-1|\d{1,7});k=(null|parts|text|missing|other);r=(-1|\d{1,7});o=(-1|\d{1,7});m=(-1|\d{1,7})$/.test(diagnostic);
  return `reading-request-failed:${code}${valid ? `;${diagnostic}` : ''}`;
}
