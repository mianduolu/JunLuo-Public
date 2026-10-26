export const BAIYUN_STICKER_FOLDER = 'baiyun-stickers';
export const BAIYUN_STICKER_LIBRARY_STORAGE_KEY =
  'junluo.persona.stickerLibrary.v1';

const STICKER_MOOD_IDS = new Set([
  'happy',
  'angry',
  'speechless',
  'confused',
  'surprised',
  'sad',
  'like',
  'tired',
  'sleepy',
]);

function safeFileName(value: string) {
  return (
    value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function isSafeBaiyunStickerBackupRelativePath(
  relativePath: string,
) {
  const parts = relativePath.split('/');
  return (
    parts.length === 2
    && STICKER_MOOD_IDS.has(parts[0] ?? '')
    && safeFileName(parts[1] ?? '')
  );
}

function rewriteStickerUri(uri: string, stickerDirectory: string) {
  const marker = `${BAIYUN_STICKER_FOLDER}/`;
  const normalized = uri.replaceAll('\\', '/');
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return uri;
  const relativePath = normalized.slice(markerIndex + marker.length);
  if (!isSafeBaiyunStickerBackupRelativePath(relativePath)) return uri;
  return `${stickerDirectory}${relativePath}`;
}

export function rewriteRestoredBaiyunStickerUris(
  storage: Record<string, string>,
  stickerDirectory: string,
) {
  const serialized = storage[BAIYUN_STICKER_LIBRARY_STORAGE_KEY];
  if (!serialized) return storage;
  try {
    const parsed = JSON.parse(serialized) as {
      stickers?: unknown;
    };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.stickers)) {
      return storage;
    }
    let changed = false;
    const stickers = parsed.stickers.map((value) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      const sticker = value as Record<string, unknown>;
      if (typeof sticker.uri !== 'string') return sticker;
      const uri = rewriteStickerUri(sticker.uri, stickerDirectory);
      if (uri === sticker.uri) return sticker;
      changed = true;
      return { ...sticker, uri };
    });
    if (!changed) return storage;
    return {
      ...storage,
      [BAIYUN_STICKER_LIBRARY_STORAGE_KEY]: JSON.stringify({
        ...parsed,
        stickers,
      }),
    };
  } catch {
    return storage;
  }
}
