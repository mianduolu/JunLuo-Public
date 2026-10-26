// Unsent input and reading positions belong to this device, not to the story.
export const THEATER_LOCAL_STORAGE_PREFIX = 'junluo.theater.local.';

export function isTheaterLocalStorageKey(key: string) {
  return key.startsWith(THEATER_LOCAL_STORAGE_PREFIX);
}
