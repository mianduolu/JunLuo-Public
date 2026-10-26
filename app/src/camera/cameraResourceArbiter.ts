import { Platform } from 'react-native';

import { CAMERA_NATIVE_MODULE_UNAVAILABLE, cameraPerceptionNative } from './cameraPerceptionNative';

export type ManualCameraLease = {
  leaseId: string;
  owner: 'manual_camera';
};

export async function acquireManualCameraResource(): Promise<ManualCameraLease | undefined> {
  if (Platform.OS !== 'android') return undefined;
  if (!cameraPerceptionNative.available) throw new Error(CAMERA_NATIVE_MODULE_UNAVAILABLE);
  const receipt = await cameraPerceptionNative.acquireResource('manual_camera');
  if (!receipt.ok || !receipt.leaseId) {
    throw new Error(receipt.failureCode ?? 'camera_resource_busy');
  }
  return { leaseId: receipt.leaseId, owner: 'manual_camera' };
}

export async function releaseManualCameraResource(lease: ManualCameraLease | undefined) {
  if (!lease) return;
  const receipt = await cameraPerceptionNative.releaseResource(lease.owner, lease.leaseId);
  if (!receipt.ok && receipt.failureCode !== 'camera_stale_session') {
    throw new Error(receipt.failureCode ?? 'camera_resource_lease_mismatch');
  }
}

export async function withManualCameraResource<T>(work: () => Promise<T>): Promise<T> {
  const lease = await acquireManualCameraResource();
  try {
    return await work();
  } finally {
    await releaseManualCameraResource(lease);
  }
}
