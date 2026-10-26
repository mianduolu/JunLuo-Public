import { personaExpressionObjectsStorageBridge as AsyncStorage } from '../../sync/syncPersonaExpressionObjectsStorageBridge';
import * as FileSystem from 'expo-file-system/legacy';

import {
  EXPRESSION_MOOD_LABELS,
  EXPRESSION_MOOD_ORDER,
  type ExpressionMoodId,
} from './expressionLibrary';

export type BaiyunStickerMoodId = ExpressionMoodId;

export type BaiyunSticker = {
  id: string;
  moodId: BaiyunStickerMoodId;
  name: string;
  uri?: string;
  objectId?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  size?: number;
  meaning?: string;
  createdAt: number;
};

export type MaterializedBaiyunSticker = BaiyunSticker & {
  uri: string;
};

export type BaiyunStickerLibrary = {
  stickers: BaiyunSticker[];
  updatedAt: number;
};

type AddStickerInput = {
  moodId: BaiyunStickerMoodId;
  sourceUri: string;
  name?: string | null;
  mimeType?: string | null;
  width?: number | null;
  height?: number | null;
  size?: number | null;
};

const STICKER_LIBRARY_KEY = 'junluo.persona.stickerLibrary.v1';
const STICKER_FOLDER = 'baiyun-stickers';
const MAX_STICKERS = 240;
const MAX_STICKERS_PER_MOOD = 36;

export { EXPRESSION_MOOD_LABELS as STICKER_MOOD_LABELS, EXPRESSION_MOOD_ORDER as STICKER_MOOD_ORDER };

export function createEmptyStickerLibrary(): BaiyunStickerLibrary {
  return {
    stickers: [],
    updatedAt: 0,
  };
}

function isStickerMoodId(value: unknown): value is BaiyunStickerMoodId {
  return typeof value === 'string' && EXPRESSION_MOOD_ORDER.includes(value as BaiyunStickerMoodId);
}

function cleanName(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || '白云表情包').slice(0, 48);
}

function cleanMeaning(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 120);
}

function normalizeNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeSticker(value: unknown): BaiyunSticker | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<BaiyunSticker>;
  const uri = typeof candidate.uri === 'string' && candidate.uri.trim()
    ? candidate.uri
    : undefined;
  const objectId = typeof candidate.objectId === 'string'
    && /^[A-Za-z0-9_-]{43}$/.test(candidate.objectId)
    ? candidate.objectId
    : undefined;
  if (
    typeof candidate.id !== 'string' ||
    !isStickerMoodId(candidate.moodId) ||
    (!uri && !objectId)
  ) {
    return null;
  }
  const meaning = cleanMeaning(candidate.meaning);
  return {
    id: candidate.id,
    moodId: candidate.moodId,
    name: cleanName(candidate.name),
    uri,
    objectId,
    mimeType: typeof candidate.mimeType === 'string' ? candidate.mimeType : undefined,
    width: normalizeNumber(candidate.width),
    height: normalizeNumber(candidate.height),
    size: normalizeNumber(candidate.size),
    meaning: meaning || undefined,
    createdAt: typeof candidate.createdAt === 'number' ? candidate.createdAt : Date.now(),
  };
}

function normalizeStickerLibrary(value: unknown): BaiyunStickerLibrary {
  if (!value || typeof value !== 'object') return createEmptyStickerLibrary();
  const candidate = value as Partial<BaiyunStickerLibrary>;
  const stickers = Array.isArray(candidate.stickers)
    ? candidate.stickers.map(normalizeSticker).filter((item): item is BaiyunSticker => !!item).slice(-MAX_STICKERS)
    : [];
  return {
    stickers,
    updatedAt: typeof candidate.updatedAt === 'number' ? candidate.updatedAt : 0,
  };
}

export async function loadStickerLibrary(options?: { strict?: boolean }) {
  const raw = await AsyncStorage.getItem(STICKER_LIBRARY_KEY);
  if (raw === null || (!options?.strict && !raw)) return createEmptyStickerLibrary();
  try {
    return normalizeStickerLibrary(JSON.parse(raw));
  } catch (error) {
    if (options?.strict) throw error;
    return createEmptyStickerLibrary();
  }
}

export async function saveStickerLibrary(library: BaiyunStickerLibrary) {
  const normalized = normalizeStickerLibrary({
    ...library,
    updatedAt: Date.now(),
  });
  await AsyncStorage.setItem(STICKER_LIBRARY_KEY, JSON.stringify(normalized));
  return normalized;
}

