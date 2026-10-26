import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import {
  clearCameraObservationDatabase,
  exportCameraObservationDatabase,
  importCameraObservationDatabase,
  inspectCameraObservationDatabase,
} from '../camera/cameraObservationStore';
import type { DatabaseImportSource } from './sqliteBackupFiles';
import {
  CAMERA_OBSERVATION_ARCHIVE_PATH,
  createCameraBackupPrivacyManifest,
  readCameraSensitiveBackupPolicy,
  type CameraBackupPrivacyManifest,
} from './cameraBackupPrivacy';

export type PreparedCameraObservationBackup = {
  manifest: CameraBackupPrivacyManifest;
  bytes?: Uint8Array;
};

export async function sha256Bytes(bytes: Uint8Array) {
  return bytesToHex(sha256(Uint8Array.from(bytes)));
}

export async function prepareCameraObservationBackup(options: {
  includeForRollback?: boolean;
} = {}): Promise<PreparedCameraObservationBackup> {
  const policy = options.includeForRollback
    ? { schemaVersion: 1 as const, consentGranted: true }
    : await readCameraSensitiveBackupPolicy().catch(() => ({
      schemaVersion: 1 as const,
      consentGranted: false,
    }));
  if (!policy.consentGranted) {
    return { manifest: await createCameraBackupPrivacyManifest() };
  }

  const bytes = await exportCameraObservationDatabase({ includeResponsesForRollback: options.includeForRollback });
  const inspection = await inspectCameraObservationDatabase(bytes);
  if (inspection.recordCount === 0) {
    return {
      manifest: {
        temporaryFramesIncluded: false,
        manuallySavedPhotosIncluded: false,
        structuredObservations: {
          sensitive: true,
          consentGranted: true,
          included: false,
          recordCount: 0,
        },
      },
    };
  }

  return {
    bytes,
    manifest: {
      temporaryFramesIncluded: false,
      manuallySavedPhotosIncluded: false,
      structuredObservations: {
        sensitive: true,
        consentGranted: true,
        included: true,
        recordCount: inspection.recordCount,
        archivePath: CAMERA_OBSERVATION_ARCHIVE_PATH,
        schemaVersion: inspection.schemaVersion,
        byteLength: bytes.byteLength,
        sha256: await sha256Bytes(bytes),
      },
    },
  };
}

export async function validateCameraObservationBackupPayload(
  manifest: CameraBackupPrivacyManifest,
  source: DatabaseImportSource,
) {
  const structured = manifest.structuredObservations;
  if (!structured.included) throw new Error('camera_observation_backup_payload_invalid');
  const bytes = source instanceof Uint8Array ? source : undefined;
  if (bytes && bytes.byteLength !== structured.byteLength) {
    throw new Error('camera_observation_backup_payload_invalid');
  }
  if (bytes && await sha256Bytes(bytes) !== structured.sha256) {
    throw new Error('camera_observation_backup_payload_invalid');
  }
  const inspection = await inspectCameraObservationDatabase(source);
  if (
    inspection.schemaVersion !== structured.schemaVersion
    || inspection.recordCount !== structured.recordCount
  ) {
    throw new Error('camera_observation_backup_payload_invalid');
  }
  return inspection;
}

export function restoreCameraObservationBackup(source: DatabaseImportSource) {
  return importCameraObservationDatabase(source);
}

export function clearCameraObservationBackup() {
  return clearCameraObservationDatabase();
}
