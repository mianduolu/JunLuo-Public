export type MemoryProcessingErrorClassification = {
  code: string;
  kind: 'blocked' | 'retry';
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

export function classifyMemoryProcessingError(
  error: unknown,
): MemoryProcessingErrorClassification {
  const message = errorMessage(error);
  if (message === 'memory-automatic-disabled') return { code: 'automatic_disabled', kind: 'blocked' };
  if (/http-(401|403)|unauthorized|forbidden|invalid[_ -]?key/.test(message)) {
    return { code: 'provider_auth', kind: 'blocked' };
  }
  if (/http-404|model.*not.*found|invalid.*model/.test(message)) {
    return { code: 'provider_model', kind: 'blocked' };
  }
  if (/abort|timeout/.test(message)) {
    return { code: 'network_timeout', kind: 'retry' };
  }
  const status = message.match(/http-(\d{3})/)?.[1];
  if (status === '429') return { code: 'provider_rate_limit', kind: 'retry' };
  if (status && Number(status) >= 500) return { code: 'provider_unavailable', kind: 'retry' };
  if (/network|fetch|connection|socket|econn/.test(message)) {
    return { code: 'network_unavailable', kind: 'retry' };
  }
  if (/database.*(busy|locked)|sqlite.*(busy|locked)/.test(message)) {
    return { code: 'database_busy', kind: 'retry' };
  }
  if (/empty|json|parse|response/.test(message)) {
    return { code: 'provider_invalid_response', kind: 'retry' };
  }
  return { code: 'processing_error', kind: 'retry' };
}
