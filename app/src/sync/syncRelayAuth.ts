import {
  base64UrlToBytes,
  bytesToBase64Url,
  canonicalizeJsonBytesV1,
  sha256BytesV1,
  signEd25519V1,
  verifyEd25519V1,
} from './syncCrypto';

export const SYNC_RELAY_AUTH_HEADERS_V1 = Object.freeze({
  vaultId: 'X-JunLuo-Vault-Id',
  deviceId: 'X-JunLuo-Device-Id',
  keyId: 'X-JunLuo-Key-Id',
  requestId: 'X-JunLuo-Request-Id',
  timestamp: 'X-JunLuo-Timestamp',
  bodySha256: 'X-JunLuo-Body-SHA256',
  signature: 'X-JunLuo-Signature',
});

const REQUEST_SIGNATURE_CONTEXT_V1 = 'junluo.sync.v1/http-request-signature';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HTTP_METHOD_PATTERN = /^[A-Z]+$/;
const ASCII_REQUEST_TARGET_PATTERN = /^[\x21-\x7e]*$/;

export type SyncRelayRequestSignatureInputV1 = {
  version: 1;
  vaultId: string;
  deviceId: string;
  keyId: string;
  requestId: string;
  timestamp: number;
  method: string;
  path: string;
  query: string;
  bodySha256: string;
};

function assertUuid(value: string, label: string) {
  if (!UUID_V4_PATTERN.test(value)) {
    throw new Error(`${label} 必须是小写 UUID v4。`);
  }
}

function assertRequestTarget(method: string, path: string, query: string) {
  if (!HTTP_METHOD_PATTERN.test(method)) {
    throw new Error('HTTP method 必须使用大写 ASCII token。');
  }
  if (
    !path.startsWith('/')
    || path.includes('?')
    || path.includes('#')
    || !ASCII_REQUEST_TARGET_PATTERN.test(path)
  ) {
    throw new Error('请求 path 必须是已编码、无 query/fragment 的 ASCII 绝对路径。');
  }
  if (
    query.startsWith('?')
    || query.includes('#')
    || !ASCII_REQUEST_TARGET_PATTERN.test(query)
  ) {
    throw new Error('请求 query 必须是无前导问号的原始 ASCII query。');
  }
}

export function relayRequestSignatureInputV1(
  input: SyncRelayRequestSignatureInputV1,
) {
  assertUuid(input.vaultId, 'vaultId');
  assertUuid(input.deviceId, 'deviceId');
  assertUuid(input.keyId, 'keyId');
  assertUuid(input.requestId, 'requestId');
  if (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0) {
    throw new Error('timestamp 必须是非负 Unix 毫秒整数。');
  }
  assertRequestTarget(input.method, input.path, input.query);
  base64UrlToBytes(input.bodySha256, 'bodySha256', 32);
  return canonicalizeJsonBytesV1({
    context: REQUEST_SIGNATURE_CONTEXT_V1,
    request: input,
  });
}

export function createSignedRelayRequestV1(input: {
  vaultId: string;
  deviceId: string;
  keyId: string;
  requestId: string;
  timestamp: number;
  method: string;
  path: string;
  query?: string;
  body?: Uint8Array;
  signingPrivateKey: string;
}) {
  const signatureInput: SyncRelayRequestSignatureInputV1 = {
    version: 1,
    vaultId: input.vaultId,
    deviceId: input.deviceId,
    keyId: input.keyId,
    requestId: input.requestId,
    timestamp: input.timestamp,
    method: input.method,
    path: input.path,
    query: input.query ?? '',
    bodySha256: bytesToBase64Url(sha256BytesV1(
      input.body ?? new Uint8Array(),
    )),
  };
  const signature = bytesToBase64Url(signEd25519V1(
    relayRequestSignatureInputV1(signatureInput),
    base64UrlToBytes(
      input.signingPrivateKey,
      'signingPrivateKey',
      32,
    ),
  ));
  return {
    signatureInput,
    headers: {
      [SYNC_RELAY_AUTH_HEADERS_V1.vaultId]: input.vaultId,
      [SYNC_RELAY_AUTH_HEADERS_V1.deviceId]: input.deviceId,
      [SYNC_RELAY_AUTH_HEADERS_V1.keyId]: input.keyId,
      [SYNC_RELAY_AUTH_HEADERS_V1.requestId]: input.requestId,
      [SYNC_RELAY_AUTH_HEADERS_V1.timestamp]: String(input.timestamp),
      [SYNC_RELAY_AUTH_HEADERS_V1.bodySha256]: signatureInput.bodySha256,
      [SYNC_RELAY_AUTH_HEADERS_V1.signature]: signature,
    },
  };
}

export function verifyRelayRequestSignatureV1(
  signatureInput: SyncRelayRequestSignatureInputV1,
  signature: string,
  signingPublicKey: string,
) {
  return verifyEd25519V1(
    base64UrlToBytes(signature, 'signature', 64),
    relayRequestSignatureInputV1(signatureInput),
    base64UrlToBytes(signingPublicKey, 'signingPublicKey', 32),
  );
}
