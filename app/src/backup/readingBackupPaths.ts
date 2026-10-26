const READING_STORAGE_PREFIX = 'junluo.reading.';

export type ReadingBackupStats = {
  bookDirectoryCount: number;
  failedFileCount: number;
  packedFileCount: number;
  restoredFileCount: number;
  skippedFileCount: number;
  storageKeyCount: number;
};

export function createReadingBackupStats(storage: Record<string, string>): ReadingBackupStats {
  return {
    bookDirectoryCount: 0,
    failedFileCount: 0,
    packedFileCount: 0,
    restoredFileCount: 0,
    skippedFileCount: 0,
    storageKeyCount: Object.keys(storage).filter((key) => key.startsWith(READING_STORAGE_PREFIX)).length,
  };
}

export function isSafeReadingBackupPathSegment(segment: string) {
  return segment.length > 0 &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !/[\u0000-\u001F]/.test(segment);
}

export function splitSafeReadingBackupPath(relativePath: string) {
  const parts = relativePath.split('/');
  if (parts.length < 2) return null;
  if (!parts.every(isSafeReadingBackupPathSegment)) return null;
  return parts;
}

export function joinSafeReadingBackupPath(parts: string[]) {
  if (parts.length < 2 || !parts.every(isSafeReadingBackupPathSegment)) return null;
  return parts.join('/');
}
