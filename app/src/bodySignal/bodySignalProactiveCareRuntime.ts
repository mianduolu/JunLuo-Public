import { loadAssistantState } from '../ai/assistantState';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { formatSleepLocalTime } from '../life/sleepPlanPolicy';
import { loadHeartCareObservation } from './bodySignalCareRuntime';
import { bodySignalBaselineThresholds } from './bodySignalBaseline';
import { loadRecentBodySignalCareEvents, markBodySignalCareEventsHandled, saveBodySignalCareEvent } from './bodySignalCareStore';
import { readHeartCareState, writeHeartCareState } from './bodySignalProactiveCareStore';
import { buildHeartCareFacts, HEART_CARE_FRESH_MS, observeHeartCareEpisode } from './bodySignalProactiveCare';
import { loadPersistedPrimaryBodySignalDeviceProfile } from './device/bodySignalDeviceRepository';
import { createBaiyunContinuityEvent } from '../ai/behavior/continuityLedger';
import { getLocalDateKey } from '../ai/assistantLifeTimeline';

let running: Promise<void> | null = null;

async function observe() {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  const current = () => canCommitBackupRestoreDataEpoch(epoch);
  await observeHeartCareEpisode({
    now: Date.now, current, read: readHeartCareState,
    write: async (previous, next) => current() && await writeHeartCareState(previous, next),
    observation: loadHeartCareObservation,
    register: async (event) => {
      for (let attempt = 0; attempt < 4 && current(); attempt += 1) {
        try {
          // Do not turn an already handled real event back into pending.
          if (!(await loadRecentBodySignalCareEvents(100)).some((saved) => saved.id === event.id)) {
            await runBackupRestoreDataEpochCommit(epoch, () => saveBodySignalCareEvent(event));
          }
          if (!current()) return;
          const episode = await readHeartCareState();
          if (!episode || episode.eventId !== event.id) return;
          await createBaiyunContinuityEvent({ eventId: `body-care:${event.id}`, operationId: `body-care:${event.id}`,
            kind: 'care_process', subject: 'you', itemName: '心率变化',
            idempotencyKey: `body-care:${event.id}`, coalescingKey: `heart-care:${episode.deviceProfileId}`,
            source: { kind: 'real_care', sourceId: event.id }, occurredAt: event.observedAt,
            occurredLocalDate: getLocalDateKey(new Date(event.observedAt)),
            timezoneOffsetMinutes: new Date(event.observedAt).getTimezoneOffset(),
            links: [{ relation: 'source', targetKind: 'body_signal_care_event', targetId: event.id }],
          });
          return;
        } catch (error) { if (attempt === 3) throw error; }
      }
    },
  });
}

export function observeBodySignalCareEpisode(): Promise<void> {
  if (!running) running = observe().finally(() => { running = null; });
  return running;
}

export async function loadPriorityHeartContact(now = Date.now()): Promise<{
  id: string; version: string; expiresAt: number; facts: string;
} | null> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return null;
  const state = await readHeartCareState(true);
  if (!state?.eventId || (await loadPersistedPrimaryBodySignalDeviceProfile())?.id !== state.deviceProfileId) return null;
  const event = (await loadRecentBodySignalCareEvents(100)).find((saved) => saved.id === state.eventId);
  if (!event || event.kind !== 'heart_rate' || event.status !== 'pending'
    || event.observedAt > now || now - event.observedAt > HEART_CARE_FRESH_MS || event.expiresAt < now) return null;
  // Collection owns draining/acknowledging native events and syncing phone activity.
  const observed = await loadHeartCareObservation(0, now, true);
  if (observed?.deviceProfileId !== state.deviceProfileId || observed.baseline?.readiness !== 'mature'
    || observed.baseline.id !== event.baselineId || observed.context !== event.context
    || observed.baseline.context !== event.context || observed.baseline.deviceProfileId !== state.deviceProfileId
    || observed.baseline.kind !== 'heart_rate' || !Number.isFinite(observed.baseline.median)
    || !Number.isFinite(observed.baseline.mad) || observed.baseline.mad < 0
    || observed.latest.measuredAt > now || now - observed.latest.measuredAt > HEART_CARE_FRESH_MS) return null;
  const evidence = event.evidence.slice(-3);
  if (!evidence.length || evidence.some((reading) => reading.kind !== 'heart_rate' || reading.unit !== 'bpm'
    || !Number.isFinite(reading.value) || reading.value <= 0 || reading.measuredAt > now)) return null;
  const limits = bodySignalBaselineThresholds(observed.baseline);
  const recorded = await loadHeartCareObservation(0, event.observedAt, true);
  if (recorded?.deviceProfileId !== state.deviceProfileId || recorded.context !== event.context) return null;
  const life = await loadAssistantState();
  if (!canCommitBackupRestoreDataEpoch(epoch)) return null;
  return { id: event.id, version: `${event.id}:${event.updatedAt}:${observed.baseline.updatedAt}`,
    expiresAt: Math.min(event.expiresAt, event.observedAt + HEART_CARE_FRESH_MS),
    facts: buildHeartCareFacts({ currentTime: formatSleepLocalTime(now), lifeModeText: life.lifeMode,
      recentHeartRateRecords: evidence.map((r) => `${formatSleepLocalTime(r.measuredAt)} ${r.value} ${r.unit}`).join('\n'),
      usualHeartRateRange: `${event.context} ${limits.regularLow.toFixed(1)}–${limits.regularHigh.toFixed(1)} bpm`,
      activityContext: recorded.activityText }),
  };
}

export async function markHeartContactHandled(id: string, at = Date.now()): Promise<void> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return;
  for (let attempt = 0; attempt < 4 && canCommitBackupRestoreDataEpoch(epoch); attempt += 1) {
    try {
      await runBackupRestoreDataEpochCommit(epoch, () => markBodySignalCareEventsHandled([id], at));
      return;
    } catch (error) { if (attempt === 3) throw error; }
  }
}
