import { NativeModules, Platform } from 'react-native';

type JunLuoSpeechRecognizerNative = {
  cancel: () => Promise<boolean>;
  isAvailable: () => Promise<boolean>;
  start: (languageTag: string) => Promise<boolean>;
  stop: () => Promise<string>;
};

const nativeModule = NativeModules.JunLuoSpeechRecognizer as JunLuoSpeechRecognizerNative | undefined;

export function isNativeSpeechRecognitionAvailable() {
  return Platform.OS === 'android' && !!nativeModule;
}

export async function canUseNativeSpeechRecognition() {
  if (!isNativeSpeechRecognitionAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.isAvailable();
  } catch {
    return false;
  }
}

export async function startNativeSpeechRecognition(languageTag = 'zh-CN') {
  if (!isNativeSpeechRecognitionAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.start(languageTag);
  } catch {
    return false;
  }
}

export async function stopNativeSpeechRecognition() {
  if (!isNativeSpeechRecognitionAvailable() || !nativeModule) return '';
  try {
    return (await nativeModule.stop()).trim();
  } catch {
    return '';
  }
}

export async function cancelNativeSpeechRecognition() {
  if (!isNativeSpeechRecognitionAvailable() || !nativeModule) return false;
  try {
    return await nativeModule.cancel();
  } catch {
    return false;
  }
}
