import { DeviceEventEmitter } from 'react-native';
import { loadAiConfigPreferencesSnapshot, resolveLifeCreativeConfig } from '../ai/AiConfigPreferences';
import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { isChatReplyInFlight } from '../ai/aiRuntimeScheduler';
import { buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { buildAssistantLifeShortJsonRequest } from '../ai/assistantLifeShortJsonRequest';
import { describeImageGroupWithVisionModel } from '../ai/openAiCompatibleProvider';
import type { ApiChatMessage } from '../ai/subjectiveMessages';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { estimateApiMessagesTokens } from '../chat/contextCompression';
import { loadActiveFocusSession } from '../focus/focusStore';
import { isJunluoWantsAwake, isWantsClockOwner } from '../life/junluoDesireRuntime';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadAndroidSyncNetworkClass } from '../sync/syncAndroidNetworkClass';
import { buildBaiyunPostReplyMaterials, parseBaiyunPostContent } from './baiyunPostContract';
import { capturePostReplySnapshot, isPostReplySnapshotCurrent, orderPostComments, type PostCommentData } from './baiyunPostData';
import { loadPostImageUnderstanding, understandPostImageGroup } from './baiyunPostImageVision';
import type { PostImageOwner, PostImageReceipt } from './baiyunPostImageData';
import { buildPostReplyMaterials, postReplyTask } from './baiyunPostReplyMaterials';
import { claimPostReplies, emptyPostReplyState, initializePostReading, pendingPostReplies, postLookKind, reconcilePostReplyState,
  type PostLookKind, type PostReplyState, type PostReplyWork } from './baiyunPostReplyState';
import { loadBaiyunPostRuntime, loadLocalBaiyunPost, loadLocalBaiyunPostComments, loadLocalBaiyunPostPage,
  saveBaiyunPostComment, updateBaiyunPostRuntime } from './baiyunPostStore';
import { loadPostTags } from './baiyunPostTags';
import { postReadRef, recordPostReading } from './baiyunPostReading';

const STATUS_CHANGED = 'junluo.baiyunPosts.replyStatus';
export function subscribePostReplyStatus(listener: () => void) {
  const subscription = DeviceEventEmitter.addListener(STATUS_CHANGED, listener);
  return () => subscription.remove();
}
const notify = () => DeviceEventEmitter.emit(STATUS_CHANGED);
type PaperInput = { key: string; lane: 'inner' | 'shared'; dataEpoch: number | null };
type ChoiceInput = PaperInput & { kind?: PostLookKind; decision?: boolean };
const unsavedChoices = new Map<string, ChoiceInput>();
let draining: Promise<boolean> | undefined;
const active = new Set<string>();
// Only paid results whose local journal write failed; no second request while this process has the result.
const unsaved = new Map<string, { epoch: number | null; work: PostReplyWork }>();
export const isPostReplyActive = (postId: string) => active.has(postId);

async function allowed(epoch: number | null) {
  if (!isWantsClockOwner() || !canCommitBackupRestoreDataEpoch(epoch) || isChatReplyInFlight()) return false;
  const [awake, policy, focus, network] = await Promise.all([isJunluoWantsAwake(), loadAutomaticRemoteAiPolicy(),
    loadActiveFocusSession(true), loadAndroidSyncNetworkClass()]);
  return awake && network !== 'offline' && isAutomaticRemoteAiAllowed(policy)
    && !(focus?.mode === 'cowork' && !focus.paused && focus.baiyunActivity.trim())
    && canCommitBackupRestoreDataEpoch(epoch);
}

