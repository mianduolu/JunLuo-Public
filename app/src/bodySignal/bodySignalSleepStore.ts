import type {
  BodySignalSleepSession,
  BodySignalSleepStage,
} from './bodySignalStructuredTypes';
import { assertBodySignalSleepSession } from './bodySignalStructuredValidation';

type SleepSessionRow = {
  wake_date_key: string | null;
  algorithm_version: string | null;
  context_eligible: number;
  confidence: BodySignalSleepSession['confidence'];
  created_at: number;
  device_profile_id: string;
  ended_at: number;
  id: string;
  source_provider: BodySignalSleepSession['sourceProvider'];
  started_at: number;
  total_minutes: number;
  updated_at: number;
};

type SleepStageRow = {
  ended_at: number;
  id: string;
  sequence: number;
  session_id: string;
  stage: BodySignalSleepStage['stage'];
  started_at: number;
};

export async function saveBodySignalSleepSession(
  session: BodySignalSleepSession,
): Promise<void> {
  assertBodySignalSleepSession(session);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    await transaction.runAsync(
      `INSERT INTO body_signal_sleep_sessions (
         id, device_profile_id, source_provider, started_at, ended_at,
         total_minutes, confidence, created_at, updated_at, wake_date_key, algorithm_version, context_eligible
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         device_profile_id = excluded.device_profile_id,
         source_provider = excluded.source_provider,
         started_at = excluded.started_at,
         ended_at = excluded.ended_at,
         total_minutes = excluded.total_minutes,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at,
         wake_date_key = COALESCE(excluded.wake_date_key, body_signal_sleep_sessions.wake_date_key),
         algorithm_version = COALESCE(excluded.algorithm_version, body_signal_sleep_sessions.algorithm_version),
         context_eligible = CASE WHEN ? IS NULL THEN body_signal_sleep_sessions.context_eligible ELSE excluded.context_eligible END`,
      session.id,
      session.deviceProfileId,
      session.sourceProvider,
      session.startedAt,
      session.endedAt,
      session.totalMinutes,
      session.confidence,
      session.createdAt,
      session.updatedAt,
      session.wakeDateKey ?? null,
      session.algorithmVersion ?? null,
      session.contextEligible === false ? 0 : 1,
      session.contextEligible === undefined ? null : Number(session.contextEligible),
    );
    await transaction.runAsync(
      'DELETE FROM body_signal_sleep_stages WHERE session_id = ?',
      session.id,
    );
    for (const stage of session.stages) {
      await transaction.runAsync(
        `INSERT INTO body_signal_sleep_stages (
           id, session_id, sequence, stage, started_at, ended_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        stage.id,
        stage.sessionId,
        stage.sequence,
        stage.stage,
        stage.startedAt,
        stage.endedAt,
      );
    }
  });
}

export async function loadBodySignalSleepSessionsSince(
  since: number,
): Promise<BodySignalSleepSession[]> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const sessions = await database.getAllAsync<SleepSessionRow>(
    `SELECT * FROM body_signal_sleep_sessions
      WHERE ended_at >= ? AND context_eligible = 1 ORDER BY started_at DESC`,
    since,
  );
  const result: BodySignalSleepSession[] = [];
  for (const session of sessions) {
    const stages = await database.getAllAsync<SleepStageRow>(
      `SELECT * FROM body_signal_sleep_stages
        WHERE session_id = ? ORDER BY sequence ASC`,
      session.id,
    );
    result.push({
      wakeDateKey: session.wake_date_key ?? undefined,
      algorithmVersion: session.algorithm_version ?? undefined,
      contextEligible: session.context_eligible === 1,
      confidence: session.confidence,
      createdAt: session.created_at,
      deviceProfileId: session.device_profile_id,
      endedAt: session.ended_at,
      id: session.id,
      sourceProvider: session.source_provider,
      stages: stages.map((stage) => ({
        endedAt: stage.ended_at,
        id: stage.id,
        sequence: stage.sequence,
        sessionId: stage.session_id,
        stage: stage.stage,
        startedAt: stage.started_at,
      })),
      startedAt: session.started_at,
      totalMinutes: session.total_minutes,
      updatedAt: session.updated_at,
    });
  }
  return result;
}
