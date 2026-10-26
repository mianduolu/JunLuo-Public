// Fixed technical values only: exception messages, URLs and stacks stay out of diagnostics.
const TRANSPORT_ERROR_NAMES = new Set(['Error', 'TypeError', 'AbortError', 'TimeoutError', 'SyntaxError', 'AggregateError']);
const TRANSPORT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'ABORT_ERR', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ERR_NETWORK_CHANGED', 'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED', 'ERR_NAME_NOT_RESOLVED', 'ERR_TIMED_OUT']);
export function normalizeChatTransportErrorName(value: unknown): string | undefined {
  return typeof value === 'string' && TRANSPORT_ERROR_NAMES.has(value) ? value : undefined;
}
export function normalizeChatTransportErrorCode(value: unknown): string | undefined {
  return typeof value === 'string' && TRANSPORT_ERROR_CODES.has(value) ? value : undefined;
}
export function normalizeChatProviderRequestId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value)
    ? value : undefined;
}
export function getChatTransportErrorDetails(error: unknown) {
  try {
    const value = error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
    return { errorName: normalizeChatTransportErrorName(value?.name), errorCode: normalizeChatTransportErrorCode(value?.code),
      causeCode: normalizeChatTransportErrorCode(value?.cause?.code) };
  } catch { return {}; }
}

export type ChatCompletionTransportObservation = {
  headersReceivedAt?: number;
  providerRequestId?: string;
  firstContentAt?: number;
  responseCompletedAt?: number;
  responseChars?: number;
  httpStatus?: number;
};

// React Native's fetch resolves on XHR load, so it cannot observe partial replies.
// This remains a single non-streaming POST; only receipt progress is observed.
export function requestObservedChatCompletion(options: {
  url: string;
  body: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  onSend?: () => void;
  onProgress: (observation: ChatCompletionTransportObservation) => void;
}): Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const observation: ChatCompletionTransportObservation = {};
    let settled = false;
    const cleanup = () => options.signal.removeEventListener('abort', abort);
    const report = (completed = false) => {
      if (settled) return;
      if (xhr.readyState >= 2 && xhr.status > 0) {
        if (observation.headersReceivedAt === undefined) {
          try {
            for (const name of ['x-request-id', 'x-dashscope-request-id', 'request-id']) {
              const id = normalizeChatProviderRequestId(xhr.getResponseHeader?.(name));
              if (id) { observation.providerRequestId = id; break; }
            }
          } catch { /* Optional response metadata never changes receipt. */ }
        }
        observation.headersReceivedAt ??= Date.now();
        observation.httpStatus = xhr.status;
      }
      // Aborting can clear responseText. Keep the last observed count.
      // RN replaces responseText with its own error message before DONE/error.
      // Read DONE content only from onload, never from a failure event.
      if ((xhr.readyState === 3 || completed) && xhr.status > 0) {
        const count = xhr.responseText.length;
        observation.responseChars = Math.max(observation.responseChars ?? 0, count);
        if (count > 0) observation.firstContentAt ??= Date.now();
      }
      if (completed) observation.responseCompletedAt = Date.now();
      try { void Promise.resolve(options.onProgress({ ...observation })).catch(() => undefined); }
      catch { /* Diagnostics never change request behavior. */ }
    };
    const fail = (error: Error) => {
      if (settled) return;
      report();
      settled = true;
      cleanup();
      reject(error);
    };
    const abortError = () => Object.assign(new Error('Aborted'), { name: 'AbortError' });
    const abort = () => {
      report();
      xhr.abort();
      fail(abortError());
    };
    try {
      xhr.open('POST', options.url, true);
      xhr.responseType = 'text';
      for (const [name, value] of Object.entries(options.headers)) xhr.setRequestHeader(name, value);
      xhr.onreadystatechange = () => report();
      xhr.onprogress = () => report();
      xhr.onload = () => {
        if (settled) return;
        report(true);
        const text = xhr.responseText;
        const status = xhr.status;
        settled = true;
        cleanup();
        resolve({ ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text) as unknown });
      };
      xhr.onerror = () => fail(new TypeError('Network request failed'));
      xhr.onabort = () => fail(abortError());
      xhr.ontimeout = () => fail(abortError());
      options.signal.addEventListener('abort', abort);
      if (options.signal.aborted) fail(abortError());
      else {
        try { options.onSend?.(); } catch { /* Observation cannot block transport. */ }
        xhr.send(options.body);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new TypeError('Network request failed'));
    }
  });
}
