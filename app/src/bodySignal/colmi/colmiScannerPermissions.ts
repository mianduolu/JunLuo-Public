import { PermissionsAndroid, Platform } from 'react-native';

export type ColmiScannerPermissionResult = {
  missing: string[];
  ok: boolean;
  reason?: 'permission_denied' | 'unsupported_platform';
};

const BLUETOOTH_SCAN_PERMISSION = 'android.permission.BLUETOOTH_SCAN' as typeof PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
const BLUETOOTH_CONNECT_PERMISSION = 'android.permission.BLUETOOTH_CONNECT' as typeof PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;

async function requestAndroidPermission(permission: string): Promise<boolean> {
  const result = await PermissionsAndroid.request(permission as typeof PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

async function checkAndroidPermission(permission: string): Promise<boolean> {
  return PermissionsAndroid.check(permission as typeof PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
}

async function resolveColmiScannerPermissions(requestMissing: boolean): Promise<ColmiScannerPermissionResult> {
  if (Platform.OS !== 'android') {
    return { missing: [], ok: false, reason: 'unsupported_platform' };
  }

  const resolvePermission = requestMissing ? requestAndroidPermission : checkAndroidPermission;
  const missing: string[] = [];
  const androidVersion = typeof Platform.Version === 'number' ? Platform.Version : Number.parseInt(String(Platform.Version), 10);

  if (androidVersion >= 31) {
    const scanGranted = await resolvePermission(BLUETOOTH_SCAN_PERMISSION);
    const connectGranted = await resolvePermission(BLUETOOTH_CONNECT_PERMISSION);
    if (!scanGranted) missing.push('BLUETOOTH_SCAN');
    if (!connectGranted) missing.push('BLUETOOTH_CONNECT');
  } else {
    const locationGranted = await resolvePermission(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    if (!locationGranted) missing.push('ACCESS_FINE_LOCATION');
  }

  return missing.length ? { missing, ok: false, reason: 'permission_denied' } : { missing: [], ok: true };
}

export async function checkColmiScannerPermissions(): Promise<ColmiScannerPermissionResult> {
  return resolveColmiScannerPermissions(false);
}

export async function requestColmiScannerPermissions(): Promise<ColmiScannerPermissionResult> {
  return resolveColmiScannerPermissions(true);
}
