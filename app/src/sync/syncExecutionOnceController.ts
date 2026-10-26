import {
  bytesToBase64Url,
  canonicalizeJsonV1,
  sha256BytesV1,
} from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  SYNC_EXECUTION_CATEGORIES_V1,
  SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1,
  assertSyncExecutionClaimV1,
  assertSyncExecutionIntentV1,
  assertSyncExecutionReceiptV1,
  assertSyncExecutionStartV1,
  assertSyncExecutionStatusV1,
  signSyncExecutionRecordV1,
  verifySyncExecutionRecordSignatureV1,
  type SyncExecutionCategoryV1,
  type SyncExecutionClaimV1,
  type SyncExecutionIntentV1,
  type SyncExecutionOutcomeV1,
  type SyncExecutionReceiptV1,
  type SyncExecutionStartV1,
  type SyncExecutionStatusV1,
} from './syncExecutionLeaseProtocol';
import { assertBase64Url } from './syncProtocol';

export type SyncExecutionFenceStateV1 =
  | 'claimed'
  | 'started'
  | 'completion-prepared'
  | 'completed';

export type SyncExecutionFenceRecordV1 = {
  operationId: string;
  category: SyncExecutionCategoryV1;
  claim: SyncExecutionClaimV1;
  start: SyncExecutionStartV1 | null;
  receipt: SyncExecutionReceiptV1 | null;
  state: SyncExecutionFenceStateV1;
  createdAt: number;
  updatedAt: number;
};

type Awaitable<T> = T | Promise<T>;

