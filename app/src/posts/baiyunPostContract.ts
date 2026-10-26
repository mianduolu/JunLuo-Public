import { rankMemoryEntriesForRecall } from '../memory/memoryRecallScoring';
import { readJsonObjects } from '../ai/shortJsonObjects';
import type { PostReplyState } from './baiyunPostReplyState';

export const BAIYUN_POST_SOURCE = 'baiyun-post';
export const BAIYUN_POST_RUNTIME_KEY = 'junluo.baiyunPosts.runtime.v1';
export const BAIYUN_POST_INTERVAL_MS = 4 * 60 * 60 * 1000;
export const BAIYUN_POST_PROMPT = `【发条动态】

I 想发条动态啦，把这会儿想说的话写下来。

I 把想发的内容写进这个 JSON：
{"content":"..."}

写好后，I 只发送这个 JSON。`;
export const BAIYUN_POST_REPLY_PROMPT = `【在动态下面聊聊】

you 来给 I 留言啦，I 想接着和 you 聊聊。

I 把想回应的话写进这个 JSON：
{"content":"..."}

写好后，I 只发送这个 JSON。`;
export const BAIYUN_POST_RECALL_INTRO = `【I 发过的动态】

这里记着 I 发过的动态，以及 I 和 you 在下面聊过的话。动态里的愿望和想象，记作 I 当时想过的事。`;

export type BaiyunPost = {
  id: string; title: string; content: string; createdAt: number; updatedAt: number; legacy: boolean;
};
export type BaiyunPostComment = {
  id: string; postId: string; source: string; author: 'I' | 'you'; content: string; createdAt: number;
};
export type PostConversationLine = {
  id: string; role: 'I' | 'you'; content: string; createdAt: number;
};
export type BaiyunPostRuntime = {
  schemaVersion: 1;
  attempts: number[];
  lastAttemptAt: number | null;
  offeredRefs: string[];
  stateMaterial: string;
  replyFailures: Record<string, string>;
  sleepingReplies: Record<string, { postId: string; content?: string; inputKey?: string }>;
  replies?: PostReplyState;
  memoryOrganization?: import('./baiyunPostMemoryState').PostMemoryRuntimeState;
};

export function emptyBaiyunPostRuntime(): BaiyunPostRuntime {
  return { schemaVersion: 1, attempts: [], lastAttemptAt: null, offeredRefs: [], stateMaterial: '', replyFailures: {}, sleepingReplies: {} };
}

export function isBaiyunPostMemory(memory: { source?: string; period?: string; tags?: readonly string[]; type?: string }) {
  return memory.source === BAIYUN_POST_SOURCE || memory.source === 'baiyun-reflection'
    || memory.period === 'reflection'
    || memory.tags?.some(tag => tag === '白云心声' || tag === '白云沉淀') === true;
}

