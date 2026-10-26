import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import { registerBaiyunPendingShareExchange } from '../ai/behavior/actionShareResponseStore';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { loadChatState } from '../chat/chatStorage';
import {
  loadWebVoyageLog, markWebVoyageChatShareDelivered, type WebVoyageLogEntry,
} from '../life/webVoyage';
import { createProactiveMessageDeliveryMessageIdPrefix } from './proactiveMessageExecutionOnceCore';
import { isWebVoyageShareableReading, webVoyageReadingStatusText } from '../life/webVoyageReading';

export type WebVoyageChatHandoff = { entry: WebVoyageLogEntry; instruction: string };

export function buildWebVoyageChatHandoffInstruction(entry: WebVoyageLogEntry) {
  return [
    '【还没说给 you 听的见闻】',
    '',
    `记录时间：${formatChatAfterglowMessageTime(entry.at)}`,
    webVoyageReadingStatusText(entry.readingStatus, entry.sourceType),
    entry.summary,
    ...(entry.title ? [`出处：${entry.title}`] : []),
    ...(entry.url ? [entry.url] : []),
    '',
    '上次消息发送失败，这份见闻还没送到 you 那边。',
    '',
    'I 还想和 you 分享，趁这次聊天说给 you 听。',
    '',
    '说起这份见闻时，I 会把原链接一起发给 you。',
  ].join('\n');
}

function isEligible(entry: WebVoyageLogEntry) {
  return entry.status === 'completed' && entry.shareStatus === 'failed'
    && isWebVoyageShareableReading(entry)
    && Number.isFinite(entry.shareChatHandoffAt) && entry.shareCancelledAt === undefined
    && !!entry.summary?.trim() && !!entry.url && /^https?:\/\//u.test(entry.url);
}

export function selectWebVoyageChatHandoff(entries: readonly WebVoyageLogEntry[]): WebVoyageChatHandoff | null {
  const entry = entries.filter(isEligible)
    .sort((left, right) => left.at - right.at || left.id.localeCompare(right.id))[0];
  return entry ? { entry, instruction: buildWebVoyageChatHandoffInstruction(entry) } : null;
}

export function isSameWebVoyageChatHandoff(handoff: WebVoyageChatHandoff, current?: WebVoyageLogEntry) {
  return !!current && isEligible(current) && (
    ['id', 'at', 'summary', 'title', 'url', 'query', 'readingStatus', 'sourceType', 'shareChatHandoffAt'] as const
  ).every(key => handoff.entry[key] === current[key]);
}

/** Compare actual HTTP links, never the title, a phrase, or a URL-shaped prefix. */
export function hasWebVoyageChatShareLink(content: string, url: string) {
  const actualTargets = content.replace(/!?\[[^\]\n]*\]\(([^\s\n]*?)(?:\s+"[^"\n]*")?\)/gu,
    (_link, target: string) => ` ${target} `);
  const links: string[] = actualTargets.match(/https?:\/\/[^\s<>"“”‘’「」『』，。！？；、]+/gu) ?? [];
  return links.some(link => link === url || link.replace(/[）】)\]}'.,!?;:]+$/gu, '') === url);
}

export async function prepareWebVoyageChatHandoff(): Promise<WebVoyageChatHandoff | null> {
  const entries = await loadWebVoyageLog();
  let handoff = selectWebVoyageChatHandoff(entries);
  if (!handoff) return null;
  // A receipt can fail after an old dedicated share was actually saved. Do not send it again.
  const { sessions } = await loadChatState();
  while (handoff) {
    const prefix = `${createProactiveMessageDeliveryMessageIdPrefix({
      scope: 'proactive.web-voyage-share', entityId: handoff.entry.id, createdAt: handoff.entry.at,
    })}-`;
    const saved = sessions.flatMap(session => session.messages)
      .find(message => message.role === 'I' && message.id.startsWith(prefix));
    if (!saved) return handoff;
    // Preparation stays read-only; the original delivery path owns its receipt reconciliation.
    const index = entries.findIndex(entry => entry.id === handoff!.entry.id);
    entries.splice(index, 1);
    handoff = selectWebVoyageChatHandoff(entries);
  }
  return null;
}

export async function isWebVoyageChatHandoffCurrent(handoff: WebVoyageChatHandoff) {
  return isSameWebVoyageChatHandoff(handoff,
    (await loadWebVoyageLog()).find(entry => entry.id === handoff.entry.id));
}

/** Called only after the final visible bubbles and their session have been saved. */
export async function commitWebVoyageChatHandoff(input: {
  handoff: WebVoyageChatHandoff;
  messages: readonly SubjectiveMessage[];
  sessionId: string;
  deliveredAt: number;
  canCommit: () => boolean;
}) {
  const delivered = input.messages.filter(message => message.role === 'I'
    && message.deliveryStatus !== 'failed'
    && hasWebVoyageChatShareLink(message.content, input.handoff.entry.url!));
  if (!delivered.length || !input.canCommit()) return false;
  // Mark the original finding first: a failed auxiliary registration must not re-offer it.
  if (!await markWebVoyageChatShareDelivered(input.handoff.entry, input.deliveredAt, input.canCommit)) return false;
  if (!input.canCommit()) return false;
  await registerBaiyunPendingShareExchange({
    sessionId: input.sessionId, origin: 'web_voyage', invitationKind: 'self_driven',
    sourceMessageIds: delivered.map(message => message.id), responseDriveKeys: ['social'],
    excerpt: delivered.map(message => message.content).join('\n'), now: input.deliveredAt,
  });
  return true;
}
