import {
  DESKTOP_PREFERENCES_ADAPTER_ID,
} from './syncDesktopPreferences';
import {
  deriveDesktopPreferenceMutations,
  projectDesktopPreferences,
  type DesktopPreferencesEnvelopeFactory,
  type DesktopSharedPreferences,
} from './syncDesktopPreferencesDocument';
import { syncBootstrapOperationId } from './syncBootstrapContract';
import type { SyncDevicePublicIdentityV1 } from './syncDeviceContract';
import type { PlainMutationV1 } from './syncProtocol';
import type { SyncDurableIntentState } from './syncRecoveryIntent';

export const DESKTOP_PREFERENCES_BOOTSTRAP_VERSION = 1 as const;

export type DesktopPreferencesBootstrapStatePort = {
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

export type DesktopPreferencesBootstrapResult = {
  status: 'already-complete' | 'completed' | 'pending-recovery';
  operationId: string;
  mutationCount: number;
};

let captureQueue = Promise.resolve();

export function runDesktopPreferencesCaptureExclusive<T>(
  callback: () => Promise<T>,
) {
  const current = captureQueue.catch(() => undefined).then(callback);
  captureQueue = current.then(
    () => undefined,
    () => undefined,
  );
  return current;
}

export async function runDesktopPreferencesBootstrap(input: {
  identity: SyncDevicePublicIdentityV1;
  state: DesktopPreferencesBootstrapStatePort;
  loadSharedPreferences(): Promise<DesktopSharedPreferences>;
  capture(input: {
    operationId: string;
    mutations: PlainMutationV1[];
  }): Promise<void>;
  envelopeFactory: DesktopPreferencesEnvelopeFactory;
  now?: () => number;
}) {
  const stateInput = {
    adapterId: DESKTOP_PREFERENCES_ADAPTER_ID,
    version: DESKTOP_PREFERENCES_BOOTSTRAP_VERSION,
    sourceDeviceId: input.identity.deviceId,
  };
  const operationId = syncBootstrapOperationId(stateInput);
  const state = await input.state.load(stateInput);
  if (state.completed) {
    return {
      status: 'already-complete',
      operationId,
      mutationCount: 0,
    } satisfies DesktopPreferencesBootstrapResult;
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
    } satisfies DesktopPreferencesBootstrapResult;
  }
  if (state.durableIntentState !== null) {
    return {
      status: 'pending-recovery',
      operationId,
      mutationCount: 0,
    } satisfies DesktopPreferencesBootstrapResult;
  }
  const capturedAt = (input.now ?? Date.now)();
  const preferences = await input.loadSharedPreferences();
  const mutations = await deriveDesktopPreferenceMutations({
    previous: [],
    next: projectDesktopPreferences(preferences),
    capturedAt,
    envelopeFactory: input.envelopeFactory,
  });
  if (mutations.length) {
    await input.capture({ operationId, mutations });
  }
  await input.state.markCompleted({
    ...stateInput,
    updatedAt: capturedAt,
  });
  return {
    status: 'completed',
    operationId,
    mutationCount: mutations.length,
  } satisfies DesktopPreferencesBootstrapResult;
}
