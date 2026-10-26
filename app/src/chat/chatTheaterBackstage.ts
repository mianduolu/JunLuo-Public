import type { ChatOptions } from '../ai/openAiCompatibleProvider';
import { replaceCompiledModuleInstruction } from '../ai/persona/promptCompiler';
import { BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL, buildBaiyunFixedPendingSharesPrompt,
  type BaiyunFixedPendingSharePromptItem } from '../ai/behavior/actionShareResponse';
import { checkBackstageCapacity, type BackstageCapacityInput } from '../theater/theaterBackstageCapacity';
import type { TheaterBackstageSession } from '../theater/theaterBackstageSession';

export type ChatTheaterBackstagePort = {
  session: TheaterBackstageSession;
  /** Same compiled inputs as the real request; no second model call or persisted prompt copy. */
  onRequestSnapshot?: (input: BackstageCapacityInput) => void;
  bindPreparation?: (prepare: () => Promise<BackstageCapacityInput>) => () => void;
};


export class BackstageCapacityPending extends Error {
  toolContinuation?: {
    continuationMessages: NonNullable<ChatOptions['continuationMessages']>;
    completedResults: import('../tools/toolTypes').JunLuoToolResult[];
  };
  constructor() { super('BACKSTAGE_CAPACITY_PENDING'); }
}

export function backstagePendingShares(items: readonly BaiyunFixedPendingSharePromptItem[]) {
  return items.filter(item => item.directReplyTarget);
}

export function withoutBackstageShares(input: BackstageCapacityInput, options: {
  webShare: string; keywordInsight: string; pendingShares: readonly BaiyunFixedPendingSharePromptItem[];
}): BackstageCapacityInput {
  const fixedBlock = (items: readonly BaiyunFixedPendingSharePromptItem[]) => items.length
    ? `${BAIYUN_CHAT_FIXED_SHARE_RESPONSE_GUIDANCE_PROTOCOL}\n\n${buildBaiyunFixedPendingSharesPrompt(items)}` : '';
  let responseInstruction = input.responseInstruction;
  if (responseInstruction) {
    for (const block of [options.webShare, options.keywordInsight]) {
      if (block) responseInstruction = responseInstruction.replace(block, '');
    }
    const allPending = fixedBlock(options.pendingShares);
    if (allPending) responseInstruction = responseInstruction.replace(allPending, fixedBlock(backstagePendingShares(options.pendingShares)));
    responseInstruction = responseInstruction.trim() || undefined;
  }
  return { ...input, responseInstruction, preparedCompiledPrompt: replaceCompiledModuleInstruction(
    input.preparedCompiledPrompt, input.responseInstruction ?? '', responseInstruction ?? '') };
}

export function createBackstageRequestPreparation(options: {
  port: ChatTheaterBackstagePort; batchId: string | null; replyId: string;
  webShare: string; keywordInsight: string;
  pendingShares: readonly BaiyunFixedPendingSharePromptItem[];
}): NonNullable<ChatOptions['prepareBackstageRequest']> {
  return async input => {
    const { session } = options.port;
    const carry = options.batchId ? await session.carry(options.batchId, options.replyId) : null;
    const snapshot = carry ? withoutBackstageShares(input, options) : input;
    const { responseInstruction } = snapshot;
    options.port.onRequestSnapshot?.(snapshot);
    if (!carry) return { preambleMessages: input.preambleMessages, responseInstruction };
    const fits = async (card: string) => (await checkBackstageCapacity(snapshot, card)).fits;
    const fitsNow = await fits(carry.card);
    const current = await session.carry(options.batchId!, options.replyId);
    if (!current) return { preambleMessages: input.preambleMessages, responseInstruction: input.responseInstruction };
    if (!fitsNow) {
      session.capacityExceeded(options.batchId!, fits);
      throw new BackstageCapacityPending();
    }
    if (current.card !== carry.card || current.source.useNumber !== carry.source.useNumber) {
      // An explicit source/card change during preparation cannot send stale material.
      throw new BackstageCapacityPending();
    }
    return { preambleMessages: [...(input.preambleMessages ?? []), { role: 'system', content: carry.card }],
      responseInstruction, preparedCompiledPrompt: snapshot.preparedCompiledPrompt, source: carry.source,
      isCurrent: () => session.beginReply() === options.batchId };
  };
}
