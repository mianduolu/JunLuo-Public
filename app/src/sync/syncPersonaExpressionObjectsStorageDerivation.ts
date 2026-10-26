import {
  buildPersonaExpressionObjectsDeleteMutation,
  buildPersonaExpressionObjectsRecordMutation,
  expressionFieldEntityId,
  PERSONA_EXPRESSION_MOOD_IDS,
  type PersonaExpressionFieldName,
  type PersonaExpressionFieldRecord,
  type PersonaExpressionMoodId,
  type PersonaExpressionObjectsEntityType,
  type PersonaStickerMetadataRecord,
} from './syncPersonaExpressionObjects';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import {
  assertJsonValue,
  type PlainMutationV1,
} from './syncProtocol';

export const PERSONA_EXPRESSION_OBJECT_KEYS = Object.freeze({
  expressionLibrary: 'junluo.persona.expressionLibrary.custom.v2',
  legacyExpressionLibrary: 'junluo.persona.expressionLibrary.custom.v1',
  stickerLibrary: 'junluo.persona.stickerLibrary.v1',
} as const);

export const PERSONA_EXPRESSION_OBJECT_GLOBAL_KEYS = Object.freeze([
  PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
  PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
] as const);

export const PERSONA_EXPRESSION_OBJECT_BOOTSTRAP_KEYS = Object.freeze([
  PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary,
  PERSONA_EXPRESSION_OBJECT_KEYS.legacyExpressionLibrary,
  PERSONA_EXPRESSION_OBJECT_KEYS.stickerLibrary,
] as const);

const GLOBAL_KEY_SET = new Set<string>(
  PERSONA_EXPRESSION_OBJECT_GLOBAL_KEYS,
);

const LEGACY_MOOD_MAP: Readonly<Record<string, PersonaExpressionMoodId>> = {
  anxious: 'sad',
  comfort: 'sad',
  curious: 'confused',
  joy: 'happy',
  serious: 'confused',
  shy: 'like',
};

const MAX_CUSTOM_TEXT_LENGTH = 1200;

export type PersonaExpressionObjectsStorageChange =
  | { kind: 'set'; key: string; value: string }
  | { kind: 'remove'; key: string };

export type PersonaExpressionObjectsStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type PersonaExpressionObjectsEnvelopeFactory = (
  entity: {
    domain: 'persona';
    type: PersonaExpressionObjectsEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type PersonaExpressionCategoryStorage = {
  emojiText: string;
  kaomojiText: string;
};

export type PersonaExpressionLibraryStorage = {
  categories: Partial<
    Record<PersonaExpressionMoodId, PersonaExpressionCategoryStorage>
  >;
  updatedAt: number;
};

export type PersonaLocalStickerStorage = Omit<
  PersonaStickerMetadataRecord,
  'objectId'
> & {
  objectId?: string;
  uri?: string;
};

export type PersonaStickerLibraryStorage = {
  stickers: PersonaLocalStickerStorage[];
  updatedAt: number;
};

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(raw: string, label: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
  const record = recordOf(parsed, label);
  assertJsonValue(record);
  return record;
}

function clampText(value: unknown) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, MAX_CUSTOM_TEXT_LENGTH);
}

function normalizeCategory(value: unknown): PersonaExpressionCategoryStorage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { emojiText: '', kaomojiText: '' };
  }
  const candidate = value as Record<string, unknown>;
  return {
    emojiText: clampText(candidate.emojiText),
    kaomojiText: clampText(candidate.kaomojiText),
  };
}

function mergeCategory(
  target: PersonaExpressionLibraryStorage['categories'],
  moodId: PersonaExpressionMoodId,
  value: PersonaExpressionCategoryStorage,
) {
  if (!value.emojiText && !value.kaomojiText) return;
  const current = target[moodId] ?? {
    emojiText: '',
    kaomojiText: '',
  };
  target[moodId] = {
    emojiText: [current.emojiText, value.emojiText]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_CUSTOM_TEXT_LENGTH),
    kaomojiText: [current.kaomojiText, value.kaomojiText]
      .filter(Boolean)
      .join('\n')
      .slice(0, MAX_CUSTOM_TEXT_LENGTH),
  };
}

