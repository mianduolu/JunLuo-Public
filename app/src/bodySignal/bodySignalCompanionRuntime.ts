import { AppState } from 'react-native';

import {
  drainBodySignalCompanionPresenceEvents,
  repairBodySignalPrimaryDeviceAssociation,
  subscribeBodySignalCompanionPresence,
} from './bodySignalCompanion';
import {
  loadBodySignalCompanionAssociation,
  recordBodySignalCompanionPresenceEvent,
} from './device/bodySignalCompanionStore';
import { loadPersistedBodySignalDeviceProfiles } from './device/bodySignalDeviceRepository';

let started = false;
let stopListening: (() => void) | undefined;
let appStateSubscription: { remove(): void } | undefined;
let presencePersistenceTail: Promise<void> = Promise.resolve();

function associationIdFromProfile(value?: string): number | undefined {
  const match = /^cdm:(\d+)$/.exec(value ?? '');
  return match ? Number(match[1]) : undefined;
}

async function persistBodySignalCompanionPresenceEventNow(event: {
  associationId: number;
  observedAt: number;
  type: 'appeared' | 'disappeared';
}): Promise<void> {
  const profiles = await loadPersistedBodySignalDeviceProfiles();
  const profile = profiles.find((candidate) => (
    candidate.isPrimary && associationIdFromProfile(candidate.authorizedAssociationId) === event.associationId
  ));
  if (!profile) return;
  await recordBodySignalCompanionPresenceEvent(profile.id, event);
}

export function persistBodySignalCompanionPresenceEvent(event: {
  associationId: number;
  observedAt: number;
  type: 'appeared' | 'disappeared';
}): Promise<void> {
  const task = presencePersistenceTail.then(() => persistBodySignalCompanionPresenceEventNow(event));
  presencePersistenceTail = task.catch(() => undefined);
  return task;
}

async function repairPersistedPrimaryAssociation(): Promise<void> {
  const profiles = await loadPersistedBodySignalDeviceProfiles();
  const profile = profiles.find((candidate) => candidate.isPrimary);
  const associationId = associationIdFromProfile(profile?.authorizedAssociationId);
  if (!profile || associationId === undefined) return;
  const association = await loadBodySignalCompanionAssociation(profile.id);
  if (
    !association
    || association.associationId !== associationId
    || association.status !== 'active'
    || !association.observationEnabled
  ) return;
  await repairBodySignalPrimaryDeviceAssociation(associationId);
}

export async function drainBodySignalCompanionRuntime(): Promise<void> {
  const events = await drainBodySignalCompanionPresenceEvents();
  for (const event of events) {
    await persistBodySignalCompanionPresenceEvent(event).catch(() => undefined);
  }
}

export function startBodySignalCompanionRuntime(): () => void {
  if (started) return () => undefined;
  started = true;
  stopListening = subscribeBodySignalCompanionPresence((event) => {
    void persistBodySignalCompanionPresenceEvent(event).catch(() => undefined);
  });
  appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') void drainBodySignalCompanionRuntime().catch(() => undefined);
  });
  void (async () => {
    await repairPersistedPrimaryAssociation().catch(() => undefined);
    await drainBodySignalCompanionRuntime().catch(() => undefined);
  })();
  return () => {
    stopListening?.();
    appStateSubscription?.remove();
    stopListening = undefined;
    appStateSubscription = undefined;
    started = false;
  };
}
