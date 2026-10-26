import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  runTogetherWalkedLifeCaptureExclusive,
} from './syncTogetherWalkedLifeCaptureQueue';

import {
  assertTogetherWalkedLifeRecord,
  TOGETHER_WALKED_DRAFT_ENTITY_ID,
  type TogetherWalkedDraftRecord,
  type TogetherWalkedEntryRecord,
  type TogetherWalkedImageObjectRecord,
  type TogetherWalkedJourneyRecord,
} from './syncTogetherWalkedLife';
import type {
  TogetherWalkedLifeBusinessPort,
} from './syncTogetherWalkedLifeApply';
import {
  loadCurrentSyncDevice,
} from './syncCurrentDevice';
import {
  loadSyncObjectJob,
  scheduleSyncObjectDownload,
  type SyncObjectJob,
} from './syncObjectJobStore';
import {
  materializeTogetherWalkedImageFile,
} from './syncTogetherWalkedLifeMaterialization';
import {
  parseTogetherWalkedDraftStorage,
  parseTogetherWalkedEntriesStorage,
  parseTogetherWalkedJourneysStorage,
  parseTogetherWalkedLifeLocalIndex,
  serializeTogetherWalkedLifeLocalIndex,
  togetherWalkedDraftFingerprint,
  TOGETHER_WALKED_DRAFT_KEY,
  TOGETHER_WALKED_ENTRIES_KEY,
  TOGETHER_WALKED_JOURNEYS_KEY,
  TOGETHER_WALKED_LIFE_INDEX_KEY,
  type TogetherWalkedLifeLocalIndex,
  type TogetherWalkedLocalDraft,
  type TogetherWalkedLocalEntry,
  type TogetherWalkedLocalImageObject,
} from './syncTogetherWalkedLifeStorageDerivation';

type TogetherWalkedStoragePort = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type TogetherWalkedJobPort = {
  load(objectId: string): Promise<SyncObjectJob | null>;
  scheduleDownload(input: {
    objectId: string;
    totalChunks: number;
    now: number;
  }): Promise<void>;
};

type TogetherWalkedMaterializePort = {
  materialize(input: {
    sourceUri: string;
    record: TogetherWalkedImageObjectRecord;
  }): Promise<string>;
};

async function loadIndex(storage: TogetherWalkedStoragePort) {
  return parseTogetherWalkedLifeLocalIndex(
    await storage.getItem(TOGETHER_WALKED_LIFE_INDEX_KEY),
  );
}

async function saveIndex(
  storage: TogetherWalkedStoragePort,
  index: TogetherWalkedLifeLocalIndex,
) {
  await storage.setItem(
    TOGETHER_WALKED_LIFE_INDEX_KEY,
    serializeTogetherWalkedLifeLocalIndex(index),
  );
}

function sortEntries(entries: TogetherWalkedLocalEntry[]) {
  return [...entries].sort(
    (left, right) => (
      right.createdAt - left.createdAt
      || left.id.localeCompare(right.id)
    ),
  );
}

function sortJourneys(journeys: TogetherWalkedJourneyRecord[]) {
  return [...journeys].sort(
    (left, right) => (
      right.updatedAt - left.updatedAt
      || left.id.localeCompare(right.id)
    ),
  );
}

async function loadEntries(storage: TogetherWalkedStoragePort) {
  return parseTogetherWalkedEntriesStorage(
    await storage.getItem(TOGETHER_WALKED_ENTRIES_KEY),
  );
}

async function saveEntries(
  storage: TogetherWalkedStoragePort,
  entries: TogetherWalkedLocalEntry[],
) {
  await storage.setItem(
    TOGETHER_WALKED_ENTRIES_KEY,
    JSON.stringify(sortEntries(entries)),
  );
}

async function loadJourneys(storage: TogetherWalkedStoragePort) {
  return parseTogetherWalkedJourneysStorage(
    await storage.getItem(TOGETHER_WALKED_JOURNEYS_KEY),
  );
}

async function saveJourneys(
  storage: TogetherWalkedStoragePort,
  journeys: TogetherWalkedJourneyRecord[],
) {
  await storage.setItem(
    TOGETHER_WALKED_JOURNEYS_KEY,
    JSON.stringify(sortJourneys(journeys)),
  );
}

