import {
  NativeEventEmitter,
  NativeModules,
  type EmitterSubscription,
} from 'react-native';


export type NativeVoiceAudioServerMessage = {
  message: string;
};

export type NativeVoiceAudioStartResult = {
  aec: boolean;
  agc: boolean;
  channels: number;
  frameBytes: number;
  noiseSuppression: boolean;
  sampleRate: number;
  source: string;
  transport: string;
};

export type NativeVoiceCallNetworkBinding = {
  bound: boolean;
  networkHandle: number;
  validated: boolean;
};

type NativeVoiceAudioModule = {
  addListener: (eventName: string) => void;
  bindToWifiNetwork: () => Promise<NativeVoiceCallNetworkBinding>;
  clearWifiNetworkBinding: () => Promise<boolean>;
  isRecording: () => Promise<boolean>;
  removeListeners: (count: number) => void;
  sendText: (payload: string) => Promise<boolean>;
  start: (streamUrl: string) => Promise<NativeVoiceAudioStartResult>;
  stop: () => Promise<boolean>;
};

const nativeModule = NativeModules.JunLuoVoiceAudio as NativeVoiceAudioModule | undefined;
const eventEmitter = nativeModule ? new NativeEventEmitter(nativeModule) : null;

function requireNativeModule() {
  if (!nativeModule || !eventEmitter) {
    throw new Error('当前安装包还没有原生麦克风桥，请覆盖安装最新 debug APK。');
  }
  return nativeModule;
}

export async function startNativeVoiceAudio(
  streamUrl: string,
  onMessage: (message: string) => void,
): Promise<{ info: NativeVoiceAudioStartResult; subscription: EmitterSubscription }> {
  const module = requireNativeModule();
  const subscription = eventEmitter!.addListener('junluoVoiceAudioMessage', (event) => {
    onMessage((event as NativeVoiceAudioServerMessage).message);
  });
  try {
    const info = await module.start(streamUrl);
    return { info, subscription };
  } catch (error) {
    subscription.remove();
    throw error;
  }
}

export async function stopNativeVoiceAudio(subscription?: EmitterSubscription | null) {
  subscription?.remove();
  if (!nativeModule) return;
  await nativeModule.stop();
}

export async function sendNativeVoiceAudioText(payload: string) {
  if (!nativeModule || typeof nativeModule.sendText !== 'function') return false;
  return nativeModule.sendText(payload);
}

export async function bindVoiceCallToWifi() {
  const module = requireNativeModule();
  if (typeof module.bindToWifiNetwork !== 'function') {
    throw new Error('当前安装包还没有通话 Wi-Fi 线路，请覆盖安装最新 debug APK。');
  }
  return module.bindToWifiNetwork();
}

export async function clearVoiceCallWifiBinding() {
  if (!nativeModule || typeof nativeModule.clearWifiNetworkBinding !== 'function') return;
  await nativeModule.clearWifiNetworkBinding();
}
