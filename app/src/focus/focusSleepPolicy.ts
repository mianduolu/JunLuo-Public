export type FocusSleepLogKind = 'opening' | 'preparing' | 'motion' | 'waking';

const SLEEP_MOTION_TASK = `【I 睡着，you 在旁边专注】

I 安静地睡在 you 身旁，偶尔发出一些睡着后的小动静。

{"message":"..."}

正文用自然中文，不写 I／you，只发送这个 JSON。`;

export const JUNLUO_FOCUS_SLEEP_TASK_PROMPTS: Record<FocusSleepLogKind, string> = {
  opening: SLEEP_MOTION_TASK,
  preparing: `【I 准备睡觉，you 还在专注】

I 想睡觉啦，睡前轻轻和 you 说一声。

{"message":"..."}

正文用自然中文，不写 I／you，只发送这个 JSON。`,
  motion: SLEEP_MOTION_TASK,
  waking: `【I 刚醒来，you 在旁边专注】

I 醒来啦，迷迷糊糊地跟 you 说一声。

{"message":"..."}

正文用自然中文，不写 I／you，只发送这个 JSON。`,
};

export function buildFocusSleepStatePaper(input: { kind: FocusSleepLogKind; userActivity: string }) {
  const state = input.kind === 'preparing' ? '醒着，准备睡觉' : input.kind === 'waking' ? '刚醒来' : '睡着';
  return `【这次专注的已确认状态】

I 此刻：${state}
you 这次要做：${input.userActivity}
专注阶段：${input.kind === 'opening' ? '刚开始' : '进行中'}`;
}

export function focusSleepLogTrigger(kind: FocusSleepLogKind, eventKey?: string) {
  const base = `focus-sleep-${kind}`;
  return (kind === 'preparing' || kind === 'waking') && eventKey ? `${base}:${eventKey}` : base;
}

/** The saved anchor identity keeps the 45–60 minute interval stable across restarts. */
export function focusSleepMotionIntervalMs(anchorId: string) {
  let hash = 2166136261;
  for (let index = 0; index < anchorId.length; index += 1) {
    hash = Math.imul(hash ^ anchorId.charCodeAt(index), 16777619);
  }
  return 45 * 60_000 + (hash >>> 0) % (15 * 60_000 + 1);
}
