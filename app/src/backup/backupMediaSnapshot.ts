export type BackupMediaSourceInfo = {
  exists: boolean;
  isDirectory?: boolean;
};

export type BackupMediaSnapshotIo = {
  getInfoAsync: (uri: string) => Promise<BackupMediaSourceInfo>;
  readDirectoryAsync: (uri: string) => Promise<string[]>;
};

export type BackupMediaSnapshotOperation =
  | 'inspect-directory'
  | 'list-directory'
  | 'inspect-entry'
  | 'validate-path'
  | 'capture-file';

export type BackupMediaFileEntry = {
  relativePath: string;
  sourceUri: string;
};

export class BackupMediaSnapshotError extends Error {
  readonly operation: BackupMediaSnapshotOperation;
  readonly originalError: unknown;
  readonly sourceUri: string;

  constructor(sourceUri: string, operation: BackupMediaSnapshotOperation, originalError: unknown) {
    const detail = originalError instanceof Error ? originalError.message : 'unknown media snapshot failure';
    super(`Media snapshot ${operation} failed for ${sourceUri}: ${detail}`);
    this.name = 'BackupMediaSnapshotError';
    this.operation = operation;
    this.originalError = originalError;
    this.sourceUri = sourceUri;
  }
}

function asDirectoryUri(uri: string) {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

function isSafePathSegment(value: string) {
  return value.length > 0 && value !== '.' && value !== '..' && !/[\\/\u0000-\u001f\u007f]/.test(value);
}

function wrapSnapshotError(
  sourceUri: string,
  operation: BackupMediaSnapshotOperation,
  error: unknown,
) {
  return error instanceof BackupMediaSnapshotError
    ? error
    : new BackupMediaSnapshotError(sourceUri, operation, error);
}

async function inspectSource(
  io: BackupMediaSnapshotIo,
  sourceUri: string,
  operation: 'inspect-directory' | 'inspect-entry',
) {
  try {
    return await io.getInfoAsync(sourceUri);
  } catch (error) {
    throw wrapSnapshotError(sourceUri, operation, error);
  }
}

async function listSourceDirectory(io: BackupMediaSnapshotIo, sourceDirectoryUri: string) {
  try {
    return await io.readDirectoryAsync(sourceDirectoryUri);
  } catch (error) {
    throw wrapSnapshotError(sourceDirectoryUri, 'list-directory', error);
  }
}

function assertSafeRelativePath(relativePath: string, sourceUri: string) {
  if (!relativePath.split('/').every(isSafePathSegment)) {
    throw new BackupMediaSnapshotError(sourceUri, 'validate-path', new Error('unsafe media path'));
  }
}

export async function captureBackupMediaFileStrict(options: {
  sourceUri: string;
  relativePath: string;
  io: BackupMediaSnapshotIo;
  captureFile: (entry: BackupMediaFileEntry) => Promise<void>;
}) {
  assertSafeRelativePath(options.relativePath, options.sourceUri);
  const info = await inspectSource(options.io, options.sourceUri, 'inspect-entry');
  if (!info.exists || info.isDirectory) {
    throw new BackupMediaSnapshotError(
      options.sourceUri,
      'inspect-entry',
      new Error(info.isDirectory ? 'media source is a directory' : 'media source does not exist'),
    );
  }
  const entry = { relativePath: options.relativePath, sourceUri: options.sourceUri };
  try {
    await options.captureFile(entry);
  } catch (error) {
    throw wrapSnapshotError(options.sourceUri, 'capture-file', error);
  }
  return entry;
}

export async function captureBackupMediaDirectoryStrict(options: {
  sourceDirectoryUri: string;
  io: BackupMediaSnapshotIo;
  captureFile: (entry: BackupMediaFileEntry) => Promise<void>;
}) {
  const sourceDirectoryUri = asDirectoryUri(options.sourceDirectoryUri);
  const rootInfo = await inspectSource(options.io, sourceDirectoryUri, 'inspect-directory');
  if (!rootInfo.exists) return { fileCount: 0, relativePaths: [] as string[] };
  if (!rootInfo.isDirectory) {
    throw new BackupMediaSnapshotError(
      sourceDirectoryUri,
      'inspect-directory',
      new Error('media source root is not a directory'),
    );
  }

  const relativePaths: string[] = [];
  const visitDirectory = async (directoryUri: string, prefix: string): Promise<void> => {
    const names = await listSourceDirectory(options.io, directoryUri);
    for (const name of names) {
      const sourceUri = `${directoryUri}${name}`;
      if (!isSafePathSegment(name)) {
        throw new BackupMediaSnapshotError(sourceUri, 'validate-path', new Error('unsafe media path segment'));
      }
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const info = await inspectSource(options.io, sourceUri, 'inspect-entry');
      if (!info.exists) {
        throw new BackupMediaSnapshotError(sourceUri, 'inspect-entry', new Error('media source disappeared'));
      }
      if (info.isDirectory) {
        await visitDirectory(`${sourceUri}/`, relativePath);
        continue;
      }
      try {
        await options.captureFile({ relativePath, sourceUri });
      } catch (error) {
        throw wrapSnapshotError(sourceUri, 'capture-file', error);
      }
      relativePaths.push(relativePath);
    }
  };

  await visitDirectory(sourceDirectoryUri, '');
  return { fileCount: relativePaths.length, relativePaths };
}
