import {
  assertFundResearchMaterialObjectReference,
  assertResearchMaterialRecord,
  buildResearchMaterialUpsertMutation,
  type FundResearchMaterialObjectReference,
  type FundResearchPayloadObjectV1,
  type ResearchMaterialRecordKind,
  type ResearchMaterialRecordValue,
  type ResearchMaterialsMutationEnvelope,
} from './syncResearchMaterials';
import type { PlainMutationV1 } from './syncProtocol';

export type ResearchMaterialsBackendOutboxState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'quarantined';

export type ResearchMaterialsBackendOutboxEntry = {
  localSequence: number;
  eventId: string;
  materialKind: ResearchMaterialRecordKind;
  materialId: string;
  payload: ResearchMaterialRecordValue;
  state: ResearchMaterialsBackendOutboxState;
  attemptCount: number;
  availableAt: number;
  leaseId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
};

export type ClaimedResearchMaterialsBackendOutboxEntry =
  ResearchMaterialsBackendOutboxEntry & {
    state: 'leased';
    leaseId: string;
    leaseExpiresAt: number;
  };

export interface ResearchMaterialsBackendOutboxPort {
  claimPending(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedResearchMaterialsBackendOutboxEntry[]>;
  markDispatched(input: {
    localSequence: number;
    leaseId: string;
    dispatchedAt: number;
  }): Promise<void>;
  releaseFailed(input: {
    localSequence: number;
    leaseId: string;
    failedAt: number;
    retryAt: number;
    errorCode: string;
  }): Promise<void>;
}

export type ResearchMaterialsBackendEnvelopeFactory = (
  entity: {
    domain: 'research';
    type: ResearchMaterialRecordKind;
    id: string;
  },
  createdAt: number,
) => Promise<ResearchMaterialsMutationEnvelope>;

export type ResearchMaterialsBackendPromotionReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{
    localSequence: number;
    errorCode: string;
  }>;
};

export type ResearchMaterialsBackendClaimResponseV1 = {
  entries: ClaimedResearchMaterialsBackendOutboxEntry[];
  deferredObjectCount: number;
};

