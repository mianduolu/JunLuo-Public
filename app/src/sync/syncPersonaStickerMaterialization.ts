import * as FileSystem from 'expo-file-system/legacy';

import type {
  PersonaStickerMetadataRecord,
} from './syncPersonaExpressionObjects';

const STICKER_FOLDER = 'baiyun-stickers';

function extensionForSticker(sticker: PersonaStickerMetadataRecord) {
  const fromName = sticker.name
    .match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (sticker.mimeType?.includes('png')) return 'png';
  if (sticker.mimeType?.includes('webp')) return 'webp';
  if (sticker.mimeType?.includes('gif')) return 'gif';
  return 'jpg';
}

export async function materializePersonaStickerObjectFile(input: {
  sourceUri: string;
  sticker: PersonaStickerMetadataRecord;
}) {
  if (!FileSystem.documentDirectory) {
    throw new Error('当前设备无法访问本地表情包目录。');
  }
  if (!/^file:\/\//.test(input.sourceUri)) {
    throw new Error('已验证贴纸对象必须提供本机 file URI。');
  }
  const source = await FileSystem.getInfoAsync(input.sourceUri);
  if (!source.exists || source.isDirectory) {
    throw new Error('已验证贴纸对象文件不存在。');
  }
  const directory = `${FileSystem.documentDirectory}${STICKER_FOLDER}/${input.sticker.moodId}/`;
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const targetUri = `${directory}${input.sticker.objectId}.${extensionForSticker(input.sticker)}`;
  const target = await FileSystem.getInfoAsync(targetUri);
  if (!target.exists) {
    await FileSystem.copyAsync({
      from: input.sourceUri,
      to: targetUri,
    });
  } else if (target.isDirectory) {
    throw new Error('贴纸物化目标被同名目录占用。');
  }
  return targetUri;
}
