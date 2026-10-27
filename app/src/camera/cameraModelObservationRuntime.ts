import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { loadAiConfigPreferencesSnapshot } from '../ai/AiConfigPreferences';
import { canAffordCameraObservation, beginCameraVisionBudgetRequest } from '../ai/aiCallBudget';
import type { AiConnection } from '../ai/types';
import { canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import type { JunLuoToolCall, JunLuoToolResult } from '../tools/toolTypes';
import type { JunLuoToolCandidateSelection } from '../tools/toolCandidateSelector';
import { addCameraObservationCandidate } from './cameraModelObservationCandidate';
import { resolveToolPermissionForCall } from '../tools/toolPermissions';
import { cameraPerceptionNative } from './cameraPerceptionNative';
import { cameraPerceptionRuntime } from './cameraPerceptionRuntime';
import { loadCameraPerceptionSettings } from './cameraPerceptionSettings';
import { getCameraObservationHistorySummary, getCameraObservationRecordByActionId, persistCameraObservation } from './cameraObservationStore';
import { analyzeCameraFrameStructured } from './cameraVisionStructured';
import { shouldOfferCameraModelObservation } from './cameraModelObservationPolicy';
import { executeCameraModelObservation } from './cameraModelObservationExecution';
import { CAMERA_LOOK_ONCE_TOOL_ID, createCameraModelObservationResult } from './cameraModelObservationMaterials';
import { cameraLookOnceTool } from '../tools/builtin/cameraObservationTools';
import { attachCameraObservationResponseContext } from './cameraEvidenceFusion';
import { cameraCaptureConditionFailure } from './cameraRuntimeConditions';
import { getProactiveDeviceControl } from '../proactive/proactiveDeviceControl';
import { readPhoneLocalContactOwner, isPhoneLocalContactOpportunity } from '../proactive/unifiedContactRuntime';
import { readUnifiedContactState } from '../proactive/unifiedContactStore';
import { loadPhonePrimaryActivation } from '../runtime/phonePrimaryRuntime';
import { loadAutomaticRemoteAiPolicy, isAutomaticRemoteAiAllowed } from '../runtime/automaticRemoteAiPolicy';
import { readAndroidRecentDeviceUse } from '../backend/recentDeviceUseNative';

let observationInFlight = false;

function isQuiet(settings: Awaited<ReturnType<typeof loadCameraPerceptionSettings>>, now: number) {
  if (!settings.quietHours.enabled) return false;
  const date = new Date(now);
  const minute = date.getHours() * 60 + date.getMinutes();
  const { startMinuteOfDay: start, endMinuteOfDay: end } = settings.quietHours;
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}

export type CameraModelObservationHost = {
  available(): Promise<boolean>;
  addCandidate(selection: JunLuoToolCandidateSelection): JunLuoToolCandidateSelection;
  execute(call: JunLuoToolCall, signal: AbortSignal): Promise<JunLuoToolResult>;
};

/** Preparation is read-only: in particular, it never starts or upgrades a session. */
export async function prepareCameraModelObservationHost(input: {
  entry: 'chat_reply' | 'proactive_contact';
  sourceMessageId: string;
  sourceSessionId?: string;
  dataEpoch: number;
  responseConnection?: AiConnection;
  signal?: AbortSignal;
  readOnly?: boolean;
}): Promise<CameraModelObservationHost | undefined> {
  if (!cameraPerceptionNative.available || observationInFlight || input.signal?.aborted
    || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
  try {
    const phoneLocal = input.entry === 'proactive_contact' && Platform.OS === 'android' && !!await loadPhonePrimaryActivation();
    const localOwnerInput = { id: input.sourceMessageId, sessionId: input.sourceSessionId, epoch: input.dataEpoch };
    if (input.entry === 'proactive_contact' && Platform.OS === 'android' && !phoneLocal) return;
    const contactControl = input.entry === 'proactive_contact' && !phoneLocal ? getProactiveDeviceControl() : undefined;
    if (input.entry === 'proactive_contact' && (phoneLocal ? !readPhoneLocalContactOwner(localOwnerInput)
      || (await readAndroidRecentDeviceUse()).sampleStatus !== 'ready'
      : !contactControl || !await contactControl.camera(input.sourceMessageId))) return;
    const sharedAnchors = contactControl?.anchors();
    const localNewFrameReady = async () => {
      if (!await loadPhonePrimaryActivation() || !readPhoneLocalContactOwner(localOwnerInput)
        || (await readAndroidRecentDeviceUse()).sampleStatus !== 'ready') return false;
      const [state, policy, settings] = await Promise.all([readUnifiedContactState(),
        loadAutomaticRemoteAiPolicy({ strict: true }),
        import('../proactive/proactiveMessages').then(module => module.loadProactiveMessageSettings({ strict: true }))]);
      const op = state.current;
      return !!op && isPhoneLocalContactOpportunity(op) && op.id === input.sourceMessageId
        && op.sessionId === input.sourceSessionId && op.epoch === input.dataEpoch && op.status === 'requesting'
        && Date.now() < op.expiresAt && settings.enabled && isAutomaticRemoteAiAllowed(policy);
    };
    const [settings, snapshot, permission, toolPermission] = await Promise.all([
      loadCameraPerceptionSettings({ strict: true }), cameraPerceptionNative.getState(), cameraPerceptionNative.getPrerequisites(),
      resolveToolPermissionForCall(cameraLookOnceTool, { input: {} }),
    ]);
    if (toolPermission.permission !== 'allow') return;
    if (snapshot.status !== 'running' || !snapshot.sessionId || !snapshot.automaticObservation.enabled) return;
    const [config, privacy, history] = await Promise.all([
      loadAiConfigPreferencesSnapshot({ maxAgeMs: 0, readOnly: input.readOnly }), cameraPerceptionNative.getTemporaryFramePrivacyState(),
      getCameraObservationHistorySummary(),
    ]);
    if (!config.visionConnection || !config.visionKey.trim()) return;
    const visionConnection = config.visionConnection;
    const responseConnection = input.entry === 'proactive_contact' ? input.responseConnection : undefined;
    const budgetReady = await canAffordCameraObservation({ visionConnection, responseConnection,
      responseRequests: responseConnection ? 2 : 0 });
    const enforceMinimumInterval = input.entry === 'proactive_contact' || settings.chatMinimumIntervalEnabled;
    if (!shouldOfferCameraModelObservation({
      entry: input.entry === 'proactive_contact' ? { kind: 'proactive_contact', contactOpportunityAvailable: true }
        : { kind: 'chat_reply', enforceMinimumInterval },
      now: Date.now(), sessionRunning: true, standbyEnabled: true,
      prerequisitesReady: !cameraCaptureConditionFailure(permission.runtimeConditions, 'model')
        && budgetReady && snapshot.networkAvailable && permission.cameraPermissionGranted
        && permission.notificationPermissionGranted && permission.notificationChannelVisible && privacy.cacheEmpty
        && privacy.lastCleanupState !== 'failed' && privacy.retryingFrameCount === 0 && privacy.orphanFrameCount === 0
        && (!snapshot.cameraResourceOwner || snapshot.cameraResourceOwner === 'observation_preview')
        && (snapshot.cameraState === 'idle' || snapshot.cameraState === 'previewing'),
      quiet: isQuiet(settings, Date.now()), observationInProgress: snapshot.automaticObservation.phase === 'executing' || observationInFlight,
      alreadySelectedInTurn: false, minimumIntervalMinutes: settings.minimumIntervalMinutes,
      lastAttemptAt: Math.max(snapshot.automaticObservation.lastAttemptAt ?? 0, sharedAnchors?.lastAttemptAt ?? 0) || undefined,
      lastSuccessfulObservationAt: Math.max(snapshot.lastSuccessfulObservationAt ?? 0, history.latestCapturedAt ?? 0,
        sharedAnchors?.lastSuccessfulObservationAt ?? 0) || undefined,
    }) || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) return;
    const sessionId = snapshot.sessionId;
    let flight: Promise<JunLuoToolResult> | undefined;
    const failure = (call: JunLuoToolCall) => createCameraModelObservationResult({ callId: call.callId,
      startedAt: Date.now(), finishedAt: Date.now(), status: 'permission_denied' });
    return {
      available: async () => !flight && !!await prepareCameraModelObservationHost(input),
      addCandidate(selection) {
        return addCameraObservationCandidate(selection, { entry: input.entry, dataEpoch: input.dataEpoch, sessionId });
      },
      async execute(call, signal) {
        if (call.toolId !== CAMERA_LOOK_ONCE_TOOL_ID || call.sourceMessageId !== input.sourceMessageId
          || call.requestedBy !== (input.entry === 'chat_reply' ? 'chat' : 'proactive') || Object.keys(call.input).length) return failure(call);
        if (flight) return { ...await flight, callId: call.callId };
        if (observationInFlight) return failure(call);
        observationInFlight = true;
        flight = (async () => {
          const guarded = await runBackupRestoreDataEpochCommit(input.dataEpoch, () => executeCameraModelObservation({
            callId: call.callId, sessionId, scheduleGeneration: snapshot.automaticObservation.scheduleGeneration, signal,
          }, {
            now: Date.now, newRequestId: () => cameraPerceptionNative.newId('camera-tool-frame'),
            isCurrent: () => canCommitBackupRestoreDataEpoch(input.dataEpoch) && !input.signal?.aborted,
            ready: async (requiresNewFrame = true) => {
              const [current, permissions, latestSettings] = await Promise.all([
                cameraPerceptionNative.getState(), cameraPerceptionNative.getPrerequisites(), loadCameraPerceptionSettings({ strict: true }),
              ]);
              return current.status === 'running' && current.sessionId === sessionId && current.automaticObservation.enabled
                && current.networkAvailable && permissions.cameraPermissionGranted && permissions.notificationPermissionGranted
                && permissions.notificationChannelVisible && !isQuiet(latestSettings, Date.now())
                && (!requiresNewFrame || !cameraCaptureConditionFailure(permissions.runtimeConditions, 'model'))
                && (!requiresNewFrame || (phoneLocal ? await localNewFrameReady()
                  : !contactControl || await contactControl.camera(input.sourceMessageId, true,
                    latestSettings.minimumIntervalMinutes * 60_000)));
            },
            snapshot: () => cameraPerceptionNative.getState(),
            subscribe: listener => {
              const subscription = cameraPerceptionNative.subscribeState(listener);
              return () => subscription?.remove();
            },
            claim: attempt => cameraPerceptionNative.requestAutomaticOpportunity({ ...attempt, enforceMinimumInterval }),
            retry: (attempt, nextRequestId) => cameraPerceptionNative.retryAutomaticNow({ ...attempt, nextRequestId }),
            capture: attempt => cameraPerceptionNative.capture(attempt.sessionId, attempt.requestId, attempt.attemptId),
            cancel: attempt => cameraPerceptionNative.cancelCapture(attempt.sessionId, attempt.requestId),
            release: frame => cameraPerceptionRuntime.releaseFrame(frame),
            readFrame: frame => FileSystem.readAsStringAsync(frame.temporaryUri, { encoding: FileSystem.EncodingType.Base64 }),
            analyze: (frame, imageDataUrl, options) => analyzeCameraFrameStructured({
              apiKey: config.visionKey, connection: visionConnection, imageDataUrl, mimeType: 'image/jpeg',
              frame: { sourceKind: frame.sourceKind as 'android_front' | 'android_back', width: frame.width,
                height: frame.height, rotation: frame.rotation, mirrored: frame.mirrored },
              subjectIdentityContext: { status: 'unknown' }, deviceContextFacts: [], ...options,
            }),
            beforeTransport: async (requestId, transportSignal) => {
              if (!await canAffordCameraObservation({ visionConnection, responseConnection, responseRequests: responseConnection ? 1 : 0 })) {
                throw new Error('camera_vision_budget_unavailable');
              }
              await beginCameraVisionBudgetRequest({ connection: visionConnection, dataEpoch: input.dataEpoch, requestId,
                beforeTransport: async () => {
                  if (transportSignal.aborted || signal.aborted || input.signal?.aborted
                    || !canCommitBackupRestoreDataEpoch(input.dataEpoch)) throw new Error('camera_vision_cancelled');
                } });
            },
            persist: (record, observationSignal) => persistCameraObservation(record, { signal: observationSignal,
              canCommit: () => canCommitBackupRestoreDataEpoch(input.dataEpoch),
              ...(input.sourceSessionId ? { responseBinding: { targetSessionId: input.sourceSessionId,
                origin: input.entry === 'chat_reply' ? 'chat_tool' as const : 'proactive_tool' as const,
                sourceTurnId: input.sourceMessageId, requestedAt: call.createdAt } } : {}),
            }),
            findCommitted: getCameraObservationRecordByActionId,
            complete: (attempt, outcome) => cameraPerceptionNative.completeAutomaticAttempt({ ...attempt,
              outcome: outcome.observation ? 'success' : outcome.prerequisiteBlocked ? 'prerequisite_blocked' : 'failure',
              ...(outcome.observation ? { observationId: outcome.observation.observationId, capturedAt: outcome.observation.capturedAt }
                : { failureCode: outcome.failureCode ?? 'camera_observation_failed' }),
            }),
          }));
          return guarded.committed
            ? await attachCameraObservationResponseContext(guarded.value)
            : failure(call);
        })().finally(() => { observationInFlight = false; });
        return flight;
      },
    };
  } catch {
    // Failure to read prerequisites means no camera definition is offered in this request.
    return;
  }
}
