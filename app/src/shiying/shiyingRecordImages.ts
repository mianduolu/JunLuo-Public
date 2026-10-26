import * as FileSystem from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertShiyingUuidV4 } from './shiyingContract';
import {
  createShiyingRecordImageId,
  getShiyingMediaRelativePath,
  parseShiyingRecordImageV1,
  type ShiyingRecordImageV1,
} from './shiyingJournalContract';

type FileInfo = { exists: boolean; isDirectory?: boolean; size?: number };
export type ShiyingRecordImageDependencies = {
  documentDirectory: () => string | null;
  encode: (uri: string) => Promise<{ base64: string; width: number; height: number; mimeType: 'image/jpeg' }>;
  info: (uri: string) => Promise<FileInfo>;
  readBase64: (uri: string) => Promise<string>;
  writeBase64: (uri: string, base64: string) => Promise<unknown>;
  list: (directory: string) => Promise<string[]>;
  remove: (uri: string) => Promise<unknown>;
  referencedHashes: () => Promise<string[]>;
  imageId: () => string;
};

function imageError(code: string) { return new Error(`shiying_record_image_${code}`); }
export type ShiyingRecordImageFailureStage = 'encode' | 'bytes' | 'storage' | 'write' | 'verify' | 'reference';
export function shiyingRecordImageFailureStage(error: unknown): ShiyingRecordImageFailureStage | null {
  const stage = error && typeof error === 'object' && 'imageStage' in error ? error.imageStage : null;
  return ['encode', 'bytes', 'storage', 'write', 'verify', 'reference'].includes(stage as string)
    ? stage as ShiyingRecordImageFailureStage : null;
}
function bytesHash(base64: string) {
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length || bytes.toString('base64') !== base64) throw imageError('invalid_bytes');
  return { contentHash: `sha256:${bytesToHex(sha256(bytes))}`, byteLength: bytes.length };
}

/** The record coordinator holds its queue through import, DB save and collection. */
export function createShiyingRecordImageService(dependencies: ShiyingRecordImageDependencies) {
  function directory() {
    const base = dependencies.documentDirectory();
    if (!base) throw imageError('storage_unavailable');
    return `${base.endsWith('/') ? base : `${base}/`}shiying-media/`;
  }
  function imageUri(contentHash: string) {
    const relative = getShiyingMediaRelativePath(contentHash);
    return `${directory()}${relative.slice('shiying-media/'.length)}`;
  }
  return {
    getUri: imageUri,
    async exists(contentHash: string) {
      const uri = imageUri(contentHash);
      try {
        const info = await dependencies.info(uri);
        return info.exists && !info.isDirectory && (info.size ?? 0) > 0;
      } catch { return false; }
    },
    async readForVision(image: ShiyingRecordImageV1) {
      const valid = parseShiyingRecordImageV1(image);
      try {
        const uri = imageUri(valid.contentHash);
        const info = await dependencies.info(uri);
        if (!info.exists || info.isDirectory || info.size !== valid.byteLength) throw imageError('file_missing');
        const base64 = await dependencies.readBase64(uri);
        const actual = bytesHash(base64);
        if (actual.contentHash !== valid.contentHash || actual.byteLength !== valid.byteLength) throw imageError('file_changed');
        return { imageId: valid.id, dataUrl: `data:${valid.mimeType};base64,${base64}`, encodedLength: base64.length };
      } catch { throw imageError('file_unavailable'); }
    },
    async importImage(recordId: string, ordinal: number, uri: string): Promise<ShiyingRecordImageV1> {
      assertShiyingUuidV4(recordId, 'record_image_record_id');
      if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal >= 9 || !uri.trim()) {
        throw imageError('invalid_input');
      }
      let imageStage: ShiyingRecordImageFailureStage = 'encode';
      try {
        const encoded = await dependencies.encode(uri);
        imageStage = 'bytes';
        const { contentHash, byteLength } = bytesHash(encoded.base64);
        const image = parseShiyingRecordImageV1({
          payloadVersion: 1, id: dependencies.imageId(), recordId, ordinal, contentHash,
          mimeType: encoded.mimeType, byteLength, width: encoded.width, height: encoded.height,
        });
        imageStage = 'storage';
        const target = imageUri(contentHash);
        const existing = await dependencies.info(target);
        // Identical files can be shared. Never replace or unlink an existing referenced copy.
        imageStage = 'write';
        if (!existing.exists) await dependencies.writeBase64(target, encoded.base64);
        imageStage = 'verify';
        const info = await dependencies.info(target);
        if (!info.exists || info.isDirectory || info.size !== byteLength
          || bytesHash(await dependencies.readBase64(target)).contentHash !== contentHash) {
          throw imageError('file_invalid');
        }
        return image;
      } catch {
        // Native errors may contain picker paths. Only a technical code escapes this layer.
        throw Object.assign(imageError('import_failed'), { imageStage });
      }
    },
    async collectUnused() {
      try {
        const kept = new Set((await dependencies.referencedHashes()).map(hash => {
          getShiyingMediaRelativePath(hash); // Validate before deleting any file.
          return hash.slice('sha256:'.length);
        }));
        const root = directory();
        const rootInfo = await dependencies.info(root);
        if (!rootInfo.exists) return { deleted: 0, failed: 0 };
        if (!rootInfo.isDirectory) throw imageError('directory_invalid');
        let deleted = 0, failed = 0;
        for (const name of await dependencies.list(root)) {
          if (kept.has(name)
            || !/^[a-f0-9]{64}(?:\.junluo-(?:safe|rollback)-\d+-[a-z0-9]+(?:\.tmp)?)?$/u.test(name)) continue;
          const target = `${root}${name}`;
          try {
            const info = await dependencies.info(target);
            if (!info.exists || info.isDirectory) continue;
            await dependencies.remove(target);
            deleted += 1;
          } catch { failed += 1; }
        }
        return { deleted, failed };
      } catch { throw imageError('cleanup_failed'); }
    },
  };
}

const service = createShiyingRecordImageService({
  documentDirectory: () => FileSystem.documentDirectory,
  encode: async uri => (await import('../posts/baiyunPostImageCodec')).compressPostImage(uri),
  info: uri => FileSystem.getInfoAsync(uri),
  readBase64: uri => FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }),
  writeBase64: async (uri, base64) => (await import('../storage/safeFileWrite')).writeStringFileSafely(
    uri, base64, { encoding: FileSystem.EncodingType.Base64, minimumBytes: 1 },
  ),
  list: uri => FileSystem.readDirectoryAsync(uri),
  remove: uri => FileSystem.deleteAsync(uri, { idempotent: true }),
  referencedHashes: async () => (await import('./shiyingRecordStore')).listShiyingReferencedImageHashes(),
  imageId: createShiyingRecordImageId,
});

export const importShiyingRecordImage = service.importImage;
export const getShiyingRecordImageUri = service.getUri;
export const shiyingRecordImageExists = service.exists;
export const readShiyingRecordImageForVision = service.readForVision;
export const collectUnusedShiyingRecordImages = service.collectUnused;
