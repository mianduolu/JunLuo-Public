import { ecb } from '@noble/ciphers/aes.js';

export const HUAMI_2021_AUTH_ENDPOINT = 0x0082;
export const HUAMI_2021_PRIVATE_KEY_LENGTH = 24;
export const HUAMI_2021_PUBLIC_KEY_LENGTH = 48;
export const MI_BAND_AUTH_KEY_LENGTH = 16;

const CURVE_DEGREE = 163n;
const CURVE_POLYNOMIAL = (1n << CURVE_DEGREE) | 0xc9n;
const CURVE_SCALAR_MASK = (1n << 162n) - 1n;
const CURVE_B = wordsToBigInt([0x4a3205fd, 0x512f7874, 0x1481eb10, 0xb8c953ca, 0x0a601907, 0x00000002]);
const CURVE_BASE_X = wordsToBigInt([0xe8343e36, 0xd4994637, 0xa0991168, 0x86a2d57e, 0xf0eba162, 0x00000003]);
const CURVE_BASE_Y = wordsToBigInt([0x797324f1, 0xb11c5c0c, 0xa2cdd545, 0x71a0094f, 0xd51fbc6c, 0x00000000]);

type BinaryCurvePoint = {
  x: bigint;
  y: bigint;
};

export type Huami2021DecodedPayload = {
  count: number;
  encrypted: boolean;
  endpoint: number;
  handle: number;
  needsAck: boolean;
  payload: Uint8Array;
};

export type Huami2021EncryptionState = {
  sequenceNumber: number;
  sessionKey: Uint8Array;
};

function wordsToBigInt(words: readonly number[]): bigint {
  let value = 0n;
  for (let index = words.length - 1; index >= 0; index -= 1) {
    value = (value << 32n) | BigInt(words[index] >>> 0);
  }
  return value;
}

function bytesToBigIntLE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }
  return value;
}

function bigIntToBytesLE(value: bigint, length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = 0; index < length; index += 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
}

function degree(value: bigint): number {
  if (value === 0n) return 0;
  return value.toString(2).length;
}

function fieldMultiply(left: bigint, right: bigint): bigint {
  let result = 0n;
  let multiplicand = left;
  let multiplier = right;
  while (multiplier !== 0n) {
    if ((multiplier & 1n) !== 0n) result ^= multiplicand;
    multiplier >>= 1n;
    multiplicand <<= 1n;
    if ((multiplicand & (1n << CURVE_DEGREE)) !== 0n) {
      multiplicand ^= CURVE_POLYNOMIAL;
    }
  }
  return result;
}

function fieldReduce(value: bigint): bigint {
  let result = value;
  while (degree(result) > Number(CURVE_DEGREE)) {
    result ^= CURVE_POLYNOMIAL << BigInt(degree(result) - Number(CURVE_DEGREE) - 1);
  }
  return result;
}

function fieldInverse(value: bigint): bigint {
  if (value === 0n) throw new RangeError('B-163 零元素没有逆元。');
  let u = value;
  let v = CURVE_POLYNOMIAL;
  let left = 1n;
  let right = 0n;
  while (u !== 1n) {
    let shift = degree(u) - degree(v);
    if (shift < 0) {
      [u, v] = [v, u];
      [left, right] = [right, left];
      shift = -shift;
    }
    u ^= v << BigInt(shift);
    left ^= right << BigInt(shift);
  }
  return fieldReduce(left);
}

function isInfinity(point: BinaryCurvePoint): boolean {
  return point.x === 0n && point.y === 0n;
}

function doublePoint(point: BinaryCurvePoint): BinaryCurvePoint {
  if (point.x === 0n) return { x: 0n, y: 0n };
  let lambda = fieldMultiply(fieldInverse(point.x), point.y) ^ point.x;
  const originalXSquared = fieldMultiply(point.x, point.x);
  const x = fieldMultiply(lambda, lambda) ^ lambda ^ 1n;
  lambda ^= 1n;
  const y = originalXSquared ^ fieldMultiply(lambda, x);
  return { x, y };
}

