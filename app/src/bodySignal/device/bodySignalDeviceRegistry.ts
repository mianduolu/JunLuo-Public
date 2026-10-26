import type {
  BodySignalCapabilityProbeResult,
  BodySignalConnectionSource,
  BodySignalDeviceProfile,
  BodySignalDeviceTarget,
} from './bodySignalDeviceTypes';

export const BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY = 'junluo.bodySignal.device.registry.v1';

type BodySignalDeviceRegistryDocument = {
  profiles: BodySignalDeviceProfile[];
  version: 1;
};

export type BodySignalDeviceRegistryStorage = {
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
};

export type RegisterBodySignalDeviceInput = {
  connectedAt?: number;
  probe: BodySignalCapabilityProbeResult;
  source: BodySignalConnectionSource;
  target: BodySignalDeviceTarget;
};

let cachedDocument: BodySignalDeviceRegistryDocument | undefined;

function normalizeIdentity(value?: string): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function hashIdentity(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function strongestIdentity(target: BodySignalDeviceTarget): string {
  return normalizeIdentity(target.authorizedAssociationId)
    ?? normalizeIdentity(target.protocolIdentity)
    ?? normalizeIdentity(target.id)
    ?? 'unknown';
}

function createProfileId(input: RegisterBodySignalDeviceInput): string {
  return `wearable-${input.probe.family}-${hashIdentity(strongestIdentity(input.target))}`;
}

export function findMatchingBodySignalDeviceProfile(
  profiles: readonly BodySignalDeviceProfile[],
  target: BodySignalDeviceTarget,
): BodySignalDeviceProfile | undefined {
  const association = normalizeIdentity(target.authorizedAssociationId);
  if (association) {
    const match = profiles.find((profile) => (
      normalizeIdentity(profile.authorizedAssociationId) === association
    ));
    if (match) return match;
  }

  const protocolIdentity = normalizeIdentity(target.protocolIdentity);
  if (protocolIdentity) {
    const match = profiles.find((profile) => (
      normalizeIdentity(profile.protocolIdentity) === protocolIdentity
    ));
    if (match) return match;
  }

  const advertisingId = normalizeIdentity(target.id);
  return advertisingId
    ? profiles.find((profile) => normalizeIdentity(profile.lastAdvertisingId) === advertisingId)
    : undefined;
}

export function upsertBodySignalDeviceProfile(
  profiles: readonly BodySignalDeviceProfile[],
  input: RegisterBodySignalDeviceInput,
): { profile: BodySignalDeviceProfile; profiles: BodySignalDeviceProfile[] } {
  const now = input.connectedAt ?? Date.now();
  const existing = findMatchingBodySignalDeviceProfile(profiles, input.target);
  const shouldBecomePrimary = input.source === 'manual'
    || (!profiles.some((profile) => profile.isPrimary) && !existing);
  const profile: BodySignalDeviceProfile = {
    authorizedAssociationId: input.target.authorizedAssociationId ?? existing?.authorizedAssociationId,
    createdAt: existing?.createdAt ?? now,
    displayName: input.target.displayName || existing?.displayName || '穿戴设备',
    family: input.probe.family,
    id: existing?.id ?? createProfileId(input),
    isPrimary: shouldBecomePrimary || Boolean(existing?.isPrimary),
    lastAdvertisingId: input.target.id || existing?.lastAdvertisingId,
    lastConnectedAt: now,
    protocolIdentity: input.target.protocolIdentity ?? existing?.protocolIdentity,
    serviceFingerprint: input.probe.serviceFingerprint,
    transportIdentity: input.target.authorizedAssociationId
      ?? input.target.protocolIdentity
      ?? input.target.id,
    updatedAt: now,
  };

  const next = profiles
    .filter((candidate) => candidate.id !== profile.id)
    .map((candidate) => shouldBecomePrimary ? { ...candidate, isPrimary: false } : { ...candidate });
  next.push(profile);
  next.sort((left, right) => (right.lastConnectedAt ?? 0) - (left.lastConnectedAt ?? 0));
  return { profile, profiles: next };
}

export function parseBodySignalDeviceRegistry(raw: string | null): BodySignalDeviceRegistryDocument {
  if (!raw) return { profiles: [], version: 1 };
  try {
    const parsed = JSON.parse(raw) as Partial<BodySignalDeviceRegistryDocument>;
    if (parsed.version !== 1 || !Array.isArray(parsed.profiles)) return { profiles: [], version: 1 };
    return { profiles: parsed.profiles, version: 1 };
  } catch {
    return { profiles: [], version: 1 };
  }
}

async function defaultStorage(): Promise<BodySignalDeviceRegistryStorage> {
  const module = await import('@react-native-async-storage/async-storage');
  return module.default;
}

export async function loadBodySignalDeviceProfiles(
  storage?: BodySignalDeviceRegistryStorage,
): Promise<BodySignalDeviceProfile[]> {
  const port = storage ?? await defaultStorage();
  const document = parseBodySignalDeviceRegistry(
    await port.getItem(BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY).catch(() => null),
  );
  cachedDocument = document;
  return document.profiles.map((profile) => ({ ...profile }));
}

export async function registerBodySignalDevice(
  input: RegisterBodySignalDeviceInput,
  storage?: BodySignalDeviceRegistryStorage,
): Promise<BodySignalDeviceProfile> {
  const port = storage ?? await defaultStorage();
  const current = cachedDocument ?? parseBodySignalDeviceRegistry(
    await port.getItem(BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY).catch(() => null),
  );
  const result = upsertBodySignalDeviceProfile(current.profiles, input);
  cachedDocument = { profiles: result.profiles, version: 1 };
  await port.setItem(BODY_SIGNAL_DEVICE_REGISTRY_STORAGE_KEY, JSON.stringify(cachedDocument));
  return { ...result.profile };
}

export async function loadPrimaryBodySignalDeviceProfile(
  storage?: BodySignalDeviceRegistryStorage,
): Promise<BodySignalDeviceProfile | undefined> {
  const profiles = await loadBodySignalDeviceProfiles(storage);
  return profiles.find((profile) => profile.isPrimary);
}

export function getCachedPrimaryBodySignalDeviceProfile(): BodySignalDeviceProfile | undefined {
  const profile = cachedDocument?.profiles.find((candidate) => candidate.isPrimary);
  return profile ? { ...profile } : undefined;
}

export function resetBodySignalDeviceRegistryForTests(): void {
  cachedDocument = undefined;
}
