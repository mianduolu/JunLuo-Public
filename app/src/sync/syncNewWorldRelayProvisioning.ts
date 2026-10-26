import {
  assertSyncDevicePublicIdentityV1,
  type SyncDevicePublicIdentityV1,
} from './syncDeviceContract';
import type { SyncRandomUuidV1 } from './syncDeviceProvisioning';
import {
  assertSyncInitialDeviceRegistrationV1,
  createSyncInitialDeviceRegistrationV1,
  type SyncInitialDeviceRegistrationV1,
} from './syncInitialProvisioning';
import type {
  NewWorldAndroidStagingSecretV1,
} from './syncNewWorldSecretsExpo';

export interface NewWorldRelayProvisioningValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export type NewWorldRelayProvisioningV1 = Readonly<{
  version: 1;
  state: 'prepared' | 'provisioned';
  registration: SyncInitialDeviceRegistrationV1;
  registeredDevice: SyncDevicePublicIdentityV1 | null;
  updatedAt: number;
}>;

export type NewWorldRelayProvisioningSnapshot = Readonly<{
  state: 'not-ready' | 'ready' | 'prepared' | 'provisioned';
  registeredDevice: SyncDevicePublicIdentityV1 | null;
}>;

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative timestamp`);
  }
}

function sameDevice(
  left: SyncDevicePublicIdentityV1,
  right: SyncDevicePublicIdentityV1,
) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function assertNewWorldRelayProvisioningV1(
  value: unknown,
): asserts value is NewWorldRelayProvisioningV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('new-world relay provisioning must be an object');
  }
  const record = value as Record<string, unknown>;
  const expected = [
    'version',
    'state',
    'registration',
    'registeredDevice',
    'updatedAt',
  ];
  if (
    Object.keys(record).some((key) => !expected.includes(key))
    || expected.some((key) => !(key in record))
  ) {
    throw new Error('new-world relay provisioning fields do not match v1');
  }
  if (
    record.version !== 1
    || (record.state !== 'prepared' && record.state !== 'provisioned')
  ) {
    throw new Error('new-world relay provisioning state is invalid');
  }
  assertSyncInitialDeviceRegistrationV1(record.registration);
  assertTimestamp(record.updatedAt, 'new-world relay provisioning updatedAt');
  const registration = record.registration as SyncInitialDeviceRegistrationV1;
  if (record.state === 'prepared') {
    if (record.registeredDevice !== null) {
      throw new Error('prepared new-world relay provisioning has a receipt');
    }
    return;
  }
  assertSyncDevicePublicIdentityV1(record.registeredDevice);
  if (!sameDevice(
    record.registeredDevice as SyncDevicePublicIdentityV1,
    registration.initialDevice,
  )) {
    throw new Error('new-world relay provisioning receipt does not match');
  }
}

function assertMatchesStaging(
  staging: NewWorldAndroidStagingSecretV1,
  state: NewWorldRelayProvisioningV1,
) {
  const registration = state.registration;
  if (
    registration.vaultRegistration.vaultId !== staging.world.vaultId
    || registration.vaultRegistration.keyId !== staging.world.keyId
    || !sameDevice(registration.initialDevice, staging.identity)
  ) {
    throw new Error('new-world relay provisioning belongs to another world');
  }
}

export function newWorldRelayProvisioningSnapshot(
  staging: NewWorldAndroidStagingSecretV1 | null,
  state: NewWorldRelayProvisioningV1 | null,
): NewWorldRelayProvisioningSnapshot {
  if (!staging) {
    if (state) {
      throw new Error('new-world relay provisioning is missing its staging identity');
    }
    return { state: 'not-ready', registeredDevice: null };
  }
  if (!state) return { state: 'ready', registeredDevice: null };
  assertMatchesStaging(staging, state);
  return {
    state: state.state,
    registeredDevice: state.registeredDevice,
  };
}

export class NewWorldRelayProvisioningStore {
  constructor(
    private readonly store: NewWorldRelayProvisioningValueStore,
    private readonly storageKey = 'junluo.sync.v2.relay-provisioning.v1',
  ) {}

  async load(): Promise<NewWorldRelayProvisioningV1 | null> {
    const raw = await this.store.get(this.storageKey);
    if (raw === null) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error('new-world relay provisioning is not valid JSON');
    }
    assertNewWorldRelayProvisioningV1(value);
    return value;
  }

  async save(value: NewWorldRelayProvisioningV1) {
    assertNewWorldRelayProvisioningV1(value);
    const current = await this.load();
    if (
      current?.state === 'provisioned'
      && JSON.stringify(current) !== JSON.stringify(value)
    ) {
      throw new Error('provisioned new-world relay identity cannot be replaced');
    }
    await this.store.set(this.storageKey, JSON.stringify(value));
  }
}

export class NewWorldRelayProvisioningController {
  constructor(
    private readonly store: NewWorldRelayProvisioningStore,
    private readonly relay: {
      provisionInitialDevice(
        registration: SyncInitialDeviceRegistrationV1,
      ): Promise<SyncDevicePublicIdentityV1>;
    },
    private readonly dependencies: {
      loadStaging(): Promise<NewWorldAndroidStagingSecretV1 | null>;
      assertLocalBaselineComplete(): Promise<void>;
      randomUuid: SyncRandomUuidV1;
      now?: () => number;
    },
  ) {}

  private now() {
    return this.dependencies.now?.() ?? Date.now();
  }

  async snapshot() {
    return newWorldRelayProvisioningSnapshot(
      await this.dependencies.loadStaging(),
      await this.store.load(),
    );
  }

  async provision() {
    await this.dependencies.assertLocalBaselineComplete();
    const staging = await this.dependencies.loadStaging();
    if (!staging) {
      throw new Error('new-world Android staging identity is not ready');
    }
    let current = await this.store.load();
    if (current) assertMatchesStaging(staging, current);
    if (current?.state === 'provisioned') return this.snapshot();

    const now = this.now();
    if (!current || now > current.registration.expiresAt) {
      const registration = createSyncInitialDeviceRegistrationV1({
        initialDevice: staging.identity,
        secrets: staging.secrets,
        requestId: await this.dependencies.randomUuid(),
        createdAt: now,
        expiresAt: now + 10 * 60 * 1000,
      });
      current = Object.freeze({
        version: 1,
        state: 'prepared',
        registration,
        registeredDevice: null,
        updatedAt: now,
      });
      await this.store.save(current);
    }

    const registeredDevice = await this.relay.provisionInitialDevice(
      current.registration,
    );
    if (!sameDevice(registeredDevice, staging.identity)) {
      throw new Error('new-world relay returned another initial device');
    }
    await this.store.save(Object.freeze({
      ...current,
      state: 'provisioned',
      registeredDevice,
      updatedAt: this.now(),
    }));
    return this.snapshot();
  }
}
