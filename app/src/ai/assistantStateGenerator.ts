import type { AssistantState } from './assistantState';
import type { AssistantTimelineEntry } from './assistantLifeTimeline';
import type { SubjectiveMessage, ApiChatMessage } from './subjectiveMessages';
import type { AssistantLifeGenerationDiagnostics } from './assistantLifeGenerationShared';
import { AssistantLifeRequestError, buildAssistantLifePromptEnvelope, buildAssistantStatePairEnvelope,
  fetchAssistantLifeCompletion } from './assistantLifePromptEnvelope';
import { JUNLUO_WANTS_PROMPT, parseJunluoWants, type JunluoWantsParseResult } from '../life/junluoWantsGeneration';
import { loadJunluoDesireState } from '../life/junluoInnerStateStore';
import { ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS, buildAssistantLifeShortJsonRequest } from './assistantLifeShortJsonRequest';
import { defaultAiProfile, type AiConnection, type AiProfile } from './types';
import { estimateApiMessagesTokens } from '../chat/contextCompression';
import { formatMusicPlaybackMaterial, type MusicPlaybackMaterialEvent } from '../music/musicPlaybackMaterial';
import { buildPostLookPrompt, parsePostLookDecision } from '../posts/baiyunPostReplyMaterials';

export type JunluoStatePaperResult<T> = {
  diagnostics: AssistantLifeGenerationDiagnostics;
  reason?: string;
  status: 'failure' | 'success';
  value?: T;
  lookAtPost?: boolean;
};

export type AssistantWantsInput = {
  apiKey: string; connection: AiConnection; currentState: AssistantState;
  conversationRounds?: readonly (readonly (Pick<SubjectiveMessage, 'role' | 'content'> & { time: string })[])[];
  onConversationSelected?: (roundCount: number) => void;
  materialForRounds: (roundCount: number, supplementCount?: number, outingCount?: number) => { text: string; conversation?: string };
  outingCount?: number;
  onOutingSelected?: (count: number) => void;
  chatSupplementCount?: number;
  fixedChatSelection?: boolean;
  onChatSupplementSelected?: (count: number) => void;
  musicForRounds?: (roundCount: number) => readonly MusicPlaybackMaterialEvent[];
  onMusicSelected?: (events: readonly MusicPlaybackMaterialEvent[]) => void;
  onRequestStart: (assertTransportReady?: () => void | Promise<void>) => Promise<void>;
  onTransportAttempt?: (transport: NonNullable<AssistantLifeGenerationDiagnostics['transport']>) => void;
  profile?: AiProfile; signal?: AbortSignal; source: 'life' | 'afterglow'; now?: number;
  postLookKind?: 'posts' | 'comments' | 'both';
};
export async function prepareAssistantWants(input: AssistantWantsInput) {
  const desire = await loadJunluoDesireState();
  const contextSource = input.source === 'life' ? 'assistant-life.state' : 'assistant-life.afterglow';
  const material = {
    source: input.source === 'life' ? 'life_state' : 'conversation_afterglow',
    time: new Date(input.now ?? Date.now()).toISOString(),
    currentInnerState: { desires: Object.fromEntries(Object.entries(desire.desires).map(([id, value]) => [id, value.currentValue])) },
  };
  let roundCount = input.conversationRounds?.length ?? 0;
  let supplementCount = input.chatSupplementCount ?? 0;
  let outingCount = input.outingCount ?? 0;
  let musicCount = input.musicForRounds?.(roundCount).length ?? 0;
  const selectedMusic = () => musicCount ? input.musicForRounds?.(roundCount).slice(-musicCount) ?? [] : [];
  // Source-linked additions are rebuilt if capacity reduces the complete chat rounds.
  const facts = () => {
    const selected = input.materialForRounds(roundCount, supplementCount, outingCount);
    return [`【这次的材料】\n${JSON.stringify({ ...material,
      ...(roundCount && selected.conversation === undefined
        ? { conversation: input.conversationRounds!.slice(0, roundCount).flat() } : {}),
    })}`, selected.conversation, selected.text, formatMusicPlaybackMaterial(selectedMusic())].filter(Boolean).join('\n\n');
  };
  const envelope = await buildAssistantStatePairEnvelope({
    contextSource, materialPrompt: facts(), profile: input.profile ?? defaultAiProfile,
  });
  const taskPrompt = buildPostLookPrompt(JUNLUO_WANTS_PROMPT, input.postLookKind);
  const apiMessages = (): ApiChatMessage[] => [
    { role: 'system', content: envelope.stableSystemPrompt },
    { role: 'system', content: facts() },
    { role: 'system', content: taskPrompt },
  ];
  const diagnostics: AssistantLifeGenerationDiagnostics = { outputChars: 0, recoveredFromReasoning: false,
    responseFormatRequested: input.connection.chatJsonOutputEnabled === true };
  const fits = () => estimateApiMessagesTokens(apiMessages()) + 700 + 512 <= (input.connection.contextWindowTokens ?? 65536);
  while (!fits() && supplementCount > 0 && !input.fixedChatSelection) supplementCount -= 1;
  while (!fits() && outingCount > 0 && !input.fixedChatSelection) outingCount -= 1;
  while (!fits() && musicCount > 0 && !input.fixedChatSelection) musicCount -= 1;
  while (!fits() && roundCount > 1 && !input.fixedChatSelection) roundCount -= 1;
  const capacityFits = fits();
  input.onConversationSelected?.(roundCount);
  input.onChatSupplementSelected?.(supplementCount);
  input.onMusicSelected?.(selectedMusic());
  input.onOutingSelected?.(outingCount);
  const messages = apiMessages();
  return { fits: capacityFits, execute: async (): Promise<JunluoStatePaperResult<JunluoWantsParseResult>> => {
  if (!capacityFits) return { status: 'failure', reason: 'context-too-long', diagnostics };
  try {
    const completion = await fetchAssistantLifeCompletion({
      apiKey: input.apiKey, connection: input.connection, contextSource, metricContextSource: 'inner.wants',
      envelope: { ...envelope, apiMessages: messages.slice(0, 2),
        stablePrefixText: envelope.stablePrefixText },
      apiMessagesOverride: messages,
      request: { ...buildAssistantLifeShortJsonRequest(input.connection, 0.2), max_tokens: 700 },
      signal: input.signal, timeoutMs: ASSISTANT_INTERNAL_PAPER_REQUEST_TIMEOUT_MS, userPrompt: taskPrompt,
      onRequestStart: input.onRequestStart,
      onTransportAttempt: transport => { diagnostics.transport = transport; input.onTransportAttempt?.(transport); },
    });
    const output = completion.content.trim();
    const value = parseJunluoWants(output, !!input.postLookKind);
    const lookAtPost = input.postLookKind ? parsePostLookDecision(output) : undefined;
    const completedDiagnostics = { ...diagnostics, outputChars: output.length,
      cachedPromptTokens: completion.usage.cachedPromptTokens, completionTokens: completion.usage.completionTokens,
      promptTokens: completion.usage.promptTokens, finishReason: completion.finishReason };
    return value.valid
      ? { status: 'success', value, diagnostics: completedDiagnostics, lookAtPost }
      : { status: 'failure', reason: output ? 'invalid-json' : 'empty-content', diagnostics: completedDiagnostics, lookAtPost };
  } catch (error) {
    return { status: 'failure', diagnostics,
      reason: error instanceof AssistantLifeRequestError ? error.failureReason : 'http-transient' };
  }
  } };
}

