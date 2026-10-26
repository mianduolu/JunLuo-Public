import { Buffer } from 'buffer';
import { getRandomBytes } from 'expo-crypto';
import type { Characteristic, Device, Subscription } from 'react-native-ble-plx';

import {
  HUAMI_2021_CHUNKED_READ_CHARACTERISTIC_UUID,
  HUAMI_2021_CHUNKED_WRITE_CHARACTERISTIC_UUID,
  normalizeColmiUuid,
} from './colmiBleConstants';
import {
  createHuami2021ChallengeResponse,
  createHuami2021ChunkAck,
  createHuami2021PublicKeyAuthPayload,
  encodeHuami2021Chunks,
  encodeHuami2021Message,
  generateHuami2021PublicKey,
  HUAMI_2021_AUTH_ENDPOINT,
  HUAMI_2021_PRIVATE_KEY_LENGTH,
  Huami2021ChunkDecoder,
  isHuami2021AuthKeyRejectedPayload,
  isHuami2021AuthSuccessPayload,
  miBandAuthKeyBytes,
  type Huami2021DecodedPayload,
} from './miBand6AuthProtocol';
import {
  assertHuami2021SafeCommand,
  HUAMI_2021_HEART_RATE_ENDPOINT,
  huami2021HeartRateCommandRequiresAck,
  HUAMI_2021_SERVICES_ENDPOINT,
  HUAMI_2021_SERVICES_REQUEST,
  parseHuami2021HeartRateAck,
  parseHuami2021ServiceList,
  type Huami2021SafePurpose,
  type Huami2021ServiceEntry,
} from './miBand6RealtimeHeartRateProtocol';

export type MiBand6AuthStage =
  | 'starting'
  | 'waiting_challenge'
  | 'waiting_confirmation'
  | 'authenticated';

type MiBand6AuthCharacteristics = {
  read: Characteristic;
  write: Characteristic;
};

type PayloadWaiter = {
  endpoint: number;
  predicate: (payload: Uint8Array) => boolean;
  reject: (error: Error) => void;
  resolve: (payload: Uint8Array) => void;
  timeout: ReturnType<typeof setTimeout>;
};

const MI_BAND_6_AUTH_TIMEOUT_MS = 15_000;
const HUAMI_2021_COMMAND_ACK_TIMEOUT_MS = 1_500;

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'base64'));
}

async function findAuthCharacteristics(device: Device): Promise<MiBand6AuthCharacteristics> {
  const services = await device.services();
  let read: Characteristic | undefined;
  let write: Characteristic | undefined;
  for (const service of services) {
    const characteristics = await device.characteristicsForService(service.uuid);
    for (const characteristic of characteristics) {
      const uuid = normalizeColmiUuid(characteristic.uuid);
      if (
        uuid === normalizeColmiUuid(HUAMI_2021_CHUNKED_READ_CHARACTERISTIC_UUID)
        && (characteristic.isNotifiable || characteristic.isIndicatable)
        && (characteristic.isWritableWithResponse || characteristic.isWritableWithoutResponse)
      ) {
        read = characteristic;
      }
      if (
        uuid === normalizeColmiUuid(HUAMI_2021_CHUNKED_WRITE_CHARACTERISTIC_UUID)
        && (characteristic.isWritableWithResponse || characteristic.isWritableWithoutResponse)
      ) {
        write = characteristic;
      }
    }
  }
  if (!read || !write) throw new Error('手环没有开放完整的新认证通道。');
  return { read, write };
}

async function writeCharacteristic(characteristic: Characteristic, bytes: Uint8Array): Promise<void> {
  const base64 = bytesToBase64(bytes);
  if (characteristic.isWritableWithResponse) {
    await characteristic.writeWithResponse(base64);
    return;
  }
  if (characteristic.isWritableWithoutResponse) {
    await characteristic.writeWithoutResponse(base64);
    return;
  }
  throw new Error('认证特征不可写。');
}

function createPrivateKey(): Uint8Array {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const privateKey = getRandomBytes(HUAMI_2021_PRIVATE_KEY_LENGTH);
    try {
      generateHuami2021PublicKey(privateKey);
      return privateKey;
    } catch {
      // Extremely rare low-entropy candidates are discarded.
    }
  }
  throw new Error('无法生成手环认证临时密钥。');
}

export class Huami2021AuthenticatedSession {
  readonly deviceId: string;

