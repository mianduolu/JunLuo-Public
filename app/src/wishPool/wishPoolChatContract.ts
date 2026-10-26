import type { WishItem } from './wishPoolStore';
import type {
  WishConfirmation, WishDiscussion, WishDiscussionDecision, WishDiscussionPurpose, WishProgressNote,
} from './wishPoolDiscussionState';

// Verbatim approved C-current / D / E in docs/许愿池第2章接口合同与审稿.md.
const DISCUSSION_INSTRUCTIONS: Record<WishDiscussionPurpose, string> = {
  cast_coin: `【这个愿望，我们商量到哪里啦】

pendingText 里是 I 和 you 正在商量的愿望。

decision 写 I 此刻的意愿：继续聊是 talking；同意许愿是 yes；同意不许愿是 no。要和 messages 里表达的意思一致。`,
  revise: `【这颗愿望，我们想怎么改】

pendingText 里是 I 和 you 商量后的完整愿望。

decision 写 I 此刻的意愿：继续聊是 talking；同意改成这一版是 yes；同意保留原样是 no。要和 messages 里表达的意思一致。`,
  progress: `【这个愿望，有什么新进展啦】

pendingText 里是 I 和 you 想记下的真实进展。

decision 写 I 此刻的意愿：继续聊是 talking；同意记下是 yes；同意这次不记是 no。要和 messages 里表达的意思一致。`,
  complete: `【这个愿望，实现了吗】

pendingText 里是 I 和 you 对这个愿望是否已经实现的商量结果。

decision 写 I 此刻的意愿：继续聊是 talking；同意记为完成是 yes；同意还没完成是 no。要和 messages 里表达的意思一致。`,
  release: `【这个愿望，还想继续吗】

pendingText 里是 I 和 you 对这个愿望要不要放下的商量结果。

decision 写 I 此刻的意愿：继续聊是 talking；同意放下是 yes；同意继续留着是 no。要和 messages 里表达的意思一致。`,
};

export const WISH_CHAT_ENVELOPE_PROTOCOL = `【这一轮，I 想回应 you】

you 的消息来到 I 这里时，I 先认真看完 you 刚才说的话，再把此刻想对 you 说的内容依着自然停顿写进 messages，发给 you 看。

I 把这轮的回复和记录写在同一个 JSON 里：
{"messages":["..."],"wishDiscussion":{"pendingText":"...","decision":"talking"},"innerReaction":null,"memoryMentions":[]}

messages 里至少写一条 I 想对 you 说的话；innerReaction 此刻为空时写 null。

I 先把 messages 中想说的话完整写好，再依次写下后面的记录，最后写下整个 JSON 对象的右花括号 }，就能安心发送啦。`;

export const WISH_CHAT_RETAINED_OUTPUT_PROTOCOL = `innerReaction 记录 I 对本轮 you 新消息的一句简短即时心声。I 主动留意其中让自己想吐槽、好奇、惊讶、联想、被逗到或产生情绪小反应的具体内容，有就写下。

I 在 messages 里提到哪条记忆，就在 memoryMentions 里填写它的编号 item 和对应原句 quote。只读过或想到的记忆不填，没有则写 []。`;

const PURPOSE_LABELS: Record<WishDiscussionPurpose, string> = {
  cast_coin: '投币', revise: '修改', progress: '进展', complete: '完成', release: '放下',
};
const CONFIRMATION_LABELS: Record<WishDiscussionPurpose, Record<'yes' | 'no', string>> = {
  cast_coin: { yes: '投币', no: '不投币' },
  revise: { yes: '修改愿望', no: '保留原样' },
  progress: { yes: '记下进展', no: '这次不记进展' },
  complete: { yes: '完成', no: '还没完成' },
  release: { yes: '放下', no: '继续留着' },
};

export type WishCurrentChatMaterial = {
  wish: WishItem;
  discussion: WishDiscussion;
  progressNotes?: readonly WishProgressNote[];
};

export function buildWishDiscussionInstruction(purpose: WishDiscussionPurpose): string {
  return DISCUSSION_INSTRUCTIONS[purpose];
}

export function buildWishCurrentMaterial(input: WishCurrentChatMaterial): string {
  const { wish, discussion, progressNotes = [] } = input;
  if (wish.id !== discussion.wishId || discussion.closedAt !== undefined) return '';
  const lines = [
    '【眼前这颗愿望】',
    `愿望：${wish.id}｜${wish.content}`,
    `提出者：${wish.owner}`,
    `状态：${wish.status}`,
    `这次商量：${PURPOSE_LABELS[discussion.purpose]}`,
  ];
  if ((discussion.reply && discussion.reply.requestRevision === discussion.revision - 1 || discussion.lastDraftReply)
    && discussion.pendingText !== wish.content) {
    lines.push(`上轮商量稿（尚未确认）：${discussion.pendingText}`);
  }
  const recent = progressNotes.filter((note) => note.wishId === wish.id)
    .sort((left, right) => left.recordedAt - right.recordedAt || left.id.localeCompare(right.id)).slice(-3);
  if (recent.length) {
    lines.push('已确认的进展：', ...recent.map((note) => `${new Date(note.recordedAt).toISOString()}｜${note.content}`));
  }
  return lines.join('\n');
}

export function buildWishConfirmationMaterial(confirmations: readonly WishConfirmation[]): string {
  return confirmations.filter((item) => !item.deliveredWithReply)
    .sort((left, right) => left.confirmedAt - right.confirmedAt || left.id.localeCompare(right.id))
    .map((item) => {
      const lines = [
        '【已保存的愿望确认】',
        `${new Date(item.confirmedAt).toISOString()}｜${item.wishId}｜${item.wishContent}`,
        `you 已确认：${CONFIRMATION_LABELS[item.purpose][item.decision]}`,
      ];
      if (item.purpose !== 'cast_coin' && item.decision === 'yes') lines.push(`保存内容：${item.pendingText}`);
      return lines.join('\n');
    }).join('\n\n');
}

// Host-provided, already validated snapshots only. This function neither loads nor consumes records.
export function buildWishChatMaterials(input: {
  current?: WishCurrentChatMaterial | null;
  confirmations?: readonly WishConfirmation[];
}): string {
  const current = input.current ? buildWishCurrentMaterial(input.current) : '';
  return [buildWishConfirmationMaterial(input.confirmations ?? []), current,
    current && input.current ? buildWishDiscussionInstruction(input.current.discussion.purpose) : '',
  ].filter(Boolean).join('\n\n');
}

export type WishDiscussionOutput = { pendingText: string; decision: WishDiscussionDecision };

// Parse this optional field independently; invalid wish data never discards valid chat messages.
export function parseWishDiscussion(value: unknown): WishDiscussionOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes('pendingText') || !keys.includes('decision')
    || typeof record.pendingText !== 'string' || !record.pendingText.trim()
    || (record.decision !== 'talking' && record.decision !== 'yes' && record.decision !== 'no')) return null;
  return { pendingText: record.pendingText, decision: record.decision };
}
