import { NativeEventEmitter, NativeModules, Platform } from 'react-native';

import type { BodySignalCompanionPresenceEvent } from './device/bodySignalCompanionTypes';

export type BodySignalCompanionSupport = {
  reason?: 'android_api_below_33' | 'api_36_legacy_compat';
  supported: boolean;
};

export type BodySignalNativeCompanionAssociation = {
  associationId: number;
  deviceProfileId: string;
  observationEnabled: boolean;
  status: 'active';
};

type BodySignalCompanionNativeModule = {
  addListener(eventName: string): void;
  beginPrimaryDeviceAssociation(
    deviceProfileId: string,
    deviceAddress: string,
  ): Promise<BodySignalNativeCompanionAssociation>;
  drainCompanionPresenceEvents(): Promise<BodySignalCompanionPresenceEvent[]>;
  getCompanionSupport(): Promise<BodySignalCompanionSupport>;
  pausePrimaryDeviceObservation(associationId: number): Promise<boolean>;
  repairPrimaryDeviceAssociation(associationId: number): Promise<boolean>;
  removeListeners(count: number): void;
  resumePrimaryDeviceObservation(associationId: number): Promise<boolean>;
  revokePrimaryDeviceAssociation(associationId: number): Promise<boolean>;
};

const COMPANION_PRESENCE_EVENT = 'junluoBodySignalCompanionPresence';

function nativeModule(): BodySignalCompanionNativeModule | undefined {
  if (Platform.OS !== 'android') return undefined;
  return NativeModules.JunLuoBodySignalCompanion as BodySignalCompanionNativeModule | undefined;
}

export async function getBodySignalCompanionSupport(): Promise<BodySignalCompanionSupport> {
  const module = nativeModule();
  if (!module) return { reason: 'android_api_below_33', supported: false };
  return module.getCompanionSupport();
}

export async function beginBodySignalPrimaryDeviceAssociation(input: {
  deviceAddress: string;
  deviceProfileId: string;
}): Promise<BodySignalNativeCompanionAssociation> {
  const module = nativeModule();
  if (!module) throw new Error('当前安装包缺少 Android 穿戴设备关联模块，请重新安装 Dev Client。');
  return module.beginPrimaryDeviceAssociation(input.deviceProfileId, input.deviceAddress);
}

export async function pauseBodySignalPrimaryDeviceObservation(associationId: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.pausePrimaryDeviceObservation(associationId);
}

export async function resumeBodySignalPrimaryDeviceObservation(associationId: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.resumePrimaryDeviceObservation(associationId);
}

export async function repairBodySignalPrimaryDeviceAssociation(associationId: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.repairPrimaryDeviceAssociation(associationId);
}

export async function revokeBodySignalPrimaryDeviceAssociation(associationId: number): Promise<void> {
  const module = nativeModule();
  if (!module) return;
  await module.revokePrimaryDeviceAssociation(associationId);
}

export function isBodySignalCompanionAssociationMissingError(error: unknown): boolean {
  const message = error instanceof Error
    ? error.message
    : typeof error === 'object' && error !== null && 'message' in error
      ? String(error.message)
      : String(error ?? '');
  return message.includes('Android no longer has this wearable association.');
}

export async function drainBodySignalCompanionPresenceEvents(): Promise<BodySignalCompanionPresenceEvent[]> {
  const module = nativeModule();
  if (!module) return [];
  return module.drainCompanionPresenceEvents();
}

export function subscribeBodySignalCompanionPresence(
  listener: (event: BodySignalCompanionPresenceEvent) => void,
): () => void {
  const module = nativeModule();
  if (!module) return () => undefined;
  const emitter = new NativeEventEmitter(module as never);
  const subscription = emitter.addListener(COMPANION_PRESENCE_EVENT, (event: BodySignalCompanionPresenceEvent) => {
    if (
      Number.isInteger(event?.associationId)
      && Number.isFinite(event?.observedAt)
      && (event?.type === 'appeared' || event?.type === 'disappeared')
    ) listener(event);
  });
  return () => subscription.remove();
}
