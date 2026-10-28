export type ConnectionPromptCacheMode = 'server-default' | 'ephemeral-first-system';

// Call once after the existing string-based preflight checks.
// The caller supplies its already serialized request; no request is dispatched here.
export function applyConnectionPromptCacheToRequestBody(
  body: string,
  mode?: ConnectionPromptCacheMode,
): string {
  if (mode !== 'ephemeral-first-system') return body;
  const request = JSON.parse(body) as { messages?: Array<Record<string, unknown>> };
  if (!Array.isArray(request.messages)) return body;
  const index = request.messages.findIndex(message => message?.role === 'system');
  if (index < 0) return body;
  const message = request.messages[index];
  if (typeof message.content !== 'string' || !message.content.trim()) return body;
  const messages = request.messages.map((entry, current) => current === index ? {
    ...entry,
    content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }],
  } : entry);
  return JSON.stringify({ ...request, messages });
}