export function parsePersonaExpressionLibraryStorage(
  raw: string,
  label = 'persona expression library',
): PersonaExpressionLibraryStorage {
  const candidate = parseJsonObject(raw, label);
  const categories: PersonaExpressionLibraryStorage['categories'] = {};
  const sourceCategories = (
    candidate.categories
    && typeof candidate.categories === 'object'
    && !Array.isArray(candidate.categories)
  ) ? candidate.categories as Record<string, unknown> : {};
  for (const [rawMoodId, rawCategory] of Object.entries(sourceCategories)) {
    const moodId = PERSONA_EXPRESSION_MOOD_IDS.includes(
      rawMoodId as PersonaExpressionMoodId,
    )
      ? rawMoodId as PersonaExpressionMoodId
      : LEGACY_MOOD_MAP[rawMoodId];
    if (!moodId) continue;
    mergeCategory(categories, moodId, normalizeCategory(rawCategory));
  }
  const legacyEmojiText = clampText(candidate.emojiText);
  const legacyKaomojiText = clampText(candidate.kaomojiText);
  if (legacyEmojiText || legacyKaomojiText) {
    mergeCategory(categories, 'sad', {
      emojiText: legacyEmojiText,
      kaomojiText: legacyKaomojiText,
    });
  }
  const updatedAt = (
    Number.isSafeInteger(candidate.updatedAt)
    && Number(candidate.updatedAt) >= 0
  ) ? Number(candidate.updatedAt) : 0;
  return { categories, updatedAt };
}

export function serializePersonaExpressionLibraryStorage(
  library: PersonaExpressionLibraryStorage,
) {
  return JSON.stringify({
    categories: library.categories,
    emojiText: '',
    kaomojiText: '',
    updatedAt: library.updatedAt,
  });
}

function cleanName(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return (text || '白云表情包').slice(0, 48);
}

function cleanMeaning(value: unknown) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.slice(0, 120);
}

function positiveNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function optionalString(value: unknown, maximumLength: number) {
  if (typeof value !== 'string' || !value.length) return undefined;
  return value.slice(0, maximumLength);
}

function parseSticker(
  value: unknown,
  label: string,
): PersonaLocalStickerStorage {
  const candidate = recordOf(value, label);
  if (
    typeof candidate.id !== 'string'
    || candidate.id.length < 1
    || candidate.id.length > 128
  ) {
    throw new Error(`${label} 缺少稳定 ID。`);
  }
  if (
    typeof candidate.moodId !== 'string'
    || !PERSONA_EXPRESSION_MOOD_IDS.includes(
      candidate.moodId as PersonaExpressionMoodId,
    )
  ) {
    throw new Error(`${label} moodId 无效。`);
  }
  const uri = optionalString(candidate.uri, 4096);
  const objectId = optionalString(candidate.objectId, 43);
  if (!uri && !objectId) {
    throw new Error(`${label} 既没有本机文件，也没有同步对象引用。`);
  }
  if (objectId && !/^[A-Za-z0-9_-]{43}$/.test(objectId)) {
    throw new Error(`${label} objectId 无效。`);
  }
  const createdAt = (
    Number.isSafeInteger(candidate.createdAt)
    && Number(candidate.createdAt) >= 0
  ) ? Number(candidate.createdAt) : 0;
  const meaning = cleanMeaning(candidate.meaning);
  return {
    id: candidate.id,
    moodId: candidate.moodId as PersonaExpressionMoodId,
    name: cleanName(candidate.name),
    ...(objectId ? { objectId } : {}),
    ...(uri ? { uri } : {}),
    createdAt,
    ...(optionalString(candidate.mimeType, 128)
      ? { mimeType: optionalString(candidate.mimeType, 128) }
      : {}),
    ...(positiveNumber(candidate.width) !== undefined
      ? { width: positiveNumber(candidate.width) }
      : {}),
    ...(positiveNumber(candidate.height) !== undefined
      ? { height: positiveNumber(candidate.height) }
      : {}),
    ...(positiveNumber(candidate.size) !== undefined
      ? { size: positiveNumber(candidate.size) }
      : {}),
    ...(meaning ? { meaning } : {}),
  };
}

export function parsePersonaStickerLibraryStorage(
  raw: string,
  label = 'persona sticker library',
): PersonaStickerLibraryStorage {
  const candidate = parseJsonObject(raw, label);
  const source = Array.isArray(candidate.stickers)
    ? candidate.stickers.slice(-240)
    : [];
  const stickers = source.map(
    (value, index) => parseSticker(value, `${label}.stickers[${index}]`),
  );
  const ids = new Set<string>();
  for (const sticker of stickers) {
    if (ids.has(sticker.id)) {
      throw new Error(`${label} 包含重复 sticker id：${sticker.id}。`);
    }
    ids.add(sticker.id);
  }
  const updatedAt = (
    Number.isSafeInteger(candidate.updatedAt)
    && Number(candidate.updatedAt) >= 0
  ) ? Number(candidate.updatedAt) : 0;
  return { stickers, updatedAt };
}

export function serializePersonaStickerLibraryStorage(
  library: PersonaStickerLibraryStorage,
) {
  return JSON.stringify(library);
}

