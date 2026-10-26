import { BackupFormatError } from './backupTypes';

export const LEGACY_BACKUP_MAX_ENTRY_COUNT = 20_000;
export const LEGACY_BACKUP_MAX_FILE_BYTES = 1024 * 1024 * 1024;
export const LEGACY_BACKUP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;
export const LEGACY_BACKUP_MAX_ARCHIVE_BYTES = LEGACY_BACKUP_MAX_TOTAL_BYTES;

export type LegacyArchiveEntry = {
  name: string;
  unsafeOriginalName?: string;
  isDirectory: boolean;
  uncompressedSize?: number;
  streamUncompressedBytes?: (onChunk: (byteLength: number) => void) => Promise<void>;
};

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/;
const MALFORMED_PERCENT_ENCODING_PATTERN = /%(?![0-9a-f]{2})/i;
const DANGEROUS_PERCENT_ENCODING_PATTERN = /%(?:0[0-9a-f]|1[0-9a-f]|25|2e|2f|3a|5c|7f)/i;
const ABSOLUTE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function hasUnsafeEncodedPathCharacter(value: string) {
  return MALFORMED_PERCENT_ENCODING_PATTERN.test(value) || DANGEROUS_PERCENT_ENCODING_PATTERN.test(value);
}

function assertSafeArchivePath(value: string, isDirectory: boolean) {
  const path = isDirectory && value.endsWith('/') ? value.slice(0, -1) : value;
  if (
    !path ||
    (!isDirectory && value.endsWith('/')) ||
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    ABSOLUTE_SCHEME_PATTERN.test(value) ||
    hasUnsafeEncodedPathCharacter(value)
  ) {
    throw new BackupFormatError('备份包含不安全的文件路径，已经停止还原。');
  }
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new BackupFormatError('备份包含目录穿越路径，已经停止还原。');
  }
}

export function validateLegacyBackgroundAssetName(value: unknown) {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    CONTROL_CHARACTER_PATTERN.test(value) ||
    ABSOLUTE_SCHEME_PATTERN.test(value) ||
    hasUnsafeEncodedPathCharacter(value)
  ) {
    throw new BackupFormatError('备份中的背景图片名称不安全，已经停止还原。');
  }
  return value;
}

function validateByteSize(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BackupFormatError('备份中的文件大小信息无效，已经停止还原。');
  }
}

export function validateLegacyArchiveFileSize(value: unknown) {
  if (typeof value !== 'number') {
    throw new BackupFormatError('无法确认备份文件的大小，已经停止还原。');
  }
  validateByteSize(value);
  if (value > LEGACY_BACKUP_MAX_ARCHIVE_BYTES) {
    throw new BackupFormatError('备份压缩包过大，已经停止还原。');
  }
  return value;
}

export async function validateLegacyArchiveEntries(entries: readonly LegacyArchiveEntry[]) {
  if (entries.length > LEGACY_BACKUP_MAX_ENTRY_COUNT) {
    throw new BackupFormatError('备份包含的文件数量过多，已经停止还原。');
  }

  let declaredTotalBytes = 0;
  let actualTotalBytes = 0;
  for (const entry of entries) {
    assertSafeArchivePath(entry.name, entry.isDirectory);
    if (entry.unsafeOriginalName !== undefined) {
      assertSafeArchivePath(entry.unsafeOriginalName, entry.isDirectory);
      if (entry.unsafeOriginalName !== entry.name) {
        throw new BackupFormatError('备份包含被规范化过的不安全路径，已经停止还原。');
      }
    }
    if (entry.isDirectory) continue;

    if (entry.uncompressedSize !== undefined) {
      validateByteSize(entry.uncompressedSize);
      if (entry.uncompressedSize > LEGACY_BACKUP_MAX_FILE_BYTES) {
        throw new BackupFormatError('备份中的单个文件过大，已经停止还原。');
      }
      declaredTotalBytes += entry.uncompressedSize;
      if (declaredTotalBytes > LEGACY_BACKUP_MAX_TOTAL_BYTES) {
        throw new BackupFormatError('备份展开后的总大小过大，已经停止还原。');
      }
    }

    if (!entry.streamUncompressedBytes) {
      throw new BackupFormatError('无法确认备份文件的实际展开大小，已经停止还原。');
    }

    let actualFileBytes = 0;
    try {
      await entry.streamUncompressedBytes((chunkBytes) => {
        validateByteSize(chunkBytes);
        actualFileBytes += chunkBytes;
        if (actualFileBytes > LEGACY_BACKUP_MAX_FILE_BYTES) {
          throw new BackupFormatError('备份中的单个文件过大，已经停止还原。');
        }
        actualTotalBytes += chunkBytes;
        if (actualTotalBytes > LEGACY_BACKUP_MAX_TOTAL_BYTES) {
          throw new BackupFormatError('备份展开后的总大小过大，已经停止还原。');
        }
      });
    } catch (error) {
      if (error instanceof BackupFormatError) throw error;
      throw new BackupFormatError('无法读取备份中的文件，已经停止还原。');
    }
  }
}
