import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY,
  type RegisterBodySignalDeviceInput,
  upsertBodySignalDeviceProfile,
} from './bodySignalDeviceRegistry';
import { toBodySignalCompanionIdentity } from './bodySignalCompanionPolicy';
import {
  loadBodySignalDeviceProfilesFromDatabase,
  replaceBodySignalDeviceProfilesInDatabase,
  saveBodySignalDeviceCapabilities,
  updateBodySignalDeviceCompanionAssociationInDatabase,
} from './bodySignalDeviceStore';
import type { BodySignalDeviceProfile } from './bodySignalDeviceTypes';

async function mirrorProfiles(profiles: readonly BodySignalDeviceProfile[]): Promise<void> {
  await AsyncStorage.setItem(BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY, JSON.stringify({
    profiles,
    version: 1,
  })).catch(() => undefined);
}

export async function loadPersistedBodySignalDeviceProfiles(): Promise<BodySignalDeviceProfile[]> {
  return loadBodySignalDeviceProfilesFromDatabase();
}

export async function loadPersistedPrimaryBodySignalDeviceProfile(): Promise<BodySignalDeviceProfile | undefined> {
  const profiles = await loadBodySignalDeviceProfilesFromDatabase();
  return profiles.find((profile) => profile.isPrimary);
}

export async function registerPersistedBodySignalDevice(
  input: RegisterBodySignalDeviceInput,
): Promise<BodySignalDeviceProfile> {
  const current = await loadBodySignalDeviceProfilesFromDatabase();
  const result = upsertBodySignalDeviceProfile(current, input);

  await replaceBodySignalDeviceProfilesInDatabase(result.profiles);
  await saveBodySignalDeviceCapabilities(result.profile.id, {
    activity: { supportLevel: input.probe.capabilities.activity ? 'supported' : 'unsupported' },
    battery: { supportLevel: input.probe.capabilities.battery ? 'supported' : 'unsupported' },
    heart_rate: { supportLevel: input.probe.capabilities.heartRate },
    hrv: { supportLevel: input.probe.capabilities.hrv ? 'supported' : 'unsupported' },
    sleep: { supportLevel: input.probe.capabilities.sleep ? 'supported' : 'unsupported' },
    spo2: { supportLevel: input.probe.capabilities.spo2 ? 'supported' : 'unsupported' },
    stress: { supportLevel: input.probe.capabilities.stress ? 'supported' : 'unsupported' },
    workout: { supportLevel: input.probe.capabilities.workout ? 'supported' : 'unsupported' },
  });
  await mirrorProfiles(result.profiles);
  return { ...result.profile };
}

export async function setPersistedBodySignalDeviceCompanionAssociation(
  deviceProfileId: string,
  associationId: number | undefined,
): Promise<BodySignalDeviceProfile> {
  const profiles = await loadBodySignalDeviceProfilesFromDatabase();
  const current = profiles.find((profile) => profile.id === deviceProfileId);
  if (!current) {
    throw new Error('The selected wearable device profile no longer exists.');
  }

  const updatedAt = Date.now();
  const nextProfile: BodySignalDeviceProfile = {
    ...current,
    ...(associationId === undefined
      ? { authorizedAssociationId: undefined }
      : { authorizedAssociationId: toBodySignalCompanionIdentity(associationId) }),
    updatedAt,
  };
  const nextProfiles = profiles.map((profile) => (
    profile.id === deviceProfileId ? nextProfile : profile
  ));
  const updated = await updateBodySignalDeviceCompanionAssociationInDatabase(
    deviceProfileId,
    nextProfile.authorizedAssociationId,
    updatedAt,
  );
  if (!updated) {
    throw new Error('The selected wearable device profile no longer exists.');
  }
  await mirrorProfiles(nextProfiles);
  return { ...nextProfile };
}
