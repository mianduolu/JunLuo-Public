import { registerBaiyunPendingShareExchange } from '../ai/behavior/actionShareResponseStore';
import { formatNearStatusWebVoyage } from '../ai/nearStatusLifeMaterialFormat';
import { fingerprintPromptText } from '../ai/promptCacheMetrics';
import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import {
  commitWebVoyageUnifiedShare, hasWebVoyageShareAttempt, loadWebVoyageLog,
  loadWebVoyageShareQueue, type WebVoyageLogEntry,
} from '../life/webVoyage';
import {
  consumeNearbyWorldActiveEvent, loadPendingNearbyWorldActiveEvents, type NearbyWorldActiveEvent,
} from '../nearby/nearbyWorldActiveEvents';
import { hasWebVoyageChatShareLink } from './webVoyageChatHandoff';
import { loadSocialActionLog, type SocialActionLogEntry } from '../life/socialAgent';
import { changeUnifiedContactState, readUnifiedContactState } from './unifiedContactStore';
import { isWebVoyageShareableReading } from '../life/webVoyageReading';

export type UnifiedContactShareRef = { id: string; version: string; kind: 'web' | 'nearby' | 'social' };
export type UnifiedContactShareMaterial = UnifiedContactShareRef & { text: string; externalActionRecorded?: boolean; occurredAt?: number };

function webVersion(entry: WebVoyageLogEntry) {
  return fingerprintPromptText(JSON.stringify([entry.id, entry.at, entry.query, entry.title, entry.summary, entry.url,
    entry.sourceType, entry.readingStatus]));
}

function nearbyVersion(event: NearbyWorldActiveEvent) {
  return fingerprintPromptText(JSON.stringify(event));
}

function socialVersion(entry: SocialActionLogEntry) {
  return fingerprintPromptText(JSON.stringify([entry.id, entry.at, entry.platform, entry.action, entry.status, entry.detail]));
}

export function formatUnifiedSocialFacts(entry: SocialActionLogEntry): string {
  return `【最近的生活】\n\n社交记录：${entry.platform}／${entry.action}\n记录时间：${formatChatAfterglowMessageTime(entry.at)}\n执行状态：${entry.status}\n${entry.detail}`;
}

function isWebSource(entry: WebVoyageLogEntry) {
  return entry.status === 'completed' && entry.shareCancelledAt === undefined
    && isWebVoyageShareableReading(entry)
    && !!entry.summary?.trim() && !!entry.url && /^https?:\/\//u.test(entry.url);
}

/** Only the previously reviewed fact lines, not the retired standalone task or fallback. */
export function formatUnifiedNearbyFacts(event: NearbyWorldActiveEvent, now: number) {
  const kind = {
    walking: '发现小仓鼠正在一起走', transit: '发现小仓鼠在交通工具上',
    'arrived-home': '发现小仓鼠到家附近', 'left-home': '发现小仓鼠离家变远',
    'location-unstable': '发现位置状态不太稳',
  }[event.kind];
  const distance = event.distanceFromHome;
  const distanceText = typeof distance !== 'number' || !Number.isFinite(distance) ? '未知'
    : distance >= 1000 ? `${(distance / 1000).toFixed(distance >= 3000 ? 0 : 1)}公里`
      : `${Math.max(10, Math.round(distance / 10) * 10)}米`;
  const time = new Date(now).toLocaleString('zh-CN', {
    day: 'numeric', hour: '2-digit', hour12: false, minute: '2-digit', month: 'long', weekday: 'long', year: 'numeric',
  });
  return [
    `当前时间：${time}`,
    `记录时间：${formatChatAfterglowMessageTime(event.at)}`,
    `附近世界状态变化：${kind}`,
    `附近位置摘要：${event.placeLabel || '未知'}`,
    `详细地址：${event.address || '无'}`,
    `附近参照：${event.nearbyReferences.length ? event.nearbyReferences.join('；') : '无'}`,
    `离家的粗略距离：${distanceText}`,
    `定位质量：${event.gpsQuality ? { excellent: '很好', good: '不错', fair: '有些不稳', poor: '不太可靠' }[event.gpsQuality] : '未知'}`,
    `一起状态：${event.precisionMode === 'walking' ? '一起走' : event.precisionMode === 'transit' ? '交通工具上' : '未开启'}`,
    `定位精度：${typeof event.accuracy === 'number' ? `约 ${Math.round(event.accuracy)} 米` : '未知'}`,
  ].join('\n');
}