function addPoints(left: BinaryCurvePoint, right: BinaryCurvePoint): BinaryCurvePoint {
  if (isInfinity(right)) return { ...left };
  if (isInfinity(left)) return { ...right };
  if (left.x === right.x) {
    return left.y === right.y ? doublePoint(left) : { x: 0n, y: 0n };
  }
  const lambda = fieldMultiply(left.y ^ right.y, fieldInverse(left.x ^ right.x));
  const x = fieldMultiply(lambda, lambda) ^ lambda ^ left.x ^ right.x ^ 1n;
  const y = left.y ^ fieldMultiply(left.x ^ x, lambda) ^ x;
  return { x, y };
}

function multiplyPoint(point: BinaryCurvePoint, scalar: bigint): BinaryCurvePoint {
  let result: BinaryCurvePoint = { x: 0n, y: 0n };
  const bits = degree(scalar);
  for (let index = bits - 1; index >= 0; index -= 1) {
    result = doublePoint(result);
    if (((scalar >> BigInt(index)) & 1n) !== 0n) {
      result = addPoints(result, point);
    }
  }
  return result;
}

function isPointOnCurve(point: BinaryCurvePoint): boolean {
  if (isInfinity(point)) return false;
  const xSquared = fieldMultiply(point.x, point.x);
  const left = fieldMultiply(point.y, point.y) ^ fieldMultiply(point.x, point.y);
  const right = fieldMultiply(xSquared, point.x) ^ xSquared ^ CURVE_B;
  return left === right;
}

function privateScalar(privateKey: Uint8Array): bigint {
  if (privateKey.length !== HUAMI_2021_PRIVATE_KEY_LENGTH) {
    throw new RangeError(`B-163 私钥必须是 ${HUAMI_2021_PRIVATE_KEY_LENGTH} 字节。`);
  }
  const raw = bytesToBigIntLE(privateKey);
  if (degree(raw) < 81) throw new RangeError('B-163 私钥随机度不足。');
  const scalar = raw & CURVE_SCALAR_MASK;
  if (scalar === 0n) throw new RangeError('B-163 私钥不能为零。');
  return scalar;
}

function decodePublicKey(publicKey: Uint8Array): BinaryCurvePoint {
  if (publicKey.length !== HUAMI_2021_PUBLIC_KEY_LENGTH) {
    throw new RangeError(`B-163 公钥必须是 ${HUAMI_2021_PUBLIC_KEY_LENGTH} 字节。`);
  }
  const point = {
    x: bytesToBigIntLE(publicKey.subarray(0, HUAMI_2021_PRIVATE_KEY_LENGTH)),
    y: bytesToBigIntLE(publicKey.subarray(HUAMI_2021_PRIVATE_KEY_LENGTH)),
  };
  if (!isPointOnCurve(point)) throw new RangeError('远端 B-163 公钥不在合法曲线上。');
  return point;
}

function encodePublicKey(point: BinaryCurvePoint): Uint8Array {
  const output = new Uint8Array(HUAMI_2021_PUBLIC_KEY_LENGTH);
  output.set(bigIntToBytesLE(point.x, HUAMI_2021_PRIVATE_KEY_LENGTH), 0);
  output.set(bigIntToBytesLE(point.y, HUAMI_2021_PRIVATE_KEY_LENGTH), HUAMI_2021_PRIVATE_KEY_LENGTH);
  return output;
}

export function generateHuami2021PublicKey(privateKey: Uint8Array): Uint8Array {
  return encodePublicKey(multiplyPoint({ x: CURVE_BASE_X, y: CURVE_BASE_Y }, privateScalar(privateKey)));
}

export function generateHuami2021SharedSecret(
  privateKey: Uint8Array,
  remotePublicKey: Uint8Array,
): Uint8Array {
  return encodePublicKey(multiplyPoint(decodePublicKey(remotePublicKey), privateScalar(privateKey)));
}

export function normalizeMiBandAuthKeyHex(value: string): string {
  const normalized = value.replace(/0x/gi, '').replace(/[\s:_-]+/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(normalized)) {
    throw new RangeError('手环认证密钥必须是 32 位十六进制字符。');
  }
  return normalized;
}

