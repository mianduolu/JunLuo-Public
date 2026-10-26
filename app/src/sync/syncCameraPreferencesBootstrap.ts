import {
  CAMERA_PREFERENCES_ADAPTER_ID,
} from './syncCameraPreferences';
import {
  CAMERA_PERCEPTION_SETTINGS_KEY,
  deriveCameraPreferenceBootstrapMutations,
  type CameraPreferencesEnvelopeFactory,
} from './syncCameraPreferencesStorageDerivation';
import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { SyncDurableIntentState } from './syncRecoveryIntent';
import type { PlainMutationV1 } from './syncProtocol';

export const CAMERA_PREFERENCES_BOOTSTRAP_VERSION = 1 as const;

export type CameraPreferencesBootstrapStatePort = {
  load(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
  }): Promise<{
    completed: boolean;
    durableIntentState: SyncDurableIntentState | null;
  }>;
  markCompleted(input: {
    adapterId: string;
    version: number;
    sourceDeviceId: string;
    updatedAt: number;
  }): Promise<void>;
};

export type CameraPreferencesBootstrapStoragePort = {
  getItem(key: string): Promise<string | null>;
};

export type CameraPreferencesBootstrapCapturePort = {
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
};

export type CameraPreferencesBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

export async function runCameraPreferencesBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: CameraPreferencesBootstrapStatePort;
  storage: CameraPreferencesBootstrapStoragePort;
  capture: CameraPreferencesBootstrapCapturePort;
  envelopeFactory: CameraPreferencesEnvelopeFactory;
  now?: () => number;
}): Promise<CameraPreferencesBootstrapResult> {
  const adapterId = CAMERA_PREFERENCES_ADAPTER_ID;
  const version = CAMERA_PREFERENCES_BOOTSTRAP_VERSION;
  const sourceDeviceId = input.identity.deviceId;
  const operationId = syncBootstrapOperationId({
    adapterId,
    version,
    sourceDeviceId,
  });
  const stateInput = { adapterId, version, sourceDeviceId };
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
    };
  }
  if (state.durableIntentState === 'captured') {
    await input.state.markCompleted({
      ...stateInput,
      updatedAt: (input.now ?? Date.now)(),
    });
    return {
      status: 'completed',
      operationId,
      mutationCount: 0,
    };
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    };
  }
  const raw = await input.storage.getItem(
    CAMERA_PERCEPTION_SETTINGS_KEY,
  );
  const mutations =
    await deriveCameraPreferenceBootstrapMutations({
      raw,
      envelopeFactory: input.envelopeFactory,
    });
  if (mutations.length) {
    await input.capture.capture({ operationId, mutations });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: (input.now ?? Date.now)(),
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
  };
}
