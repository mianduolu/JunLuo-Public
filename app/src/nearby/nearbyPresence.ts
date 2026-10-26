import { numberCareMessages, type CareSourceMessage } from '../ai/behavior/chatCareUpdates';
import { resolveNearbyPresence } from './nearbyLocationPolicy';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { runNearbyWorldDataEpochCommit } from './nearbyWorldEpochCoordinator';
import { loadNearbyWorldStatus, saveNearbyWorldStatus, type NearbyWorldStatus } from './nearbyWorldStore';
import { nearbyOutingEvidenceKey } from './nearbyOuting';
import { recordNearbyOutingHomeReportWithinCommit } from './nearbyWorldActiveEvents';

export const CHAT_PRESENCE_GUIDANCE = `【you 刚说明的位置状态】

I 结合完整语境，留意 you 本轮亲口说明的、此刻已经发生的位置变化，在原回复 JSON 的最后用 presenceUpdate 记下来：

{"state":"在外","from":3,"quote":"我出门啦"}

state：you 此刻明确说明的状态，填“在家”“在外”或“不确定”。
from：对应的 you 新消息在本次材料中的序号。
quote：从这条消息里原样摘出说明当前情况的片段。

同轮有多次明确更新时，记录最后一次。有新情况才添加 presenceUpdate，其余轮次沿用原回复结构。`;

export function parsePresenceUpdate(raw: string, messages: readonly CareSourceMessage[], newMessageIds: readonly string[], sessionId: string): NearbyWorldStatus['presenceReport'] {
  try {
    const value = JSON.parse(raw)?.presenceUpdate;
    if (!value || !['在家', '在外', '不确定'].includes(value.state) || !Number.isInteger(value.from)
      || typeof value.quote !== 'string' || !value.quote.trim()) return undefined;
    const source = numberCareMessages(messages).find(message => message.messageIndex === value.from);
    if (!source || source.role !== 'you' || !newMessageIds.includes(source.id) || !source.text.includes(value.quote)) return undefined;
    return { state: value.state, quote: value.quote, sourceText: source.text, messageId: source.id, sessionId, sentAt: source.sentAt };
  } catch { return undefined; }
}

export async function presenceReportIsCurrent(report: NearbyWorldStatus['presenceReport']): Promise<boolean> {
  if (!report) return false;
  const { PRIMARY_CHAT_SESSION_ID } = await import('../chat/primaryChat');
  if (report.sessionId !== PRIMARY_CHAT_SESSION_ID) return false;
  const { loadChatSessionMessage } = await import('../chat/chatStorage');
  const source = await loadChatSessionMessage(report.sessionId, report.messageId);
  return Boolean(source && source.role === 'you' && source.createdAt === report.sentAt && source.content === report.sourceText
    && source.content.includes(report.quote));
}

/** Read-only validation: deleted/changed sources are never reused or reconstructed. */
export async function withValidPresenceReport(status: NearbyWorldStatus): Promise<NearbyWorldStatus> {
  const report = status.presenceReport;
  const valid = report && await presenceReportIsCurrent(report);
  const next = valid ? status : { ...status, presenceReport: undefined };
  return { ...next, presence: resolveNearbyPresence(next) };
}

/** Runs inside the caller's existing data-epoch commit, after the adopted reply is saved. */
export async function commitPresenceUpdate(report: NearbyWorldStatus['presenceReport']) {
  if (!report || !await presenceReportIsCurrent(report)) return;
  await runNearbyWorldDataEpochCommit(captureBackupRestoreDataEpoch(), async () => {
    if (!await presenceReportIsCurrent(report)) return;
    const current = await loadNearbyWorldStatus();
    if (current.presenceReport && current.presenceReport.sentAt > report.sentAt) return;
    const next = { ...current, presenceReport: report };
    if (report.state === '在家') {
      await recordNearbyOutingHomeReportWithinCommit({ sessionId: report.sessionId, messageId: report.messageId,
        createdAt: report.sentAt, quote: report.quote,
        revision: nearbyOutingEvidenceKey([report.messageId, 'you', report.sentAt, report.sourceText]) });
    }
    await saveNearbyWorldStatus({ ...next, presence: resolveNearbyPresence(next),
      precisionArrivedHomeSince: report.state === '在家' && resolveNearbyPresence(next) !== 'outside' ? report.sentAt : undefined });
  });
}
