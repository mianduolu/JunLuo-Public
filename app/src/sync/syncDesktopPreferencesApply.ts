import {
  assertDesktopPreferencesMutationV1,
  desktopPreferenceMutationValue,
  type DesktopPreferenceRecord,
} from './syncDesktopPreferences';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type DesktopPreferenceRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface DesktopPreferencesBusinessPort {
  setPreference(input: {
    record: DesktopPreferenceRecord;
    revision: DesktopPreferenceRevisionContext;
  }): Promise<void>;
}

export class DesktopPreferencesBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: DesktopPreferencesBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertDesktopPreferencesMutationV1(mutation);
    await this.port.setPreference({
      record: desktopPreferenceMutationValue(mutation),
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

export const DESKTOP_PREFERENCES_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'desktop.preferences',
  isMutationAllowed(mutation) {
    try {
      assertDesktopPreferencesMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
