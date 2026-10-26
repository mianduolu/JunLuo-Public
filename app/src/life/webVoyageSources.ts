import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { loadAssistantState } from '../ai/assistantState';
import { loadChatSessionMessage, loadChatSessionSnapshot } from '../chat/chatStorage';
import { PRIMARY_CHAT_SESSION_ID } from '../chat/primaryChat';
import { isAutomaticRemoteAiAllowed, loadAutomaticRemoteAiPolicy } from '../runtime/automaticRemoteAiPolicy';
import { loadCurrentSyncRelayEnrollment } from '../sync/syncRelayClientExpo';
import { AndroidSyncExecutionFenceV2SqlitePort } from '../sync/syncExecutionFenceSqlitePort';
import { isAutonomyFeatureEnabled, loadAutonomySettings } from './autonomySettings';
import { createLifeTickExecutionIdentity, createLifeTickOperationId } from './lifeTickExecutionOnceCore';
import { EXPLORATION_DRIVE_LABELS, type ExplorationExecutionIntent } from './explorationExecutionIntent';
import { loadWebVoyageLog, type WebVoyageLogEntry } from './webVoyage';
import { webVoyageReadingStatusText } from './webVoyageReading';
import { selectWebVoyageLifeMaterials } from './webVoyageLifeMaterialPolicy';

export function isWebVoyageChatSource(message: SubjectiveMessage) {
  return (message.role === 'I' || message.role === 'you') && !!message.content.trim()
    && !message.deliveryStatus && !message.theaterBackstagePending && !message.theaterBackstage
    && (!message.source || message.source === 'chat' || message.source === 'proactive-message'
      || message.source === 'life-message' || message.source === 'nearby-world-active');
}

const chatVersion = (message: SubjectiveMessage) => JSON.stringify([
  message.id, message.role, message.createdAt, message.content, message.source,
  message.deliveryStatus, message.theaterBackstage, message.theaterBackstagePending,
]);
const logVersion = (entry: WebVoyageLogEntry) => JSON.stringify([
  entry.id, entry.at, entry.status, entry.sourceType, entry.title, entry.url, entry.summary, entry.readingStatus,
  entry.shareCancelledAt,
]);

/** Keep exactly the complete sources sent, not just the pre-trim selection. */
export function buildWebVoyageTopicMaterial(
  messages: SubjectiveMessage[], logs: WebVoyageLogEntry[], intent: ExplorationExecutionIntent,
  maxChars = 6000, now = Date.now(),
) {
  const chats = messages.filter(isWebVoyageChatSource).slice(-6);
  const voyages = logs.filter(entry => entry.status === 'completed'
    && entry.shareCancelledAt === undefined && selectWebVoyageLifeMaterials([entry], now).length > 0
    && (!entry.readingStatus || entry.readingStatus === 'body_excerpt'))
    .sort((a, b) => b.at - a.at).slice(0, 2).reverse();
  const material = () => JSON.stringify({
    近期交流: chats.map(message => ({ role: message.role, 时间: new Date(message.createdAt).toISOString(), 正文: message.content })),
    最近见闻: voyages.map(entry => ({ 时间: new Date(entry.at).toISOString(), 标题: entry.title,
      链接: entry.url, 读取状态: webVoyageReadingStatusText(entry.readingStatus, entry.sourceType), 内容: entry.summary })),
    当前探索状态: { [EXPLORATION_DRIVE_LABELS[intent.driveKey]]: Math.round(intent.score * 100) + '%' },
  });
  while (material().length > maxChars && (chats.length || voyages.length)) {
    if (chats.length && (!voyages.length || chats[0].createdAt <= voyages[0].at)) chats.shift();
    else voyages.shift();
  }
  return { chats, voyages, material: material() };
}

export async function webVoyageRuntimeEnabled() {
  const [autonomy, remote, state] = await Promise.all([
    loadAutonomySettings({ strict: true }), loadAutomaticRemoteAiPolicy(), loadAssistantState(),
  ]);
  return isAutonomyFeatureEnabled(autonomy, 'webVoyageEnabled')
    && isAutonomyFeatureEnabled(autonomy, 'githubVoyageEnabled')
    && isAutonomyFeatureEnabled(autonomy, 'desireDrivenBehaviorEnabled')
    && isAutomaticRemoteAiAllowed(remote) && state.lifeMode !== 'sleeping';
}

export type WebVoyageSourceRefs = {
  owner: string | null;
  chats: Array<{ id: string; version: string }>;
  voyages: Array<{ id: string; version: string }>;
};

/** Resume old sources under this tick's existing ownership, never reopen its old fence. */
export async function captureWebVoyageSources(intent: ExplorationExecutionIntent, now: number, saved?: WebVoyageSourceRefs) {
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const owner = enrollment?.publicIdentity.deviceId ?? null;
  let material = '';
  let refs = saved;
  if (!refs) {
    const snapshot = await loadChatSessionSnapshot(PRIMARY_CHAT_SESSION_ID, { messageLimit: 30 });
    const sources = buildWebVoyageTopicMaterial(snapshot?.session.messages ?? [], await loadWebVoyageLog(), intent, 6000, now);
    material = sources.material;
    refs = { owner, chats: sources.chats.map(message => ({ id: message.id, version: chatVersion(message) })),
      voyages: sources.voyages.map(entry => ({ id: entry.id, version: logVersion(entry) })) };
  }
  const fixed = refs;
  const operationId = createLifeTickOperationId(createLifeTickExecutionIdentity(now));
  const fence = new AndroidSyncExecutionFenceV2SqlitePort();
  const initial = owner ? await fence.load(operationId) : null;
  const initialClaim = initial?.protocolVersion === 2 && initial.state === 'started'
    && initial.start?.claimantDeviceId === owner ? initial.start.claimId : null;
  const canRun = async () => {
      if (!await webVoyageRuntimeEnabled()) return false;
      const currentEnrollment = await loadCurrentSyncRelayEnrollment();
      if ((currentEnrollment?.publicIdentity.deviceId ?? null) !== owner) return false;
      if (owner) {
        const current = await fence.load(operationId);
        if (!initialClaim || current?.protocolVersion !== 2 || current.state !== 'started'
          || current.start?.claimId !== initialClaim || current.start.claimantDeviceId !== owner) return false;
      }
      return true;
  };
  const sourcesCurrent = async () => {
      if (fixed.owner !== owner) return false;
      const currentMessages = await Promise.all(fixed.chats.map(message => loadChatSessionMessage(PRIMARY_CHAT_SESSION_ID, message.id)));
      if (currentMessages.some((message, i) => !message || !isWebVoyageChatSource(message)
        || chatVersion(message) !== fixed.chats[i].version)) return false;
      const logs = await loadWebVoyageLog();
      return fixed.voyages.every(entry => {
        const current = logs.find(log => log.id === entry.id);
        return !!current && logVersion(current) === entry.version;
      });
  };
  return { material, refs: fixed, canRun, sourcesCurrent,
    isCurrent: async () => await canRun() && await sourcesCurrent() };
}
