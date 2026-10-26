import {
  assertResearchMaterialsMutationV1,
  isFundResearchMaterialObjectReference,
  researchMaterialMutationValue,
  type ResearchMaterialRecordKind,
  type ResearchMaterialRecordValue,
} from './syncResearchMaterials';
import type {
  SyncMutationBatchCapturePolicy,
  SyncMutationBusinessApplier,
} from './syncMutationBatchCapture';
import type { PlainMutationV1 } from './syncProtocol';

export type ResearchMaterialRevisionContext = {
  revisionId: string;
  parentRevisionIds: string[];
  sourceDeviceId: string;
  sourceSequence: number;
  createdAt: number;
};

export interface ResearchMaterialsBusinessPort {
  upsert(input: {
    kind: ResearchMaterialRecordKind;
    value: ResearchMaterialRecordValue;
    revision: ResearchMaterialRevisionContext;
  }): Promise<void>;
  tombstone(input: {
    kind: ResearchMaterialRecordKind;
    materialId: string;
    deletedAt: number;
    revision: ResearchMaterialRevisionContext;
  }): Promise<void>;
}

export class ResearchMaterialsBusinessApplier
implements SyncMutationBusinessApplier {
  constructor(
    private readonly port: ResearchMaterialsBusinessPort,
  ) {}

  async applySyncMutation(mutation: PlainMutationV1) {
    assertResearchMaterialsMutationV1(mutation);
    const decoded = researchMaterialMutationValue(mutation);
    const revision = {
      revisionId: mutation.revision.id,
      parentRevisionIds: [...mutation.revision.parents],
      sourceDeviceId: mutation.sourceDeviceId,
      sourceSequence: mutation.sourceSequence,
      createdAt: mutation.createdAt,
    };
    if (mutation.revision.operation === 'delete') {
      await this.port.tombstone({
        kind: decoded.kind,
        materialId: mutation.entity.id,
        deletedAt: decoded.deletedAt!,
        revision,
      });
      return;
    }
    if (isFundResearchMaterialObjectReference(decoded.value!)) {
      return;
    }
    await this.port.upsert({
      kind: decoded.kind,
      value: decoded.value!,
      revision,
    });
  }
}

export const RESEARCH_MATERIALS_BATCH_CAPTURE_POLICY:
SyncMutationBatchCapturePolicy = {
  adapterId: 'research.materials',
  isMutationAllowed(mutation) {
    try {
      assertResearchMaterialsMutationV1(mutation);
      return true;
    } catch {
      return false;
    }
  },
};
