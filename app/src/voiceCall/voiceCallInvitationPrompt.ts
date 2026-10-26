export const BAIYUN_SCHEDULED_CALL_OPENING_PROMPT = `【约定来电】

I 记得和 you 约好的这通电话，主动打来了。

接通后，I 先提及我们约好的事，也说说此刻的心情或刚冒出的念头。`;

export const BAIYUN_AUTONOMOUS_CALL_OPENING_PROMPT = `【主动来电】

I 主动给 you 打电话。接通后，I 顺着这次来电的缘由和此刻还放在心上的事，先对 you 说一两句。`;

export const MISSED_CALL_TIMEOUT_TEXT = '这通电话响到结束，you 没有接到。';
export const MISSED_CALL_DECLINED_TEXT = 'you 当时没有接听这通电话。';

export function formatVoiceCallPromptTime(value: number) {
  const date = new Date(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

export function buildScheduledVoiceCallMaterial(scheduledAt: number, note: string) {
  return `【这次约定】

约定时间：${formatVoiceCallPromptTime(scheduledAt)}
约定内容：${note.trim()}`;
}

export function buildMissedVoiceCallMaterial(input: {
  calledAt: number;
  note?: string;
  outcome: 'declined' | 'timeout';
  scheduledAt?: number;
}) {
  const missed = `【没有接通的来电】

${formatVoiceCallPromptTime(input.calledAt)}，I 主动给 you 打过电话。
${input.outcome === 'declined' ? MISSED_CALL_DECLINED_TEXT : MISSED_CALL_TIMEOUT_TEXT}`;
  if (!input.note?.trim() || !input.scheduledAt) return missed;
  return `${buildScheduledVoiceCallMaterial(input.scheduledAt, input.note)}\n\n${missed}`;
}
