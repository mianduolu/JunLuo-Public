/** Scheduling record in the existing post runtime, never model input. */
export type PostMemoryRuntimeState = {
  version: 1;
  automaticDay?: string;
  requestId?: string;
  cachedBatchId?: string;
  status?: 'waiting_review' | 'before_evening' | 'empty' | 'configuration' | 'disabled' | 'budget' | 'running' | 'failed' | 'ready' | 'long_sentence' | 'needs_recheck';
  error?: string;
  retryAt?: number;
};

export function parsePostMemoryRuntimeState(value: unknown): PostMemoryRuntimeState | undefined {
  if (value === undefined) return undefined;
  const item = value as PostMemoryRuntimeState;
  if (!item || item.version !== 1
    || (item.automaticDay !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(item.automaticDay))
    || ['requestId', 'cachedBatchId', 'error'].some(key => item[key as keyof PostMemoryRuntimeState] !== undefined
      && typeof item[key as keyof PostMemoryRuntimeState] !== 'string')
    || (item.retryAt !== undefined && !Number.isFinite(item.retryAt))
    || (item.status !== undefined && !['waiting_review', 'before_evening', 'empty', 'configuration', 'disabled', 'budget', 'running', 'failed', 'ready', 'long_sentence', 'needs_recheck'].includes(item.status))) {
    throw new Error('baiyun-post-memory-state-invalid');
  }
  return item;
}
