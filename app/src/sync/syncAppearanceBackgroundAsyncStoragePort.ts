import RawAsyncStorage from '@react-native-async-storage/async-storage';

import {
  appearanceBackgroundEntityId,
  assertAppearanceBackgroundRecord,
  type AppearanceBackgroundObject,
  type AppearanceBackgroundSettings,
} from './syncAppearanceBackground';
import type {
  AppearanceBackgroundBusinessPort,
} from './syncAppearanceBackgroundApply';
import {
  materializeAppearanceBackgroundFile,
} from './syncAppearanceBackgroundMaterialization';
import {
  APPEARANCE_BACKGROUND_INDEX_KEY,
  APPEARANCE_BACKGROUND_SETTINGS_KEY,
  parseAppearanceBackgroundLocalIndex,
  parseAppearanceBackgroundSettings,
  serializeAppearanceBackgroundLocalIndex,
  serializeAppearanceBackgroundSettings,
  type AppearanceBackgroundLocalIndex,
} from './syncAppearanceBackgroundStorageDerivation';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import {
  loadSyncObjectJob,
  scheduleSyncObjectDownload,
  type SyncObjectJob,
} from './syncObjectJobStore';

type AppearanceBackgroundStoragePort = {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
};

type AppearanceBackgroundJobPort = {
  load(objectId: string): Promise<SyncObjectJob | null>;
  scheduleDownload(input: {
    objectId: string;
    totalChunks: number;
    now: number;
  }): Promise<void>;
};

type AppearanceBackgroundMaterializePort = {
  materialize(input: {
    sourceUri: string;
    record: AppearanceBackgroundObject;
  }): Promise<string>;
};

let applyQueue = Promise.resolve();

