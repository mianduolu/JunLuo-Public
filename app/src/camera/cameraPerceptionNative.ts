import * as Crypto from 'expo-crypto';
import { NativeEventEmitter, NativeModules, Platform, type EmitterSubscription } from 'react-native';
import { parseCameraRuntimeConditions, type CameraRuntimeConditions } from './cameraRuntimeConditions';

import type {
  CameraCaptureSuccessReceipt,
  CameraFramePrivacyState,
  CameraFrameReleaseReceipt,
  CameraManualSaveDestination,
  CameraManualSaveReceipt,
  CameraSensitiveBackupPolicy,
  CameraSourceKind,
} from './cameraPerceptionTypes';

export const CAMERA_NATIVE_MODULE_UNAVAILABLE = 'camera_native_module_unavailable';
export const CAMERA_INVALID_BRIDGE_PAYLOAD = 'camera_invalid_bridge_payload';
export const CAMERA_MODEL_OBSERVATION_MODE = 'model_choice_v1' as const;

const SESSION_STATUSES = new Set([
  'stopped',
  'starting',
  'running',
  'paused_camera_busy',
  'stopping',
  'error',
]);
const CAMERA_STATES = new Set(['idle', 'opening', 'capturing', 'previewing']);
const RESOURCE_OWNERS = new Set(['observation_capture', 'observation_preview', 'manual_camera', 'video_call_camera']);
const SOURCE_KINDS = new Set(['android_front', 'android_back']);
const CLEANUP_STATES = new Set(['none', 'deleting', 'retrying', 'verified_deleted', 'failed']);
const AUTOMATIC_PHASES = new Set([
  'inactive',
  'waiting_minimum',
  'opportunity_open',
  'deadline_due',
  'quiet_paused',
  'prerequisite_blocked',
  'executing',
  'retry_waiting',
  'degraded',
]);
const AUTOMATIC_TRIGGER_KINDS = new Set([
  'action_opportunity',
  'max_interval_deadline',
  'retry_after_failure',
]);

type NativeCameraModule = {
  getAndroidCameraAvailability(facing: string): Promise<unknown>;
  getObservationPrerequisites(): Promise<unknown>;
  getObservationSessionState(): Promise<unknown>;
  startObservationSession(request: object): Promise<unknown>;
  stopObservationSession(request: object): Promise<unknown>;
  switchObservationFacing(request: object): Promise<unknown>;
  captureObservationFrame(request: object): Promise<unknown>;
  cancelObservationCapture(request: object): Promise<unknown>;
  releaseObservationFrame(request: object): Promise<unknown>;
  getTemporaryFramePrivacyState(): Promise<unknown>;
  verifyTemporaryFrameCleanup(request: object): Promise<unknown>;
  awaitObservationFrameDeletion(request: object): Promise<unknown>;
  getSensitiveCameraBackupPolicy(): Promise<unknown>;
  setSensitiveCameraBackupPolicy(request: object): Promise<unknown>;
  runTemporaryFramePrivacyDebugSelfTest(request: object): Promise<unknown>;
  getManualSaveDestination(): Promise<unknown>;
  openManualSaveDestinationPicker(request: object): Promise<unknown>;
  setManualSaveDestination(request: object): Promise<unknown>;
  clearManualSaveDestination(request: object): Promise<unknown>;
  saveObservationFrameToDestination(request: object): Promise<unknown>;
  acquireCameraResource(request: object): Promise<unknown>;
  releaseCameraResource(request: object): Promise<unknown>;
  updateAutomaticObservationPolicy(request: object): Promise<unknown>;
  requestAutomaticObservationOpportunity(request: object): Promise<unknown>;
  completeAutomaticObservationAttempt(request: object): Promise<unknown>;
  retryAutomaticObservationNow(request: object): Promise<unknown>;
  runAutomaticObservationDebugCommand(request: object): Promise<unknown>;
  openObservationNotificationSettings(): Promise<unknown>;
  addListener(eventName: string): void;
  removeListeners(count: number): void;
};

