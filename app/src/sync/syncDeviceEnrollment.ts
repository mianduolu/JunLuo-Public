import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonV1,
  exchangePublicKeyFromPrivateV1,
  signingPublicKeyFromPrivateV1,
} from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  assertPendingSyncDeviceSecretsV1,
  createPendingSyncDeviceV1,
  type PendingSyncDeviceSecretsV1,
  type SyncRandomBytesV1,
  type SyncRandomUuidV1,
} from './syncDeviceProvisioning';
import {
  acceptSyncPairingPackageV1,
  assertSyncPairingOfferV1,
  assertSyncPairingPackageV1,
  assertSyncPairingRequestV1,
  createSyncPairingRequestV1,
  pairingVerificationCodeForNewDeviceV1,
  type SyncPairingOfferV1,
  type SyncPairingPackageV1,
  type SyncPairingRequestV1,
} from './syncPairing';

const ANDROID_PENDING_ENROLLMENT_KEY =
  'junluo.sync.android-pending-enrollment.v1';

export interface AndroidEnrollmentValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export type AndroidPendingPairingEnrollmentV1 = {
  version: 1;
  state: 'pending-pairing';
  offer: SyncPairingOfferV1;
  request: SyncPairingRequestV1;
  pendingSecrets: PendingSyncDeviceSecretsV1;
  verificationCode: string;
  createdAt: number;
};

export type AndroidPendingDeviceEnrollmentV1 =
  AndroidPendingPairingEnrollmentV1;

