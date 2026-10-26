import * as FileSystem from 'expo-file-system/legacy';

import { copyFileSafely } from '../storage/safeFileWrite';
import type { ToolsWorkspaceFileRecord } from './syncToolsWorkspace';

function safeName(value: string) {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512) || 'workspace-file';
}

export function toolsWorkspaceFileMaterializedUri(
  record: ToolsWorkspaceFileRecord,
) {
  if (!FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问工具工作区文件目录。');
  }
  return `${FileSystem.documentDirectory}tool-file-cache/`
    + `${safeName(record.cacheId)}-${safeName(record.name)}`;
}

export async function materializeToolsWorkspaceFile(input: {
  sourceUri: string;
  record: ToolsWorkspaceFileRecord;
}) {
  if (!/^file:\/\//.test(input.sourceUri)) {
    throw new Error('工具工作区对象来源必须是本机 file URI。');
  }
  const targetUri = toolsWorkspaceFileMaterializedUri(input.record);
  if (input.sourceUri === targetUri) return targetUri;
  const directory = targetUri.slice(0, targetUri.lastIndexOf('/') + 1);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  await copyFileSafely({ from: input.sourceUri, to: targetUri });
  const [source, target] = await Promise.all([
    FileSystem.getInfoAsync(input.sourceUri),
    FileSystem.getInfoAsync(targetUri),
  ]);
  if (
    !source.exists
    || source.isDirectory
    || !target.exists
    || target.isDirectory
    || (
      typeof source.size === 'number'
      && typeof target.size === 'number'
      && source.size !== target.size
    )
  ) {
    throw new Error('工具工作区对象原子落盘后文件大小不一致。');
  }
  return targetUri;
}
