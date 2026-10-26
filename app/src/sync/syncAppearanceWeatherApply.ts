import {
  appearanceWeatherMutationValue,
  assertAppearanceWeatherMutationV1,
  type AppearanceWeatherRecordKind,
  type AppearanceWeatherRecordValue,
} from './syncAppearanceWeather';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type AppearanceWeatherRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface AppearanceWeatherBusinessPort {
  upsert(input: {
    kind: AppearanceWeatherRecordKind;
    value: AppearanceWeatherRecordValue;
    revision: AppearanceWeatherRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    kind: AppearanceWeatherRecordKind;
    entityId: string;
    deletedAt: number;
    revision: AppearanceWeatherRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): AppearanceWeatherRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

export class AppearanceWeatherBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: AppearanceWeatherBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertAppearanceWeatherMutationV1(mutation);
    const decoded = appearanceWeatherMutationValue(mutation);
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

export const APPEARANCE_WEATHER_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'appearance.weather',
  isMutationAllowed(mutation) {
    try {
      assertAppearanceWeatherMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
