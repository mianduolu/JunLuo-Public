import { Buffer } from 'buffer';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  decryptXChaCha20Poly1305V1,
  derivePairingWrapKeyV1,
  encryptXChaCha20Poly1305V1,
  exchangePublicKeyFromPrivateV1,
  hmacSha256V1,
  sha256BytesV1,
  signEd25519V1,
  signingPublicKeyFromPrivateV1,
  verifyEd25519V1,
} from './syncCrypto';
import {
  assertSyncDevicePublicIdentityV1,
  assertSyncDeviceSecretsV1,
  type SyncDevicePublicIdentityV1,
  type SyncDeviceSecretsV1,
} from './syncDeviceContract';
import {
  assertPendingSyncDeviceSecretsV1,
  finalizePairedSyncDeviceSecretsV1,
  type PendingSyncDeviceSecretsV1,
  type SyncRandomBytesV1,
  type SyncRandomUuidV1,
} from './syncDeviceProvisioning';

const MAX_PAIRING_TTL_MS = 15 * 60 * 1000;
const OFFER_SIGNATURE_CONTEXT_V1 = 'junluo.sync.v1/pairing-offer-signature';
const REQUEST_SIGNATURE_CONTEXT_V1 = 'junluo.sync.v1/pairing-request-signature';
const PACKAGE_SIGNATURE_CONTEXT_V1 = 'junluo.sync.v1/pairing-package-signature';
const TRANSCRIPT_CONTEXT_V1 = 'junluo.sync.v1/pairing-transcript';
const VERIFICATION_CONTEXT_V1 = 'junluo.sync.v1/pairing-verification-code';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type SyncPairingOfferV1 = {
  version: 1;
  pairingId: string;
  vaultId: string;
  keyId: string;
  inviterDeviceId: string;
  inviterSigningPublicKey: string;
  inviterEphemeralExchangePublicKey: string;
  pairingToken: string;
  createdAt: number;
  expiresAt: number;
  signature: string;
};

export type SyncPairingOfferSecretV1 = {
  version: 1;
  pairingId: string;
  inviterEphemeralExchangePrivateKey: string;
};

export type SyncPairingSessionDescriptorV1 = {
  version: 1;
  pairingId: string;
  vaultId: string;
  keyId: string;
  inviterDeviceId: string;
  expiresAt: number;
  tokenDigest: string;
};

export type SyncPairingRequestV1 = {
  version: 1;
  pairingId: string;
  vaultId: string;
  keyId: string;
  requestId: string;
  newDevice: SyncDevicePublicIdentityV1;
  createdAt: number;
  signature: string;
};

export type SyncPairingPackageV1 = {
  version: 1;
  pairingId: string;
  vaultId: string;
  keyId: string;
  requestId: string;
  inviterDeviceId: string;
  newDeviceId: string;
  createdAt: number;
  expiresAt: number;
  nonce: string;
  ciphertext: string;
  signature: string;
};

type PairingOfferBodyV1 = Omit<SyncPairingOfferV1, 'signature'>;
type PairingRequestBodyV1 = Omit<SyncPairingRequestV1, 'signature'>;
type PairingPackageHeaderV1 = Omit<
  SyncPairingPackageV1,
  'nonce' | 'ciphertext' | 'signature'
>;

function recordOf(value: unknown, label: string): Record<string, unknown> {
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

function assertUuid(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_V4_PATTERN.test(value)) {
    throw new Error(`${label} 必须是小写 UUID v4。`);
  }
}

