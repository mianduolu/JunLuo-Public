import { NativeModules, Platform } from 'react-native';
import type { BodySignalGuardianEvent } from './bodySignalGuardian';
import type { MiBand6ActivityBatch, MiBand6ActivitySyncTrigger } from './miBand6ActivityTypes';

export type MiBand6ActivityEvent = Extract<BodySignalGuardianEvent, { type: 'activity_batch' }>;
export type MiBand6ActivitySyncState = {
  deviceProfileId?: string; formallyVerified?: boolean;
  status?: 'syncing' | 'candidate' | 'pending_save' | 'completed' | 'error';
  lastAttemptAt?: number; lastSuccessAt?: number; lastReceivedAt?: number; lastErrorCode?: string;
  rangeStartedAt?: number; rangeEndedAt?: number; receivedCount?: number; syncedThroughAt?: number;
  gap?: boolean; inFlightUntil?: number;
};
type Native = {
  readGuardianActivity?(profile: string, trigger: string, diagnostic: boolean): Promise<MiBand6ActivityBatch | MiBand6ActivityEvent>;
  getMiBand6ActivitySyncState?(profile: string): Promise<string>;
  restoreMiBand6ActivityCursor?(profile: string, cursor: number): Promise<boolean>;
  beginLegacyMiBand6Activity?(profile: string, trigger: string, diagnostic: boolean): Promise<{ since: number; attemptedAt: number }>;
  finishLegacyMiBand6Activity?(profile: string, trigger: string, attemptedAt: number, batch: string | null,
    error: string | null, diagnostic: boolean): Promise<MiBand6ActivityBatch | MiBand6ActivityEvent>;
};
function module(): Native {
  const native = Platform.OS === 'android' ? NativeModules.JunLuoBodySignalGuardian as Native | undefined : undefined;
  if (!native?.readGuardianActivity || !native.getMiBand6ActivitySyncState || !native.restoreMiBand6ActivityCursor
    || !native.beginLegacyMiBand6Activity || !native.finishLegacyMiBand6Activity) throw new Error('activity_update_required');
  return native;
}
export async function readNativeMiBand6Activity(profile: string, trigger: MiBand6ActivitySyncTrigger, diagnostic: boolean) {
  return module().readGuardianActivity!(profile, trigger, diagnostic);
}
export async function loadNativeMiBand6ActivityState(profile: string): Promise<MiBand6ActivitySyncState> {
  return JSON.parse(await module().getMiBand6ActivitySyncState!(profile)) as MiBand6ActivitySyncState;
}
export async function restoreNativeMiBand6ActivityCursor(profile: string, cursor: number): Promise<void> {
  if (!await module().restoreMiBand6ActivityCursor!(profile, cursor)) throw new Error('activity_save_failed');
}
export async function beginLegacyMiBand6Activity(profile: string, trigger: MiBand6ActivitySyncTrigger, diagnostic: boolean) {
  return module().beginLegacyMiBand6Activity!(profile, trigger, diagnostic);
}
export async function finishLegacyMiBand6Activity(profile: string, trigger: MiBand6ActivitySyncTrigger,
  attemptedAt: number, batch: MiBand6ActivityBatch | undefined, error: string | undefined, diagnostic: boolean) {
  return module().finishLegacyMiBand6Activity!(profile, trigger, attemptedAt,
    batch ? JSON.stringify(batch) : null, error ?? null, diagnostic);
}
