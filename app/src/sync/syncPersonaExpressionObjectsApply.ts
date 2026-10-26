import {
  assertPersonaExpressionObjectsMutationV1,
  type PersonaExpressionObjectsEntityType,
  type PersonaExpressionObjectsRecordKind,
} from './syncPersonaExpressionObjects';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type {
  JsonValue,
  PlainMutationV1,
} from './syncProtocol';

export type PersonaExpressionObjectsRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface PersonaExpressionObjectsBusinessPort {
  upsertRecord(input: {
    entityType: PersonaExpressionObjectsEntityType;
    entityId: string;
    kind: PersonaExpressionObjectsRecordKind;
    value: JsonValue;
    revision: PersonaExpressionObjectsRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    entityType: PersonaExpressionObjectsEntityType;
    entityId: string;
    deletedAt: number;
    revision: PersonaExpressionObjectsRevisionContext;
  }): Promise<void>;
}

function revisionContext(
  mutation: PlainMutationV1,
): PersonaExpressionObjectsRevisionContext {
  return {
    revisionId: mutation.revision.id,
    parentRevisionIds: [...mutation.revision.parents],
    sourceDeviceId: mutation.sourceDeviceId,
    sourceSequence: mutation.sourceSequence,
    createdAt: mutation.createdAt,
  };
}

function payloadRecord(mutation: PlainMutationV1) {
  if (
    !mutation.payload
    || typeof mutation.payload !== 'object'
    || Array.isArray(mutation.payload)
  ) {
    throw new Error('persona.expression-objects payload 必须是对象。');
  }
  return mutation.payload;
}

export class PersonaExpressionObjectsBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(private readonly port: PersonaExpressionObjectsBusinessPort) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertPersonaExpressionObjectsMutationV1(mutation);
    const payload = payloadRecord(mutation);
    const revision = revisionContext(mutation);
    const entityType = (
      mutation.entity.type as PersonaExpressionObjectsEntityType
    );
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        entityType,
        entityId: mutation.entity.id,
        deletedAt: payload.deletedAt as number,
        revision,
      });
      return;
    }
    await this.port.upsertRecord({
      entityType,
      entityId: mutation.entity.id,
      kind: payload.kind as PersonaExpressionObjectsRecordKind,
      value: payload.value as JsonValue,
      revision,
    });
  }
}

export const PERSONA_EXPRESSION_OBJECTS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'persona.expression-objects',
  isMutationAllowed(mutation) {
    try {
      assertPersonaExpressionObjectsMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