function replaceById<T extends { id: string }>(
  values: T[],
  value: T,
) {
  const index = values.findIndex((item) => item.id === value.id);
  if (index < 0) values.push(value);
  else values[index] = value;
}

function indexObjectForOwner(
  index: TogetherWalkedLifeLocalIndex,
  ownerType: 'entry' | 'draft',
  ownerId: string,
) {
  return index.objects.find(
    (object) => (
      object.ownerType === ownerType
      && object.ownerId === ownerId
    ),
  );
}

async function pendingImageUri(input: {
  storage: TogetherWalkedStoragePort;
  ownerType: 'entry' | 'draft';
  ownerId: string;
  imageObjectId?: string;
  existingUri?: string;
}) {
  if (!input.imageObjectId) return undefined;
  const index = await loadIndex(input.storage);
  const object = indexObjectForOwner(
    index,
    input.ownerType,
    input.ownerId,
  );
  if (
    object?.objectId === input.imageObjectId
    && object.localUri
  ) {
    return object.localUri;
  }
  return input.existingUri;
}

async function upsertEntry(
  storage: TogetherWalkedStoragePort,
  record: TogetherWalkedEntryRecord,
) {
  const [entries, journeys] = await Promise.all([
    loadEntries(storage),
    loadJourneys(storage),
  ]);
  if (
    record.journeyId
    && !journeys.some((journey) => journey.id === record.journeyId)
  ) {
    throw new Error(
      `together-walked entry ${record.id} 缺少先行 journey。`,
    );
  }
  const existing = entries.find((entry) => entry.id === record.id);
  const imageUri = await pendingImageUri({
    storage,
    ownerType: 'entry',
    ownerId: record.id,
    imageObjectId: record.imageObjectId,
    existingUri: existing?.imageUri,
  });
  replaceById(entries, {
    id: record.id,
    title: record.title,
    note: record.note,
    ...(record.imageObjectId && imageUri ? { imageUri } : {}),
    ...(record.location ? { location: record.location } : {}),
    ...(record.journeyId ? { journeyId: record.journeyId } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.memoryId ? { memoryId: record.memoryId } : {}),
  });
  await saveEntries(storage, entries);
}

async function upsertJourney(
  storage: TogetherWalkedStoragePort,
  record: TogetherWalkedJourneyRecord,
) {
  const journeys = await loadJourneys(storage);
  replaceById(journeys, record);
  await saveJourneys(storage, journeys);
}

async function upsertDraft(
  storage: TogetherWalkedStoragePort,
  record: TogetherWalkedDraftRecord,
) {
  if (record.journeyId) {
    const journeys = await loadJourneys(storage);
    if (!journeys.some((journey) => journey.id === record.journeyId)) {
      throw new Error(
        'together-walked draft 缺少先行 journey。',
      );
    }
  }
  const current = parseTogetherWalkedDraftStorage(
    await storage.getItem(TOGETHER_WALKED_DRAFT_KEY),
  );
  const imageUri = await pendingImageUri({
    storage,
    ownerType: 'draft',
    ownerId: TOGETHER_WALKED_DRAFT_ENTITY_ID,
    imageObjectId: record.imageObjectId,
    existingUri: current?.imageUri,
  });
  const draft: TogetherWalkedLocalDraft = {
    ...(record.title !== undefined ? { title: record.title } : {}),
    ...(record.note !== undefined ? { note: record.note } : {}),
    ...(record.occurredAtText !== undefined
      ? { occurredAtText: record.occurredAtText }
      : {}),
    ...(record.imageObjectId && imageUri ? { imageUri } : {}),
    ...(record.location ? { location: record.location } : {}),
    ...(record.journeyId ? { journeyId: record.journeyId } : {}),
    ...(record.manualPlace !== undefined
      ? { manualPlace: record.manualPlace }
      : {}),
    ...(record.manualLatitude !== undefined
      ? { manualLatitude: record.manualLatitude }
      : {}),
    ...(record.manualLongitude !== undefined
      ? { manualLongitude: record.manualLongitude }
      : {}),
  };
  await storage.setItem(
    TOGETHER_WALKED_DRAFT_KEY,
    JSON.stringify(draft),
  );
  const index = await loadIndex(storage);
  const {
    updatedAt: _updatedAt,
    ...fingerprintValue
  } = record;
  await saveIndex(storage, {
    ...index,
    draftFingerprint:
      togetherWalkedDraftFingerprint(fingerprintValue),
    draftUpdatedAt: record.updatedAt,
    updatedAt: Math.max(index.updatedAt, record.updatedAt),
  });
}

