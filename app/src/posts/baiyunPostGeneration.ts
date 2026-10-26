import { runBudgetedAiCall } from '../ai/aiCallBudget';
import { buildAssistantStatePairEnvelope, fetchAssistantLifeCompletion } from '../ai/assistantLifePromptEnvelope';
import { buildAssistantLifeShortJsonRequest } from '../ai/assistantLifeShortJsonRequest';
import { loadAssistantLifeDay } from '../ai/assistantLifeTimeline';
import { loadAssistantState } from '../ai/assistantState';
import type { AiConnection, AiProfile } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, captureBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { loadChatStateFast } from '../chat/chatStorage';
import { buildJunluoDesirePromptPaper } from '../life/junluoDesireMetabolism';
import { isWantsClockOwner, loadJunluoDesireSnapshot } from '../life/junluoDesireRuntime';
import { BAIYUN_EMOTION_LABELS } from '../life/junluoInnerStatePresentation';
import { loadJunluoAffectState } from '../life/junluoInnerStateStore';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { buildBaiyunPostMaterials, canPublishBaiyunPost, markBaiyunPostAttempt, postDateKey, recentCompletePostChat } from './baiyunPostContract';
import { buildPostPublishTask, parsePostPublishResult } from './baiyunPostReplyMaterials';
import { createLocalBaiyunPost, loadBaiyunPostRuntime, loadLocalBaiyunPostPage, saveBaiyunPostComment, updateBaiyunPostRuntime } from './baiyunPostStore';
import { loadPostTags } from './baiyunPostTags';

let publishing = false;

async function collectPostMaterials(now: number) {
  const [status, affect, desire, chatState, day, page, policy] = await Promise.all([
    loadAssistantState(), loadJunluoAffectState(), loadJunluoDesireSnapshot(now), loadChatStateFast(),
    loadAssistantLifeDay(postDateKey(now)), loadLocalBaiyunPostPage(), loadAutomaticRemoteAiPolicy(),
  ]);
  const posts = page.posts.filter(post => post.author === 'I').slice(0, 2)
    .map(post => ({ ...post, title: post.title ?? '', legacy: false }));
  const active = chatState.sessions.find(session => session.id === chatState.activeSessionId);
  const chat = recentCompletePostChat((active?.messages ?? []).filter(message =>
    (!message.source || message.source === 'chat') && message.content.trim()).map(message => ({
      id: message.id, role: message.role, content: message.content, createdAt: message.createdAt,
    })));
  const savedStatus = status.sourceType !== 'default' && status.updatedAt > 0 ? status : undefined;
  const life = (day?.timelineEntries ?? []).filter(entry => !savedStatus ||
    entry.title !== savedStatus.title || entry.activity !== savedStatus.activity).slice(-2);
  const emotions = [affect.emotions.primary, ...affect.emotions.secondary.slice(0, 1)].filter(entry => entry !== null);
  const emotion = emotions.length ? { text: emotions.map(entry => BAIYUN_EMOTION_LABELS[entry.emotionId]).join('、'), at: emotions[0].occurredAt } : undefined;
  const stateMaterial = savedStatus || emotion ? JSON.stringify({
    status: savedStatus ? [savedStatus.lifeMode, savedStatus.title, savedStatus.activity, savedStatus.lifeContext ?? ''] : null,
    emotions: emotions.map(entry => entry.emotionId),
  }) : '';
  return {
    refs: [...chat.map(message => `chat:${message.id}`), ...life.map(entry => `life:${entry.id}`)], stateMaterial,
    desire: desire.desires.speak_to_you.effectiveValue, lifeMode: status.lifeMode,
    automaticAllowed: isAutomaticRemoteAiAllowed(policy),
    material: buildBaiyunPostMaterials({ now, status: savedStatus ? { ...savedStatus,
      lifeModeText: { available: '日常', 'self-time': '自处', sleeping: '睡眠' }[savedStatus.lifeMode] } : undefined,
      emotion, desirePaper: buildJunluoDesirePromptPaper(desire), chat, lifeEntries: life, posts }),
  };
}

export async function maybePublishBaiyunPost(options: {
  apiKey?: string; connection?: AiConnection; profile: AiProfile; now?: number; proactiveSent: boolean;
}) {
  if (!isWantsClockOwner() || publishing || options.proactiveSent || !options.apiKey?.trim() || !options.connection) return false;
  publishing = true;
  const epoch = captureBackupRestoreDataEpoch();
  try {
    const materials = await collectPostMaterials(options.now ?? Date.now());
    const eligible = async () => canCommitBackupRestoreDataEpoch(epoch) && canPublishBaiyunPost({
      ...materials, now: Date.now(), proactiveSent: options.proactiveSent, runtime: await loadBaiyunPostRuntime(),
    });
    if (!await eligible()) return false;
    const tags = await loadPostTags();
    const task = buildPostPublishTask(tags);
    const envelope = await buildAssistantStatePairEnvelope({ contextSource: 'assistant-life.post', materialPrompt: materials.material, profile: options.profile });
    const connection = options.connection;
    const outcome = await runBudgetedAiCall('proactive', 'background', async () => {
      let started = false;
      try {
        if (!await eligible()) return false;
        const result = await fetchAssistantLifeCompletion({ apiKey: options.apiKey!, connection, contextSource: 'assistant-life.post', envelope,
          request: buildAssistantLifeShortJsonRequest(connection, 0.8), userPrompt: task,
          apiMessagesOverride: [{ role: 'system', content: envelope.apiMessages[0].content },
            { role: 'system', content: materials.material }, { role: 'system', content: task }],
          onRequestStart: async () => {
            const [currentStatus, policy] = await Promise.all([loadAssistantState(), loadAutomaticRemoteAiPolicy()]);
            if (currentStatus.lifeMode !== 'available' || !isAutomaticRemoteAiAllowed(policy) || !await eligible()) throw new Error('baiyun-post-not-due');
            await updateBaiyunPostRuntime(state => markBaiyunPostAttempt(state, Date.now(), materials.refs, materials.stateMaterial), epoch);
            started = true;
          },
        });
        const post = parsePostPublishResult(result.content, (await loadPostTags()).filter(current =>
          tags.some(offered => offered.id === current.id && (offered.scope === 'I' || offered.scope === 'both'))));
        if (!post || (result.finishReason != null && result.finishReason !== 'stop' && result.finishReason !== 'end_turn')) return started;
        await runBackupRestoreDataEpochCommit(epoch, () => createLocalBaiyunPost({ ...post, author: 'I', imageGroup: null }));
      } catch { /* A paid failure consumes this material; no automatic retry or invented post. */ }
      return started;
    }, { connection, dataEpoch: epoch, shouldRecordSuccess: Boolean });
    return outcome.ok && outcome.value;
  } finally {
    publishing = false;
    await import('./baiyunPostNotifications').then(module => module.resumePostNotifications()).catch(() => undefined);
  }
}

/** Compatibility entry used by the existing life engine; it drains only a saved viewing choice. */
export async function resumeSleepingBaiyunPostReply() {
  return (await import('./baiyunPostReplyRuntime')).drainPostReplies();
}
export async function submitBaiyunPostComment(postId: string, content: string) {
  const source = `baiyun-post-comment:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  return saveBaiyunPostComment({ postId, content, author: 'you', source });
}
export async function retryBaiyunPostReply(postId: string, source: string) {
  return (await import('./baiyunPostReplyRuntime')).retryPostReply(postId, source);
}
// Legacy UI imports this synchronous flag; the current page uses the local committed callback.
export { isPostReplyActive as isBaiyunPostReplyPending } from './baiyunPostReplyRuntime';
