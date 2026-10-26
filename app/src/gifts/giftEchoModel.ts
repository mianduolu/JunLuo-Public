import { loadAiConfigPreferencesSnapshot, type AiConfigSnapshot } from '../ai/AiConfigPreferences';
import { audioInputAdapterFor } from '../ai/audioInputCompatibility';
import { buildChatMemoryBundle } from '../memory/memoryOrchestrator';
import { compilePersonaPromptResult, replaceCompiledMemoryContext } from '../ai/persona/promptCompiler';
import { SUBJECTIVE_IDENTITY_PROTOCOL } from '../ai/subjectiveMessages';
import { requestGiftEcho } from '../ai/giftEchoRequest';
import { loadGiftEchoThread } from './giftEchoStore';
import { loadGiftActivityMaterials } from './giftActivityMaterials';
import { assertGiftEchoEpoch, currentGiftEchoGift, inspectGiftEchoOriginal, readGiftEchoOriginal } from './giftEchoOriginal';
import type { GiftAttachment, GiftWorkToken } from './giftTypes';
import type { GiftEchoReadSelection } from './giftEchoReadStore';
import { loadGiftEchoReadSelection } from './giftEchoReadStore';

export type GiftEchoModelResult = { kind: 'reply'; content: string; attachmentId?: string; originalId?: string; readAt?: number }
  | { kind: 'read'; attachmentId: string };
/** Approved verbatim in the revised chapter-6 review, 2026-10-17. */
export const GIFT_ECHO_PROMPT = `【聊聊这份礼物】
I 正在和 you 聊这份礼物。

I 回应 you 这次说的话，自然说出自己的想法和感受。

想再听一听、看一看礼物里的某件内容时，I 用 read_gift_original 选择它。听过、看过或读过后，I 再继续回应 you。`;
export const GIFT_ECHO_READ_PROMPT = `【再次听、看或读这份礼物】
I 正在重新听、看或读这份礼物里选中的内容。

I 根据这次实际听到、看到或读到的内容，自然回应 you。

有拿不准的地方时，I 就如实告诉 you。`;
export const giftEchoReviewApproved = true;

function route(config: AiConfigSnapshot, kind?: GiftAttachment['kind']) {
  return kind === 'audio' ? { connection: config.audioUnderstandingConnection, key: config.audioUnderstandingKey }
    : kind === 'image' ? { connection: config.visionConnection, key: config.visionKey }
      : { connection: config.chatConnection, key: config.chatKey };
}
const configured = (value: ReturnType<typeof route>) => !!(value.connection?.provider === 'openai-compatible'
  && value.connection.baseUrl.trim() && value.connection.model.trim() && value.key?.trim());
const readTool = (ids: string[]) => ({ type: 'function', function: { name: 'read_gift_original',
  description: 'I 选择这份礼物里的一个文件，再听一听、看一看或读一读。', parameters: { type: 'object',
    properties: { attachmentId: { type: 'string', description: 'I 选中的文件编号', enum: ids } },
    required: ['attachmentId'], additionalProperties: false } } });

