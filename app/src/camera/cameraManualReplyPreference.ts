import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CameraObservationTimelineItem } from './cameraObservationTypes';

export const CAMERA_MANUAL_REPLY_PREFERENCE_KEY = 'junluo.cameraPerception.manualReplyAfterLook.v1';

export function parseCameraManualReplyPreference(raw: string | null): boolean {
  if (raw === null || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error('camera_manual_reply_preference_invalid');
}

export async function loadCameraManualReplyPreference(): Promise<boolean> {
  return parseCameraManualReplyPreference(await AsyncStorage.getItem(CAMERA_MANUAL_REPLY_PREFERENCE_KEY));
}

export async function saveCameraManualReplyPreference(enabled: boolean): Promise<boolean> {
  await AsyncStorage.setItem(CAMERA_MANUAL_REPLY_PREFERENCE_KEY, enabled ? 'true' : 'false');
  return enabled;
}

export function describeCameraObservationResponseStatus(status: CameraObservationTimelineItem['responseStatus']) {
  if (status === 'pending') return '等待接续';
  if (status === 'draft_ready') return '等待保存';
  if (status === 'delivered') return '已回应';
  if (status === 'cancelled') return '已取消';
  return '无需自动回应';
}
