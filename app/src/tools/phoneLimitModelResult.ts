import { isPhoneLimitToolId } from './phoneLimitContract';
import type { JunLuoToolResult } from './toolTypes';

// These receipts are the texts approved in chapter 8A. Raw native/host errors
// remain in the local result; only this phone-specific envelope reaches I.
const QUERY_SUMMARIES = ['手机情况已读取。', '只读到部分手机情况。'] as const;
const SUCCESS_SUMMARIES: Record<string, readonly string[]> = {
  'phone_limit.get_status': QUERY_SUMMARIES,
  'phone_limit.start': ['本次锁定已设置。', '这次锁定已经结束。'],
  'phone_limit.shorten': ['这次锁定的时间已缩短。', '这次锁定的时间没有改变。', '这次锁定已经结束。'],
  'phone_limit.end': ['这次锁定已经结束。'],
  'phone_limit.release_app': ['本次 App 放行已设置。', '这次 App 放行已经结束。'],
  'phone_limit.set_plan': ['计划已保存。', '计划没有改变。'],
};

export type PhoneLimitModelResult = {
  ok: boolean;
  status: JunLuoToolResult['status'] | 'outcome_unknown';
  summary: string;
  data: unknown;
  dataOmitted?: true;
};

function emptyActionData(toolId: string): unknown {
  if (toolId === 'phone_limit.get_status') return null;
  if (toolId === 'phone_limit.start') return { lock: null, display: null };
  if (toolId === 'phone_limit.release_app') return { release: null };
  if (toolId === 'phone_limit.set_plan') return { plans: null };
  return { lock: null };
}

function notStartedSummary(toolId: string) {
  if (toolId === 'phone_limit.get_status') return '暂时读不到手机情况。';
  if (toolId === 'phone_limit.start') return '本次锁定未开始。';
  if (toolId === 'phone_limit.set_plan') return '本次计划设置未执行。';
  return '本次调整未执行。';
}

function unknownSummary(toolId: string) {
  if (toolId === 'phone_limit.start') return '暂时无法确认锁定结果。';
  if (toolId === 'phone_limit.set_plan') return '暂时无法确认计划设置结果。';
  return '暂时无法确认调整结果。';
}

/** Call only at a rejection that occurs before dispatch, never in a catch. */
export function phoneLimitPreExecutionResult(result: JunLuoToolResult): JunLuoToolResult {
  if (!isPhoneLimitToolId(result.toolId)) return result;
  return { ...result, summary: notStartedSummary(result.toolId), data: emptyActionData(result.toolId) };
}

export function projectPhoneLimitModelResult(result: JunLuoToolResult): PhoneLimitModelResult | null {
  if (!isPhoneLimitToolId(result.toolId)) return null;
  const data = result.data === undefined ? emptyActionData(result.toolId) : result.data;
  if (result.ok && result.status === 'success' && SUCCESS_SUMMARIES[result.toolId].includes(result.summary)) {
    return { ok: true, status: 'success', summary: result.summary, data };
  }
  if (result.toolId === 'phone_limit.get_status') {
    return { ok: false, status: result.status === 'permission_denied' || result.status === 'cancelled'
      ? result.status : 'error', summary: '暂时读不到手机情况。', data: null };
  }
  // An approved, explicit non-execution receipt is proof supplied by the host
  // or domain executor. A generic error code, cancellation, or timeout is not.
  if (!result.ok && result.summary === notStartedSummary(result.toolId)) {
    return { ok: false, status: result.status === 'permission_denied' || result.status === 'cancelled'
      ? result.status : 'error', summary: result.summary, data };
  }
  const summary = result.toolId === 'phone_limit.set_plan'
    && result.summary === '计划设置已保存，暂时无法确认手机是否采用。'
    ? result.summary : unknownSummary(result.toolId);
  return { ok: false, status: 'outcome_unknown', summary, data };
}

export function serializePhoneLimitModelResult(
  result: JunLuoToolResult,
  maximumCharacters: number,
  forceDataOmitted = false,
): string | null {
  const envelope = projectPhoneLimitModelResult(result);
  if (!envelope) return null;
  if (!forceDataOmitted) {
    try {
      const content = JSON.stringify(envelope);
      if (content.length <= maximumCharacters) return content;
    } catch { /* Unserializable data is omitted with the same actual receipt. */ }
  }
  return JSON.stringify({ ...envelope, data: null, dataOmitted: true });
}

/** Reserve the indivisible receipt before allocating the round's data budget. */
export function phoneLimitMinimumResultCharacters(result: JunLuoToolResult) {
  return serializePhoneLimitModelResult(result, 0, true)?.length ?? 0;
}

export type PhoneLimitDiscoveryAttachment = {
  summary: string;
  data: unknown;
  dataOmitted?: true;
};

/** Called after the host has actually qualified and performed get_status. */
export function phoneLimitDiscoveryAttachment(result: JunLuoToolResult): PhoneLimitDiscoveryAttachment {
  if (result.toolId !== 'phone_limit.get_status') throw new Error('PHONE_LIMIT_QUERY_REQUIRED');
  const receipt = projectPhoneLimitModelResult(result)!;
  return { summary: receipt.summary, data: receipt.data };
}

// Package discovery does not go through resultMessage. Apply the same existing
// per-result/round budget to just the phone attachment, preserving other packs.
export function serializePhoneLimitDiscoveryResult(
  envelope: Record<string, unknown>,
  attachment: PhoneLimitDiscoveryAttachment,
  maximumCharacters: number,
) {
  try {
    const content = JSON.stringify({ ...envelope, phone: attachment });
    if (content.length <= maximumCharacters) return content;
  } catch { /* Preserve the read receipt when the data cannot be serialized. */ }
  return JSON.stringify({ ...envelope, phone: { summary: attachment.summary, data: null, dataOmitted: true } });
}
