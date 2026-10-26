import { NativeModules, Platform } from 'react-native';

import { bytesToBase64Url } from './syncCrypto';
import {
  assertSealedSyncObjectChunkV1,
  type SealedSyncObjectChunkV1,
  type SyncObjectManifestPlaintextV1,
} from './syncObjectProtocol';

type NativeManagedSyncChunkSealer = {
  sealManagedSyncChunk(optionsJson: string): Promise<string>;
};

type NativeSealResponse = Partial<SealedSyncObjectChunkV1> & {
  ok?: boolean;
  code?: string;
  message?: string;
};

const nativeSealer = NativeModules.JunLuoExternalFiles as
  NativeManagedSyncChunkSealer | undefined;

export async function sealManagedSyncObjectChunkNative(input: {
  localUri: string;
  manifest: SyncObjectManifestPlaintextV1;
  chunkIndex: number;
  identity: {
    vaultId: string;
    sourceDeviceId: string;
    keyId: string;
    objectEncryptionKey: Uint8Array;
    signingPrivateKey: Uint8Array;
  };
}) {
  if (Platform.OS !== 'android' || !nativeSealer) {
    throw new Error('当前安装包没有 Android 原生对象分片能力。');
  }
  const descriptor = input.manifest.chunks[input.chunkIndex];
  if (!descriptor) throw new Error('Android 原生对象 chunkIndex 越界。');
  let response: NativeSealResponse;
  try {
    response = JSON.parse(await nativeSealer.sealManagedSyncChunk(
      JSON.stringify({
        fileUri: input.localUri,
        objectId: input.manifest.objectId,
        chunkIndex: input.chunkIndex,
        chunkBytes: input.manifest.chunkBytes,
        plaintextBytes: descriptor.plaintextBytes,
        plaintextSha256: descriptor.plaintextSha256,
        vaultId: input.identity.vaultId,
        sourceDeviceId: input.identity.sourceDeviceId,
        keyId: input.identity.keyId,
        objectEncryptionKey: bytesToBase64Url(
          input.identity.objectEncryptionKey,
        ),
        signingPrivateKey: bytesToBase64Url(
          input.identity.signingPrivateKey,
        ),
      }),
    )) as NativeSealResponse;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error('Android 原生对象分片返回了无效 JSON。');
    }
    throw error;
  }
  if (response.ok !== true) {
    throw new Error(
      response.message
        || response.code
        || 'Android 原生对象分片失败。',
    );
  }
  const sealed: unknown = {
    protocolVersion: response.protocolVersion,
    vaultId: response.vaultId,
    sourceDeviceId: response.sourceDeviceId,
    objectId: response.objectId,
    chunkIndex: response.chunkIndex,
    keyId: response.keyId,
    nonce: response.nonce,
    ciphertext: response.ciphertext,
    ciphertextSha256: response.ciphertextSha256,
    signature: response.signature,
  };
  assertSealedSyncObjectChunkV1(sealed);
  if (
    sealed.vaultId !== input.identity.vaultId
    || sealed.sourceDeviceId !== input.identity.sourceDeviceId
    || sealed.objectId !== input.manifest.objectId
    || sealed.chunkIndex !== input.chunkIndex
    || sealed.keyId !== input.identity.keyId
  ) {
    throw new Error('Android 原生对象分片路由与请求不一致。');
  }
  return sealed;
}
