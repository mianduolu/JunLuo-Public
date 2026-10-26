import * as FileSystem from 'expo-file-system/legacy';

type WriteStringOptions = NonNullable<Parameters<typeof FileSystem.writeAsStringAsync>[2]>;

type SafeWriteOptions = WriteStringOptions & {
  minimumBytes?: number;
};

type SafeCopyOptions = {
  from: string;
  to: string;
  minimumBytes?: number;
};

function uniqueSafeWriteId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function stripTrailingSlash(uri: string) {
  return uri.endsWith('/') ? uri.slice(0, -1) : uri;
}

function ensureDirectoryUri(uri: string) {
  return uri.endsWith('/') ? uri : `${uri}/`;
}

function parentDirectoryOf(uri: string) {
  const normalized = stripTrailingSlash(uri);
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex < 0) {
    throw new Error(`无法识别文件目录：${uri}`);
  }
  return normalized.slice(0, slashIndex + 1);
}

async function safeDeleteAsync(uri: string) {
  await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
}

async function ensureParentDirectory(uri: string) {
  await FileSystem.makeDirectoryAsync(parentDirectoryOf(uri), { intermediates: true });
}

async function assertPreparedFile(uri: string, minimumBytes = 0) {
  const info = await FileSystem.getInfoAsync(uri);
  if (!info.exists) {
    throw new Error('安全写入失败：临时文件没有生成。');
  }
  if (!info.isDirectory && typeof info.size === 'number' && info.size < minimumBytes) {
    throw new Error('安全写入失败：临时文件大小不符合预期。');
  }
}

async function replacePathSafely(preparedUri: string, targetUri: string) {
  const rollbackUri = `${stripTrailingSlash(targetUri)}.junluo-rollback-${uniqueSafeWriteId()}`;
  const targetInfo = await FileSystem.getInfoAsync(targetUri);
  let hasRollback = false;

  await safeDeleteAsync(rollbackUri);

  if (targetInfo.exists) {
    await FileSystem.moveAsync({ from: targetUri, to: rollbackUri });
    hasRollback = true;
  }

  try {
    await FileSystem.moveAsync({ from: preparedUri, to: targetUri });
    await safeDeleteAsync(rollbackUri);
  } catch (error) {
    await safeDeleteAsync(targetUri);
    if (hasRollback) {
      await FileSystem.moveAsync({ from: rollbackUri, to: targetUri }).catch(() => undefined);
    }
    throw error;
  }
}

export async function writeStringFileSafely(uri: string, contents: string, options: SafeWriteOptions = {}) {
  await ensureParentDirectory(uri);
  const { minimumBytes, ...writeOptions } = options;
  const tempUri = `${uri}.junluo-safe-${uniqueSafeWriteId()}.tmp`;

  try {
    await FileSystem.writeAsStringAsync(tempUri, contents, writeOptions);
    await assertPreparedFile(tempUri, minimumBytes);
    await replacePathSafely(tempUri, uri);
  } catch (error) {
    await safeDeleteAsync(tempUri);
    throw error;
  }
}

export async function copyFileSafely({ from, to, minimumBytes }: SafeCopyOptions) {
  await ensureParentDirectory(to);
  const tempUri = `${to}.junluo-safe-${uniqueSafeWriteId()}.tmp`;

  try {
    await FileSystem.copyAsync({ from, to: tempUri });
    await assertPreparedFile(tempUri, minimumBytes);
    await replacePathSafely(tempUri, to);
  } catch (error) {
    await safeDeleteAsync(tempUri);
    throw error;
  }
}

export async function restoreDirectorySafely(
  targetDirectory: string,
  populateStagingDirectory: (stagingDirectory: string) => Promise<void>,
) {
  const normalizedTarget = ensureDirectoryUri(targetDirectory);
  const baseTarget = stripTrailingSlash(normalizedTarget);
  const stagingDirectory = ensureDirectoryUri(`${baseTarget}.junluo-staging-${uniqueSafeWriteId()}`);

  await FileSystem.makeDirectoryAsync(parentDirectoryOf(normalizedTarget), { intermediates: true });
  await safeDeleteAsync(stagingDirectory);
  await FileSystem.makeDirectoryAsync(stagingDirectory, { intermediates: true });

  try {
    await populateStagingDirectory(stagingDirectory);
    const stagingInfo = await FileSystem.getInfoAsync(stagingDirectory);
    if (!stagingInfo.exists || !stagingInfo.isDirectory) {
      throw new Error('安全恢复失败：临时目录没有生成。');
    }
    await replacePathSafely(stagingDirectory, normalizedTarget);
  } catch (error) {
    await safeDeleteAsync(stagingDirectory);
    throw error;
  }
}

export async function cleanupSafeWriteTemps(directoryUri: string) {
  const directory = ensureDirectoryUri(directoryUri);
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(directory);
  } catch {
    return;
  }

  await Promise.all(
    names
      .filter((name) => name.includes('.junluo-safe-') || name.includes('.junluo-staging-') || name.includes('.junluo-rollback-'))
      .map((name) => safeDeleteAsync(`${directory}${name}`)),
  );
}

