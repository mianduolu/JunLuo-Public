import type { BodySignalWorkoutSession } from './bodySignalStructuredTypes';
import { assertBodySignalWorkoutSession } from './bodySignalStructuredValidation';

type WorkoutSessionRow = {
  calories_kcal: number | null;
  created_at: number;
  device_profile_id: string;
  distance_meters: number | null;
  ended_at: number | null;
  id: string;
  source_provider: BodySignalWorkoutSession['sourceProvider'];
  started_at: number;
  status: BodySignalWorkoutSession['status'];
  steps: number | null;
  type: BodySignalWorkoutSession['type'];
  updated_at: number;
};

export async function saveBodySignalWorkoutSession(
  session: BodySignalWorkoutSession,
): Promise<void> {
  assertBodySignalWorkoutSession(session);
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_workout_sessions (
       id, device_profile_id, source_provider, type, status,
       started_at, ended_at, steps, distance_meters, calories_kcal,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       ended_at = excluded.ended_at,
       steps = excluded.steps,
       distance_meters = excluded.distance_meters,
       calories_kcal = excluded.calories_kcal,
       updated_at = excluded.updated_at`,
    session.id,
    session.deviceProfileId,
    session.sourceProvider,
    session.type,
    session.status,
    session.startedAt,
    session.endedAt ?? null,
    session.steps ?? null,
    session.distanceMeters ?? null,
    session.caloriesKcal ?? null,
    session.createdAt,
    session.updatedAt,
  );
}

export async function linkBodySignalReadingToWorkout(
  workoutSessionId: string,
  readingId: string,
  linkedAt = Date.now(),
): Promise<void> {
  if (!workoutSessionId || !readingId) {
    throw new RangeError('workoutSessionId and readingId are required');
  }
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT OR IGNORE INTO body_signal_workout_reading_links (
       workout_session_id, reading_id, linked_at
     ) VALUES (?, ?, ?)`,
    workoutSessionId,
    readingId,
    linkedAt,
  );
}

export async function loadBodySignalWorkoutSessionsSince(
  since: number,
): Promise<BodySignalWorkoutSession[]> {
  const { getBodySignalDatabase } = await import('./bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<WorkoutSessionRow>(
    `SELECT * FROM body_signal_workout_sessions
      WHERE started_at >= ? OR ended_at >= ?
      ORDER BY started_at DESC`,
    since,
    since,
  );
  return rows.map((row) => ({
    ...(row.calories_kcal === null ? {} : { caloriesKcal: row.calories_kcal }),
    createdAt: row.created_at,
    deviceProfileId: row.device_profile_id,
    ...(row.distance_meters === null ? {} : { distanceMeters: row.distance_meters }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    id: row.id,
    sourceProvider: row.source_provider,
    startedAt: row.started_at,
    status: row.status,
    ...(row.steps === null ? {} : { steps: row.steps }),
    type: row.type,
    updatedAt: row.updated_at,
  }));
}