export function miBandAuthKeyBytes(value: string): Uint8Array {
  const normalized = normalizeMiBandAuthKeyHex(value);
  return Uint8Array.from(
    Array.from({ length: MI_BAND_AUTH_KEY_LENGTH }, (_, index) => (
      Number.parseInt(normalized.slice(index * 2, index * 2 + 2), 16)
    )),
  );
}

export function createHuami2021PublicKeyAuthPayload(publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== HUAMI_2021_PUBLIC_KEY_LENGTH) {
    throw new RangeError('认证公钥长度错误。');
  }
  const payload = new Uint8Array(4 + publicKey.length);
  payload.set([0x04, 0x02, 0x00, 0x02], 0);
  payload.set(publicKey, 4);
  return payload;
}

function aesEncryptBlock(key: Uint8Array, input: Uint8Array): Uint8Array {
  if (key.length !== 16 || input.length !== 16) {
    throw new RangeError('Mi Band 6 认证 AES 只接受 16 字节 key 和数据块。');
  }
  return ecb(key, { disablePadding: true }).encrypt(input);
}

function aesDecryptBlocks(key: Uint8Array, input: Uint8Array): Uint8Array {
  if (key.length !== 16 || input.length === 0 || input.length % 16 !== 0) {
    throw new RangeError('Mi Band 6 加密分包必须使用 16 字节 key 和完整 AES 数据块。');
  }
  return ecb(key, { disablePadding: true }).decrypt(input);
}

function huami2021MessageKey(sessionKey: Uint8Array, handle: number): Uint8Array {
  if (sessionKey.length !== 16) throw new RangeError('Huami 2021 会话密钥必须是 16 字节。');
  return Uint8Array.from(sessionKey, (byte) => byte ^ (handle & 0xff));
}

export function calculateHuami2021Crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint32ToBytesLE(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
  return bytes;
}

function encryptedHuami2021Payload(
  payload: Uint8Array,
  sessionKey: Uint8Array,
  handle: number,
  sequenceNumber: number,
): Uint8Array {
  const plainLength = payload.length + 8;
  const paddedLength = Math.ceil(plainLength / 16) * 16;
  const plain = new Uint8Array(paddedLength);
  const sequenceBytes = uint32ToBytesLE(sequenceNumber);
  plain.set(payload, 0);
  plain.set(sequenceBytes, payload.length);
  const crcInput = new Uint8Array(payload.length + sequenceBytes.length);
  crcInput.set(payload, 0);
  crcInput.set(sequenceBytes, payload.length);
  plain.set(uint32ToBytesLE(calculateHuami2021Crc32(crcInput)), payload.length + 4);
  return ecb(huami2021MessageKey(sessionKey, handle), { disablePadding: true }).encrypt(plain);
}

export function createHuami2021ChallengeResponse(
  privateKey: Uint8Array,
  authKey: Uint8Array,
  remotePayload: Uint8Array,
): { encryptedSequenceNumber: number; payload: Uint8Array; sessionKey: Uint8Array } {
  if (
    remotePayload.length !== 67
    || remotePayload[0] !== 0x10
    || remotePayload[1] !== 0x04
    || remotePayload[2] !== 0x01
  ) {
    throw new RangeError('Mi Band 6 返回的认证挑战结构不合法。');
  }
  if (authKey.length !== MI_BAND_AUTH_KEY_LENGTH) {
    throw new RangeError('Mi Band 6 认证 key 必须是 16 字节。');
  }
  const remoteRandom = remotePayload.subarray(3, 19);
  const remotePublicKey = remotePayload.subarray(19, 67);
  const sharedSecret = generateHuami2021SharedSecret(privateKey, remotePublicKey);
  const encryptedSequenceNumber = new DataView(
    sharedSecret.buffer,
    sharedSecret.byteOffset,
    4,
  ).getUint32(0, true);
  const sessionKey = new Uint8Array(16);
  for (let index = 0; index < sessionKey.length; index += 1) {
    sessionKey[index] = sharedSecret[index + 8] ^ authKey[index];
  }
  const payload = new Uint8Array(33);
  payload[0] = 0x05;
  payload.set(aesEncryptBlock(authKey, remoteRandom), 1);
  payload.set(aesEncryptBlock(sessionKey, remoteRandom), 17);
  return { encryptedSequenceNumber, payload, sessionKey };
}