async function refreshState(epoch: number | null) {
  const page = await loadLocalBaiyunPostPage();
  let replies = emptyPostReplyState();
  await updateBaiyunPostRuntime(runtime => {
    replies = reconcilePostReplyState(runtime.replies ?? emptyPostReplyState(), page.posts, page.comments);
    replies.reading ??= initializePostReading(runtime.replies ?? emptyPostReplyState(), page.posts, page.comments, Date.now());
    // Paid waiting results have priority over older failed jobs on the same post.
    // Unmigrated entries stay in the existing legacy maps until their slot becomes available.
    const failures = { ...runtime.replyFailures }, waitingReplies = { ...runtime.sleepingReplies };
    for (const [source, waiting] of Object.entries(waitingReplies)) {
      const post = page.posts.find(item => item.id === waiting.postId), progress = replies.posts[waiting.postId];
      if (!post || !progress || progress.handledSources.includes(source) || !waiting.content) {
        delete waitingReplies[source]; continue;
      }
      if (progress.work) continue;
      const comments = page.comments.filter(line => line.postId === post.id && !line.deleted);
      const oldPost = { ...post, title: post.title ?? '', legacy: false };
      const oldComments = comments.map(line => ({ ...line, id: line.storageId }));
      const key = JSON.stringify([post.id, post.content, post.updatedAt, buildBaiyunPostReplyMaterials(oldPost, oldComments, source, 0)]);
      const at = Math.max(Date.now(), progress.lastOpportunityAt + 1);
      progress.lastOpportunityAt = at;
      progress.work = { postId: post.id, source: `${source}:reply`, opportunityAt: at,
        initial: post.author === 'you' && !progress.initialHandled, newSources: [source],
        phase: key === waiting.inputKey ? 'generated' : 'stale',
        ...(key === waiting.inputKey ? { content: waiting.content, snapshot: capturePostReplySnapshot(post, comments) } : {}) };
      delete waitingReplies[source];
    }
    for (const [source, postId] of Object.entries(failures)) {
      const progress = replies.posts[postId];
      if (!progress || progress.handledSources.includes(source)
        || !page.comments.some(line => line.postId === postId && line.source === source && !line.deleted)) {
        delete failures[source]; continue;
      }
      if (progress.work) continue;
      const initial = page.posts.find(post => post.id === postId)?.author === 'you' && !progress.initialHandled;
      const at = Math.max(Date.now(), progress.lastOpportunityAt + 1);
      progress.lastOpportunityAt = at;
      progress.work = { postId, source: `${source}:reply`, opportunityAt: at, initial,
        newSources: [source], phase: 'failed' };
      delete failures[source];
    }
    return { ...runtime, replies, replyFailures: failures, sleepingReplies: waitingReplies };
  }, epoch);
  for (const [source, retained] of unsaved) {
    if (retained.epoch !== epoch || replies.posts[retained.work.postId]?.work?.source !== source) unsaved.delete(source);
  }
  return { ...page, replies };
}

/** Called only after the existing first-paper runtime has established a natural batch key. */
export async function preparePostLookPaper(input: PaperInput): Promise<PostLookKind | undefined> {
  await flushPostChoices();
  if (!await allowed(input.dataEpoch)) return undefined;
  const page = await refreshState(input.dataEpoch);
  const previous = page.replies.papers[input.lane];
  if (previous?.key === input.key && previous.decision !== undefined) return undefined;
  const kind = postLookKind(pendingPostReplies(page.replies, page.posts, page.comments));
  if (previous?.key === input.key && previous.kind === kind) return kind;
  await updateBaiyunPostRuntime(runtime => ({ ...runtime, replies: { ...(runtime.replies ?? emptyPostReplyState()),
    papers: { ...runtime.replies?.papers, [input.lane]: { key: input.key, kind } } } }), input.dataEpoch);
  return kind;
}

