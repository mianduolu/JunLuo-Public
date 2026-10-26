import type {
  ResearchMaterialsBackendObjectPort,
  ResearchMaterialsBackendOutboxPort,
} from './syncResearchMaterialsBackendOutbox';
import type {
  SyncRelayActiveEnrollmentV1,
  SyncRelayClient,
} from './syncRelayClient';

type ResearchMaterialsBackendRelayClient = Pick<
  SyncRelayClient,
  | 'claimResearchMaterialsBackendOutbox'
  | 'markResearchMaterialsBackendOutboxDispatched'
  | 'releaseResearchMaterialsBackendOutbox'
>;

type ResearchMaterialsBackendObjectRelayClient = Pick<
  SyncRelayClient,
  | 'claimResearchMaterialsBackendObjects'
  | 'readResearchMaterialsBackendObjectChunk'
  | 'markResearchMaterialsBackendOutboxDispatched'
  | 'releaseResearchMaterialsBackendObject'
>;

export class ResearchMaterialsBackendRelayOutboxPort
implements ResearchMaterialsBackendOutboxPort {
  deferredObjectCount = 0;

  constructor(
    private readonly relay: ResearchMaterialsBackendRelayClient,
    private readonly enrollment: SyncRelayActiveEnrollmentV1,
  ) {}

  async claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }) {
    const response = await this.relay
      .claimResearchMaterialsBackendOutbox(this.enrollment, {
        leaseId: input.leaseId,
        leaseDurationMs: input.leaseDurationMs,
        limit: input.limit,
      });
    this.deferredObjectCount = response.deferredObjectCount;
    return response.entries;
  }

  async markDispatched(input: {
    localSequence: number;
    leaseId: string;
    dispatchedAt: number;
  }) {
    await this.relay.markResearchMaterialsBackendOutboxDispatched(
      this.enrollment,
      {
        localSequence: input.localSequence,
        leaseId: input.leaseId,
      },
    );
  }

  async releaseFailed(input: {
    localSequence: number;
    leaseId: string;
    failedAt: number;
    retryAt: number;
    errorCode: string;
  }) {
    await this.relay.releaseResearchMaterialsBackendOutbox(
      this.enrollment,
      {
        localSequence: input.localSequence,
        leaseId: input.leaseId,
        retryDelayMs: Math.max(1, input.retryAt - input.failedAt),
        errorCode: input.errorCode,
      },
    );
  }
}

export class ResearchMaterialsBackendRelayObjectPort
implements ResearchMaterialsBackendObjectPort {
  constructor(
    private readonly relay:
      ResearchMaterialsBackendObjectRelayClient,
    private readonly enrollment:
      SyncRelayActiveEnrollmentV1,
  ) {}

  async claimObjects(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }) {
    return (
      await this.relay.claimResearchMaterialsBackendObjects(
        this.enrollment,
        {
          leaseId: input.leaseId,
          leaseDurationMs: input.leaseDurationMs,
          limit: input.limit,
        },
      )
    ).entries;
  }

  readObjectChunk(input: {
    localSequence: number;
    leaseId: string;
    offset: number;
    maximumBytes: number;
  }) {
    return this.relay.readResearchMaterialsBackendObjectChunk(
      this.enrollment,
      input,
    );
  }

  async markObjectDispatched(input: {
    localSequence: number;
    leaseId: string;
    dispatchedAt: number;
  }) {
    await this.relay.markResearchMaterialsBackendOutboxDispatched(
      this.enrollment,
      {
        localSequence: input.localSequence,
        leaseId: input.leaseId,
      },
    );
  }

  async releaseObjectFailed(input: {
    localSequence: number;
    leaseId: string;
    failedAt: number;
    errorCode: string;
  }) {
    await this.relay.releaseResearchMaterialsBackendObject(
      this.enrollment,
      {
        localSequence: input.localSequence,
        leaseId: input.leaseId,
        errorCode: input.errorCode,
      },
    );
  }
}
