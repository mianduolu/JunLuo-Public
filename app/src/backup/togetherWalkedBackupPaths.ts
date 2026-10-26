export type TogetherWalkedBackupImageTarget = 'draft' | 'entry';
export type TogetherWalkedBackupDirectoryReadMode = 'best-effort' | 'restore';

export type TogetherWalkedBackupDirectoryIo = {
  getInfoAsync: (uri: string) => Promise<{ exists: boolean; isDirectory?: boolean }>;
  readDirectoryAsync: (uri: string) => Promise<string[]>;
};

export async function listTogetherWalkedBackupDirectory(
  directoryUri: string,
  io: TogetherWalkedBackupDirectoryIo,
  mode: TogetherWalkedBackupDirectoryReadMode,
) {
  const listDirectory = async () => {
    const info = await io.getInfoAsync(directoryUri);
    if (!info.exists) return [];
    if (!info.isDirectory) throw new Error(`TogetherWalked media path is not a directory: ${directoryUri}`);
    return io.readDirectoryAsync(directoryUri);
  };
  if (mode === 'best-effort') {
    try {
      return await listDirectory();
    } catch {
      return [];
    }
  }
  return listDirectory();
}

function isSafeTogetherWalkedBackupFileName(value: string) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)
    && value !== '.'
    && value !== '..';
}

export function isSafeTogetherWalkedBackupRelativePath(relativePath: string) {
  const parts = relativePath.split('/');
  if (parts.length === 1) {
    return parts[0] !== 'drafts' && isSafeTogetherWalkedBackupFileName(parts[0]);
  }
  return parts.length === 2
    && parts[0] === 'drafts'
    && isSafeTogetherWalkedBackupFileName(parts[1]);
}

export function getManagedTogetherWalkedBackupRelativePath(uri: string, imageFolder: string) {
  if (!uri.startsWith('file://')) return null;
  const pathUri = uri.split(/[?#]/)[0] ?? '';
  const marker = '/' + imageFolder + '/';
  const markerIndex = pathUri.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const relativePath = pathUri.slice(markerIndex + marker.length);
  return isSafeTogetherWalkedBackupRelativePath(relativePath) ? relativePath : null;
}

export function rewriteManagedTogetherWalkedImageUri(
  uri: string,
  restoredDirectory: string,
  imageFolder: string,
  target: TogetherWalkedBackupImageTarget,
) {
  const relativePath = getManagedTogetherWalkedBackupRelativePath(uri, imageFolder);
  if (!relativePath) return uri;
  const isDraft = relativePath.startsWith('drafts/');
  if ((target === 'draft') !== isDraft) return uri;
  const directory = restoredDirectory.endsWith('/') ? restoredDirectory : restoredDirectory + '/';
  return directory + relativePath;
}
