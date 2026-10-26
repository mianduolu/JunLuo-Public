import * as FileSystem from 'expo-file-system/legacy';

import {
  copyFileSafely,
} from '../storage/safeFileWrite';
import {
  TOGETHER_WALKED_DRAFT_ENTITY_ID,
  type TogetherWalkedImageObjectRecord,
} from './syncTogetherWalkedLife';

function expect(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function imageDirectory() {
  expect(
    !!FileSystem.documentDirectory,
    '当前设备无法访问应用文件目录。',
  );
  return `${FileSystem.documentDirectory}together-walked/`;
}

export function togetherWalkedImageMaterializedUri(
  record: TogetherWalkedImageObjectRecord,
) {
  expect(
    /^[A-Za-z0-9_-]{43}$/.test(record.objectId),
    'together-walked materialize objectId 无效。',
  );
  expect(
    /^[a-z0-9]{1,16}$/.test(record.extension),
    'together-walked materialize extension 无效。',
  );
  if (record.ownerType === 'draft') {
    expect(
      record.ownerId === TOGETHER_WALKED_DRAFT_ENTITY_ID,
      'together-walked draft image owner 无效。',
    );
    return `${imageDirectory()}drafts/${record.objectId}.${record.extension}`;
  }
  return `${imageDirectory()}${record.objectId}.${record.extension}`;
}

export async function materializeTogetherWalkedImageFile(input: {
  sourceUri: string;
  record: TogetherWalkedImageObjectRecord;
}) {
  expect(
    /^file:\/\//.test(input.sourceUri),
    'together-walked materialize sourceUri 必须是 file URI。',
  );
  const targetUri = togetherWalkedImageMaterializedUri(input.record);
  if (input.sourceUri === targetUri) return targetUri;
  const targetDirectory =
    targetUri.slice(0, targetUri.lastIndexOf('/') + 1);
  await FileSystem.makeDirectoryAsync(targetDirectory, {
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
    'together-walked 图片原子落盘后文件大小不一致。',
  );
  return targetUri;
}
