import * as FileSystem from 'expo-file-system/legacy';

import { listPreImportBackupSnapshots } from '../backup/backupService';

export type MemorySystemDiagnosticSeverity = 'ok' | 'notice' | 'warning';

export type MemorySystemDiagnosticActionTarget =
  | 'system_health'
  | 'memory_health'
  | 'candidate_reviews'
  | 'memory_catalog';

export type MemorySystemDiagnosticItem = {
  actionLabel?: string;
  actionTarget?: MemorySystemDiagnosticActionTarget;
  count?: number;
  detail: string;
  id: string;
  severity: MemorySystemDiagnosticSeverity;
  title: string;
};

export type MemorySystemDiagnosticsSnapshot = {
  items: MemorySystemDiagnosticItem[];
  summary: string;
  title: string;
};

const BACKUP_CACHE_PREFIX = 'JunLuo-backup-';
const BACKUP_CACHE_SUFFIX = '.zip';
const PRE_IMPORT_SNAPSHOT_LIMIT = 3;
const SAFE_WRITE_MARKERS = ['.junluo-safe-', '.junluo-staging-', '.junluo-rollback-'];

function formatDateTime(value?: string | number) {
  if (!value) return '';
  const date = typeof value === 'number' ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('zh-CN');
}

function makeItem(
  id: string,
  title: string,
  detail: string,
  severity: MemorySystemDiagnosticSeverity,
  count?: number,
): MemorySystemDiagnosticItem {
  return { count, detail, id, severity, title };
}

