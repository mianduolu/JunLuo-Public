import {
  buildChatCompletionPromptEnvelope,
  insertContinuationMessages,
  mapContinuationMessages,
  type ChatCompletionPromptEnvelopeOptions,
  type ChatOptions,
  type OpenAiCompatibleRequestMessage,
} from '../ai/openAiCompatibleProvider';
import { estimateApiMessagesTokens, estimateTextTokens, getReplyTokenReserve } from '../chat/contextCompression';
import { toolDefinitionToOpenAiTool } from '../tools/toolCallProtocol';
import { projectWishPackageTools } from '../wishPool/wishPackageToolProtocol';

export type BackstageCapacityInput = ChatCompletionPromptEnvelopeOptions & Pick<
  ChatOptions,
  | 'tools'
  | 'toolMode'
  | 'strictTools'
  | 'wishPackageEntry'
  | 'continuationMessages'
  | 'semanticPrefixCompletionMode'
  | 'prefixWithTools'
> & { preparedCompiledPrompt: NonNullable<ChatCompletionPromptEnvelopeOptions['preparedCompiledPrompt']> };

export type TheaterBackstageCapacityResult = {
  fits: boolean;
  promptTokens: number;
  totalTokens: number;
  limit: number;
  replyTokenReserve: number;
  requestOverheadTokens: number;
  apiMessages: OpenAiCompatibleRequestMessage[];
};

/** Offline preparation only. The caller supplies the full current context and an approved card.
 * This result applies to this input snapshot; chapter 13 must check the actual send again. */
export async function checkBackstageCapacity(
  input: BackstageCapacityInput,
  card: string,
): Promise<TheaterBackstageCapacityResult> {
  // The provider's default ambient builder can refresh weather; offline callers must prepare it.
  if (input.ambientContext === undefined) throw new Error('BACKSTAGE_AMBIENT_CONTEXT_REQUIRED');
  if (!input.preparedCompiledPrompt) throw new Error('BACKSTAGE_COMPILED_PROMPT_REQUIRED');
  const continuation = input.continuationMessages ?? [];
  const toolRequestEnabled = input.toolMode === 'openai-tools' && Boolean(input.tools?.length);
  const openAiTools = toolRequestEnabled
    ? (input.wishPackageEntry ? projectWishPackageTools(input.tools!) : input.tools!).map(tool => toolDefinitionToOpenAiTool(tool, { strict: input.strictTools ?? false }))
    : undefined;
  const requestOverheadTokens = (openAiTools ? estimateTextTokens(JSON.stringify(openAiTools)) : 0)
    + (continuation.length ? estimateTextTokens(JSON.stringify(mapContinuationMessages(continuation))) : 0);
  // Reuse the request's compiled snapshot: its default loader can migrate old local state.
  // Chapter 13 supplies this snapshot from the same request, not a separate preparation build.
  // Never rebuild a smaller chat to fit the card.
  const envelope = await buildChatCompletionPromptEnvelope({
    ...input,
    preambleMessages: [...(input.preambleMessages ?? []), { role: 'system', content: card }],
    musicRequestOverheadTokens: Math.max(input.musicRequestOverheadTokens ?? 0, requestOverheadTokens),
  });
  const baseMessages = envelope.apiMessages.filter(message => !(
    message.prefix && (input.semanticPrefixCompletionMode === 'disabled'
      || (toolRequestEnabled && !input.prefixWithTools))
  ));
  const apiMessages = insertContinuationMessages(baseMessages, continuation);
  // The adapted continuation JSON includes reasoning, tool calls and receipts. Counting only
  // message.content loses those fields. Keep the provider's conservative overhead calculation.
  const promptTokens = estimateApiMessagesTokens(baseMessages) + requestOverheadTokens;
  const replyTokenReserve = getReplyTokenReserve(input.connection);
  const totalTokens = promptTokens + replyTokenReserve + 512;
  const limit = input.connection.contextWindowTokens ?? 65536;
  return { fits: totalTokens <= limit, promptTokens, totalTokens, limit,
    replyTokenReserve, requestOverheadTokens, apiMessages };
}
