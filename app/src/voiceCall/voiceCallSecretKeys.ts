export const voiceCallSecretKeys = {
  minimaxApiKey: 'junluo.voiceCall.minimax.apiKey',
  minimaxGroupId: 'junluo.voiceCall.minimax.groupId',
  minimaxVoiceId: 'junluo.voiceCall.minimax.voiceId',
  voiceCallApiToken: 'junluo.voiceCall.backend.apiToken',
} as const;

export const voiceCallSecretKeyList = Object.values(voiceCallSecretKeys);

export const voiceCallSecretStorageKeys = voiceCallSecretKeyList.map(
  (key) => `junluo.fallbackSecret.${encodeURIComponent(key)}`,
);
