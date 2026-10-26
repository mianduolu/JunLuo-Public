import type {
  SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import {
  AndroidDeviceEnrollmentWorkflow,
  AndroidPendingDeviceEnrollmentStore,
  type AndroidPendingPairingEnrollmentV1,
} from './syncDeviceEnrollment';
import {
  AndroidEnrollmentRelayReceiptStore,
  type AndroidPairingConsumedReceiptV1,
} from './syncDeviceEnrollmentRelayReceipt';
import type { SyncRelayClient } from './syncRelayClient';

type EnrollmentRelayPort = Pick<
  SyncRelayClient,
  'submitPairingRequest' | 'consumePairingSession'
>;

type ActiveDeviceLoader = () => Promise<{
  identity: SyncDevicePublicIdentityV1;
} | null>;

function samePublicDevice(
  left: SyncDevicePublicIdentityV1,
  right: SyncDevicePublicIdentityV1,
) {
  return left.version === right.version
    && left.vaultId === right.vaultId
    && left.deviceId === right.deviceId
    && left.keyId === right.keyId
    && left.platform === right.platform
    && left.displayName === right.displayName
    && left.signingPublicKey === right.signingPublicKey
    && left.exchangePublicKey === right.exchangePublicKey
    && left.state === right.state
    && left.createdAt === right.createdAt
    && left.revokedAt === right.revokedAt;
}

function assertPairingReceiptMatches(
  pending: AndroidPendingPairingEnrollmentV1,
  receipt: AndroidPairingConsumedReceiptV1,
) {
  if (
    receipt.pairingId !== pending.offer.pairingId
    || receipt.pairingPackage.pairingId
      !== pending.offer.pairingId
    || receipt.pairingPackage.requestId
      !== pending.request.requestId
    || receipt.pairingPackage.newDeviceId
      !== pending.request.newDevice.deviceId
    || receipt.pairingPackage.inviterDeviceId
      !== pending.offer.inviterDeviceId
    || !samePublicDevice(receipt.registeredDevice, {
      ...pending.request.newDevice,
      state: 'active',
    })
  ) {
    throw new Error('中继配对回执与 Android pending 配对不一致。');
  }
}

export class AndroidDeviceEnrollmentRelayCoordinator {
  constructor(
    private readonly enrollmentStore:
      AndroidPendingDeviceEnrollmentStore,
    private readonly receiptStore:
      AndroidEnrollmentRelayReceiptStore,
    private readonly enrollmentWorkflow:
      AndroidDeviceEnrollmentWorkflow,
    private readonly relayClient: EnrollmentRelayPort,
    private readonly loadActiveDevice: ActiveDeviceLoader,
    private readonly now: () => number = Date.now,
  ) {}

  async submitPendingPairing() {
    const pending = await this.enrollmentStore.load();
    if (pending?.state !== 'pending-pairing') {
      throw new Error('Android 当前没有待提交的配对请求。');
    }
    if (await this.receiptStore.load()) {
      throw new Error('配对已经收到中继回执，请先完成本机激活。');
    }
    return this.relayClient.submitPairingRequest({
      pairingToken: pending.offer.pairingToken,
      request: pending.request,
    });
  }

  async receivePendingPairing() {
    const pending = await this.enrollmentStore.load();
    if (pending?.state !== 'pending-pairing') {
      throw new Error('Android 当前没有待领取的配对包。');
    }
    const existingReceipt = await this.receiptStore.load();
    if (existingReceipt) {
      assertPairingReceiptMatches(pending, existingReceipt);
      return existingReceipt;
    }
    const consumed = await this.relayClient.consumePairingSession({
      pairingId: pending.offer.pairingId,
      pairingToken: pending.offer.pairingToken,
    });
    const receipt: AndroidPairingConsumedReceiptV1 = {
      version: 1,
      state: 'pairing-consumed',
      pairingId: pending.offer.pairingId,
      pairingPackage: consumed.pairingPackage,
      registeredDevice: consumed.registeredDevice,
      receivedAt: this.now(),
    };
    assertPairingReceiptMatches(pending, receipt);
    await this.receiptStore.save(receipt);
    return receipt;
  }

  async finalizeReceivedPairing(
    confirmedVerificationCode: string,
  ) {
    const receipt = await this.receiptStore.load();
    if (receipt?.state !== 'pairing-consumed') {
      throw new Error('Android 当前没有已落盘的配对消费回执。');
    }
    const pending = await this.enrollmentStore.load();
    if (pending === null) {
      const active = await this.loadActiveDevice();
      if (
        !active
        || !samePublicDevice(
          active.identity,
          receipt.registeredDevice,
        )
      ) {
        throw new Error('当前 active 设备与遗留配对回执不一致。');
      }
      await this.receiptStore.clear();
      return active.identity;
    }
    if (pending.state !== 'pending-pairing') {
      throw new Error('配对回执对应的是另一种 pending 状态。');
    }
    assertPairingReceiptMatches(pending, receipt);
    const activated =
      await this.enrollmentWorkflow.acceptPairingPackage({
        pairingPackage: receipt.pairingPackage,
        confirmedVerificationCode,
      });
    if (!samePublicDevice(activated, receipt.registeredDevice)) {
      throw new Error('本机解密后的设备身份与中继登记结果不一致。');
    }
    await this.receiptStore.clear();
    return activated;
  }
}