export type NativeCameraSessionSnapshot = {
  schemaVersion: 6;
  modelObservationMode: typeof CAMERA_MODEL_OBSERVATION_MODE;
  networkAvailable: boolean;
  revision: number;
  status: 'stopped' | 'starting' | 'running' | 'paused_camera_busy' | 'stopping' | 'error';
  sessionId?: string;
  lastSessionId?: string;
  sourceKind?: Extract<CameraSourceKind, 'android_front' | 'android_back'>;
  startedAt?: number;
  lastHeartbeatAt?: number;
  lastSuccessfulObservationAt?: number;
  cameraReady: boolean;
  cameraState: 'idle' | 'opening' | 'capturing' | 'previewing';
  activeCaptureRequestId?: string;
  persistentNotificationVisible: boolean;
  lastFailureCode?: string;
  stopReasonCode?: string;
  cameraResourceOwner?: 'observation_capture' | 'observation_preview' | 'manual_camera' | 'video_call_camera';
  cameraResourceLeaseId?: string;
  cameraResourcePausedAt?: number;
  automaticObservation: NativeAutomaticObservationState;
};

export type NativeAutomaticObservationPhase =
  | 'inactive'
  | 'waiting_minimum'
  | 'opportunity_open'
  | 'deadline_due'
  | 'quiet_paused'
  | 'prerequisite_blocked'
  | 'executing'
  | 'retry_waiting'
  | 'degraded';

export type NativeAutomaticObservationTriggerKind =
  | 'action_opportunity'
  | 'max_interval_deadline'
  | 'retry_after_failure';

export type NativeAutomaticObservationState = {
  enabled: boolean;
  phase: NativeAutomaticObservationPhase;
  scheduleGeneration: number;
  anchorAt?: number;
  nextOpportunityAt?: number;
  hardDeadlineAt?: number;
  resumeAt?: number;
  activeAttemptId?: string;
  activeRequestId?: string;
  activeTriggerKind?: NativeAutomaticObservationTriggerKind;
  activeRetryUsed: boolean;
  consecutiveFailureCount: number;
  nextRetryAt?: number;
  lastAttemptAt?: number;
  lastAttemptTriggerKind?: NativeAutomaticObservationTriggerKind;
  lastFailureCode?: string;
  overdueByMs: number;
};

export type NativeCameraPrerequisites = {
  cameraPermissionGranted: boolean;
  notificationPermissionGranted: boolean;
  notificationChannelVisible: boolean;
  activityResumed: boolean;
  runtimeConditions?: CameraRuntimeConditions;
};

export type NativeCameraCommandReceipt = {
  ok: boolean;
  failureCode?: string;
  sessionId?: string;
  status?: string;
  revision?: number;
  leaseId?: string;
  owner?: 'manual_camera' | 'video_call_camera';
  alreadyReleased?: boolean;
  cleanupState?: string;
  deletionVerified?: boolean;
  alreadyDeleted?: boolean;
  auditPersisted?: boolean;
  configured?: boolean;
  available?: boolean;
  directoryDisplayName?: string;
  selectedAt?: number;
  consentGranted?: boolean;
  updatedAt?: number;
};

export type NativeCameraCaptureReceipt = CameraCaptureSuccessReceipt | {
  schemaVersion: 1;
  captureSucceeded: false;
  sessionId: string;
  requestId: string;
  captureGeneration: number;
  sourceKind: Extract<CameraSourceKind, 'android_front' | 'android_back'>;
  failedAt: number;
  failureCode: string;
};

const nativeModule = Platform.OS === 'android'
  ? NativeModules.JunLuoCameraPerception as NativeCameraModule | undefined
  : undefined;
const nativeEmitter = nativeModule ? new NativeEventEmitter(nativeModule as never) : undefined;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
  return value as Record<string, unknown>;
}