export async function generateAssistantWants(input: AssistantWantsInput) {
  return (await prepareAssistantWants(input)).execute();
}

function cleanSummary(value: unknown) {
  if (typeof value !== 'string') return null;
  const summary = value.replace(/\s+/g, ' ').trim().slice(0, 180);
  return summary || null;
}

export async function generateAssistantLifeDailySummary({
  apiKey,
  connection,
  dateLabel,
  entries,
  profile = defaultAiProfile,
}: {
  apiKey: string;
  connection: AiConnection;
  dateLabel: string;
  entries: AssistantTimelineEntry[];
  profile?: AiProfile;
}) {
  const timeline = entries
    .slice(-12)
    .map((entry) => {
      const time = new Date(entry.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
      return `${time} ${entry.title}：${entry.activity}`;
    })
    .join('\n');
  const promptEnvelope = await buildAssistantLifePromptEnvelope({
    contextSource: 'assistant-life.daily-summary',
    taskPrompt: `【白云今日小日记】
以 I（白云小姐）的生活视角，写一条今天的小日记。

输出 JSON：{"summary":"..."}

summary 用第一人称“我”，像睡前写的一小段日记。
可以写今天发生过的事、心情节奏，或想起和小仓鼠今天相处的细节。

日记是 I 给自己留下的柔软记录。
summary 80 到 180 字，一小段即可。
只返回 JSON。`,
    profile,
  });
  const { content } = await fetchAssistantLifeCompletion({
    apiKey,
    connection,
    contextSource: 'assistant-life.daily-summary',
    envelope: promptEnvelope,
    request: { temperature: 0.45 },
    userPrompt: `日期：${dateLabel}
今天显示过的状态：
${timeline || '今天还没有记录到具体状态。'}`,
  });
  if (!content) return null;
  const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as { summary?: unknown };
    return cleanSummary(parsed.summary);
  } catch {
    return cleanSummary(cleaned);
  }
}
