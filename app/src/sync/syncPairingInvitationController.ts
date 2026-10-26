import { canonicalizeJsonV1 } from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import type {
  SyncRandomBytesV1,
  SyncRandomUuidV1,
} from './syncDeviceProvisioning';
import {
  assertSyncPairingOfferSecretV1,
  assertSyncPairingOfferV1,
  assertSyncPairingPackageV1,
  assertSyncPairingRequestV1,
  createSyncPairingOfferV1,
  createSyncPairingPackageV1,
  pairingSessionDescriptorV1,
  pairingVerificationCodeForInviterV1,
  verifySyncPairingRequestV1,
  type SyncPairingOfferSecretV1,
  type SyncPairingOfferV1,
  type SyncPairingPackageV1,
  type SyncPairingRequestV1,
  type SyncPairingSessionDescriptorV1,
} from './syncPairing';
import {
  SyncRelayHttpError,
  type SyncRelayClient,
  type SyncRelayPairingSessionStatusV1,
} from './syncRelayClient';

const ANDROID_PAIRING_INVITATION_KEY =
  'junluo.sync.android-pairing-invitation.v1';

export interface AndroidPairingInvitationValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type AndroidPairingInvitationPhase =
  | 'prepared'
  | 'published'
  | 'request-received'
  | 'approval-prepared'
  | 'approved'
  | 'consumed';

export type AndroidPairingInvitationV1 = {
  version: 1;
  state: AndroidPairingInvitationPhase;
  offer: SyncPairingOfferV1;
  localSecret: SyncPairingOfferSecretV1;
  relayDescriptor: SyncPairingSessionDescriptorV1;
  request: SyncPairingRequestV1 | null;
  verificationCode: string | null;
  pairingPackage: SyncPairingPackageV1 | null;
  createdAt: number;
  updatedAt: number;
};

type ActiveDevice = {
  identity: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
};

type InvitationRelayPort = Pick<
  SyncRelayClient,
  | 'createPairingSession'
  | 'getPairingSession'
  | 'approvePairingSession'
>;