export function isHuami2021AuthSuccessPayload(payload: Uint8Array): boolean {
  return payload.length >= 3 && payload[0] === 0x10 && payload[1] === 0x05 && payload[2] === 0x01;
}

export function isHuami2021AuthKeyRejectedPayload(payload: Uint8Array): boolean {
  return payload.length >= 3 && payload[0] === 0x10 && payload[1] === 0x05 && payload[2] === 0x25;
}

export function encodeHuami2021Chunks(options: {
  endpoint: number;
  handle: number;
  mtu: number;
  payload: Uint8Array;
}): Uint8Array[] {
  const { endpoint, payload } = options;
  const handle = options.handle & 0xff;
  const mtu = Math.max(23, Math.floor(options.mtu));
  if (endpoint !== HUAMI_2021_AUTH_ENDPOINT) {
    throw new RangeError('本模块只允许发送 Mi Band 6 认证 endpoint。');
  }
  if (
    !(
      (payload.length === 52 && payload[0] === 0x04)
      || (payload.length === 33 && payload[0] === 0x05)
    )
  ) {
    throw new RangeError('拒绝发送未知的 Mi Band 6 认证 payload。');
  }

  const chunks: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  while (offset < payload.length) {
    const first = offset === 0;
    const headerLength = first ? 11 : 5;
    const copyLength = Math.min(payload.length - offset, mtu - 3 - headerLength);
    if (copyLength <= 0) throw new RangeError('BLE MTU 太小，无法编码认证分包。');
    const last = offset + copyLength >= payload.length;
    const chunk = new Uint8Array(headerLength + copyLength);
    chunk[0] = 0x03;
    chunk[1] = (first ? 0x01 : 0x00) | (last ? 0x06 : 0x00);
    chunk[2] = 0x00;
    chunk[3] = handle;
    chunk[4] = count;
    if (first) {
      chunk[5] = payload.length & 0xff;
      chunk[6] = (payload.length >> 8) & 0xff;
      chunk[7] = (payload.length >> 16) & 0xff;
      chunk[8] = (payload.length >> 24) & 0xff;
      chunk[9] = endpoint & 0xff;
      chunk[10] = (endpoint >> 8) & 0xff;
    }
    chunk.set(payload.subarray(offset, offset + copyLength), headerLength);
    chunks.push(chunk);
    offset += copyLength;
    count += 1;
  }
  return chunks;
}

export function encodeHuami2021Message(options: {
  encryption?: Huami2021EncryptionState;
  endpoint: number;
  handle: number;
  mtu: number;
  payload: Uint8Array;
}): Uint8Array[] {
  const { endpoint, encryption, payload } = options;
  const handle = options.handle & 0xff;
  const mtu = Math.max(23, Math.floor(options.mtu));
  const wirePayload = encryption
    ? encryptedHuami2021Payload(
      payload,
      encryption.sessionKey,
      handle,
      encryption.sequenceNumber,
    )
    : payload;
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let count = 0;
  while (offset < wirePayload.length) {
    const first = offset === 0;
    const headerLength = first ? 11 : 5;
    const copyLength = Math.min(wirePayload.length - offset, mtu - 3 - headerLength);
    if (copyLength <= 0) throw new RangeError('BLE MTU 太小，无法编码分包。');
    const last = offset + copyLength >= wirePayload.length;
    const chunk = new Uint8Array(headerLength + copyLength);
    chunk[0] = 0x03;
    chunk[1] = (first ? 0x01 : 0x00)
      | (last ? 0x06 : 0x00)
      | (encryption ? 0x08 : 0x00);
    chunk[2] = 0x00;
    chunk[3] = handle;
    chunk[4] = count;
    if (first) {
      chunk[5] = payload.length & 0xff;
      chunk[6] = (payload.length >> 8) & 0xff;
      chunk[7] = (payload.length >> 16) & 0xff;
      chunk[8] = (payload.length >> 24) & 0xff;
      chunk[9] = endpoint & 0xff;
      chunk[10] = (endpoint >> 8) & 0xff;
    }
    chunk.set(wirePayload.subarray(offset, offset + copyLength), headerLength);
    chunks.push(chunk);
    offset += copyLength;
    count += 1;
  }
  return chunks;
}

