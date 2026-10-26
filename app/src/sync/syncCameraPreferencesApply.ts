import {
  assertCameraPreferenceFieldValue,
  assertCameraPreferencesMutationV1,
  CAMERA_PREFERENCES_ADAPTER_ID,
  cameraPreferenceMutationValue,
  type CameraPreferenceField,
  type CameraPreferenceFieldValue,
} from './syncCameraPreferences';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type CameraPreferencesRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface CameraPreferencesBusinessPort {
  upsertPreferenceField(input: {
    field: CameraPreferenceField;
    value: CameraPreferenceFieldValue;
    revision: CameraPreferencesRevisionContext;
  }): Promise<void>;
}

export class CameraPreferencesBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: CameraPreferencesBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertCameraPreferencesMutationV1(mutation);
    const { field, value } = cameraPreferenceMutationValue(mutation);
    assertCameraPreferenceFieldValue(field, value);
    await this.port.upsertPreferenceField({
      field,
      value,
      revision: {
        revisionId: mutation.revision.id,
        parentRevisionIds: [...mutation.revision.parents],
        sourceDeviceId: mutation.sourceDeviceId,
        sourceSequence: mutation.sourceSequence,
        createdAt: mutation.createdAt,
      },
    });
  }
}

export const CAMERA_PREFERENCES_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: CAMERA_PREFERENCES_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertCameraPreferencesMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
