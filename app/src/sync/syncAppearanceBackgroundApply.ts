import {
  appearanceBackgroundMutationValue,
  assertAppearanceBackgroundMutationV1,
  type AppearanceBackgroundRecordKind,
  type AppearanceBackgroundRecordValue,
} from './syncAppearanceBackground';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type AppearanceBackgroundRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface AppearanceBackgroundBusinessPort {
  upsert(input: {
    kind: AppearanceBackgroundRecordKind;
    value: AppearanceBackgroundRecordValue;
    revision: AppearanceBackgroundRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    kind: AppearanceBackgroundRecordKind;
    entityId: string;
    deletedAt: number;
    revision: AppearanceBackgroundRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): AppearanceBackgroundRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class AppearanceBackgroundBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: AppearanceBackgroundBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertAppearanceBackgroundMutationV1(mutation);
    const decoded = appearanceBackgroundMutationValue(mutation);
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

export const APPEARANCE_BACKGROUND_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'appearance.background',
  isMutationAllowed(mutation) {
    try {
      assertAppearanceBackgroundMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
