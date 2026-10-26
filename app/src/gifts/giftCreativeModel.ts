import { digestStringAsync, CryptoDigestAlgorithm } from 'expo-crypto';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { loadAssistantState } from '../ai/assistantState';
import { compilePersonaPromptResult, replaceCompiledMemoryContext } from '../ai/persona/promptCompiler';
import { SUBJECTIVE_IDENTITY_PROTOCOL } from '../ai/subjectiveMessages';
import { requestGiftCreation, type GiftCreationResponse } from '../ai/giftCreationRequest';
import { buildChatMemoryBundle } from '../memory/memoryOrchestrator';
import { loadChatSessionSnapshot } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { loadJunluoDesireSnapshot } from '../life/junluoDesireRuntime';
import { loadJunluoDesireState, loadJunluoThoughtState } from '../life/junluoInnerStateStore';
import { listGiftViews } from './giftStore';
import { giftToolPackage } from '../tools/builtin/giftTools';
import type { GiftCreativeRun } from './giftCreativeStore';

/** Approved in docs/礼物柜第七章准备与赠送审稿.md, 2026-10-17. */
export const GIFT_CREATIVE_PROMPT = `【想送给 you 的礼物】
I 看看自己现在有没有想为 you 准备的礼物，也看看已有的准备是否想继续。

I 自己决定做什么、做到哪一步。I 用礼物工具保存想法、制作内容或送出礼物。`;
const stamp = (value: unknown) => digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(value));

export async function loadGiftCreativeContext(now: number) {
  const [config, assistant, effective, desire, thoughts, chat, views] = await Promise.all([
    loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 }), loadAssistantState(),
    loadJunluoDesireSnapshot(now, true), loadJunluoDesireState(true), loadJunluoThoughtState(),
    loadChatSessionSnapshot(PRIMARY_CHAT_SESSION_ID, { messageLimit: 30 }), listGiftViews('I'),
  ]);
  const thought = thoughts.thoughts.filter(value => value.desireId === 'own_time'
    && ['flit', 'fixation', 'unfulfilled_candidate'].includes(value.state))
    .sort((a, b) => b.lastTransition.occurredAt - a.lastTransition.occurredAt || a.thoughtId.localeCompare(b.thoughtId))[0];
  const source = { visible: effective.selectedIds.includes('own_time') && effective.desires.own_time.effectiveValue > 0,
    wantOperationId: desire.desires.own_time.lastValueChange?.operationId ?? null,
    thought: thought ? { thoughtId: thought.thoughtId, transitionOperationId: thought.lastTransition.operationId } : null };
  const messages = [] as Array<{ id: string; subject: 'I' | 'you'; content: string; createdAt: number }>;
  let size = 0;
  for (const line of [...(chat?.session.messages ?? [])].reverse()) {
    if (!['I', 'you'].includes(line.role) || !line.content?.trim()) continue;
    if (messages.length >= 30 || size + line.content.length > 12_000) break;
    messages.unshift({ id: line.id, subject: line.role as 'I' | 'you', content: line.content, createdAt: line.createdAt });
    size += line.content.length;
  }
  const preparations = views.filter(view => view.revealed && view.gift.sender === 'I'
    && ['draft', 'withdrawn', 'scheduled'].includes(view.gift.deliveryStatus));
  const gifts: typeof preparations = [];
  let preparationSize = 0;
  for (const view of preparations) {
    const size = JSON.stringify(view.gift).length;
    if (gifts.length >= 20 || preparationSize + size > 8000) break;
    gifts.push(view); preparationSize += size;
  }
  const connection = resolveLifeCreativeConfig(config);
  return { config, connection, assistant, effective, desire, source, messages, gifts, totalGiftPreparations: preparations.length,
    sourceStamp: await stamp(source), historyStamp: await stamp(messages),
    configStamp: await stamp({ connection, profile: config.profile }) };
}
export type GiftCreativeContext = Awaited<ReturnType<typeof loadGiftCreativeContext>>;

export async function prepareGiftCreativeCall(context: GiftCreativeContext, run: GiftCreativeRun, now: number) {
  const { connection, apiKey } = context.connection;
  if (!connection || connection.provider !== 'openai-compatible' || !connection.model.trim()
    || !connection.baseUrl.trim() || !apiKey.trim()) throw Error('gift-creation-request-config');
  const preparation = context.gifts.filter(view => view.revealed).map(view => view.gift);
  const query = [...context.messages.map(line => line.content), ...preparation.flatMap(gift => [gift.title, gift.note])].join('\n');
  const memories = await buildChatMemoryBundle({ userText: query, sourceHints: '', activeContext: '' }, {
    source: 'letter', readOnly: true, includeCurrentStates: false, useSemanticMemory: false, allowRerank: false, touch: false,
  });
  let compiled = await compilePersonaPromptResult({ readOnly: true, profile: context.config.profile,
    contextProfile: 'chat-full', outputAudience: 'private_visible_text', conversationText: query, memoryContext: memories.context });
  let facts = context;
  const systemMessages: string[] = [];
  const assemble = () => systemMessages.splice(0, systemMessages.length,
    [SUBJECTIVE_IDENTITY_PROTOCOL, compiled.stablePrompt].filter(Boolean).join('\n\n'),
    ...(compiled.dynamicPrompt ? [compiled.dynamicPrompt] : []),
    GIFT_CREATIVE_PROMPT + '\n\n【这次准备的时间与状态】\n' + JSON.stringify({ now: new Date(Date.now()).toISOString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, lifeMode: facts.assistant.lifeMode,
      wants: Object.entries(facts.desire.desires).map(([id, value]) => ({ id, currentValue: value.currentValue })) })
      + '\n\n【I 已经准备的礼物】\n' + JSON.stringify({ gifts: preparation.map(gift => ({ id: gift.id,
        title: gift.title, note: gift.note, deliveryStatus: gift.deliveryStatus, updatedAt: new Date(gift.updatedAt).toISOString(),
        scheduledAt: gift.scheduledAt === null ? null : new Date(gift.scheduledAt).toISOString(), scheduledTimeZone: gift.scheduledTimeZone,
        attachments: gift.attachments.map(item => ({ attachmentId: item.id, kind: item.kind,
          ...(item.kind === 'url' ? {} : { name: item.original.originalName }) })) })), total: context.totalGiftPreparations }));
  assemble();
  return { connection, async request(beforeTransport: (assertReady: () => Promise<void>) => Promise<void>,
    onResult: (value: GiftCreationResponse) => void) {
    return requestGiftCreation({ connection, apiKey, systemMessages, messages: context.messages,
      continuation: run.continuation, tools: run.callCount >= 4 ? [] : giftToolPackage.tools,
      async beforeRequest() {
        await memories.refreshMemoryMaterials?.(); compiled = replaceCompiledMemoryContext(compiled, memories.context); assemble();
        await beforeTransport(async () => {
          const current = await loadGiftCreativeContext(Date.now());
          if (current.configStamp !== context.configStamp || current.sourceStamp !== context.sourceStamp
            || current.historyStamp !== context.historyStamp || current.totalGiftPreparations !== context.totalGiftPreparations
            || JSON.stringify(current.gifts) !== JSON.stringify(context.gifts)) throw Error('gift-creative-source-changed');
          facts = current; assemble();
        });
      }, onResult });
  } };
}
