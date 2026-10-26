export type TodoType = 'normal' | 'inhibit';
export type InhibitOutcome = 'kept' | 'slipped' | 'unrecorded';

const POSITIVE_REMINDER_PREFIX = /^(?:不要忘记|别忘(?:了|记)?)/;
const INHIBIT_PREFIX = /^(?:不要|别(?!忘)|避免|忍住(?:不|别)|少(?:看|刷|吃|喝|碰|抓|挠|熬|玩|买))/;

export function inferTodoType(value: string): TodoType {
  const normalized = value.trim().replace(/^[，。！？、：:\s]+/, '');
  if (!normalized || POSITIVE_REMINDER_PREFIX.test(normalized)) return 'normal';
  return INHIBIT_PREFIX.test(normalized) ? 'inhibit' : 'normal';
}