  private decoder = new Huami2021ChunkDecoder();
  private disposed = false;
  private encryptedSequenceNumber = 0;
  private monitorSubscription: Subscription;
  private mtu: number;
  private read: Characteristic;
  private serviceEntries: Huami2021ServiceEntry[] = [];
  private sessionKey?: Uint8Array;
  private waiters = new Set<PayloadWaiter>();
  private write: Characteristic;
  private writeHandle = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: {
    device: Device;
    read: Characteristic;
    write: Characteristic;
  }) {
    this.deviceId = options.device.id;
    this.mtu = typeof options.device.mtu === 'number' ? options.device.mtu : 23;
    this.read = options.read;
    this.write = options.write;
    const subscriptionType = this.read.isNotifiable ? 'notification' : 'indication';
    this.monitorSubscription = this.read.monitor(
      (error, characteristic) => {
        if (this.disposed) return;
        if (error) {
          this.rejectWaiters(new Error(error.reason || error.message || '小米手环控制通道监听失败。'));
          return;
        }
        if (!characteristic?.value) return;
        void this.handleIncoming(base64ToBytes(characteristic.value)).catch((incomingError) => {
          this.rejectWaiters(incomingError instanceof Error
            ? incomingError
            : new Error('小米手环控制通道解析失败。'));
        });
      },
      `junluo-mi-band-6-session-${options.device.id}`,
      subscriptionType,
    );
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  getServiceEntries(): Huami2021ServiceEntry[] {
    return this.serviceEntries.map((entry) => ({ ...entry }));
  }

  hasEndpoint(endpoint: number): boolean {
    return this.serviceEntries.some((entry) => entry.endpoint === endpoint);
  }

  endpointUsesEncryption(endpoint: number): boolean {
    return Boolean(this.serviceEntries.find((entry) => entry.endpoint === endpoint)?.encrypted);
  }

  setEncryption(sessionKey: Uint8Array, sequenceNumber: number): void {
    if (this.disposed) throw new Error('小米手环认证会话已经结束。');
    this.sessionKey?.fill(0);
    this.sessionKey = Uint8Array.from(sessionKey);
    this.encryptedSequenceNumber = sequenceNumber >>> 0;
    this.decoder.setSessionKey(this.sessionKey);
  }

  async sendAuth(payload: Uint8Array): Promise<void> {
    if (this.disposed) throw new Error('小米手环认证会话已经结束。');
    this.writeHandle = (this.writeHandle + 1) & 0xff;
    const chunks = encodeHuami2021Chunks({
      endpoint: HUAMI_2021_AUTH_ENDPOINT,
      handle: this.writeHandle,
      mtu: this.mtu,
      payload,
    });
    await this.enqueueChunks(chunks);
  }

  waitForPayload(options: {
    endpoint: number;
    predicate: (payload: Uint8Array) => boolean;
    timeoutMs?: number;
  }): Promise<Uint8Array> {
    if (this.disposed) return Promise.reject(new Error('小米手环认证会话已经结束。'));
    return new Promise((resolve, reject) => {
      const waiter: PayloadWaiter = {
        endpoint: options.endpoint,
        predicate: options.predicate,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error('等待小米手环控制回包超时。'));
        }, options.timeoutMs ?? HUAMI_2021_COMMAND_ACK_TIMEOUT_MS),
      };
      this.waiters.add(waiter);
    });
  }

  async requestServiceList(): Promise<Huami2021ServiceEntry[]> {
    const response = this.waitForPayload({
      endpoint: HUAMI_2021_SERVICES_ENDPOINT,
      predicate: (payload) => payload[0] === 0x04,
    });
    await this.sendSafeCommand('services_list', HUAMI_2021_SERVICES_REQUEST, false);
    this.serviceEntries = parseHuami2021ServiceList(await response);
    return this.getServiceEntries();
  }

  async sendHeartRateCommand(
    purpose: Exclude<Huami2021SafePurpose, 'services_list'>,
    payload: Uint8Array,
  ): Promise<void> {
    const requiresAck = huami2021HeartRateCommandRequiresAck(purpose);
    const response = requiresAck
      ? this.waitForPayload({
        endpoint: HUAMI_2021_HEART_RATE_ENDPOINT,
        predicate: (candidate) => Boolean(parseHuami2021HeartRateAck(candidate)),
      })
      : undefined;
    await this.sendSafeCommand(
      purpose,
      payload,
      this.endpointUsesEncryption(HUAMI_2021_HEART_RATE_ENDPOINT),
    );
    if (response) {
      const ack = parseHuami2021HeartRateAck(await response);
      if (!ack?.ok) throw new Error(`小米手环拒绝心率命令（状态 ${ack?.status ?? 'unknown'}）。`);
    }
  }

  dispose(reason = '小米手环认证会话已结束。'): void {
    if (this.disposed) return;
    this.disposed = true;
    this.monitorSubscription.remove();
    this.sessionKey?.fill(0);
    this.sessionKey = undefined;
    this.decoder.setSessionKey(undefined);
    this.serviceEntries = [];
    this.rejectWaiters(new Error(reason));
  }

  private async sendSafeCommand(
    purpose: Huami2021SafePurpose,
    payload: Uint8Array,
    encrypted: boolean,
  ): Promise<void> {
    const endpoint = purpose === 'services_list'
      ? HUAMI_2021_SERVICES_ENDPOINT
      : HUAMI_2021_HEART_RATE_ENDPOINT;
    const supported = this.serviceEntries.length
      ? new Set(this.serviceEntries.map((entry) => entry.endpoint))
      : undefined;
    assertHuami2021SafeCommand(purpose, endpoint, payload, supported);
    if (encrypted && !this.sessionKey) throw new Error('加密心率端点缺少认证会话密钥。');
    this.writeHandle = (this.writeHandle + 1) & 0xff;
    const encryption = encrypted && this.sessionKey
      ? {
        sequenceNumber: this.encryptedSequenceNumber,
        sessionKey: this.sessionKey,
      }
      : undefined;
    const chunks = encodeHuami2021Message({
      encryption,
      endpoint,
      handle: this.writeHandle,
      mtu: this.mtu,
      payload,
    });
    if (encryption) this.encryptedSequenceNumber = (this.encryptedSequenceNumber + 1) >>> 0;
    await this.enqueueChunks(chunks);
  }

  private enqueueChunks(chunks: Uint8Array[]): Promise<void> {
    const run = async () => {
      if (this.disposed) throw new Error('小米手环认证会话已经结束。');
      for (const chunk of chunks) await writeCharacteristic(this.write, chunk);
    };
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.catch(() => undefined);
    return result;
  }

  private async handleIncoming(bytes: Uint8Array): Promise<void> {
    const decoded = this.decoder.decode(bytes);
    if (!decoded) return;
    if (decoded.needsAck) {
      await writeCharacteristic(this.read, createHuami2021ChunkAck(decoded.handle, decoded.count));
    }
    this.resolveWaiter(decoded);
  }

  private resolveWaiter(decoded: Huami2021DecodedPayload): void {
    const waiter = Array.from(this.waiters).find((candidate) => (
      candidate.endpoint === decoded.endpoint && candidate.predicate(decoded.payload)
    ));
    if (!waiter) return;
    clearTimeout(waiter.timeout);
    this.waiters.delete(waiter);
    waiter.resolve(decoded.payload);
  }

  private rejectWaiters(error: Error): void {
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.clear();
  }
}

