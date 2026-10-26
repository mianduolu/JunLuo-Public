import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  assertReadingObjectRecord,
  type ReadingObjectRecord,
} from './syncReadingObjects';
import type {
  ReadingObjectsBusinessPort,
} from './syncReadingObjectsApply';
import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  loadSyncObjectJob,
  scheduleSyncObjectDownload,
  type SyncObjectJob,
} from './syncObjectJobStore';
import {
  materializeReadingObjectFile,
} from './syncReadingObjectMaterialization';
import {
  parseReadingObjectsLocalIndex,
  READING_OBJECTS_INDEX_KEY,
  READING_OBJECTS_LIBRARY_KEY,
  serializeReadingObjectsLocalIndex,
  type ReadingObjectLocalRecord,
  type ReadingObjectsLocalIndex,
} from './syncReadingObjectsStorageDerivation';

type ReadingObjectsStoragePort = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
};

type ReadingObjectsJobPort = {
  load(objectId: string): Promise<SyncObjectJob | null>;
  scheduleDownload(input: {
    objectId: string;
    totalChunks: number;
    now: number;
  }): Promise<void>;
};

type ReadingObjectsMaterializePort = {
  materialize(input: {
    sourceUri: string;
    record: ReadingObjectRecord;
  }): Promise<string>;
};

let readingObjectsApplyQueue = Promise.resolve();

function enqueueReadingObjectsApply<T>(callback: () => Promise<T>) {
  const current = readingObjectsApplyQueue
    .catch(() => undefined)
    .then(callback);
  readingObjectsApplyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

function parseLibrary(raw: string | null) {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('reading library 不是有效 JSON。');
  }
  const rawBooks = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      && !Array.isArray(parsed)
      && Array.isArray((parsed as { books?: unknown }).books)
      ? (parsed as { books: unknown[] }).books
      : null;
  if (!rawBooks) throw new Error('reading library books 无效。');
  return {
    parsed,
    books: rawBooks,
  };
}

function withMaterializedBookUri(
  value: unknown,
  record: ReadingObjectRecord,
  uri: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const book = value as Record<string, unknown>;
  if (book.id !== record.bookId) return value;
  if (record.role === 'source') return { ...book, fileUri: uri };
  if (record.role === 'cover') return { ...book, coverUri: uri };
  return value;
}

async function persistLibraryUri(
  storage: ReadingObjectsStoragePort,
  record: ReadingObjectRecord,
  uri: string,
) {
  if (record.role === 'extracted-image') return;
  const library = parseLibrary(await storage.getItem(READING_OBJECTS_LIBRARY_KEY));
  if (!library) return;
  const books = library.books.map((book) =>
    withMaterializedBookUri(book, record, uri));
  const next = Array.isArray(library.parsed)
    ? books
    : {
        ...(library.parsed as Record<string, unknown>),
        books,
      };
  await storage.setItem(READING_OBJECTS_LIBRARY_KEY, JSON.stringify(next));
}

async function loadIndex(storage: ReadingObjectsStoragePort) {
  return parseReadingObjectsLocalIndex(
    await storage.getItem(READING_OBJECTS_INDEX_KEY),
  );
}

async function saveIndex(
  storage: ReadingObjectsStoragePort,
  index: ReadingObjectsLocalIndex,
) {
  await storage.setItem(
    READING_OBJECTS_INDEX_KEY,
    serializeReadingObjectsLocalIndex(index),
  );
}

async function materializedUriForRecord(input: {
  record: ReadingObjectRecord;
  existing?: ReadingObjectLocalRecord;
  jobs: ReadingObjectsJobPort;
  files: ReadingObjectsMaterializePort;
  now: number;
}) {
  if (
    input.existing?.objectId === input.record.objectId
    && input.existing.localUri
    && /^file:\/\//.test(input.existing.localUri)
  ) {
    return input.existing.localUri;
  }
  const job = await input.jobs.load(input.record.objectId);
  if (
    job?.state === 'verified'
    && job.localUri
    && /^file:\/\//.test(job.localUri)
  ) {
    return input.files.materialize({
      sourceUri: job.localUri,
      record: input.record,
    });
  }
  await input.jobs.scheduleDownload({
    objectId: input.record.objectId,
    totalChunks: input.record.chunkCount,
    now: input.now,
  });
  return undefined;
}

export function createReadingObjectsBusinessPort(input: {
  storage: ReadingObjectsStoragePort;
  jobs: ReadingObjectsJobPort;
  files: ReadingObjectsMaterializePort;
}): ReadingObjectsBusinessPort {
  return {
    upsertRecord: (change) => enqueueReadingObjectsApply(async () => {
      assertReadingObjectRecord(
        change.entityType,
        change.entityId,
        change.value,
      );
      const index = await loadIndex(input.storage);
      const existing = index.records.find(
        (record) => record.entityId === change.entityId,
      );
      const localUri = await materializedUriForRecord({
        record: change.value,
        existing,
        jobs: input.jobs,
        files: input.files,
        now: change.revision.createdAt,
      });
      const nextRecord: ReadingObjectLocalRecord = {
        entityType: change.entityType,
        entityId: change.entityId,
        ...change.value,
        ...(localUri ? { localUri } : {}),
      };
      const records = index.records.filter(
        (record) => record.entityId !== change.entityId,
      );
      records.push(nextRecord);
      await saveIndex(input.storage, {
        version: 1,
        records,
        updatedAt: Math.max(index.updatedAt, change.revision.createdAt),
      });
      if (localUri) {
        await persistLibraryUri(input.storage, change.value, localUri);
      }
    }),
    tombstone: (change) => enqueueReadingObjectsApply(async () => {
      const index = await loadIndex(input.storage);
      const records = index.records.filter(
        (record) => record.entityId !== change.entityId,
      );
      if (records.length === index.records.length) return;
      await saveIndex(input.storage, {
        version: 1,
        records,
        updatedAt: Math.max(index.updatedAt, change.revision.createdAt),
      });
    }),
  };
}

const productionJobs: ReadingObjectsJobPort = {
  load: loadSyncObjectJob,
  async scheduleDownload(input) {
    const currentDevice = await loadCurrentSyncDevice();
    if (!currentDevice) return;
    await scheduleSyncObjectDownload({
      ...input,
      keyId: currentDevice.identity.keyId,
    });
  },
};

const productionFiles: ReadingObjectsMaterializePort = {
  materialize: materializeReadingObjectFile,
};

export const readingObjectsAsyncStorageBusinessPort =
  createReadingObjectsBusinessPort({
    storage: RawAsyncStorage,
    jobs: productionJobs,
    files: productionFiles,
  });

export async function materializeReadingObject(input: {
  objectId: string;
  localUri: string;
}) {
  return enqueueReadingObjectsApply(async () => {
    const index = await loadIndex(RawAsyncStorage);
    let matched = false;
    let changed = false;
    for (const record of index.records) {
      if (record.objectId !== input.objectId) continue;
      matched = true;
      const uri = await materializeReadingObjectFile({
        sourceUri: input.localUri,
        record,
      });
      if (record.localUri !== uri) {
        record.localUri = uri;
        changed = true;
      }
      await persistLibraryUri(RawAsyncStorage, record, uri);
    }
    if (changed) {
      await saveIndex(RawAsyncStorage, {
        ...index,
        updatedAt: Math.max(index.updatedAt, Date.now()),
      });
    }
    return {
      handled: matched,
      pending: !matched,
      changed,
    };
  });
}
