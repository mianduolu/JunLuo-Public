import { NativeModules, Platform } from 'react-native';

// Execution diagnostics stay local. They are not conversation or model input.
export type PhoneRestrictionExecutionStatus = {
  schemaVersion: 1;
  checkedAt: number;
  restorePaused: boolean;
  needs: { collector: boolean; strictPhone: boolean; overlay: boolean; usageAccess: boolean };
  permissions: {
    usageAccess: boolean | null;
    notificationListener: boolean | null;
    accessibility: boolean | null;
    overlay: boolean | null;
  };
  accessibilityConnected: boolean;
  collector: {
    running: boolean;
    starting: boolean;
    screenAvailable: boolean | null;
    lastStartFailure: string | null;
    lastObservationAt: number | null;
    lastObservationSource: string | null;
  };
  window: {
    required: boolean | null;
    phoneOverlayAttached: boolean;
    phoneActivityAttached: boolean;
    phoneWindowShowing: boolean;
    appOverlayShowing: boolean;
    legacyOverlayAttached: boolean;
    countdownAttached: boolean;
    lastFailureCode: string | null;
    lastFailureAt: number | null;
    lastActivityAttemptAt: number | null;
  };
};

type RecoveryNativeModule = {
  getRestrictionExecutionStatus?: () => Promise<string>;
  refreshRestrictionExecution?: () => Promise<boolean>;
};

const nullableBoolean = (value: unknown) => value === null || typeof value === 'boolean';
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const nullableTime = (value: unknown) => value === null
  || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

export function parsePhoneRestrictionExecutionStatus(raw: unknown): PhoneRestrictionExecutionStatus | null {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || value.schemaVersion !== 1 || !Number.isFinite(value.checkedAt)
      || value.checkedAt <= 0 || typeof value.restorePaused !== 'boolean'
      || typeof value.accessibilityConnected !== 'boolean') return null;
    const { needs, permissions, collector, window } = value;
    if (!needs || !permissions || !collector || !window
      || !['collector', 'strictPhone', 'overlay', 'usageAccess'].every((key) => typeof needs[key] === 'boolean')
      || !['usageAccess', 'notificationListener', 'accessibility', 'overlay'].every((key) => nullableBoolean(permissions[key]))
      || typeof collector.running !== 'boolean' || typeof collector.starting !== 'boolean'
      || !nullableBoolean(collector.screenAvailable)
      || !nullableString(collector.lastStartFailure) || !nullableTime(collector.lastObservationAt)
      || !nullableString(collector.lastObservationSource)
      || !nullableBoolean(window.required)
      || !['phoneOverlayAttached', 'phoneActivityAttached', 'phoneWindowShowing', 'appOverlayShowing',
        'legacyOverlayAttached', 'countdownAttached'].every((key) => typeof window[key] === 'boolean')
      || !nullableString(window.lastFailureCode) || !nullableTime(window.lastFailureAt)
      || !nullableTime(window.lastActivityAttemptAt)) return null;
    return value as PhoneRestrictionExecutionStatus;
  } catch {
    return null;
  }
}

function nativeModule(): RecoveryNativeModule | undefined {
  return Platform.OS === 'android' ? NativeModules.JunLuoPhoneActivity : undefined;
}

export async function readPhoneRestrictionExecutionStatus(): Promise<PhoneRestrictionExecutionStatus | null> {
  const module = nativeModule();
  if (typeof module?.getRestrictionExecutionStatus !== 'function') return null;
  try {
    return parsePhoneRestrictionExecutionStatus(await module.getRestrictionExecutionStatus());
  } catch {
    return null;
  }
}

export async function refreshPhoneRestrictionExecution(): Promise<boolean | null> {
  const module = nativeModule();
  if (typeof module?.refreshRestrictionExecution !== 'function') return null;
  try {
    // This is current running state; a false return is not proof that the pending start failed.
    const running = await module.refreshRestrictionExecution();
    return typeof running === 'boolean' ? running : null;
  } catch {
    return null;
  }
}