async function snapshot(token: GiftWorkToken, replyToId: string, config: AiConfigSnapshot) {
  const gift = await currentGiftEchoGift(token), thread = await loadGiftEchoThread(token, 'I');
  if (thread.token.dataEpoch !== token.dataEpoch || !thread.pendingYouIds.includes(replyToId)) throw Error('gift-echo-target-missing');
  const target = thread.messages.find(line => line.id === replyToId)!;
  const prior = thread.messages.filter(line => line.sequence <= target.sequence), messages = [...prior];
  let size = messages.reduce((sum, line) => sum + line.content.length, 0);
  while (messages.length > 1 && (messages.length > 30 || size > 12000)) size -= messages.shift()!.content.length;
  const attachments = [];
  for (const [index, attachment] of gift.attachments.entries()) {
    let unavailableReason: null | 'unconfigured' | 'missing' | 'unsupported' | 'too_large' | 'link_only' = null;
    if (attachment.kind === 'url') unavailableReason = 'link_only';
    else if (!configured(route(config, attachment.kind))) unavailableReason = 'unconfigured';
    else try { await inspectGiftEchoOriginal(token, attachment.id, audioInputAdapterFor(route(config, attachment.kind).connection!)); }
      catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (['gift-audio-format-unsupported', 'gift-image-format-unsupported'].includes(code)) unavailableReason = 'unsupported';
        else if (code === 'gift-audio-too-large') unavailableReason = 'too_large';
        else if (['gift-original-missing', 'gift-original-changed'].includes(code)) unavailableReason = 'missing';
        else throw error;
      }
    attachments.push({ attachmentId: attachment.id, position: index + 1, kind: attachment.kind,
      ...(attachment.kind === 'url' ? { url: attachment.url } : { originalName: attachment.original.originalName }),
      readable: unavailableReason === null, unavailableReason });
  }
  const activity = await loadGiftActivityMaterials(token);
  const originalReads = thread.messages.flatMap(line => {
    if (line.subject !== 'I' || line.readAt === null || !line.attachmentId || !line.originalId) return [];
    const attachment = gift.attachments.find(item => item.id === line.attachmentId);
    if (!attachment || attachment.kind === 'url' || attachment.original.id !== line.originalId) return [];
    return [{ subject: 'I' as const, attachmentId: line.attachmentId, originalId: line.originalId,
      readAt: new Date(line.readAt).toISOString(), kind: line.origin === 'understanding' ? 'first' : 'revisit' }];
  });
  await currentGiftEchoGift(token); assertGiftEchoEpoch(token);
  return { gift, target, messages, readable: attachments.filter(item => item.readable).map(item => item.attachmentId),
    record: { sender: gift.sender, title: gift.title, note: gift.note, deliveredAt: new Date(gift.deliveredAt!).toISOString(),
      openedAt: new Date(gift.openedAt!).toISOString(), attachments, ...activity, originalReads, providedOriginal: null as unknown },
    range: { replyToId, messages: messages.map(line => ({ id: line.id, subject: line.subject, at: new Date(line.createdAt).toISOString() })),
      earlierMessageCount: prior.length - messages.length } };
}

