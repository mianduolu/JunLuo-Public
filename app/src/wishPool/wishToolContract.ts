import type { JunLuoToolResult } from '../tools/toolTypes';

export const WISH_TOOL_SUMMARIES = {
  proposed: '愿望已经写进愿望簿，正等着 I 和 you 商量。',
  invalidContent: '这颗愿望还没有写下：正文需要是 1—160 个字符。',
  proposeUnknown: '还不知道这颗愿望有没有写进愿望簿',
  viewEmpty: '没有翻到符合这条线索的愿望。',
  pulled: '从池里捞起了 you 的一颗愿望。',
  pullEmpty: '池里暂时没有可以捞起的愿望。',
  pullUnknown: '还不知道这次有没有捞起愿望',
  invited: '商量这颗愿望的邀请已经递出。',
  inviteUnavailable: '这颗愿望现在不能商量这件事，邀请没有递出去。',
  inviteUnknown: '还不知道商量愿望的邀请有没有递给 you',
} as const;

export function isWishToolId(toolId: string) {
  return ['wish.propose', 'wish.view', 'wish.pull', 'wish.invite_discussion'].includes(toolId);
}

type WishResultEnvelope = {
  callId?: string; toolId?: string; ok: boolean; status: string; summary: string;
  data?: unknown; errorCode?: string;
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

// Project only the A2/B/E5 payload. Internal receipts and invitation metadata stay local.
export function projectWishToolResult(result: JunLuoToolResult): WishResultEnvelope | undefined {
  if (!isWishToolId(result.toolId)) return undefined;
  if (!result.ok && result.error?.code === 'TOOL_OUTCOME_UNKNOWN' && result.toolId !== 'wish.view') {
    const summary = result.toolId === 'wish.propose' ? WISH_TOOL_SUMMARIES.proposeUnknown
      : result.toolId === 'wish.pull' ? WISH_TOOL_SUMMARIES.pullUnknown : WISH_TOOL_SUMMARIES.inviteUnknown;
    return { ok: false, status: 'outcome_unknown', summary, errorCode: 'TOOL_OUTCOME_UNKNOWN' };
  }
  const envelope: WishResultEnvelope = {
    callId: result.callId, toolId: result.toolId, ok: result.ok, status: result.status, summary: result.summary,
  };
  if (!result.ok) {
    if (result.toolId === 'wish.propose' && result.error?.code === 'VALIDATION_FAILED') {
      return { ...envelope, summary: WISH_TOOL_SUMMARIES.invalidContent, errorCode: result.error.code };
    }
    if (result.toolId === 'wish.invite_discussion' && result.error?.code === 'WISH_DISCUSSION_NOT_AVAILABLE') {
      return { ...envelope, summary: WISH_TOOL_SUMMARIES.inviteUnavailable, errorCode: result.error.code };
    }
    return undefined; // Existing host permission/budget/cancellation errors keep their original path.
  }
  if (result.toolId === 'wish.propose') return { ...envelope, summary: WISH_TOOL_SUMMARIES.proposed };
  if (result.toolId === 'wish.invite_discussion') return { ...envelope, summary: WISH_TOOL_SUMMARIES.invited };
  const data = object(result.data);
  if (result.toolId === 'wish.pull') {
    return data && typeof data.wishId === 'string' && typeof data.content === 'string'
      ? { ...envelope, summary: WISH_TOOL_SUMMARIES.pulled, data: { wishId: data.wishId, content: data.content } }
      : { ...envelope, summary: WISH_TOOL_SUMMARIES.pullEmpty };
  }
  const wishes = Array.isArray(data?.wishes) ? data.wishes.slice(0, 3).flatMap(value => {
    const wish = object(value);
    return wish && typeof wish.wishId === 'string' && (wish.owner === 'I' || wish.owner === 'you')
      && typeof wish.content === 'string' && typeof wish.state === 'string'
      ? [{ wishId: wish.wishId, owner: wish.owner, content: wish.content, state: wish.state }] : [];
  }) : [];
  return wishes.length
    ? { ...envelope, summary: `翻到了 ${wishes.length} 颗愿望。`, data: { wishes } }
    : { ...envelope, summary: WISH_TOOL_SUMMARIES.viewEmpty };
}

export function buildWishToolResultFallback(result: JunLuoToolResult) {
  const projected = projectWishToolResult(result);
  const status = projected?.status === 'outcome_unknown' ? '结果不确定' : result.ok ? '成功' : '失败';
  return `【I 刚刚拿到的结果】${result.toolId}：${status}；${projected?.summary ?? result.summary}`
    + (projected?.data === undefined ? '' : `\ndata：${JSON.stringify(projected.data)}`);
}
