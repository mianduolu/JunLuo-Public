import { cameraPerceptionNative } from '../camera/cameraPerceptionNative';
import type { CameraSensitiveBackupPolicy } from '../camera/cameraPerceptionTypes';

export type CameraBackupPrivacyManifest = {
  temporaryFramesIncluded: false;
  manuallySavedPhotosIncluded: false;
  structuredObservations: {
    sensitive: true;
    consentGranted: boolean;
    included: boolean;
    recordCount: number;
    archivePath?: string;
    schemaVersion?: number;
    byteLength?: number;
    sha256?: string;
  };
};

export const CAMERA_OBSERVATION_STORAGE_PREFIX = 'junluo.cameraObservation.';
export const CAMERA_OBSERVATION_ARCHIVE_PATH = 'JunLuo/sensitive/camera-observations-v1.sqlite';

export function shouldExcludeCameraStorageKey(key: string) {
  return key.startsWith(CAMERA_OBSERVATION_STORAGE_PREFIX);
}

export async function readCameraSensitiveBackupPolicy(): Promise<CameraSensitiveBackupPolicy> {
  if (!cameraPerceptionNative.available) {
    return { schemaVersion: 1, consentGranted: false };
  }
  return cameraPerceptionNative.getSensitiveBackupPolicy();
}

export async function setCameraSensitiveBackupPolicy(consentGranted: boolean) {
  return cameraPerceptionNative.setSensitiveBackupPolicy(consentGranted);
}

export async function createCameraBackupPrivacyManifest(): Promise<CameraBackupPrivacyManifest> {
  const policy = await readCameraSensitiveBackupPolicy().catch(() => ({
    schemaVersion: 1 as const,
    consentGranted: false,
  }));
  return {
    temporaryFramesIncluded: false,
    manuallySavedPhotosIncluded: false,
    structuredObservations: {
      sensitive: true,
      consentGranted: policy.consentGranted,
      included: false,
      recordCount: 0,
    },
  };
}
