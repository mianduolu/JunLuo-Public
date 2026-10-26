import { DeviceEventEmitter, NativeModules, Platform } from 'react-native';

import type { VoiceCallInvitationKind, VoiceCallInvitationStatus } from '../voiceCall/voiceCallInvitationStore';

type NativeIncomingCallModule = {
  cancelCall(invitationId: string): Promise<boolean>;
  consumePendingAction(): Promise<IncomingCallNativeAction | null>;
  declineCall(invitationId: string): Promise<boolean>;
  getCapabilityStatus(): Promise<IncomingCallCapabilityStatus>;
  getRecords(): Promise<IncomingCallNativeRecord[]>;
  openExactAlarmSettings(): Promise<boolean>;
  openFullScreenIntentSettings(): Promise<boolean>;
  openXiaomiIncomingCallSettings(): Promise<boolean>;
  scheduleCall(payloadJson: string): Promise<{ nativeTaskId: string }>;
  setCallUiVisible(visible: boolean): Promise<boolean>;
  suppressCall(invitationId: string): Promise<boolean>;
  answerCall(invitationId: string): Promise<boolean>;
};

export type IncomingCallCapabilityStatus = {
  available: boolean;
  exactAlarmAllowed: boolean;
  fullScreenIntentAllowed: boolean;
  notificationsAllowed: boolean;
  xiaomiPermissionRequired: boolean;
  showOnLockScreenAllowed: boolean;
  backgroundStartAllowed: boolean;
};

export type IncomingCallNativeRecord = {
  invitationId: string;
  isTest?: boolean;
  kind: VoiceCallInvitationKind;
  note?: string;
  scheduledAt: number;
  status: VoiceCallInvitationStatus;
  updatedAt: number;
};

export type IncomingCallNativeAction = IncomingCallNativeRecord & {
  action: 'answered' | 'declined' | 'ringing' | 'suppressed_busy' | 'timed_out';
};

const incomingCallModule = NativeModules.JunLuoIncomingCall as NativeIncomingCallModule | undefined;
const EVENT_NAME = 'junluoIncomingCallAction';

function requireModule() {
  if (Platform.OS !== 'android' || !incomingCallModule) throw new Error('当前安装包还没有包含原生来电模块。');
  return incomingCallModule;
}

export function getIncomingCallCapabilityStatus() {
  if (Platform.OS !== 'android' || !incomingCallModule) {
    return Promise.resolve({
      available: false,
      exactAlarmAllowed: false,
      fullScreenIntentAllowed: false,
      notificationsAllowed: false,
      xiaomiPermissionRequired: false,
      showOnLockScreenAllowed: false,
      backgroundStartAllowed: false,
    });
  }
  return incomingCallModule.getCapabilityStatus();
}

export function scheduleNativeIncomingCall(record: IncomingCallNativeRecord) {
  return requireModule().scheduleCall(JSON.stringify(record));
}
export function cancelNativeIncomingCall(invitationId: string) { return requireModule().cancelCall(invitationId); }
export function answerNativeIncomingCall(invitationId: string) { return requireModule().answerCall(invitationId); }
export function declineNativeIncomingCall(invitationId: string) { return requireModule().declineCall(invitationId); }
export function suppressNativeIncomingCall(invitationId: string) { return requireModule().suppressCall(invitationId); }
export function setNativeIncomingCallUiVisible(visible: boolean) {
  return incomingCallModule?.setCallUiVisible(visible) ?? Promise.resolve(false);
}
export function consumePendingIncomingCallAction() { return incomingCallModule?.consumePendingAction() ?? Promise.resolve(null); }
export function loadNativeIncomingCallRecords() { return incomingCallModule?.getRecords() ?? Promise.resolve([]); }
export function openIncomingCallExactAlarmSettings() { return requireModule().openExactAlarmSettings(); }
export function openIncomingCallFullScreenSettings() { return requireModule().openFullScreenIntentSettings(); }
export function openIncomingCallXiaomiSettings() { return requireModule().openXiaomiIncomingCallSettings(); }
export function subscribeIncomingCallActions(listener: (event: IncomingCallNativeAction) => void) {
  const subscription = DeviceEventEmitter.addListener(EVENT_NAME, listener);
  return () => subscription.remove();
}
