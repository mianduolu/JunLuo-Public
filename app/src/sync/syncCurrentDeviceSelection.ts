import { getSecretItem } from '../storage/secretStore';
import { DEFAULT_SYNC_DATABASE_TARGET } from './syncWorld';

const LEGACY_CURRENT_SYNC_DEVICE_ID_KEY =
  'junluo.sync.current-device-id.v1' as const;
const NEW_WORLD_CURRENT_SECRET_KEY =
  'junluo.sync.v2.staging.device.v1' as const;

/**
 * Cheaply checks whether this installation has selected a sync identity.
 *
 * Capture bridges use this before loading SQLite and crypto modules. It must
 * understand both the frozen legacy world and the active v2 secret slot: a
 * legacy-only guard would silently turn every post-rebuild business write into
 * a local-only write.
 */
export async function hasCurrentSyncDeviceSelection() {
  const key = DEFAULT_SYNC_DATABASE_TARGET === 'v2'
    ? NEW_WORLD_CURRENT_SECRET_KEY
    : LEGACY_CURRENT_SYNC_DEVICE_ID_KEY;
  // The formal device loader still reads freshly and migrates legacy secrets.
  return (await getSecretItem(key, true)) !== null;
}
