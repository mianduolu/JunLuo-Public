import { canonicalizeJsonV1 } from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { AndroidEnrollmentValueStore } from './syncDeviceEnrollment';
import {
  assertSyncPairingPackageV1,
  type SyncPairingPackageV1,
} from './syncPairing';

const ANDROID_ENROLLMENT_RELAY_RECEIPT_KEY =
  'junluo.sync.android-enrollment-relay-receipt.v1';

export type AndroidPairingConsumedReceiptV1 = {
  version: 1;
  state: 'pairing-consumed';
  pairingId: string;
  pairingPackage: SyncPairingPackageV1;
  registeredDevice: SyncDevicePublicIdentityV1;
  receivedAt: number;
};

export type AndroidEnrollmentRelayReceiptV1 =
  AndroidPairingConsumedReceiptV1;

function recordOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Android 设备登记中继回执必须是对象。');
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
) {
  const keys = Object.keys(record);
  if (
    keys.some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('Android 设备登记中继回执字段不符合 v1 合同。');
  }
}

function assertTimestamp(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('Android 设备登记中继回执时间无效。');
  }
}

export function assertAndroidEnrollmentRelayReceiptV1(
  value: unknown,
): asserts value is AndroidEnrollmentRelayReceiptV1 {
  const record = recordOf(value);
  if (record.version !== 1) {
    throw new Error('Android 设备登记中继回执版本不受支持。');
  }
  if (record.state === 'pairing-consumed') {
    assertExactKeys(record, [
      'version',
      'state',
      'pairingId',
      'pairingPackage',
      'registeredDevice',
      'receivedAt',
    ]);
    assertSyncUuidV4(record.pairingId, 'pairingId');
    assertSyncPairingPackageV1(record.pairingPackage);
    assertSyncDevicePublicIdentityV1(record.registeredDevice);
    const pairingPackage =
      record.pairingPackage as SyncPairingPackageV1;
    const registeredDevice =
      record.registeredDevice as SyncDevicePublicIdentityV1;
    if (
      pairingPackage.pairingId !== record.pairingId
      || registeredDevice.platform !== 'android'
      || registeredDevice.state !== 'active'
      || registeredDevice.vaultId !== pairingPackage.vaultId
      || registeredDevice.deviceId !== pairingPackage.newDeviceId
      || registeredDevice.keyId !== pairingPackage.keyId
    ) {
      throw new Error('Android 配对消费回执内部不一致。');
    }
    assertTimestamp(record.receivedAt);
    return;
  }
  throw new Error('Android 设备登记中继回执状态不受支持。');
}

function sameReceipt(
  left: AndroidEnrollmentRelayReceiptV1,
  right: AndroidEnrollmentRelayReceiptV1,
) {
  return canonicalizeJsonV1(left) === canonicalizeJsonV1(right);
}

export class AndroidEnrollmentRelayReceiptStore {
  constructor(
    private readonly secureStore: AndroidEnrollmentValueStore,
  ) {}

  async load(): Promise<AndroidEnrollmentRelayReceiptV1 | null> {
    const raw = await this.secureStore.get(
      ANDROID_ENROLLMENT_RELAY_RECEIPT_KEY,
    );
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(
        'Android 设备登记中继回执密文解开后不是有效 JSON。',
      );
    }
    assertAndroidEnrollmentRelayReceiptV1(value);
    return value;
  }

  async save(receipt: AndroidEnrollmentRelayReceiptV1) {
    assertAndroidEnrollmentRelayReceiptV1(receipt);
    const current = await this.load();
    if (current && !sameReceipt(current, receipt)) {
      throw new Error('已有另一份未完成的设备登记中继回执。');
    }
    await this.secureStore.set(
      ANDROID_ENROLLMENT_RELAY_RECEIPT_KEY,
      JSON.stringify(receipt),
    );
  }

  async clear() {
    await this.secureStore.delete(
      ANDROID_ENROLLMENT_RELAY_RECEIPT_KEY,
    );
  }

  async snapshot() {
    const receipt = await this.load();
    return receipt
      ? { state: receipt.state, receivedAt: receipt.receivedAt }
      : { state: 'none' as const };
  }
}
