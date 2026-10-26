import type { AiConnection } from './types';

export const ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS = 120_000;

export function buildAssistantLifeShortJsonRequest(
  connection: AiConnection,
  temperature: number,
) {
  const isDeepSeekNonThinking = connection.preset === 'deepseek'
    && /^(?:deepseek-flash$|deepseek-v4(?:-|$))/i.test(connection.model.trim());
  return {
    max_tokens: 240,
    temperature,
    ...(isDeepSeekNonThinking ? { thinking: { type: 'disabled' as const } } : {}),
  };
}
