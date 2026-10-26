import * as FileSystem from 'expo-file-system/legacy';

import {
  copyFileSafely,
} from '../storage/safeFileWrite';
import type {
  ReadingObjectRecord,
} from './syncReadingObjects';

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function bookDirectory(bookId: string) {
  expect(
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bookId),
    'reading object materialize bookId 无效。',
  );
  expect(
    !!FileSystem.documentDirectory,
    '当前设备无法访问应用文件目录。',
  );
  return `${FileSystem.documentDirectory}reading/books/${bookId}/`;
}

export function readingObjectMaterializedUri(record: ReadingObjectRecord) {
  const directory = bookDirectory(record.bookId);
  if (record.role === 'source') {
    return `${directory}source.${record.extension}`;
  }
  if (record.role === 'cover') {
    return `${directory}cover.${record.extension}`;
  }
  expect(
    !!record.slot
      && record.slot.length <= 160
      && !/[\/\\\u0000-\u001f\u007f]/.test(record.slot)
      && record.slot !== '.'
      && record.slot !== '..',
    'reading extracted image slot 无效。',
  );
  return `${directory}images/${record.slot}`;
}

export async function materializeReadingObjectFile(input: {
  sourceUri: string;
  record: ReadingObjectRecord;
}) {
  expect(
    /^file:\/\//.test(input.sourceUri),
    'reading object materialize sourceUri 必须是 file URI。',
  );
  const targetUri = readingObjectMaterializedUri(input.record);
  if (input.sourceUri === targetUri) return targetUri;
  const targetDirectory = targetUri.slice(0, targetUri.lastIndexOf('/') + 1);
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
    'reading object 原子落盘后文件大小不一致。',
  );
  return targetUri;
}
