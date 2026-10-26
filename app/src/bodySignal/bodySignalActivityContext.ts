import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type {
  BodySignalActivityTransition,
  BodySignalActivityType,
} from './bodySignalStructuredTypes';

export type BodySignalActivityContextSupport = {
  bootSessionId?: string;
  enabled: boolean;
  fallbackEnabled?: boolean;
  lastNativeActivity?: BodySignalActivityType;
  lastNativeConfidence?: number;
  lastNativeErrorCode?: string;
  lastNativeEventAt?: number;
  lastNativeObservationAt?: number;
  lastNativeTransition?: BodySignalActivityTransition;
  lastNavigationObservedAt?: number;
  lastRegistrationAt?: number;
  lastRegistrationErrorCode?: string;
  lastReceiverAt?: number;
  pendingEventCount?: number;
  navigationEvidenceActive?: boolean;
  navigationEvidenceAvailable?: boolean;
  permissionGranted: boolean;
  reason?: string;
  supported: boolean;
};

export type BodySignalNativeActivityEvent = {
  activity: BodySignalActivityType;
  bootSessionId: string;
  eventId: string;
  observedAt: number;
  transition: BodySignalActivityTransition;
};

type NativeActivityContextModule = {
  acknowledgeActivityContextEvents: (eventIds: string[]) => Promise<boolean>;
  addListener: (eventName: string) => void;
  disableActivityTransitions: () => Promise<boolean>;
  drainActivityContextEvents: () => Promise<BodySignalNativeActivityEvent[]>;
  enableActivityTransitions: () => Promise<boolean>;
  getActivityContextSupport: () => Promise<BodySignalActivityContextSupport>;
  getPendingActivityContextEvents: () => Promise<BodySignalNativeActivityEvent[]>;
  refreshActivityTransitionsIfStale?: () => Promise<boolean>;
  removeListeners: (count: number) => void;
  requestActivityRecognitionPermission: () => Promise<boolean>;
};

const nativeModule = NativeModules.BodySignalActivityContext as NativeActivityContextModule | undefined;
const emitter = nativeModule ? new NativeEventEmitter(nativeModule as any) : undefined;

export async function getActivityContextSupport(): Promise<BodySignalActivityContextSupport> {
  if (Platform.OS !== 'android' || !nativeModule) {
    return { enabled: false, permissionGranted: false, reason: 'unsupported', supported: false };
  }
  return nativeModule.getActivityContextSupport();
}

export async function requestActivityRecognitionPermission(): Promise<boolean> {
  return nativeModule?.requestActivityRecognitionPermission() ?? false;
}

export async function enableActivityTransitions(): Promise<boolean> {
  return nativeModule?.enableActivityTransitions() ?? false;
}

export async function refreshActivityTransitionsIfStale(): Promise<boolean> {
  return nativeModule?.refreshActivityTransitionsIfStale?.() ?? false;
}

export async function disableActivityTransitions(): Promise<boolean> {
  return nativeModule?.disableActivityTransitions() ?? true;
}

export async function drainActivityContextEvents(): Promise<BodySignalNativeActivityEvent[]> {
  return nativeModule?.drainActivityContextEvents() ?? [];
}

export async function getPendingActivityContextEvents(): Promise<BodySignalNativeActivityEvent[]> {
  return nativeModule?.getPendingActivityContextEvents() ?? [];
}

export async function acknowledgeActivityContextEvents(eventIds: readonly string[]): Promise<boolean> {
  if (!eventIds.length) return true;
  return nativeModule?.acknowledgeActivityContextEvents([...eventIds]) ?? true;
}

export function subscribeActivityContext(listener: () => void): () => void {
  if (!emitter) return () => undefined;
  const subscription = emitter.addListener('bodySignalActivityContext', listener);
  return () => subscription.remove();
}
