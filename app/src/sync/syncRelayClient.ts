import {
  canonicalizeJsonV1,
} from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  assertSyncUuidV4,
  normalizeSyncDeviceDisplayName,
  sameSyncDeviceIdentityExceptDisplayNameV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  assertSyncPairingPackageV1,
  assertSyncPairingRequestV1,
  type SyncPairingPackageV1,
  type SyncPairingRequestV1,
  type SyncPairingSessionDescriptorV1,
} from './syncPairing';
import {
  assertSealedSyncObjectChunkV1,
  assertSealedSyncObjectManifestV1,
  type SealedSyncObjectChunkV1,
  type SealedSyncObjectManifestV1,
} from './syncObjectProtocol';
import {
  assertBase64Url,
  assertSealedChangeV1,
  type SealedChangeV1,
} from './syncProtocol';
import {
  assertSyncInitialDeviceRegistrationV1,
  type SyncInitialDeviceRegistrationV1,
} from './syncInitialProvisioning';
import {
  createSignedRelayRequestV1,
} from './syncRelayAuth';
import {
  assertSyncExecutionClaimV1,
  assertSyncExecutionIntentV1,
  assertSyncExecutionReceiptV1,
  assertSyncExecutionStartV1,
  assertSyncExecutionStatusV1,
  type SyncExecutionClaimV1,
  type SyncExecutionIntentV1,
  type SyncExecutionReceiptV1,
  type SyncExecutionStartV1,
} from './syncExecutionLeaseProtocol';
import {
  assertSyncExecutionClaimV2,
  type SyncExecutionCompleteRequestV2,
} from './syncExecutionClaimV2Protocol';
import type { SyncRandomUuidV1 } from './syncDeviceProvisioning';
import {
  parseResearchMaterialsBackendClaimResponse,
  parseResearchMaterialsBackendObjectChunk,
  parseResearchMaterialsBackendObjectClaimResponse,
} from './syncResearchMaterialsBackendOutbox';
import {
  assertSyncCurrentBaselineCommitV1,
  assertSyncCurrentBaselineV1,
  type SyncCurrentBaselineCommitV1,
  type SyncCurrentBaselineV1,
} from './syncCurrentBaseline';
import {
  assertCurrentStateRefreshStatusV1,
  assertFiniteDeletionCompactionStatusV1,
  assertFiniteDeletionCompactionV1,
  assertSyncDeviceFreshnessV2,
  type CurrentStateRefreshApprovalV1,
  type CurrentStateRefreshEntryV1,
  type CurrentStateRefreshStatusV1,
  type FiniteDeletionCompactionStatusV1,
  type FiniteDeletionCompactionV1,
  type FiniteDeletionTargetV1,
  type SyncDeviceFreshnessV2,
} from './syncFiniteHistory';

const MAX_DEVICE_RESPONSE_BYTES = 256 * 1024;
const MAX_CHANGE_BATCH_ITEMS = 16;
const MAX_CHANGE_PULL_ITEMS = 100;
const MAX_CHANGE_RESPONSE_BYTES = 24 * 1024 * 1024;
const MAX_OBJECT_CHUNK_RESPONSE_BYTES = 6 * 1024 * 1024;
const MAX_RESEARCH_MATERIALS_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_RESEARCH_OBJECT_CHUNK_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const OBJECT_CHUNK_TIMEOUT_MS = 60_000;

export type SyncRelayActiveEnrollmentV1 = {
  publicIdentity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
};

export type SyncRelayPairingSessionStatusV1 = {
  pairingId: string;
  state: 'created' | 'requested' | 'approved' | 'consumed';
  expiresAt: number;
  request: SyncPairingRequestV1 | null;
};

export type SyncRelayConsumePairingResponseV1 = {
  pairingPackage: SyncPairingPackageV1;
  registeredDevice: SyncDevicePublicIdentityV1;
};

export type SyncRelayPushChangesResponseV1 = {
  acknowledgements: Array<{
    mutationId: string;
    relayCursor: number;
    duplicate: boolean;
  }>;
  highestCursor: number;
};

export type SyncRelayPullChangesResponseV1 = {
  changes: Array<{
    relayCursor: number;
    change: SealedChangeV1;
  }>;
  nextCursor: number;
  hasMore: boolean;
};

export type SyncChangeStatusV1 = {
  latestCursor: number;
  hasChanges: boolean;
};

export type SyncRelayObjectWriteAckV1 = {
  objectId: string;
  chunkIndex: number | null;
  duplicate: boolean;
};

type RelayResponse = {
  ok: boolean;
  status: number;
  headers: {
    get(name: string): string | null;
  };
  text(): Promise<string>;
};

type RelayFetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<RelayResponse>;

export class SyncRelayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`君落同步中继返回 ${status}：${detail}`);
    this.name = 'SyncRelayHttpError';
  }
}

