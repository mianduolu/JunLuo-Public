import { useEffect } from 'react';
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { readAndroidRecentDeviceUse, getAndroidRecentDeviceUseMonotonicTime } from '../backend/recentDeviceUseNative';
import { captureBackupRestoreDataEpoch } from '../backup/backupRestoreCoordinator';
import { loadCurrentSyncRelayEnrollment, createAndroidSyncRelayClient } from '../sync/syncRelayClientExpo';
import { loadGiftExecutionRelayBaseUrl } from '../gifts/giftExecutionRelay';
import { loadAutomaticRemoteAiPolicy, isAutomaticRemoteAiAllowed } from '../runtime/automaticRemoteAiPolicy';
import { cameraPerceptionNative } from '../camera/cameraPerceptionNative';
import { getCameraObservationHistorySummary } from '../camera/cameraObservationStore';
import { readUnifiedContactState } from './unifiedContactStore';
import { createProactiveDeviceUseReporter } from './proactiveDeviceUseReporter';
import { proactiveMigrationUsed } from './proactiveDeviceControl';
import { loadSyncEntityHeadMutations } from '../sync/syncMutationStateStore';
import { ensurePhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';

let reporter: ReturnType<typeof createProactiveDeviceUseReporter> | undefined;

const stopActivatedReporter = async () => {
  if (!await ensurePhonePrimaryActivation()) return false;
  reporter?.stop(); reporter = undefined;
  return true;
};

/** App and its existing Headless entry share this reader; no new Android service or permission request. */
export async function ensureAndroidProactiveDeviceControl() {
  if (Platform.OS !== 'android') return;
  if (await stopActivatedReporter()) return;
  if (!reporter) {
    reporter = createProactiveDeviceUseReporter({
      identity: async () => {
        const enrollment = await loadCurrentSyncRelayEnrollment();
        if (!enrollment) return null;
        const identity = enrollment.publicIdentity;
        return { deviceId: identity.deviceId, platform: 'android',
          scope: `${identity.vaultId}:${identity.keyId}:${identity.deviceId}` };
      },
      newRuntimeEpoch: Crypto.randomUUID,
      dataEpoch: captureBackupRestoreDataEpoch,
      sample: readAndroidRecentDeviceUse,
      monotonicNow: getAndroidRecentDeviceUseMonotonicTime,
      // Reuse the old reporter wakeup only while the one-time real ledger handoff is pending.
      onState: () => { void stopActivatedReporter(); },
      post: async (action, body) => {
        const enrollment = await loadCurrentSyncRelayEnrollment();
        const baseUrl = await loadGiftExecutionRelayBaseUrl();
        if (!enrollment || !baseUrl) throw Error('proactive-control-not-paired');
        return createAndroidSyncRelayClient({ baseUrl, timeoutMs: 5000 }).proactiveControl(enrollment, action, body);
      },
      localState: async serverDay => {
        const [local, policy, settings, camera, history, heads] = await Promise.all([
          readUnifiedContactState(), loadAutomaticRemoteAiPolicy({ strict: true }),
          import('./proactiveMessages').then(module => module.loadProactiveMessageSettings({ strict: true })),
          cameraPerceptionNative.available ? cameraPerceptionNative.getState() : null,
          getCameraObservationHistorySummary(),
          loadSyncEntityHeadMutations({ domain: 'life', type: 'assistant-state', id: 'current' }),
        ]);
        return { enabled: settings.enabled && isAutomaticRemoteAiAllowed(policy),
          standby: camera?.status === 'running' && camera.automaticObservation.enabled === true,
          migration: { day: serverDay, used: proactiveMigrationUsed(serverDay, [local, ...heads
            .filter(head => head.revision.operation !== 'delete').map(head => {
              const payload = head.payload;
              if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
              const value = payload.value;
              return value && typeof value === 'object' && !Array.isArray(value) ? value.unifiedContact : undefined;
            })]),
            legacyCurrentActive: !!local.current && local.current.status !== 'finished', lastEndedAt: local.lastEndedAt,
            lastOrdinaryReplyAt: local.lastOrdinaryReplyAt, motiveLastSelectedAt: local.motiveLastSelectedAt ?? {},
            lastCameraAttemptAt: camera?.automaticObservation.lastAttemptAt ?? 0,
            lastSuccessfulObservationAt: Math.max(camera?.lastSuccessfulObservationAt ?? 0, history.latestCapturedAt ?? 0) } };
      },
    });
    reporter.start();
  }
  await reporter.check();
}

export function useProactiveDeviceControl(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    void ensureAndroidProactiveDeviceControl();
    return () => { reporter?.stop(); reporter = undefined; };
  }, [enabled]);
}
