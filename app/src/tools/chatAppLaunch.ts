import type { PhoneLaunchableAppEntry, PhoneLaunchableAppInventory } from '../backend/phoneActivityNative';
import type { JunLuoToolResult } from './toolTypes';

export const APP_LAUNCH_TOOL_ID = 'device.launch_app';
export const APP_LAUNCH_CATALOG_DESCRIPTION = '打开手机上的应用。';
export const APP_LAUNCH_DESCRIPTION = '按应用名称打开手机上已安装的应用。';
export const APP_LAUNCH_APP_NAME_DESCRIPTION = '想打开的应用名称，并写明要打开原版还是应用分身。';
export const APP_LAUNCH_UNAVAILABLE = '当前无法使用打开应用功能。';
export const APP_LAUNCH_READ_FAILED = '这次没能读取手机应用列表。';
export const APP_LAUNCH_AMBIGUOUS = '找到多个同名应用，需要确认要打开哪一个。';

export function createAppLaunchOpportunity(sourceMessageId: string) {
  let available = true;
  return { sourceMessageId, available: () => available, consume: () => {
    if (!available) return false;
    available = false;
    return true;
  } };
}
export type AppLaunchOpportunity = ReturnType<typeof createAppLaunchOpportunity>;

function requestedName(value: string) {
  const text = value.trim();
  const marker = text.match(/(?:\s*[（(]?\s*)(原版|应用分身|分身)\s*[）)]?$/u);
  return { name: (marker ? text.slice(0, marker.index) : text).trim().toLowerCase(),
    variant: marker ? marker[1] === '原版' ? 'original' : 'clone' : undefined };
}
function variant(entry: PhoneLaunchableAppEntry) {
  if (entry.profileType === 'android.os.usertype.profile.CLONE') return 'clone';
  if (entry.isCurrentProfile && entry.profileType?.startsWith('android.os.usertype.full.')) return 'original';
  return undefined;
}
export function appLaunchEntryKey(entry: PhoneLaunchableAppEntry) {
  return `${entry.profileSerial}:${entry.componentName}`;
}

export type AppLaunchEntryResolution = { kind: 'selected'; entry: PhoneLaunchableAppEntry }
  | { kind: 'choose'; entries: PhoneLaunchableAppEntry[] }
  | { kind: 'not_found' | 'read_failed' | 'unavailable' };

export function resolveAppLaunchEntries(appName: string, inventory: PhoneLaunchableAppInventory): AppLaunchEntryResolution {
  if (!inventory.available) return { kind: inventory.reason === 'NATIVE_UNAVAILABLE' ? 'unavailable' : 'read_failed' };
  const requested = requestedName(appName);
  if (!requested.name) return { kind: 'not_found' };
  const unique = new Map<string, PhoneLaunchableAppEntry>();
  for (const entry of inventory.entries) {
    if (entry.componentName.split('/').at(-1) === 'android.app.AppDetailsActivity') continue;
    if (requestedName(entry.title).name !== requested.name) continue;
    unique.set(appLaunchEntryKey(entry), entry);
  }
  const sameNameEntries = [...unique.values()];
  const entries = sameNameEntries.filter(entry => {
    const actualVariant = variant(entry);
    if (requested.variant && actualVariant && actualVariant !== requested.variant) return false;
    // An unknown current profile is not evidence of a requested clone.
    return !(requested.variant === 'clone' && !actualVariant && entry.isCurrentProfile);
  });
  if (!entries.length) return { kind: inventory.complete ? 'not_found' : 'read_failed' };
  if (inventory.complete && entries.length === 1 && variant(entries[0])) return { kind: 'selected', entry: entries[0] };
  // Selection may use genuine system labels/icons, never profile serials as UI aliases.
  const label = (entry: PhoneLaunchableAppEntry) => `${entry.title}\n${entry.badgeLabel ?? ''}\n${entry.iconUri ?? ''}`;
  const distinguishable = entries.every(entry => (!!variant(entry) || !!entry.badgeLabel || !!entry.iconUri)
    && !sameNameEntries.some(other => appLaunchEntryKey(other) !== appLaunchEntryKey(entry) && label(other) === label(entry)));
  return distinguishable ? { kind: 'choose', entries } : { kind: 'unavailable' };
}

export function projectAppLaunchResult(result: JunLuoToolResult): JunLuoToolResult {
  if (result.toolId !== APP_LAUNCH_TOOL_ID) return result;
  const { data: _data, error, ...receipt } = result;
  return { ...receipt, ...(error ? { error: { code: error.code, message: error.code } } : {}) };
}
