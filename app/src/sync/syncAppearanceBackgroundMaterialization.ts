import * as FileSystem from 'expo-file-system/legacy';

import { copyFileSafely } from '../storage/safeFileWrite';
import type {
  AppearanceBackgroundObject,
} from './syncAppearanceBackground';

function expect(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function backgroundDirectory() {
  expect(
    !!FileSystem.documentDirectory,
    '当前设备无法访问应用文件目录。',
  );
  return `${FileSystem.documentDirectory}backgrounds/`;
}

export function appearanceBackgroundMaterializedUri(
  record: AppearanceBackgroundObject,
) {
  expect(
    /^[A-Za-z0-9_-]{43}$/.test(record.objectId),
    'appearance.background materialize objectId 无效。',
  );
  expect(
    /^[a-z0-9]{1,8}$/.test(record.extension),
    'appearance.background materialize extension 无效。',
  );
  return `${backgroundDirectory()}sync-${record.objectId}.${record.extension}`;
}

export async function materializeAppearanceBackgroundFile(input: {
  sourceUri: string;
  record: AppearanceBackgroundObject;
}) {
  expect(
    /^file:\/\//.test(input.sourceUri),
    'appearance.background materialize sourceUri 必须是 file URI。',
  );
  const targetUri = appearanceBackgroundMaterializedUri(input.record);
  if (input.sourceUri === targetUri) return targetUri;
  await FileSystem.makeDirectoryAsync(backgroundDirectory(), {
    intermediates: true,
  });
  await copyFileSafely({
    from: input.sourceUri,
    to: targetUri,
  });
  const [sourceInfo, targetInfo] = await Promise.all([
    FileSystem.getInfoAsync(input.sourceUri),
    FileSystem.getInfoAsync(targetUri),
  ]);
  expect(
    sourceInfo.exists
      && targetInfo.exists
      && !sourceInfo.isDirectory
      && !targetInfo.isDirectory
      && (
        typeof sourceInfo.size !== 'number'
        || typeof targetInfo.size !== 'number'
        || sourceInfo.size === targetInfo.size
      ),
    'appearance.background 图片原子落盘后文件大小不一致。',
  );
  return targetUri;
}