export type SyncExecutionFencePortV1 = {
  load(operationId: string): Awaitable<SyncExecutionFenceRecordV1 | null>;
  saveClaimed(input: {
    category: SyncExecutionCategoryV1;
    claim: SyncExecutionClaimV1;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV1>;
  saveStarted(input: {
    start: SyncExecutionStartV1;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV1>;
  saveCompletionPrepared(input: {
    receipt: SyncExecutionReceiptV1;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV1>;
  markCompleted(input: {
    receipt: SyncExecutionReceiptV1;
    updatedAt: number;
  }): Awaitable<SyncExecutionFenceRecordV1>;
};

export type SyncExecutionEnrollmentV1 = {
  publicIdentity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
};

export type SyncExecutionRelayPortV1 = {
  createExecutionIntent(
    enrollment: SyncExecutionEnrollmentV1,
    intent: SyncExecutionIntentV1,
  ): Promise<SyncExecutionStatusV1>;
  getExecutionStatus(
    enrollment: SyncExecutionEnrollmentV1,
    operationId: string,
  ): Promise<SyncExecutionStatusV1>;
  claimExecutionIntent(
    enrollment: SyncExecutionEnrollmentV1,
    claim: SyncExecutionClaimV1,
  ): Promise<SyncExecutionStatusV1>;
  startExecution(
    enrollment: SyncExecutionEnrollmentV1,
    start: SyncExecutionStartV1,
  ): Promise<SyncExecutionStatusV1>;
  completeExecution(
    enrollment: SyncExecutionEnrollmentV1,
    receipt: SyncExecutionReceiptV1,
  ): Promise<SyncExecutionStatusV1>;
};

export type SyncExecutionOnceResultV1 =
  | {
    state: 'completed';
    outcome: SyncExecutionOutcomeV1;
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

type ExecutionOnceInputV1 = {
  intent: SyncExecutionIntentV1;
  sourceSigningPublicKey: string;
  intentRegistered?: boolean;
  leaseDurationMs?: number;
  reconcile?: () => Promise<SyncExecutionOutcomeV1 | null>;
  execute: () => Promise<SyncExecutionOutcomeV1 | void>;
};

type ActiveExecution = {
  intentJson: string;
  promise: Promise<SyncExecutionOnceResultV1>;
};

const activeExecutions = new Map<string, ActiveExecution>();

function assertTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertOperationIdentityPart(
  value: string,
  label: string,
  maximumLength: number,
) {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maximumLength
  ) {
    throw new Error(`${label} 必须是无首尾空白的非空稳定标识。`);
  }
}

function executionHttpStatus(error: unknown) {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return Number.isSafeInteger(status) ? Number(status) : null;
}

function sameRecord(left: unknown, right: unknown) {
  return canonicalizeJsonV1(left) === canonicalizeJsonV1(right);
}

function assertEnrollment(enrollment: SyncExecutionEnrollmentV1) {
  assertSyncDevicePublicIdentityV1(enrollment.publicIdentity);
  assertSyncDeviceSecretsV1(enrollment.secrets);
  if (
    enrollment.publicIdentity.vaultId !== enrollment.secrets.vaultId
    || enrollment.publicIdentity.deviceId !== enrollment.secrets.deviceId
    || enrollment.publicIdentity.keyId !== enrollment.secrets.keyId
    || enrollment.publicIdentity.state !== 'active'
    || enrollment.publicIdentity.revokedAt !== null
  ) {
    throw new Error('执行租约只允许当前 active 设备参与。');
  }
}

export function assertSyncExecutionFenceRecordV1(
  value: SyncExecutionFenceRecordV1,
) {
  assertBase64Url(value.operationId, 'execution fence operationId', {
    exactBytes: 32,
  });
  if (!SYNC_EXECUTION_CATEGORIES_V1.includes(value.category)) {
    throw new Error('execution fence category 无效。');
  }
  assertSyncExecutionClaimV1(value.claim);
  if (value.claim.operationId !== value.operationId) {
    throw new Error('execution fence claim 越界。');
  }
  if (value.start !== null) {
    assertSyncExecutionStartV1(value.start);
    if (
      value.start.operationId !== value.operationId
      || value.start.claimId !== value.claim.claimId
    ) {
      throw new Error('execution fence start 越界。');
    }
  }
  if (value.receipt !== null) {
    assertSyncExecutionReceiptV1(value.receipt);
    if (
      value.receipt.operationId !== value.operationId
      || value.receipt.claimId !== value.claim.claimId
    ) {
      throw new Error('execution fence receipt 越界。');
    }
  }
  if (
    value.state !== 'claimed'
    && value.state !== 'started'
    && value.state !== 'completion-prepared'
    && value.state !== 'completed'
  ) {
    throw new Error('execution fence state 无效。');
  }
  if (
    (value.state === 'claimed' && (value.start || value.receipt))
    || (value.state === 'started' && (!value.start || value.receipt))
    || (
      (value.state === 'completion-prepared' || value.state === 'completed')
      && (!value.start || !value.receipt)
    )
  ) {
    throw new Error('execution fence 状态内容不完整。');
  }
  assertTimestamp(value.createdAt, 'execution fence createdAt');
  assertTimestamp(value.updatedAt, 'execution fence updatedAt');
  if (value.updatedAt < value.createdAt) {
    throw new Error('execution fence 时间发生回退。');
  }
}

function assertStatusForIntent(
  status: SyncExecutionStatusV1,
  intent: SyncExecutionIntentV1,
) {
  assertSyncExecutionStatusV1(status);
  if (!sameRecord(status.intent, intent)) {
    throw new Error('中继执行状态对应了另一份 intent。');
  }
}

function completedResult(
  receipt: SyncExecutionReceiptV1,
  executedLocally: boolean,
): SyncExecutionOnceResultV1 {
  return {
    state: 'completed',
    outcome: receipt.outcome,
    executedLocally,
    executorDeviceId: receipt.executorDeviceId,
    completedAt: receipt.completedAt,
  };
}

export function createSignedSyncExecutionIntentV1(input: {
  enrollment: SyncExecutionEnrollmentV1;
  operationId: string;
  category: SyncExecutionCategoryV1;
  createdAt: number;
  notBefore?: number;
}) {
  assertEnrollment(input.enrollment);
  assertBase64Url(input.operationId, 'execution intent operationId', {
    exactBytes: 32,
  });
  if (!SYNC_EXECUTION_CATEGORIES_V1.includes(input.category)) {
    throw new Error('execution intent category 无效。');
  }
  assertTimestamp(input.createdAt, 'execution intent createdAt');
  const notBefore = input.notBefore ?? input.createdAt;
  assertTimestamp(notBefore, 'execution intent notBefore');
  const identity = input.enrollment.publicIdentity;
  const intent = signSyncExecutionRecordV1(
    SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1.intent,
    'intent',
    {
      protocolVersion: 1,
      vaultId: identity.vaultId,
      operationId: input.operationId,
      keyId: identity.keyId,
      category: input.category,
      sourceDeviceId: identity.deviceId,
      createdAt: input.createdAt,
      notBefore,
    },
    input.enrollment.secrets.signingPrivateKey,
  );
  assertSyncExecutionIntentV1(intent);
  return intent;
}

export function createSyncExecutionOperationIdV1(input: {
  category: SyncExecutionCategoryV1;
  scope: string;
  entityId: string;
  action: string;
}) {
  if (!SYNC_EXECUTION_CATEGORIES_V1.includes(input.category)) {
    throw new Error('execution operation category 无效。');
  }
  assertOperationIdentityPart(input.scope, 'execution operation scope', 128);
  assertOperationIdentityPart(input.entityId, 'execution operation entityId', 512);
  assertOperationIdentityPart(input.action, 'execution operation action', 128);
  return bytesToBase64Url(sha256BytesV1(new TextEncoder().encode(
    canonicalizeJsonV1({
      context: 'junluo.sync.v1/execution-operation-id',
      category: input.category,
      scope: input.scope,
      entityId: input.entityId,
      action: input.action,
    }),
  )));
}

export class SyncExecutionOnceControllerV1 {
  constructor(
    private readonly dependencies: {
      enrollment: SyncExecutionEnrollmentV1;
      relay: SyncExecutionRelayPortV1;
      fence: SyncExecutionFencePortV1;
      randomUuid: () => Awaitable<string>;
      randomBytes: (length: number) => Awaitable<Uint8Array>;
      now?: () => number;
    },
  ) {
    assertEnrollment(dependencies.enrollment);
  }

  execute(input: ExecutionOnceInputV1) {
    assertSyncExecutionIntentV1(input.intent);
    if (!verifySyncExecutionRecordSignatureV1(
      SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1.intent,
      'intent',
      input.intent,
      input.sourceSigningPublicKey,
    )) {
      throw new Error('执行 intent 来源签名无效。');
    }
    const operationId = input.intent.operationId;
    const intentJson = canonicalizeJsonV1(input.intent);
    const active = activeExecutions.get(operationId);
    if (active) {
      if (active.intentJson !== intentJson) {
        throw new Error('同一 operationId 正在执行另一份 intent。');
      }
      return active.promise;
    }
    const promise = this.executeExclusive(input);
    activeExecutions.set(operationId, { intentJson, promise });
    promise.finally(() => {
      if (activeExecutions.get(operationId)?.promise === promise) {
        activeExecutions.delete(operationId);
      }
    }).catch(() => undefined);
    return promise;
  }

  private async executeExclusive(
    input: ExecutionOnceInputV1,
  ): Promise<SyncExecutionOnceResultV1> {
    const { enrollment, relay, fence } = this.dependencies;
    const identity = enrollment.publicIdentity;
    const intent = input.intent;
    if (intent.vaultId !== identity.vaultId) {
      throw new Error('执行 intent 不属于当前 vault。');
    }
    const leaseDurationMs = input.leaseDurationMs ?? 30_000;
    if (
      !Number.isSafeInteger(leaseDurationMs)
      || leaseDurationMs < 5_000
      || leaseDurationMs > 300_000
    ) {
      throw new Error('执行领取时长必须在 5–300 秒之间。');
    }

    const local = await fence.load(intent.operationId);
    if (local) {
      assertSyncExecutionFenceRecordV1(local);
      if (local.category !== intent.category) {
        throw new Error('本机 execution fence category 冲突。');
      }
      if (local.state === 'completed') {
        return completedResult(local.receipt!, true);
      }
      if (local.state === 'completion-prepared') {
        const status = await relay.completeExecution(
          enrollment,
          local.receipt!,
        );
        assertStatusForIntent(status, intent);
        if (
          status.state !== 'completed'
          || !status.receipt
          || !sameRecord(status.receipt, local.receipt)
        ) {
          throw new Error('中继未确认已保存的 execution receipt。');
        }
        await fence.markCompleted({
          receipt: local.receipt!,
          updatedAt: this.readNow(),
        });
        return completedResult(local.receipt!, true);
      }
      if (local.state === 'started') {
        const reconciledOutcome = await input.reconcile?.() ?? null;
        if (reconciledOutcome !== null) {
          return this.completeStartedExecution(
            intent,
            local,
            reconciledOutcome,
          );
        }
        return {
          state: 'reconciliation-required',
          operationId: intent.operationId,
        };
      }
    }

    let status = input.intentRegistered
      ? await relay.getExecutionStatus(enrollment, intent.operationId)
      : intent.sourceDeviceId === identity.deviceId
      ? await relay.createExecutionIntent(enrollment, intent)
      : await relay.getExecutionStatus(enrollment, intent.operationId);
    assertStatusForIntent(status, intent);
    if (status.state === 'completed') {
      return completedResult(status.receipt!, false);
    }

    let claimed = local?.state === 'claimed' ? local : null;
    if (status.state === 'started') {
      if (
        !status.start
        || !status.claim
        || status.start.executorDeviceId !== identity.deviceId
        || !claimed
        || !sameRecord(status.claim, claimed.claim)
      ) {
        return {
          state: 'reconciliation-required',
          operationId: intent.operationId,
        };
      }
      claimed = await fence.saveStarted({
        start: status.start,
        updatedAt: this.readNow(),
      });
    } else {
      const now = this.readNow();
      if (intent.notBefore > now) {
        return { state: 'deferred', reason: 'not-before' };
      }
      if (
        status.state === 'claimed'
        && status.claim
        && status.leaseExpiresAt !== null
        && status.leaseExpiresAt > now
      ) {
        if (status.claim.claimantDeviceId !== identity.deviceId) {
          return {
            state: 'deferred',
            reason: 'claimed-by-another-device',
          };
        }
        if (!verifySyncExecutionRecordSignatureV1(
          SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1.claim,
          'claim',
          status.claim,
          identity.signingPublicKey,
        )) {
          throw new Error('本设备 execution claim 签名无法验证。');
        }
        claimed = await fence.saveClaimed({
          category: intent.category,
          claim: status.claim,
          updatedAt: now,
        });
      } else {
        const claimId = await this.dependencies.randomUuid();
        assertSyncUuidV4(claimId, 'execution claimId');
        const claim = signSyncExecutionRecordV1(
          SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1.claim,
          'claim',
          {
            protocolVersion: 1,
            vaultId: identity.vaultId,
            operationId: intent.operationId,
            keyId: identity.keyId,
            claimantDeviceId: identity.deviceId,
            claimId,
            requestedAt: now,
            leaseDurationMs,
          },
          enrollment.secrets.signingPrivateKey,
        );
        assertSyncExecutionClaimV1(claim);
        status = await relay.claimExecutionIntent(enrollment, claim);
        assertStatusForIntent(status, intent);
        if (
          status.state !== 'claimed'
          || !status.claim
          || !sameRecord(status.claim, claim)
        ) {
          if (
            status.state === 'claimed'
            && status.claim?.claimantDeviceId !== identity.deviceId
          ) {
            return {
              state: 'deferred',
              reason: 'claimed-by-another-device',
            };
          }
          throw new Error('中继未确认当前 execution claim。');
        }
        claimed = await fence.saveClaimed({
          category: intent.category,
          claim,
          updatedAt: now,
        });
      }
    }

    let started = claimed.state === 'started'
      ? claimed
      : null;
    if (!started) {
      const start = signSyncExecutionRecordV1(
        SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1.start,
        'start',
        {
          protocolVersion: 1,
          vaultId: identity.vaultId,
          operationId: intent.operationId,
          keyId: identity.keyId,
          executorDeviceId: identity.deviceId,
          claimId: claimed.claim.claimId,
          startedAt: this.readNow(),
        },
        enrollment.secrets.signingPrivateKey,
      );
      assertSyncExecutionStartV1(start);
      status = await relay.startExecution(enrollment, start);
      assertStatusForIntent(status, intent);
      if (
        status.state !== 'started'
        || !status.start
        || !sameRecord(status.start, start)
      ) {
        throw new Error('中继未确认 execution start 围栏。');
      }
      started = await fence.saveStarted({
        start,
        updatedAt: this.readNow(),
      });
    }

    let outcome: SyncExecutionOutcomeV1 = 'completed';
    try {
      const executionOutcome = await input.execute();
      outcome = typeof executionOutcome === 'string'
        ? executionOutcome
        : 'completed';
      if (
        outcome !== 'completed'
        && outcome !== 'failed'
        && outcome !== 'cancelled'
      ) {
        throw new Error('执行结果 outcome 无效。');
      }
    } catch {
      outcome = 'failed';
    }

    return this.completeStartedExecution(intent, started, outcome);
  }

  private async completeStartedExecution(
    intent: SyncExecutionIntentV1,
    started: SyncExecutionFenceRecordV1,
    outcome: SyncExecutionOutcomeV1,
  ): Promise<SyncExecutionOnceResultV1> {
    if (
      outcome !== 'completed'
      && outcome !== 'failed'
      && outcome !== 'cancelled'
    ) {
      throw new Error('执行结果 outcome 无效。');
    }
    const { enrollment, relay, fence } = this.dependencies;
    const identity = enrollment.publicIdentity;
    const receiptBytes = await this.dependencies.randomBytes(32);
    if (!(receiptBytes instanceof Uint8Array) || receiptBytes.length !== 32) {
      throw new Error('execution receiptId 随机源必须返回 32 字节。');
    }
    const receipt = signSyncExecutionRecordV1(
      SYNC_EXECUTION_SIGNATURE_CONTEXTS_V1.receipt,
      'receipt',
      {
        protocolVersion: 1,
        vaultId: identity.vaultId,
        operationId: intent.operationId,
        keyId: identity.keyId,
        executorDeviceId: identity.deviceId,
        claimId: started.claim.claimId,
        receiptId: bytesToBase64Url(receiptBytes),
        outcome,
        completedAt: this.readNow(),
      },
      enrollment.secrets.signingPrivateKey,
    );
    assertSyncExecutionReceiptV1(receipt);
    await fence.saveCompletionPrepared({
      receipt,
      updatedAt: this.readNow(),
    });
    const completedStatus = await relay.completeExecution(
      enrollment,
      receipt,
    );
    assertStatusForIntent(completedStatus, intent);
    if (
      completedStatus.state !== 'completed'
      || !completedStatus.receipt
      || !sameRecord(completedStatus.receipt, receipt)
    ) {
      throw new Error('中继未确认 execution receipt。');
    }
    await fence.markCompleted({
      receipt,
      updatedAt: this.readNow(),
    });
    return completedResult(receipt, true);
  }

  private readNow() {
    const value = (this.dependencies.now ?? Date.now)();
    assertTimestamp(value, 'execution now');
    return value;
  }
}

export type SyncExecutionIntentPreparationV1 = {
  operationId: string;
  category: SyncExecutionCategoryV1;
  createdAt: number;
  notBefore?: number;
};

export class SyncExecutionIntentCoordinatorV1 {
  constructor(
    private readonly dependencies: {
      enrollment: SyncExecutionEnrollmentV1;
      relay: SyncExecutionRelayPortV1;
      controller: SyncExecutionOnceControllerV1;
      resolveSigningPublicKey(
        intent: SyncExecutionIntentV1,
      ): Awaitable<string>;
    },
  ) {
    assertEnrollment(dependencies.enrollment);
  }

  async prepareIntent(input: SyncExecutionIntentPreparationV1) {
    assertBase64Url(input.operationId, 'execution operationId', {
      exactBytes: 32,
    });
    if (!SYNC_EXECUTION_CATEGORIES_V1.includes(input.category)) {
      throw new Error('execution category 无效。');
    }
    assertTimestamp(input.createdAt, 'execution createdAt');
    const notBefore = input.notBefore ?? input.createdAt;
    assertTimestamp(notBefore, 'execution notBefore');

    let status: SyncExecutionStatusV1 | null;
    try {
      status = await this.dependencies.relay.getExecutionStatus(
        this.dependencies.enrollment,
        input.operationId,
      );
    } catch (error) {
      if (executionHttpStatus(error) !== 404) throw error;
      status = null;
    }

    if (!status) {
      const intent = createSignedSyncExecutionIntentV1({
        enrollment: this.dependencies.enrollment,
        operationId: input.operationId,
        category: input.category,
        createdAt: input.createdAt,
        notBefore,
      });
      try {
        status = await this.dependencies.relay.createExecutionIntent(
          this.dependencies.enrollment,
          intent,
        );
      } catch (error) {
        if (executionHttpStatus(error) !== 409) throw error;
        status = await this.dependencies.relay.getExecutionStatus(
          this.dependencies.enrollment,
          input.operationId,
        );
      }
    }

    assertSyncExecutionStatusV1(status);
    const intent = status.intent;
    if (
      intent.vaultId !== this.dependencies.enrollment.publicIdentity.vaultId
      || intent.operationId !== input.operationId
      || intent.category !== input.category
      || intent.createdAt !== input.createdAt
      || intent.notBefore !== notBefore
    ) {
      throw new Error('同一 execution operationId 对应了另一份业务意图。');
    }
    return {
      intent,
      sourceSigningPublicKey:
        await this.dependencies.resolveSigningPublicKey(intent),
    };
  }

  async execute(input: SyncExecutionIntentPreparationV1 & {
    leaseDurationMs?: number;
    reconcile?: () => Promise<SyncExecutionOutcomeV1 | null>;
    execute: () => Promise<SyncExecutionOutcomeV1 | void>;
  }) {
    const prepared = await this.prepareIntent(input);
    return this.dependencies.controller.execute({
      ...prepared,
      intentRegistered: true,
      leaseDurationMs: input.leaseDurationMs,
      reconcile: input.reconcile,
      execute: input.execute,
    });
  }
}
