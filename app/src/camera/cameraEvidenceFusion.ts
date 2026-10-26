import type { SubjectiveMessage } from '../ai/subjectiveMessages';
import type { PhoneActivityLog } from '../phoneActivity/phoneActivityStore';
import type { JunLuoToolResult } from '../tools/toolTypes';
import type { JunLuoToolAuditRecord } from '../tools/toolAuditTypes';
import type { CameraObservationRecallCandidate } from './cameraObservationTypes';
import { CAMERA_LOOK_ONCE_TOOL_ID, type CameraModelObservationSuccessData } from './cameraModelObservationMaterials';

const EVIDENCE_GUIDANCE = 'I 按各自标注的时间和来源理解本次画面、you 的自述、设备活动记录与过去观察，只使用每项材料能支持的部分。某项材料没有记录到的内容，仍按“没有记录到”理解。';
const RECALL_PREFIX = `【I 过去看见过的相关片段】

这些片段各自属于标注的拍摄时间。I 只在它与眼前对话确实相关时自然想起，并按原时间理解。画面、you 的自述和设备记录各自保留来源与时间，I 只使用每项材料能支持的部分。`;
export type RecentCameraObservationInput = {
  sessionId: string;
  recentMessages: readonly Pick<SubjectiveMessage, 'id' | 'role' | 'toolCallCards' | 'deliveryStatus'>[];
};

export type CameraObservationResponseContext = {
  evidenceGuidance: typeof EVIDENCE_GUIDANCE;
  phoneActivityWindow?: {
    from: string;
    through: string;
    items: Array<{
      appTitle: string;
      foregroundDurationMinutes: number;
      latestObservedAt: string;
    }>;
  };
};

/** Follow actual receipt/reply IDs, never the words or language of a question. */
export function getRecentCameraObservationActionIds(
  input: RecentCameraObservationInput,
  audits: readonly JunLuoToolAuditRecord[],
) {
  const ids = new Set<string>();
  const recent = input.recentMessages.filter(message => message.deliveryStatus !== 'failed').slice(-4);
  for (const message of [...recent].reverse()) {
    if (message.role !== 'I') continue;
    for (const card of message.toolCallCards ?? []) {
      if (card.toolId === CAMERA_LOOK_ONCE_TOOL_ID && card.status === 'success') ids.add(card.auditId ?? card.callId);
    }
    for (const audit of audits) {
      if (audit.toolId === CAMERA_LOOK_ONCE_TOOL_ID && audit.status === 'success'
        && audit.cameraReply?.sessionId === input.sessionId && audit.cameraReply.messageIds.includes(message.id)) {
        ids.add(audit.callId);
      }
    }
  }
  return [...ids].slice(0, 2);
}

