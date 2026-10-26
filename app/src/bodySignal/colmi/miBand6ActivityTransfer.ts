import { Buffer } from 'buffer';
import type { Device, Subscription } from 'react-native-ble-plx';
import type { MiBand6ActivityBatch, MiBand6ActivityCandidate } from '../miBand6ActivityTypes';
import { ACTIVITY_IDLE_MS, ACTIVITY_TIMEOUT_MS, createMiBand6ActivityRequest,
  miBand6ActivityFetchCommand, MiBand6ActivityAssembler, MI_BAND_6_ACTIVITY_CONTROL,
  MI_BAND_6_ACTIVITY_DATA, MI_BAND_6_ACTIVITY_SERVICE } from './miBand6ActivityProtocol';

const CCCD = '00002902-0000-1000-8000-00805f9b34fb';
const decode = (value?: string | null) => value ? Array.from(Buffer.from(value, 'base64')) : [];

export function receiveMiBand6Activity(input: {
  device: Device; since: number; assertCurrent(): void;
  cancelTransaction(id: string): Promise<void>; releaseConnection(): Promise<void>;
  blockConnection(): void;
  observePacket?(kind: 'control' | 'data', bytes: readonly number[], observedAt: number, elapsedMs: number): void;
}): { promise: Promise<MiBand6ActivityCandidate>; cancel(): Promise<void> } {
  const { device } = input;
  const token = `mi-band-6-activity-${Date.now()}`;
  const subscriptions: Subscription[] = [];
  const monitored: string[] = [];
  const transactions = [token, `${token}-control`, `${token}-data`];
  const requestedAt = Date.now();
  const monotonicNow = () => typeof performance === 'undefined' ? Date.now() : performance.now();
  const started = monotonicNow();
  const parser = new MiBand6ActivityAssembler(input.since, requestedAt);
  let closing = false;
  let cleanup: Promise<void> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let total: ReturnType<typeof setTimeout> | undefined;
  let writeWithResponse = true;
  let resolve!: (batch: MiBand6ActivityCandidate) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<MiBand6ActivityCandidate>((yes, no) => { resolve = yes; reject = no; });
  const assertCurrent = () => {
    input.assertCurrent();
    if (closing) throw new Error('activity_cancelled');
  };
  const finish = (batch?: MiBand6ActivityBatch, code?: string): Promise<void> => {
    if (cleanup) return cleanup;
    closing = true;
    if (idle) clearTimeout(idle);
    if (total) clearTimeout(total);
    if (code) input.blockConnection();
    cleanup = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let expired = false;
      try {
        await Promise.race([
          (async () => {
            let removalFailed = false;
            subscriptions.forEach(subscription => { try { subscription.remove(); } catch { removalFailed = true; } });
            if (removalFailed) throw new Error('activity_cleanup_failed');
            for (const id of transactions) await input.cancelTransaction(id);
            for (const uuid of monitored) {
              if (expired) throw new Error('activity_cleanup_failed');
              input.assertCurrent();
              // BLE PLX owns CCCD writes. Read after disposal to confirm its unsubscribe finished.
              const descriptor = await device.readDescriptorForService(MI_BAND_6_ACTIVITY_SERVICE, uuid, CCCD, `${token}-cleanup`);
              input.assertCurrent();
              const bytes = decode(descriptor.value);
              if (bytes.length !== 2 || bytes[0] !== 0 || bytes[1] !== 0) throw new Error('activity_cleanup_failed');
            }
          })(),
          new Promise<never>((_, fail) => { timeout = setTimeout(() => {
            expired = true; fail(new Error('activity_cleanup_failed'));
          }, 5000); }),
        ]);
        if (batch && !code) resolve({ ...batch, evidence: parser.getEvidence() });
        else reject(Object.assign(new Error(code ?? 'activity_cancelled'), { evidence: parser.getEvidence() }));
      } catch {
        input.blockConnection();
        void input.cancelTransaction(`${token}-cleanup`).catch(() => undefined);
        // Initiate disconnect, but never let an unresponsive native promise hold HR indefinitely.
        void input.releaseConnection().catch(() => undefined);
        reject(new Error('activity_cleanup_failed'));
        throw new Error('activity_cleanup_failed');
      } finally { if (timeout) clearTimeout(timeout); }
    })();
    void cleanup.catch(() => undefined);
    return cleanup;
  };
  const fail = (error: unknown) => { void finish(undefined,
    error instanceof Error && /^(activity_|sleep_)/.test(error.message) ? error.message : 'activity_transfer_failed'); };
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      try { parser.checkTime(Date.now(), monotonicNow() - started); armIdle(); } catch (error) { fail(error); }
    }, ACTIVITY_IDLE_MS);
  };
  const write = async (bytes: number[]) => {
    assertCurrent();
    const value = Buffer.from(bytes).toString('base64');
    if (writeWithResponse) {
      await device.writeCharacteristicWithResponseForService(MI_BAND_6_ACTIVITY_SERVICE,
        MI_BAND_6_ACTIVITY_CONTROL, value, token);
    } else {
      await device.writeCharacteristicWithoutResponseForService(MI_BAND_6_ACTIVITY_SERVICE,
        MI_BAND_6_ACTIVITY_CONTROL, value, token);
    }
    assertCurrent();
  };
  const start = async () => {
    assertCurrent();
    const characteristics = await device.characteristicsForService(MI_BAND_6_ACTIVITY_SERVICE);
    assertCurrent();
    const control = characteristics.find(item => item.uuid.toLowerCase() === MI_BAND_6_ACTIVITY_CONTROL);
    const data = characteristics.find(item => item.uuid.toLowerCase() === MI_BAND_6_ACTIVITY_DATA);
    if (!control || !(control.isWritableWithResponse || control.isWritableWithoutResponse)
      || !(control.isNotifiable || control.isIndicatable)
      || !data || !(data.isNotifiable || data.isIndicatable)) throw new Error('activity_unsupported');
    writeWithResponse = control.isWritableWithResponse;
    for (const [uuid, suffix] of [[MI_BAND_6_ACTIVITY_CONTROL, 'control'], [MI_BAND_6_ACTIVITY_DATA, 'data']]) {
      assertCurrent();
      monitored.push(uuid);
      subscriptions.push(device.monitorCharacteristicForService(MI_BAND_6_ACTIVITY_SERVICE, uuid, (error, value) => { void Promise.resolve().then(() => {
        if (closing) return;
        if (error) { fail(error); return; }
        try {
          assertCurrent();
          if ((value?.value?.length ?? 0) > 684) throw new Error('activity_invalid_packet');
          const bytes = decode(value?.value);
          const observedAt = Date.now();
          const elapsedMs = monotonicNow() - started;
          input.observePacket?.(uuid === MI_BAND_6_ACTIVITY_DATA ? 'data' : 'control', bytes, observedAt, elapsedMs);
          let progress = true;
          if (uuid === MI_BAND_6_ACTIVITY_DATA) progress = parser.data(bytes, observedAt, elapsedMs);
          else {
            const result = parser.control(bytes, observedAt, elapsedMs);
            if (result === 'fetch') void write(miBand6ActivityFetchCommand()).catch(fail);
            else void finish(result);
          }
          if (!closing && progress) armIdle();
        } catch (caught) { fail(caught); }
      }); }, `${token}-${suffix}`));
      const descriptor = await device.readDescriptorForService(MI_BAND_6_ACTIVITY_SERVICE, uuid, CCCD, token);
      assertCurrent();
      const enabled = decode(descriptor.value);
      if (enabled.length !== 2 || ![1, 2].includes(enabled[0]) || enabled[1] !== 0) throw new Error('activity_subscription_failed');
    }
    await write(createMiBand6ActivityRequest(input.since));
  };
  total = setTimeout(() => fail(new Error('activity_timeout')), ACTIVITY_TIMEOUT_MS);
  armIdle();
  void start().catch(fail);
  return { promise, cancel: () => finish(undefined, 'activity_cancelled') };
}
