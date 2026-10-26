import type { DialerContactEntry, DialerContactInventory } from '../backend/dialerNative';
import type { JunLuoToolCall, JunLuoToolResult } from './toolTypes';

export const DIALER_TOOL_ID = 'communication.open_phone_dialer';
export const DIALER_CATALOG_DESCRIPTION = '按电话号码或通讯录中的姓名、备注，打开填好号码的拨号页。';
export const DIALER_DESCRIPTION = DIALER_CATALOG_DESCRIPTION;
export const DIALER_TARGET_DESCRIPTION = '想拨打的电话号码，或联系人在通讯录中的姓名、备注。';
export const DIALER_OPEN_FAILED = '这次没能打开拨号页。';
export const DIALER_READ_FAILED = '这次没能读取通讯录。';
export const DIALER_PERMISSION_MISSING = '尚未获得通讯录读取权限。';

export function normalizeDialerNumber(value: string): string | null {
  const number = value.trim().replace(/[ ().-]/g, '');
  return /^\+?[0-9]{3,24}$/.test(number) ? number : null;
}
export function parseDialerTarget(value: unknown): { kind: 'number'; phoneNumber: string }
  | { kind: 'contact'; name: string } | { kind: 'invalid' } {
  if (typeof value !== 'string' || !value.trim()) return { kind: 'invalid' };
  const text = value.trim();
  if (/^[0-9 ().+\-]+$/.test(text)) {
    const phoneNumber = normalizeDialerNumber(text);
    return phoneNumber ? { kind: 'number', phoneNumber } : { kind: 'invalid' };
  }
  return { kind: 'contact', name: text };
}
export function createDialerOpportunity(sourceMessageId: string) {
  let available = true;
  return { sourceMessageId, available: () => available, consume: () => {
    if (!available) return false;
    available = false; return true;
  } };
}
export type DialerOpportunity = ReturnType<typeof createDialerOpportunity>;
export const dialerEntryKey = (entry: DialerContactEntry) => `${entry.contactId}:${entry.phoneRowId}`;
const normalizeName = (value: string) => value.trim().replace(/[A-Z]/g, char => char.toLowerCase());
export function resolveDialerContacts(name: string, inventory: DialerContactInventory):
  { kind: 'selected'; entry: DialerContactEntry } | { kind: 'choose'; entries: DialerContactEntry[] }
  | { kind: 'not_found' | 'no_number' | 'read_failed' | 'permission_missing' | 'unavailable' } {
  if (inventory.reason === 'CONTACT_PERMISSION_MISSING') return { kind: 'permission_missing' };
  if (inventory.reason === 'NATIVE_UNAVAILABLE') return { kind: 'unavailable' };
  if (!inventory.available || !inventory.complete || !Array.isArray(inventory.entries)) return { kind: 'read_failed' };
  if (inventory.reason === 'CONTACT_HAS_NO_NUMBER') return { kind: 'no_number' };
  const requested = normalizeName(name);
  const unique = new Map<string, DialerContactEntry>();
  let partial = inventory.match === 'partial';
  for (const entry of inventory.entries) {
    if (!entry || typeof entry.displayName !== 'string' || typeof entry.phoneNumber !== 'string'
      || !entry.contactId || !entry.phoneRowId) return { kind: 'read_failed' };
    const actual = normalizeName(entry.displayName);
    if (!actual.includes(requested)) return { kind: 'read_failed' };
    partial ||= actual !== requested;
    const number = normalizeDialerNumber(entry.phoneNumber);
    if (number) unique.set(`${entry.contactId}:${number}`, { ...entry, phoneNumber: number });
  }
  const entries = [...unique.values()];
  if (!entries.length) return { kind: inventory.matchedContactCount === 0 ? 'not_found' : 'no_number' };
  return !partial && inventory.match === 'exact' && inventory.matchedContactCount === 1 && entries.length === 1
    ? { kind: 'selected', entry: entries[0] } : { kind: 'choose', entries };
}
// Compatibility is permission-only: never expose or persist an extra resolved field in the call.
export function dialerPermissionCall<T extends Pick<JunLuoToolCall, 'input'>>(call: T, phoneNumber?: string): T {
  const parsed = parseDialerTarget(call.input.target);
  const number = phoneNumber ?? (parsed.kind === 'number' ? parsed.phoneNumber : undefined);
  return number ? { ...call, input: { ...call.input, phoneNumber: number } } : call;
}
export function projectDialerResult(result: JunLuoToolResult): JunLuoToolResult {
  if (result.toolId !== DIALER_TOOL_ID) return result;
  const { data: _data, error, ...receipt } = result;
  return { ...receipt, ...(error ? { error: { code: error.code, message: error.code } } : {}) };
}
