import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  deriveSyncVaultKeysV1,
  exchangePublicKeyFromPrivateV1,
  signEd25519V1,
  signingPublicKeyFromPrivateV1,
  verifyEd25519V1,
} from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  assertSyncUuidV4,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  assertSyncVaultPublicRegistrationV1,
  createSyncVaultPublicRegistrationV1,
  type SyncVaultPublicRegistrationV1,
} from './syncRecoveryAuthorization';

const INITIAL_DEVICE_REGISTRATION_CONTEXT_V1 =
  'junluo.sync.v1/initial-device-registration';
const MAX_INITIAL_DEVICE_REGISTRATION_TTL_MS =
  10 * 60 * 1000;

export type SyncInitialDeviceRegistrationV1 = {
  version: 1;
  vaultRegistration: SyncVaultPublicRegistrationV1;
  initialDevice: SyncDevicePublicIdentityV1;
  requestId: string;
  createdAt: number;
  expiresAt: number;
  recoverySignature: string;
  deviceSignature: string;
};

type SyncInitialDeviceRegistrationBodyV1 = Omit<
  SyncInitialDeviceRegistrationV1,
  'recoverySignature' | 'deviceSignature'
>;

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

function registrationBody(
  registration: SyncInitialDeviceRegistrationV1,
): SyncInitialDeviceRegistrationBodyV1 {
  const {
    recoverySignature: _recoverySignature,
    deviceSignature: _deviceSignature,
    ...body
  } = registration;
  return body;
}

export function initialDeviceRegistrationSignatureInputV1(
  body: SyncInitialDeviceRegistrationBodyV1,
  proof: 'recovery' | 'device',
) {
  return canonicalizeJsonBytesV1({
    context: INITIAL_DEVICE_REGISTRATION_CONTEXT_V1,
    proof,
    registration: body,
  });
}

export function assertSyncInitialDeviceRegistrationV1(
  value: unknown,
): asserts value is SyncInitialDeviceRegistrationV1 {
  const record = recordOf(value, '首台设备登记');
  assertExactKeys(
    record,
    [
      'version',
      'vaultRegistration',
      'initialDevice',
      'requestId',
      'createdAt',
      'expiresAt',
      'recoverySignature',
      'deviceSignature',
    ],
    '首台设备登记',
  );
  if (record.version !== 1) {
    throw new Error('首台设备登记版本不受支持。');
  }
  assertSyncVaultPublicRegistrationV1(record.vaultRegistration);
  assertSyncDevicePublicIdentityV1(record.initialDevice);
  assertSyncUuidV4(record.requestId, 'requestId');
  assertTimestamp(record.createdAt, 'createdAt');
  assertTimestamp(record.expiresAt, 'expiresAt');
  const vault =
    record.vaultRegistration as SyncVaultPublicRegistrationV1;
  const device =
    record.initialDevice as SyncDevicePublicIdentityV1;
  if (device.state !== 'active' || device.revokedAt !== null) {
    throw new Error('首台设备必须是未撤销的 active 设备。');
  }
  if (
    device.vaultId !== vault.vaultId
    || device.keyId !== vault.keyId
    || device.createdAt !== vault.createdAt
  ) {
    throw new Error('首台设备与 vault 公开登记不匹配。');
  }
  if (
    Number(record.expiresAt) <= Number(record.createdAt)
    || Number(record.expiresAt) - Number(record.createdAt)
      > MAX_INITIAL_DEVICE_REGISTRATION_TTL_MS
  ) {
    throw new Error('首台设备登记有效期必须大于 0 且不超过 10 分钟。');
  }
  base64UrlToBytes(
    record.recoverySignature as string,
    'recoverySignature',
    64,
  );
  base64UrlToBytes(
    record.deviceSignature as string,
    'deviceSignature',
    64,
  );
}