function recordOf(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象。`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
  label: string,
) {
  const keys = Object.keys(record);
  if (
    keys.some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error(`${label} 字段不符合 v1 合同。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertCanonicalBase64Url(
  value: unknown,
  label: string,
  exactBytes: number,
) {
  assertBase64Url(value, label, { exactBytes });
}

function assertDescriptor(
  value: SyncPairingSessionDescriptorV1,
) {
  const record = recordOf(value, 'pairing descriptor');
  assertExactKeys(record, [
    'version',
    'pairingId',
    'vaultId',
    'keyId',
    'inviterDeviceId',
    'expiresAt',
    'tokenDigest',
  ], 'pairing descriptor');
  if (record.version !== 1) {
    throw new Error('pairing descriptor version 无效。');
  }
  assertSyncUuidV4(record.pairingId, 'pairingId');
  assertSyncUuidV4(record.vaultId, 'vaultId');
  assertSyncUuidV4(record.keyId, 'keyId');
  assertSyncUuidV4(record.inviterDeviceId, 'inviterDeviceId');
  assertTimestamp(record.expiresAt, 'expiresAt');
  assertCanonicalBase64Url(
    record.tokenDigest,
    'tokenDigest',
    32,
  );
}

function assertPairingStatus(
  value: unknown,
): asserts value is SyncRelayPairingSessionStatusV1 {
  const record = recordOf(value, 'pairing session status');
  assertExactKeys(record, [
    'pairingId',
    'state',
    'expiresAt',
    'request',
  ], 'pairing session status');
  assertSyncUuidV4(record.pairingId, 'pairingId');
  if (
    record.state !== 'created'
    && record.state !== 'requested'
    && record.state !== 'approved'
    && record.state !== 'consumed'
  ) {
    throw new Error('pairing session state 无效。');
  }
  assertTimestamp(record.expiresAt, 'expiresAt');
  if (record.request !== null) {
    assertSyncPairingRequestV1(record.request);
  }
}

function assertConsumePairingResponse(
  value: unknown,
): asserts value is SyncRelayConsumePairingResponseV1 {
  const record = recordOf(value, 'consume pairing response');
  assertExactKeys(record, [
    'pairingPackage',
    'registeredDevice',
  ], 'consume pairing response');
  assertSyncPairingPackageV1(record.pairingPackage);
  assertSyncDevicePublicIdentityV1(record.registeredDevice);
  const pairingPackage =
    record.pairingPackage as SyncPairingPackageV1;
  const registeredDevice =
    record.registeredDevice as SyncDevicePublicIdentityV1;
  if (
    registeredDevice.state !== 'active'
    || registeredDevice.vaultId !== pairingPackage.vaultId
    || registeredDevice.deviceId !== pairingPackage.newDeviceId
    || registeredDevice.keyId !== pairingPackage.keyId
  ) {
    throw new Error('中继消费结果中的设备与配对包不一致。');
  }
}

function assertPositiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`${label} 必须是正安全整数。`);
  }
}

function assertPushChangesResponse(
  value: unknown,
  expectedMutationIds: readonly string[],
): asserts value is SyncRelayPushChangesResponseV1 {
  const record = recordOf(value, 'push changes response');
  assertExactKeys(
    record,
    ['acknowledgements', 'highestCursor'],
    'push changes response',
  );
  if (
    !Array.isArray(record.acknowledgements)
    || record.acknowledgements.length !== expectedMutationIds.length
  ) {
    throw new Error('中继变更确认数量与提交数量不一致。');
  }
  const expected = new Set(expectedMutationIds);
  const seen = new Set<string>();
  let maximumCursor = 0;
  for (const valueAtIndex of record.acknowledgements) {
    const acknowledgement = recordOf(
      valueAtIndex,
      'push acknowledgement',
    );
    assertExactKeys(
      acknowledgement,
      ['mutationId', 'relayCursor', 'duplicate'],
      'push acknowledgement',
    );
    assertSyncUuidV4(acknowledgement.mutationId, 'mutationId');
    assertPositiveInteger(
      acknowledgement.relayCursor,
      'relayCursor',
    );
    if (typeof acknowledgement.duplicate !== 'boolean') {
      throw new Error('push acknowledgement duplicate 必须是布尔值。');
    }
    const mutationId = acknowledgement.mutationId as string;
    if (!expected.has(mutationId) || seen.has(mutationId)) {
      throw new Error('中继变更确认包含越界或重复 mutationId。');
    }
    seen.add(mutationId);
    maximumCursor = Math.max(
      maximumCursor,
      Number(acknowledgement.relayCursor),
    );
  }
  assertTimestamp(record.highestCursor, 'highestCursor');
  if (Number(record.highestCursor) < maximumCursor) {
    throw new Error('中继 highestCursor 小于确认游标。');
  }
}

function assertSyncChangeStatusV1(
  value: unknown,
): asserts value is SyncChangeStatusV1 {
  const record = recordOf(value, 'change status response');
  assertExactKeys(record, ['latestCursor', 'hasChanges'], 'change status response');
  assertTimestamp(record.latestCursor, 'latestCursor');
  if (typeof record.hasChanges !== 'boolean') {
    throw new Error('change status hasChanges 必须是布尔值。');
  }
}

function assertObjectWriteAck(
  value: unknown,
): asserts value is SyncRelayObjectWriteAckV1 {
  const record = recordOf(value, 'object write acknowledgement');
  assertExactKeys(
    record,
    ['objectId', 'chunkIndex', 'duplicate'],
    'object write acknowledgement',
  );
  assertBase64Url(record.objectId, 'objectId', {
    exactBytes: 32,
  });
  if (
    record.chunkIndex !== null
    && (
      !Number.isSafeInteger(record.chunkIndex)
      || Number(record.chunkIndex) < 0
    )
  ) {
    throw new Error('object acknowledgement chunkIndex 无效。');
  }
  if (typeof record.duplicate !== 'boolean') {
    throw new Error('object acknowledgement duplicate 必须是布尔值。');
  }
}

function assertActiveTransportScope(
  enrollment: SyncRelayActiveEnrollmentV1,
  value: {
    vaultId: string;
    sourceDeviceId: string;
    keyId: string;
  },
) {
  assertActiveEnrollment(enrollment);
  const identity = enrollment.publicIdentity;
  if (
    value.vaultId !== identity.vaultId
    || value.sourceDeviceId !== identity.deviceId
    || value.keyId !== identity.keyId
  ) {
    throw new Error('待上传密文不属于当前 Android active 设备。');
  }
}

function assertActiveEnrollment(
  enrollment: SyncRelayActiveEnrollmentV1,
) {
  assertSyncDevicePublicIdentityV1(enrollment.publicIdentity);
  assertSyncDeviceSecretsV1(enrollment.secrets);
  if (
    enrollment.publicIdentity.state !== 'active'
    || enrollment.publicIdentity.platform !== 'android'
  ) {
    throw new Error('只有 active Android 设备可以签名访问中继。');
  }
  if (
    enrollment.publicIdentity.vaultId !== enrollment.secrets.vaultId
    || enrollment.publicIdentity.deviceId !== enrollment.secrets.deviceId
    || enrollment.publicIdentity.keyId !== enrollment.secrets.keyId
  ) {
    throw new Error('Android active 身份与本机签名秘密不一致。');
  }
}

export function normalizeSyncRelayBaseUrl(input: string) {
  const url = new URL(input);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new Error('同步中继地址只能填写不含凭据、路径、查询或片段的源地址。');
  }
  const loopback = url.hostname === 'localhost'
    || url.hostname === '127.0.0.1'
    || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('同步中继必须使用 HTTPS；仅本机回归允许 HTTP。');
  }
  return url.origin;
}