export type ClaimedResearchMaterialsBackendObjectEntry = {
  localSequence: number;
  eventId: string;
  materialKind: 'fund-material';
  materialId: string;
  cacheKey: string;
  source: string;
  fetchedAt: number;
  expiresAt: number;
  staleAllowed: boolean;
  payloadBytes: number;
  payloadSha256: string;
  state: 'leased';
  attemptCount: number;
  leaseId: string;
  leaseExpiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type ResearchMaterialsBackendObjectChunkV1 = {
  localSequence: number;
  offset: number;
  nextOffset: number;
  totalBytes: number;
  payloadSha256: string;
  data: string;
  complete: boolean;
};

export interface ResearchMaterialsBackendObjectPort {
  claimObjects(input: {
    leaseId: string;
    now: number;
    leaseDurationMs: number;
    limit: number;
  }): Promise<ClaimedResearchMaterialsBackendObjectEntry[]>;
  readObjectChunk(input: {
    localSequence: number;
    leaseId: string;
    offset: number;
    maximumBytes: number;
  }): Promise<ResearchMaterialsBackendObjectChunkV1>;
  markObjectDispatched(input: {
    localSequence: number;
    leaseId: string;
    dispatchedAt: number;
  }): Promise<void>;
  releaseObjectFailed(input: {
    localSequence: number;
    leaseId: string;
    failedAt: number;
    errorCode: string;
  }): Promise<void>;
}

export type ResearchMaterialsBackendObjectPromotionReport = {
  claimedCount: number;
  dispatchedCount: number;
  failed: Array<{
    localSequence: number;
    errorCode: string;
  }>;
};

function recordOf(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const expectedSet = new Set(expected);
  const extras = Object.keys(value).filter((key) => !expectedSet.has(key));
  const missing = expected.filter((key) => !(key in value));
  if (extras.length || missing.length) {
    throw new Error(`${label} 字段不符合严格合同。`);
  }
}

function assertSafeInteger(
  value: unknown,
  label: string,
  minimum = 0,
) {
  if (
    !Number.isSafeInteger(value)
    || Number(value) < minimum
  ) {
    throw new Error(`${label} 无效。`);
  }
}

function assertBase64Url32(value: unknown, label: string) {
  if (
    typeof value !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(value)
  ) {
    throw new Error(`${label} 无效。`);
  }
}

export function assertResearchMaterialsBackendOutboxEntry(
  value: unknown,
): asserts value is ResearchMaterialsBackendOutboxEntry {
  const entry = recordOf(value, 'research backend outbox entry');
  assertExactKeys(entry, [
    'localSequence', 'eventId', 'materialKind', 'materialId',
    'payload', 'state', 'attemptCount', 'availableAt', 'leaseId',
    'leaseExpiresAt', 'createdAt', 'updatedAt', 'lastError',
  ], 'research backend outbox entry');
  const typed = entry as ResearchMaterialsBackendOutboxEntry;
  assertSafeInteger(typed.localSequence, 'localSequence', 1);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(typed.eventId)
  ) {
    throw new Error('research backend eventId 无效。');
  }
  assertResearchMaterialRecord(typed.materialKind, typed.payload);
  if (typed.payload.materialId !== typed.materialId) {
    throw new Error('research backend materialId 与 payload 不一致。');
  }
  if (
    !['pending', 'leased', 'dispatched', 'quarantined']
      .includes(typed.state)
  ) {
    throw new Error('research backend outbox state 无效。');
  }
  assertSafeInteger(typed.attemptCount, 'attemptCount');
  assertSafeInteger(typed.availableAt, 'availableAt');
  assertSafeInteger(typed.createdAt, 'createdAt');
  assertSafeInteger(typed.updatedAt, 'updatedAt');
  if (
    typed.leaseExpiresAt !== null
    && (
      !Number.isSafeInteger(typed.leaseExpiresAt)
      || typed.leaseExpiresAt < 0
    )
  ) {
    throw new Error('research backend leaseExpiresAt 无效。');
  }
  if (
    typed.state === 'leased'
    && (
      !typed.leaseId
      || typed.leaseExpiresAt === null
    )
  ) {
    throw new Error('research backend leased 状态缺少租约。');
  }
  if (
    (typed.leaseId !== null && (
      typeof typed.leaseId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(typed.leaseId)
    ))
    || (typed.lastError !== null && typeof typed.lastError !== 'string')
  ) {
    throw new Error('research backend outbox 技术字段无效。');
  }
}

export function parseResearchMaterialsBackendClaimResponse(
  value: unknown,
): ResearchMaterialsBackendClaimResponseV1 {
  const response = recordOf(value, 'research backend claim response');
  assertExactKeys(
    response,
    ['entries', 'deferredObjectCount'],
    'research backend claim response',
  );
  if (!Array.isArray(response.entries) || response.entries.length > 4) {
    throw new Error('research backend claim entries 数量无效。');
  }
  response.entries.forEach(assertResearchMaterialsBackendOutboxEntry);
  if (response.entries.some((entry) => entry.state !== 'leased')) {
    throw new Error('research backend claim 只能返回 leased 条目。');
  }
  assertSafeInteger(response.deferredObjectCount, 'deferredObjectCount');
  return {
    entries: response.entries,
    deferredObjectCount: Number(response.deferredObjectCount),
  };
}

