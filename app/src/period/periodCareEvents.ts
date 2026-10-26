import {
  createBaiyunContinuityEvent, getBaiyunContinuityEvent, listBaiyunContinuityEvents,
  listBaiyunContinuityLinks, recordBaiyunContinuityEvidence,
} from '../ai/behavior/continuityLedger';
import { formatNearStatusPeriodLogParts } from '../ai/nearStatusLifeMaterialFormat';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { formatSleepLocalTime } from '../life/sleepPlanPolicy';
import { getPeriodDateKey, loadPeriodObservation, type PeriodObservation } from './periodStore';
import { loadPeriodReminderSettings } from './periodReminderSettings';

export const PERIOD_PRIORITY_WINDOW_MS = 6 * 60 * 60 * 1000;
const SOURCE_PREFIX = 'period-care:';
const PRIORITY_SOURCE = 'period_priority_observation';
let observationWrites: Promise<void> = Promise.resolve();

export function periodObservationOccurredAt(observation: Pick<PeriodObservation, 'dateKey' | 'timeText'>): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observation.dateKey)
    || !observation.timeText || !/^([01]\d|2[0-3]):[0-5]\d$/.test(observation.timeText)) return null;
  const at = new Date(`${observation.dateKey}T${observation.timeText}:00`).getTime();
  return Number.isFinite(at) && getPeriodDateKey(at) === observation.dateKey ? at : null;
}

function observationVersion(observation: PeriodObservation) {
  return JSON.stringify([observation.id, observation.updatedAt]);
}

function decodeVersion(value: string): [string, number] | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string'
      && Number.isSafeInteger(parsed[1]) ? parsed as [string, number] : null;
  } catch { return null; }
}

async function openPeriodMatters() {
  const result = [];
  for (let offset = 0; ; offset += 200) {
    const page = await listBaiyunContinuityEvents({ kinds: ['care_process'], statuses: ['open', 'waiting'], readOnly: true, offset, limit: 200 });
    result.push(...page.filter((event) => event.source.kind === 'real_care' && event.source.sourceId.startsWith(SOURCE_PREFIX)));
    if (page.length < 200) return result;
  }
}

async function locally<T>(work: () => Promise<T>, current: () => boolean): Promise<T | undefined> {
  for (let attempt = 0; attempt < 4 && current(); attempt += 1) {
    try { return await work(); } catch (error) { if (attempt === 3) throw error; }
  }
}

// Only the successful local observation transaction calls this. Import/sync and
// daily projections never discover a fresh priority or scan old observations.
export function recordPeriodCareObservation(input: {
  observation: PeriodObservation;
  previous: PeriodObservation | null;
  live: boolean;
  dataEpoch: ReturnType<typeof captureBackupRestoreDataEpoch>;
}): Promise<void> {
  const work = async () => {
    const { observation, previous, dataEpoch } = input;
    const current = () => dataEpoch !== null && canCommitBackupRestoreDataEpoch(dataEpoch);
    const at = periodObservationOccurredAt(observation);
    if (!input.live || at === null || at > Date.now() || !current()) return;
    const episode = `${SOURCE_PREFIX}${observation.periodId ?? 'unconfirmed'}`;
    const open = (await openPeriodMatters()).find((event) => event.coalescingKey === episode);
    if (!current()) return;
    if (observation.painLevel === 0) {
      if (open && (previous?.painLevel ?? 0) > 0) {
        await locally(async () => {
          const latest = await getBaiyunContinuityEvent(open.id, true);
          if (!latest || !['open', 'waiting'].includes(latest.status) || !current()) return;
          await recordBaiyunContinuityEvidence({ eventId: latest.id, expectedRevision: latest.revision,
            operationId: `period-pain-ended:${observation.id}`,
            evidence: { id: `period-pain-ended:${observation.id}`, sourceId: observation.id,
              kind: 'observed_care_recovery', occurredAt: at, outcome: 'succeeded' } });
        }, current);
      }
      return;
    }
    const same = previous && observation.painLevel === previous.painLevel
      && observation.bodyState === previous.bodyState && observation.flow === previous.flow
      && observation.note === previous.note && JSON.stringify(observation.symptoms) === JSON.stringify(previous.symptoms);
    if (same) return;
    const previousAt = previous && periodObservationOccurredAt(previous);
    if (previousAt !== null && previousAt !== undefined && previousAt > at) return;
    const priority = observation.painLevel >= 3
      && (!previous || previous.painLevel < 3 || observation.painLevel > previous.painLevel);
    const version = observationVersion(observation);
    await locally(() => createBaiyunContinuityEvent({
      eventId: `${SOURCE_PREFIX}${observation.id}`, operationId: `period-observation:${version}`,
      kind: 'care_process', subject: 'you', itemName: observation.periodId ? '经期不适' : '身体不适',
      idempotencyKey: `period-observation:${version}`, coalescingKey: episode,
      source: { kind: 'real_care', sourceId: episode }, occurredAt: at,
      occurredLocalDate: observation.dateKey, timezoneOffsetMinutes: new Date(at).getTimezoneOffset(),
      links: [
        { relation: 'source', targetKind: 'period_observation', targetId: version },
        ...(priority ? [{ relation: 'source' as const, targetKind: PRIORITY_SOURCE, targetId: version }] : []),
      ],
    }), current);
  };
  const result = observationWrites.then(work, work);
  observationWrites = result.catch(() => undefined);
  void result.then(() => import('../life/sleepPlanRuntime')).then(module => module.reconcileSleepPlanLocally()).catch(() => undefined);
  return result;
}