async function persistOwnerUri(
  storage: TogetherWalkedStoragePort,
  record: TogetherWalkedImageObjectRecord,
  uri: string,
) {
  if (record.ownerType === 'entry') {
    const entries = await loadEntries(storage);
    let changed = false;
    const next = entries.map((entry) => {
      if (entry.id !== record.ownerId || entry.imageUri === uri) {
        return entry;
      }
      changed = true;
      return { ...entry, imageUri: uri };
    });
    if (changed) await saveEntries(storage, next);
    return;
  }
  const draft = parseTogetherWalkedDraftStorage(
    await storage.getItem(TOGETHER_WALKED_DRAFT_KEY),
  );
  if (!draft || draft.imageUri === uri) return;
  await storage.setItem(
    TOGETHER_WALKED_DRAFT_KEY,
    JSON.stringify({ ...draft, imageUri: uri }),
  );
}

async function materializedUriForRecord(input: {
  record: TogetherWalkedImageObjectRecord;
  existing?: TogetherWalkedLocalImageObject;
  jobs: TogetherWalkedJobPort;
  files: TogetherWalkedMaterializePort;
  now: number;
}) {
  if (
    input.existing?.objectId === input.record.objectId
    && input.existing.localUri
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

async function upsertImageObject(input: {
  storage: TogetherWalkedStoragePort;
  jobs: TogetherWalkedJobPort;
  files: TogetherWalkedMaterializePort;
  record: TogetherWalkedImageObjectRecord;
  entityId: string;
  now: number;
}) {
  const index = await loadIndex(input.storage);
  const existing = index.objects.find(
    (object) => object.entityId === input.entityId,
  );
  const localUri = await materializedUriForRecord({
    record: input.record,
    existing,
    jobs: input.jobs,
    files: input.files,
    now: input.now,
  });
  const nextObject: TogetherWalkedLocalImageObject = {
    entityId: input.entityId,
    ...input.record,
    ...(localUri ? { localUri } : {}),
  };
  const objects = index.objects.filter(
    (object) => (
      object.entityId !== input.entityId
      && !(
        object.ownerType === input.record.ownerType
        && object.ownerId === input.record.ownerId
      )
    ),
  );
  objects.push(nextObject);
  await saveIndex(input.storage, {
    ...index,
    objects,
    updatedAt: Math.max(index.updatedAt, input.now),
  });
  if (localUri) {
    await persistOwnerUri(input.storage, input.record, localUri);
  }
}

export function createTogetherWalkedLifeBusinessPort(input: {
  storage: TogetherWalkedStoragePort;
  jobs: TogetherWalkedJobPort;
  files: TogetherWalkedMaterializePort;
}): TogetherWalkedLifeBusinessPort {
  return {
    upsertRecord: (change) =>
      runTogetherWalkedLifeCaptureExclusive(async () => {
        assertTogetherWalkedLifeRecord(
          change.kind,
          change.entityId,
          change.value,
        );
        if (
          change.entityType === 'entry'
          && change.kind === 'entry'
        ) {
          await upsertEntry(
            input.storage,
            change.value as TogetherWalkedEntryRecord,
          );
          return;
        }
        if (
          change.entityType === 'journey'
          && change.kind === 'journey'
        ) {
          await upsertJourney(
            input.storage,
            change.value as TogetherWalkedJourneyRecord,
          );
          return;
        }
        if (
          change.entityType === 'draft'
          && change.kind === 'draft'
        ) {
          await upsertDraft(
            input.storage,
            change.value as TogetherWalkedDraftRecord,
          );
          return;
        }
        if (
          change.entityType === 'image-object'
          && change.kind === 'image-object'
        ) {
          await upsertImageObject({
            storage: input.storage,
            jobs: input.jobs,
            files: input.files,
            record: change.value as TogetherWalkedImageObjectRecord,
            entityId: change.entityId,
            now: change.revision.createdAt,
          });
          return;
        }
        throw new Error(
          'together-walked.life apply entity/kind 不匹配。',
        );
      }),
    tombstone: (change) =>
      runTogetherWalkedLifeCaptureExclusive(async () => {
        if (change.entityType === 'entry') {
          const [entries, index] = await Promise.all([
            loadEntries(input.storage),
            loadIndex(input.storage),
          ]);
          await saveEntries(
            input.storage,
            entries.filter((entry) => entry.id !== change.entityId),
          );
          await saveIndex(input.storage, {
            ...index,
            objects: index.objects.filter(
              (object) => !(
                object.ownerType === 'entry'
                && object.ownerId === change.entityId
              ),
            ),
            updatedAt: Math.max(
              index.updatedAt,
              change.revision.createdAt,
            ),
          });
          return;
        }
        if (change.entityType === 'draft') {
          const index = await loadIndex(input.storage);
          await input.storage.removeItem(TOGETHER_WALKED_DRAFT_KEY);
          await saveIndex(input.storage, {
            ...index,
            objects: index.objects.filter(
              (object) => object.ownerType !== 'draft',
            ),
            draftFingerprint: undefined,
            draftUpdatedAt: undefined,
            updatedAt: Math.max(
              index.updatedAt,
              change.revision.createdAt,
            ),
          });
          return;
        }
        if (change.entityType === 'journey') {
          const [journeys, entries] = await Promise.all([
            loadJourneys(input.storage),
            loadEntries(input.storage),
          ]);
          await saveJourneys(
            input.storage,
            journeys.filter(
              (journey) => journey.id !== change.entityId,
            ),
          );
          await saveEntries(
            input.storage,
            entries.map((entry) => (
              entry.journeyId === change.entityId
                ? {
                    ...entry,
                    journeyId: undefined,
                    updatedAt: Math.max(
                      entry.updatedAt,
                      change.deletedAt,
                    ),
                  }
                : entry
            )),
          );
          const draft = parseTogetherWalkedDraftStorage(
            await input.storage.getItem(TOGETHER_WALKED_DRAFT_KEY),
          );
          if (draft?.journeyId === change.entityId) {
            await input.storage.setItem(
              TOGETHER_WALKED_DRAFT_KEY,
              JSON.stringify({ ...draft, journeyId: undefined }),
            );
          }
          return;
        }
        const index = await loadIndex(input.storage);
        const removed = index.objects.find(
          (object) => object.entityId === change.entityId,
        );
        if (!removed) return;
        await saveIndex(input.storage, {
          ...index,
          objects: index.objects.filter(
            (object) => object.entityId !== change.entityId,
          ),
          updatedAt: Math.max(
            index.updatedAt,
            change.revision.createdAt,
          ),
        });
        if (removed.ownerType === 'entry') {
          const entries = await loadEntries(input.storage);
          await saveEntries(
            input.storage,
            entries.map((entry) => (
              entry.id === removed.ownerId
                ? { ...entry, imageUri: undefined }
                : entry
            )),
          );
        } else {
          const draft = parseTogetherWalkedDraftStorage(
            await input.storage.getItem(TOGETHER_WALKED_DRAFT_KEY),
          );
          if (draft) {
            await input.storage.setItem(
              TOGETHER_WALKED_DRAFT_KEY,
              JSON.stringify({ ...draft, imageUri: undefined }),
            );
          }
        }
      }),
  };
}

const productionJobs: TogetherWalkedJobPort = {
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

const productionFiles: TogetherWalkedMaterializePort = {
  materialize: materializeTogetherWalkedImageFile,
};

export const togetherWalkedLifeAsyncStorageBusinessPort =
  createTogetherWalkedLifeBusinessPort({
    storage: RawAsyncStorage,
    jobs: productionJobs,
    files: productionFiles,
  });

export async function materializeTogetherWalkedObject(input: {
  objectId: string;
  localUri: string;
}) {
  return runTogetherWalkedLifeCaptureExclusive(async () => {
    const index = await loadIndex(RawAsyncStorage);
    let matched = false;
    let changed = false;
    for (const object of index.objects) {
      if (object.objectId !== input.objectId) continue;
      matched = true;
      const uri = await materializeTogetherWalkedImageFile({
        sourceUri: input.localUri,
        record: object,
      });
      if (object.localUri !== uri) {
        object.localUri = uri;
        changed = true;
      }
      await persistOwnerUri(RawAsyncStorage, object, uri);
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
