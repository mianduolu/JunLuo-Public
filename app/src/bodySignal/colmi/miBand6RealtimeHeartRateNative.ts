import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

export type MiBand6RealtimeNativeStopReason =
  | 'disconnect'
  | 'manual'
  | 'task_removed'
  | 'timeout'
  | 'write_failed';

type MiBand6RealtimeNativeModule = {
  acknowledgeSampleTick(tickId: number): Promise<boolean>;
  addListener(eventName: string): void;
  finish(reason: MiBand6RealtimeNativeStopReason): Promise<boolean>;
  getState(): Promise<{ endsAt: number; isRunning: boolean }>;
  removeListeners(count: number): void;
  start(durationMs: number): Promise<boolean>;
};

const EVENT_STOP_REQUESTED = 'junluoMiBand6HeartRateStopRequested';
const EVENT_STOPPED = 'junluoMiBand6HeartRateStopped';
const EVENT_SAMPLE_TICK = 'junluoMiBand6HeartRateSampleTick';

function nativeModule(): MiBand6RealtimeNativeModule | undefined {
  if (Platform.OS !== 'android') return undefined;
  return NativeModules.JunLuoMiBand6RealtimeHeartRate as MiBand6RealtimeNativeModule | undefined;
}

export function isMiBand6RealtimeNativeAvailable(): boolean {
  return Boolean(nativeModule());
}

export async function startMiBand6RealtimeNative(durationMs: number): Promise<void> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少小米手环连续心率原生模块，请重新安装 Dev Client。');
  await module.start(durationMs);
}

export async function finishMiBand6RealtimeNative(
  reason: MiBand6RealtimeNativeStopReason,
): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.finish(reason);
}

export async function acknowledgeMiBand6RealtimeSampleTick(tickId: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.acknowledgeSampleTick(tickId);
}

export async function getMiBand6RealtimeNativeState(): Promise<{
  endsAt: number;
  isRunning: boolean;
}> {
  const module = nativeModule();
  if (!module) return { endsAt: 0, isRunning: false };
  return module.getState();
}

export function subscribeMiBand6RealtimeNative(options: {
  onStopRequested: (reason: MiBand6RealtimeNativeStopReason) => void;
  onSampleTick: (tickId: number) => void;
  onStopped: (reason: MiBand6RealtimeNativeStopReason) => void;
}): () => void {
  const module = nativeModule();
  if (!module) return () => undefined;
  const emitter = new NativeEventEmitter(module as never);
  const stopRequested = emitter.addListener(EVENT_STOP_REQUESTED, (event) => {
    options.onStopRequested(event.reason as MiBand6RealtimeNativeStopReason);
  });
  const sampleTick = emitter.addListener(EVENT_SAMPLE_TICK, (event) => {
    options.onSampleTick(Number(event.tickId));
  });
  const stopped = emitter.addListener(EVENT_STOPPED, (event) => {
    options.onStopped(event.reason as MiBand6RealtimeNativeStopReason);
  });
  return () => {
    stopRequested.remove();
    stopped.remove();
    sampleTick.remove();
  };
}
