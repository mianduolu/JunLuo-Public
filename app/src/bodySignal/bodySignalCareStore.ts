import type {
  BodySignalCareEvent,
  BodySignalCareEventEvidence,
  BodySignalPersonalBaseline,
} from './bodySignalStructuredTypes';
import {
  assertBodySignalCareEvent,
  assertBodySignalPersonalBaseline,
} from './bodySignalStructuredValidation';

export async function saveBodySignalPersonalBaseline(
  baseline: BodySignalPersonalBaseline,
): Promise<void> {
  assertBodySignalPersonalBaseline(baseline);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_personal_baselines (
       id, device_profile_id, kind, context_bucket,
       distinct_date_count, bucket_count, sample_count,
       median, mad, p10, p90, average, minimum, maximum,
       standard_deviation, window_started_at, window_ended_at,
       algorithm_version, readiness, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(device_profile_id, kind, context_bucket) DO UPDATE SET
       distinct_date_count = excluded.distinct_date_count,
       bucket_count = excluded.bucket_count,
       sample_count = excluded.sample_count,
       median = excluded.median,
       mad = excluded.mad,
       p10 = excluded.p10,
       p90 = excluded.p90,
       average = excluded.average,
       minimum = excluded.minimum,
       maximum = excluded.maximum,
       standard_deviation = excluded.standard_deviation,
       window_started_at = excluded.window_started_at,
       window_ended_at = excluded.window_ended_at,
       algorithm_version = excluded.algorithm_version,
       readiness = excluded.readiness,
       updated_at = excluded.updated_at`,
    baseline.id,
    baseline.deviceProfileId,
    baseline.kind,
    baseline.context,
    baseline.dateCount,
    baseline.bucketCount,
    baseline.sampleCount,
    baseline.median,
    baseline.mad,
    baseline.p10,
    baseline.p90,
    baseline.average,
    baseline.minimum,
    baseline.maximum,
    baseline.standardDeviation ?? null,
    baseline.windowStartedAt,
    baseline.windowEndedAt,
    baseline.algorithmVersion,
    baseline.readiness,
    baseline.updatedAt,
  );
}

type BaselineRow = {
  algorithm_version: number;
  average: number;
  bucket_count: number;
  context_bucket: BodySignalPersonalBaseline['context'];
  device_profile_id: string;
  distinct_date_count: number;
  id: string;
  kind: BodySignalPersonalBaseline['kind'];
  mad: number;
  maximum: number;
  median: number;
  minimum: number;
  p10: number;
  p90: number;
  readiness: BodySignalPersonalBaseline['readiness'];
  sample_count: number;
  standard_deviation: number | null;
  updated_at: number;
  window_ended_at: number;
  window_started_at: number;
};

function baselineFromRow(row: BaselineRow): BodySignalPersonalBaseline {
  return {
    algorithmVersion: row.algorithm_version,
    average: row.average,
    bucketCount: row.bucket_count,
    context: row.context_bucket,
    dateCount: row.distinct_date_count,
    deviceProfileId: row.device_profile_id,
    id: row.id,
    kind: row.kind,
    mad: row.mad,
    maximum: row.maximum,
    median: row.median,
    minimum: row.minimum,
    p10: row.p10,
    p90: row.p90,
    readiness: row.readiness,
    sampleCount: row.sample_count,
    ...(row.standard_deviation === null ? {} : { standardDeviation: row.standard_deviation }),
    updatedAt: row.updated_at,
    windowEndedAt: row.window_ended_at,
    windowStartedAt: row.window_started_at,
  };
}

export async function loadBodySignalPersonalBaseline(
  deviceProfileId: string,
  kind: BodySignalPersonalBaseline['kind'],
  context: BodySignalPersonalBaseline['context'],
): Promise<BodySignalPersonalBaseline | undefined> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const row = await database.getFirstAsync<BaselineRow>(
    `SELECT * FROM body_signal_personal_baselines
      WHERE device_profile_id = ? AND kind = ? AND context_bucket = ?`,
    deviceProfileId,
    kind,
    context,
  );
  return row ? baselineFromRow(row) : undefined;
}

export async function saveBodySignalCareEvent(event: BodySignalCareEvent): Promise<void> {
  assertBodySignalCareEvent(event);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO body_signal_care_events (
         id, kind, context_bucket, severity, status,
         reason_code, direction, dedupe_key, baseline_id,
         context_confidence, expires_at, observed_at,
         created_at, updated_at, handled_at, dismissed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         context_bucket = excluded.context_bucket,
         severity = excluded.severity,
         status = excluded.status,
         reason_code = excluded.reason_code,
         direction = excluded.direction,
         dedupe_key = excluded.dedupe_key,
         baseline_id = excluded.baseline_id,
         context_confidence = excluded.context_confidence,
         expires_at = excluded.expires_at,
         observed_at = excluded.observed_at,
         updated_at = excluded.updated_at,
         handled_at = excluded.handled_at,
         dismissed_at = excluded.dismissed_at`,
      event.id,
      event.kind,
      event.context,
      event.severity,
      event.status,
      event.reason,
      event.direction,
      event.dedupeKey,
      event.baselineId ?? null,
      event.contextConfidence,
      event.expiresAt,
      event.observedAt,
      event.createdAt,
      event.updatedAt,
      event.handledAt ?? null,
      event.dismissedAt ?? null,
    );
    await transaction.runAsync(
      'DELETE FROM body_signal_care_event_evidence WHERE event_id = ?',
      event.id,
    );
    for (const evidence of event.evidence) {
      await transaction.runAsync(
        `INSERT INTO body_signal_care_event_evidence (
           id, event_id, reading_id, kind, value, unit, measured_at,
           source_provider, source_device_name, confidence
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        evidence.id,
        evidence.eventId,
        evidence.readingId ?? null,
        evidence.kind,
        evidence.value,
        evidence.unit,
        evidence.measuredAt,
        evidence.sourceProvider,
        evidence.sourceDeviceName ?? null,
        evidence.confidence,
      );
    }
  });
}

export async function loadRecentBodySignalCareEvents(limit = 20): Promise<BodySignalCareEvent[]> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<any>(
    `SELECT * FROM body_signal_care_events
      ORDER BY observed_at DESC LIMIT ?`,
    Math.max(0, Math.min(100, Math.floor(limit))),
  );
  const events: BodySignalCareEvent[] = [];
  for (const row of rows) {
    const evidenceRows = await database.getAllAsync<any>(
      `SELECT * FROM body_signal_care_event_evidence
        WHERE event_id = ? ORDER BY measured_at ASC`,
      row.id,
    );
    const evidence: BodySignalCareEventEvidence[] = evidenceRows.map((item) => ({
      confidence: item.confidence,
      eventId: item.event_id,
      id: item.id,
      kind: item.kind,
      measuredAt: item.measured_at,
      ...(item.reading_id ? { readingId: item.reading_id } : {}),
      ...(item.source_device_name ? { sourceDeviceName: item.source_device_name } : {}),
      sourceProvider: item.source_provider,
      unit: item.unit,
      value: item.value,
    }));
    events.push({
      ...(row.baseline_id ? { baselineId: row.baseline_id } : {}),
      context: row.context_bucket,
      contextConfidence: row.context_confidence,
      createdAt: row.created_at,
      dedupeKey: row.dedupe_key,
      direction: row.direction,
      ...(row.dismissed_at ? { dismissedAt: row.dismissed_at } : {}),
      evidence,
      expiresAt: row.expires_at,
      ...(row.handled_at ? { handledAt: row.handled_at } : {}),
      id: row.id,
      kind: row.kind,
      observedAt: row.observed_at,
      reason: row.reason_code,
      severity: row.severity,
      status: row.status,
      updatedAt: row.updated_at,
    });
  }
  return events;
}

/** Exact source lookup; old care cards must not depend on the latest-100 page. */
export async function loadBodySignalCareEvidence(eventId: string): Promise<BodySignalCareEventEvidence[]> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<any>(
    'SELECT * FROM body_signal_care_event_evidence WHERE event_id = ? ORDER BY measured_at ASC', eventId,
  );
  return rows.map(row => ({ id: row.id, eventId: row.event_id, kind: row.kind, value: row.value,
    unit: row.unit, measuredAt: row.measured_at, confidence: row.confidence, sourceProvider: row.source_provider,
    ...(row.reading_id ? { readingId: row.reading_id } : {}),
    ...(row.source_device_name ? { sourceDeviceName: row.source_device_name } : {}),
  }));
}

export type BodySignalCareDoorbellEvent = Pick<
  BodySignalCareEvent,
  'id' | 'observedAt' | 'severity'
>;

export async function loadPendingBodySignalCareDoorbellEvents(
  now = Date.now(),
): Promise<BodySignalCareDoorbellEvent[]> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<any>(
    `SELECT id, observed_at, severity
       FROM body_signal_care_events
      WHERE status = 'pending'
        AND expires_at >= ?
        AND severity IN ('support', 'concern')
      ORDER BY CASE severity WHEN 'concern' THEN 0 ELSE 1 END,
               observed_at DESC,
               id ASC`,
    now,
  );
  return rows.map((row) => ({
    id: String(row.id),
    observedAt: Number(row.observed_at),
    severity: row.severity,
  }));
}

export async function markBodySignalCareEventsHandled(
  eventIds: readonly string[],
  handledAt = Date.now(),
): Promise<void> {
  const ids = [...new Set(eventIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return;
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const placeholders = ids.map(() => '?').join(', ');
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `UPDATE body_signal_care_events
          SET status = 'handled',
              updated_at = ?,
              handled_at = ?,
              dismissed_at = NULL
        WHERE id IN (${placeholders})
          AND status = 'pending'`,
      handledAt,
      handledAt,
      ...ids,
    );
  });
}

export async function loadBodySignalCareEventByDedupeKeySince(
  dedupeKey: string,
  since: number,
): Promise<BodySignalCareEvent | undefined> {
  const events = await loadRecentBodySignalCareEvents(100);
  return events.find((event) => (
    event.dedupeKey === dedupeKey && event.observedAt >= since
  ));
}
