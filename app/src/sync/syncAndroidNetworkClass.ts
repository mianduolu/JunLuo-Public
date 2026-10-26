import { NativeModules, Platform } from 'react-native';

import type {
  SyncObjectNetworkClass,
} from './syncObjectPolicy';

type NativeNetworkClassModule = {
  getNetworkClass(): Promise<unknown>;
};

export async function loadAndroidSyncNetworkClass():
Promise<SyncObjectNetworkClass> {
  if (Platform.OS !== 'android') return 'wifi';
  const native = NativeModules.JunLuoNetworkStatus as
    NativeNetworkClassModule | undefined;
  if (!native) return 'offline';
  const value = await native.getNetworkClass();
  if (
    value !== 'offline'
    && value !== 'cellular'
    && value !== 'wifi'
  ) {
    throw new Error('Android 原生网络类型返回值无效。');
  }
  return value;
}
