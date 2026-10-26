export type BodySignalCompanionAssociationStatus =
  | 'active'
  | 'paused'
  | 'revoked'
  | 'unsupported';

export type BodySignalCompanionAssociation = {
  associationId: number;
  deviceProfileId: string;
  lastAppearedAt?: number;
  lastDisappearedAt?: number;
  lastErrorCode?: string;
  observationEnabled: boolean;
  status: BodySignalCompanionAssociationStatus;
  updatedAt: number;
};

export type BodySignalCompanionPresenceEvent = {
  associationId: number;
  observedAt: number;
  type: 'appeared' | 'disappeared';
};
