import type { BodySignalDeviceProfile } from './bodySignalDeviceTypes';

type DeviceRow = {
  authorized_association_id: string | null;
  created_at: number;
  display_name: string;
  family: BodySignalDeviceProfile['family'];
  id: string;
  is_primary: number;
  last_advertising_id: string | null;
  last_connected_at: number | null;
  protocol_identity: string | null;
  service_fingerprint: string | null;
  transport_identity: string | null;
  updated_at: number;
};

function fromRow(row: DeviceRow): BodySignalDeviceProfile {
  return {
    ...(row.authorized_association_id
      ? { authorizedAssociationId: row.authorized_association_id }
      : {}),
    createdAt: row.created_at,
    displayName: row.display_name,
    family: row.family,
    id: row.id,
    isPrimary: row.is_primary === 1,
    ...(row.last_advertising_id ? { lastAdvertisingId: row.last_advertising_id } : {}),
    ...(row.last_connected_at !== null ? { lastConnectedAt: row.last_connected_at } : {}),
    ...(row.protocol_identity ? { protocolIdentity: row.protocol_identity } : {}),
    ...(row.service_fingerprint ? { serviceFingerprint: row.service_fingerprint } : {}),
    ...(row.transport_identity ? { transportIdentity: row.transport_identity } : {}),
    updatedAt: row.updated_at,
  };
}

export async function loadBodySignalDeviceProfilesFromDatabase(): Promise<BodySignalDeviceProfile[]> {
  const { getBodySignalDatabase } = await import('../bodySignalStore');
  const database = await getBodySignalDatabase();
  const rows = await database.getAllAsync<DeviceRow>(
    `SELECT id, display_name, family, is_primary,
            authorized_association_id, last_advertising_id,
            protocol_identity, service_fingerprint, transport_identity,
            last_connected_at, created_at, updated_at
       FROM body_signal_devices
      WHERE retired_at IS NULL
      ORDER BY is_primary DESC, last_connected_at DESC, updated_at DESC`,
  );
  return rows.map(fromRow);
}

export async function updateBodySignalDeviceCompanionAssociationInDatabase(
  deviceProfileId: string,
  authorizedAssociationId: string | undefined,
  updatedAt: number,
): Promise<boolean> {
  const { getBodySignalDatabase } = await import('../bodySignalStore');
  const database = await getBodySignalDatabase();
  const result = await database.runAsync(
    `UPDATE body_signal_devices
        SET authorized_association_id = ?,
            updated_at = ?
      WHERE id = ?
        AND retired_at IS NULL`,
    authorizedAssociationId ?? null,
    updatedAt,
    deviceProfileId,
  );
  return result.changes === 1;
}

export async function replaceBodySignalDeviceProfilesInDatabase(
  profiles: readonly BodySignalDeviceProfile[],
): Promise<void> {
  const { getBodySignalDatabase } = await import('../bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    const now = Date.now();
    await transaction.runAsync(
      `UPDATE body_signal_devices
          SET is_primary = 0,
              retired_at = ?,
              updated_at = ?
        WHERE retired_at IS NULL`,
      now,
      now,
    );
    for (const profile of profiles) {
      await transaction.runAsync(
        `INSERT INTO body_signal_devices (
           id, display_name, family, is_primary,
           authorized_association_id, last_advertising_id,
           protocol_identity, service_fingerprint, transport_identity,
           last_connected_at, created_at, updated_at, retired_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
         ON CONFLICT(id) DO UPDATE SET
           display_name = excluded.display_name,
           family = excluded.family,
           is_primary = excluded.is_primary,
           authorized_association_id = excluded.authorized_association_id,
           last_advertising_id = excluded.last_advertising_id,
           protocol_identity = excluded.protocol_identity,
           service_fingerprint = excluded.service_fingerprint,
           transport_identity = excluded.transport_identity,
           last_connected_at = excluded.last_connected_at,
           updated_at = excluded.updated_at,
           retired_at = NULL`,
        profile.id,
        profile.displayName,
        profile.family,
        profile.isPrimary ? 1 : 0,
        profile.authorizedAssociationId ?? null,
        profile.lastAdvertisingId ?? null,
        profile.protocolIdentity ?? null,
        profile.serviceFingerprint ?? null,
        profile.transportIdentity ?? null,
        profile.lastConnectedAt ?? null,
        profile.createdAt,
        profile.updatedAt,
      );
    }
  });
}

export async function saveBodySignalDeviceCapabilities(
  deviceProfileId: string,
  capabilities: Record<string, { evidenceId?: string; supportLevel: string; verifiedAt?: number }>,
): Promise<void> {
  const { getBodySignalDatabase } = await import('../bodySignalStore');
  const database = await getBodySignalDatabase();
  await database.withExclusiveTransactionAsync(async (transaction) => {
    for (const [capability, value] of Object.entries(capabilities)) {
      await transaction.runAsync(
        `INSERT INTO body_signal_device_capabilities (
           device_profile_id, capability, support_level,
           evidence_id, verified_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_profile_id, capability) DO UPDATE SET
           support_level = excluded.support_level,
           evidence_id = excluded.evidence_id,
           verified_at = excluded.verified_at,
           updated_at = excluded.updated_at`,
        deviceProfileId,
        capability,
        value.supportLevel,
        value.evidenceId ?? null,
        value.verifiedAt ?? null,
        Date.now(),
      );
    }
  });
}
