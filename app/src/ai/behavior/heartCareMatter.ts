import type { BaiyunContinuityEvent } from './continuityEvent';

/** Exact identity written by bodySignalProactiveCareRuntime, never a text match. */
export function isHeartCareMatter(event: BaiyunContinuityEvent) {
  return event.schemaVersion === 2 && event.kind === 'care_process' && event.subject === 'you'
    && event.source.kind === 'real_care' && event.id === `body-care:${event.source.sourceId}`
    && Boolean(event.coalescingKey?.startsWith('heart-care:'));
}

export const HEART_CARE_RECORD_PREDICATE = `(schema_version = 2 AND kind = 'care_process'
  AND subject = 'you' AND source_kind = 'real_care' AND id = 'body-care:' || source_id
  AND COALESCE(coalescing_key, '') LIKE 'heart-care:%')`;

export type CareContextEvent = BaiyunContinuityEvent & { deviceRecord?: string };

/** A read-time projection of the original device evidence, not another stored copy. */
export async function loadHeartCareDeviceRecord(event: BaiyunContinuityEvent) {
  if (!isHeartCareMatter(event)) return undefined;
  const { loadBodySignalCareEvidence } = await import('../../bodySignal/bodySignalCareStore');
  const readings = await loadBodySignalCareEvidence(event.source.sourceId);
  const time = (at: number) => {
    const date = new Date(at);
    const pad = (part: number) => String(part).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };
  const heart = readings.filter(reading => reading.kind === 'heart_rate');
  return heart.length ? heart.map(reading => `${time(reading.measuredAt)} · ${reading.value} ${reading.unit}`).join('；')
    : `${time(event.occurredAt)} · ${event.itemName ?? ''}`;
}
