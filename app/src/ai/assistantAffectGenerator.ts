import type { AssistantState } from './assistantState';
import type { AiConnection, AiProfile } from './types';
import { defaultAiProfile } from './types';
import { AssistantLifeRequestError, buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from './assistantLifePromptEnvelope';
import { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS, buildAssistantLifeShortJsonRequest } from './assistantLifeShortJsonRequest';
import { estimateApiMessagesTokens } from '../chat/contextCompression';
import { formatChatAfterglowConversation, formatChatAfterglowMessageTime, type ChatAfterglowMessage } from '../chat/chatAfterglowProbe';
import type { PokeInteraction } from '../chat/chatPokeExperience';
import { loadJunluoAffectState } from '../life/junluoInnerStateStore';
import { ASSISTANT_AFFECT_PROMPT, formatPreviousAffect, parseAssistantAffect, type AssistantAffectParseResult } from './assistantAffectPaper';
import type { JunluoStatePaperResult } from './assistantStateGenerator';
import { formatMusicPlaybackMaterial, type MusicPlaybackMaterialEvent } from '../music/musicPlaybackMaterial';
import { formatContactWaiting, type ContactWaiting } from '../proactive/contactWaiting';

export type AssistantAffectInput = {
  contactWaiting?: ContactWaiting;
  apiKey: string; connection: AiConnection; profile?: AiProfile; currentState: AssistantState;
  now: number; messages: readonly ChatAfterglowMessage[]; lifeMaterial: string;
  pokeFacts?: readonly PokeInteraction[];
  music?: readonly MusicPlaybackMaterialEvent[];
  onMusicSelected?: (events: readonly MusicPlaybackMaterialEvent[]) => void;
  onRequestStart: (assertTransportReady?: () => void | Promise<void>) => Promise<void>; signal?: AbortSignal;
  onTransportAttempt?: (transport: import('./assistantLifeGenerationShared').AssistantLifeTransportDiagnostic) => void;
};
export async function prepareAssistantAffect(input: AssistantAffectInput) {
  const affect = await loadJunluoAffectState();
  const time = formatChatAfterglowMessageTime;
  let music = input.music ?? [];
  const material = () => [
    `【此刻】\n\n现在：${time(input.now)}\nI 当前的作息状态：${{ available: '日常', 'self-time': '自处', sleeping: '睡眠' }[input.currentState.lifeMode]}`,
    formatContactWaiting(input.contactWaiting, input.now),
    input.messages.length || input.pokeFacts?.length
      ? `【最近和 you 聊过的话】\n\n${formatChatAfterglowConversation(input.messages, input.pokeFacts)}` : '',
    input.lifeMaterial, formatPreviousAffect(affect), formatMusicPlaybackMaterial(music),
  ].filter(Boolean).join('\n\n');
  const contextSource = input.messages.length ? 'assistant-life.afterglow' : 'assistant-life.state';
  const envelope = await buildAssistantStatePairEnvelope({ contextSource, materialPrompt: material(), profile: input.profile ?? defaultAiProfile });
  const apiMessages = () => [
    { role: 'system' as const, content: envelope.stableSystemPrompt },
    { role: 'system' as const, content: ASSISTANT_AFFECT_PROMPT },
    { role: 'system' as const, content: material() },
  ];
  const diagnostics: import('./assistantLifeGenerationShared').AssistantLifeGenerationDiagnostics = { outputChars: 0, recoveredFromReasoning: false, responseFormatRequested: input.connection.chatJsonOutputEnabled === true };
  const capacityFits = () => estimateApiMessagesTokens(apiMessages()) + 900 + 512 <= (input.connection.contextWindowTokens ?? 65536);
  while (!capacityFits() && music.length) music = music.slice(1);
  const fits = capacityFits();
  input.onMusicSelected?.(music);
  const messages = apiMessages();
  return { fits, execute: async (): Promise<JunluoStatePaperResult<AssistantAffectParseResult>> => {
  if (!fits)
    return { status: 'failure', reason: 'context-too-long', diagnostics };
  try {
    const completion = await fetchAssistantLifeCompletion({
      apiKey: input.apiKey, connection: input.connection, contextSource, metricContextSource: 'inner.affect',
      envelope: { ...envelope, apiMessages: messages.slice(0, 2), stablePrefixText: envelope.stablePrefixText },
      apiMessagesOverride: messages, request: { ...buildAssistantLifeShortJsonRequest(input.connection, 0.2), max_tokens: 900 },
      signal: input.signal, timeoutMs: ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS, userPrompt: ASSISTANT_AFFECT_PROMPT, onRequestStart: input.onRequestStart,
      onTransportAttempt: transport => { diagnostics.transport = transport; input.onTransportAttempt?.(transport); },
    });
    const text = completion.content.trim();
    const value = parseAssistantAffect(text);
    const complete = { ...diagnostics, outputChars: text.length, cachedPromptTokens: completion.usage.cachedPromptTokens,
      completionTokens: completion.usage.completionTokens, promptTokens: completion.usage.promptTokens, finishReason: completion.finishReason };
    return value.valid ? { status: 'success', value, diagnostics: complete }
      : { status: 'failure', reason: text ? 'invalid-json' : 'empty-content', diagnostics: complete };
  } catch (error) {
    return { status: 'failure', diagnostics, reason: error instanceof AssistantLifeRequestError ? error.failureReason : 'http-transient' };
  }
  } };
}

export async function generateAssistantAffect(input: AssistantAffectInput) {
  return (await prepareAssistantAffect(input)).execute();
}
