import {
  getColmiConnectionSnapshot,
  startMiBand6RealtimeHeartRate,
  stopMiBand6RealtimeHeartRate,
} from './colmi/colmiConnection';
import {
  startGuardianFiveMinuteHeartRate,
  stopGuardianHeartRate,
} from './bodySignalGuardian';
import { getBodySignalGuardianRuntimeState } from './bodySignalGuardianRuntime';
import { guardianOwnsBodySignalConnection } from './bodySignalGuardianPolicy';

export async function startBodySignalContinuousHeartRate(): Promise<void> {
  const guardian = getBodySignalGuardianRuntimeState();
  if (guardianOwnsBodySignalConnection(guardian)) {
    if (guardian.status !== 'ready' && guardian.status !== 'sampling') {
      throw new Error('全天守候连接尚未就绪。');
    }
    await startGuardianFiveMinuteHeartRate();
    return;
  }
  const state = getColmiConnectionSnapshot();
  if (!state.isConnected || state.status !== 'connected') {
    throw new Error('穿戴设备还没有连接。');
  }
  if (!state.capabilities.supportsHuami2021Auth) {
    throw new Error('当前设备不支持限时连续心率。');
  }
  await startMiBand6RealtimeHeartRate();
}

export async function stopBodySignalContinuousHeartRate(): Promise<void> {
  const guardian = getBodySignalGuardianRuntimeState();
  if (guardianOwnsBodySignalConnection(guardian)) {
    await stopGuardianHeartRate();
    return;
  }
  await stopMiBand6RealtimeHeartRate('manual');
}

export function formatBodySignalHeartRateRemaining(
  endsAt: number | undefined,
  now: number,
  startedAt?: number,
): string {
  const effectiveNow = Math.max(now, startedAt ?? now);
  const remainingMs = Math.max(0, (endsAt ?? effectiveNow) - effectiveNow);
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}
