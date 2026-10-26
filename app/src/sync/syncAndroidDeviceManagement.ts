import {
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type {
  SyncRelayActiveEnrollmentV1,
  SyncRelayClient,
} from './syncRelayClient';

export type AndroidManagedSyncDeviceV1 = {
  deviceId: string;
  platform: 'android' | 'windows';
  displayName: string;
  state: 'pending' | 'active' | 'revoked';
  createdAt: number;
  revokedAt: number | null;
  isCurrent: boolean;
};

export type AndroidDeviceDirectorySnapshotV1 = {
  currentDeviceId: string;
  devices: AndroidManagedSyncDeviceV1[];
  refreshedAt: number;
};

type AndroidDeviceDirectoryRelayPort = Pick<
  SyncRelayClient,
  'listDevices' | 'renameCurrentDevice' | 'revokeDevice'
>;

type AndroidCurrentIdentityWriter = (
  identity: SyncDevicePublicIdentityV1,
) => Promise<void>;

function publicDevice(
  identity: SyncDevicePublicIdentityV1,
  currentDeviceId: string,
): AndroidManagedSyncDeviceV1 {
  return {
    deviceId: identity.deviceId,
    platform: identity.platform,
    displayName: identity.displayName,
    state: identity.state,
    createdAt: identity.createdAt,
    revokedAt: identity.revokedAt,
    isCurrent: identity.deviceId === currentDeviceId,
  };
}

function sortDevices(devices: AndroidManagedSyncDeviceV1[]) {
  return devices.sort((left, right) => {
    if (left.isCurrent !== right.isCurrent) {
      return left.isCurrent ? -1 : 1;
    }
    if (left.state !== right.state) {
      return left.state === 'active' ? -1 : 1;
    }
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt;
    }
    return left.deviceId < right.deviceId
      ? -1
      : left.deviceId > right.deviceId
        ? 1
        : 0;
  });
}

export class AndroidDeviceManagementController {
  constructor(
    private readonly relay: AndroidDeviceDirectoryRelayPort,
    private readonly loadEnrollment: () => Promise<
      SyncRelayActiveEnrollmentV1 | null
    >,
    private readonly now: () => number = Date.now,
    private readonly saveCurrentIdentity?: AndroidCurrentIdentityWriter,
  ) {}

  private async activeEnrollment() {
    const enrollment = await this.loadEnrollment();
    if (
      !enrollment
      || enrollment.publicIdentity.platform !== 'android'
      || enrollment.publicIdentity.state !== 'active'
      || enrollment.publicIdentity.revokedAt !== null
    ) {
      throw new Error('Android 当前没有 active 设备身份。');
    }
    return enrollment;
  }

  private snapshotFor(
    enrollment: SyncRelayActiveEnrollmentV1,
    devices: readonly SyncDevicePublicIdentityV1[],
  ): AndroidDeviceDirectorySnapshotV1 {
    const current = devices.find(
      (device) =>
        device.deviceId === enrollment.publicIdentity.deviceId
        && device.state === 'active'
        && device.revokedAt === null,
    );
    if (!current) {
      throw new Error('中继设备目录未确认当前 Android active 身份。');
    }
    return {
      currentDeviceId: enrollment.publicIdentity.deviceId,
      devices: sortDevices(devices.map((device) => publicDevice(
        device,
        enrollment.publicIdentity.deviceId,
      ))),
      refreshedAt: this.now(),
    };
  }

  async refreshDirectory() {
    const enrollment = await this.activeEnrollment();
    const devices = await this.relay.listDevices(enrollment);
    const current = devices.find(
      (device) => device.deviceId === enrollment.publicIdentity.deviceId,
    );
    if (current) await this.saveCurrentIdentity?.(current);
    return this.snapshotFor(enrollment, devices);
  }

  async renameCurrentDevice(displayName: unknown) {
    const enrollment = await this.activeEnrollment();
    const renamed = await this.relay.renameCurrentDevice(
      enrollment,
      displayName,
    );
    try {
      await this.saveCurrentIdentity?.(renamed);
      const devices = await this.relay.listDevices({
        ...enrollment,
        publicIdentity: renamed,
      });
      return this.snapshotFor(
        { ...enrollment, publicIdentity: renamed },
        devices,
      );
    } catch (cause) {
      throw new Error(
        '昵称已经由中继保存，本机将在下次刷新设备时补齐。',
        { cause },
      );
    }
  }

  async revokePeerDevice(deviceId: unknown) {
    assertSyncUuidV4(deviceId, 'deviceId');
    const enrollment = await this.activeEnrollment();
    if (deviceId === enrollment.publicIdentity.deviceId) {
      throw new Error('不能从当前 Android 会话撤销这台手机。');
    }
    const devices = await this.relay.listDevices(enrollment);
    const target = devices.find((device) => device.deviceId === deviceId);
    if (!target || target.state !== 'active' || target.revokedAt !== null) {
      throw new Error('目标设备不存在或已经撤销。');
    }
    const revoked = await this.relay.revokeDevice(enrollment, deviceId);
    return this.snapshotFor(
      enrollment,
      devices.map((device) =>
        device.deviceId === deviceId ? revoked : device),
    );
  }
}
