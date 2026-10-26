import { sha256 } from '@noble/hashes/sha2.js';
import { Buffer } from 'buffer';

import {
  buildTogetherWalkedLifeDeleteMutation,
  buildTogetherWalkedLifeRecordMutation,
  TOGETHER_WALKED_DRAFT_ENTITY_ID,
  togetherWalkedImageEntityId,
  type TogetherWalkedDraftRecord,
  type TogetherWalkedEntryRecord,
  type TogetherWalkedImageObjectRecord,
  type TogetherWalkedImageOwnerType,
  type TogetherWalkedJourneyRecord,
  type TogetherWalkedLifeEntityType,
  type TogetherWalkedLifeRecord,
  type TogetherWalkedSharedLocation,
} from './syncTogetherWalkedLife';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import type {
  PlainMutationV1,
} from './syncProtocol';

export const TOGETHER_WALKED_ENTRIES_KEY =
  'junluo.togetherWalked.entries.v1' as const;
export const TOGETHER_WALKED_DRAFT_KEY =
  'junluo.togetherWalked.draft.v1' as const;
export const TOGETHER_WALKED_JOURNEYS_KEY =
  'junluo.togetherWalked.journeys.v1' as const;
export const TOGETHER_WALKED_LIFE_INDEX_KEY =
  'junluo.sync.togetherWalked.life.v1' as const;
export const TOGETHER_WALKED_LIFE_INDEX_VERSION = 1 as const;

export const TOGETHER_WALKED_LIFE_GLOBAL_KEYS = Object.freeze([
  TOGETHER_WALKED_ENTRIES_KEY,
  TOGETHER_WALKED_DRAFT_KEY,
  TOGETHER_WALKED_JOURNEYS_KEY,
] as const);

export type TogetherWalkedLocalEntry = {
  id: string;
  title: string;
  note: string;
  imageUri?: string;
  location?: TogetherWalkedSharedLocation;
  journeyId?: string;
  createdAt: number;
  updatedAt: number;
  memoryId?: string;
};

export type TogetherWalkedLocalJourney = {
  id: string;
  title: string;
  description: string;
  createdAt: number;
  updatedAt: number;
};

export type TogetherWalkedLocalDraft = {
  title?: string;
  note?: string;
  occurredAtText?: string;
  imageUri?: string;
  location?: TogetherWalkedSharedLocation;
  journeyId?: string;
  manualPlace?: string;
  manualLatitude?: string;
  manualLongitude?: string;
};

export type TogetherWalkedLocalImageObject =
  TogetherWalkedImageObjectRecord & {
    entityId: string;
    keyId?: string;
    localUri?: string;
  };

export type TogetherWalkedLifeLocalIndex = {
  version: typeof TOGETHER_WALKED_LIFE_INDEX_VERSION;
  objects: TogetherWalkedLocalImageObject[];
  draftFingerprint?: string;
  draftUpdatedAt?: number;
  updatedAt: number;
};

export type TogetherWalkedLifeRawSnapshot =
  Readonly<Record<string, string | null>>;