async function probeDirectoryWritable(directoryUri: string) {
  const probeUri = `${directoryUri}junluo-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await FileSystem.writeAsStringAsync(probeUri, 'ok');
    const info = await FileSystem.getInfoAsync(probeUri);
    await FileSystem.deleteAsync(probeUri, { idempotent: true }).catch(() => undefined);
    return info.exists && !info.isDirectory;
  } catch {
    await FileSystem.deleteAsync(probeUri, { idempotent: true }).catch(() => undefined);
    return false;
  }
}

async function scanSafeWriteTemps(rootUri: string | null | undefined, maxDepth = 3) {
  if (!rootUri) return [];
  const found: string[] = [];

  async function visit(directoryUri: string, depth: number) {
    if (depth > maxDepth || found.length >= 30) return;
    let names: string[];
    try {
      names = await FileSystem.readDirectoryAsync(directoryUri);
    } catch {
      return;
    }

    for (const name of names) {
      if (found.length >= 30) return;
      const uri = `${directoryUri}${name}`;
      if (SAFE_WRITE_MARKERS.some((marker) => name.includes(marker))) {
        found.push(uri);
        continue;
      }
      if (depth < maxDepth) {
        const info = await FileSystem.getInfoAsync(uri).catch(() => null);
        if (info?.exists && info.isDirectory) {
          await visit(`${uri}/`, depth + 1);
        }
      }
    }
  }

  await visit(rootUri, 0);
  return found;
}

async function loadCachedBackupExports() {
  const cacheDirectory = FileSystem.cacheDirectory;
  if (!cacheDirectory) return [];
  let names: string[];
  try {
    names = await FileSystem.readDirectoryAsync(cacheDirectory);
  } catch {
    return [];
  }

  const backups = await Promise.all(
    names
      .filter((name) => name.startsWith(BACKUP_CACHE_PREFIX) && name.endsWith(BACKUP_CACHE_SUFFIX))
      .map(async (name) => {
        const uri = `${cacheDirectory}${name}`;
        const info = await FileSystem.getInfoAsync(uri);
        if (!info.exists || info.isDirectory) return null;
        return {
          createdAt: typeof info.modificationTime === 'number' ? info.modificationTime * 1000 : 0,
          name,
          size: typeof info.size === 'number' ? info.size : undefined,
          uri,
        };
      }),
  );

  return backups
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .sort((left, right) => right.createdAt - left.createdAt);
}

export async function buildMemorySystemDiagnosticsSnapshot(): Promise<MemorySystemDiagnosticsSnapshot> {
  const items: MemorySystemDiagnosticItem[] = [];
  const documentDirectory = FileSystem.documentDirectory;
  const cacheDirectory = FileSystem.cacheDirectory;

  if (!documentDirectory || !cacheDirectory) {
    items.push(makeItem(
      'file-system-unavailable',
      '文件目录不可用',
      '当前设备没有暴露应用文件目录，备份和本地素材可能无法安全写入。',
      'warning',
    ));
  } else {
    const [documentWritable, cacheWritable] = await Promise.all([
      probeDirectoryWritable(documentDirectory),
      probeDirectoryWritable(cacheDirectory),
    ]);
    items.push(makeItem(
      'storage-writable',
      documentWritable && cacheWritable ? '本地存储可写' : '本地存储需要看一眼',
      documentWritable && cacheWritable
        ? '应用目录和缓存目录都能写入临时探针文件。'
        : `应用目录${documentWritable ? '可写' : '不可写'}，缓存目录${cacheWritable ? '可写' : '不可写'}。`,
      documentWritable && cacheWritable ? 'ok' : 'warning',
    ));
  }

  const tempRoots = await Promise.all([
    scanSafeWriteTemps(documentDirectory),
    scanSafeWriteTemps(cacheDirectory),
  ]);
  const tempFiles = tempRoots.flat();
  items.push(makeItem(
    'safe-write-temps',
    tempFiles.length ? '安全写入有临时残留' : '安全写入没有明显残留',
    tempFiles.length
      ? `发现 ${tempFiles.length} 个安全写入临时/回滚痕迹；本章只提示，不自动清理。`
      : '没有发现安全写入临时文件、staging 目录或 rollback 目录残留。',
    tempFiles.length ? 'notice' : 'ok',
    tempFiles.length,
  ));

  try {
    const snapshots = await listPreImportBackupSnapshots();
    const latest = snapshots[0];
    items.push(makeItem(
      'pre-import-snapshots',
      snapshots.length ? '导入前快照可用' : '导入前快照等待导入',
      snapshots.length
        ? `已保留 ${snapshots.length}/${PRE_IMPORT_SNAPSHOT_LIMIT} 份导入前快照，最新一份：${formatDateTime(latest.createdAt)}。`
        : '还没有导入前快照；它会在还原备份前自动生成。',
      snapshots.length ? 'ok' : 'notice',
      snapshots.length,
    ));
  } catch {
    items.push(makeItem(
      'pre-import-snapshots-error',
      '导入前快照无法读取',
      '无法列出导入前快照目录；还原备份前需要特别留意。',
      'warning',
    ));
  }

  const cachedBackups = await loadCachedBackupExports();
  const latestBackup = cachedBackups[0];
  items.push(makeItem(
    'backup-cache',
    latestBackup ? '最近有备份缓存' : '暂无备份缓存',
    latestBackup
      ? `缓存目录里最近生成过备份包：${formatDateTime(latestBackup.createdAt)}。真正长期保存仍以小仓鼠导出的 zip 为准。`
      : '缓存目录里没有看到最近生成的备份包；这不等于没有手动导出的备份。',
    latestBackup ? 'ok' : 'notice',
    cachedBackups.length,
  ));

  items.push(makeItem(
    'restore-gate',
    '备份导入闸门已开启',
    '还原备份前会先尝试生成导入前快照；快照失败时默认拦住恢复。',
    'ok',
  ));

  const warningCount = items.filter((item) => item.severity === 'warning').length;
  const noticeCount = items.filter((item) => item.severity === 'notice').length;
  return {
    items,
    summary: warningCount
      ? `系统诊断有 ${warningCount} 项需要看一眼，另外 ${noticeCount} 项只是提醒。`
      : noticeCount
        ? `系统诊断没有危险项，有 ${noticeCount} 项普通提醒。`
        : '系统诊断暂时安静，存储和备份保护都能工作。',
    title: warningCount ? '记忆系统诊断有提醒' : noticeCount ? '记忆系统诊断有小纸条' : '记忆系统诊断良好',
  };
}
