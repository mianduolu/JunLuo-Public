import { canonicalizeJsonV1 } from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  assertSyncExecutionClaimV2,
  assertSyncExecutionCompleteRequestV2,
  type SyncExecutionClaimV2,
  type SyncExecutionCompleteRequestV2,
  type SyncExecutionOutcomeV2,
} from './syncExecutionClaimV2Protocol';
import {
  SYNC_EXECUTION_CATEGORIES,
  type SyncExecutionCategory,
} from './syncExecutionOperationId';
import { assertBase64Url } from './syncProtocol';

type Awaitable<T> = T | Promise<T>;

export type SyncExecutionEnrollmentV2 = {
  publicIdentity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
};

export type SyncExecutionFenceStateV2 =
  | 'claimed'
  | 'started'
  | 'completion-prepared'
  | 'completed';

export type SyncExecutionFenceRecordV2 = {
  protocolVersion: 2;
  operationId: string;
  category: SyncExecutionCategory;
  claim: SyncExecutionClaimV2;
  start: SyncExecutionClaimV2 | null;
  completion: SyncExecutionCompleteRequestV2 | SyncExecutionClaimV2 | null;
  state: SyncExecutionFenceStateV2;
  createdAt: number;
  updatedAt: number;
};

export type SyncExecutionLegacyFenceMarker = {
  protocolVersion: 1;
  operationId: string;
};

