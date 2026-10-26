import {
  formatBodySignalAmbientContext,
  presentBodySignalSnapshot,
  isSameLocalDay,
} from '../bodySignal/bodySignalAiPresentation';
import { loadBodySignalReadingContext } from '../bodySignal/bodySignalReadingContextReader';

async function buildExistingBodySignalContext(now: number) {
  try {
    const { loadBodySignalSnapshot } = await import('../bodySignal/bodySignalReader');
    const snapshot = await loadBodySignalSnapshot(now);
    const context = snapshot.heartRate && isSameLocalDay(snapshot.heartRate.measuredAt, now)
      ? await loadBodySignalReadingContext(snapshot.heartRate) : undefined;
    return formatBodySignalAmbientContext(presentBodySignalSnapshot(snapshot, now), context);
  } catch {
    return '';
  }
}

export async function buildBodySignalAmbientContext(now = Date.now(), options: { includeWearableSleep?: boolean; includeWearableSteps?: boolean } = {}) {
  const [existing, sleep, steps] = await Promise.all([
    buildExistingBodySignalContext(now),
    options.includeWearableSleep
      ? import('../bodySignal/bodySignalSleepAiMaterial')
        .then(module => module.loadBodySignalSleepAiMaterial(now)).then(material => material?.text ?? '').catch(() => '')
      : Promise.resolve(''),
    options.includeWearableSteps
      ? import('../bodySignal/bodySignalStepsAiMaterial')
        .then(module => module.loadBodySignalStepsAiMaterial(now)).then(material => material?.text ?? '').catch(() => '')
      : Promise.resolve(''),
  ]);
  return [existing, sleep, steps].filter(Boolean).join('\n\n');
}
