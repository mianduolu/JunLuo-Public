import { Linking, PermissionsAndroid, Platform } from 'react-native';

export type CameraPermissionStatus =
  | 'checking'
  | 'granted'
  | 'not_granted'
  | 'denied'
  | 'blocked'
  | 'unavailable';

let lastDeniedStatus: Extract<CameraPermissionStatus, 'denied' | 'blocked'> | null = null;

export function normalizeCameraPermissionRequestResult(
  result: string,
  platform: string = Platform.OS,
): CameraPermissionStatus {
  if (platform !== 'android') return 'unavailable';
  if (result === PermissionsAndroid.RESULTS.GRANTED) return 'granted';
  if (result === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) return 'blocked';
  return 'denied';
}

export async function checkCameraPermission(): Promise<CameraPermissionStatus> {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    const granted = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.CAMERA);
    if (granted) {
      lastDeniedStatus = null;
      return 'granted';
    }
    return lastDeniedStatus ?? 'not_granted';
  } catch {
    return 'unavailable';
  }
}

export async function requestCameraPermissionFromUserAction(): Promise<CameraPermissionStatus> {
  if (Platform.OS !== 'android') return 'unavailable';
  try {
    const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
    const status = normalizeCameraPermissionRequestResult(result);
    lastDeniedStatus = status === 'denied' || status === 'blocked' ? status : null;
    return status;
  } catch {
    return 'unavailable';
  }
}

export async function openCameraPermissionSettings(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    await Linking.openSettings();
    return true;
  } catch {
    return false;
  }
}