function limited(value: string, maximum: number) {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function formatCapturedAt(capturedAt: number) {
  const date = new Date(capturedAt);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${offset < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

function formatObservation(candidate: CameraObservationRecallCandidate, index: number) {
  const { result } = candidate;
  const sections = [
    `【片段 ${index + 1}】`,
    `拍摄时间：${formatCapturedAt(candidate.capturedAt)}`,
    `摄像头来源：${candidate.sourceKind === 'pc_webcam' ? '电脑摄像头' : candidate.sourceKind === 'android_front' ? '手机前置摄像头' : '手机后置摄像头'}`,
    `画面可用性：${({ clear: '清楚', limited: '有限', unusable: '不可用' } as const)[result.frameUsability]}`,
    `人物身份关联：${result.subjectIdentities.some((identity) => identity.identity === 'you') ? '已确认是 you' : '未确认'}`,
    result.objectiveFacts.length ? `直接看见：\n${result.objectiveFacts.slice(0, 6).map((fact) => `- ${fact.text}（画面证据：${({ clear: '清楚', recognizable: '可辨认', partial: '局部' } as const)[fact.evidenceQuality]}）`).join('\n')}` : '',
    result.inferences.length ? `可能的理解：\n${result.inferences.slice(0, 2).map((inference) => `- ${inference.text}（把握：${inference.confidence === 'medium' ? '中' : '低'}）`).join('\n')}` : '',
    result.uncertainties.length ? `没看清或仍有多种解释：\n${result.uncertainties.slice(0, 2).map((uncertainty) => `- ${uncertainty.text}`).join('\n')}` : '',
    `当时的画面摘要：${result.sceneSummary}`,
    `整体把握：${({ low: '低', medium: '中', high: '高' } as const)[result.overallConfidence]}`,
  ].filter(Boolean).join('\n');
  return limited(sections, 900);
}

export function formatCameraObservationRecallMaterial(
  selected: readonly CameraObservationRecallCandidate[],
) {
  if (!selected.length) return '';
  return limited(`${RECALL_PREFIX}\n\n${selected.slice(0, 2).map(formatObservation).join('\n\n')}`, 1800);
}

export async function loadRecentCameraObservationMaterial(input: RecentCameraObservationInput) {
  if (!input.recentMessages.filter(message => message.deliveryStatus !== 'failed').slice(-4)
    .some(message => message.role === 'I')) return '';
  const { loadRecentToolCalls } = await import('../tools/toolAuditStore');
  const ids = getRecentCameraObservationActionIds(input, await loadRecentToolCalls(1000));
  const { getCameraObservationRecordByActionId, getCameraObservationRecord, listDeliveredCameraObservationResponses } = await import('./cameraObservationStore');
  const records = await Promise.all(ids.map(id => getCameraObservationRecordByActionId(id)));
  const responses = await listDeliveredCameraObservationResponses(input.sessionId,
    input.recentMessages.filter(message => message.deliveryStatus !== 'failed').slice(-4)
      .filter(message => message.role === 'I').map(message => message.id));
  const shared = await Promise.all(responses.map(response => getCameraObservationRecord(response.observationId).catch(() => undefined)));
  const unique = new Map([...shared, ...records].filter((record): record is NonNullable<typeof record> => !!record)
    .map(record => [record.observationId, record]));
  return formatCameraObservationRecallMaterial([...unique.values()].slice(0, 2));
}

function aggregatePhoneActivity(logs: readonly PhoneActivityLog[], from: number, through: number) {
  const totals = new Map<string, { durationMs: number; latestObservedAt: number }>();
  for (const log of logs) {
    const title = log.title.trim();
    if (!title || title === log.source.trim()) continue;
    const start = Math.max(from, log.started_at ?? log.created_at);
    const end = Math.min(through, log.ended_at ?? start + Math.max(0, log.duration_ms));
    if (end <= start) continue;
    const current = totals.get(title) ?? { durationMs: 0, latestObservedAt: 0 };
    current.durationMs += end - start;
    current.latestObservedAt = Math.max(current.latestObservedAt, end);
    totals.set(title, current);
  }
  return [...totals.entries()]
    .sort((left, right) => right[1].durationMs - left[1].durationMs || left[0].localeCompare(right[0], 'zh-CN'))
    .slice(0, 3)
    .map(([appTitle, item]) => ({
      appTitle,
      foregroundDurationMinutes: Math.max(0.1, Math.round(item.durationMs / 6000) / 10),
      latestObservedAt: new Date(item.latestObservedAt).toISOString(),
    }));
}

export function buildCameraObservationResponseContext(
  logs: readonly PhoneActivityLog[],
  capturedAt: number,
): CameraObservationResponseContext {
  const through = capturedAt;
  const from = through - 30 * 60_000;
  const items = aggregatePhoneActivity(logs, from, through);
  return {
    evidenceGuidance: EVIDENCE_GUIDANCE,
    ...(items.length ? { phoneActivityWindow: {
      from: new Date(from).toISOString(), through: new Date(through).toISOString(), items,
    } } : {}),
  };
}

export async function attachCameraObservationResponseContext(result: JunLuoToolResult): Promise<JunLuoToolResult> {
  if (result.toolId !== CAMERA_LOOK_ONCE_TOOL_ID || !result.ok || result.status !== 'success' || !result.data) return result;
  const data = result.data as CameraModelObservationSuccessData;
  if (!Number.isFinite(data.capturedAt)) return result;
  const through = data.capturedAt;
  const from = through - 30 * 60_000;
  let logs: PhoneActivityLog[] = [];
  if (data.sourceKind !== 'pc_webcam') try {
    const { loadPersistedPhoneUsageSegmentsOverlapping } = await import('../phoneActivity/phoneActivityStore');
    logs = await loadPersistedPhoneUsageSegmentsOverlapping(from, through);
  } catch {
    // Phone activity is optional context; an unavailable local store omits it.
  }
  return { ...result, data: { ...data, responseContext: buildCameraObservationResponseContext(logs, through) } };
}
