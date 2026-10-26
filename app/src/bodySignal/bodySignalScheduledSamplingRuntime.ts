import {
  cancelScheduledSampling,
  configureScheduledSampling,
  evaluateScheduledSampling,
} from './bodySignalGuardian';
import {
  nextLocalEightAm,
  type BodySignalScheduledSamplingSettings,
  type BodySignalScheduledSamplingTrigger,
  type BodySignalScheduledSamplingWindow,
} from './bodySignalScheduledSampling';
import {
  loadRecentScheduledSamplingWindows,
  loadScheduledSamplingSettings,
  saveScheduledSamplingSettings,
} from './bodySignalStore';

async function applyScheduledSamplingSettings(
  next: Pick<BodySignalScheduledSamplingSettings, 'enabled' | 'pauseUntil'>,
): Promise<BodySignalScheduledSamplingSettings> {
  const previous = await loadScheduledSamplingSettings();
  const saved = await saveScheduledSamplingSettings(next);
  try {
    if (next.enabled) await configureScheduledSampling(true, next.pauseUntil);
    else await cancelScheduledSampling();
    return saved;
  } catch (error) {
    await saveScheduledSamplingSettings(previous);
    try {
      if (previous.enabled) await configureScheduledSampling(true, previous.pauseUntil);
      else await cancelScheduledSampling();
    } catch {
      // The runtime reconciliation path will retry the persisted previous state.
    }
    throw error;
  }
}

export async function saveScheduledSamplingEnabled(
  enabled: boolean,
): Promise<BodySignalScheduledSamplingSettings> {
  return applyScheduledSamplingSettings({ enabled });
}

export async function pauseScheduledSamplingUntil(
  timestamp: number,
): Promise<BodySignalScheduledSamplingSettings> {
  if (!Number.isFinite(timestamp) || timestamp <= Date.now()) {
    throw new RangeError('节制采样暂停时间必须在未来。');
  }
  return applyScheduledSamplingSettings({ enabled: true, pauseUntil: timestamp });
}

export async function pauseScheduledSamplingUntilTomorrow(): Promise<BodySignalScheduledSamplingSettings> {
  return pauseScheduledSamplingUntil(nextLocalEightAm());
}

export async function resumeScheduledSampling(): Promise<BodySignalScheduledSamplingSettings> {
  return applyScheduledSamplingSettings({ enabled: true });
}

export async function requestScheduledSamplingEvaluation(
  trigger: BodySignalScheduledSamplingTrigger,
): Promise<void> {
  await evaluateScheduledSampling(trigger);
}

export {
  loadRecentScheduledSamplingWindows,
  loadScheduledSamplingSettings,
};

export type { BodySignalScheduledSamplingSettings, BodySignalScheduledSamplingWindow };