function extensionForSticker(name?: string | null, mimeType?: string | null) {
  const fromName = name?.match(/\.([a-zA-Z0-9]{2,5})$/)?.[1]?.toLowerCase();
  if (fromName) return fromName;
  if (mimeType?.includes('png')) return 'png';
  if (mimeType?.includes('webp')) return 'webp';
  if (mimeType?.includes('gif')) return 'gif';
  return 'jpg';
}

function getStickerDirectory(moodId: BaiyunStickerMoodId) {
  if (!FileSystem.documentDirectory) throw new Error('当前设备无法访问本地表情包目录。');
  return `${FileSystem.documentDirectory}${STICKER_FOLDER}/${moodId}/`;
}

function isManagedStickerFile(sticker: BaiyunSticker) {
  if (!FileSystem.documentDirectory || !isStickerMoodId(sticker.moodId) || !sticker.uri) return false;
  const directory = `${FileSystem.documentDirectory}${STICKER_FOLDER}/${sticker.moodId}/`;
  if (!sticker.uri.startsWith(directory)) return false;
  const fileName = sticker.uri.slice(directory.length);
  if (!fileName || fileName === '.' || fileName === '..') return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(fileName);
}

export async function copyStickerImage(input: AddStickerInput): Promise<BaiyunSticker> {
  const id = `sticker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const directory = getStickerDirectory(input.moodId);
  await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
  const extension = extensionForSticker(input.name, input.mimeType);
  const targetUri = `${directory}${id}.${extension}`;
  await FileSystem.copyAsync({ from: input.sourceUri, to: targetUri });
  return {
    id,
    moodId: input.moodId,
    name: cleanName(input.name),
    uri: targetUri,
    mimeType: input.mimeType ?? undefined,
    width: normalizeNumber(input.width),
    height: normalizeNumber(input.height),
    size: normalizeNumber(input.size),
    createdAt: Date.now(),
  };
}

export function addStickerToLibrary(library: BaiyunStickerLibrary, sticker: BaiyunSticker) {
  const sameMood = library.stickers.filter((item) => item.moodId === sticker.moodId);
  const trimmedSameMoodIds = new Set(sameMood.slice(Math.max(0, sameMood.length - MAX_STICKERS_PER_MOOD + 1)).map((item) => item.id));
  const kept = library.stickers.filter((item) => item.moodId !== sticker.moodId || trimmedSameMoodIds.has(item.id));
  return {
    ...library,
    stickers: [...kept, sticker].slice(-MAX_STICKERS),
  };
}

export function removeStickerFromLibrary(library: BaiyunStickerLibrary, stickerId: string) {
  return {
    ...library,
    stickers: library.stickers.filter((item) => item.id !== stickerId),
  };
}

export async function deleteStickerFile(sticker: BaiyunSticker) {
  if (!isManagedStickerFile(sticker) || !sticker.uri) return;
  await FileSystem.deleteAsync(sticker.uri, { idempotent: true }).catch(() => undefined);
}

export function isMaterializedBaiyunSticker(
  sticker: BaiyunSticker,
): sticker is MaterializedBaiyunSticker {
  return typeof sticker.uri === 'string' && !!sticker.uri;
}

export function getStickersForMood(
  library: BaiyunStickerLibrary,
  moodId: BaiyunStickerMoodId,
): MaterializedBaiyunSticker[] {
  return library.stickers.filter(
    (item): item is MaterializedBaiyunSticker =>
      item.moodId === moodId && isMaterializedBaiyunSticker(item),
  );
}

export function countStickers(library: BaiyunStickerLibrary) {
  return library.stickers.length;
}

export function pickRandomSticker(library: BaiyunStickerLibrary, moodId: BaiyunStickerMoodId) {
  const candidates = getStickersForMood(library, moodId);
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)] ?? null;
}

export function buildStickerLibraryPrompt(library?: BaiyunStickerLibrary | null) {
  if (!library?.stickers.length) return '';
  const lines = EXPRESSION_MOOD_ORDER
    .map((id) => {
      const count = getStickersForMood(library, id).length;
      return count ? `- ${EXPRESSION_MOOD_LABELS[id]}：${id}（${count} 张）` : '';
    })
    .filter(Boolean);
  if (!lines.length) return '';
  return `【本地图片表情包】
I 可以让本地图片表情包随着此刻的语气自然出现。
可用分类：
${lines.join('\n')}

使用时，在一个气泡末尾单独写一行 [STICKER:分类id]，例如 [STICKER:happy]。`;
}