export async function authenticateMiBand6(options: {
  authKeyHex: string;
  device: Device;
  onStage?: (stage: MiBand6AuthStage) => void;
}): Promise<Huami2021AuthenticatedSession> {
  const { authKeyHex, device, onStage } = options;
  const authKey = miBandAuthKeyBytes(authKeyHex);
  const privateKey = createPrivateKey();
  const publicKey = generateHuami2021PublicKey(privateKey);
  const { read, write } = await findAuthCharacteristics(device);
  const session = new Huami2021AuthenticatedSession({ device, read, write });

  onStage?.('starting');
  try {
    const challengePromise = session.waitForPayload({
      endpoint: HUAMI_2021_AUTH_ENDPOINT,
      predicate: (payload) => (
        payload.length >= 3
        && payload[0] === 0x10
        && payload[1] === 0x04
        && payload[2] === 0x01
      ),
      timeoutMs: MI_BAND_6_AUTH_TIMEOUT_MS,
    });
    onStage?.('waiting_challenge');
    await session.sendAuth(createHuami2021PublicKeyAuthPayload(publicKey));
    const challengePayload = await challengePromise;
    const challenge = createHuami2021ChallengeResponse(privateKey, authKey, challengePayload);
    session.setEncryption(challenge.sessionKey, challenge.encryptedSequenceNumber);

    const confirmationPromise = session.waitForPayload({
      endpoint: HUAMI_2021_AUTH_ENDPOINT,
      predicate: (payload) => (
        isHuami2021AuthSuccessPayload(payload)
        || isHuami2021AuthKeyRejectedPayload(payload)
      ),
      timeoutMs: MI_BAND_6_AUTH_TIMEOUT_MS,
    });
    onStage?.('waiting_confirmation');
    await session.sendAuth(challenge.payload);
    const confirmation = await confirmationPromise;
    if (isHuami2021AuthKeyRejectedPayload(confirmation)) {
      throw new Error('手环拒绝了认证密钥，请检查密钥是否属于这只手环。');
    }
    if (!isHuami2021AuthSuccessPayload(confirmation)) {
      throw new Error('小米手环认证确认结构不合法。');
    }
    onStage?.('authenticated');
    privateKey.fill(0);
    authKey.fill(0);
    challenge.sessionKey.fill(0);
    return session;
  } catch (error) {
    privateKey.fill(0);
    authKey.fill(0);
    session.dispose('小米手环认证失败。');
    throw error;
  }
}
