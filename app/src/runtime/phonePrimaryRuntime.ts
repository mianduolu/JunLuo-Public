import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as Crypto from 'expo-crypto';
import { captureBackupRestoreDataEpoch, canCommitBackupRestoreDataEpoch, runBackupRestoreDataEpochCommit } from '../backup/backupRestoreCoordinator';
import { isBackupRestoreSyncGateActive } from '../backup/backupRestoreSyncGate';
import { loadCurrentSyncRelayEnrollment, createAndroidSyncRelayClient } from '../sync/syncRelayClientExpo';
import { loadGiftExecutionRelayBaseUrl } from '../gifts/giftExecutionRelay';
import { createProactiveDeviceControl, type ProactiveControlState } from '../proactive/proactiveDeviceControl';
import { readUnifiedContactState, changeUnifiedContactState } from '../proactive/unifiedContactStore';
import { contactLocalDay } from '../proactive/unifiedContact';

export const PHONE_PRIMARY_ACTIVATION_KEY = 'junluo.runtime.phonePrimaryActivation.v1';
export type PhonePrimaryActivation = { activatedAt: number };
let activating: Promise<PhonePrimaryActivation | undefined> | undefined;

const enrollmentScope = (enrollment: Awaited<ReturnType<typeof loadCurrentSyncRelayEnrollment>>) => enrollment
  ? `paired:${enrollment.publicIdentity.vaultId}:${enrollment.publicIdentity.keyId}:${enrollment.publicIdentity.deviceId}`
  : 'unpaired';

/** A local runtime setting only: reading it never initializes data or contacts a service. */
export async function loadPhonePrimaryActivation(): Promise<PhonePrimaryActivation | undefined> {
  const raw = await AsyncStorage.getItem(PHONE_PRIMARY_ACTIVATION_KEY);
  if (raw === null) return undefined;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !('activatedAt' in value) || !('identityScope' in value)
    || typeof value.activatedAt !== 'number' || !Number.isSafeInteger(value.activatedAt) || value.activatedAt <= 0
    || typeof value.identityScope !== 'string' || !value.identityScope) {
    throw new Error('phone-primary-activation-invalid');
  }
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null || await isBackupRestoreSyncGateActive()) return undefined;
  const scope = enrollmentScope(await loadCurrentSyncRelayEnrollment());
  if (!canCommitBackupRestoreDataEpoch(epoch) || scope !== value.identityScope) return undefined;
  return { activatedAt: value.activatedAt };
}

function completeSharedHandoff(shared: ProactiveControlState, now: number) {
  const times = [shared.ledger.lastEndedAt, shared.ledger.lastOrdinaryReplyAt,
    ...Object.values(shared.ledger.motiveLastSelectedAt)];
  return shared.migrationComplete && shared.day === contactLocalDay(now)
    && Number.isSafeInteger(shared.used) && shared.used >= 0
    && times.every(value => Number.isSafeInteger(value) && value >= 0)
    && !shared.current;
}

async function activatePhonePrimary(): Promise<PhonePrimaryActivation | undefined> {
  const existing = await loadPhonePrimaryActivation();
  if (existing) return existing;
  const epoch = captureBackupRestoreDataEpoch();
  if (epoch === null || await isBackupRestoreSyncGateActive()) return undefined;
  // A missing device is different from a temporarily unreadable/corrupt device: errors defer.
  const enrollment = await loadCurrentSyncRelayEnrollment();
  const identityScope = enrollmentScope(enrollment);
  await readUnifiedContactState();
  if (enrollment) {
    const baseUrl = await loadGiftExecutionRelayBaseUrl();
    if (!baseUrl) return undefined;
    const control = createProactiveDeviceControl({ deviceId: enrollment.publicIdentity.deviceId,
      runtimeEpoch: Crypto.randomUUID(), post: (action, body) =>
        createAndroidSyncRelayClient({ baseUrl, timeoutMs: 5000 }).proactiveControl(enrollment, action, body) });
    const shared = await control.read();
    if (!completeSharedHandoff(shared, Date.now()) || !canCommitBackupRestoreDataEpoch(epoch)
      || enrollmentScope(await loadCurrentSyncRelayEnrollment()) !== identityScope) return undefined;
    await changeUnifiedContactState(state => {
      state.used = Math.max(shared.used, state.day === shared.day ? state.used : 0);
      state.day = shared.day;
      state.lastEndedAt = Math.max(state.lastEndedAt, shared.ledger.lastEndedAt);
      state.lastOrdinaryReplyAt = Math.max(state.lastOrdinaryReplyAt, shared.ledger.lastOrdinaryReplyAt);
      state.motiveLastSelectedAt = Object.fromEntries([...new Set([
        ...Object.keys(state.motiveLastSelectedAt ?? {}), ...Object.keys(shared.ledger.motiveLastSelectedAt),
      ])].map(key => [key, Math.max(state.motiveLastSelectedAt?.[key as keyof NonNullable<typeof state.motiveLastSelectedAt>] ?? 0,
        shared.ledger.motiveLastSelectedAt[key] ?? 0)]));
    }, epoch);
  }
  const activation = { activatedAt: Date.now() };
  const saved = await runBackupRestoreDataEpochCommit(epoch, async () => {
    if (await isBackupRestoreSyncGateActive()
      || enrollmentScope(await loadCurrentSyncRelayEnrollment()) !== identityScope) return undefined;
    const already = await loadPhonePrimaryActivation();
    if (already) return already;
    await AsyncStorage.setItem(PHONE_PRIMARY_ACTIVATION_KEY, JSON.stringify({ ...activation, identityScope }));
    return activation;
  });
  return saved.committed ? saved.value : undefined;
}

/** Once the real ledger handoff succeeds, all subsequent use is local and needs no relay. */
export function ensurePhonePrimaryActivation(): Promise<PhonePrimaryActivation | undefined> {
  if (Platform.OS !== 'android') return Promise.resolve(undefined);
  if (!activating) activating = activatePhonePrimary().catch(() => undefined).finally(() => { activating = undefined; });
  return activating;
}

/** Restore reconciliation removes only this device-local activation, never the contact ledger. */
export async function clearPhonePrimaryActivation(): Promise<void> {
  await AsyncStorage.removeItem(PHONE_PRIMARY_ACTIVATION_KEY);
}
