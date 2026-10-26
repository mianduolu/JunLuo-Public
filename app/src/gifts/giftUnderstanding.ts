import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { audioInputAdapterFor } from '../ai/audioInputCompatibility';
import { buildChatMemoryBundle } from '../memory/memoryOrchestrator';
import { compilePersonaPromptResult, replaceCompiledMemoryContext } from '../ai/persona/promptCompiler';
import { SUBJECTIVE_IDENTITY_PROTOCOL } from '../ai/subjectiveMessages';
import { requestGiftOriginalUnderstanding } from '../ai/giftOriginalUnderstandingRequest';
import { currentGiftUnderstandingSource, readGiftOriginalMedia } from './giftOriginalMedia';
import type { GiftRecord, GiftWorkToken } from './giftTypes';

export type GiftOriginalUnderstandingResult = {
  subject: 'I'; token: GiftWorkToken; attachmentId: string; kind: 'audio' | 'image'; content: string; understoodAt: number;
};

/** Approved verbatim: docs/礼物柜第四章原件理解审稿.md, 2026-10-16. */
export const GIFT_ORIGINAL_UNDERSTANDING_PROMPT = `【接住礼物】
I 正在读 you 送来的礼物原件。I 结合此刻的关系、相关记忆和这次实际收到的内容，直接向 you 说出自己的感受。

音频里，I 留意旋律、节奏、音色、演唱或演奏，以及让自己在意的声音细节；图片里，I 留意实际看见的内容。

礼物记录里的标题和留言是 you 提供的信息。I 依据原件判断听见、看见了什么，分清已确认的内容与自己的猜想；认不出的曲名、歌手或声音来源，就自然保留这份不确定。

I 这次接触的原件由下方记录标明，其他原件留待实际读到时再回应。

I 用自然的正文回应 you。`;

export function giftUnderstandingMaterial(gift: GiftRecord, attachmentId: string) {
  return `【本次礼物记录】\n${JSON.stringify({
    sender: gift.sender,
    title: gift.title,
    note: gift.note,
    deliveredAt: new Date(gift.deliveredAt!).toISOString(),
    openedAt: new Date(gift.openedAt!).toISOString(),
    attachments: gift.attachments.map((attachment, index) => ({
      position: index + 1,
      kind: attachment.kind,
      ...(attachment.kind !== 'url' ? { originalName: attachment.original.originalName } : {}),
      providedThisRequest: attachment.id === attachmentId,
    })),
  }, null, 2)}`;
}

/** One original, after I's real opening decision. Chapters 5/6 own invocation,
 * delivery and durable replies; this service never opens, plays or sends a gift.
 */
export async function understandGiftOriginal(sourceToken: GiftWorkToken, attachmentId: string, options: {
  signal?: AbortSignal;
  beforeRequest?: (assertReady?: () => Promise<void>) => Promise<void>;
  onResult?: (result: GiftOriginalUnderstandingResult) => void;
} = {}) {
  const token = { ...sourceToken };
  const assertActive = () => { if (options.signal?.aborted) throw Error('gift-understanding-aborted'); };
  assertActive();
  const source = await currentGiftUnderstandingSource(token, attachmentId);
  const config = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
  const audio = source.attachment.kind === 'audio';
  const connection = audio ? config.audioUnderstandingConnection : config.visionConnection;
  const apiKey = audio ? config.audioUnderstandingKey : config.visionKey;
  if (!connection || !connection.baseUrl.trim() || !connection.model.trim() || !apiKey?.trim()) {
    throw Error(audio ? 'gift-audio-connection-unavailable' : 'gift-image-connection-unavailable');
  }
  assertActive();
  const original = await readGiftOriginalMedia(token, attachmentId, audioInputAdapterFor(connection));
  assertActive();
  const query = [original.gift.title, original.gift.note].filter(Boolean).join('\n');
  const memories = await buildChatMemoryBundle({ userText: query, sourceHints: '', activeContext: '' }, {
    source: 'letter', readOnly: true, includeCurrentStates: false,
    useSemanticMemory: false, allowRerank: false, touch: false, signal: options.signal,
  });
  let compiled = await compilePersonaPromptResult({
    readOnly: true, profile: config.profile, contextProfile: 'chat-full',
    outputAudience: 'private_visible_text', conversationText: query, memoryContext: memories.context,
  });
  const systemMessages: string[] = [];
  const assemble = () => {
    systemMessages.splice(0, systemMessages.length,
      [SUBJECTIVE_IDENTITY_PROTOCOL, compiled.stablePrompt].filter(Boolean).join('\n\n'),
      ...(compiled.dynamicPrompt ? [compiled.dynamicPrompt] : []),
      `${GIFT_ORIGINAL_UNDERSTANDING_PROMPT}\n\n${giftUnderstandingMaterial(original.gift, attachmentId)}`);
  };
  assemble();
  const position = original.gift.attachments.findIndex(item => item.id === attachmentId) + 1;
  const media = audio ? {
    type: 'input_audio' as const,
    input_audio: { data: audioInputAdapterFor(connection) === 'qwen-omni'
      ? `data:;base64,${original.base64}` : original.base64, format: original.format! },
  } : { type: 'image_url' as const,
    image_url: { url: `data:${original.attachment.original.mimeType};base64,${original.base64}` } };
  const content = await requestGiftOriginalUnderstanding({
    apiKey, connection, systemMessages, kind: audio ? 'audio' : 'image', signal: options.signal,
    material: { role: 'you', content: [{ type: 'text', text: `礼物第 ${position} 件原件` }, media] },
    beforeRequest: async () => {
      assertActive();
      await memories.refreshMemoryMaterials?.();
      compiled = replaceCompiledMemoryContext(compiled, memories.context);
      assemble();
      let checked = false;
      const assertReady = async () => {
        const latest = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 });
        const latestConnection = audio ? latest.audioUnderstandingConnection : latest.visionConnection;
        const latestKey = audio ? latest.audioUnderstandingKey : latest.visionKey;
        if (JSON.stringify(latestConnection) !== JSON.stringify(connection) || latestKey !== apiKey
          || JSON.stringify(latest.profile) !== JSON.stringify(config.profile)) throw Error('gift-understanding-config-changed');
        await currentGiftUnderstandingSource(token, attachmentId);
        assertActive();
        checked = true;
      };
      await options.beforeRequest?.(assertReady);
      if (!checked) await assertReady();
    },
  });
  assertActive();
  const result: GiftOriginalUnderstandingResult = { subject: 'I', token: { ...token }, attachmentId,
    kind: audio ? 'audio' : 'image', content, understoodAt: Date.now() };
  options.onResult?.(result);
  await currentGiftUnderstandingSource(token, attachmentId);
  assertActive();
  return result;
}