function string(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function number(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function boolean(value: unknown) {
  return typeof value === 'boolean' ? value : undefined;
}

function requireModule(): NativeCameraModule {
  if (!nativeModule) throw new Error(CAMERA_NATIVE_MODULE_UNAVAILABLE);
  return nativeModule;
}

function parseCommandReceipt(value: unknown): NativeCameraCommandReceipt {
  const raw = record(value);
  const ok = boolean(raw.ok);
  if (ok === undefined) throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
  const owner = string(raw.owner);
  return {
    ok,
    failureCode: string(raw.failureCode),
    sessionId: string(raw.sessionId),
    status: string(raw.status),
    revision: number(raw.revision),
    leaseId: string(raw.leaseId),
    owner: owner === 'manual_camera' || owner === 'video_call_camera' ? owner : undefined,
    alreadyReleased: boolean(raw.alreadyReleased),
    cleanupState: string(raw.cleanupState),
    deletionVerified: boolean(raw.deletionVerified),
    alreadyDeleted: boolean(raw.alreadyDeleted),
    auditPersisted: boolean(raw.auditPersisted),
    configured: boolean(raw.configured),
    available: boolean(raw.available),
    directoryDisplayName: string(raw.directoryDisplayName),
    selectedAt: number(raw.selectedAt),
    consentGranted: boolean(raw.consentGranted),
    updatedAt: number(raw.updatedAt),
  };
}

function parseManualSaveDestination(value: unknown): CameraManualSaveDestination {
  const raw = record(value);
  if (boolean(raw.ok) !== true || boolean(raw.configured) === undefined || boolean(raw.available) === undefined) {
    throw new Error(string(raw.failureCode) ?? CAMERA_INVALID_BRIDGE_PAYLOAD);
  }
  return {
    configured: raw.configured as boolean,
    available: raw.available as boolean,
    directoryDisplayName: string(raw.directoryDisplayName),
    selectedAt: number(raw.selectedAt),
  };
}

function parseFrameReleaseReceipt(value: unknown): CameraFrameReleaseReceipt {
  const raw = record(value);
  const cleanupState = string(raw.cleanupState);
  const ok = boolean(raw.ok);
  if (ok === undefined || !cleanupState || !['verified_deleted', 'retrying', 'failed'].includes(cleanupState)) {
    throw new Error(string(raw.failureCode) ?? CAMERA_INVALID_BRIDGE_PAYLOAD);
  }
  return {
    success: ok,
    cleanupState: cleanupState as CameraFrameReleaseReceipt['cleanupState'],
    deletionVerified: boolean(raw.deletionVerified) ?? false,
    alreadyDeleted: boolean(raw.alreadyDeleted) ?? false,
    auditPersisted: boolean(raw.auditPersisted) ?? false,
    failureCode: string(raw.failureCode),
  };
}

function parseFramePrivacyState(value: unknown): CameraFramePrivacyState {
  const raw = record(value);
  const cleanupState = string(raw.lastCleanupState);
  if (
    boolean(raw.ok) !== true || number(raw.schemaVersion) !== 1
    || !cleanupState || !CLEANUP_STATES.has(cleanupState)
  ) throw new Error(string(raw.failureCode) ?? CAMERA_INVALID_BRIDGE_PAYLOAD);
  const proofRaw = raw.latestProof ? record(raw.latestProof) : undefined;
  const proof = proofRaw ? {
    proofId: string(proofRaw.proofId) ?? '',
    completedAt: number(proofRaw.completedAt) ?? 0,
    trigger: string(proofRaw.trigger) ?? '',
    byteLength: number(proofRaw.byteLength),
    sha256Prefix: string(proofRaw.sha256Prefix),
    attemptCount: number(proofRaw.attemptCount) ?? 0,
    deletionVerified: boolean(proofRaw.deletionVerified) ?? false,
    orphanRecovered: boolean(proofRaw.orphanRecovered) ?? false,
  } : undefined;
  return {
    schemaVersion: 1,
    activeFrameCount: number(raw.activeFrameCount) ?? 0,
    retryingFrameCount: number(raw.retryingFrameCount) ?? 0,
    orphanFrameCount: number(raw.orphanFrameCount) ?? 0,
    cacheEmpty: boolean(raw.cacheEmpty) ?? false,
    lastCleanupAt: number(raw.lastCleanupAt),
    lastCleanupState: cleanupState as CameraFramePrivacyState['lastCleanupState'],
    lastCleanupTrigger: string(raw.lastCleanupTrigger),
    startupOrphansDeleted: number(raw.startupOrphansDeleted) ?? 0,
    auditAvailable: boolean(raw.auditAvailable) ?? false,
    latestProof: proof?.proofId && proof.completedAt && proof.trigger ? proof : undefined,
  };
}

function parseSensitiveBackupPolicy(value: unknown): CameraSensitiveBackupPolicy {
  const raw = record(value);
  if (boolean(raw.ok) !== true || number(raw.schemaVersion) !== 1 || boolean(raw.consentGranted) === undefined) {
    throw new Error(string(raw.failureCode) ?? CAMERA_INVALID_BRIDGE_PAYLOAD);
  }
  return {
    schemaVersion: 1,
    consentGranted: raw.consentGranted as boolean,
    updatedAt: number(raw.updatedAt),
  };
}

function parseManualSaveReceipt(value: unknown): CameraManualSaveReceipt {
  const raw = record(value);
  if (boolean(raw.ok) !== true) throw new Error(string(raw.failureCode) ?? CAMERA_INVALID_BRIDGE_PAYLOAD);
  const sourceKind = string(raw.sourceKind);
  const rotation = number(raw.rotation);
  const cleanup = string(raw.sourceFrameCleanup);
  const consentSource = string(raw.consentSource);
  const longTermStorage = string(raw.longTermStorage);
  const requiredStrings = {
    actionId: string(raw.actionId),
    sessionId: string(raw.sessionId),
    requestId: string(raw.requestId),
    fileName: string(raw.fileName),
    directoryDisplayName: string(raw.directoryDisplayName),
    sha256: string(raw.sha256),
  };
  if (
    Object.values(requiredStrings).some((item) => !item)
    || !sourceKind || !SOURCE_KINDS.has(sourceKind)
    || ![0, 90, 180, 270].includes(rotation ?? -1)
    || (cleanup !== 'released' && cleanup !== 'retrying')
    || string(raw.mimeType) !== 'image/jpeg'
    || boolean(raw.destinationVerified) !== true
    || consentSource !== 'explicit_manual_save_confirmation'
    || longTermStorage !== 'user_selected_saf_directory'
  ) throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
  return {
    actionId: requiredStrings.actionId!,
    sessionId: requiredStrings.sessionId!,
    requestId: requiredStrings.requestId!,
    sourceKind: sourceKind as 'android_front' | 'android_back',
    capturedAt: number(raw.capturedAt) ?? 0,
    savedAt: number(raw.savedAt) ?? 0,
    fileName: requiredStrings.fileName!,
    directoryDisplayName: requiredStrings.directoryDisplayName!,
    mimeType: 'image/jpeg',
    width: number(raw.width) ?? 0,
    height: number(raw.height) ?? 0,
    rotation: rotation as 0 | 90 | 180 | 270,
    mirrored: boolean(raw.mirrored) ?? false,
    byteLength: number(raw.byteLength) ?? 0,
    sha256: requiredStrings.sha256!,
    destinationVerified: true,
    sourceFrameCleanup: cleanup,
    consentSource: 'explicit_manual_save_confirmation',
    longTermStorage: 'user_selected_saf_directory',
  };
}

export function parseNativeCameraSessionSnapshot(value: unknown): NativeCameraSessionSnapshot {
  const raw = record(value);
  const status = string(raw.status);
  const cameraState = string(raw.cameraState);
  const revision = number(raw.revision);
  const owner = string(raw.cameraResourceOwner);
  const sourceKind = string(raw.sourceKind);
  const automaticRaw = record(raw.automaticObservation);
  const automaticPhase = string(automaticRaw.phase);
  const activeTriggerKind = string(automaticRaw.activeTriggerKind);
  const lastAttemptTriggerKind = string(automaticRaw.lastAttemptTriggerKind);
  if (
    number(raw.schemaVersion) !== 6
    || raw.modelObservationMode !== CAMERA_MODEL_OBSERVATION_MODE
    || boolean(raw.networkAvailable) === undefined
    || revision === undefined
    || !Number.isSafeInteger(revision) || revision < 0
    || !status
    || !SESSION_STATUSES.has(status)
    || !cameraState
    || !CAMERA_STATES.has(cameraState)
    || boolean(raw.cameraReady) === undefined
    || boolean(raw.persistentNotificationVisible) === undefined
    || boolean(automaticRaw.enabled) === undefined
    || boolean(automaticRaw.activeRetryUsed) === undefined
    || !automaticPhase
    || !AUTOMATIC_PHASES.has(automaticPhase)
    || number(automaticRaw.scheduleGeneration) === undefined
    || !Number.isSafeInteger(automaticRaw.scheduleGeneration) || (automaticRaw.scheduleGeneration as number) < 0
    || number(automaticRaw.consecutiveFailureCount) === undefined
    || !Number.isSafeInteger(automaticRaw.consecutiveFailureCount) || (automaticRaw.consecutiveFailureCount as number) < 0
    || number(automaticRaw.overdueByMs) === undefined
    || (automaticRaw.overdueByMs as number) < 0
    || (activeTriggerKind !== undefined && !AUTOMATIC_TRIGGER_KINDS.has(activeTriggerKind))
    || (lastAttemptTriggerKind !== undefined && !AUTOMATIC_TRIGGER_KINDS.has(lastAttemptTriggerKind))
  ) throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
  return {
    schemaVersion: 6,
    modelObservationMode: CAMERA_MODEL_OBSERVATION_MODE,
    networkAvailable: raw.networkAvailable as boolean,
    revision,
    status: status as NativeCameraSessionSnapshot['status'],
    sessionId: string(raw.sessionId),
    lastSessionId: string(raw.lastSessionId),
    sourceKind: sourceKind && SOURCE_KINDS.has(sourceKind) ? sourceKind as NativeCameraSessionSnapshot['sourceKind'] : undefined,
    startedAt: number(raw.startedAt),
    lastHeartbeatAt: number(raw.lastHeartbeatAt),
    lastSuccessfulObservationAt: number(raw.lastSuccessfulObservationAt),
    cameraReady: raw.cameraReady as boolean,
    cameraState: cameraState as NativeCameraSessionSnapshot['cameraState'],
    activeCaptureRequestId: string(raw.activeCaptureRequestId),
    persistentNotificationVisible: raw.persistentNotificationVisible as boolean,
    lastFailureCode: string(raw.lastFailureCode),
    stopReasonCode: string(raw.stopReasonCode),
    cameraResourceOwner: owner && RESOURCE_OWNERS.has(owner) ? owner as NativeCameraSessionSnapshot['cameraResourceOwner'] : undefined,
    cameraResourceLeaseId: string(raw.cameraResourceLeaseId),
    cameraResourcePausedAt: number(raw.cameraResourcePausedAt),
    automaticObservation: {
      enabled: automaticRaw.enabled as boolean,
      phase: automaticPhase as NativeAutomaticObservationPhase,
      scheduleGeneration: number(automaticRaw.scheduleGeneration)!,
      anchorAt: number(automaticRaw.anchorAt),
      nextOpportunityAt: number(automaticRaw.nextOpportunityAt),
      hardDeadlineAt: number(automaticRaw.hardDeadlineAt),
      resumeAt: number(automaticRaw.resumeAt),
      activeAttemptId: string(automaticRaw.activeAttemptId),
      activeRequestId: string(automaticRaw.activeRequestId),
      activeTriggerKind: activeTriggerKind as NativeAutomaticObservationTriggerKind | undefined,
      activeRetryUsed: automaticRaw.activeRetryUsed as boolean,
      consecutiveFailureCount: number(automaticRaw.consecutiveFailureCount)!,
      nextRetryAt: number(automaticRaw.nextRetryAt),
      lastAttemptAt: number(automaticRaw.lastAttemptAt),
      lastAttemptTriggerKind: lastAttemptTriggerKind as NativeAutomaticObservationTriggerKind | undefined,
      lastFailureCode: string(automaticRaw.lastFailureCode),
      overdueByMs: number(automaticRaw.overdueByMs)!,
    },
  };
}

export function parseNativeCameraCaptureReceipt(value: unknown): NativeCameraCaptureReceipt {
  const raw = record(value);
  const sessionId = string(raw.sessionId);
  const requestId = string(raw.requestId);
  const captureGeneration = number(raw.captureGeneration);
  const ok = boolean(raw.ok);
  if (!sessionId || !requestId || captureGeneration === undefined || ok === undefined) {
    throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
  }
  if (!ok) {
    return {
      schemaVersion: 1,
      captureSucceeded: false,
      sessionId,
      requestId,
      captureGeneration,
      sourceKind: 'android_front',
      failedAt: Date.now(),
      failureCode: string(raw.failureCode) ?? CAMERA_INVALID_BRIDGE_PAYLOAD,
    };
  }
  const sourceKind = string(raw.sourceKind);
  const rotation = number(raw.rotation);
  const requiredStrings = [
    string(raw.temporaryUri),
    string(raw.temporaryFrameId),
    string(raw.releaseToken),
    string(raw.sha256),
  ];
  if (
    !sourceKind || !SOURCE_KINDS.has(sourceKind)
    || ![0, 90, 180, 270].includes(rotation ?? -1)
    || requiredStrings.some((item) => !item)
  ) throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
  return {
    schemaVersion: 1,
    captureSucceeded: true,
    sessionId,
    requestId,
    sourceKind: sourceKind as 'android_front' | 'android_back',
    captureGeneration,
    revision: number(raw.revision) ?? 0,
    capturedAt: number(raw.capturedAt) ?? 0,
    temporaryUri: requiredStrings[0]!,
    temporaryFrameId: requiredStrings[1]!,
    releaseToken: requiredStrings[2]!,
    width: number(raw.width) ?? 0,
    height: number(raw.height) ?? 0,
    rotation: rotation as 0 | 90 | 180 | 270,
    mirrored: boolean(raw.mirrored) ?? false,
    sha256: requiredStrings[3]!,
    byteLength: number(raw.byteLength) ?? 0,
  };
}

export const cameraPerceptionNative = {
  available: Boolean(nativeModule),
  newId(prefix: string) {
    return `${prefix}-${Crypto.randomUUID()}`;
  },
  async getAvailability(facing: 'front' | 'back') {
    return record(await requireModule().getAndroidCameraAvailability(facing));
  },
  async getPrerequisites(): Promise<NativeCameraPrerequisites> {
    const raw = record(await requireModule().getObservationPrerequisites());
    const result = {
      cameraPermissionGranted: boolean(raw.cameraPermissionGranted),
      notificationPermissionGranted: boolean(raw.notificationPermissionGranted),
      notificationChannelVisible: boolean(raw.notificationChannelVisible),
      activityResumed: boolean(raw.activityResumed),
    };
    if (Object.values(result).some((item) => item === undefined)) throw new Error(CAMERA_INVALID_BRIDGE_PAYLOAD);
    return { ...result as NativeCameraPrerequisites, runtimeConditions: parseCameraRuntimeConditions(raw.runtimeConditions) };
  },
  async getState() {
    return parseNativeCameraSessionSnapshot(await requireModule().getObservationSessionState());
  },
  async start(sessionId: string, facing: 'front' | 'back') {
    return parseCommandReceipt(await requireModule().startObservationSession({
      commandId: this.newId('camera-start'),
      requestedAt: Date.now(),
      sessionId,
      facing,
    }));
  },
  async stop(sessionId: string, reasonCode = 'user_stop') {
    return parseCommandReceipt(await requireModule().stopObservationSession({
      commandId: this.newId('camera-stop'),
      requestedAt: Date.now(),
      sessionId,
      reasonCode,
    }));
  },
  async switchFacing(sessionId: string, facing: 'front' | 'back') {
    return parseCommandReceipt(await requireModule().switchObservationFacing({
      commandId: this.newId('camera-facing'),
      requestedAt: Date.now(),
      sessionId,
      facing,
    }));
  },
  async capture(sessionId: string, requestId: string, automaticAttemptId?: string) {
    const value = await requireModule().captureObservationFrame({
      commandId: this.newId('camera-capture'),
      requestedAt: Date.now(),
      sessionId,
      requestId,
      automaticAttemptId,
    });
    const raw = record(value);
    // Native may reject before issuing a capture receipt; preserve only these health prerequisites.
    if (raw.ok === false && raw.captureGeneration === undefined
      && (raw.failureCode === 'camera_low_battery' || raw.failureCode === 'camera_thermal_paused')) {
      throw new Error(raw.failureCode);
    }
    return parseNativeCameraCaptureReceipt(value);
  },
  async cancelCapture(sessionId: string, requestId: string) {
    return parseCommandReceipt(await requireModule().cancelObservationCapture({
      commandId: this.newId('camera-cancel'),
      requestedAt: Date.now(),
      sessionId,
      requestId,
    }));
  },
  async releaseFrame(temporaryFrameId: string, releaseToken: string) {
    return parseFrameReleaseReceipt(await requireModule().releaseObservationFrame({ temporaryFrameId, releaseToken }));
  },
  async awaitFrameDeletion(temporaryFrameId: string, releaseToken: string) {
    return parseFrameReleaseReceipt(await requireModule().awaitObservationFrameDeletion({
      temporaryFrameId,
      releaseToken,
    }));
  },
  async getTemporaryFramePrivacyState() {
    return parseFramePrivacyState(await requireModule().getTemporaryFramePrivacyState());
  },
  async verifyTemporaryFrameCleanup() {
    const receipt = parseCommandReceipt(await requireModule().verifyTemporaryFrameCleanup({
      commandId: this.newId('camera-privacy-verify'),
      requestedAt: Date.now(),
    }));
    if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_frame_privacy_state_unavailable');
    return this.getTemporaryFramePrivacyState();
  },
  async getSensitiveBackupPolicy() {
    return parseSensitiveBackupPolicy(await requireModule().getSensitiveCameraBackupPolicy());
  },
  async setSensitiveBackupPolicy(consentGranted: boolean) {
    const receipt = parseCommandReceipt(await requireModule().setSensitiveCameraBackupPolicy({
      commandId: this.newId('camera-sensitive-backup'),
      requestedAt: Date.now(),
      consentGranted,
    }));
    if (!receipt.ok) throw new Error(receipt.failureCode ?? 'camera_sensitive_backup_policy_persist_failed');
    return this.getSensitiveBackupPolicy();
  },
  async runPrivacyDebugSelfTest(mode: 'delete_now' | 'fail_once' | 'fail_all' | 'create_orphan' | 'watchdog') {
    return parseCommandReceipt(await requireModule().runTemporaryFramePrivacyDebugSelfTest({
      commandId: this.newId('camera-privacy-debug'),
      requestedAt: Date.now(),
      mode,
    }));
  },
  async getManualSaveDestination() {
    return parseManualSaveDestination(await requireModule().getManualSaveDestination());
  },
  async openManualSaveDestinationPicker() {
    return parseCommandReceipt(await requireModule().openManualSaveDestinationPicker({
      commandId: this.newId('camera-save-destination-picker'),
      requestedAt: Date.now(),
    }));
  },
  async setManualSaveDestination(directoryUri: string) {
    return parseManualSaveDestination(await requireModule().setManualSaveDestination({
      commandId: this.newId('camera-save-destination'),
      requestedAt: Date.now(),
      directoryUri,
    }));
  },
  async clearManualSaveDestination() {
    return parseManualSaveDestination(await requireModule().clearManualSaveDestination({
      commandId: this.newId('camera-clear-destination'),
      requestedAt: Date.now(),
    }));
  },
  async saveFrameToDestination({
    actionId,
    commandId,
    fileName,
    receipt,
  }: {
    actionId: string;
    commandId: string;
    fileName: string;
    receipt: CameraCaptureSuccessReceipt;
  }) {
    return parseManualSaveReceipt(await requireModule().saveObservationFrameToDestination({
      commandId,
      requestedAt: Date.now(),
      actionId,
      sessionId: receipt.sessionId,
      requestId: receipt.requestId,
      temporaryFrameId: receipt.temporaryFrameId,
      releaseToken: receipt.releaseToken,
      fileName,
    }));
  },
  async acquireResource(owner: 'manual_camera' | 'video_call_camera') {
    return parseCommandReceipt(await requireModule().acquireCameraResource({
      commandId: this.newId('camera-acquire'),
      requestedAt: Date.now(),
      owner,
    }));
  },
  async releaseResource(owner: 'manual_camera' | 'video_call_camera', leaseId: string) {
    return parseCommandReceipt(await requireModule().releaseCameraResource({
      commandId: this.newId('camera-release'),
      requestedAt: Date.now(),
      owner,
      leaseId,
    }));
  },
  async updateAutomaticPolicy(input: {
    sessionId?: string;
    enabled: boolean;
    minimumIntervalMinutes: number;
    maximumIntervalMinutes: number;
    quietHours: { enabled: boolean; startMinuteOfDay: number; endMinuteOfDay: number };
    latestSuccessfulObservationAt?: number;
  }) {
    return parseCommandReceipt(await requireModule().updateAutomaticObservationPolicy({
      commandId: this.newId('camera-auto-policy'),
      requestedAt: Date.now(),
      ...input,
    }));
  },
  async requestAutomaticOpportunity(input: {
    sessionId: string;
    scheduleGeneration: number;
    attemptId: string;
    requestId: string;
    enforceMinimumInterval: boolean;
    commandId?: string;
    requestedAt?: number;
  }) {
    return parseCommandReceipt(await requireModule().requestAutomaticObservationOpportunity({
      triggerKind: 'action_opportunity',
      ...input,
      commandId: input.commandId ?? this.newId('camera-auto-opportunity'),
      requestedAt: input.requestedAt ?? Date.now(),
    }));
  },
  async completeAutomaticAttempt(input: {
    sessionId: string;
    attemptId: string;
    requestId: string;
    scheduleGeneration: number;
    outcome: 'success' | 'prerequisite_blocked' | 'failure';
    failureCode?: string;
    observationId?: string;
    capturedAt?: number;
    commandId?: string;
    requestedAt?: number;
  }) {
    return parseCommandReceipt(await requireModule().completeAutomaticObservationAttempt({
      ...input,
      commandId: input.commandId ?? this.newId('camera-auto-complete'),
      requestedAt: input.requestedAt ?? Date.now(),
    }));
  },
  async retryAutomaticNow(input: {
    sessionId: string;
    scheduleGeneration: number;
    attemptId: string;
    requestId: string;
    nextRequestId?: string;
    commandId?: string;
    requestedAt?: number;
  }) {
    return parseCommandReceipt(await requireModule().retryAutomaticObservationNow({
      ...input,
      commandId: input.commandId ?? this.newId('camera-auto-retry'),
      requestedAt: input.requestedAt ?? Date.now(),
    }));
  },
  async runAutomaticDebugCommand(mode: string, value?: number) {
    return parseCommandReceipt(await requireModule().runAutomaticObservationDebugCommand({
      commandId: this.newId('camera-auto-debug'),
      requestedAt: Date.now(),
      mode,
      value,
    }));
  },
  async setRuntimeConditionsDebug(input: {
    clear?: boolean;
    batteryPercent?: number | null;
    charging?: boolean | null;
    thermalStatus?: number | null;
  }) {
    return parseCommandReceipt(await requireModule().runAutomaticObservationDebugCommand({
      commandId: this.newId('camera-runtime-debug'), requestedAt: Date.now(), mode: 'runtime_conditions', ...input,
    }));
  },
  async openNotificationSettings() {
    return parseCommandReceipt(await requireModule().openObservationNotificationSettings());
  },
  subscribeState(listener: (snapshot: NativeCameraSessionSnapshot) => void): EmitterSubscription | undefined {
    return nativeEmitter?.addListener('onCameraSessionStateChanged', (value) => listener(parseNativeCameraSessionSnapshot(value)));
  },
  subscribeCapture(listener: (receipt: NativeCameraCaptureReceipt) => void): EmitterSubscription | undefined {
    return nativeEmitter?.addListener('onCameraCaptureReceipt', (value) => listener(parseNativeCameraCaptureReceipt(value)));
  },
  subscribeHeartbeat(listener: (value: { revision: number; sessionId?: string; lastHeartbeatAt?: number }) => void): EmitterSubscription | undefined {
    return nativeEmitter?.addListener('onCameraServiceHeartbeat', (value) => {
      const raw = record(value);
      listener({
        revision: number(raw.revision) ?? 0,
        sessionId: string(raw.sessionId),
        lastHeartbeatAt: number(raw.lastHeartbeatAt),
      });
    });
  },
  subscribePrivacy(listener: (state: CameraFramePrivacyState) => void): EmitterSubscription | undefined {
    return nativeEmitter?.addListener('onCameraFramePrivacyStateChanged', (value) => {
      listener(parseFramePrivacyState(value));
    });
  },
};
