import type {
  BodySignalContextObservation,
  BodySignalDiscomfortReport,
} from './bodySignalStructuredTypes';

type ContextRow = {
  activity_type: BodySignalContextObservation['activity'];
  boot_session_id: string | null;
  confidence: number;
  context_bucket: BodySignalContextObservation['context'];
  created_at: number;
  ended_at: number | null;
  expires_at: number;
  id: string;
  source: BodySignalContextObservation['source'];
  started_at: number;
  transition_type: BodySignalContextObservation['transition'] | null;
};

export async function saveBodySignalContextObservation(
  observation: BodySignalContextObservation,
): Promise<void> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_context_observations (
       id, context_bucket, activity_type, transition_type, source, boot_session_id,
       started_at, ended_at, confidence, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    observation.id,
    observation.context,
    observation.activity,
    observation.transition ?? null,
    observation.source,
    observation.bootSessionId ?? null,
    observation.startedAt,
    observation.endedAt ?? null,
    observation.confidence,
    observation.expiresAt,
    observation.createdAt,
  );
}

export async function loadRecentBodySignalContextObservations(
  since: number,
  limit = 100,
  through?: number,
): Promise<BodySignalContextObservation[]> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<ContextRow>(
    `SELECT * FROM body_signal_context_observations
      WHERE started_at >= ?${through === undefined ? '' : ' AND started_at <= ?'} ORDER BY started_at DESC LIMIT ?`,
    since,
    ...(through === undefined ? [] : [through]),
    Math.max(0, Math.min(512, Math.floor(limit))),
  );
  return rows.map((row) => ({
    activity: row.activity_type,
    ...(row.boot_session_id ? { bootSessionId: row.boot_session_id } : {}),
    confidence: row.confidence,
    context: row.context_bucket,
    createdAt: row.created_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    expiresAt: row.expires_at,
    id: row.id,
    source: row.source,
    startedAt: row.started_at,
    ...(row.transition_type ? { transition: row.transition_type } : {}),
  }));
}

export async function saveBodySignalDiscomfortReport(
  report: BodySignalDiscomfortReport,
): Promise<void> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_discomfort_reports (
       id, category, source_message_id, observed_at,
       confidence, expires_at, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_message_id) DO NOTHING`,
    report.id,
    report.category,
    report.sourceMessageId,
    report.observedAt,
    report.confidence,
    report.expiresAt,
    report.createdAt,
  );
}

export async function loadActiveBodySignalDiscomfortReport(
  now = Date.now(),
): Promise<BodySignalDiscomfortReport | undefined> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const row = await database.getFirstAsync<any>(
    `SELECT * FROM body_signal_discomfort_reports
      WHERE observed_at <= ? AND expires_at >= ?
      ORDER BY observed_at DESC LIMIT 1`,
    now,
    now,
  );
  if (!row) return undefined;
  return {
    category: row.category,
    confidence: row.confidence,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    id: row.id,
    observedAt: row.observed_at,
    sourceMessageId: row.source_message_id,
  };
}

export async function loadBodySignalEvaluationCursor(
  deviceProfileId: string,
  kind = 'heart_rate',
): Promise<{ lastMeasuredAt?: number; lastReadingId?: string } | undefined> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const row = await database.getFirstAsync<any>(
    `SELECT last_reading_id, last_measured_at
       FROM body_signal_evaluation_cursors
      WHERE device_profile_id = ? AND kind = ?`,
    deviceProfileId,
    kind,
  );
  return row ? {
    ...(row.last_measured_at ? { lastMeasuredAt: row.last_measured_at } : {}),
    ...(row.last_reading_id ? { lastReadingId: row.last_reading_id } : {}),
  } : undefined;
}

export async function saveBodySignalEvaluationCursor(input: {
  deviceProfileId: string;
  kind?: string;
  lastMeasuredAt: number;
  lastReadingId: string;
}): Promise<void> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_evaluation_cursors (
       device_profile_id, kind, last_reading_id, last_measured_at, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(device_profile_id, kind) DO UPDATE SET
       last_reading_id = excluded.last_reading_id,
       last_measured_at = excluded.last_measured_at,
       updated_at = excluded.updated_at`,
    input.deviceProfileId,
    input.kind ?? 'heart_rate',
    input.lastReadingId,
    input.lastMeasuredAt,
    Date.now(),
  );
}