/** Read-only candidates; the unified opportunity chooses its own complete 8/1000 material bundle. */
export async function prepareUnifiedContactShares(now = Date.now()): Promise<UnifiedContactShareMaterial[]> {
  const [queue, log, nearby, social, state] = await Promise.all([
    loadWebVoyageShareQueue(), loadWebVoyageLog(), loadPendingNearbyWorldActiveEvents(),
    loadSocialActionLog(), readUnifiedContactState(now),
  ]);
  const candidates: Array<UnifiedContactShareMaterial & { at: number }> = [];
  const queued = new Set(queue.map(item => item.logId));
  for (const entry of log) {
    if (entry.at > now || !queued.has(entry.id) || !isWebSource(entry)
      || entry.shareStatus === 'delivered' || hasWebVoyageShareAttempt(entry)) continue;
    candidates.push({
      id: entry.id, kind: 'web', version: webVersion(entry), at: entry.at,
      text: formatNearStatusWebVoyage(entry),
    });
  }
  for (const event of nearby) {
    if (event.at <= now) candidates.push({
      id: event.id, kind: 'nearby', version: nearbyVersion(event), at: event.at,
      text: formatUnifiedNearbyFacts(event, now),
    });
  }
  const handledSocial = new Set(state.handledSocialIds ?? []);
  for (const entry of social) {
    if (entry.at >= state.initializedAt && entry.at <= now && entry.detail.trim() && !handledSocial.has(entry.id)) {
      candidates.push({ id: entry.id, kind: 'social', version: socialVersion(entry), at: entry.at,
        text: formatUnifiedSocialFacts(entry), externalActionRecorded: entry.status === 'completed' });
    }
  }
  return candidates.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .map(({ at, ...item }) => ({ ...item, occurredAt: at }));
}

export async function validateUnifiedContactShare(ref: UnifiedContactShareRef): Promise<boolean> {
  if (ref.kind === 'social') {
    const state = await readUnifiedContactState();
    return !(state.handledSocialIds ?? []).includes(ref.id) && (await loadSocialActionLog()).some(entry =>
      entry.id === ref.id && entry.at >= state.initializedAt && entry.at <= Date.now() && socialVersion(entry) === ref.version);
  }
  if (ref.kind === 'nearby') {
    return (await loadPendingNearbyWorldActiveEvents()).some(event => event.id === ref.id && nearbyVersion(event) === ref.version);
  }
  const [queue, log] = await Promise.all([loadWebVoyageShareQueue(), loadWebVoyageLog()]);
  return queue.some(item => item.logId === ref.id) && log.some(entry => entry.id === ref.id
    && isWebSource(entry) && entry.shareStatus !== 'delivered' && !hasWebVoyageShareAttempt(entry)
    && webVersion(entry) === ref.version);
}

/** Only call after these exact I messages and their session have been durably saved. */
export async function commitUnifiedContactShares(
  refs: readonly UnifiedContactShareRef[], messages: readonly SubjectiveMessage[], sessionId: string,
  deliveredAt: number, canCommit: () => boolean = () => true,
): Promise<string[]> {
  const epoch = captureBackupRestoreDataEpoch();
  const current = () => canCommitBackupRestoreDataEpoch(epoch) && canCommit();
  const saved = messages.filter(message => message.role === 'I' && message.id
    && message.content.trim() && message.deliveryStatus !== 'failed');
  if (!saved.length || !sessionId || !current()) return [];
  const committed: string[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    if (!current()) break;
    const key = `${ref.kind}:${ref.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === 'social') {
      if (!await validateUnifiedContactShare(ref) || !current()) continue;
      // The caller supplies the durably saved whole reply, never the input facts as an excerpt.
      await registerBaiyunPendingShareExchange({ sessionId, origin: 'social_share', invitationKind: 'self_driven',
        sourceMessageIds: saved.map(message => message.id), responseDriveKeys: ['social'],
        excerpt: saved.map(message => message.content).join('\n'), now: deliveredAt });
      if (!await validateUnifiedContactShare(ref) || !current()) continue;
      await changeUnifiedContactState(state => {
        state.handledSocialIds = [...new Set([...(state.handledSocialIds ?? []), ref.id])];
        if (state.current?.sources.some(source => source.kind === ref.kind && source.id === ref.id && source.version === ref.version)) {
          state.current.handledSources = [...new Set([...(state.current.handledSources ?? []), key])];
        }
      }, epoch);
      committed.push(ref.id);
      continue;
    }
    if (ref.kind === 'nearby') {
      const event = (await loadPendingNearbyWorldActiveEvents())
        .find(item => item.id === ref.id && nearbyVersion(item) === ref.version);
      if (event && current() && await consumeNearbyWorldActiveEvent(event, epoch)) committed.push(ref.id);
      continue;
    }
    const entry = (await loadWebVoyageLog()).find(item => item.id === ref.id
      && isWebSource(item) && webVersion(item) === ref.version);
    if (!entry) continue;
    const linked = saved.filter(message => hasWebVoyageChatShareLink(message.content, entry.url!));
    if (!linked.length || !current()) continue;
    if (await commitWebVoyageUnifiedShare(entry, deliveredAt, () => registerBaiyunPendingShareExchange({
      sessionId, origin: 'web_voyage', invitationKind: 'self_driven',
      sourceMessageIds: linked.map(message => message.id), responseDriveKeys: ['social'],
      excerpt: linked.map(message => message.content).join('\n'), now: deliveredAt,
    }), current)) committed.push(ref.id);
  }
  return committed;
}
