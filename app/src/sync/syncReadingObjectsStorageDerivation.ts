import {
  buildReadingObjectDeleteMutation,
  buildReadingObjectRecordMutation,
  readingObjectEntityId,
  readingObjectEntityTypeForRole,
  type ReadingObjectEntityType,
  type ReadingObjectRecord,
  type ReadingObjectRole,
} from './syncReadingObjects';
import type {
  ChatCoreMutationEnvelope,
} from './syncChatCore';
import type {
  PlainMutationV1,
} from './syncProtocol';

export const READING_OBJECTS_INDEX_KEY =
  'junluo.sync.reading.objects.v1' as const;
export const READING_OBJECTS_INDEX_VERSION = 1 as const;
export const READING_OBJECTS_LIBRARY_KEY =
  'junluo.reading.library.v1' as const;

export type ReadingObjectLocalRecord = ReadingObjectRecord & {
  entityType: ReadingObjectEntityType;
  entityId: string;
  keyId?: string;
  localUri?: string;
};

export type ReadingObjectsLocalIndex = {
  version: typeof READING_OBJECTS_INDEX_VERSION;
  records: ReadingObjectLocalRecord[];
  updatedAt: number;
};

export type ReadingObjectsStorageReadPort = {
  getItem(key: string): Promise<string | null>;
};

export type ReadingObjectsEnvelopeFactory = (
  entity: {
    domain: 'reading';
    type: ReadingObjectEntityType;
    id: string;
  },
) => Promise<ChatCoreMutationEnvelope>;

export type ReadingObjectDiscoveredFile = {
  role: ReadingObjectRole;
  slot?: string;
  uri: string;
  extension: string;
  mediaType?: string;
};

export type ReadingObjectCaptureResult = {
  objectId: string;
  plaintextBytes: number;
  chunkCount: number;
};

type ReadingLibraryBook = {
  id: string;
  fileType: string;
  fileUri?: string;
  coverUri?: string;
};

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recordOf(value: unknown, label: string): Record<string, unknown> {
  expect(
    !!value && typeof value === 'object' && !Array.isArray(value),
    `${label} 必须是对象。`,
  );
  return value as Record<string, unknown>;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`${label} 不是有效 JSON。`);
  }
}

function safeInteger(
  value: unknown,
  label: string,
  maximum: number,
  minimum = 0,
) {
  expect(
    Number.isSafeInteger(value)
      && Number(value) >= minimum
      && Number(value) <= maximum,
    `${label} 无效。`,
  );
  return Number(value);
}

function safeOptionalString(
  value: unknown,
  label: string,
  maximum: number,
) {
  if (value === undefined) return undefined;
  expect(
    typeof value === 'string'
      && value.length >= 1
      && value.length <= maximum
      && !/[\u0000-\u001f\u007f]/.test(value),
    `${label} 无效。`,
  );
  return value;
}

function safeLocalUri(value: unknown) {
  if (value === undefined) return undefined;
  expect(
    typeof value === 'string'
      && value.length <= 4096
      && /^file:\/\//.test(value),
    'reading object localUri 必须是本机 file URI。',
  );
  return value;
}

function safeKeyId(value: unknown, label: string) {
  if (value === undefined) return undefined;
  expect(
    typeof value === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
    `${label} 无效。`,
  );
  return value;
}

