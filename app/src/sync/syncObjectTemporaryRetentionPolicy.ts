export const SYNC_OBJECT_TEMPORARY_RETENTION_MS =
  24 * 60 * 60 * 1_000;

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DOWNLOAD_DIRECTORY_PATTERN =
  /^download-([A-Za-z0-9_-]{43})$/u;
const DOWNLOAD_PARTIAL_PATTERN =
  /^(?:manifest\.(?:plain|sealed)\.json|chunk-[0-9]+\.bin|content)\.partial$/u;

export function isStaleSyncObjectTemporaryEntry(
  modificationTime: number | null | undefined,
  now: number,
) {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error('content-object 临时清理时间无效。');
  }
  return typeof modificationTime === 'number'
    && Number.isFinite(modificationTime)
    && modificationTime >= 0
    && modificationTime
      <= now - SYNC_OBJECT_TEMPORARY_RETENTION_MS;
}

export function isSyncObjectCaptureStagingName(name: string) {
  return UUID_V4_PATTERN.test(name);
}

export function syncObjectIdFromDownloadStagingName(
  name: string,
) {
  return DOWNLOAD_DIRECTORY_PATTERN.exec(name)?.[1] ?? null;
}

export function isSyncObjectDownloadPartialFileName(
  name: string,
) {
  return DOWNLOAD_PARTIAL_PATTERN.test(name);
}
