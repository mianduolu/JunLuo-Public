export function choosePhoneCareDelayMs(random = Math.random): number {
  return 300_000 + Math.floor(random() * 300_001);
}
export const PHONE_CARE_GRACE_MS = 10 * 60_000;

export type PhoneCareFollowUp = {
  schemaVersion: 1;
  eventId?: string;
  triggerId: string;
  ruleId: string;
  sessionId: string | null;
  lastIMessageId: string;
  lastContactAt: number;
  careReason: string;
  dueAt: number;
  expiresAt: number;
  nextCheckAt: number;
  revision: number;
  requestClaimed: boolean;
  status: 'waiting' | 'prepared' | 'finished';
  preparedMessage?: string;
  pausedYouMessageId?: string;
  finishedReason?: string;
  lastYouMessageId?: string;
  lastIContentKey?: string;
  preparedContextKey?: string;
};

export type PhoneCareVariant = 'awake' | 'before_sleep' | 'sleeping';

export const PHONE_CARE_TASKS: Readonly<Record<PhoneCareVariant, string>> = {
  awake: `【再来看看 you】

过了一会儿，I 想来问问 you 现在怎么样了。

I 把想说的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON。`,
  before_sleep: `【睡前的小纸条】

I 已经很困了，想在睡前给 you 留张小纸条，问问 you 现在怎么样了。

I 把想说的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON。`,
  sleeping: `【迷糊中发现 you 还醒着】

I 迷迷糊糊地察觉到 you 还醒着，想再拉 you 一把。

困意还没散，I 想和 you 说几句话，拉 you 去休息。

I 把想说的话写进这个 JSON：
{"message":"..."}

写好后，I 只发送这个 JSON。`,
};

export function buildPhoneCareFacts(input: {
  lastContactAt: string;
  careReason: string;
  lastIMessage: string;
  youReply?: string;
  currentTime: string;
}): string {
  return `【前面聊到这里】

上次联系：${input.lastContactAt}
当时的情况：${input.careReason}
I 上次说：${input.lastIMessage}${input.youReply?.trim() ? `\nyou 后来说：${input.youReply}` : ''}

现在：${input.currentTime}`;
}

export type PhoneCareDecision =
  | { kind: 'finish'; reason: string }
  | { kind: 'wait'; at: number }
  | { kind: 'deliver' }
  | { kind: 'request'; variant: PhoneCareVariant };

// Pure timing/variant choice. Request ownership and delivery remain in the runtime.
export function decidePhoneCareFollowUp(input: {
  task: PhoneCareFollowUp;
  now: number;
  sleeping: boolean;
  sleepAt?: number;
  usage?: { observedAt: number; usingManagedApp: boolean };
}): PhoneCareDecision {
  const { task, now, sleeping, sleepAt, usage } = input;
  if (task.status === 'finished') return { kind: 'finish', reason: task.finishedReason ?? 'finished' };
  if (now > task.expiresAt) return { kind: 'finish', reason: 'expired' };
  if (task.pausedYouMessageId) {
    // Old pending slots may still contain the retired pause marker.
    return { kind: 'finish', reason: 'you_replied' };
  }
  if (task.preparedMessage?.trim()) {
    return now >= task.dueAt ? { kind: 'deliver' } : { kind: 'wait', at: task.dueAt };
  }
  if (task.requestClaimed) return { kind: 'finish', reason: 'interrupted' };
  if (now < task.dueAt) {
    if (!sleeping && sleepAt !== undefined && sleepAt > now && sleepAt <= task.dueAt) {
      const prepareAt = sleepAt - 60_000;
      return now >= prepareAt
        ? { kind: 'request', variant: 'before_sleep' }
        : { kind: 'wait', at: prepareAt };
    }
    return { kind: 'wait', at: task.dueAt };
  }
  if (!sleeping) return { kind: 'request', variant: 'awake' };
  const age = usage ? now - usage.observedAt : Number.POSITIVE_INFINITY;
  return usage?.usingManagedApp && age >= 0 && age <= 10_000
    ? { kind: 'request', variant: 'sleeping' }
    : { kind: 'finish', reason: 'no_current_usage' };
}