function normalizeLocalRecord(
  value: unknown,
  label: string,
): ReadingObjectLocalRecord {
  const record = recordOf(value, label);
  const bookId = safeOptionalString(record.bookId, `${label}.bookId`, 128);
  expect(
    !!bookId && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(bookId),
    `${label}.bookId 无效。`,
  );
  const role = record.role;
  expect(
    role === 'source' || role === 'cover' || role === 'extracted-image',
    `${label}.role 无效。`,
  );
  const slot = safeOptionalString(record.slot, `${label}.slot`, 160);
  if (role === 'extracted-image') {
    expect(
      !!slot
        && !/[\/\\]/.test(slot)
        && slot !== '.'
        && slot !== '..',
      `${label}.slot 无效。`,
    );
  } else {
    expect(slot === undefined, `${label} source/cover 不能带 slot。`);
  }
  const entityType = readingObjectEntityTypeForRole(role);
  expect(
    record.entityType === entityType,
    `${label}.entityType 与 role 不一致。`,
  );
  const entityId = readingObjectEntityId({
    bookId,
    role,
    ...(slot ? { slot } : {}),
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
  const mediaType = safeOptionalString(
    record.mediaType,
    `${label}.mediaType`,
    128,
  );
  return {
    entityType,
    entityId,
    bookId,
    role,
    ...(slot ? { slot } : {}),
    objectId: record.objectId,
    extension: record.extension,
    ...(mediaType ? { mediaType } : {}),
    plaintextBytes: safeInteger(
      record.plaintextBytes,
      `${label}.plaintextBytes`,
      Number.MAX_SAFE_INTEGER,
    ),
    chunkCount: safeInteger(
      record.chunkCount,
      `${label}.chunkCount`,
      100_000,
      1,
    ),
    updatedAt: safeInteger(
      record.updatedAt,
      `${label}.updatedAt`,
      Number.MAX_SAFE_INTEGER,
    ),
    ...(safeKeyId(record.keyId, `${label}.keyId`)
      ? { keyId: safeKeyId(record.keyId, `${label}.keyId`) }
      : {}),
    ...(safeLocalUri(record.localUri)
      ? { localUri: safeLocalUri(record.localUri) }
      : {}),
  };
}

export function emptyReadingObjectsLocalIndex(
  updatedAt = 0,
): ReadingObjectsLocalIndex {
  return {
    version: READING_OBJECTS_INDEX_VERSION,
    records: [],
    updatedAt,
  };
}

export function parseReadingObjectsLocalIndex(
  raw: string | null,
): ReadingObjectsLocalIndex {
  if (raw === null) return emptyReadingObjectsLocalIndex();
  const value = recordOf(parseJson(raw, 'reading objects index'), 'reading objects index');
  expect(
    value.version === READING_OBJECTS_INDEX_VERSION,
    'reading objects index version 无效。',
  );
  expect(
    Array.isArray(value.records) && value.records.length <= 50_000,
    'reading objects index records 无效。',
  );
  const records = value.records.map(
    (record, index) => normalizeLocalRecord(
      record,
      `reading objects index records[${index}]`,
    ),
  );
  const ids = new Set<string>();
  for (const record of records) {
    expect(!ids.has(record.entityId), `reading objects index 重复 entity：${record.entityId}。`);
    ids.add(record.entityId);
  }
  return {
    version: READING_OBJECTS_INDEX_VERSION,
    records: records.sort((left, right) =>
      left.entityId.localeCompare(right.entityId)),
    updatedAt: safeInteger(
      value.updatedAt,
      'reading objects index updatedAt',
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function serializeReadingObjectsLocalIndex(
  index: ReadingObjectsLocalIndex,
) {
  return JSON.stringify({
    version: READING_OBJECTS_INDEX_VERSION,
    records: [...index.records].sort((left, right) =>
      left.entityId.localeCompare(right.entityId)),
    updatedAt: index.updatedAt,
  });
}

function parseLibrary(raw: string): ReadingLibraryBook[] {
  const parsed = parseJson(raw, 'reading library');
  const rawBooks = Array.isArray(parsed)
    ? parsed
    : recordOf(parsed, 'reading library').books;
  expect(
    Array.isArray(rawBooks) && rawBooks.length <= 10_000,
    'reading library books 无效。',
  );
  const books = rawBooks.map((value, index) => {
    const record = recordOf(value, `reading library books[${index}]`);
    expect(
      typeof record.id === 'string'
        && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(record.id),
      `reading library books[${index}].id 无效。`,
    );
    expect(
      typeof record.fileType === 'string'
        && record.fileType.length >= 1
        && record.fileType.length <= 16,
      `reading library books[${index}].fileType 无效。`,
    );
    const fileUri = typeof record.fileUri === 'string'
      && /^file:\/\//.test(record.fileUri)
      ? record.fileUri
      : undefined;
    const coverUri = typeof record.coverUri === 'string'
      && /^file:\/\//.test(record.coverUri)
      ? record.coverUri
      : undefined;
    return {
      id: record.id,
      fileType: record.fileType,
      ...(fileUri ? { fileUri } : {}),
      ...(coverUri ? { coverUri } : {}),
    };
  });
  const ids = new Set<string>();
  for (const book of books) {
    expect(!ids.has(book.id), `reading library 重复 book：${book.id}。`);
    ids.add(book.id);
  }
  return books;
}

function sharedProjection(record: ReadingObjectLocalRecord): ReadingObjectRecord {
  const {
    entityType: _entityType,
    entityId: _entityId,
    keyId: _keyId,
    localUri: _localUri,
    ...shared
  } = record;
  return shared;
}

function sameJson(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function extensionFromUri(uri: string, fallback: string) {
  const clean = uri.split(/[?#]/, 1)[0];
  const match = clean.match(/\.([a-z0-9]{1,16})$/i);
  const extension = (match?.[1] ?? fallback).toLowerCase();
  expect(
    /^[a-z0-9]{1,16}$/.test(extension),
    'reading object 文件扩展名无效。',
  );
  return extension;
}

function mediaTypeForExtension(extension: string) {
  const known: Readonly<Record<string, string>> = {
    epub: 'application/epub+zip',
    pdf: 'application/pdf',
    txt: 'text/plain',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
  };
  return known[extension];
}

function descriptorForBookUri(
  book: ReadingLibraryBook,
  role: 'source' | 'cover',
): ReadingObjectDiscoveredFile | null {
  const uri = role === 'source' ? book.fileUri : book.coverUri;
  if (!uri) return null;
  const extension = extensionFromUri(
    uri,
    role === 'source' && book.fileType !== 'url'
      ? book.fileType
      : role === 'cover'
        ? 'jpg'
        : 'txt',
  );
  return {
    role,
    uri,
    extension,
    ...(mediaTypeForExtension(extension)
      ? { mediaType: mediaTypeForExtension(extension) }
      : {}),
  };
}

export async function prepareReadingObjectsIndexForLibrary(input: {
  previous: ReadingObjectsLocalIndex;
  libraryRaw: string;
  keyId: string;
  discoverExtractedImages(bookId: string): Promise<ReadingObjectDiscoveredFile[]>;
  capture(input: {
    bookId: string;
    file: ReadingObjectDiscoveredFile;
  }): Promise<ReadingObjectCaptureResult | null>;
  now: number;
}) {
  expect(
    Number.isSafeInteger(input.now) && input.now >= 0,
    'reading objects prepare now 无效。',
  );
  const books = parseLibrary(input.libraryRaw);
  const bookIds = new Set(books.map((book) => book.id));
  const previousByEntity = new Map(
    input.previous.records.map((record) => [record.entityId, record]),
  );
  const next = new Map<string, ReadingObjectLocalRecord>();
  for (const record of input.previous.records) {
    if (bookIds.has(record.bookId)) next.set(record.entityId, record);
  }
  for (const book of books) {
    const discovered = [
      descriptorForBookUri(book, 'source'),
      descriptorForBookUri(book, 'cover'),
      ...await input.discoverExtractedImages(book.id),
    ].filter((file): file is ReadingObjectDiscoveredFile => !!file);
    const descriptorIds = new Set<string>();
    for (const file of discovered) {
      expect(/^file:\/\//.test(file.uri), 'reading object 来源必须是本机 file URI。');
      expect(
        /^[a-z0-9]{1,16}$/.test(file.extension),
        'reading object discovery extension 无效。',
      );
      if (file.role === 'extracted-image') {
        expect(
          !!file.slot
            && file.slot.length <= 160
            && !/[\/\\\u0000-\u001f\u007f]/.test(file.slot),
          'reading extracted image discovery slot 无效。',
        );
      }
      const entityType = readingObjectEntityTypeForRole(file.role);
      const entityId = readingObjectEntityId({
        bookId: book.id,
        role: file.role,
        ...(file.slot ? { slot: file.slot } : {}),
      });
      expect(!descriptorIds.has(entityId), `reading object discovery 重复 entity：${entityId}。`);
      descriptorIds.add(entityId);
      const existing = previousByEntity.get(entityId);
      if (
        existing?.localUri === file.uri
        && existing.keyId === input.keyId
      ) {
        next.set(entityId, existing);
        continue;
      }
      const captured = await input.capture({
        bookId: book.id,
        file,
      });
      if (!captured) continue;
      expect(
        /^[A-Za-z0-9_-]{43}$/.test(captured.objectId),
        'reading object capture objectId 无效。',
      );
      const sharedContentUnchanged = !!existing
        && existing.objectId === captured.objectId
        && existing.extension === file.extension
        && existing.mediaType === file.mediaType
        && existing.plaintextBytes === captured.plaintextBytes
        && existing.chunkCount === captured.chunkCount;
      const record: ReadingObjectLocalRecord = {
        entityType,
        entityId,
        bookId: book.id,
        role: file.role,
        ...(file.slot ? { slot: file.slot } : {}),
        objectId: captured.objectId,
        extension: file.extension,
        ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        plaintextBytes: captured.plaintextBytes,
        chunkCount: captured.chunkCount,
        updatedAt: sharedContentUnchanged
          ? existing.updatedAt
          : input.now,
        keyId: input.keyId,
        localUri: file.uri,
      };
      next.set(entityId, record);
    }
  }
  const records = [...next.values()].sort((left, right) =>
    left.entityId.localeCompare(right.entityId));
  return {
    version: READING_OBJECTS_INDEX_VERSION,
    records,
    updatedAt: sameJson(records, input.previous.records)
      ? input.previous.updatedAt
      : input.now,
  } satisfies ReadingObjectsLocalIndex;
}

export async function deriveReadingObjectsMutations(input: {
  previous: ReadingObjectsLocalIndex;
  next: ReadingObjectsLocalIndex;
  capturedAt: number;
  envelopeFactory: ReadingObjectsEnvelopeFactory;
}) {
  const previous = new Map(
    input.previous.records.map((record) => [record.entityId, record]),
  );
  const next = new Map(
    input.next.records.map((record) => [record.entityId, record]),
  );
  const ids = [...new Set([...previous.keys(), ...next.keys()])].sort();
  const mutations: PlainMutationV1[] = [];
  for (const entityId of ids) {
    const before = previous.get(entityId);
    const after = next.get(entityId);
    const beforeShared = before ? sharedProjection(before) : undefined;
    const afterShared = after ? sharedProjection(after) : undefined;
    if (sameJson(beforeShared, afterShared)) continue;
    const identity = after ?? before;
    if (!identity) continue;
    const envelope = await input.envelopeFactory({
      domain: 'reading',
      type: identity.entityType,
      id: entityId,
    });
    if (!after) {
      mutations.push(buildReadingObjectDeleteMutation({
        envelope,
        entityType: identity.entityType,
        entityId,
        deletedAt: input.capturedAt,
      }));
    } else {
      mutations.push(buildReadingObjectRecordMutation({
        envelope,
        entityType: after.entityType,
        entityId,
        value: afterShared!,
      }));
    }
  }
  return mutations;
}
