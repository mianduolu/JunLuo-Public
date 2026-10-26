// One native trigger owns its two HTTP attempts, independently of overlay lifetime.
export type PhoneGuardStatus = 'pending' | 'succeeded' | 'failed' | 'disabled' | 'blocked' | 'cancelled';
export type PhoneGuardEvent = {
  triggerId: string;
  ruleId: string;
  triggeredAt: number;
  attempts: number;
  status: PhoneGuardStatus;
  overlayShownAt?: number;
  authorized?: boolean;
  overlayPermission?: boolean;
  returnClickedAt?: number;
  returnedAt?: number;
};

export class PhoneGuardStop extends Error {
  constructor(public readonly status: PhoneGuardStatus) { super(status); }
}

export type PhoneGuardDeliveryPorts = {
  current: () => boolean;
  now: () => number;
  read: () => Promise<PhoneGuardEvent | null>;
  claim: () => Promise<PhoneGuardEvent | null>;
  finish: (status: PhoneGuardStatus) => Promise<boolean>;
  available: () => Promise<'ready' | 'disabled' | 'blocked' | 'cancelled'>;
  request: (signal: AbortSignal, beforeRequest: () => Promise<void>) => Promise<string>;
  runRequests: (
    attempt: () => Promise<void>,
    shouldContinue: () => boolean,
    started: (attempt: 1 | 2) => boolean,
  ) => Promise<boolean>;
  save: (content: string) => Promise<boolean>;
  recordOverlay: (event: PhoneGuardEvent) => Promise<void>;
  recordDelivery: () => Promise<void>;
  display: (text: string) => Promise<unknown>;
  diagnostic: (stage: string) => void;
  timeoutMs?: number;
};

export async function runPhoneGuardDelivery(
  identity: { triggerId: string; ruleId: string },
  ports: PhoneGuardDeliveryPorts,
): Promise<boolean> {
  const matches = (event: PhoneGuardEvent | null): event is PhoneGuardEvent => !!event
    && event.triggerId === identity.triggerId && event.ruleId === identity.ruleId;
  const safeLocal = async <T>(stage: string, work: () => Promise<T>): Promise<T | undefined> => {
    // Display is not persistence. Only saves/receipts get three additional attempts.
    const attempts = stage === 'display' ? 2 : 4;
    for (let retry = 0; retry < attempts && ports.current(); retry += 1) {
      try { return await work(); } catch { ports.diagnostic(stage); }
    }
    return undefined;
  };
  const finish = async (status: PhoneGuardStatus) => {
    await safeLocal(`finish:${status}`, async () => {
      if (!await ports.finish(status)) throw new Error('finish-not-saved');
    });
  };
  let event = await ports.read();
  if (!ports.current() || !matches(event)) return false;
  if (event.status !== 'pending') return false;
  if (ports.now() - event.triggeredAt > 30 * 60 * 1000 || event.triggeredAt > ports.now()) {
    await finish('cancelled');
    return false;
  }
  // Display evidence is independent of whether the model produces any text.
  if (event.overlayShownAt && event.authorized && event.overlayPermission) {
    await safeLocal('overlay-receipt', () => ports.recordOverlay(event!));
  }
  let status: PhoneGuardStatus = 'pending';
  let content = '';
  let invocation = 0;
  const started = [false, false];
  const attempt = async () => {
    const index = invocation++;
    if (!ports.current() || content || status !== 'pending') return;
    const availability = await ports.available();
    if (!ports.current()) return;
    if (availability !== 'ready') { status = availability; return; }
    event = await ports.read();
    if (!matches(event) || event.status !== 'pending') { status = 'cancelled'; return; }
    if (event.attempts >= 2) { status = 'failed'; return; }
    if (ports.now() - event.triggeredAt > 30 * 60 * 1000) { status = 'cancelled'; return; }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let expired = false;
    let beforeRequestCalled = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        controller.abort();
        reject(new Error('timeout'));
      }, ports.timeoutMs ?? 25_000);
    });
    try {
      const candidate = await Promise.race([
        ports.request(controller.signal, async () => {
          if (beforeRequestCalled || expired || !ports.current()) throw new PhoneGuardStop('cancelled');
          beforeRequestCalled = true;
          const availability = await ports.available();
          if (availability !== 'ready') throw new PhoneGuardStop(availability);
          if (expired || !ports.current()) throw new PhoneGuardStop('cancelled');
          const claimed = await ports.claim();
          if (!matches(claimed) || expired || !ports.current()) throw new PhoneGuardStop('cancelled');
          started[index] = true;
        }),
        timeout,
      ]);
      if (!expired && ports.current() && started[index]) content = candidate.trim();
    } catch (error) {
      if (error instanceof PhoneGuardStop) status = error.status;
      ports.diagnostic(error instanceof PhoneGuardStop ? error.status : 'request-failed');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
  await safeLocal('display', () => ports.display('消息生成中'));
  const allowed = await ports.runRequests(
    attempt,
    () => ports.current() && !content && status === 'pending',
    (index) => started[index - 1],
  );
  if (!ports.current()) return false;
  if (!allowed) status = 'blocked';
  if (!content) {
    if (status === 'pending') status = 'failed';
    await finish(status);
    await safeLocal('display', () => ports.display(status === 'disabled'
      ? '后台自动调用已关闭' : '消息生成失败'));
    return false;
  }
  const saved = await safeLocal('message-save', async () => {
    if (!await ports.save(content)) throw new Error('message-not-saved');
    return true;
  });
  if (!ports.current()) return false;
  if (!saved) {
    await finish('failed');
    await safeLocal('display', () => ports.display('消息生成失败'));
    return false;
  }
  await finish('succeeded');
  await safeLocal('message-receipt', ports.recordDelivery);
  await safeLocal('display', () => ports.display(content));
  return true;
}
