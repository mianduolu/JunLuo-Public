import {
  aiLogicalConfigStorageBridge as AsyncStorage,
} from '../sync/syncAiLogicalConfigStorageBridge';

import { getSecretItem } from '../storage/secretStore';
import {
  deleteVaultSharedSecret,
  setVaultSharedSecret,
} from '../sync/syncVaultSharedSecretsStorageBridge';
import { voiceCallSecretKeys } from './voiceCallSecretKeys';

export { voiceCallSecretKeys, voiceCallSecretStorageKeys } from './voiceCallSecretKeys';

const VOICE_CALL_SETTINGS_KEY = 'junluo.voiceCall.settings.v1';

export type VoiceCallSttProvider = 'cloud' | 'funasr';
export type VoiceCallUplinkMode = 'auto' | 'livekit' | 'native';

export type VoiceCallSettings = {
  autonomousIncomingCallsEnabled: boolean;
  dailyCharacterLimit: number;
  emotion2vecEnabled: boolean;
  enabled: boolean;
  maxCallMinutes: number;
  maxNewSynthesesPerCall: number;
  minimaxBaseUrl: string;
  minimaxModel: string;
  saveCallSummary: boolean;
  saveRawAudio: boolean;
  sttProvider: VoiceCallSttProvider;
  uplinkMode: VoiceCallUplinkMode;
};

export type VoiceCallSecrets = {
  minimaxApiKey: string;
  minimaxGroupId: string;
  minimaxVoiceId: string;
  voiceCallApiToken: string;
};

export type VoiceCallReadiness =
  | { kind: 'disabled'; label: string; detail: string }
  | { kind: 'missing_backend_token'; label: string; detail: string }
  | { kind: 'ready'; label: string; detail: string };

export const defaultVoiceCallSettings: VoiceCallSettings = {
  autonomousIncomingCallsEnabled: false,
  dailyCharacterLimit: 3000,
  emotion2vecEnabled: false,
  enabled: false,
  maxCallMinutes: 10,
  maxNewSynthesesPerCall: 4,
  minimaxBaseUrl: 'https://api.minimaxi.chat/v1/t2a_v2',
  minimaxModel: 'speech-02-turbo',
  saveCallSummary: true,
  saveRawAudio: false,
  sttProvider: 'funasr',
  uplinkMode: 'auto',
};

const emptySecrets: VoiceCallSecrets = {
  minimaxApiKey: '',
  minimaxGroupId: '',
  minimaxVoiceId: '',
  voiceCallApiToken: '',
};

export async function getVoiceCallApiToken() {
  return (await getSecretItem(voiceCallSecretKeys.voiceCallApiToken))?.trim() ?? '';
}

async function saveVoiceCallApiToken(value: string) {
  const normalized = value.trim();
  if (!normalized) {
    await deleteVaultSharedSecret(voiceCallSecretKeys.voiceCallApiToken);
    return;
  }
  await setVaultSharedSecret(voiceCallSecretKeys.voiceCallApiToken, normalized);
}

function normalizePositiveInteger(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numberValue)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numberValue)));
}

function normalizeSttProvider(value: unknown): VoiceCallSttProvider {
  return value === 'cloud' ? 'cloud' : 'funasr';
}

function normalizeUplinkMode(value: unknown): VoiceCallUplinkMode {
  return value === 'livekit' || value === 'native' || value === 'auto' ? value : 'auto';
}

