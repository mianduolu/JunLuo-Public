import RawAsyncStorage from '@react-native-async-storage/async-storage';
import { notifySyncedFontChoice } from '../fonts/fontPreferenceRuntime';

import {
  appearanceFontEntityId,
  appearanceFontMutationValue,
  assertAppearanceFontMutationV1,
  assertAppearanceFontRecord,
  type AppearanceFontChoice,
  type AppearanceFontObject,
  type AppearanceFontRecordKind,
  type AppearanceFontRecordValue,
} from './syncAppearanceFonts';
import {
  APPEARANCE_FONT_CHOICE_KEY,
  APPEARANCE_FONT_INDEX_KEY,
  parseAppearanceFontLocalIndex,
  serializeAppearanceFontLocalIndex,
} from './syncAppearanceFontsStorageDerivation';
import { loadCurrentSyncDevice } from './syncCurrentDevice';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import {
  loadSyncObjectJob,
  scheduleSyncObjectDownload,
} from './syncObjectJobStore';
import type { PlainMutationV1 } from './syncProtocol';

export type AppearanceFontRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface AppearanceFontBusinessPort {
  upsert(input: {
    kind: AppearanceFontRecordKind;
    value: AppearanceFontRecordValue;
    revision: AppearanceFontRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    kind: AppearanceFontRecordKind;
    entityId: string;
    deletedAt: number;
    revision: AppearanceFontRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): AppearanceFontRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class AppearanceFontBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: AppearanceFontBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertAppearanceFontMutationV1(mutation);
    const decoded = appearanceFontMutationValue(mutation);
    const revision = revisionContext(mutation);
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        kind: decoded.kind,
        entityId: mutation.entity.id,
        deletedAt: decoded.deletedAt!,
        revision,
      });
      return;
    }
    await this.port.upsert({
      kind: decoded.kind,
      value: decoded.value!,
      revision,
    });
  }
}

export const APPEARANCE_FONTS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'appearance.fonts',
  isMutationAllowed(mutation) {
    try {
      assertAppearanceFontMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
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

async function saveFontObject(value: AppearanceFontObject) {
  const current = parseAppearanceFontLocalIndex(
    await RawAsyncStorage.getItem(APPEARANCE_FONT_INDEX_KEY),
  );
  const existing = current.records.find(
    (record) => record.fontId === value.fontId,
  );
  let localUri = existing?.objectId === value.objectId
    ? existing.localUri
    : undefined;
  if (!localUri) {
    const job = await loadSyncObjectJob(value.objectId);
    if (
      job?.state === 'verified'
      && job.localUri
      && /^file:\/\//.test(job.localUri)
    ) {
      localUri = job.localUri;
    } else {
      const currentDevice = await loadCurrentSyncDevice();
      if (currentDevice) {
        await scheduleSyncObjectDownload({
          objectId: value.objectId,
          keyId: currentDevice.identity.keyId,
          totalChunks: value.chunkCount,
          now: Date.now(),
        });
      }
    }
  }
  await RawAsyncStorage.setItem(
    APPEARANCE_FONT_INDEX_KEY,
    serializeAppearanceFontLocalIndex({
      version: 1,
      records: [{
        ...value,
        updatedAt: existing?.objectId === value.objectId
          ? existing.updatedAt
          : Date.now(),
        ...(localUri ? { localUri } : {}),
      }],
    }),
  );
}

async function removeByEntityId(
  kind: AppearanceFontRecordKind,
  entityId: string,
) {
  if (
    kind === 'font-choice'
    && appearanceFontEntityId(kind, 'global') === entityId
  ) {
    await RawAsyncStorage.removeItem(APPEARANCE_FONT_CHOICE_KEY);
    notifySyncedFontChoice('system');
    return;
  }
  if (
    kind === 'font-object'
    && appearanceFontEntityId(kind, 'xiaolai') === entityId
  ) {
    await RawAsyncStorage.removeItem(APPEARANCE_FONT_INDEX_KEY);
  }
}

export const appearanceFontAsyncStorageBusinessPort:
AppearanceFontBusinessPort = {
  upsert: (input) => enqueueApply(async () => {
    assertAppearanceFontRecord(input.kind, input.value);
    if (input.kind === 'font-choice') {
      const value = input.value as AppearanceFontChoice;
      await RawAsyncStorage.setItem(
        APPEARANCE_FONT_CHOICE_KEY,
        value.fontId,
      );
      notifySyncedFontChoice(value.fontId);
      return;
    }
    await saveFontObject(input.value as AppearanceFontObject);
  }),
  tombstone: (input) => enqueueApply(
    () => removeByEntityId(input.kind, input.entityId),
  ),
};

export async function materializeAppearanceFontObject(input: {
  objectId: string;
  localUri: string;
}) {
  return enqueueApply(async () => {
    if (
      !/^[A-Za-z0-9_-]{43}$/.test(input.objectId)
      || !/^file:\/\//.test(input.localUri)
    ) {
      throw new Error('appearance.fonts materialize 输入无效。');
    }
    const index = parseAppearanceFontLocalIndex(
      await RawAsyncStorage.getItem(APPEARANCE_FONT_INDEX_KEY),
    );
    const target = index.records.find(
      (record) => record.objectId === input.objectId,
    );
    if (!target) {
      return {
        handled: false as const,
        pending: true as const,
        changed: false,
      };
    }
    await RawAsyncStorage.setItem(
      APPEARANCE_FONT_INDEX_KEY,
      serializeAppearanceFontLocalIndex({
        version: 1,
        records: [{ ...target, localUri: input.localUri }],
      }),
    );
    return {
      handled: true as const,
      changed: target.localUri !== input.localUri,
    };
  });
}