function assertTimestamp(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} 必须是非负 Unix 毫秒整数。`);
  }
}

function assertPairingWindow(createdAt: number, expiresAt: number) {
  assertTimestamp(createdAt, 'createdAt');
  assertTimestamp(expiresAt, 'expiresAt');
  if (
    expiresAt <= createdAt
    || expiresAt - createdAt > MAX_PAIRING_TTL_MS
  ) {
    throw new Error('配对有效期必须大于 0 且不超过 15 分钟。');
  }
}

function assertNotExpired(expiresAt: number, now: number) {
  assertTimestamp(now, 'now');
  if (now > expiresAt) throw new Error('一次性配对已经过期。');
}

function assertSameDeviceMaterial(
  identity: SyncDevicePublicIdentityV1,
  secrets: Pick<
    SyncDeviceSecretsV1 | PendingSyncDeviceSecretsV1,
    'vaultId' | 'deviceId' | 'keyId' | 'signingPrivateKey' | 'exchangePrivateKey'
  >,
) {
  assertSyncDevicePublicIdentityV1(identity);
  if (
    identity.vaultId !== secrets.vaultId
    || identity.deviceId !== secrets.deviceId
    || identity.keyId !== secrets.keyId
  ) {
    throw new Error('设备公开身份与本地秘密标识不一致。');
  }
  const signingPublicKey = bytesToBase64Url(signingPublicKeyFromPrivateV1(
    base64UrlToBytes(secrets.signingPrivateKey, 'signingPrivateKey', 32),
  ));
  const exchangePublicKey = bytesToBase64Url(exchangePublicKeyFromPrivateV1(
    base64UrlToBytes(secrets.exchangePrivateKey, 'exchangePrivateKey', 32),
  ));
  if (
    identity.signingPublicKey !== signingPublicKey
    || identity.exchangePublicKey !== exchangePublicKey
  ) {
    throw new Error('设备公钥与本地私钥不匹配。');
  }
}

function offerBody(offer: SyncPairingOfferV1): PairingOfferBodyV1 {
  const { signature: _signature, ...body } = offer;
  return body;
}

function requestBody(request: SyncPairingRequestV1): PairingRequestBodyV1 {
  const { signature: _signature, ...body } = request;
  return body;
}

function packageHeader(pairingPackage: SyncPairingPackageV1): PairingPackageHeaderV1 {
  const {
    nonce: _nonce,
    ciphertext: _ciphertext,
    signature: _signature,
    ...header
  } = pairingPackage;
  return header;
}

function pairingOfferSignatureInputV1(body: PairingOfferBodyV1) {
  return canonicalizeJsonBytesV1({
    context: OFFER_SIGNATURE_CONTEXT_V1,
    offer: body,
  });
}

function pairingRequestSignatureInputV1(body: PairingRequestBodyV1) {
  return canonicalizeJsonBytesV1({
    context: REQUEST_SIGNATURE_CONTEXT_V1,
    request: body,
  });
}

function pairingPackageSignatureInputV1(
  header: PairingPackageHeaderV1,
  nonce: string,
  ciphertext: string,
) {
  return canonicalizeJsonBytesV1({
    context: PACKAGE_SIGNATURE_CONTEXT_V1,
    header,
    nonce,
    ciphertext,
  });
}

function pairingTranscriptV1(
  offer: SyncPairingOfferV1,
  request: SyncPairingRequestV1,
) {
  return canonicalizeJsonBytesV1({
    context: TRANSCRIPT_CONTEXT_V1,
    offer,
    request,
  });
}

function pairingVerificationCodeV1(
  wrapKey: Uint8Array,
  transcript: Uint8Array,
) {
  const digest = hmacSha256V1(
    wrapKey,
    canonicalizeJsonBytesV1({
      context: VERIFICATION_CONTEXT_V1,
      transcriptSha256: bytesToBase64Url(sha256BytesV1(transcript)),
    }),
  );
  const value = (
    ((digest[0] << 24) >>> 0)
    | (digest[1] << 16)
    | (digest[2] << 8)
    | digest[3]
  ) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}

async function randomBytesExact(
  randomBytes: SyncRandomBytesV1,
  length: number,
  label: string,
) {
  const value = await randomBytes(length);
  if (!(value instanceof Uint8Array) || value.byteLength !== length) {
    throw new Error(`${label} 必须由 CSPRNG 返回正好 ${length} bytes。`);
  }
  return value;
}

export function assertSyncPairingOfferV1(
  value: unknown,
): asserts value is SyncPairingOfferV1 {
  const record = recordOf(value, '配对邀请');
  assertExactKeys(
    record,
    [
      'version',
      'pairingId',
      'vaultId',
      'keyId',
      'inviterDeviceId',
      'inviterSigningPublicKey',
      'inviterEphemeralExchangePublicKey',
      'pairingToken',
      'createdAt',
      'expiresAt',
      'signature',
    ],
    '配对邀请',
  );
  if (record.version !== 1) throw new Error('配对邀请版本不受支持。');
  assertUuid(record.pairingId, 'pairingId');
  assertUuid(record.vaultId, 'vaultId');
  assertUuid(record.keyId, 'keyId');
  assertUuid(record.inviterDeviceId, 'inviterDeviceId');
  base64UrlToBytes(
    record.inviterSigningPublicKey as string,
    'inviterSigningPublicKey',
    32,
  );
  base64UrlToBytes(
    record.inviterEphemeralExchangePublicKey as string,
    'inviterEphemeralExchangePublicKey',
    32,
  );
  base64UrlToBytes(record.pairingToken as string, 'pairingToken', 32);
  base64UrlToBytes(record.signature as string, 'signature', 64);
  assertPairingWindow(record.createdAt as number, record.expiresAt as number);
}

export function assertSyncPairingOfferSecretV1(
  value: unknown,
): asserts value is SyncPairingOfferSecretV1 {
  const record = recordOf(value, '配对邀请本地秘密');
  assertExactKeys(
    record,
    ['version', 'pairingId', 'inviterEphemeralExchangePrivateKey'],
    '配对邀请本地秘密',
  );
  if (record.version !== 1) throw new Error('配对邀请本地秘密版本不受支持。');
  assertUuid(record.pairingId, 'pairingId');
  base64UrlToBytes(
    record.inviterEphemeralExchangePrivateKey as string,
    'inviterEphemeralExchangePrivateKey',
    32,
  );
}

export function assertSyncPairingRequestV1(
  value: unknown,
): asserts value is SyncPairingRequestV1 {
  const record = recordOf(value, '配对请求');
  assertExactKeys(
    record,
    [
      'version',
      'pairingId',
      'vaultId',
      'keyId',
      'requestId',
      'newDevice',
      'createdAt',
      'signature',
    ],
    '配对请求',
  );
  if (record.version !== 1) throw new Error('配对请求版本不受支持。');
  assertUuid(record.pairingId, 'pairingId');
  assertUuid(record.vaultId, 'vaultId');
  assertUuid(record.keyId, 'keyId');
  assertUuid(record.requestId, 'requestId');
  assertTimestamp(record.createdAt, 'createdAt');
  assertSyncDevicePublicIdentityV1(record.newDevice);
  if ((record.newDevice as SyncDevicePublicIdentityV1).state !== 'pending') {
    throw new Error('新设备在配对完成前必须保持 pending。');
  }
  base64UrlToBytes(record.signature as string, 'signature', 64);
}

export function assertSyncPairingPackageV1(
  value: unknown,
): asserts value is SyncPairingPackageV1 {
  const record = recordOf(value, '加密配对包');
  assertExactKeys(
    record,
    [
      'version',
      'pairingId',
      'vaultId',
      'keyId',
      'requestId',
      'inviterDeviceId',
      'newDeviceId',
      'createdAt',
      'expiresAt',
      'nonce',
      'ciphertext',
      'signature',
    ],
    '加密配对包',
  );
  if (record.version !== 1) throw new Error('加密配对包版本不受支持。');
  assertUuid(record.pairingId, 'pairingId');
  assertUuid(record.vaultId, 'vaultId');
  assertUuid(record.keyId, 'keyId');
  assertUuid(record.requestId, 'requestId');
  assertUuid(record.inviterDeviceId, 'inviterDeviceId');
  assertUuid(record.newDeviceId, 'newDeviceId');
  assertPairingWindow(record.createdAt as number, record.expiresAt as number);
  base64UrlToBytes(record.nonce as string, 'nonce', 24);
  base64UrlToBytes(record.ciphertext as string, 'ciphertext');
  base64UrlToBytes(record.signature as string, 'signature', 64);
}

export function verifySyncPairingOfferV1(
  offer: SyncPairingOfferV1,
  now: number,
) {
  assertSyncPairingOfferV1(offer);
  assertNotExpired(offer.expiresAt, now);
  const valid = verifyEd25519V1(
    base64UrlToBytes(offer.signature, 'signature', 64),
    pairingOfferSignatureInputV1(offerBody(offer)),
    base64UrlToBytes(
      offer.inviterSigningPublicKey,
      'inviterSigningPublicKey',
      32,
    ),
  );
  if (!valid) throw new Error('配对邀请签名验证失败。');
}

export function verifySyncPairingRequestV1(
  offer: SyncPairingOfferV1,
  request: SyncPairingRequestV1,
  now: number,
) {
  verifySyncPairingOfferV1(offer, now);
  assertSyncPairingRequestV1(request);
  if (
    request.pairingId !== offer.pairingId
    || request.vaultId !== offer.vaultId
    || request.keyId !== offer.keyId
    || request.newDevice.vaultId !== offer.vaultId
    || request.newDevice.keyId !== offer.keyId
    || request.newDevice.deviceId === offer.inviterDeviceId
  ) {
    throw new Error('配对请求与邀请不匹配。');
  }
  if (request.createdAt < offer.createdAt || request.createdAt > offer.expiresAt) {
    throw new Error('配对请求时间不在邀请有效期内。');
  }
  const valid = verifyEd25519V1(
    base64UrlToBytes(request.signature, 'signature', 64),
    pairingRequestSignatureInputV1(requestBody(request)),
    base64UrlToBytes(
      request.newDevice.signingPublicKey,
      'newDevice.signingPublicKey',
      32,
    ),
  );
  if (!valid) throw new Error('新设备配对请求签名验证失败。');
}

export async function createSyncPairingOfferV1(input: {
  inviter: SyncDevicePublicIdentityV1;
  inviterSecrets: SyncDeviceSecretsV1;
  createdAt: number;
  expiresAt: number;
  randomBytes: SyncRandomBytesV1;
  randomUuid: SyncRandomUuidV1;
}) {
  assertSyncDeviceSecretsV1(input.inviterSecrets);
  assertSameDeviceMaterial(input.inviter, input.inviterSecrets);
  if (input.inviter.state !== 'active') {
    throw new Error('只有 active 设备可以发起配对。');
  }
  assertPairingWindow(input.createdAt, input.expiresAt);
  const pairingId = await input.randomUuid();
  assertUuid(pairingId, 'pairingId');
  const ephemeralPrivateKey = await randomBytesExact(
    input.randomBytes,
    32,
    '配对临时私钥',
  );
  const pairingToken = await randomBytesExact(
    input.randomBytes,
    32,
    '一次性配对 token',
  );
  const body: PairingOfferBodyV1 = {
    version: 1,
    pairingId,
    vaultId: input.inviter.vaultId,
    keyId: input.inviter.keyId,
    inviterDeviceId: input.inviter.deviceId,
    inviterSigningPublicKey: input.inviter.signingPublicKey,
    inviterEphemeralExchangePublicKey: bytesToBase64Url(
      exchangePublicKeyFromPrivateV1(ephemeralPrivateKey),
    ),
    pairingToken: bytesToBase64Url(pairingToken),
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
  };
  const offer: SyncPairingOfferV1 = {
    ...body,
    signature: bytesToBase64Url(signEd25519V1(
      pairingOfferSignatureInputV1(body),
      base64UrlToBytes(
        input.inviterSecrets.signingPrivateKey,
        'signingPrivateKey',
        32,
      ),
    )),
  };
  const localSecret: SyncPairingOfferSecretV1 = {
    version: 1,
    pairingId,
    inviterEphemeralExchangePrivateKey: bytesToBase64Url(ephemeralPrivateKey),
  };
  assertSyncPairingOfferV1(offer);
  assertSyncPairingOfferSecretV1(localSecret);
  return {
    offer,
    localSecret,
    relayDescriptor: pairingSessionDescriptorV1(offer),
  };
}

export function pairingSessionDescriptorV1(
  offer: SyncPairingOfferV1,
): SyncPairingSessionDescriptorV1 {
  assertSyncPairingOfferV1(offer);
  return {
    version: 1,
    pairingId: offer.pairingId,
    vaultId: offer.vaultId,
    keyId: offer.keyId,
    inviterDeviceId: offer.inviterDeviceId,
    expiresAt: offer.expiresAt,
    tokenDigest: bytesToBase64Url(sha256BytesV1(
      base64UrlToBytes(offer.pairingToken, 'pairingToken', 32),
    )),
  };
}

export function createSyncPairingRequestV1(input: {
  offer: SyncPairingOfferV1;
  newDevice: SyncDevicePublicIdentityV1;
  pendingSecrets: PendingSyncDeviceSecretsV1;
  requestId: string;
  createdAt: number;
}) {
  verifySyncPairingOfferV1(input.offer, input.createdAt);
  assertPendingSyncDeviceSecretsV1(input.pendingSecrets);
  assertSameDeviceMaterial(input.newDevice, input.pendingSecrets);
  assertUuid(input.requestId, 'requestId');
  const body: PairingRequestBodyV1 = {
    version: 1,
    pairingId: input.offer.pairingId,
    vaultId: input.offer.vaultId,
    keyId: input.offer.keyId,
    requestId: input.requestId,
    newDevice: input.newDevice,
    createdAt: input.createdAt,
  };
  const request: SyncPairingRequestV1 = {
    ...body,
    signature: bytesToBase64Url(signEd25519V1(
      pairingRequestSignatureInputV1(body),
      base64UrlToBytes(
        input.pendingSecrets.signingPrivateKey,
        'signingPrivateKey',
        32,
      ),
    )),
  };
  verifySyncPairingRequestV1(input.offer, request, input.createdAt);
  return request;
}

function pairingWrapKeyForInviterV1(
  localSecret: SyncPairingOfferSecretV1,
  offer: SyncPairingOfferV1,
  request: SyncPairingRequestV1,
) {
  assertSyncPairingOfferSecretV1(localSecret);
  if (localSecret.pairingId !== offer.pairingId) {
    throw new Error('配对邀请本地秘密与邀请不匹配。');
  }
  const transcript = pairingTranscriptV1(offer, request);
  return {
    transcript,
    wrapKey: derivePairingWrapKeyV1(
      base64UrlToBytes(
        localSecret.inviterEphemeralExchangePrivateKey,
        'inviterEphemeralExchangePrivateKey',
        32,
      ),
      base64UrlToBytes(
        request.newDevice.exchangePublicKey,
        'newDevice.exchangePublicKey',
        32,
      ),
      transcript,
    ),
  };
}

function pairingWrapKeyForNewDeviceV1(
  pendingSecrets: PendingSyncDeviceSecretsV1,
  offer: SyncPairingOfferV1,
  request: SyncPairingRequestV1,
) {
  assertPendingSyncDeviceSecretsV1(pendingSecrets);
  if (
    pendingSecrets.deviceId !== request.newDevice.deviceId
    || pendingSecrets.vaultId !== offer.vaultId
    || pendingSecrets.keyId !== offer.keyId
  ) {
    throw new Error('待配对设备秘密与配对会话不匹配。');
  }
  const transcript = pairingTranscriptV1(offer, request);
  return {
    transcript,
    wrapKey: derivePairingWrapKeyV1(
      base64UrlToBytes(
        pendingSecrets.exchangePrivateKey,
        'exchangePrivateKey',
        32,
      ),
      base64UrlToBytes(
        offer.inviterEphemeralExchangePublicKey,
        'inviterEphemeralExchangePublicKey',
        32,
      ),
      transcript,
    ),
  };
}

export function pairingVerificationCodeForInviterV1(
  localSecret: SyncPairingOfferSecretV1,
  offer: SyncPairingOfferV1,
  request: SyncPairingRequestV1,
  now: number,
) {
  verifySyncPairingRequestV1(offer, request, now);
  const { wrapKey, transcript } = pairingWrapKeyForInviterV1(
    localSecret,
    offer,
    request,
  );
  return pairingVerificationCodeV1(wrapKey, transcript);
}

export function pairingVerificationCodeForNewDeviceV1(
  pendingSecrets: PendingSyncDeviceSecretsV1,
  offer: SyncPairingOfferV1,
  request: SyncPairingRequestV1,
  now: number,
) {
  verifySyncPairingRequestV1(offer, request, now);
  const { wrapKey, transcript } = pairingWrapKeyForNewDeviceV1(
    pendingSecrets,
    offer,
    request,
  );
  return pairingVerificationCodeV1(wrapKey, transcript);
}

export async function createSyncPairingPackageV1(input: {
  inviter: SyncDevicePublicIdentityV1;
  inviterSecrets: SyncDeviceSecretsV1;
  offer: SyncPairingOfferV1;
  localSecret: SyncPairingOfferSecretV1;
  request: SyncPairingRequestV1;
  confirmedVerificationCode: string;
  createdAt: number;
  randomBytes: SyncRandomBytesV1;
}) {
  assertSameDeviceMaterial(input.inviter, input.inviterSecrets);
  verifySyncPairingRequestV1(input.offer, input.request, input.createdAt);
  if (
    input.inviter.state !== 'active'
    || input.inviter.deviceId !== input.offer.inviterDeviceId
  ) {
    throw new Error('配对批准者不是邀请中的 active 设备。');
  }
  const { wrapKey, transcript } = pairingWrapKeyForInviterV1(
    input.localSecret,
    input.offer,
    input.request,
  );
  const verificationCode = pairingVerificationCodeV1(wrapKey, transcript);
  if (input.confirmedVerificationCode !== verificationCode) {
    throw new Error('双端短校验码尚未确认一致，拒绝包装 vault secret。');
  }
  const header: PairingPackageHeaderV1 = {
    version: 1,
    pairingId: input.offer.pairingId,
    vaultId: input.offer.vaultId,
    keyId: input.offer.keyId,
    requestId: input.request.requestId,
    inviterDeviceId: input.offer.inviterDeviceId,
    newDeviceId: input.request.newDevice.deviceId,
    createdAt: input.createdAt,
    expiresAt: input.offer.expiresAt,
  };
  const nonceBytes = await randomBytesExact(
    input.randomBytes,
    24,
    '配对包 nonce',
  );
  const nonce = bytesToBase64Url(nonceBytes);
  const ciphertext = bytesToBase64Url(encryptXChaCha20Poly1305V1(
    canonicalizeJsonBytesV1({
      version: 1,
      vaultRootSecret: input.inviterSecrets.vaultRootSecret,
      newDeviceId: input.request.newDevice.deviceId,
    }),
    wrapKey,
    nonceBytes,
    canonicalizeJsonBytesV1(header),
  ));
  const pairingPackage: SyncPairingPackageV1 = {
    ...header,
    nonce,
    ciphertext,
    signature: bytesToBase64Url(signEd25519V1(
      pairingPackageSignatureInputV1(header, nonce, ciphertext),
      base64UrlToBytes(
        input.inviterSecrets.signingPrivateKey,
        'signingPrivateKey',
        32,
      ),
    )),
  };
  assertSyncPairingPackageV1(pairingPackage);
  return pairingPackage;
}

export function acceptSyncPairingPackageV1(input: {
  offer: SyncPairingOfferV1;
  request: SyncPairingRequestV1;
  pairingPackage: SyncPairingPackageV1;
  pendingSecrets: PendingSyncDeviceSecretsV1;
  confirmedVerificationCode: string;
  now: number;
}) {
  verifySyncPairingRequestV1(input.offer, input.request, input.now);
  assertSyncPairingPackageV1(input.pairingPackage);
  assertNotExpired(input.pairingPackage.expiresAt, input.now);
  const header = packageHeader(input.pairingPackage);
  if (
    input.pairingPackage.pairingId !== input.offer.pairingId
    || input.pairingPackage.vaultId !== input.offer.vaultId
    || input.pairingPackage.keyId !== input.offer.keyId
    || input.pairingPackage.requestId !== input.request.requestId
    || input.pairingPackage.inviterDeviceId !== input.offer.inviterDeviceId
    || input.pairingPackage.newDeviceId !== input.request.newDevice.deviceId
    || input.pairingPackage.expiresAt !== input.offer.expiresAt
  ) {
    throw new Error('加密配对包与邀请或请求不匹配。');
  }
  const signatureValid = verifyEd25519V1(
    base64UrlToBytes(input.pairingPackage.signature, 'signature', 64),
    pairingPackageSignatureInputV1(
      header,
      input.pairingPackage.nonce,
      input.pairingPackage.ciphertext,
    ),
    base64UrlToBytes(
      input.offer.inviterSigningPublicKey,
      'inviterSigningPublicKey',
      32,
    ),
  );
  if (!signatureValid) throw new Error('加密配对包签名验证失败。');
  const { wrapKey, transcript } = pairingWrapKeyForNewDeviceV1(
    input.pendingSecrets,
    input.offer,
    input.request,
  );
  const verificationCode = pairingVerificationCodeV1(wrapKey, transcript);
  if (input.confirmedVerificationCode !== verificationCode) {
    throw new Error('双端短校验码尚未确认一致，拒绝接收 vault secret。');
  }
  const plaintext = decryptXChaCha20Poly1305V1(
    base64UrlToBytes(input.pairingPackage.ciphertext, 'ciphertext'),
    wrapKey,
    base64UrlToBytes(input.pairingPackage.nonce, 'nonce', 24),
    canonicalizeJsonBytesV1(header),
  );
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(plaintext).toString('utf8'));
  } catch {
    throw new Error('解密后的配对包不是有效 JSON。');
  }
  const record = recordOf(decoded, '解密后的配对包');
  assertExactKeys(
    record,
    ['version', 'vaultRootSecret', 'newDeviceId'],
    '解密后的配对包',
  );
  if (
    record.version !== 1
    || record.newDeviceId !== input.pendingSecrets.deviceId
  ) {
    throw new Error('解密后的配对包不属于当前新设备。');
  }
  const vaultRootSecret = base64UrlToBytes(
    record.vaultRootSecret as string,
    'vaultRootSecret',
    32,
  );
  return {
    publicIdentity: {
      ...input.request.newDevice,
      state: 'active' as const,
    },
    secrets: finalizePairedSyncDeviceSecretsV1(
      input.pendingSecrets,
      vaultRootSecret,
    ),
  };
}