function enqueueApply<T>(callback: () => Promise<T>) {
  const current = applyQueue.catch(() => undefined).then(callback);
  applyQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

async function loadIndex(storage: AppearanceBackgroundStoragePort) {
  return parseAppearanceBackgroundLocalIndex(
    await storage.getItem(APPEARANCE_BACKGROUND_INDEX_KEY),
  );
}

async function saveIndex(
  storage: AppearanceBackgroundStoragePort,
  index: AppearanceBackgroundLocalIndex,
) {
  await storage.setItem(
    APPEARANCE_BACKGROUND_INDEX_KEY,
    serializeAppearanceBackgroundLocalIndex(index),
  );
}

async function writeSettings(input: {
  storage: AppearanceBackgroundStoragePort;
  value: AppearanceBackgroundSettings;
  index: AppearanceBackgroundLocalIndex;
}) {
  const object = input.value.imageObjectId
    ? input.index.objects.find(
      (candidate) =>
        candidate.objectId === input.value.imageObjectId,
    )
    : undefined;
  const current = parseAppearanceBackgroundSettings(
    await input.storage.getItem(
      APPEARANCE_BACKGROUND_SETTINGS_KEY,
    ),
  );
  await saveIndex(input.storage, {
    ...input.index,
    ...(input.value.imageObjectId
      ? { selectedObjectId: input.value.imageObjectId }
      : { selectedObjectId: undefined }),
  });
  await input.storage.setItem(
    APPEARANCE_BACKGROUND_SETTINGS_KEY,
    serializeAppearanceBackgroundSettings({
      mode: input.value.mode,
      fixedPeriod: input.value.fixedPeriod,
      imageFit: input.value.imageFit,
      headerTextTone: input.value.headerTextTone,
      exposedLabelTextTone: input.value.exposedLabelTextTone,
      ...(object?.localUri
        ? { imageUri: object.localUri }
        : {}),
      ...(
        !object?.localUri
        && input.value.imageObjectId
        && current.imageUri
        && input.index.selectedObjectId
          === input.value.imageObjectId
        ? { imageUri: current.imageUri }
        : {}
      ),
    }),
  );
}

async function materializedUriForObject(input: {
  record: AppearanceBackgroundObject;
  existing?: AppearanceBackgroundLocalIndex['objects'][number];
  jobs: AppearanceBackgroundJobPort;
  files: AppearanceBackgroundMaterializePort;
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

export function createAppearanceBackgroundBusinessPort(input: {
  storage: AppearanceBackgroundStoragePort;
  jobs: AppearanceBackgroundJobPort;
  files: AppearanceBackgroundMaterializePort;
  now?: () => number;
}): AppearanceBackgroundBusinessPort {
  const now = input.now ?? Date.now;
  return {
    upsert: (change) => enqueueApply(async () => {
      assertAppearanceBackgroundRecord(
        change.kind,
        change.value,
      );
      const index = await loadIndex(input.storage);
      if (change.kind === 'background-settings') {
        await writeSettings({
          storage: input.storage,
          value: change.value as AppearanceBackgroundSettings,
          index,
        });
        return;
      }
      const value = change.value as AppearanceBackgroundObject;
      const existing = index.objects.find(
        (candidate) => candidate.slotId === value.slotId,
      );
      const localUri = await materializedUriForObject({
        record: value,
        existing,
        jobs: input.jobs,
        files: input.files,
        now: now(),
      });
      const next: AppearanceBackgroundLocalIndex = {
        ...index,
        objects: [{
          ...value,
          updatedAt: existing?.objectId === value.objectId
            ? existing.updatedAt
            : now(),
          ...(localUri ? { localUri } : {}),
        }],
      };
      await saveIndex(input.storage, next);
      if (
        next.selectedObjectId === value.objectId
        && localUri
      ) {
        const settings = parseAppearanceBackgroundSettings(
          await input.storage.getItem(
            APPEARANCE_BACKGROUND_SETTINGS_KEY,
          ),
        );
        await input.storage.setItem(
          APPEARANCE_BACKGROUND_SETTINGS_KEY,
          serializeAppearanceBackgroundSettings({
            ...settings,
            imageUri: localUri,
          }),
        );
      }
    }),
    tombstone: (change) => enqueueApply(async () => {
      const index = await loadIndex(input.storage);
      if (
        change.kind === 'background-settings'
        && change.entityId
          === appearanceBackgroundEntityId('background-settings')
      ) {
        await input.storage.removeItem(
          APPEARANCE_BACKGROUND_SETTINGS_KEY,
        );
        await saveIndex(input.storage, {
          ...index,
          selectedObjectId: undefined,
        });
        return;
      }
      if (
        change.kind === 'background-object'
        && change.entityId
          === appearanceBackgroundEntityId('background-object')
      ) {
        const removedIds = new Set(
          index.objects.map((value) => value.objectId),
        );
        await saveIndex(input.storage, {
          ...index,
          objects: [],
        });
        if (
          index.selectedObjectId
          && removedIds.has(index.selectedObjectId)
        ) {
          const settings = parseAppearanceBackgroundSettings(
            await input.storage.getItem(
              APPEARANCE_BACKGROUND_SETTINGS_KEY,
            ),
          );
          await input.storage.setItem(
            APPEARANCE_BACKGROUND_SETTINGS_KEY,
            serializeAppearanceBackgroundSettings({
              ...settings,
              imageUri: undefined,
            }),
          );
        }
      }
    }),
  };
}

const productionJobs: AppearanceBackgroundJobPort = {
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

const productionFiles: AppearanceBackgroundMaterializePort = {
  materialize: materializeAppearanceBackgroundFile,
};

export const appearanceBackgroundAsyncStorageBusinessPort =
  createAppearanceBackgroundBusinessPort({
    storage: RawAsyncStorage,
    jobs: productionJobs,
    files: productionFiles,
  });

export async function materializeAppearanceBackgroundObject(input: {
  objectId: string;
  localUri: string;
}) {
  return enqueueApply(async () => {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.objectId)
      || !/^file:\/\//.test(input.localUri)
    ) {
      throw new Error(
        'appearance.background materialize 输入无效。',
      );
    }
    const index = await loadIndex(RawAsyncStorage);
    const object = index.objects.find(
      (candidate) => candidate.objectId === input.objectId,
    );
    if (!object) {
      return {
        handled: false as const,
        pending: true as const,
        changed: false,
      };
    }
    const uri = await materializeAppearanceBackgroundFile({
      sourceUri: input.localUri,
      record: object,
    });
    await saveIndex(RawAsyncStorage, {
      ...index,
      objects: [{ ...object, localUri: uri }],
    });
    if (index.selectedObjectId === input.objectId) {
      const settings = parseAppearanceBackgroundSettings(
        await RawAsyncStorage.getItem(
          APPEARANCE_BACKGROUND_SETTINGS_KEY,
        ),
      );
      await RawAsyncStorage.setItem(
        APPEARANCE_BACKGROUND_SETTINGS_KEY,
        serializeAppearanceBackgroundSettings({
          ...settings,
          imageUri: uri,
        }),
      );
    }
    return {
      handled: true as const,
      changed: object.localUri !== uri,
    };
  });
}