export function createHuami2021ChunkAck(handle: number, count: number): Uint8Array {
  return Uint8Array.from([0x04, 0x00, handle & 0xff, 0x01, count & 0xff]);
}

export class Huami2021ChunkDecoder {
  private count = 0;
  private encrypted = false;
  private endpoint = 0;
  private expectedLength = 0;
  private handle: number | undefined;
  private parts: Uint8Array[] = [];
  private receivedLength = 0;
  private sessionKey?: Uint8Array;

  constructor(sessionKey?: Uint8Array) {
    this.setSessionKey(sessionKey);
  }

  setSessionKey(sessionKey?: Uint8Array): void {
    if (sessionKey && sessionKey.length !== 16) {
      throw new RangeError('Huami 2021 会话密钥必须是 16 字节。');
    }
    this.sessionKey = sessionKey ? Uint8Array.from(sessionKey) : undefined;
  }

  reset(): void {
    this.count = 0;
    this.endpoint = 0;
    this.encrypted = false;
    this.expectedLength = 0;
    this.handle = undefined;
    this.parts = [];
    this.receivedLength = 0;
  }

  decode(data: Uint8Array): Huami2021DecodedPayload | undefined {
    if (data.length < 5 || data[0] !== 0x03) return undefined;
    const flags = data[1];
    const encrypted = (flags & 0x08) !== 0;
    const first = (flags & 0x01) !== 0;
    const last = (flags & 0x02) !== 0;
    const needsAck = (flags & 0x04) !== 0;

    const handle = data[3];
    const count = data[4];
    let offset = 5;
    if (first) {
      if (data.length < 11) throw new RangeError('认证首分包长度不足。');
      this.expectedLength = (
        data[5]
        | (data[6] << 8)
        | (data[7] << 16)
        | (data[8] << 24)
      ) >>> 0;
      this.endpoint = data[9] | (data[10] << 8);
      this.encrypted = encrypted;
      this.handle = handle;
      this.parts = [];
      this.receivedLength = 0;
      offset = 11;
    } else if (this.handle !== handle || this.encrypted !== encrypted) {
      return undefined;
    }

    const part = data.slice(offset);
    this.parts.push(part);
    this.receivedLength += part.length;
    this.count = count;
    if (!last) return undefined;
    if (!encrypted && this.receivedLength < this.expectedLength) {
      this.reset();
      throw new RangeError('认证分包提前结束。');
    }

    const wirePayload = new Uint8Array(this.receivedLength);
    let payloadOffset = 0;
    for (const item of this.parts) {
      const remaining = wirePayload.length - payloadOffset;
      if (remaining <= 0) break;
      wirePayload.set(item.subarray(0, remaining), payloadOffset);
      payloadOffset += Math.min(item.length, remaining);
    }
    let payload: Uint8Array;
    if (encrypted) {
      if (!this.sessionKey) {
        this.reset();
        throw new RangeError('收到加密分包，但认证会话密钥不存在。');
      }
      const decrypted = aesDecryptBlocks(
        huami2021MessageKey(this.sessionKey, handle),
        wirePayload,
      );
      if (this.expectedLength + 8 > decrypted.length) {
        this.reset();
        throw new RangeError('加密分包长度不足。');
      }
      payload = decrypted.slice(0, this.expectedLength);
      const sequenceBytes = decrypted.slice(this.expectedLength, this.expectedLength + 4);
      const expectedCrc = new DataView(
        decrypted.buffer,
        decrypted.byteOffset + this.expectedLength + 4,
        4,
      ).getUint32(0, true);
      const crcInput = new Uint8Array(payload.length + sequenceBytes.length);
      crcInput.set(payload, 0);
      crcInput.set(sequenceBytes, payload.length);
      if (calculateHuami2021Crc32(crcInput) !== expectedCrc) {
        this.reset();
        throw new RangeError('Huami 2021 加密分包 CRC32 校验失败。');
      }
    } else {
      payload = wirePayload.slice(0, this.expectedLength);
    }
    const decoded: Huami2021DecodedPayload = {
      count: this.count,
      encrypted,
      endpoint: this.endpoint,
      handle,
      needsAck,
      payload,
    };
    this.reset();
    return decoded;
  }
}
