import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

export type DialerContactEntry = { contactId: string; phoneRowId: string; displayName: string; phoneNumber: string };
export type DialerContactInventory = {
  available: boolean; complete: boolean; reason?: string; match?: 'exact' | 'partial';
  matchedContactCount?: number; entries: DialerContactEntry[];
};
export type DialerOpenResult = { available: boolean; opened: boolean; reason?: string };
type DialerModule = {
  queryDialerContacts?: (name: string) => Promise<DialerContactInventory>;
  openDialer?: (number: string, binding: DialerContactEntry | null) => Promise<DialerOpenResult>;
};
const bridge = () => NativeModules.JunLuoPhoneActivity as DialerModule | undefined;
export function isChatDialerNativeAvailable() {
  return Platform.OS === 'android' && typeof bridge()?.queryDialerContacts === 'function' && typeof bridge()?.openDialer === 'function';
}
export async function requestDialerContactsPermission(): Promise<boolean> {
  if (!isChatDialerNativeAvailable()) return false;
  const permission = PermissionsAndroid.PERMISSIONS.READ_CONTACTS;
  return await PermissionsAndroid.check(permission)
    || await PermissionsAndroid.request(permission) === PermissionsAndroid.RESULTS.GRANTED;
}
export async function queryPhoneDialerContacts(name: string): Promise<DialerContactInventory> {
  if (!isChatDialerNativeAvailable()) return { available: false, complete: false, reason: 'NATIVE_UNAVAILABLE', entries: [] };
  try {
    return await bridge()!.queryDialerContacts!(name);
  } catch {
    return { available: false, complete: false, reason: 'CONTACT_READ_FAILED', entries: [] };
  }
}
export async function openPhoneDialer(number: string, entry?: DialerContactEntry): Promise<DialerOpenResult> {
  if (!isChatDialerNativeAvailable()) return { available: false, opened: false, reason: 'NATIVE_UNAVAILABLE' };
  try {
    return await bridge()!.openDialer!(number, entry ?? null);
  } catch {
    // A bridge rejection after dispatch cannot prove that nothing opened.
    return { available: true, opened: false, reason: 'DIAL_OUTCOME_UNKNOWN' };
  }
}
