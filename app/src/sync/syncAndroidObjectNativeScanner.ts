import { NativeModules, Platform } from 'react-native';

import type {
  SyncObjectChunkDescriptorV1,
} from './syncObjectProtocol';

type NativeManagedSyncScanner = {
  scanManagedSyncContent(
    fileUri: string,
    maximumChunkBytes: number,
  ): Promise<string>;
};

type NativeScanResponse = {
  ok?: boolean;
  code?: string;
  message?: string;
  plaintextBytes?: number;
  plaintextSha256?: string;
  chunks?: SyncObjectChunkDescriptorV1[];
};

const nativeScanner = NativeModules.JunLuoExternalFiles as
  NativeManagedSyncScanner | undefined;

function parseResponse(raw: string): NativeScanResponse {
  try {
    return JSON.parse(raw) as NativeScanResponse;
  } catch {
    throw new Error('Android 原生对象扫描返回了无效 JSON。');
  }
}

export async function scanManagedSyncContentNative(
  fileUri: string,
  maximumChunkBytes: number,
) {
  if (Platform.OS !== 'android' || !nativeScanner) {
    throw new Error('当前安装包没有 Android 原生对象扫描能力。');
  }
  const response = parseResponse(await nativeScanner.scanManagedSyncContent(
    fileUri,
    maximumChunkBytes,
  ));
  if (response.ok !== true) {
    throw new Error(
      response.message
        || response.code
        || 'Android 原生对象扫描失败。',
    );
  }
  if (
    typeof response.plaintextBytes !== 'number'
    || !Number.isSafeInteger(response.plaintextBytes)
    || typeof response.plaintextSha256 !== 'string'
    || !Array.isArray(response.chunks)
  ) {
    throw new Error('Android 原生对象扫描结果缺少摘要字段。');
  }
  return {
    plaintextBytes: response.plaintextBytes,
    plaintextSha256: response.plaintextSha256,
    chunks: response.chunks,
  };
}
