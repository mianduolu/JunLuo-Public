import {
  assertRelationshipAuthorizationFieldValue,
  assertRelationshipAuthorizationMutationV1,
  RELATIONSHIP_AUTHORIZATION_ADAPTER_ID,
  type RelationshipAuthorizationEntityType,
  type RelationshipAuthorizationField,
  type RelationshipAuthorizationFieldValue,
} from './syncRelationshipAuthorization';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type RelationshipAuthorizationRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface RelationshipAuthorizationBusinessPort {
  upsertField(input: {
    entityType: RelationshipAuthorizationEntityType;
    field: RelationshipAuthorizationField;
    value: RelationshipAuthorizationFieldValue;
    revision: RelationshipAuthorizationRevisionContext;
  }): Promise<void>;
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('relationship.authorization payload 必须是对象。');
  }
  return mutation.payload;
}

export class RelationshipAuthorizationBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: RelationshipAuthorizationBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertRelationshipAuthorizationMutationV1(mutation);
    const entityType =
      mutation.entity.type as RelationshipAuthorizationEntityType;
    const field =
      mutation.entity.id as RelationshipAuthorizationField;
    const payload = payloadRecord(mutation);
    assertRelationshipAuthorizationFieldValue(field, payload.value);
    await this.port.upsertField({
      entityType,
      field,
      value: payload.value,
      revision: {
        revisionId: mutation.revision.id,
        parentRevisionIds: [...mutation.revision.parents],
        sourceDeviceId: mutation.sourceDeviceId,
        sourceSequence: mutation.sourceSequence,
        createdAt: mutation.createdAt,
      },
    });
  }
}

export const RELATIONSHIP_AUTHORIZATION_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: RELATIONSHIP_AUTHORIZATION_ADAPTER_ID,
  isMutationAllowed(mutation) {
    try {
      assertRelationshipAuthorizationMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