export function buildPeriodCareFacts(observation: PeriodObservation) {
  const at = periodObservationOccurredAt(observation);
  if (at === null) return '';
  return `【you 最近保存的经期状态】\n\n记录时间：${formatSleepLocalTime(at)}\n${formatNearStatusPeriodLogParts(observation, { today: false, includePeriodState: true }).join('；')}`;
}

export async function loadPriorityPeriodContact(now = Date.now()): Promise<{
  id: string; version: string; expiresAt: number; facts: string;
} | null> {
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null) return null;
  const settings = await loadPeriodReminderSettings();
  if (!settings.careEnabled || settings.mutedDateKey === getPeriodDateKey(now)) return null;
  const candidates = [];
  for (const event of await openPeriodMatters()) {
    const links = await listBaiyunContinuityLinks(event.id, true);
    const observations = await Promise.all(links.filter((link) => link.targetKind === 'period_observation').map(async (link) => {
      const ref = decodeVersion(link.targetId);
      if (!ref) return null;
      const observation = await loadPeriodObservation(ref[0]);
      return observation ? { observation, originalVersion: link.targetId, valid: observation.updatedAt === ref[1] } : null;
    }));
    const ordered = observations.filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) => (periodObservationOccurredAt(right.observation) ?? 0) - (periodObservationOccurredAt(left.observation) ?? 0)
        || right.observation.createdAt - left.observation.createdAt || right.observation.id.localeCompare(left.observation.id));
    const latest = ordered[0];
    if (!latest?.valid || latest.observation.painLevel < 3) continue;
    // New remarks at the same pain level do not restart or erase the original
    // six-hour window. An edited newest priority never falls back to an old one.
    const priority = ordered.find((entry) => links.some((link) => link.targetKind === PRIORITY_SOURCE && link.targetId === entry.originalVersion));
    if (!priority?.valid) continue;
    const evidence = priority.observation;
    const version = observationVersion(evidence);
    const id = JSON.stringify([event.id, evidence.id, evidence.updatedAt]);
    if (links.some((link) => link.targetKind === 'proactive_message_persisted' && link.targetId === id)) continue;
    const at = periodObservationOccurredAt(evidence);
    if (at === null || at > now || now > at + PERIOD_PRIORITY_WINDOW_MS) continue;
    candidates.push({ id, version: `${version}:${latest.originalVersion}:${event.revision}`, expiresAt: at + PERIOD_PRIORITY_WINDOW_MS,
      facts: buildPeriodCareFacts(latest.observation) });
  }
  return canCommitBackupRestoreDataEpoch(epoch)
    ? candidates.sort((left, right) => left.expiresAt - right.expiresAt || left.id.localeCompare(right.id))[0] ?? null : null;
}

export async function markPeriodContactHandled(id: string, at = Date.now()): Promise<void> {
  let reference: unknown;
  try { reference = JSON.parse(id); } catch { return; }
  if (!Array.isArray(reference) || reference.length !== 3 || typeof reference[0] !== 'string'
    || typeof reference[1] !== 'string' || !Number.isSafeInteger(reference[2])) return;
  const [eventId, observationId, updatedAt] = reference as [string, string, number];
  const epoch = captureBackupRestoreDataEpoch();
  const current = () => epoch !== null && canCommitBackupRestoreDataEpoch(epoch);
  await locally(async () => {
    const [event, observation, links] = await Promise.all([getBaiyunContinuityEvent(eventId, true),
      loadPeriodObservation(observationId), listBaiyunContinuityLinks(eventId, true)]);
    if (!current() || !event || !['open', 'waiting'].includes(event.status)
      || observation?.updatedAt !== updatedAt
      || !links.some((link) => link.targetKind === PRIORITY_SOURCE && link.targetId === observationVersion(observation))
      || links.some((link) => link.targetKind === 'proactive_message_persisted' && link.targetId === id)) return;
    await recordBaiyunContinuityEvidence({ eventId, expectedRevision: event.revision,
      operationId: `period-contact:${id}`, evidence: { id: `period-contact:${id}`,
        kind: 'proactive_message_persisted', sourceId: id, occurredAt: at, outcome: 'succeeded' } });
  }, current);
}
