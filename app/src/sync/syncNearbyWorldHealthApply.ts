import {
  assertNearbyWorldHealthMutationV1,
  assertNearbyWorldLocationObservation,
  assertNearbyWorldMovementEvent,
  assertNearbyWorldSettingsFieldValue,
  NEARBY_WORLD_HEALTH_ADAPTER_ID,
  normalizeNearbyWorldLocationRetention,
  type NearbyWorldLocationObservation,
  type NearbyWorldMovementEvent,
  type NearbyWorldSettingsField,
  type NearbyWorldSettingsFieldValue,
} from './syncNearbyWorldHealth';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type NearbyWorldHealthRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface NearbyWorldHealthBusinessPort {
  upsertSettingsField(input: {
    field: NearbyWorldSettingsField;
    value: NearbyWorldSettingsFieldValue;
    revision: NearbyWorldHealthRevisionContext;
  }): Promise<void>;
  appendLocationObservation(input: {
    observation: NearbyWorldLocationObservation;
    revision: NearbyWorldHealthRevisionContext;
  }): Promise<void>;
  deleteLocationObservation(input: {
    entityId: string;
    deletedAt: number;
    revision: NearbyWorldHealthRevisionContext;
  }): Promise<void>;
  deleteMovementEvent(input: {
    entityId: string;
    deletedAt: number;
    revision: NearbyWorldHealthRevisionContext;
  }): Promise<void>;
  appendMovementEvent(input: {
    event: NearbyWorldMovementEvent;
    revision: NearbyWorldHealthRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('nearby-world.health payload 必须是对象。');
  }
  return mutation.payload;
}

function valueRecord(mutation: PlainMutationV1) {
  const payload = payloadRecord(mutation);
  if (
    !payload.value
    || typeof payload.value !== 'object'
    || Array.isArray(payload.value)
  ) {
    throw new Error('nearby-world.health value 必须是对象。');
  }
  return payload.value;
}

export class NearbyWorldHealthBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: NearbyWorldHealthBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertNearbyWorldHealthMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision: NearbyWorldHealthRevisionContext = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if (mutation.revision.operation === 'delete') {
      const deletion = {
        entityId: mutation.entity.id,
        deletedAt: Number(payload.deletedAt),
        revision,
      };
      if (payload.kind === 'nearby-movement-event') {
        await this.port.deleteMovementEvent(deletion);
      } else {
        await this.port.deleteLocationObservation(deletion);
      }
      return;
    }
    const value = valueRecord(mutation);
    if (payload.kind === 'nearby-settings-field') {
      const field = mutation.entity.id as NearbyWorldSettingsField;
      assertNearbyWorldSettingsFieldValue(field, value.value);
      await this.port.upsertSettingsField({
        field,
        value: value.value,
        revision,
      });
      return;
    }
    if (payload.kind === 'nearby-location-observation') {
      assertNearbyWorldLocationObservation(
        value,
        mutation.entity.id,
        mutation.sourceDeviceId,
      );
      const observation = normalizeNearbyWorldLocationRetention(value);
      await this.port.appendLocationObservation({
        observation,
        revision,
      });
      return;
    }
    assertNearbyWorldMovementEvent(
      value,
      mutation.entity.id,
      mutation.sourceDeviceId,
    );
    await this.port.appendMovementEvent({
      event: value,
      revision,
    });
  }
}

export const NEARBY_WORLD_HEALTH_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: NEARBY_WORLD_HEALTH_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertNearbyWorldHealthMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
