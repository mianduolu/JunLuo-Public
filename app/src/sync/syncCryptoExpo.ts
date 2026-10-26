import * as Crypto from 'expo-crypto';
import {
  createSyncCryptoPortV1,
  type SyncCryptoPortConfigV1,
} from './syncCrypto';

export type ExpoSyncCryptoPortConfigV1 = Omit<
  SyncCryptoPortConfigV1,
  'randomBytes'
>;

export const expoSyncRandomBytesV1 = (length: number) => (
  Crypto.getRandomBytesAsync(length)
);

export const expoSyncRandomUuidV1 = () => Crypto.randomUUID();

export function createExpoSyncCryptoPortV1(config: ExpoSyncCryptoPortConfigV1) {
  return createSyncCryptoPortV1({
    ...config,
    randomBytes: expoSyncRandomBytesV1,
  });
}