export async function prepareGiftEchoCall(sourceToken: GiftWorkToken, replyToId: string, read: GiftEchoReadSelection | null) {
  const token = { ...sourceToken }, gift = await currentGiftEchoGift(token);
  const attachment = read ? gift.attachments.find(item => item.id === read.attachmentId) : undefined;
  if (read && (read.giftId !== gift.id || read.giftRevision !== gift.revision || read.replyToId !== replyToId
    || !attachment || attachment.kind === 'url' || attachment.original.id !== read.originalId)) throw Error('gift-attachment-not-owned');
  const assertSelection = async () => {
    if (!read) return;
    const saved = await loadGiftEchoReadSelection(token, replyToId);
    if (!saved || saved.attachmentId !== read.attachmentId || saved.originalId !== read.originalId
      || saved.selectedAt !== read.selectedAt) throw Error('gift-echo-target-missing');
  };
  await assertSelection();
  const config = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 }), selected = route(config, attachment?.kind);
  if (!configured(selected)) throw Error(attachment?.kind === 'audio' ? 'gift-audio-connection-unavailable'
    : attachment?.kind === 'image' ? 'gift-image-connection-unavailable' : 'gift-chat-connection-unavailable');
  const connection = selected.connection!, apiKey = selected.key;
  const original = attachment ? await readGiftEchoOriginal(token, attachment.id, audioInputAdapterFor(connection)) : undefined;
  let context = await snapshot(token, replyToId, config);
  const query = [gift.title, gift.note, context.target.content].filter(Boolean).join('\n');
  const memories = await buildChatMemoryBundle({ userText: query, sourceHints: '', activeContext: '' }, {
    source: 'letter', readOnly: true, includeCurrentStates: false, useSemanticMemory: false, allowRerank: false, touch: false,
  });
  let compiled = await compilePersonaPromptResult({ readOnly: true, profile: config.profile, contextProfile: 'chat-full',
    outputAudience: 'private_visible_text', conversationText: query, memoryContext: memories.context });
  const input: Parameters<typeof requestGiftEcho>[0] = { connection, apiKey, systemMessages: [], messages: [], original: original?.media };
  const assemble = () => {
    const providedOriginal = original ? { attachmentId: original.attachment.id,
      position: gift.attachments.findIndex(item => item.id === original.attachment.id) + 1, kind: original.attachment.kind,
      originalId: original.attachment.original.id, complete: !original.html || original.html.through === original.html.total,
      ...(original.html ? { from: original.html.from, through: original.html.through, total: original.html.total } : {}) } : null;
    input.systemMessages = [[SUBJECTIVE_IDENTITY_PROTOCOL, compiled.stablePrompt].filter(Boolean).join('\n\n'),
      ...(compiled.dynamicPrompt ? [compiled.dynamicPrompt] : []),
      `${read ? GIFT_ECHO_READ_PROMPT : GIFT_ECHO_PROMPT}\n\n【这份礼物的信息】\n${JSON.stringify({ ...context.record, providedOriginal })}`
      + `\n\n【这次对话的消息与时间】\n${JSON.stringify(context.range)}`
      + (original?.html ? `\n\n【本次小网页原文】\n${JSON.stringify({ attachmentId: original.attachment.id, ...original.html })}` : '')];
    input.messages = context.messages.map(line => ({ subject: line.subject, content: line.content }));
    input.tools = !read && context.readable.length ? [readTool(context.readable)] : undefined;
  };
  assemble();
  return { connection, budgetKind: read ? 'giftUnderstanding' as const : 'giftReply' as const,
    async request(beforeRequest: (assertReady?: () => Promise<void>) => Promise<void>, onResult: (value: GiftEchoModelResult) => void) {
      input.beforeRequest = async () => {
        await memories.refreshMemoryMaterials?.(); compiled = replaceCompiledMemoryContext(compiled, memories.context);
        let checked = false;
        const assertReady = async () => {
          const latest = await loadAiConfigPreferencesSnapshot({ readOnly: true, maxAgeMs: 0 }), current = route(latest, attachment?.kind);
          if (JSON.stringify(current.connection) !== JSON.stringify(connection) || current.key !== apiKey
            || JSON.stringify(latest.profile) !== JSON.stringify(config.profile)) throw Error('gift-echo-config-changed');
          context = await snapshot(token, replyToId, latest);
          await assertSelection();
          if (read && !context.readable.includes(read.attachmentId)) throw Error('gift-original-missing');
          assemble(); assertGiftEchoEpoch(token); checked = true;
        };
        await beforeRequest(assertReady); if (!checked) await assertReady();
      };
      const returned = await requestGiftEcho(input);
      let result: GiftEchoModelResult;
      if (returned.kind === 'tool') {
        const args = returned.arguments;
        if (read || returned.name !== 'read_gift_original' || !args || typeof args !== 'object' || Array.isArray(args)
          || Object.keys(args).length !== 1 || !('attachmentId' in args) || typeof args.attachmentId !== 'string'
          || !context.readable.includes(args.attachmentId)) throw Error('gift-echo-invalid-choice');
        result = { kind: 'read', attachmentId: args.attachmentId };
      } else result = { kind: 'reply', content: returned.content, ...(original ? { attachmentId: original.attachment.id,
        originalId: original.attachment.original.id, readAt: Date.now() } : {}) };
      onResult(result);
      await currentGiftEchoGift(token); assertGiftEchoEpoch(token);
      return result;
    } };
}