export type TogetherWalkedLifeEnvelopeFactory = (
  entity: {
    domain: 'together-walked';
    type: TogetherWalkedLifeEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type TogetherWalkedImageCaptureResult = {
  objectId: string;
  plaintextBytes: number;
  chunkCount: number;
};

export type TogetherWalkedImageCapturePort = {
  capture(input: {
    ownerType: TogetherWalkedImageOwnerType;
    ownerId: string;
    uri: string;
    extension: string;
    mediaType?: string;
  }): Promise<TogetherWalkedImageCaptureResult>;
};

type JsonRecord = Record<string, unknown>;

function expect(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): JsonRecord {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as JsonRecord;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function safeString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
  allowFormattingWhitespace = false,
) {
  const forbiddenControlCharacters = allowFormattingWhitespace
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  expect(
    typeof value === 'string'
      && (allowEmpty || value.length > 0)
      && value.length <= maximum
      && !forbiddenControlCharacters.test(value),
    `${label} 无效。`,
  );
  return value;
}

function optionalString(
  value: unknown,
  label: string,
  maximum: number,
  allowFormattingWhitespace = false,
) {
  if (value === undefined) return undefined;
  return safeString(
    value,
    label,
    maximum,
    true,
    allowFormattingWhitespace,
  );
}

function safeId(value: unknown, label: string) {
  const id = safeString(value, label, 200);
  expect(
    id !== '.' && id !== '..' && !/[\/\\]/.test(id),
    `${label} 不能包含路径。`,
  );
  return id;
}

function timestamp(value: unknown, label: string) {
  expect(
    Number.isSafeInteger(value) && Number(value) >= 0,
    `${label} 必须是非负 Unix 毫秒整数。`,
  );
  return Number(value);
}

function optionalLocation(
  value: unknown,
  label: string,
): TogetherWalkedSharedLocation | undefined {
  if (value === undefined) return undefined;
  const location = recordOf(value, label);
  const allowed = new Set([
    'latitude',
    'longitude',
    'accuracy',
    'label',
  ]);
  expect(
    Object.keys(location).every((key) => allowed.has(key)),
    `${label} 包含未允许字段。`,
  );
  const hasLatitude = location.latitude !== undefined;
  const hasLongitude = location.longitude !== undefined;
  expect(
    hasLatitude === hasLongitude,
    `${label} 经纬度必须成对出现。`,
  );
  let latitude: number | undefined;
  let longitude: number | undefined;
  if (hasLatitude) {
    expect(
      typeof location.latitude === 'number'
        && Number.isFinite(location.latitude)
        && location.latitude >= -90
        && location.latitude <= 90,
      `${label}.latitude 无效。`,
    );
    expect(
      typeof location.longitude === 'number'
        && Number.isFinite(location.longitude)
        && location.longitude >= -180
        && location.longitude <= 180,
      `${label}.longitude 无效。`,
    );
    expect(
      location.latitude !== 0 || location.longitude !== 0,
      `${label} 不能使用 0,0 伪坐标。`,
    );
    latitude = location.latitude;
    longitude = location.longitude;
  }
  let accuracy: number | undefined;
  if (location.accuracy !== undefined) {
    expect(
      typeof location.accuracy === 'number'
        && Number.isFinite(location.accuracy)
        && location.accuracy >= 0
        && location.accuracy <= 1_000_000,
      `${label}.accuracy 无效。`,
    );
    accuracy = location.accuracy;
  }
  const locationLabel = optionalString(
    location.label,
    `${label}.label`,
    300,
  );
  expect(
    latitude !== undefined || Boolean(locationLabel),
    `${label} 至少需要地点名或坐标。`,
  );
  return {
    ...(latitude !== undefined ? { latitude, longitude } : {}),
    ...(accuracy !== undefined ? { accuracy } : {}),
    ...(locationLabel ? { label: locationLabel } : {}),
  };
}

function optionalUri(value: unknown, label: string) {
  if (value === undefined) return undefined;
  const uri = safeString(value, label, 4096);
  expect(
    /^(file|content):\/\//.test(uri),
    `${label} 必须是本机 file/content URI。`,
  );
  return uri;
}

function parseEntry(value: unknown, index: number) {
  const label = `together-walked entries[${index}]`;
  const record = recordOf(value, label);
  const allowed = new Set([
    'id',
    'title',
    'note',
    'imageUri',
    'location',
    'journeyId',
    'createdAt',
    'updatedAt',
    'memoryId',
  ]);
  expect(
    Object.keys(record).every((key) => allowed.has(key)),
    `${label} 包含未允许字段。`,
  );
  return {
    id: safeId(record.id, `${label}.id`),
    title: safeString(record.title, `${label}.title`, 300),
    note: safeString(
      record.note ?? '',
      `${label}.note`,
      20_000,
      true,
      true,
    ),
    ...(optionalUri(record.imageUri, `${label}.imageUri`)
      ? { imageUri: optionalUri(record.imageUri, `${label}.imageUri`) }
      : {}),
    ...(optionalLocation(record.location, `${label}.location`)
      ? { location: optionalLocation(record.location, `${label}.location`) }
      : {}),
    ...(record.journeyId !== undefined
      ? { journeyId: safeId(record.journeyId, `${label}.journeyId`) }
      : {}),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(record.updatedAt, `${label}.updatedAt`),
    ...(record.memoryId !== undefined
      ? { memoryId: safeId(record.memoryId, `${label}.memoryId`) }
      : {}),
  } satisfies TogetherWalkedLocalEntry;
}

export function parseTogetherWalkedEntriesStorage(
  raw: string | null,
) {
  if (raw === null) return [] as TogetherWalkedLocalEntry[];
  const value = parseJson(raw, 'together-walked entries');
  expect(
    Array.isArray(value) && value.length <= 50_000,
    'together-walked entries 必须是有界数组。',
  );
  const entries = value.map(parseEntry);
  const ids = new Set<string>();
  for (const entry of entries) {
    expect(
      !ids.has(entry.id),
      `together-walked entries 重复 id：${entry.id}。`,
    );
    ids.add(entry.id);
  }
  return entries;
}

function parseJourney(value: unknown, index: number) {
  const label = `together-walked journeys[${index}]`;
  const record = recordOf(value, label);
  const allowed = new Set([
    'id',
    'title',
    'description',
    'createdAt',
    'updatedAt',
  ]);
  expect(
    Object.keys(record).every((key) => allowed.has(key)),
    `${label} 包含未允许字段。`,
  );
  return {
    id: safeId(record.id, `${label}.id`),
    title: safeString(record.title, `${label}.title`, 300),
    description: safeString(
      record.description ?? '',
      `${label}.description`,
      20_000,
      true,
      true,
    ),
    createdAt: timestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: timestamp(record.updatedAt, `${label}.updatedAt`),
  } satisfies TogetherWalkedLocalJourney;
}

export function parseTogetherWalkedJourneysStorage(
  raw: string | null,
) {
  if (raw === null) return [] as TogetherWalkedLocalJourney[];
  const value = parseJson(raw, 'together-walked journeys');
  expect(
    Array.isArray(value) && value.length <= 20_000,
    'together-walked journeys 必须是有界数组。',
  );
  const journeys = value.map(parseJourney);
  const ids = new Set<string>();
  for (const journey of journeys) {
    expect(
      !ids.has(journey.id),
      `together-walked journeys 重复 id：${journey.id}。`,
    );
    ids.add(journey.id);
  }
  return journeys;
}

export function parseTogetherWalkedDraftStorage(
  raw: string | null,
): TogetherWalkedLocalDraft | null {
  if (raw === null) return null;
  const record = recordOf(
    parseJson(raw, 'together-walked draft'),
    'together-walked draft',
  );
  const allowed = new Set([
    'title',
    'note',
    'occurredAtText',
    'imageUri',
    'location',
    'journeyId',
    'manualPlace',
    'manualLatitude',
    'manualLongitude',
  ]);
  expect(
    Object.keys(record).every((key) => allowed.has(key)),
    'together-walked draft 包含未允许字段。',
  );
  return {
    ...(record.title !== undefined
      ? { title: optionalString(record.title, 'draft.title', 300) }
      : {}),
    ...(record.note !== undefined
      ? {
          note: optionalString(
            record.note,
            'draft.note',
            20_000,
            true,
          ),
        }
      : {}),
    ...(record.occurredAtText !== undefined
      ? {
          occurredAtText: optionalString(
            record.occurredAtText,
            'draft.occurredAtText',
            100,
          ),
        }
      : {}),
    ...(optionalUri(record.imageUri, 'draft.imageUri')
      ? { imageUri: optionalUri(record.imageUri, 'draft.imageUri') }
      : {}),
    ...(optionalLocation(record.location, 'draft.location')
      ? { location: optionalLocation(record.location, 'draft.location') }
      : {}),
    ...(record.journeyId !== undefined
      ? { journeyId: safeId(record.journeyId, 'draft.journeyId') }
      : {}),
    ...(record.manualPlace !== undefined
      ? {
          manualPlace: optionalString(
            record.manualPlace,
            'draft.manualPlace',
            300,
          ),
        }
      : {}),
    ...(record.manualLatitude !== undefined
      ? {
          manualLatitude: optionalString(
            record.manualLatitude,
            'draft.manualLatitude',
            100,
          ),
        }
      : {}),
    ...(record.manualLongitude !== undefined
      ? {
          manualLongitude: optionalString(
            record.manualLongitude,
            'draft.manualLongitude',
            100,
          ),
        }
      : {}),
  };
}

function normalizeIndexObject(
  value: unknown,
  index: number,
): TogetherWalkedLocalImageObject {
  const label = `together-walked index objects[${index}]`;
  const record = recordOf(value, label);
  const allowed = new Set([
    'entityId',
    'ownerType',
    'ownerId',
    'objectId',
    'extension',
    'mediaType',
    'plaintextBytes',
    'chunkCount',
    'updatedAt',
    'keyId',
    'localUri',
  ]);
  expect(
    Object.keys(record).every((key) => allowed.has(key)),
    `${label} 包含未允许字段。`,
  );
  expect(
    record.ownerType === 'entry' || record.ownerType === 'draft',
    `${label}.ownerType 无效。`,
  );
  const ownerType = record.ownerType;
  const ownerId = safeId(record.ownerId, `${label}.ownerId`);
  if (ownerType === 'draft') {
    expect(
      ownerId === TOGETHER_WALKED_DRAFT_ENTITY_ID,
      `${label}.ownerId 无效。`,
    );
  }
  const entityId = togetherWalkedImageEntityId({
    ownerType,
    ownerId,
  });
  expect(record.entityId === entityId, `${label}.entityId 无效。`);
  expect(
    typeof record.objectId === 'string'
      && /^[A-Za-z0-9_-]{43}$/.test(record.objectId),
    `${label}.objectId 无效。`,
  );
  expect(
    typeof record.extension === 'string'
      && /^[a-z0-9]{1,16}$/.test(record.extension),
    `${label}.extension 无效。`,
  );
  const mediaType = optionalString(
    record.mediaType,
    `${label}.mediaType`,
    128,
  );
  expect(
    Number.isSafeInteger(record.plaintextBytes)
      && Number(record.plaintextBytes) >= 0,
    `${label}.plaintextBytes 无效。`,
  );
  expect(
    Number.isSafeInteger(record.chunkCount)
      && Number(record.chunkCount) >= 1
      && Number(record.chunkCount) <= 100_000,
    `${label}.chunkCount 无效。`,
  );
  const localUri = optionalUri(record.localUri, `${label}.localUri`);
  const keyId = optionalString(record.keyId, `${label}.keyId`, 36);
  if (keyId !== undefined) {
    expect(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(keyId),
      `${label}.keyId 无效。`,
    );
  }
  return {
    entityId,
    ownerType,
    ownerId,
    objectId: record.objectId,
    extension: record.extension,
    ...(mediaType ? { mediaType } : {}),
    plaintextBytes: Number(record.plaintextBytes),
    chunkCount: Number(record.chunkCount),
    updatedAt: timestamp(record.updatedAt, `${label}.updatedAt`),
    ...(keyId ? { keyId } : {}),
    ...(localUri ? { localUri } : {}),
  };
}

export function emptyTogetherWalkedLifeLocalIndex(
  updatedAt = 0,
): TogetherWalkedLifeLocalIndex {
  return {
    version: TOGETHER_WALKED_LIFE_INDEX_VERSION,
    objects: [],
    updatedAt,
  };
}

export function parseTogetherWalkedLifeLocalIndex(
  raw: string | null,
): TogetherWalkedLifeLocalIndex {
  if (raw === null) return emptyTogetherWalkedLifeLocalIndex();
  const record = recordOf(
    parseJson(raw, 'together-walked index'),
    'together-walked index',
  );
  const allowed = new Set([
    'version',
    'objects',
    'draftFingerprint',
    'draftUpdatedAt',
    'updatedAt',
  ]);
  expect(
    Object.keys(record).every((key) => allowed.has(key)),
    'together-walked index 包含未允许字段。',
  );
  expect(
    record.version === TOGETHER_WALKED_LIFE_INDEX_VERSION,
    'together-walked index version 无效。',
  );
  expect(
    Array.isArray(record.objects) && record.objects.length <= 50_001,
    'together-walked index objects 无效。',
  );
  const objects = record.objects.map(normalizeIndexObject);
  const entityIds = new Set<string>();
  const owners = new Set<string>();
  for (const object of objects) {
    const owner = `${object.ownerType}:${object.ownerId}`;
    expect(
      !entityIds.has(object.entityId) && !owners.has(owner),
      'together-walked index 包含重复对象所有者。',
    );
    entityIds.add(object.entityId);
    owners.add(owner);
  }
  const draftFingerprint = optionalString(
    record.draftFingerprint,
    'together-walked index draftFingerprint',
    43,
  );
  if (draftFingerprint !== undefined) {
    expect(
      /^[A-Za-z0-9_-]{43}$/.test(draftFingerprint),
      'together-walked index draftFingerprint 无效。',
    );
  }
  const draftUpdatedAt = record.draftUpdatedAt === undefined
    ? undefined
    : timestamp(
        record.draftUpdatedAt,
        'together-walked index draftUpdatedAt',
      );
  expect(
    (draftFingerprint === undefined)
      === (draftUpdatedAt === undefined),
    'together-walked index 草稿 revision 元数据不完整。',
  );
  return {
    version: TOGETHER_WALKED_LIFE_INDEX_VERSION,
    objects: objects.sort((left, right) =>
      left.entityId.localeCompare(right.entityId)),
    ...(draftFingerprint ? { draftFingerprint } : {}),
    ...(draftUpdatedAt !== undefined ? { draftUpdatedAt } : {}),
    updatedAt: timestamp(
      record.updatedAt,
      'together-walked index updatedAt',
    ),
  };
}

export function serializeTogetherWalkedLifeLocalIndex(
  index: TogetherWalkedLifeLocalIndex,
) {
  return JSON.stringify({
    version: TOGETHER_WALKED_LIFE_INDEX_VERSION,
    objects: [...index.objects].sort((left, right) =>
      left.entityId.localeCompare(right.entityId)),
    ...(index.draftFingerprint
      ? { draftFingerprint: index.draftFingerprint }
      : {}),
    ...(index.draftUpdatedAt !== undefined
      ? { draftUpdatedAt: index.draftUpdatedAt }
      : {}),
    updatedAt: index.updatedAt,
  });
}

function extensionFromUri(uri: string) {
  const clean = uri.split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]{1,16})$/i);
  return (match?.[1] ?? 'jpg').toLowerCase();
}