export function postDateKey(at: number) {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function postTime(at: number) { return new Date(at).toLocaleString('zh-CN', { hour12: false }); }

export function canPublishBaiyunPost(input: {
  now: number; desire: number; lifeMode: string; automaticAllowed: boolean; proactiveSent: boolean;
  refs: readonly string[]; stateMaterial: string; runtime: BaiyunPostRuntime;
}) {
  if (!input.automaticAllowed || input.proactiveSent || input.lifeMode !== 'available' || input.desire + 1e-9 < 0.54) return false;
  if (input.runtime.lastAttemptAt !== null && input.now - input.runtime.lastAttemptAt < BAIYUN_POST_INTERVAL_MS) return false;
  if (input.runtime.attempts.filter(at => postDateKey(at) === postDateKey(input.now)).length >= 2) return false;
  return input.refs.some(ref => !input.runtime.offeredRefs.includes(ref))
    || Boolean(input.stateMaterial && input.stateMaterial !== input.runtime.stateMaterial);
}

export function markBaiyunPostAttempt(runtime: BaiyunPostRuntime, now: number, refs: readonly string[], stateMaterial: string): BaiyunPostRuntime {
  return { ...runtime, attempts: [...runtime.attempts.filter(at => now - at < 48 * 60 * 60 * 1000), now], lastAttemptAt: now,
    offeredRefs: [...new Set([...runtime.offeredRefs, ...refs])], stateMaterial };
}

export function conversationRounds<T extends { role: 'I' | 'you' }>(lines: readonly T[]): T[][] {
  const rounds: T[][] = [];
  for (const line of lines) {
    const current = rounds[rounds.length - 1];
    if (!current || (line.role === 'you' && current.some(item => item.role === 'I'))) rounds.push([line]);
    else current.push(line);
  }
  return rounds;
}

export function recentCompletePostChat(lines: readonly PostConversationLine[], limit = 3) {
  return conversationRounds(lines).filter(round => round.some(line => line.role === 'you') && round.some(line => line.role === 'I')).slice(-limit).flat();
}

export function recentPostDiscussion(comments: readonly BaiyunPostComment[], currentSource?: string, throughId?: string) {
  let rounds = conversationRounds(comments.map(comment => ({ ...comment, role: comment.author })));
  if (throughId) {
    const index = rounds.findIndex(round => round.some(line => line.id === throughId));
    if (index >= 0) rounds = rounds.slice(0, index + 1);
  }
  const currentRound = currentSource ? rounds.find(round => round.some(line => line.source === currentSource)) : undefined;
  if (currentRound) {
    return [...rounds.slice(0, rounds.indexOf(currentRound)).filter(round => round.some(line => line.role === 'I') && round.some(line => line.role === 'you')).slice(-6).flat(), ...currentRound];
  }
  return rounds.slice(-6).flat();
}

export function formatPostConversation(lines: readonly PostConversationLine[]) {
  return lines.map(line => `${postTime(line.createdAt)} ${line.role}：${line.content}`).join('\n');
}
export function formatPostComments(comments: readonly BaiyunPostComment[]) {
  return formatPostConversation(comments.map(comment => ({ ...comment, role: comment.author })));
}

export function buildBaiyunPostMaterials(input: {
  now: number;
  status?: { lifeModeText: string; title: string; activity: string; lifeContext?: string; updatedAt: number };
  emotion?: { text: string; at: number };
  desirePaper: string; chat: readonly PostConversationLine[];
  lifeEntries: readonly { title: string; activity: string; at: number }[]; posts: readonly BaiyunPost[];
}) {
  const status = input.status;
  const life = input.lifeEntries.filter(entry => !status || entry.title !== status.title || entry.activity !== status.activity).slice(-2);
  const chat = recentCompletePostChat(input.chat);
  return [
    `【此刻】\n\n现在：${postTime(input.now)}`,
    status ? `【I 最近保存的生活状态】\n\n生活模式：${status.lifeModeText}\n状态：${status.title}\n小动作：${status.activity}${status.lifeContext?.trim() ? `\n作息：${status.lifeContext}` : ''}\n记录时间：${postTime(status.updatedAt)}` : '',
    input.emotion ? `【I 最近记录的心情】\n\n心情：${input.emotion.text}\n记录时间：${postTime(input.emotion.at)}` : '',
    input.desirePaper,
    chat.length ? `【最近和 you 聊过的话】\n\n${formatPostConversation(chat)}` : '',
    life.length ? `【I 最近留下的生活片段】\n\n${life.map(entry => `${postTime(entry.at)} I：${entry.title}\n${entry.activity}`).join('\n\n')}` : '',
    input.posts.length ? `【I 最近发过的动态】\n\n${input.posts.slice(0, 2).map(post => `${postTime(post.createdAt)} I：${post.content}`).join('\n\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildBaiyunPostReplyMaterials(post: BaiyunPost, comments: readonly BaiyunPostComment[], currentSource: string, now: number) {
  const discussion = recentPostDiscussion(comments, currentSource);
  return `【此刻】\n\n现在：${postTime(now)}\n\n【I 发的这条动态】\n\n发布时间：${postTime(post.createdAt)}\n${post.content}\n\n【这条动态下面的留言】\n\n${formatPostComments(discussion)}`;
}

export function parseBaiyunPostContent(raw: string): string | null {
  const values = readJsonObjects(raw);
  if (values.length !== 1) return null;
  const content = (values[0] as { content?: unknown }).content;
  return typeof content === 'string' && content.trim() ? content.trim() : null;
}

export function selectBaiyunPostRecall(posts: readonly BaiyunPost[], comments: readonly BaiyunPostComment[], query: string) {
  const candidates = posts.flatMap(post => [
    { post, commentId: undefined as string | undefined, content: post.content },
    ...comments.filter(comment => comment.postId === post.id).map(comment => ({ post, commentId: comment.id, content: comment.content })),
  ]);
  const ranked = rankMemoryEntriesForRecall(candidates.map(candidate => ({
    ...candidate, id: candidate.commentId ?? candidate.post.id, title: '', domain: '日常', tags: [], recallCues: [],
    importance: 5, confidence: 1, stability: 1, pinned: false, protected: false, resolved: false,
    anchor: false, activationCount: 0, lastActiveAt: candidate.post.createdAt,
    tier: 'working' as const, type: 'feel' as const, semanticType: 'other' as const, createdAt: candidate.post.createdAt,
  })), query, { limit: 1 });
  const hit = ranked[0]?.memory;
  if (!hit) return null;
  const discussion = recentPostDiscussion(comments.filter(comment => comment.postId === hit.post.id), undefined, hit.commentId);
  return { post: hit.post, discussion, prompt: `${BAIYUN_POST_RECALL_INTRO}\n\n${postTime(hit.post.createdAt)} I：${hit.post.content}${discussion.length ? `\n\n${formatPostComments(discussion)}` : ''}` };
}