export function createSyncInitialDeviceRegistrationV1(input: {
  initialDevice: SyncDevicePublicIdentityV1;
  secrets: SyncDeviceSecretsV1;
  requestId: string;
  createdAt: number;
  expiresAt: number;
}) {
  assertSyncDevicePublicIdentityV1(input.initialDevice);
  assertSyncDeviceSecretsV1(input.secrets);
  assertSyncUuidV4(input.requestId, 'requestId');
  assertTimestamp(input.createdAt, 'createdAt');
  assertTimestamp(input.expiresAt, 'expiresAt');
  if (
    input.initialDevice.state !== 'active'
    || input.initialDevice.revokedAt !== null
    || input.initialDevice.vaultId !== input.secrets.vaultId
    || input.initialDevice.deviceId !== input.secrets.deviceId
    || input.initialDevice.keyId !== input.secrets.keyId
  ) {
    throw new Error('首台设备身份与本机设备秘密不匹配。');
  }
  const signingPublicKey = bytesToBase64Url(
    signingPublicKeyFromPrivateV1(base64UrlToBytes(
      input.secrets.signingPrivateKey,
      'signingPrivateKey',
      32,
    )),
  );
  const exchangePublicKey = bytesToBase64Url(
    exchangePublicKeyFromPrivateV1(base64UrlToBytes(
      input.secrets.exchangePrivateKey,
      'exchangePrivateKey',
      32,
    )),
  );
  if (
    signingPublicKey !== input.initialDevice.signingPublicKey
    || exchangePublicKey !== input.initialDevice.exchangePublicKey
  ) {
    throw new Error('首台设备公开身份与本机私钥不匹配。');
  }
  const vaultRegistration = createSyncVaultPublicRegistrationV1(
    input.secrets,
    input.initialDevice.createdAt,
  );
  const body: SyncInitialDeviceRegistrationBodyV1 = {
    version: 1,
    vaultRegistration,
    initialDevice: input.initialDevice,
    requestId: input.requestId,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const recoveryAuthorizationKey = deriveSyncVaultKeysV1(
    base64UrlToBytes(
      input.secrets.vaultRootSecret,
      'vaultRootSecret',
      32,
    ),
  ).recoveryAuthorizationKey;
  const registration: SyncInitialDeviceRegistrationV1 = {
    ...body,
    recoverySignature: bytesToBase64Url(signEd25519V1(
      initialDeviceRegistrationSignatureInputV1(body, 'recovery'),
      recoveryAuthorizationKey,
    )),
    deviceSignature: bytesToBase64Url(signEd25519V1(
      initialDeviceRegistrationSignatureInputV1(body, 'device'),
      base64UrlToBytes(
        input.secrets.signingPrivateKey,
        'signingPrivateKey',
        32,
      ),
    )),
  };
  assertSyncInitialDeviceRegistrationV1(registration);
  return registration;
}

export function verifySyncInitialDeviceRegistrationV1(
  registration: SyncInitialDeviceRegistrationV1,
  now: number,
) {
  assertSyncInitialDeviceRegistrationV1(registration);
  assertTimestamp(now, 'now');
  if (now > registration.expiresAt) {
    throw new Error('首台设备登记已经过期。');
  }
  const body = registrationBody(registration);
  const recoveryValid = verifyEd25519V1(
    base64UrlToBytes(
      registration.recoverySignature,
      'recoverySignature',
      64,
    ),
    initialDeviceRegistrationSignatureInputV1(body, 'recovery'),
    base64UrlToBytes(
      registration.vaultRegistration
        .recoveryAuthorizationPublicKey,
      'recoveryAuthorizationPublicKey',
      32,
    ),
  );
  if (!recoveryValid) {
    throw new Error('首台设备恢复授权签名验证失败。');
  }
  const deviceValid = verifyEd25519V1(
    base64UrlToBytes(
      registration.deviceSignature,
      'deviceSignature',
      64,
    ),
    initialDeviceRegistrationSignatureInputV1(body, 'device'),
    base64UrlToBytes(
      registration.initialDevice.signingPublicKey,
      'signingPublicKey',
      32,
    ),
  );
  if (!deviceValid) {
    throw new Error('首台设备签名验证失败。');
  }
}