function expressionRecords(
  raw: string | null,
): Map<string, PersonaExpressionFieldRecord> {
  const records = new Map<string, PersonaExpressionFieldRecord>();
  if (raw === null) return records;
  const library = parsePersonaExpressionLibraryStorage(raw);
  for (const moodId of PERSONA_EXPRESSION_MOOD_IDS) {
    const category = library.categories[moodId];
    if (!category) continue;
    for (const field of ['emojiText', 'kaomojiText'] as const) {
      const text = category[field];
      if (!text) continue;
      const entityId = expressionFieldEntityId(moodId, field);
      records.set(entityId, { moodId, field, text });
    }
  }
  return records;
}

function stickerRecords(raw: string | null) {
  const records = new Map<string, PersonaStickerMetadataRecord>();
  const ids = new Set<string>();
  if (raw === null) return { records, ids };
  const library = parsePersonaStickerLibraryStorage(raw);
  for (const sticker of library.stickers) {
    ids.add(sticker.id);
    if (!sticker.objectId) continue;
    const {
      uri: _localUri,
      ...record
    } = sticker;
    records.set(sticker.id, record as PersonaStickerMetadataRecord);
  }
  return { records, ids };
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

export function isPersonaExpressionObjectsGlobalStorageKey(key: string) {
  return GLOBAL_KEY_SET.has(key);
}

export async function derivePersonaExpressionObjectsMutationsForStorageChanges(
  input: {
    changes: readonly PersonaExpressionObjectsStorageChange[];
    reader: PersonaExpressionObjectsStorageReadPort;
    capturedAt: number;
    envelopeFactory: PersonaExpressionObjectsEnvelopeFactory;
  },
) {
  assertTimestamp(
    input.capturedAt,
    'persona.expression-objects capture time',
  );
  const seenKeys = new Set<string>();
  const mutations: PlainMutationV1[] = [];
  for (const change of input.changes) {
    if (seenKeys.has(change.key)) {
      throw new Error(
        `persona.expression-objects 同批重复变更 key：${change.key}。`,
      );
    }
    seenKeys.add(change.key);
    if (!isPersonaExpressionObjectsGlobalStorageKey(change.key)) continue;
    const previousRaw = await input.reader.getItem(change.key);
    const nextRaw = change.kind === 'set' ? change.value : null;
    if (change.key === PERSONA_EXPRESSION_OBJECT_KEYS.expressionLibrary) {
      const previous = expressionRecords(previousRaw);
      const next = expressionRecords(nextRaw);
      const entityIds = [...new Set([
        ...previous.keys(),
        ...next.keys(),
      ])].sort();
      for (const entityId of entityIds) {
        const before = previous.get(entityId);
        const after = next.get(entityId);
        if (sameJson(before, after)) continue;
        const envelope = await input.envelopeFactory({
          domain: 'persona',
          type: 'expression',
          id: entityId,
        });
        if (!after) {
          mutations.push(buildPersonaExpressionObjectsDeleteMutation({
            envelope,
            entityType: 'expression',
            entityId,
            deletedAt: input.capturedAt,
          }));
        } else {
          mutations.push(buildPersonaExpressionObjectsRecordMutation({
            envelope,
            entityType: 'expression',
            entityId,
            kind: 'expression-field',
            value: after,
          }));
        }
      }
      continue;
    }
    const previous = stickerRecords(previousRaw);
    const next = stickerRecords(nextRaw);
    const entityIds = [...new Set([
      ...previous.ids,
      ...next.ids,
    ])].sort();
    for (const entityId of entityIds) {
      const before = previous.records.get(entityId);
      const after = next.records.get(entityId);
      if (next.ids.has(entityId) && !after) {
        throw new Error(
          `贴纸 ${entityId} 尚未生成 objectId，不能进入同步 mutation。`,
        );
      }
      if (sameJson(before, after)) continue;
      const envelope = await input.envelopeFactory({
        domain: 'persona',
        type: 'sticker',
        id: entityId,
      });
      if (!after) {
        mutations.push(buildPersonaExpressionObjectsDeleteMutation({
          envelope,
          entityType: 'sticker',
          entityId,
          deletedAt: input.capturedAt,
        }));
      } else {
        mutations.push(buildPersonaExpressionObjectsRecordMutation({
          envelope,
          entityType: 'sticker',
          entityId,
          kind: 'sticker-metadata',
          value: after,
        }));
      }
    }
  }
  return mutations.sort(
    (left, right) => (
      left.entity.type.localeCompare(right.entity.type)
      || left.entity.id.localeCompare(right.entity.id)
    ),
  );
}