/** This only records a choice; never start a nested model call inside the first paper's budget lease. */
async function commitPostLookDecision(input: ChoiceInput) {
  if (!input.kind || typeof input.decision !== 'boolean' || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
  const page = await refreshState(input.dataEpoch);
  await updateBaiyunPostRuntime(runtime => {
    let replies = runtime.replies ?? emptyPostReplyState();
    const paper = replies.papers[input.lane];
    if (paper?.key !== input.key || paper.kind !== input.kind || paper.decision !== undefined) return runtime;
    replies = { ...replies, papers: { ...replies.papers, [input.lane]: { ...paper, decision: input.decision } } };
    if (input.decision) replies = claimPostReplies(replies, pendingPostReplies(replies, page.posts, page.comments), input.key, Date.now());
    return { ...runtime, replies };
  }, input.dataEpoch);
  notify();
}

export async function acceptPostLookDecision(input: ChoiceInput) {
  if (!input.kind || typeof input.decision !== 'boolean') return;
  const id = `${input.lane}:${input.key}`;
  unsavedChoices.set(id, input);
  await commitPostLookDecision(input);
  unsavedChoices.delete(id);
}

async function flushPostChoices() {
  for (const [id, input] of unsavedChoices) {
    if (canCommitBackupRestoreDataEpoch(input.dataEpoch)) await commitPostLookDecision(input);
    unsavedChoices.delete(id);
  }
}

async function saveWork(work: PostReplyWork, epoch: number | null) {
  await updateBaiyunPostRuntime(runtime => {
    const replies = runtime.replies, progress = replies?.posts[work.postId];
    if (!replies || !progress || progress.work?.source !== work.source) return runtime;
    return { ...runtime, replies: { ...replies,
      reading: work.reading ? recordPostReading(replies.reading ?? { activatedAt: work.reading.at, rounds: [] }, work.reading) : replies.reading,
      posts: { ...replies.posts, [work.postId]: { ...progress, work } } } };
  }, epoch);
  notify();
}

async function stillCurrent(work: PostReplyWork, epoch: number | null) {
  if (!canCommitBackupRestoreDataEpoch(epoch) || !work.snapshot) return false;
  const [post, comments, tags, runtime] = await Promise.all([loadLocalBaiyunPost(work.postId),
    loadLocalBaiyunPostComments(work.postId), loadPostTags(), loadBaiyunPostRuntime()]);
  return runtime.replies?.posts[work.postId]?.work?.source === work.source
    && isPostReplySnapshotCurrent(work.snapshot, post, comments)
    && (work.tagSnapshot ?? []).every(tag => tags.some(current => current.id === tag.id && current.name === tag.name && current.scope === tag.scope));
}

async function deliver(work: PostReplyWork, epoch: number | null) {
  if (!await stillCurrent(work, epoch)) {
    unsaved.delete(work.source);
    await saveWork({ ...work, phase: 'stale', content: undefined }, epoch); return;
  }
  if (!await allowed(epoch)) return;
  await saveBaiyunPostComment({ postId: work.postId, author: 'I', source: work.source, content: work.content!,
    notificationGroupKey: work.notificationGroupKey ?? work.source,
    snapshot: work.snapshot, tagSnapshot: work.tagSnapshot, imageReceipts: work.imageReceipts, dataEpoch: epoch });
  await refreshState(epoch); // A crash here is reconciled from the committed source, including deletion markers.
  unsaved.delete(work.source);
  notify();
}

async function runReply(original: PostReplyWork, epoch: number | null): Promise<boolean> {
  let work = original, transportStarted = false;
  try {
    const retained = unsaved.get(work.source);
    if (retained?.epoch === epoch) {
      work = retained.work; await saveWork(work, epoch);
      if (work.phase === 'failed') unsaved.delete(work.source);
    }
    else if (retained) unsaved.delete(work.source);
    if (work.phase === 'generated' && work.content) { await deliver(work, epoch); return false; }
    if (work.phase === 'generating') { await saveWork({ ...work, phase: 'failed' }, epoch); return false; }
    if (work.phase !== 'ready' || !await allowed(epoch)) return false;
    const [post, all, tags, config, runtime] = await Promise.all([loadLocalBaiyunPost(work.postId), loadLocalBaiyunPostComments(work.postId),
      loadPostTags(), loadAiConfigPreferencesSnapshot(), loadBaiyunPostRuntime()]);
    if (!post) return false;
    const { connection, apiKey } = resolveLifeCreativeConfig(config);
    if (!connection || !apiKey.trim()) return false;
    const handled = runtime.replies?.posts[post.id]?.handledSources ?? [];
    let newComments: PostCommentData[], oldComments: PostCommentData[];
    if (work.snapshot) {
      if (!await stillCurrent(work, epoch)) { await saveWork({ ...work, phase: 'stale' }, epoch); return false; }
      newComments = orderPostComments(all.filter(line => work.newSources.includes(line.source) && !line.deleted));
      oldComments = orderPostComments(all.filter(line => work.oldSources?.includes(line.source) && !line.deleted));
    } else {
      newComments = orderPostComments(all.filter(line => line.author === 'you' && !line.deleted && !handled.includes(line.source)));
      oldComments = orderPostComments(all.filter(line => !line.deleted && (line.author === 'I' || handled.includes(line.source)))).slice(-6);
      if (!work.initial && !newComments.length) { await saveWork({ ...work, phase: 'stale' }, epoch); return false; }
      work = { ...work, newSources: newComments.map(line => line.source), oldSources: oldComments.map(line => line.source),
        snapshot: capturePostReplySnapshot(post, [...oldComments, ...newComments]),
        tagSnapshot: post.tagIds.flatMap(id => { const tag = tags.find(item => item.id === id); return tag ? [tag] : []; }) };
      await saveWork(work, epoch);
    }
    const images: Record<string, { description: string; recovered: boolean } | null> = {};
    const receipts = new Map<string, PostImageReceipt>();
    const owners = (lines: readonly PostCommentData[]) => lines.filter(line => line.imageGroup).map(line => ({
      owner: { postId: post.id, commentSource: line.source } as PostImageOwner, group: line.imageGroup! }));
    const required = [...owners(newComments), ...(post.imageGroup ? [{ owner: { postId: post.id, commentSource: null }, group: post.imageGroup }] : [])];
    const unknown = new Set<string>();
    for (const { owner, group } of [...required, ...owners(oldComments)]) {
      const cached = await loadPostImageUnderstanding(owner);
      if (cached?.status === 'stale') { await saveWork({ ...work, phase: 'stale' }, epoch); return false; }
      if (cached?.status === 'seen') { images[group.id] = cached; receipts.set(group.id, cached.receipt); }
      else { images[group.id] = null; unknown.add(group.id); }
    }
    const task = postReplyTask(work.initial), materialAt = Date.now();
    const material = () => buildPostReplyMaterials({ now: materialAt, post, oldComments, newComments,
      tagNames: (work.tagSnapshot ?? []).map(tag => tag.name), images });
    const envelope = await buildAssistantStatePairEnvelope({ contextSource: 'assistant-life.post-reply', profile: config.profile, materialPrompt: material() });
    const messages = (): ApiChatMessage[] => [{ role: 'system', content: envelope.apiMessages[0].content },
      { role: 'system', content: material() }, { role: 'system', content: task }];
    const fits = (reserveUnknown = true) => estimateApiMessagesTokens(messages()) + 700 + 512
      + (reserveUnknown ? owners(oldComments).filter(item => unknown.has(item.group.id)).length * 800 : 0) <= (connection.contextWindowTokens ?? 65536);
    // Reject an already oversized fixed body before paying for any image. Required image results
    // are obtained before deciding which old comments can fit, avoiding speculative over-pruning.
    const proposedOld = oldComments;
    oldComments = [];
    if (!fits(false)) { await saveWork({ ...work, phase: 'capacity' }, epoch); return false; }
    oldComments = proposedOld;
    const readGroup = async ({ owner, group }: typeof required[number]): Promise<boolean> => {
      if (!unknown.has(group.id)) return true;
      if (!config.visionConnection || !config.visionKey.trim()) return false;
      const vision = await understandPostImageGroup({ owner, opportunity: { id: work.source, startedAt: work.opportunityAt }, request: async input => {
        let received: { started: boolean; text: string | null; error?: unknown } | undefined;
        const result = await runBudgetedAiCall('postVision', 'background', async () => {
          if (!await allowed(epoch) || !await stillCurrent(work, epoch)) return { started: false, text: null };
          transportStarted = true;
          try { return received = { started: true, text: await describeImageGroupWithVisionModel({ apiKey: config.visionKey,
            connection: config.visionConnection!, images: input }) }; }
          catch (error) { return received = { started: true, text: null, error }; }
        }, { connection: config.visionConnection, dataEpoch: epoch, shouldRecordSuccess: result => result.started })
          .catch(error => { if (received) return { ok: true as const, value: received }; throw error; });
        if (!result.ok) return null;
        if ('error' in result.value) throw result.value.error;
        return result.value.text;
      } });
      if (vision.status === 'stale') { await saveWork({ ...work, phase: 'stale' }, epoch); return false; }
      if (vision.status !== 'seen' && vision.status !== 'unavailable') return false;
      images[group.id] = vision.status === 'seen' ? vision : null;
      if (vision.status === 'seen') receipts.set(group.id, vision.receipt);
      unknown.delete(group.id);
      return true;
    };
    for (const item of required) if (!await readGroup(item)) return transportStarted;
    while (!fits() && oldComments.length) oldComments.shift();
    if (!fits()) { await saveWork({ ...work, phase: 'capacity' }, epoch); return transportStarted; }
    work = { ...work, oldSources: oldComments.map(line => line.source), snapshot: capturePostReplySnapshot(post, [...oldComments, ...newComments]) };
    await saveWork(work, epoch);
    for (const item of owners(oldComments)) if (!await readGroup(item)) return transportStarted;
    while (!fits() && oldComments.length) oldComments.shift();
    if (!fits()) { await saveWork({ ...work, phase: 'capacity' }, epoch); return transportStarted; }
    work = { ...work, oldSources: oldComments.map(line => line.source), snapshot: capturePostReplySnapshot(post, [...oldComments, ...newComments]),
      imageReceipts: [...required, ...owners(oldComments)].flatMap(item => receipts.has(item.group.id) ? [receipts.get(item.group.id)!] : []) };
    await saveWork(work, epoch);
    const result = await runBudgetedAiCall('postReply', 'background', async () => {
      if (!await allowed(epoch) || !await stillCurrent(work, epoch)) return { started: false };
      let started = false;
      try {
        const reply = await fetchAssistantLifeCompletion({ apiKey, connection, contextSource: 'assistant-life.post-reply', envelope,
          apiMessagesOverride: messages(), userPrompt: task, request: { ...buildAssistantLifeShortJsonRequest(connection, .8), max_tokens: 700 },
          onRequestStart: async () => {
            if (!await allowed(epoch) || !await stillCurrent(work, epoch)) throw new Error('baiyun-post-deferred');
            await saveWork({ ...work, phase: 'generating' }, epoch);
          }, onTransportAttempt: transport => { if (transport.outcome === 'started') { started = true; transportStarted = true; } },
        });
        if (reply.content.trim()) work = { ...work, reading: { source: work.source, postId: post.id,
          at: Math.max(Date.now(), (runtime.replies?.reading?.activatedAt ?? 0) + 1),
          refs: [postReadRef(post, images), ...[...oldComments, ...newComments].map(line => postReadRef(line, images))] } };
        const complete = reply.finishReason == null || reply.finishReason === 'stop' || reply.finishReason === 'end_turn';
        const content = complete ? parseBaiyunPostContent(reply.content) : null;
        const generated: PostReplyWork = { ...work, phase: content ? 'generated' : 'failed', ...(content ? { content } : {}) };
        unsaved.set(work.source, { epoch, work: generated });
        await saveWork(generated, epoch);
        work = generated;
        if (!content) unsaved.delete(work.source);
        return { started };
      } catch { if (!unsaved.has(work.source)) await saveWork({ ...work, phase: started ? 'failed' : 'ready' }, epoch); return { started }; }
    }, { connection, dataEpoch: epoch, shouldRecordSuccess: result => result.started });
    if (result.ok && work.phase === 'generated') await deliver(work, epoch);
    return transportStarted;
  } catch {
    // Local IO failure leaves the existing journal untouched. It cannot trigger a fresh paid attempt.
    return transportStarted;
  }
}

/** Reuses the life engine's existing slow-task entry. No timer, wake-up, or questionnaire is started here. */
export function drainPostReplies(): Promise<boolean> {
  if (draining) return draining;
  draining = (async () => {
    const epoch = captureBackupRestoreDataEpoch();
    await flushPostChoices();
    if (!await allowed(epoch)) return false;
    const page = await refreshState(epoch);
    const works = Object.values(page.replies.posts).flatMap(progress => progress.work
      && (['ready', 'generating', 'generated'].includes(progress.work.phase) || unsaved.has(progress.work.source)) ? [progress.work] : [])
      .sort((a, b) => a.opportunityAt - b.opportunityAt || a.postId.localeCompare(b.postId));
    let started = false;
    for (const work of works) {
      if (!await allowed(epoch)) break;
      active.add(work.postId);
      try { started = await runReply(work, epoch) || started; }
      finally {
        active.delete(work.postId);
        await import('./baiyunPostNotifications').then(module => module.resumePostNotifications()).catch(() => undefined);
      }
    }
    return started;
  })().finally(() => { draining = undefined; });
  return draining;
}

export async function retryPostReply(postId: string, source?: string) {
  if (active.has(postId)) return;
  const epoch = captureBackupRestoreDataEpoch();
  const page = await refreshState(epoch), work = page.replies.posts[postId]?.work;
  if (!work || (source && source !== work.source && `${source}:reply` !== work.source)) return;
  if (['failed', 'capacity', 'stale'].includes(work.phase)) {
    await saveWork({ ...work, phase: 'ready', snapshot: undefined, oldSources: undefined,
      tagSnapshot: undefined, content: undefined, imageReceipts: undefined }, epoch);
  }
  await drainPostReplies();
}

export async function loadPostReplyFailure(postId: string) {
  const work = (await loadBaiyunPostRuntime()).replies?.posts[postId]?.work;
  return work && ['failed', 'capacity', 'stale'].includes(work.phase) ? { source: work.source,
    message: work.phase === 'capacity' ? '本次回复材料太长，暂时无法生成评论。内容已保存，可以缩短内容，或拆到不同动态后重试。'
      : '评论暂时没生成' } : null;
}