export type SyncExecutionFencePortV2 = {
  load(operationId: string): Awaitable<
    SyncExecutionFenceRecordV2 | SyncExecutionLegacyFenceMarker | null
  >;
  saveClaimed(input: {
    category: SyncExecutionCategory;
    claim: SyncExecutionClaimV2;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV2>;
  saveStarted(input: {
    start: SyncExecutionClaimV2;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV2>;
  saveCompletionPrepared(input: {
    operationId: string;
    completion: SyncExecutionCompleteRequestV2;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV2>;
  markCompleted(input: {
    completed: SyncExecutionClaimV2;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV2>;
};

export type SyncExecutionRelayPortV2 = {
  getExecutionClaimV2(
    enrollment: SyncExecutionEnrollmentV2,
    operationId: string,
  ): Promise<SyncExecutionClaimV2>;
  claimExecutionV2(
    enrollment: SyncExecutionEnrollmentV2,
    operationId: string,
  ): Promise<SyncExecutionClaimV2>;
  startExecutionV2(
    enrollment: SyncExecutionEnrollmentV2,
    operationId: string,
    claimId: string,
  ): Promise<SyncExecutionClaimV2>;
  completeExecutionV2(
    enrollment: SyncExecutionEnrollmentV2,
    operationId: string,
    completion: SyncExecutionCompleteRequestV2,
  ): Promise<SyncExecutionClaimV2>;
};

export type SyncExecutionOnceResultV2 =
  | {
    state: 'completed';
    outcome: SyncExecutionOutcomeV2;
    executedLocally: boolean;
    executorDeviceId: string;
    completedAt: number;
  }
  | {
    state: 'deferred';
    reason: 'not-before' | 'claimed-by-another-device';
  }
  | {
    state: 'reconciliation-required';
    operationId: string;
  };

export type SyncExecutionOnceInputV2 = {
  operationId: string;
  category: SyncExecutionCategory;
  createdAt: number;
  notBefore?: number;
  reconcile?: () => Promise<SyncExecutionOutcomeV2 | null>;
  execute: () => Promise<SyncExecutionOutcomeV2 | void>;
};

type ActiveExecution = {
  identityJson: string;
  promise: Promise<SyncExecutionOnceResultV2>;
};

const activeExecutions = new Map<string, ActiveExecution>();

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function executionHttpStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  return Number.isSafeInteger(status) ? Number(status) : null;
}

function assertEnrollment(enrollment: SyncExecutionEnrollmentV2) {
  assertSyncDevicePublicIdentityV1(enrollment.publicIdentity);
  assertSyncDeviceSecretsV1(enrollment.secrets);
  if (
    enrollment.publicIdentity.vaultId !== enrollment.secrets.vaultId
    || enrollment.publicIdentity.deviceId !== enrollment.secrets.deviceId
    || enrollment.publicIdentity.keyId !== enrollment.secrets.keyId
    || enrollment.publicIdentity.state !== 'active'
    || enrollment.publicIdentity.revokedAt !== null
  ) {
    throw new Error('轻量执行认领只允许当前 active 设备参与。');
  }
}

function assertInput(input: SyncExecutionOnceInputV2) {
  assertBase64Url(input.operationId, 'execution operationId', { exactBytes: 32 });
  if (!SYNC_EXECUTION_CATEGORIES.includes(input.category)) {
    throw new Error('execution category 无效。');
  }
  assertTimestamp(input.createdAt, 'execution createdAt');
  assertTimestamp(input.notBefore ?? input.createdAt, 'execution notBefore');
}

function assertScopedStatus(
  status: SyncExecutionClaimV2,
  operationId: string,
) {
  assertSyncExecutionClaimV2(status);
  if (status.operationId !== operationId) {
    throw new Error('中继轻量认领响应对应了另一项操作。');
  }
}

function completedResult(
  completed: SyncExecutionClaimV2,
  executedLocally: boolean,
): SyncExecutionOnceResultV2 {
  assertScopedStatus(completed, completed.operationId);
  if (
    completed.state !== 'completed'
    || completed.outcome === null
    || completed.completedAt === null
  ) {
    throw new Error('中继没有返回完整的执行完成状态。');
  }
  return {
    state: 'completed',
    outcome: completed.outcome,
    executedLocally,
    executorDeviceId: completed.claimantDeviceId,
    completedAt: completed.completedAt,
  };
}

export function assertSyncExecutionFenceRecordV2(
  value: SyncExecutionFenceRecordV2,
) {
  if (value.protocolVersion !== 2) throw new Error('execution fence v2 版本无效。');
  assertBase64Url(value.operationId, 'execution fence v2 operationId', { exactBytes: 32 });
  if (!SYNC_EXECUTION_CATEGORIES.includes(value.category)) {
    throw new Error('execution fence v2 category 无效。');
  }
  assertScopedStatus(value.claim, value.operationId);
  if (value.start !== null) {
    assertScopedStatus(value.start, value.operationId);
    if (value.start.claimId !== value.claim.claimId || value.start.state === 'claimed') {
      throw new Error('execution fence v2 start 与 claim 不一致。');
    }
  }
  if (value.completion !== null) {
    if ('operationId' in value.completion) {
      assertScopedStatus(value.completion, value.operationId);
      if (value.completion.state !== 'completed') {
        throw new Error('execution fence v2 完成状态无效。');
      }
    } else {
      assertSyncExecutionCompleteRequestV2(value.completion);
      if (value.completion.claimId !== value.claim.claimId) {
        throw new Error('execution fence v2 完成请求与 claim 不一致。');
      }
    }
  }
  if (
    value.state === 'claimed'
      ? value.start !== null || value.completion !== null
      : value.state === 'started'
        ? value.start === null || value.completion !== null
        : value.state === 'completion-prepared'
          ? value.start === null || value.completion === null || 'operationId' in value.completion
          : value.state === 'completed'
            ? value.start === null || value.completion === null || !('operationId' in value.completion)
            : true
  ) {
    throw new Error('execution fence v2 状态内容不完整。');
  }
  assertTimestamp(value.createdAt, 'execution fence v2 createdAt');
  assertTimestamp(value.updatedAt, 'execution fence v2 updatedAt');
  if (value.updatedAt < value.createdAt) throw new Error('execution fence v2 时间发生回退。');
}

export class SyncExecutionOnceCoordinatorV2 {
  constructor(
    private readonly dependencies: {
      enrollment: SyncExecutionEnrollmentV2;
      relay: SyncExecutionRelayPortV2;
      fence: SyncExecutionFencePortV2;
      executeLegacy?: (
        input: SyncExecutionOnceInputV2,
      ) => Promise<SyncExecutionOnceResultV2>;
      now?: () => number;
    },
  ) {
    assertEnrollment(dependencies.enrollment);
  }

  execute(input: SyncExecutionOnceInputV2) {
    assertInput(input);
    const activeKey = `${this.dependencies.enrollment.publicIdentity.deviceId}\u0000${input.operationId}`;
    const identityJson = canonicalizeJsonV1({
      operationId: input.operationId,
      category: input.category,
      createdAt: input.createdAt,
      notBefore: input.notBefore ?? input.createdAt,
    });
    const active = activeExecutions.get(activeKey);
    if (active) {
      if (active.identityJson !== identityJson) {
        throw new Error('同一 operationId 正在执行另一份业务意图。');
      }
      return active.promise;
    }
    const promise = this.executeInternal(input).finally(() => {
      if (activeExecutions.get(activeKey)?.promise === promise) {
        activeExecutions.delete(activeKey);
      }
    });
    activeExecutions.set(activeKey, { identityJson, promise });
    return promise;
  }

  private async executeInternal(
    input: SyncExecutionOnceInputV2,
  ): Promise<SyncExecutionOnceResultV2> {
    const { enrollment, relay, fence } = this.dependencies;
    const deviceId = enrollment.publicIdentity.deviceId;
    const now = this.readNow();
    if ((input.notBefore ?? input.createdAt) > now) {
      return { state: 'deferred', reason: 'not-before' };
    }

    const local = await fence.load(input.operationId);
    if (local?.protocolVersion === 1) return this.executeLegacy(input);
    if (local?.state === 'completed') {
      return completedResult(local.completion as SyncExecutionClaimV2, false);
    }

    const reconciledBeforeClaim = await input.reconcile?.() ?? null;
    if (local?.state === 'started') {
      if (reconciledBeforeClaim === null) {
        return { state: 'reconciliation-required', operationId: input.operationId };
      }
      return this.finish(local, reconciledBeforeClaim, false);
    }
    if (local?.state === 'completion-prepared') {
      return this.submitPrepared(local, false);
    }

    let remote: SyncExecutionClaimV2 | null = null;
    try {
      remote = await relay.getExecutionClaimV2(enrollment, input.operationId);
      assertScopedStatus(remote, input.operationId);
    } catch (error) {
      const status = executionHttpStatus(error);
      if (status === 409) return this.executeLegacy(input);
      if (status !== 404) throw error;
    }

    if (remote?.state === 'completed') return completedResult(remote, false);
    const remoteClaimHasExpired = remote?.state === 'claimed'
      && (remote.leaseExpiresAt ?? 0) <= now;
    if (remote && remote.claimantDeviceId !== deviceId && !remoteClaimHasExpired) {
      return { state: 'deferred', reason: 'claimed-by-another-device' };
    }
    if (!remote || (remote.state === 'claimed' && (remote.leaseExpiresAt ?? 0) <= now)) {
      try {
        remote = await relay.claimExecutionV2(enrollment, input.operationId);
        assertScopedStatus(remote, input.operationId);
      } catch (error) {
        if (executionHttpStatus(error) === 409) return this.executeLegacy(input);
        try {
          remote = await relay.getExecutionClaimV2(enrollment, input.operationId);
          assertScopedStatus(remote, input.operationId);
        } catch {
          throw error;
        }
      }
    }
    if (remote.state === 'completed') return completedResult(remote, false);
    if (remote.claimantDeviceId !== deviceId) {
      return { state: 'deferred', reason: 'claimed-by-another-device' };
    }
    if (remote.state === 'started') {
      if (reconciledBeforeClaim === null) {
        return { state: 'reconciliation-required', operationId: input.operationId };
      }
      const claimed = local ?? await fence.saveClaimed({
        category: input.category,
        claim: remote,
        updatedAt: this.readNow(),
      });
      const started = claimed.state === 'started'
        ? claimed
        : await fence.saveStarted({ start: remote, updatedAt: this.readNow() });
      return this.finish(started, reconciledBeforeClaim, false);
    }

    let claimed = local ?? await fence.saveClaimed({
      category: input.category,
      claim: remote,
      updatedAt: this.readNow(),
    });
    if (claimed.claim.claimId !== remote.claimId) {
      claimed = await fence.saveClaimed({
        category: input.category,
        claim: remote,
        updatedAt: this.readNow(),
      });
    }

    let startedRemote: SyncExecutionClaimV2;
    try {
      startedRemote = await relay.startExecutionV2(
        enrollment,
        input.operationId,
        remote.claimId,
      );
    } catch (error) {
      try {
        startedRemote = await relay.getExecutionClaimV2(enrollment, input.operationId);
      } catch {
        throw error;
      }
    }
    assertScopedStatus(startedRemote, input.operationId);
    if (startedRemote.state === 'completed') return completedResult(startedRemote, false);
    if (
      startedRemote.state !== 'started'
      || startedRemote.claimantDeviceId !== deviceId
      || startedRemote.claimId !== remote.claimId
    ) {
      throw new Error('中继未确认当前设备的 execution start。');
    }
    const started = await fence.saveStarted({
      start: startedRemote,
      updatedAt: this.readNow(),
    });

    const reconciledAfterStart = await input.reconcile?.() ?? reconciledBeforeClaim;
    let outcome = reconciledAfterStart;
    let executedLocally = false;
    if (outcome === null) {
      executedLocally = true;
      try {
        const executedOutcome = await input.execute();
        outcome = executedOutcome === 'failed' || executedOutcome === 'cancelled'
          ? executedOutcome
          : 'completed';
      } catch {
        outcome = 'failed';
      }
    }
    return this.finish(started, outcome, executedLocally);
  }

  private async finish(
    started: SyncExecutionFenceRecordV2,
    outcome: SyncExecutionOutcomeV2,
    executedLocally: boolean,
  ) {
    const completion: SyncExecutionCompleteRequestV2 = {
      protocolVersion: 2,
      claimId: started.claim.claimId,
      outcome,
    };
    const prepared = await this.dependencies.fence.saveCompletionPrepared({
      operationId: started.operationId,
      completion,
      updatedAt: this.readNow(),
    });
    return this.submitPrepared(prepared, executedLocally);
  }

  private async submitPrepared(
    prepared: SyncExecutionFenceRecordV2,
    executedLocally: boolean,
  ) {
    const completion = prepared.completion as SyncExecutionCompleteRequestV2;
    let completed: SyncExecutionClaimV2;
    try {
      completed = await this.dependencies.relay.completeExecutionV2(
        this.dependencies.enrollment,
        prepared.operationId,
        completion,
      );
    } catch (error) {
      try {
        completed = await this.dependencies.relay.getExecutionClaimV2(
          this.dependencies.enrollment,
          prepared.operationId,
        );
      } catch {
        throw error;
      }
    }
    assertScopedStatus(completed, prepared.operationId);
    if (
      completed.state !== 'completed'
      || completed.claimId !== completion.claimId
      || completed.outcome !== completion.outcome
    ) {
      throw new Error('中继未确认一致的 execution completion。');
    }
    await this.dependencies.fence.markCompleted({
      completed,
      updatedAt: this.readNow(),
    });
    return completedResult(completed, executedLocally);
  }

  private executeLegacy(input: SyncExecutionOnceInputV2) {
    if (!this.dependencies.executeLegacy) {
      return Promise.resolve<SyncExecutionOnceResultV2>({
        state: 'reconciliation-required',
        operationId: input.operationId,
      });
    }
    return this.dependencies.executeLegacy(input);
  }

  private readNow() {
    const value = (this.dependencies.now ?? Date.now)();
    assertTimestamp(value, 'execution now');
    return value;
  }
}