function mediaTypeForExtension(extension: string) {
  const values: Readonly<Record<string, string>> = {
    gif: 'image/gif',
    heic: 'image/heic',
    heif: 'image/heif',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
  };
  return values[extension];
}

function ownerKey(
  ownerType: TogetherWalkedImageOwnerType,
  ownerId: string,
) {
  return `${ownerType}:${ownerId}`;
}

async function prepareImageObject(input: {
  ownerType: TogetherWalkedImageOwnerType;
  ownerId: string;
  imageUri: string;
  keyId: string;
  previous?: TogetherWalkedLocalImageObject;
  capture: TogetherWalkedImageCapturePort;
  now: number;
}) {
  if (
    input.previous?.localUri === input.imageUri
    && input.previous.keyId === input.keyId
  ) {
    return input.previous;
  }
  const extension = extensionFromUri(input.imageUri);
  const mediaType = mediaTypeForExtension(extension);
  const captured = await input.capture.capture({
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    uri: input.imageUri,
    extension,
    ...(mediaType ? { mediaType } : {}),
  });
  expect(
    /^[A-Za-z0-9_-]{43}$/.test(captured.objectId),
    'together-walked capture objectId 无效。',
  );
  expect(
    Number.isSafeInteger(captured.plaintextBytes)
      && captured.plaintextBytes >= 0,
    'together-walked capture plaintextBytes 无效。',
  );
  expect(
    Number.isSafeInteger(captured.chunkCount)
      && captured.chunkCount >= 1
      && captured.chunkCount <= 100_000,
    'together-walked capture chunkCount 无效。',
  );
  return {
    entityId: togetherWalkedImageEntityId({
      ownerType: input.ownerType,
      ownerId: input.ownerId,
    }),
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    objectId: captured.objectId,
    extension,
    ...(mediaType ? { mediaType } : {}),
    plaintextBytes: captured.plaintextBytes,
    chunkCount: captured.chunkCount,
    updatedAt: input.now,
    keyId: input.keyId,
    localUri: input.imageUri,
  } satisfies TogetherWalkedLocalImageObject;
}