export function parseResearchMaterialsBackendObjectClaimResponse(
  value: unknown,
) {
  const response = recordOf(value, 'research object claim response');
  assertExactKeys(
    response,
    ['entries'],
    'research object claim response',
  );
  if (!Array.isArray(response.entries) || response.entries.length > 4) {
    throw new Error('research object claim entries 数量无效。');
  }
  const entries = response.entries.map((candidate) => {
    const entry = recordOf(candidate, 'research object entry');
    assertExactKeys(entry, [
      'localSequence', 'eventId', 'materialKind', 'materialId',
      'cacheKey', 'source', 'fetchedAt', 'expiresAt',
      'staleAllowed', 'payloadBytes', 'payloadSha256', 'state',
      'attemptCount', 'leaseId', 'leaseExpiresAt', 'createdAt',
      'updatedAt',
    ], 'research object entry');
    assertSafeInteger(entry.localSequence, 'localSequence', 1);
    if (
      typeof entry.eventId !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        .test(entry.eventId)
      || entry.materialKind !== 'fund-material'
      || typeof entry.materialId !== 'string'
      || !/^[A-Za-z0-9_-]{43}$/.test(entry.materialId)
      || typeof entry.cacheKey !== 'string'
      || entry.cacheKey.length < 1
      || entry.cacheKey.length > 300
      || typeof entry.source !== 'string'
      || entry.source.length < 1
      || entry.source.length > 80
      || typeof entry.staleAllowed !== 'boolean'
      || entry.state !== 'leased'
      || typeof entry.leaseId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,160}$/.test(entry.leaseId)
    ) {
      throw new Error('research object entry 字段无效。');
    }
    assertSafeInteger(entry.fetchedAt, 'fetchedAt');
    assertSafeInteger(entry.expiresAt, 'expiresAt');
    if (Number(entry.expiresAt) < Number(entry.fetchedAt)) {
      throw new Error('research object expiresAt 早于 fetchedAt。');
    }
    assertSafeInteger(entry.payloadBytes, 'payloadBytes', 1);
    assertBase64Url32(entry.payloadSha256, 'payloadSha256');
    assertSafeInteger(entry.attemptCount, 'attemptCount', 1);
    assertSafeInteger(entry.leaseExpiresAt, 'leaseExpiresAt');
    assertSafeInteger(entry.createdAt, 'createdAt');
    assertSafeInteger(entry.updatedAt, 'updatedAt');
    return entry as ClaimedResearchMaterialsBackendObjectEntry;
  });
  return { entries };
}

export function parseResearchMaterialsBackendObjectChunk(
  value: unknown,
): ResearchMaterialsBackendObjectChunkV1 {
  const chunk = recordOf(value, 'research object chunk');
  assertExactKeys(chunk, [
    'localSequence', 'offset', 'nextOffset', 'totalBytes',
    'payloadSha256', 'data', 'complete',
  ], 'research object chunk');
  assertSafeInteger(chunk.localSequence, 'localSequence', 1);
  assertSafeInteger(chunk.offset, 'offset');
  assertSafeInteger(chunk.nextOffset, 'nextOffset');
  assertSafeInteger(chunk.totalBytes, 'totalBytes', 1);
  assertBase64Url32(chunk.payloadSha256, 'payloadSha256');
  if (
    typeof chunk.data !== 'string'
    || !/^[A-Za-z0-9_-]+$/.test(chunk.data)
    || typeof chunk.complete !== 'boolean'
    || Number(chunk.nextOffset) <= Number(chunk.offset)
    || Number(chunk.nextOffset) > Number(chunk.totalBytes)
    || chunk.complete
      !== (Number(chunk.nextOffset) === Number(chunk.totalBytes))
  ) {
    throw new Error('research object chunk 字段无效。');
  }
  return chunk as ResearchMaterialsBackendObjectChunkV1;
}

export function materializeResearchMaterialsBackendMutation(input: {
  entry: ResearchMaterialsBackendOutboxEntry;
  envelope: ResearchMaterialsMutationEnvelope;
}) {
  assertResearchMaterialsBackendOutboxEntry(input.entry);
  return buildResearchMaterialUpsertMutation({
    envelope: input.envelope,
    kind: input.entry.materialKind,
    value: input.entry.payload,
  });
}

function compactErrorCode(value: unknown) {
  const raw = value instanceof Error
    ? value.message
    : String(value ?? 'unknown');
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
  return normalized || 'unknown';
}