function normalizeSettings(value: unknown): VoiceCallSettings {
  if (!value || typeof value !== 'object') return defaultVoiceCallSettings;
  const candidate = value as Partial<VoiceCallSettings>;
  return {
    autonomousIncomingCallsEnabled: candidate.autonomousIncomingCallsEnabled === true,
    dailyCharacterLimit: normalizePositiveInteger(candidate.dailyCharacterLimit, 3000, 100, 200000),
    emotion2vecEnabled: candidate.emotion2vecEnabled === true,
    enabled: candidate.enabled === true,
    maxCallMinutes: normalizePositiveInteger(candidate.maxCallMinutes, 10, 1, 180),
    maxNewSynthesesPerCall: normalizePositiveInteger(candidate.maxNewSynthesesPerCall, 4, 1, 20),
    minimaxBaseUrl: (candidate.minimaxBaseUrl || defaultVoiceCallSettings.minimaxBaseUrl).trim().replace(/\/+$/, ''),
    minimaxModel: (candidate.minimaxModel || defaultVoiceCallSettings.minimaxModel).trim(),
    saveCallSummary: candidate.saveCallSummary !== false,
    saveRawAudio: false,
    sttProvider: normalizeSttProvider(candidate.sttProvider),
    uplinkMode: normalizeUplinkMode(candidate.uplinkMode),
  };
}

export async function loadVoiceCallSettings() {
  const [rawSettings, minimaxApiKey, minimaxGroupId, minimaxVoiceId, voiceCallApiToken] = await Promise.all([
    AsyncStorage.getItem(VOICE_CALL_SETTINGS_KEY),
    getSecretItem(voiceCallSecretKeys.minimaxApiKey),
    getSecretItem(voiceCallSecretKeys.minimaxGroupId),
    getSecretItem(voiceCallSecretKeys.minimaxVoiceId),
    getVoiceCallApiToken(),
  ]);

  let settings = defaultVoiceCallSettings;
  if (rawSettings) {
    try {
      settings = normalizeSettings(JSON.parse(rawSettings) as unknown);
    } catch {
      settings = defaultVoiceCallSettings;
    }
  }

  return {
    secrets: {
      minimaxApiKey: minimaxApiKey ?? '',
      minimaxGroupId: minimaxGroupId ?? '',
      minimaxVoiceId: minimaxVoiceId ?? '',
      voiceCallApiToken,
    },
    settings,
  };
}

export async function saveVoiceCallSettings(settings: VoiceCallSettings, secrets: VoiceCallSecrets) {
  const normalized = normalizeSettings(settings);
  await Promise.all([
    AsyncStorage.setItem(VOICE_CALL_SETTINGS_KEY, JSON.stringify(normalized)),
    setVaultSharedSecret(voiceCallSecretKeys.minimaxApiKey, secrets.minimaxApiKey),
    setVaultSharedSecret(voiceCallSecretKeys.minimaxGroupId, secrets.minimaxGroupId),
    setVaultSharedSecret(voiceCallSecretKeys.minimaxVoiceId, secrets.minimaxVoiceId),
    saveVoiceCallApiToken(secrets.voiceCallApiToken),
  ]);
  return normalized;
}

export async function clearVoiceCallSecrets() {
  await Promise.all([
    deleteVaultSharedSecret(voiceCallSecretKeys.minimaxApiKey),
    deleteVaultSharedSecret(voiceCallSecretKeys.minimaxGroupId),
    deleteVaultSharedSecret(voiceCallSecretKeys.minimaxVoiceId),
    deleteVaultSharedSecret(voiceCallSecretKeys.voiceCallApiToken),
  ]);
  return { ...emptySecrets };
}

export function getVoiceCallReadiness(settings: VoiceCallSettings, secrets: VoiceCallSecrets): VoiceCallReadiness {
  if (!settings.enabled) {
    return { kind: 'disabled', label: '未启用', detail: '语音通话总开关还关着；测试来电壳仍然可以手动触发。' };
  }
  if (!secrets.voiceCallApiToken.trim()) {
    return { kind: 'missing_backend_token', label: '缺电话线令牌', detail: '在电脑小管家里复制电话线令牌，粘贴并保存后才能请求本地语音后端。' };
  }
  return { kind: 'ready', label: '本地配置已就绪', detail: '电脑后端会报告实际电话线、音色与今日额度状态。' };
}
