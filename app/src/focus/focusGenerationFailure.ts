import { classifyChatReplyFailure, type ChatReplyFailureCode } from '../chat/chatReplyFailure';
import type { ChatReplyDiagnostics } from '../ai/openAiCompatibleProvider';

export type FocusGenerationFailure = {
  code: ChatReplyFailureCode | 'focus_configuration_missing';
  timeoutMs?: number;
  httpStatus?: number;
};

export function reportFocusGenerationFailure(observer: ((failure: FocusGenerationFailure) => void) | undefined, failure: FocusGenerationFailure) {
  try { observer?.(failure); } catch { /* A technical observer must not change the generation result. */ }
}

export function classifyFocusGenerationFailure(error: unknown, timeoutMs = 120_000): FocusGenerationFailure {
  const { code } = classifyChatReplyFailure({ error, dataEpochCurrent: true });
  const status = error && typeof error === 'object' ? (error as { httpStatus?: unknown }).httpStatus : undefined;
  return { code,
    ...(code === 'model_timeout' && (timeoutMs === 20_000 || timeoutMs === 120_000) ? { timeoutMs } : {}),
    ...(typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
  };
}

export function focusReplyGenerationFailure(error: unknown) {
  return { contents: [] as string[], rawEnvelope: '', failure: classifyFocusGenerationFailure(error) };
}

export function focusEmptyReplyFailure(diagnostics?: Pick<ChatReplyDiagnostics, 'visibleReplyStatus' | 'visibleReplyFailureReason'>): FocusGenerationFailure {
  return { code: diagnostics?.visibleReplyStatus === 'structure_invalid'
    || diagnostics?.visibleReplyFailureReason === 'messages_malformed'
    ? 'visible_envelope_invalid' : 'model_visible_text_missing' };
}

export function formatFocusGenerationFailure(failure: FocusGenerationFailure | undefined, prefix: string) {
  if (!failure) return prefix;
  let reason: string;
  switch (failure.code) {
    case 'focus_configuration_missing': reason = '模型连接尚未配置完整。'; break;
    case 'model_timeout': reason = failure.timeoutMs === 20_000 || failure.timeoutMs === 120_000
      ? `等待模型回复超过 ${failure.timeoutMs / 1000} 秒，本次请求已停止。` : '等待模型回复超时。'; break;
    case 'model_network_failed': reason = '连接模型服务失败。'; break;
    case 'model_authentication_failed': reason = '模型服务拒绝了身份或权限验证。'; break;
    case 'model_http_failed': reason = '模型服务返回错误状态。'; break;
    case 'provider_payload_invalid': reason = '模型服务返回的数据无法解析。'; break;
    case 'visible_envelope_invalid': reason = '回复正文的格式无法解析。'; break;
    case 'model_visible_text_missing': reason = '模型没有返回可显示的正文。'; break;
    case 'model_cancelled': reason = '本次模型请求已取消。'; break;
    default: reason = '暂未识别具体失败原因。';
  }
  const status = failure.httpStatus;
  const http = (failure.code === 'model_http_failed' || failure.code === 'model_authentication_failed')
    && typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? `（HTTP ${status}）` : '';
  return `${prefix}\n原因：${reason}${http}`;
}
