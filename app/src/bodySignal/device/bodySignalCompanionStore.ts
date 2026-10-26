import {
  applyBodySignalCompanionPresenceEvent,
} from './bodySignalCompanionPolicy';
import type {
  BodySignalCompanionAssociation,
  BodySignalCompanionAssociationStatus,
  BodySignalCompanionPresenceEvent,
} from './bodySignalCompanionTypes';

type CompanionAssociationRow = {
  association_id: number;
  device_profile_id: string;
  last_appeared_at: number | null;
  last_disappeared_at: number | null;
  last_error_code: string | null;
  observation_enabled: number;
  status: BodySignalCompanionAssociationStatus;
  updated_at: number;
};

function fromRow(row: CompanionAssociationRow): BodySignalCompanionAssociation {
  return {
    associationId: row.association_id,
    deviceProfileId: row.device_profile_id,
    ...(row.last_appeared_at === null ? {} : { lastAppearedAt: row.last_appeared_at }),
    ...(row.last_disappeared_at === null ? {} : { lastDisappearedAt: row.last_disappeared_at }),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    observationEnabled: row.observation_enabled === 1,
    status: row.status,
    updatedAt: row.updated_at,
  };
}

export async function loadBodySignalCompanionAssociation(
  deviceProfileId: string,
  associationId?: number,
): Promise<BodySignalCompanionAssociation | undefined> {
  const { getBodySignalDatabase } = await import('../bodySignalStore');
  const database = await getBodySignalDatabase();
  const row = await database.getFirstAsync<CompanionAssociationRow>(
    `SELECT association_id, device_profile_id, status, observation_enabled,
            last_appeared_at, last_disappeared_at, last_error_code, updated_at
       FROM body_signal_companion_associations
      WHERE device_profile_id = ?
        AND (? IS NULL OR association_id = ?)
      ORDER BY updated_at DESC
      LIMIT 1`,
    deviceProfileId,
    associationId ?? null,
    associationId ?? null,
  );
  return row ? fromRow(row) : undefined;
}

export async function saveBodySignalCompanionAssociation(
  association: BodySignalCompanionAssociation,
): Promise<void> {
  const { getBodySignalDatabase } = await import('../bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.runAsync(
    `INSERT INTO body_signal_companion_associations (
       association_id, device_profile_id, status, observation_enabled,
       last_appeared_at, last_disappeared_at, last_error_code, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(association_id) DO UPDATE SET
       device_profile_id = excluded.device_profile_id,
       status = excluded.status,
       observation_enabled = excluded.observation_enabled,
       last_appeared_at = excluded.last_appeared_at,
       last_disappeared_at = excluded.last_disappeared_at,
       last_error_code = excluded.last_error_code,
       updated_at = excluded.updated_at`,
    association.associationId,
    association.deviceProfileId,
    association.status,
    association.observationEnabled ? 1 : 0,
    association.lastAppearedAt ?? null,
    association.lastDisappearedAt ?? null,
    association.lastErrorCode ?? null,
    association.updatedAt,
  );
}

export async function updateBodySignalCompanionAssociationStatus(
  association: BodySignalCompanionAssociation,
  status: BodySignalCompanionAssociationStatus,
  observationEnabled: boolean,
  lastErrorCode?: string,
): Promise<BodySignalCompanionAssociation> {
  const next = {
    ...association,
    ...(lastErrorCode ? { lastErrorCode } : {}),
    observationEnabled,
    status,
    updatedAt: Date.now(),
  };
  await saveBodySignalCompanionAssociation(next);
  return next;
}

export async function recordBodySignalCompanionPresenceEvent(
  deviceProfileId: string,
  event: BodySignalCompanionPresenceEvent,
): Promise<BodySignalCompanionAssociation | undefined> {
  const association = await loadBodySignalCompanionAssociation(deviceProfileId);
  if (!association) return undefined;
  const next = applyBodySignalCompanionPresenceEvent(association, event);
  if (next === association) return association;
  await saveBodySignalCompanionAssociation(next);
  return next;
}