export type AndroidPendingEnrollmentSnapshot =
  | { state: 'unprovisioned' }
  | {
      state: AndroidPendingDeviceEnrollmentV1['state'];
      vaultId: string;
      deviceId: string;
      keyId: string;
      displayName: string;
      createdAt: number;
    };

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Android 待登记设备记录必须是对象。');
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
) {
  const keys = Object.keys(value);
  if (
    keys.some((key) => !expected.includes(key))
    || expected.some((key) => !(key in value))
  ) {
    throw new Error('Android 待登记设备记录字段不符合 v1 合同。');
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertPublicMatchesPrivate(
  identity: SyncDevicePublicIdentityV1,
  secrets: Pick<
    SyncDeviceSecretsV1 | PendingSyncDeviceSecretsV1,
    | 'vaultId'
    | 'deviceId'
    | 'keyId'
    | 'signingPrivateKey'
    | 'exchangePrivateKey'
  >,
) {
  assertSyncDevicePublicIdentityV1(identity);
  if (
    identity.vaultId !== secrets.vaultId
    || identity.deviceId !== secrets.deviceId
    || identity.keyId !== secrets.keyId
  ) {
    throw new Error('Android 设备公开身份与本机秘密标识不一致。');
  }
  const signingPublicKey = bytesToBase64Url(
    signingPublicKeyFromPrivateV1(base64UrlToBytes(
      secrets.signingPrivateKey,
      'signingPrivateKey',
      32,
    )),
  );
  const exchangePublicKey = bytesToBase64Url(
    exchangePublicKeyFromPrivateV1(base64UrlToBytes(
      secrets.exchangePrivateKey,
      'exchangePrivateKey',
      32,
    )),
  );
  if (
    identity.signingPublicKey !== signingPublicKey
    || identity.exchangePublicKey !== exchangePublicKey
  ) {
    throw new Error('Android 设备公钥与本机私钥不匹配。');
  }
}

export function assertAndroidPendingDeviceEnrollmentV1(
  value: unknown,
): asserts value is AndroidPendingDeviceEnrollmentV1 {
  const record = recordOf(value);
  if (record.version !== 1) {
    throw new Error('Android 待登记设备记录版本不受支持。');
  }
  if (record.state === 'pending-pairing') {
    assertExactKeys(record, [
      'version',
      'state',
      'offer',
      'request',
      'pendingSecrets',
      'verificationCode',
      'createdAt',
    ]);
    assertSyncPairingOfferV1(record.offer);
    assertSyncPairingRequestV1(record.request);
    assertPendingSyncDeviceSecretsV1(record.pendingSecrets);
    assertTimestamp(record.createdAt, 'createdAt');
    const offer = record.offer as SyncPairingOfferV1;
    const request = record.request as SyncPairingRequestV1;
    const pending = record.pendingSecrets as PendingSyncDeviceSecretsV1;
    if (
      request.newDevice.platform !== 'android'
      || request.newDevice.state !== 'pending'
      || request.createdAt !== record.createdAt
    ) {
      throw new Error('Android 配对请求的平台、状态或创建时间不一致。');
    }
    assertPublicMatchesPrivate(request.newDevice, pending);
    const expectedCode = pairingVerificationCodeForNewDeviceV1(
      pending,
      offer,
      request,
      request.createdAt,
    );
    if (
      typeof record.verificationCode !== 'string'
      || !/^\d{6}$/.test(record.verificationCode)
      || record.verificationCode !== expectedCode
    ) {
      throw new Error('Android 配对短码与加密 transcript 不一致。');
    }
    return;
  }
  throw new Error('Android 待登记设备状态不受支持。');
}

function snapshotOf(
  enrollment: AndroidPendingDeviceEnrollmentV1,
): AndroidPendingEnrollmentSnapshot {
  const identity = enrollment.request.newDevice;
  return {
    state: enrollment.state,
    vaultId: identity.vaultId,
    deviceId: identity.deviceId,
    keyId: identity.keyId,
    displayName: identity.displayName,
    createdAt: enrollment.createdAt,
  };
}

export class AndroidPendingDeviceEnrollmentStore {
  constructor(
    private readonly secureStore: AndroidEnrollmentValueStore,
  ) {}

  async load(): Promise<AndroidPendingDeviceEnrollmentV1 | null> {
    const raw = await this.secureStore.get(
      ANDROID_PENDING_ENROLLMENT_KEY,
    );
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Android 待登记设备密文解开后不是有效 JSON。');
    }
    assertAndroidPendingDeviceEnrollmentV1(value);
    return value;
  }

  async snapshot(): Promise<AndroidPendingEnrollmentSnapshot> {
    const enrollment = await this.load();
    return enrollment ? snapshotOf(enrollment) : {
      state: 'unprovisioned',
    };
  }

  async save(enrollment: AndroidPendingDeviceEnrollmentV1) {
    assertAndroidPendingDeviceEnrollmentV1(enrollment);
    await this.secureStore.set(
      ANDROID_PENDING_ENROLLMENT_KEY,
      JSON.stringify(enrollment),
    );
  }

  async clear() {
    await this.secureStore.delete(ANDROID_PENDING_ENROLLMENT_KEY);
  }
}

export class AndroidDeviceEnrollmentWorkflow {
  constructor(
    private readonly store: AndroidPendingDeviceEnrollmentStore,
    private readonly dependencies: {
      randomBytes: SyncRandomBytesV1;
      randomUuid: SyncRandomUuidV1;
      commitActiveDevice(
        identity: SyncDevicePublicIdentityV1,
        secrets: SyncDeviceSecretsV1,
      ): Promise<void>;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }

  private async assertNoPendingEnrollment() {
    if (await this.store.load()) {
      throw new Error('Android 已有未完成的设备登记，请先完成或明确清除。');
    }
  }

  async preparePairingJoin(input: {
    offerQrPayload: string;
    displayName: string;
  }) {
    await this.assertNoPendingEnrollment();
    let offer: unknown;
    try {
      offer = JSON.parse(input.offerQrPayload);
    } catch {
      throw new Error('一次性配对二维码不是有效 JSON。');
    }
    assertSyncPairingOfferV1(offer);
    const createdAt = this.now();
    const pending = await createPendingSyncDeviceV1({
      vaultId: offer.vaultId,
      keyId: offer.keyId,
      platform: 'android',
      displayName: input.displayName,
      createdAt,
      randomBytes: this.dependencies.randomBytes,
      randomUuid: this.dependencies.randomUuid,
    });
    const request = createSyncPairingRequestV1({
      offer,
      newDevice: pending.publicIdentity,
      pendingSecrets: pending.pendingSecrets,
      requestId: await this.dependencies.randomUuid(),
      createdAt,
    });
    const verificationCode = pairingVerificationCodeForNewDeviceV1(
      pending.pendingSecrets,
      offer,
      request,
      createdAt,
    );
    const enrollment: AndroidPendingPairingEnrollmentV1 = {
      version: 1,
      state: 'pending-pairing',
      offer,
      request,
      pendingSecrets: pending.pendingSecrets,
      verificationCode,
      createdAt,
    };
    await this.store.save(enrollment);
    return {
      pairingId: offer.pairingId,
      pairingToken: offer.pairingToken,
      request,
      verificationCode,
      expiresAt: offer.expiresAt,
    };
  }

  async acceptPairingPackage(input: {
    pairingPackage: SyncPairingPackageV1;
    confirmedVerificationCode: string;
  }) {
    assertSyncPairingPackageV1(input.pairingPackage);
    const enrollment = await this.store.load();
    if (enrollment?.state !== 'pending-pairing') {
      throw new Error('Android 当前没有待完成的一次性配对。');
    }
    if (
      input.confirmedVerificationCode
      !== enrollment.verificationCode
    ) {
      throw new Error('输入短码与本机配对短码不一致。');
    }
    const accepted = acceptSyncPairingPackageV1({
      offer: enrollment.offer,
      request: enrollment.request,
      pairingPackage: input.pairingPackage,
      pendingSecrets: enrollment.pendingSecrets,
      confirmedVerificationCode: input.confirmedVerificationCode,
      now: this.now(),
    });
    assertSyncDeviceSecretsV1(accepted.secrets);
    await this.dependencies.commitActiveDevice(
      accepted.publicIdentity,
      accepted.secrets,
    );
    await this.store.clear();
    return accepted.publicIdentity;
  }

  async exportPendingPairingRequest() {
    const enrollment = await this.store.load();
    if (enrollment?.state !== 'pending-pairing') return null;
    return {
      pairingId: enrollment.offer.pairingId,
      pairingToken: enrollment.offer.pairingToken,
      requestJson: canonicalizeJsonV1(enrollment.request),
      verificationCode: enrollment.verificationCode,
      expiresAt: enrollment.offer.expiresAt,
    };
  }

  async clearPendingEnrollment() {
    await this.store.clear();
  }
}