function bodyBytes(value: unknown) {
  return new TextEncoder().encode(canonicalizeJsonV1(value));
}

function parseResponseJson(text: string, label: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON。`, { cause: error });
  }
}

function responseDetail(text: string) {
  try {
    const record = recordOf(JSON.parse(text), 'relay error');
    return typeof record.detail === 'string'
      ? record.detail.slice(0, 500)
      : '中继拒绝了请求。';
  } catch {
    return '中继拒绝了请求。';
  }
}

export class SyncRelayClient {
  /** Independent control messages; does not push or pull encrypted business data. */
  proactiveControl(enrollment: SyncRelayActiveEnrollmentV1, action: string, body: Record<string, unknown>) {
    if (!/^(state:read|devices\/self:report|opportunities:reserve|opportunities\/[^/]+:(start|verify-camera|complete))$/.test(action)) {
      throw new Error('proactive-control-action-invalid');
    }
    return this.request({ method: 'POST', enrollment, body,
      path: `/v1/vaults/${enrollment.publicIdentity.vaultId}/proactive-control/${action}`,
      maxResponseBytes: 32 * 1024, responseLabel: '主动联系协调' });
  }
  private readonly baseUrl: string;
  private readonly relayFetch: RelayFetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly randomUuid: () => string | Promise<string>;

  constructor(input: {
    baseUrl: string;
    fetch?: RelayFetch;
    timeoutMs?: number;
    now?: () => number;
    randomUuid: SyncRandomUuidV1;
  }) {
    this.baseUrl = normalizeSyncRelayBaseUrl(input.baseUrl);
    this.relayFetch = input.fetch ?? (
      (url, init) => fetch(url, init)
    );
    this.timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.timeoutMs)
      || this.timeoutMs < 1_000
      || this.timeoutMs > 60_000
    ) {
      throw new Error('同步中继 timeout 必须在 1–60 秒之间。');
    }
    this.now = input.now ?? Date.now;
    this.randomUuid = input.randomUuid;
  }

  private async request(input: {
    method: 'GET' | 'POST' | 'PUT';
    path: string;
    query?: string;
    body?: unknown;
    enrollment?: SyncRelayActiveEnrollmentV1;
    maxResponseBytes?: number;
    responseLabel?: string;
    timeoutMs?: number;
  }) {
    if (
      !input.path.startsWith('/')
      || input.path.includes('?')
      || input.path.includes('#')
      || !/^[\x21-\x7e]+$/.test(input.path)
    ) {
      throw new Error('中继 path 必须是已编码 ASCII 绝对路径。');
    }
    const query = input.query ?? '';
    if (
      query.startsWith('?')
      || query.includes('#')
      || !/^[\x21-\x7e]*$/.test(query)
    ) {
      throw new Error('中继 query 必须是无前导问号的 ASCII 字符串。');
    }
    const bodyText = input.body === undefined
      ? undefined
      : canonicalizeJsonV1(input.body);
    const body = bodyText === undefined
      ? undefined
      : new TextEncoder().encode(bodyText);
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (body) headers['Content-Type'] = 'application/json';
    if (input.enrollment) {
      assertActiveEnrollment(input.enrollment);
      const identity = input.enrollment.publicIdentity;
      const signed = createSignedRelayRequestV1({
        vaultId: identity.vaultId,
        deviceId: identity.deviceId,
        keyId: identity.keyId,
        requestId: await this.randomUuid(),
        timestamp: this.now(),
        method: input.method,
        path: input.path,
        query,
        body,
        signingPrivateKey:
          input.enrollment.secrets.signingPrivateKey,
      });
      Object.assign(headers, signed.headers);
    }
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      input.timeoutMs ?? this.timeoutMs,
    );
    let response: RelayResponse;
    try {
      response = await this.relayFetch(
        `${this.baseUrl}${input.path}${query ? `?${query}` : ''}`,
        {
          method: input.method,
          headers,
          body: bodyText,
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error('君落同步中继请求超时。', { cause: error });
      }
      throw new Error('无法连接君落同步中继。', { cause: error });
    } finally {
      clearTimeout(timeout);
    }
    const declaredLength = Number(
      response.headers.get('content-length') ?? 0,
    );
    const maximumResponseBytes =
      input.maxResponseBytes ?? MAX_DEVICE_RESPONSE_BYTES;
    const responseLabel = input.responseLabel ?? '设备';
    if (
      Number.isFinite(declaredLength)
      && declaredLength > maximumResponseBytes
    ) {
      throw new Error(`同步中继${responseLabel}响应超过字节上限。`);
    }
    const text = await response.text();
    if (
      new TextEncoder().encode(text).byteLength > maximumResponseBytes
    ) {
      throw new Error(`同步中继${responseLabel}响应超过字节上限。`);
    }
    if (!response.ok) {
      throw new SyncRelayHttpError(
        response.status,
        responseDetail(text),
      );
    }
    const contentType =
      response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!contentType.startsWith('application/json')) {
      throw new Error('同步中继成功响应必须是 application/json。');
    }
    return parseResponseJson(text, '同步中继响应');
  }

  async provisionInitialDevice(
    registration: SyncInitialDeviceRegistrationV1,
  ) {
    assertSyncInitialDeviceRegistrationV1(registration);
    const vaultId = registration.vaultRegistration.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}:provision`,
      body: registration,
      responseLabel: '首台设备',
    });
    assertSyncDevicePublicIdentityV1(value);
    const device = value as SyncDevicePublicIdentityV1;
    if (
      device.vaultId !== vaultId
      || device.deviceId !== registration.initialDevice.deviceId
      || device.keyId !== registration.vaultRegistration.keyId
      || device.state !== 'active'
      || device.revokedAt !== null
    ) {
      throw new Error('中继首台设备登记响应与本机请求不一致。');
    }
    return device;
  }

  async listDevices(enrollment: SyncRelayActiveEnrollmentV1) {
    const vaultId = enrollment.publicIdentity.vaultId;
    assertSyncUuidV4(vaultId, 'vaultId');
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/devices`,
      enrollment,
    });
    const record = recordOf(value, 'device list response');
    assertExactKeys(record, ['devices'], 'device list response');
    if (!Array.isArray(record.devices) || record.devices.length > 100) {
      throw new Error('中继设备列表必须是至多 100 项的数组。');
    }
    const seen = new Set<string>();
    for (const device of record.devices) {
      assertSyncDevicePublicIdentityV1(device);
      if (device.vaultId !== vaultId || seen.has(device.deviceId)) {
        throw new Error('中继设备列表包含越界或重复设备。');
      }
      seen.add(device.deviceId);
    }
    return record.devices as SyncDevicePublicIdentityV1[];
  }

  async revokeDevice(
    enrollment: SyncRelayActiveEnrollmentV1,
    deviceId: string,
  ) {
    const vaultId = enrollment.publicIdentity.vaultId;
    assertSyncUuidV4(vaultId, 'vaultId');
    assertSyncUuidV4(deviceId, 'deviceId');
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/devices/${deviceId}:revoke`,
      enrollment,
    });
    assertSyncDevicePublicIdentityV1(value);
    if (
      value.vaultId !== vaultId
      || value.deviceId !== deviceId
      || value.state !== 'revoked'
    ) {
      throw new Error('中继撤销响应与目标设备不一致。');
    }
    return value;
  }

  async renameCurrentDevice(
    enrollment: SyncRelayActiveEnrollmentV1,
    displayName: unknown,
  ) {
    const identity = enrollment.publicIdentity;
    const normalized = normalizeSyncDeviceDisplayName(displayName);
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${identity.vaultId}/devices/self:rename`,
      body: { version: 1, displayName: normalized },
      enrollment,
      responseLabel: '设备昵称更新结果',
    });
    assertSyncDevicePublicIdentityV1(value);
    if (
      value.displayName !== normalized
      || !sameSyncDeviceIdentityExceptDisplayNameV1(identity, value)
    ) {
      throw new Error('中继昵称更新响应与当前设备身份不一致。');
    }
    return value;
  }

  async createPairingSession(
    enrollment: SyncRelayActiveEnrollmentV1,
    descriptor: SyncPairingSessionDescriptorV1,
  ) {
    assertDescriptor(descriptor);
    if (
      descriptor.vaultId !== enrollment.publicIdentity.vaultId
      || descriptor.inviterDeviceId
        !== enrollment.publicIdentity.deviceId
    ) {
      throw new Error('配对 descriptor 不属于当前邀请设备。');
    }
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${descriptor.vaultId}/pairings`,
      body: { descriptor },
      enrollment,
    });
    assertPairingStatus(value);
    if (value.pairingId !== descriptor.pairingId) {
      throw new Error('中继创建的配对会话 ID 不一致。');
    }
    return value;
  }

  async submitPairingRequest(input: {
    pairingToken: string;
    request: SyncPairingRequestV1;
  }) {
    assertCanonicalBase64Url(
      input.pairingToken,
      'pairingToken',
      32,
    );
    assertSyncPairingRequestV1(input.request);
    const value = await this.request({
      method: 'POST',
      path: `/v1/pairings/${input.request.pairingId}:request`,
      body: input,
    });
    assertPairingStatus(value);
    if (
      value.pairingId !== input.request.pairingId
      || value.state !== 'requested'
    ) {
      throw new Error('中继没有进入 requested 配对状态。');
    }
    return value;
  }

  async getPairingSession(
    enrollment: SyncRelayActiveEnrollmentV1,
    pairingId: string,
  ) {
    assertSyncUuidV4(pairingId, 'pairingId');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/pairings/${pairingId}`,
      enrollment,
    });
    assertPairingStatus(value);
    if (value.pairingId !== pairingId) {
      throw new Error('中继配对会话 ID 不一致。');
    }
    return value;
  }

  async approvePairingSession(input: {
    enrollment: SyncRelayActiveEnrollmentV1;
    pairingPackage: SyncPairingPackageV1;
  }) {
    assertSyncPairingPackageV1(input.pairingPackage);
    const { vaultId, pairingId, inviterDeviceId } =
      input.pairingPackage;
    if (
      vaultId !== input.enrollment.publicIdentity.vaultId
      || inviterDeviceId
        !== input.enrollment.publicIdentity.deviceId
    ) {
      throw new Error('配对包不属于当前邀请设备。');
    }
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/pairings/${pairingId}:approve`,
      body: { pairingPackage: input.pairingPackage },
      enrollment: input.enrollment,
    });
    assertPairingStatus(value);
    if (value.pairingId !== pairingId || value.state !== 'approved') {
      throw new Error('中继没有进入 approved 配对状态。');
    }
    return value;
  }

  async consumePairingSession(input: {
    pairingId: string;
    pairingToken: string;
  }) {
    assertSyncUuidV4(input.pairingId, 'pairingId');
    assertCanonicalBase64Url(
      input.pairingToken,
      'pairingToken',
      32,
    );
    const value = await this.request({
      method: 'POST',
      path: `/v1/pairings/${input.pairingId}:consume`,
      body: { pairingToken: input.pairingToken },
    });
    assertConsumePairingResponse(value);
    if (value.pairingPackage.pairingId !== input.pairingId) {
      throw new Error('中继消费结果的配对会话 ID 不一致。');
    }
    return value;
  }

  async pushChanges(
    enrollment: SyncRelayActiveEnrollmentV1,
    changes: readonly SealedChangeV1[],
  ) {
    if (
      changes.length < 1
      || changes.length > MAX_CHANGE_BATCH_ITEMS
    ) {
      throw new Error('Android 单批只能推送 1–16 条密文变更。');
    }
    const mutationIds = new Set<string>();
    for (const change of changes) {
      assertSealedChangeV1(change);
      assertActiveTransportScope(enrollment, change);
      if (mutationIds.has(change.mutationId)) {
        throw new Error('Android 单批密文变更 mutationId 不能重复。');
      }
      mutationIds.add(change.mutationId);
    }
    const serialized = bodyBytes({ changes });
    if (serialized.byteLength > 20 * 1024 * 1024) {
      throw new Error('Android 单批密文变更超过 20 MiB 上限。');
    }
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${enrollment.publicIdentity.vaultId}/changes:batch`,
      body: { changes },
      enrollment,
      maxResponseBytes: MAX_CHANGE_RESPONSE_BYTES,
      responseLabel: '变更推送',
    });
    assertPushChangesResponse(value, [...mutationIds]);
    return value;
  }

  async commitCurrentBaseline(
    enrollment: SyncRelayActiveEnrollmentV1,
    baseline: SyncCurrentBaselineCommitV1,
  ) {
    assertSyncCurrentBaselineCommitV1(baseline);
    if (
      baseline.vaultId !== enrollment.publicIdentity.vaultId
      || baseline.sourceDeviceId !== enrollment.publicIdentity.deviceId
      || baseline.keyId !== enrollment.publicIdentity.keyId
    ) {
      throw new Error('current baseline receipt is outside active enrollment');
    }
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${baseline.vaultId}/current-baseline:complete`,
      body: baseline,
      enrollment,
      responseLabel: 'current baseline receipt',
    });
    assertSyncCurrentBaselineV1(value);
    if (
      value.vaultId !== baseline.vaultId
      || value.sourceDeviceId !== baseline.sourceDeviceId
      || value.keyId !== baseline.keyId
    ) {
      throw new Error('relay current baseline receipt changed scope');
    }
    return value;
  }

  async getCurrentBaseline(
    enrollment: SyncRelayActiveEnrollmentV1,
  ) {
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${enrollment.publicIdentity.vaultId}/current-baseline`,
      enrollment,
      responseLabel: 'current baseline receipt',
    });
    assertSyncCurrentBaselineV1(value);
    if (
      value.vaultId !== enrollment.publicIdentity.vaultId
      || value.keyId !== enrollment.publicIdentity.keyId
    ) {
      throw new Error('relay current baseline belongs to another world');
    }
    return value;
  }

  async pullChanges(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: {
      after: number;
      limit?: number;
    },
  ) {
    assertTimestamp(input.after, 'after');
    const limit = input.limit ?? MAX_CHANGE_PULL_ITEMS;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > MAX_CHANGE_PULL_ITEMS
    ) {
      throw new Error('Android 单次只能拉取 1–100 条密文变更。');
    }
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/changes`,
      query: `after=${input.after}&limit=${limit}`,
      enrollment,
      maxResponseBytes: MAX_CHANGE_RESPONSE_BYTES,
      responseLabel: '变更拉取',
    });
    const record = recordOf(value, 'pull changes response');
    assertExactKeys(
      record,
      ['changes', 'nextCursor', 'hasMore'],
      'pull changes response',
    );
    if (!Array.isArray(record.changes) || record.changes.length > limit) {
      throw new Error('中继拉取变更数量超过请求上限。');
    }
    let previousCursor = input.after;
    for (const item of record.changes) {
      const pulled = recordOf(item, 'pulled change');
      assertExactKeys(pulled, ['relayCursor', 'change'], 'pulled change');
      assertPositiveInteger(pulled.relayCursor, 'relayCursor');
      assertSealedChangeV1(pulled.change);
      if (pulled.change.vaultId !== vaultId) {
        throw new Error('中继拉取结果包含其他 vault 的变更。');
      }
      const cursor = Number(pulled.relayCursor);
      if (cursor <= previousCursor) {
        throw new Error('中继拉取游标必须严格递增且不能重复。');
      }
      previousCursor = cursor;
    }
    assertTimestamp(record.nextCursor, 'nextCursor');
    if (Number(record.nextCursor) !== previousCursor) {
      throw new Error('中继 nextCursor 与最后一条拉取游标不一致。');
    }
    if (typeof record.hasMore !== 'boolean') {
      throw new Error('中继 hasMore 必须是布尔值。');
    }
    return {
      changes: record.changes,
      nextCursor: Number(record.nextCursor),
      hasMore: record.hasMore,
    } as SyncRelayPullChangesResponseV1;
  }

  async getChangeStatus(
    enrollment: SyncRelayActiveEnrollmentV1,
    after: number,
  ) {
    assertTimestamp(after, 'after');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/changes:status`,
      query: `after=${after}`,
      enrollment,
      responseLabel: '变更状态',
    });
    assertSyncChangeStatusV1(value);
    return value;
  }

  async getDeviceFreshness(
    enrollment: SyncRelayActiveEnrollmentV1,
  ): Promise<SyncDeviceFreshnessV2> {
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/devices/self/freshness`,
      enrollment,
      responseLabel: '设备进度账',
    });
    assertSyncDeviceFreshnessV2(value);
    if (value.deviceId !== enrollment.publicIdentity.deviceId) {
      throw new Error('设备进度账属于另一台设备。');
    }
    return value;
  }

  async listDeviceFreshness(
    enrollment: SyncRelayActiveEnrollmentV1,
  ): Promise<SyncDeviceFreshnessV2[]> {
    const identity = enrollment.publicIdentity;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${identity.vaultId}/devices/freshness`,
      enrollment,
      responseLabel: '设备进度账列表',
    });
    const record = recordOf(value, '设备进度账列表');
    assertExactKeys(record, ['devices'], '设备进度账列表');
    if (!Array.isArray(record.devices) || record.devices.length > 100) {
      throw new Error('设备进度账列表必须是至多 100 项的数组。');
    }
    const seen = new Set<string>();
    for (const item of record.devices) {
      assertSyncDeviceFreshnessV2(item);
      if (seen.has(item.deviceId)) {
        throw new Error('设备进度账列表包含重复设备。');
      }
      seen.add(item.deviceId);
    }
    if (!seen.has(identity.deviceId)) {
      throw new Error('设备进度账列表缺少当前设备。');
    }
    return record.devices as SyncDeviceFreshnessV2[];
  }

  async checkpointDeviceFreshness(
    enrollment: SyncRelayActiveEnrollmentV1,
    appliedCursor: number,
  ): Promise<SyncDeviceFreshnessV2> {
    assertTimestamp(appliedCursor, 'appliedCursor');
    const identity = enrollment.publicIdentity;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${identity.vaultId}/devices/self/freshness:checkpoint`,
      body: {
        version: 2,
        deviceId: identity.deviceId,
        appliedCursor,
      },
      enrollment,
      responseLabel: '设备进度回执',
    });
    assertSyncDeviceFreshnessV2(value);
    return value;
  }

  async lookupMutationRelayReceipts(
    enrollment: SyncRelayActiveEnrollmentV1,
    mutationIds: readonly string[],
  ): Promise<{
    receipts: Array<Omit<FiniteDeletionTargetV1, 'revisionId'>>;
    missingMutationIds: string[];
  }> {
    if (mutationIds.length < 1 || mutationIds.length > 32) {
      throw new Error('单次只能核对 1–32 个 mutation 回执。');
    }
    const sorted = [...mutationIds].sort();
    if (new Set(sorted).size !== sorted.length) {
      throw new Error('mutation 回执查询不能重复。');
    }
    sorted.forEach((id) => assertSyncUuidV4(id, 'mutationId'));
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/changes:receipts`,
      body: { mutationIds: sorted },
      enrollment,
      responseLabel: 'mutation 回执',
    });
    const record = recordOf(value, 'mutation receipt response');
    if (!Array.isArray(record.receipts) || !Array.isArray(record.missingMutationIds)) {
      throw new Error('mutation 回执响应无效。');
    }
    const receipts = record.receipts.map((item) => {
      const receipt = recordOf(item, 'mutation relay receipt');
      assertSyncUuidV4(receipt.mutationId, 'mutationId');
      assertSyncUuidV4(receipt.sourceDeviceId, 'sourceDeviceId');
      assertPositiveInteger(receipt.sourceSequence, 'sourceSequence');
      assertPositiveInteger(receipt.relayCursor, 'relayCursor');
      return {
        mutationId: String(receipt.mutationId),
        sourceDeviceId: String(receipt.sourceDeviceId),
        sourceSequence: Number(receipt.sourceSequence),
        relayCursor: Number(receipt.relayCursor),
      };
    });
    const missingMutationIds = record.missingMutationIds.map((item) => {
      assertSyncUuidV4(item, 'missingMutationId');
      return String(item);
    });
    return { receipts, missingMutationIds };
  }

  async compactFiniteDeletion(
    enrollment: SyncRelayActiveEnrollmentV1,
    compaction: FiniteDeletionCompactionV1,
  ): Promise<FiniteDeletionCompactionStatusV1> {
    assertFiniteDeletionCompactionV1(compaction);
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${compaction.vaultId}/finite-deletions:compact`,
      body: compaction,
      enrollment,
      responseLabel: '有限删除整理',
    });
    assertFiniteDeletionCompactionStatusV1(value);
    return value;
  }

  async listPendingFiniteDeletions(
    enrollment: SyncRelayActiveEnrollmentV1,
  ): Promise<FiniteDeletionCompactionV1[]> {
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/finite-deletions:pending`,
      query: 'limit=32',
      enrollment,
      responseLabel: '有限删除待办',
    });
    const record = recordOf(value, 'finite deletion pending page');
    if (!Array.isArray(record.compactions)) throw new Error('有限删除待办无效。');
    record.compactions.forEach(assertFiniteDeletionCompactionV1);
    return record.compactions;
  }

  async acknowledgeFiniteDeletion(
    enrollment: SyncRelayActiveEnrollmentV1,
    compactionId: string,
    acknowledgedAt: number,
  ) {
    assertSyncUuidV4(compactionId, 'compactionId');
    const identity = enrollment.publicIdentity;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${identity.vaultId}/finite-deletions/${compactionId}:acknowledge`,
      body: {
        version: 1,
        compactionId,
        deviceId: identity.deviceId,
        acknowledgedAt,
      },
      enrollment,
      responseLabel: '有限删除确认',
    });
    assertFiniteDeletionCompactionStatusV1(value);
    return value;
  }

  async listPendingCurrentStateRefresh(
    enrollment: SyncRelayActiveEnrollmentV1,
  ): Promise<CurrentStateRefreshStatusV1[]> {
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/current-state-refresh-sessions:pending`,
      enrollment,
      responseLabel: '当前状态刷新请求',
    });
    const record = recordOf(value, 'refresh pending page');
    if (!Array.isArray(record.sessions)) throw new Error('刷新请求列表无效。');
    record.sessions.forEach(assertCurrentStateRefreshStatusV1);
    return record.sessions;
  }

  async approveCurrentStateRefresh(
    enrollment: SyncRelayActiveEnrollmentV1,
    approval: CurrentStateRefreshApprovalV1,
  ) {
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${approval.vaultId}/current-state-refresh-sessions/${approval.sessionId}:approve`,
      body: approval,
      enrollment,
      responseLabel: '当前状态刷新批准',
    });
    assertCurrentStateRefreshStatusV1(value);
    return value;
  }

  async putCurrentStateRefreshEntry(
    enrollment: SyncRelayActiveEnrollmentV1,
    entry: CurrentStateRefreshEntryV1,
  ) {
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'PUT',
      path: `/v1/vaults/${vaultId}/current-state-refresh-sessions/${entry.sessionId}/entries/${entry.entryIndex}`,
      body: entry,
      enrollment,
      maxResponseBytes: MAX_CHANGE_RESPONSE_BYTES,
      responseLabel: '当前状态刷新条目',
    });
    assertCurrentStateRefreshStatusV1(value);
    return value;
  }

  async finalizeCurrentStateRefresh(
    enrollment: SyncRelayActiveEnrollmentV1,
    sessionId: string,
  ) {
    assertSyncUuidV4(sessionId, 'sessionId');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/current-state-refresh-sessions/${sessionId}:finalize`,
      enrollment,
      responseLabel: '当前状态刷新完成准备',
    });
    assertCurrentStateRefreshStatusV1(value);
    return value;
  }

  async claimResearchMaterialsBackendOutbox(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: {
      leaseId: string;
      leaseDurationMs: number;
      limit: number;
    },
  ) {
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/api/sync/v1/vaults/${vaultId}/research-materials/outbox:claim`,
      body: input,
      enrollment,
      maxResponseBytes: MAX_RESEARCH_MATERIALS_RESPONSE_BYTES,
      responseLabel: '研究材料领取',
    });
    return parseResearchMaterialsBackendClaimResponse(value);
  }

  async markResearchMaterialsBackendOutboxDispatched(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: { localSequence: number; leaseId: string },
  ) {
    assertPositiveInteger(input.localSequence, 'localSequence');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/api/sync/v1/vaults/${vaultId}/research-materials/outbox/${input.localSequence}:dispatched`,
      body: { leaseId: input.leaseId },
      enrollment,
      responseLabel: '研究材料确认',
    });
    const response = recordOf(value, 'research dispatch response');
    assertExactKeys(response, ['state'], 'research dispatch response');
    if (response.state !== 'dispatched') {
      throw new Error('研究材料后端没有确认 dispatched。');
    }
  }

  async releaseResearchMaterialsBackendOutbox(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: {
      localSequence: number;
      leaseId: string;
      retryDelayMs: number;
      errorCode: string;
    },
  ) {
    assertPositiveInteger(input.localSequence, 'localSequence');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/api/sync/v1/vaults/${vaultId}/research-materials/outbox/${input.localSequence}:release`,
      body: {
        leaseId: input.leaseId,
        retryDelayMs: input.retryDelayMs,
        errorCode: input.errorCode,
      },
      enrollment,
      responseLabel: '研究材料失败释放',
    });
    const response = recordOf(value, 'research release response');
    assertExactKeys(response, ['state'], 'research release response');
    if (response.state !== 'pending') {
      throw new Error('研究材料后端没有恢复 pending。');
    }
  }

  async claimResearchMaterialsBackendObjects(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: {
      leaseId: string;
      leaseDurationMs: number;
      limit: number;
    },
  ) {
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/api/sync/v1/vaults/${vaultId}/research-materials/outbox:claim-objects`,
      body: input,
      enrollment,
      maxResponseBytes: MAX_RESEARCH_MATERIALS_RESPONSE_BYTES,
      responseLabel: '研究材料对象领取',
    });
    return parseResearchMaterialsBackendObjectClaimResponse(value);
  }

  async readResearchMaterialsBackendObjectChunk(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: {
      localSequence: number;
      leaseId: string;
      offset: number;
      maximumBytes: number;
    },
  ) {
    assertPositiveInteger(input.localSequence, 'localSequence');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/api/sync/v1/vaults/${vaultId}/research-materials/outbox/${input.localSequence}:read-object-chunk`,
      body: {
        leaseId: input.leaseId,
        offset: input.offset,
        maximumBytes: input.maximumBytes,
      },
      enrollment,
      maxResponseBytes: MAX_RESEARCH_OBJECT_CHUNK_RESPONSE_BYTES,
      responseLabel: '研究材料对象分块',
    });
    return parseResearchMaterialsBackendObjectChunk(value);
  }

  async releaseResearchMaterialsBackendObject(
    enrollment: SyncRelayActiveEnrollmentV1,
    input: {
      localSequence: number;
      leaseId: string;
      errorCode: string;
    },
  ) {
    assertPositiveInteger(input.localSequence, 'localSequence');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/api/sync/v1/vaults/${vaultId}/research-materials/outbox/${input.localSequence}:release-object`,
      body: {
        leaseId: input.leaseId,
        retryDelayMs: 1,
        errorCode: input.errorCode,
      },
      enrollment,
      responseLabel: '研究材料对象失败释放',
    });
    const response = recordOf(value, 'research object release response');
    assertExactKeys(response, ['state'], 'research object release response');
    if (response.state !== 'quarantined') {
      throw new Error('研究材料对象没有恢复 quarantined。');
    }
  }

  async putObjectManifest(
    enrollment: SyncRelayActiveEnrollmentV1,
    manifest: SealedSyncObjectManifestV1,
  ) {
    assertSealedSyncObjectManifestV1(manifest);
    assertActiveTransportScope(enrollment, manifest);
    const value = await this.request({
      method: 'PUT',
      path: `/v1/vaults/${manifest.vaultId}/objects/${manifest.objectId}/manifest`,
      body: manifest,
      enrollment,
    });
    assertObjectWriteAck(value);
    if (
      value.objectId !== manifest.objectId
      || value.chunkIndex !== null
    ) {
      throw new Error('中继 object manifest 写入确认不一致。');
    }
    return value;
  }

  async getObjectManifest(
    enrollment: SyncRelayActiveEnrollmentV1,
    objectId: string,
  ) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    const identity = enrollment.publicIdentity;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${identity.vaultId}/objects/${objectId}/manifest`,
      enrollment,
    });
    assertSealedSyncObjectManifestV1(value);
    if (
      value.vaultId !== identity.vaultId
      || value.objectId !== objectId
      || value.keyId !== identity.keyId
    ) {
      throw new Error('中继 object manifest 与请求路由不一致。');
    }
    return value;
  }

  async putObjectChunk(
    enrollment: SyncRelayActiveEnrollmentV1,
    chunk: SealedSyncObjectChunkV1,
  ) {
    assertSealedSyncObjectChunkV1(chunk);
    assertActiveTransportScope(enrollment, chunk);
    const value = await this.request({
      method: 'PUT',
      path: `/v1/vaults/${chunk.vaultId}/objects/${chunk.objectId}/chunks/${chunk.chunkIndex}`,
      body: chunk,
      enrollment,
      timeoutMs: OBJECT_CHUNK_TIMEOUT_MS,
    });
    assertObjectWriteAck(value);
    if (
      value.objectId !== chunk.objectId
      || value.chunkIndex !== chunk.chunkIndex
    ) {
      throw new Error('中继 object chunk 写入确认不一致。');
    }
    return value;
  }

  async getObjectChunk(
    enrollment: SyncRelayActiveEnrollmentV1,
    objectId: string,
    chunkIndex: number,
  ) {
    assertBase64Url(objectId, 'objectId', { exactBytes: 32 });
    if (
      !Number.isSafeInteger(chunkIndex)
      || chunkIndex < 0
      || chunkIndex >= 100_000
    ) {
      throw new Error('object chunkIndex 无效。');
    }
    const identity = enrollment.publicIdentity;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${identity.vaultId}/objects/${objectId}/chunks/${chunkIndex}`,
      enrollment,
      maxResponseBytes: MAX_OBJECT_CHUNK_RESPONSE_BYTES,
      responseLabel: '对象分块',
      timeoutMs: OBJECT_CHUNK_TIMEOUT_MS,
    });
    assertSealedSyncObjectChunkV1(value);
    if (
      value.vaultId !== identity.vaultId
      || value.objectId !== objectId
      || value.chunkIndex !== chunkIndex
      || value.keyId !== identity.keyId
    ) {
      throw new Error('中继 object chunk 与请求路由不一致。');
    }
    return value;
  }

  async createExecutionIntent(
    enrollment: SyncRelayActiveEnrollmentV1,
    intent: SyncExecutionIntentV1,
  ) {
    assertSyncExecutionIntentV1(intent);
    const identity = enrollment.publicIdentity;
    if (
      intent.vaultId !== identity.vaultId
      || intent.keyId !== identity.keyId
      || intent.sourceDeviceId !== identity.deviceId
    ) {
      throw new Error('执行意图不属于当前设备。');
    }
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${intent.vaultId}/execution-intents`,
      body: intent,
      enrollment,
      responseLabel: '执行意图',
    });
    assertSyncExecutionStatusV1(value);
    if (value.intent.operationId !== intent.operationId) {
      throw new Error('中继执行意图响应 ID 不一致。');
    }
    return value;
  }

  async getExecutionStatus(
    enrollment: SyncRelayActiveEnrollmentV1,
    operationId: string,
  ) {
    assertBase64Url(operationId, 'operationId', { exactBytes: 32 });
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/execution-intents/${operationId}`,
      enrollment,
      responseLabel: '执行状态',
    });
    assertSyncExecutionStatusV1(value);
    if (value.intent.vaultId !== vaultId || value.intent.operationId !== operationId) {
      throw new Error('中继执行状态与请求路由不一致。');
    }
    return value;
  }

  async claimExecutionIntent(
    enrollment: SyncRelayActiveEnrollmentV1,
    claim: SyncExecutionClaimV1,
  ) {
    assertSyncExecutionClaimV1(claim);
    const identity = enrollment.publicIdentity;
    if (
      claim.vaultId !== identity.vaultId
      || claim.keyId !== identity.keyId
      || claim.claimantDeviceId !== identity.deviceId
    ) throw new Error('执行领取不属于当前设备。');
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${claim.vaultId}/execution-intents/${claim.operationId}:claim`,
      body: claim,
      enrollment,
      responseLabel: '执行领取',
    });
    assertSyncExecutionStatusV1(value);
    return value;
  }

  async startExecution(
    enrollment: SyncRelayActiveEnrollmentV1,
    start: SyncExecutionStartV1,
  ) {
    assertSyncExecutionStartV1(start);
    const identity = enrollment.publicIdentity;
    if (
      start.vaultId !== identity.vaultId
      || start.keyId !== identity.keyId
      || start.executorDeviceId !== identity.deviceId
    ) throw new Error('执行开始记录不属于当前设备。');
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${start.vaultId}/execution-intents/${start.operationId}:start`,
      body: start,
      enrollment,
      responseLabel: '执行围栏',
    });
    assertSyncExecutionStatusV1(value);
    return value;
  }

  async completeExecution(
    enrollment: SyncRelayActiveEnrollmentV1,
    receipt: SyncExecutionReceiptV1,
  ) {
    assertSyncExecutionReceiptV1(receipt);
    const identity = enrollment.publicIdentity;
    if (
      receipt.vaultId !== identity.vaultId
      || receipt.keyId !== identity.keyId
      || receipt.executorDeviceId !== identity.deviceId
    ) throw new Error('执行回执不属于当前设备。');
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${receipt.vaultId}/execution-intents/${receipt.operationId}:complete`,
      body: receipt,
      enrollment,
      responseLabel: '执行回执',
    });
    assertSyncExecutionStatusV1(value);
    return value;
  }

  async getExecutionClaimV2(
    enrollment: SyncRelayActiveEnrollmentV1,
    operationId: string,
  ) {
    assertBase64Url(operationId, 'operationId', { exactBytes: 32 });
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'GET',
      path: `/v1/vaults/${vaultId}/execution-claims/${operationId}`,
      enrollment,
      responseLabel: '轻量执行认领',
    });
    assertSyncExecutionClaimV2(value);
    if (value.operationId !== operationId) {
      throw new Error('中继轻量执行认领响应 ID 不一致。');
    }
    return value;
  }

  async claimExecutionV2(
    enrollment: SyncRelayActiveEnrollmentV1,
    operationId: string,
  ) {
    assertBase64Url(operationId, 'operationId', { exactBytes: 32 });
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/execution-claims/${operationId}:claim`,
      body: { protocolVersion: 2 },
      enrollment,
      responseLabel: '轻量执行领取',
    });
    assertSyncExecutionClaimV2(value);
    if (value.operationId !== operationId) {
      throw new Error('中继轻量执行领取响应 ID 不一致。');
    }
    return value;
  }

  async startExecutionV2(
    enrollment: SyncRelayActiveEnrollmentV1,
    operationId: string,
    claimId: string,
  ) {
    assertBase64Url(operationId, 'operationId', { exactBytes: 32 });
    assertSyncUuidV4(claimId, 'execution claimId');
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/execution-claims/${operationId}:start`,
      body: { protocolVersion: 2, claimId },
      enrollment,
      responseLabel: '轻量执行开始',
    });
    assertSyncExecutionClaimV2(value);
    if (value.operationId !== operationId) {
      throw new Error('中继轻量执行开始响应 ID 不一致。');
    }
    return value;
  }

  async completeExecutionV2(
    enrollment: SyncRelayActiveEnrollmentV1,
    operationId: string,
    completion: SyncExecutionCompleteRequestV2,
  ) {
    assertBase64Url(operationId, 'operationId', { exactBytes: 32 });
    const vaultId = enrollment.publicIdentity.vaultId;
    const value = await this.request({
      method: 'POST',
      path: `/v1/vaults/${vaultId}/execution-claims/${operationId}:complete`,
      body: completion,
      enrollment,
      responseLabel: '轻量执行完成',
    });
    assertSyncExecutionClaimV2(value);
    if (value.operationId !== operationId) {
      throw new Error('中继轻量执行完成响应 ID 不一致。');
    }
    return value;
  }
}