function recordOf(value: unknown, label: string) {
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
    throw new Error(`${label}字段不符合 v1 合同。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function sameJson(left: unknown, right: unknown) {
  return canonicalizeJsonV1(left) === canonicalizeJsonV1(right);
}

function assertPackageMatches(
  state: AndroidPairingInvitationV1,
  pairingPackage: SyncPairingPackageV1,
) {
  const request = state.request;
  if (
    !request
    || pairingPackage.pairingId !== state.offer.pairingId
    || pairingPackage.vaultId !== state.offer.vaultId
    || pairingPackage.keyId !== state.offer.keyId
    || pairingPackage.requestId !== request.requestId
    || pairingPackage.inviterDeviceId !== state.offer.inviterDeviceId
    || pairingPackage.newDeviceId !== request.newDevice.deviceId
    || pairingPackage.expiresAt !== state.offer.expiresAt
  ) {
    throw new Error('Android 配对批准包与邀请请求不一致。');
  }
}

export function assertAndroidPairingInvitationV1(
  value: unknown,
): asserts value is AndroidPairingInvitationV1 {
  const record = recordOf(value, 'Android 配对邀请');
  assertExactKeys(record, [
    'version',
    'state',
    'offer',
    'localSecret',
    'relayDescriptor',
    'request',
    'verificationCode',
    'pairingPackage',
    'createdAt',
    'updatedAt',
  ], 'Android 配对邀请');
  if (record.version !== 1 || ![
    'prepared',
    'published',
    'request-received',
    'approval-prepared',
    'approved',
    'consumed',
  ].includes(String(record.state))) {
    throw new Error('Android 配对邀请版本或状态无效。');
  }
  assertSyncPairingOfferV1(record.offer);
  assertSyncPairingOfferSecretV1(record.localSecret);
  assertTimestamp(record.createdAt, 'createdAt');
  assertTimestamp(record.updatedAt, 'updatedAt');
  const state = record as AndroidPairingInvitationV1;
  const expectedDescriptor = pairingSessionDescriptorV1(state.offer);
  if (
    state.localSecret.pairingId !== state.offer.pairingId
    || !sameJson(state.relayDescriptor, expectedDescriptor)
    || state.createdAt !== state.offer.createdAt
    || state.updatedAt < state.createdAt
  ) {
    throw new Error('Android 配对邀请本地秘密或 descriptor 不一致。');
  }
  if (state.request === null) {
    if (
      state.verificationCode !== null
      || state.pairingPackage !== null
      || !['prepared', 'published'].includes(state.state)
    ) {
      throw new Error('Android 配对邀请无请求状态不一致。');
    }
    return;
  }
  assertSyncPairingRequestV1(state.request);
  verifySyncPairingRequestV1(
    state.offer,
    state.request,
    state.request.createdAt,
  );
  const expectedCode = pairingVerificationCodeForInviterV1(
    state.localSecret,
    state.offer,
    state.request,
    state.request.createdAt,
  );
  if (
    state.verificationCode !== expectedCode
    || !/^\d{6}$/.test(state.verificationCode)
  ) {
    throw new Error('Android 配对邀请短码与 transcript 不一致。');
  }
  if (state.pairingPackage === null) {
    if (state.state !== 'request-received') {
      throw new Error('Android 配对邀请待批准状态不一致。');
    }
    return;
  }
  assertSyncPairingPackageV1(state.pairingPackage);
  assertPackageMatches(state, state.pairingPackage);
  if (!['approval-prepared', 'approved', 'consumed'].includes(state.state)) {
    throw new Error('Android 配对邀请批准状态不一致。');
  }
}

export class AndroidPairingInvitationStore {
  constructor(
    private readonly store: AndroidPairingInvitationValueStore,
    private readonly storageKey = ANDROID_PAIRING_INVITATION_KEY,
  ) {}

  async load() {
    const raw = await this.store.get(this.storageKey);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Android 配对邀请解密后不是有效 JSON。');
    }
    assertAndroidPairingInvitationV1(value);
    return value;
  }

  async save(value: AndroidPairingInvitationV1) {
    assertAndroidPairingInvitationV1(value);
    await this.store.set(
      this.storageKey,
      JSON.stringify(value),
    );
  }

  async clear() {
    await this.store.delete(this.storageKey);
  }
}

function invitationView(state: AndroidPairingInvitationV1) {
  return {
    state: state.state,
    pairingId: state.offer.pairingId,
    qrPayload: canonicalizeJsonV1(state.offer),
    verificationCode: state.verificationCode,
    expiresAt: state.offer.expiresAt,
    newDevice: state.request?.newDevice ?? null,
  };
}

export class AndroidPairingInvitationController {
  constructor(
    private readonly store: AndroidPairingInvitationStore,
    private readonly relay: InvitationRelayPort,
    private readonly dependencies: {
      randomBytes: SyncRandomBytesV1;
      randomUuid: SyncRandomUuidV1;
      loadActiveDevice(): Promise<ActiveDevice | null>;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }

  private async activeFor(state?: AndroidPairingInvitationV1) {
    const active = await this.dependencies.loadActiveDevice();
    if (!active) throw new Error('Android 当前没有 active 同步设备。');
    assertSyncDevicePublicIdentityV1(active.identity);
    assertSyncDeviceSecretsV1(active.secrets);
    if (
      active.identity.state !== 'active'
      || active.identity.revokedAt !== null
      || active.identity.vaultId !== active.secrets.vaultId
      || active.identity.deviceId !== active.secrets.deviceId
      || active.identity.keyId !== active.secrets.keyId
    ) {
      throw new Error('Android active 同步设备身份无效。');
    }
    if (state && (
      state.offer.vaultId !== active.identity.vaultId
      || state.offer.keyId !== active.identity.keyId
      || state.offer.inviterDeviceId !== active.identity.deviceId
    )) {
      throw new Error('Android 配对邀请不属于当前 active 设备。');
    }
    return {
      publicIdentity: active.identity,
      secrets: active.secrets,
    };
  }

  async snapshot() {
    const state = await this.store.load();
    return state ? invitationView(state) : null;
  }

  async prepareInvitation() {
    const existing = await this.store.load();
    if (existing && this.now() <= existing.offer.expiresAt) {
      throw new Error('Android 已有尚未过期的配对邀请。');
    }
    if (existing) await this.store.clear();
    const active = await this.activeFor();
    const createdAt = this.now();
    const invitation = await createSyncPairingOfferV1({
      inviter: active.publicIdentity,
      inviterSecrets: active.secrets,
      createdAt,
      expiresAt: createdAt + 15 * 60 * 1000,
      randomBytes: this.dependencies.randomBytes,
      randomUuid: this.dependencies.randomUuid,
    });
    const state: AndroidPairingInvitationV1 = {
      version: 1,
      state: 'prepared',
      offer: invitation.offer,
      localSecret: invitation.localSecret,
      relayDescriptor: invitation.relayDescriptor,
      request: null,
      verificationCode: null,
      pairingPackage: null,
      createdAt,
      updatedAt: createdAt,
    };
    await this.store.save(state);
    return invitationView(state);
  }

  async publishInvitation() {
    const state = await this.requireState();
    const active = await this.activeFor(state);
    let status: SyncRelayPairingSessionStatusV1;
    try {
      status = await this.relay.getPairingSession(
        active,
        state.offer.pairingId,
      );
    } catch (error) {
      if (!(error instanceof SyncRelayHttpError) || error.status !== 404) {
        throw error;
      }
      status = await this.relay.createPairingSession(
        active,
        state.relayDescriptor,
      );
    }
    const updated = this.reconcile(state, status);
    await this.store.save(updated);
    return invitationView(updated);
  }

  async refreshInvitation() {
    const state = await this.requireState();
    const active = await this.activeFor(state);
    const status = await this.relay.getPairingSession(
      active,
      state.offer.pairingId,
    );
    const updated = this.reconcile(state, status);
    await this.store.save(updated);
    return invitationView(updated);
  }

  async prepareApproval(confirmedVerificationCode: string) {
    const state = await this.requireState();
    const active = await this.activeFor(state);
    if (!state.request || !state.verificationCode) {
      throw new Error('Android 尚未收到 Windows 配对请求。');
    }
    if (confirmedVerificationCode !== state.verificationCode) {
      throw new Error('双端六位短码不一致，拒绝批准。');
    }
    if (state.pairingPackage) return invitationView(state);
    const pairingPackage = await createSyncPairingPackageV1({
      inviter: active.publicIdentity,
      inviterSecrets: active.secrets,
      offer: state.offer,
      localSecret: state.localSecret,
      request: state.request,
      confirmedVerificationCode,
      createdAt: this.now(),
      randomBytes: this.dependencies.randomBytes,
    });
    const updated: AndroidPairingInvitationV1 = {
      ...state,
      state: 'approval-prepared',
      pairingPackage,
      updatedAt: this.now(),
    };
    await this.store.save(updated);
    return invitationView(updated);
  }

  async submitApproval() {
    const state = await this.requireState();
    const active = await this.activeFor(state);
    if (!state.pairingPackage) {
      throw new Error('Android 尚未持久化配对批准包。');
    }
    let status = await this.relay.getPairingSession(
      active,
      state.offer.pairingId,
    );
    let updated = this.reconcile(state, status);
    if (updated.state === 'approved' || updated.state === 'consumed') {
      await this.store.save(updated);
      return invitationView(updated);
    }
    status = await this.relay.approvePairingSession({
      enrollment: active,
      pairingPackage: state.pairingPackage,
    });
    updated = this.reconcile(state, status);
    await this.store.save(updated);
    return invitationView(updated);
  }

  async clearExpiredInvitation() {
    const state = await this.requireState();
    if (this.now() <= state.offer.expiresAt) {
      throw new Error('配对邀请尚未过期，不能按过期记录清理。');
    }
    await this.store.clear();
  }

  private async requireState() {
    const state = await this.store.load();
    if (!state) throw new Error('Android 当前没有已落盘的配对邀请。');
    return state;
  }

  private reconcile(
    state: AndroidPairingInvitationV1,
    status: SyncRelayPairingSessionStatusV1,
  ): AndroidPairingInvitationV1 {
    if (
      status.pairingId !== state.offer.pairingId
      || status.expiresAt !== state.offer.expiresAt
    ) {
      throw new Error('中继配对状态与 Android 本地邀请不一致。');
    }
    if (status.request === null) {
      if (
        status.state !== 'created'
        || state.request !== null
        || state.pairingPackage !== null
      ) {
        throw new Error('中继配对状态缺少已经存在的请求或批准包。');
      }
      return {
        ...state,
        state: 'published',
        updatedAt: this.now(),
      };
    }
    assertSyncPairingRequestV1(status.request);
    verifySyncPairingRequestV1(
      state.offer,
      status.request,
      status.request.createdAt,
    );
    if (state.request && !sameJson(state.request, status.request)) {
      throw new Error('中继返回了不同的 Windows 配对请求。');
    }
    const verificationCode = pairingVerificationCodeForInviterV1(
      state.localSecret,
      state.offer,
      status.request,
      status.request.createdAt,
    );
    if (status.state === 'requested') {
      return {
        ...state,
        state: state.pairingPackage
          ? 'approval-prepared'
          : 'request-received',
        request: status.request,
        verificationCode,
        updatedAt: this.now(),
      };
    }
    if (!state.pairingPackage) {
      throw new Error('中继已批准或消费，但本机缺少持久化批准包。');
    }
    const nextState = status.state === 'consumed'
      ? 'consumed'
      : status.state === 'approved'
        ? 'approved'
        : null;
    if (!nextState) throw new Error('中继配对状态转换无效。');
    const updated: AndroidPairingInvitationV1 = {
      ...state,
      state: nextState,
      request: status.request,
      verificationCode,
      updatedAt: this.now(),
    };
    assertPackageMatches(updated, state.pairingPackage);
    return updated;
  }
}
