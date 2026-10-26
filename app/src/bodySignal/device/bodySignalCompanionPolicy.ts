import type { BodySignalDeviceProfile } from './bodySignalDeviceTypes';
import type {
  BodySignalCompanionAssociation,
  BodySignalCompanionPresenceEvent,
} from './bodySignalCompanionTypes';

const MAC_ADDRESS_PATTERN = /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i;

export function toBodySignalCompanionIdentity(associationId: number): string {
  if (!Number.isInteger(associationId) || associationId < 0) {
    throw new RangeError('Android companion association id must be a non-negative integer.');
  }
  return `cdm:${associationId}`;
}

export function fromBodySignalCompanionIdentity(value?: string): number | undefined {
  const match = /^cdm:(\d+)$/.exec(value ?? '');
  if (!match) return undefined;
  const associationId = Number(match[1]);
  return Number.isSafeInteger(associationId) ? associationId : undefined;
}

export function activateBodySignalCompanionAssociation(
  previous: BodySignalCompanionAssociation | undefined,
  next: Pick<BodySignalCompanionAssociation, 'associationId' | 'deviceProfileId' | 'observationEnabled' | 'updatedAt'>,
): BodySignalCompanionAssociation {
  const sameAssociation = previous?.associationId === next.associationId;
  return {
    ...next,
    ...(sameAssociation && previous?.lastAppearedAt !== undefined
      ? { lastAppearedAt: previous.lastAppearedAt }
      : {}),
    ...(sameAssociation && previous?.lastDisappearedAt !== undefined
      ? { lastDisappearedAt: previous.lastDisappearedAt }
      : {}),
    observationEnabled: next.observationEnabled,
    status: 'active',
  };
}

export function canManageBodySignalCompanion(
  profile: Pick<BodySignalDeviceProfile, 'isPrimary'> | undefined,
): boolean {
  return profile?.isPrimary === true;
}

export function shouldReplaceBodySignalCompanionAssociation(
  associationSucceeded: boolean,
): boolean {
  return associationSucceeded;
}

export function applyBodySignalCompanionPresenceEvent(
  association: BodySignalCompanionAssociation,
  event: BodySignalCompanionPresenceEvent,
): BodySignalCompanionAssociation {
  if (
    association.associationId !== event.associationId
    || association.status !== 'active'
    || !association.observationEnabled
    || !Number.isFinite(event.observedAt)
  ) {
    return association;
  }

  if (event.type === 'appeared' && event.observedAt <= (association.lastAppearedAt ?? 0)) {
    return association;
  }
  if (event.type === 'disappeared' && event.observedAt <= (association.lastDisappearedAt ?? 0)) {
    return association;
  }

  return {
    ...association,
    ...(event.type === 'appeared'
      ? { lastAppearedAt: event.observedAt }
      : { lastDisappearedAt: event.observedAt }),
    updatedAt: event.observedAt,
  };
}

export function containsPersistedBluetoothAddress(value: unknown): boolean {
  return typeof value === 'string' && MAC_ADDRESS_PATTERN.test(value);
}