export function togetherWalkedDraftFingerprint(
  value: Omit<TogetherWalkedDraftRecord, 'updatedAt'>,
) {
  return Buffer.from(sha256(
    new TextEncoder().encode(JSON.stringify(value)),
  )).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function rawValue(
  snapshot: TogetherWalkedLifeRawSnapshot,
  key: string,
) {
  return Object.prototype.hasOwnProperty.call(snapshot, key)
    ? snapshot[key] ?? null
    : null;
}

export async function prepareTogetherWalkedLifeLocalIndex(input: {
  raw: TogetherWalkedLifeRawSnapshot;
  previous: TogetherWalkedLifeLocalIndex;
  keyId: string;
  capture: TogetherWalkedImageCapturePort;
  now: number;
}) {
  timestamp(input.now, 'together-walked prepare now');
  const entries = parseTogetherWalkedEntriesStorage(
    rawValue(input.raw, TOGETHER_WALKED_ENTRIES_KEY),
  );
  const journeys = parseTogetherWalkedJourneysStorage(
    rawValue(input.raw, TOGETHER_WALKED_JOURNEYS_KEY),
  );
  const draft = parseTogetherWalkedDraftStorage(
    rawValue(input.raw, TOGETHER_WALKED_DRAFT_KEY),
  );
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  const previousByOwner = new Map(
    input.previous.objects.map((object) => [
      ownerKey(object.ownerType, object.ownerId),
      object,
    ]),
  );
  const objects: TogetherWalkedLocalImageObject[] = [];
  for (const entry of entries) {
    if (!entry.imageUri) continue;
    objects.push(await prepareImageObject({
      ownerType: 'entry',
      ownerId: entry.id,
      imageUri: entry.imageUri,
      keyId: input.keyId,
      previous: previousByOwner.get(ownerKey('entry', entry.id)),
      capture: input.capture,
      now: input.now,
    }));
  }
  if (draft?.imageUri) {
    objects.push(await prepareImageObject({
      ownerType: 'draft',
      ownerId: TOGETHER_WALKED_DRAFT_ENTITY_ID,
      imageUri: draft.imageUri,
      keyId: input.keyId,
      previous: previousByOwner.get(
        ownerKey('draft', TOGETHER_WALKED_DRAFT_ENTITY_ID),
      ),
      capture: input.capture,
      now: input.now,
    }));
  }
  const provisional: TogetherWalkedLifeLocalIndex = {
    version: TOGETHER_WALKED_LIFE_INDEX_VERSION,
    objects: objects.sort((left, right) =>
      left.entityId.localeCompare(right.entityId)),
    updatedAt: Math.max(input.previous.updatedAt, input.now),
  };
  if (!draft) return provisional;
  const draftRecord = projectDraft(
    draft,
    provisional,
    journeyIds,
    input.now,
  );
  const draftShape = {
    ...draftRecord,
    updatedAt: undefined,
  };
  const draftFingerprint = togetherWalkedDraftFingerprint(
    draftShape,
  );
  const draftUpdatedAt = (
    input.previous.draftFingerprint === draftFingerprint
    && input.previous.draftUpdatedAt !== undefined
  )
    ? input.previous.draftUpdatedAt
    : input.now;
  return {
    ...provisional,
    draftFingerprint,
    draftUpdatedAt,
  };
}

function sharedImageObject(
  value: TogetherWalkedLocalImageObject,
): TogetherWalkedImageObjectRecord {
  return {
    ownerType: value.ownerType,
    ownerId: value.ownerId,
    objectId: value.objectId,
    extension: value.extension,
    ...(value.mediaType ? { mediaType: value.mediaType } : {}),
    plaintextBytes: value.plaintextBytes,
    chunkCount: value.chunkCount,
    updatedAt: value.updatedAt,
  };
}

function objectForOwner(
  index: TogetherWalkedLifeLocalIndex,
  ownerType: TogetherWalkedImageOwnerType,
  ownerId: string,
) {
  return index.objects.find(
    (object) => (
      object.ownerType === ownerType
      && object.ownerId === ownerId
    ),
  );
}

function projectEntry(
  entry: TogetherWalkedLocalEntry,
  index: TogetherWalkedLifeLocalIndex,
  journeyIds: ReadonlySet<string>,
): TogetherWalkedEntryRecord {
  const image = objectForOwner(index, 'entry', entry.id);
  return {
    id: entry.id,
    title: entry.title,
    note: entry.note,
    ...(image ? { imageObjectId: image.objectId } : {}),
    ...(entry.location ? { location: entry.location } : {}),
    ...(entry.journeyId && journeyIds.has(entry.journeyId)
      ? { journeyId: entry.journeyId }
      : {}),
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    ...(entry.memoryId ? { memoryId: entry.memoryId } : {}),
  };
}

function projectJourney(
  journey: TogetherWalkedLocalJourney,
): TogetherWalkedJourneyRecord {
  return { ...journey };
}

function projectDraft(
  draft: TogetherWalkedLocalDraft,
  index: TogetherWalkedLifeLocalIndex,
  journeyIds: ReadonlySet<string>,
  fallbackUpdatedAt: number,
): TogetherWalkedDraftRecord {
  const image = objectForOwner(
    index,
    'draft',
    TOGETHER_WALKED_DRAFT_ENTITY_ID,
  );
  return {
    id: TOGETHER_WALKED_DRAFT_ENTITY_ID,
    ...(draft.title !== undefined ? { title: draft.title } : {}),
    ...(draft.note !== undefined ? { note: draft.note } : {}),
    ...(draft.occurredAtText !== undefined
      ? { occurredAtText: draft.occurredAtText }
      : {}),
    ...(image ? { imageObjectId: image.objectId } : {}),
    ...(draft.location ? { location: draft.location } : {}),
    ...(draft.journeyId && journeyIds.has(draft.journeyId)
      ? { journeyId: draft.journeyId }
      : {}),
    ...(draft.manualPlace !== undefined
      ? { manualPlace: draft.manualPlace }
      : {}),
    ...(draft.manualLatitude !== undefined
      ? { manualLatitude: draft.manualLatitude }
      : {}),
    ...(draft.manualLongitude !== undefined
      ? { manualLongitude: draft.manualLongitude }
      : {}),
    updatedAt: index.draftUpdatedAt ?? fallbackUpdatedAt,
  };
}

type ProjectedSnapshot = {
  entries: Map<string, TogetherWalkedEntryRecord>;
  journeys: Map<string, TogetherWalkedJourneyRecord>;
  draft: TogetherWalkedDraftRecord | null;
  objects: Map<string, TogetherWalkedImageObjectRecord>;
};

function projectSnapshot(input: {
  raw: TogetherWalkedLifeRawSnapshot;
  index: TogetherWalkedLifeLocalIndex;
  fallbackUpdatedAt: number;
}): ProjectedSnapshot {
  const entries = parseTogetherWalkedEntriesStorage(
    rawValue(input.raw, TOGETHER_WALKED_ENTRIES_KEY),
  );
  const journeys = parseTogetherWalkedJourneysStorage(
    rawValue(input.raw, TOGETHER_WALKED_JOURNEYS_KEY),
  );
  const draft = parseTogetherWalkedDraftStorage(
    rawValue(input.raw, TOGETHER_WALKED_DRAFT_KEY),
  );
  const journeyIds = new Set(journeys.map((journey) => journey.id));
  return {
    entries: new Map(entries.map((entry) => [
      entry.id,
      projectEntry(entry, input.index, journeyIds),
    ])),
    journeys: new Map(journeys.map((journey) => [
      journey.id,
      projectJourney(journey),
    ])),
    draft: draft
      ? projectDraft(
          draft,
          input.index,
          journeyIds,
          input.fallbackUpdatedAt,
        )
      : null,
    objects: new Map(input.index.objects.map((object) => [
      object.entityId,
      sharedImageObject(object),
    ])),
  };
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

async function recordMutation(input: {
  entityType: TogetherWalkedLifeEntityType;
  entityId: string;
  value: TogetherWalkedLifeRecord;
  envelopeFactory: TogetherWalkedLifeEnvelopeFactory;
}) {
  return buildTogetherWalkedLifeRecordMutation({
    envelope: await input.envelopeFactory({
      domain: 'together-walked',
      type: input.entityType,
      id: input.entityId,
    }),
    entityType: input.entityType,
    entityId: input.entityId,
    value: input.value,
  });
}

async function deleteMutation(input: {
  entityType: TogetherWalkedLifeEntityType;
  entityId: string;
  deletedAt: number;
  envelopeFactory: TogetherWalkedLifeEnvelopeFactory;
}) {
  return buildTogetherWalkedLifeDeleteMutation({
    envelope: await input.envelopeFactory({
      domain: 'together-walked',
      type: input.entityType,
      id: input.entityId,
    }),
    entityType: input.entityType,
    entityId: input.entityId,
    deletedAt: input.deletedAt,
  });
}

async function appendUpserts<T extends TogetherWalkedLifeRecord>(
  output: PlainMutationV1[],
  entityType: TogetherWalkedLifeEntityType,
  previous: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
  envelopeFactory: TogetherWalkedLifeEnvelopeFactory,
) {
  for (const [entityId, value] of [...next.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    if (sameJson(previous.get(entityId), value)) continue;
    output.push(await recordMutation({
      entityType,
      entityId,
      value,
      envelopeFactory,
    }));
  }
}

async function appendDeletes<T>(
  output: PlainMutationV1[],
  entityType: TogetherWalkedLifeEntityType,
  previous: ReadonlyMap<string, T>,
  next: ReadonlyMap<string, T>,
  deletedAt: number,
  envelopeFactory: TogetherWalkedLifeEnvelopeFactory,
) {
  for (const entityId of [...previous.keys()].sort()) {
    if (next.has(entityId)) continue;
    output.push(await deleteMutation({
      entityType,
      entityId,
      deletedAt,
      envelopeFactory,
    }));
  }
}

export async function deriveTogetherWalkedLifeMutations(input: {
  previousRaw: TogetherWalkedLifeRawSnapshot;
  nextRaw: TogetherWalkedLifeRawSnapshot;
  previousIndex: TogetherWalkedLifeLocalIndex;
  nextIndex: TogetherWalkedLifeLocalIndex;
  capturedAt: number;
  envelopeFactory: TogetherWalkedLifeEnvelopeFactory;
}) {
  timestamp(input.capturedAt, 'together-walked capture time');
  const previous = projectSnapshot({
    raw: input.previousRaw,
    index: input.previousIndex,
    fallbackUpdatedAt: input.capturedAt,
  });
  const next = projectSnapshot({
    raw: input.nextRaw,
    index: input.nextIndex,
    fallbackUpdatedAt: input.capturedAt,
  });
  const mutations: PlainMutationV1[] = [];

  await appendUpserts(
    mutations,
    'journey',
    previous.journeys,
    next.journeys,
    input.envelopeFactory,
  );
  await appendUpserts(
    mutations,
    'image-object',
    previous.objects,
    next.objects,
    input.envelopeFactory,
  );
  await appendUpserts(
    mutations,
    'entry',
    previous.entries,
    next.entries,
    input.envelopeFactory,
  );
  if (!sameJson(previous.draft, next.draft)) {
    if (next.draft) {
      mutations.push(await recordMutation({
        entityType: 'draft',
        entityId: TOGETHER_WALKED_DRAFT_ENTITY_ID,
        value: next.draft,
        envelopeFactory: input.envelopeFactory,
      }));
    } else if (previous.draft) {
      mutations.push(await deleteMutation({
        entityType: 'draft',
        entityId: TOGETHER_WALKED_DRAFT_ENTITY_ID,
        deletedAt: input.capturedAt,
        envelopeFactory: input.envelopeFactory,
      }));
    }
  }
  await appendDeletes(
    mutations,
    'entry',
    previous.entries,
    next.entries,
    input.capturedAt,
    input.envelopeFactory,
  );
  await appendDeletes(
    mutations,
    'image-object',
    previous.objects,
    next.objects,
    input.capturedAt,
    input.envelopeFactory,
  );
  await appendDeletes(
    mutations,
    'journey',
    previous.journeys,
    next.journeys,
    input.capturedAt,
    input.envelopeFactory,
  );
  return mutations;
}

export function emptyTogetherWalkedLifeRawSnapshot():
TogetherWalkedLifeRawSnapshot {
  return {
    [TOGETHER_WALKED_ENTRIES_KEY]: null,
    [TOGETHER_WALKED_DRAFT_KEY]: null,
    [TOGETHER_WALKED_JOURNEYS_KEY]: null,
  };
}

export function isTogetherWalkedLifeGlobalStorageKey(
  key: string,
) {
  return (
    key === TOGETHER_WALKED_ENTRIES_KEY
    || key === TOGETHER_WALKED_DRAFT_KEY
    || key === TOGETHER_WALKED_JOURNEYS_KEY
  );
}