export async function promoteResearchMaterialsBackendOutbox(input: {
  port: ResearchMaterialsBackendOutboxPort;
  envelopeFactory: ResearchMaterialsBackendEnvelopeFactory;
  enqueueCentralMutation(mutation: PlainMutationV1): Promise<void>;
  leaseId: string;
  now: number;
  leaseDurationMs: number;
  retryDelayMs: number;
  limit: number;
}): Promise<ResearchMaterialsBackendPromotionReport> {
  const claimed = await input.port.claimPending({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: ResearchMaterialsBackendPromotionReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const entry of claimed) {
    try {
      assertResearchMaterialsBackendOutboxEntry(entry);
      const envelope = await input.envelopeFactory({
        domain: 'research',
        type: entry.materialKind,
        id: entry.materialId,
      }, entry.createdAt);
      await input.enqueueCentralMutation(
        materializeResearchMaterialsBackendMutation({
          entry,
          envelope,
        }),
      );
      await input.port.markDispatched({
        localSequence: entry.localSequence,
        leaseId: entry.leaseId,
        dispatchedAt: input.now,
      });
      report.dispatchedCount += 1;
    } catch (error) {
      const errorCode = compactErrorCode(error);
      report.failed.push({
        localSequence: entry.localSequence,
        errorCode,
      });
      await input.port.releaseFailed({
        localSequence: entry.localSequence,
        leaseId: entry.leaseId,
        failedAt: input.now,
        retryAt: input.now + Math.max(1, input.retryDelayMs),
        errorCode,
      });
    }
  }
  return report;
}

export async function promoteResearchMaterialsBackendObjects(input: {
  port: ResearchMaterialsBackendObjectPort;
  envelopeFactory: ResearchMaterialsBackendEnvelopeFactory;
  captureObject(
    entry: ClaimedResearchMaterialsBackendObjectEntry,
    port: ResearchMaterialsBackendObjectPort,
  ): Promise<FundResearchPayloadObjectV1>;
  enqueueCentralMutation(mutation: PlainMutationV1): Promise<void>;
  leaseId: string;
  now: number;
  leaseDurationMs: number;
  limit: number;
}): Promise<ResearchMaterialsBackendObjectPromotionReport> {
  const claimed = await input.port.claimObjects({
    leaseId: input.leaseId,
    now: input.now,
    leaseDurationMs: input.leaseDurationMs,
    limit: input.limit,
  });
  const report: ResearchMaterialsBackendObjectPromotionReport = {
    claimedCount: claimed.length,
    dispatchedCount: 0,
    failed: [],
  };
  for (const entry of claimed) {
    try {
      const payloadObject = await input.captureObject(
        entry,
        input.port,
      );
      if (
        payloadObject.plaintextBytes !== entry.payloadBytes
        || payloadObject.plaintextSha256 !== entry.payloadSha256
      ) {
        throw new Error('research-object-digest-mismatch');
      }
      const value: FundResearchMaterialObjectReference = {
        materialId: entry.materialId,
        cacheKey: entry.cacheKey,
        payloadObject,
        source: entry.source,
        fetchedAt: entry.fetchedAt,
        expiresAt: entry.expiresAt,
        staleAllowed: entry.staleAllowed,
      };
      assertFundResearchMaterialObjectReference(value);
      const envelope = await input.envelopeFactory({
        domain: 'research',
        type: 'fund-material',
        id: entry.materialId,
      }, entry.createdAt);
      await input.enqueueCentralMutation(
        buildResearchMaterialUpsertMutation({
          envelope,
          kind: 'fund-material',
          value,
        }),
      );
      await input.port.markObjectDispatched({
        localSequence: entry.localSequence,
        leaseId: entry.leaseId,
        dispatchedAt: input.now,
      });
      report.dispatchedCount += 1;
    } catch (error) {
      const errorCode = compactErrorCode(error);
      report.failed.push({
        localSequence: entry.localSequence,
        errorCode,
      });
      await input.port.releaseObjectFailed({
        localSequence: entry.localSequence,
        leaseId: entry.leaseId,
        failedAt: input.now,
        errorCode,
      });
    }
  }
  return report;
}
