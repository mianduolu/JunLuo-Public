import { resolveBodySignalReadingContext, unknownBodySignalReadingContext, type BodySignalReadingContextInput } from './bodySignalReadingContext';
import { BODY_SIGNAL_ACTIVITY_MAX_AGE_MS } from './bodySignalContext';

// No event drain, registration, care evaluation or measurement is allowed here.
export async function loadBodySignalReadingContext(reading: BodySignalReadingContextInput) {
  if (!reading.deviceProfileId || !Number.isFinite(reading.measuredAt) || reading.measuredAt <= 0) {
    return unknownBodySignalReadingContext(reading);
  }
  try {
    const [devices, context, activity, phone, sleep, workouts] = await Promise.all([
      import('./device/bodySignalDeviceRepository'), import('./bodySignalContextStore'),
      import('./bodySignalActivityContext'), import('../phoneActivity/phoneActivityStore'),
      import('./bodySignalSleepStore'), import('./bodySignalWorkoutStore'),
    ]);
    const [profiles, support, observations, navigation, sleepSessions, workoutSessions] = await Promise.all([
      devices.loadPersistedBodySignalDeviceProfiles(), activity.getActivityContextSupport(),
      context.loadRecentBodySignalContextObservations(reading.measuredAt - BODY_SIGNAL_ACTIVITY_MAX_AGE_MS, 512, reading.measuredAt),
      phone.loadPersistedPhoneActivityLogsBetween(reading.measuredAt - BODY_SIGNAL_ACTIVITY_MAX_AGE_MS, reading.measuredAt),
      sleep.loadBodySignalSleepSessionsSince(reading.measuredAt),
      workouts.loadBodySignalWorkoutSessionsSince(reading.measuredAt - 28 * 86_400_000),
    ]);
    return resolveBodySignalReadingContext(reading, { deviceProfileIds: profiles.map(profile => profile.id),
      support, activity: observations, navigation, sleep: sleepSessions, workouts: workoutSessions });
  } catch {
    return unknownBodySignalReadingContext(reading);
  }
}
