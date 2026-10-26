export type ChatVoiceCaptureGate = {
  appState: string | null | undefined;
  mounted: boolean;
  screenActive: boolean;
  voiceAudioReleaseForCallActive?: boolean;
  voiceCallAudioActive: boolean;
};

export const CHAT_VOICE_AUDIO_RELEASE_STAGE_TIMEOUT_MS = 7_000;
export const CHAT_VOICE_AUDIO_RELEASE_TOTAL_TIMEOUT_MS =
  CHAT_VOICE_AUDIO_RELEASE_STAGE_TIMEOUT_MS * 2 + 1_000;

export function isChatVoiceCaptureAllowed(gate: ChatVoiceCaptureGate) {
  return gate.mounted
    && gate.screenActive
    && gate.appState === 'active'
    && !gate.voiceAudioReleaseForCallActive
    && !gate.voiceCallAudioActive;
}

export type ChatVoiceAudioResourceState = {
  busy: boolean;
  finishing: boolean;
  hasFinishPromise: boolean;
  hasNativeSpeechPromise: boolean;
  hasPrewarmPromise: boolean;
  hasRecorder: boolean;
  hasTeardownPromise: boolean;
  nativeSpeechActive: boolean;
  recorderPrepared: boolean;
  recording: boolean;
  recordingStarted: boolean;
  starting: boolean;
};

export function isChatVoiceAudioQuiet(state: ChatVoiceAudioResourceState) {
  return !Object.values(state).some(Boolean);
}

export type ChatVoiceAudioReleaseInput = {
  exitRecordingMode: () => Promise<void>;
  isQuiet: () => boolean;
  stageTimeoutMs: number;
  teardown: () => Promise<boolean>;
};

async function waitForChatVoiceReleaseStage(
  task: () => Promise<unknown>,
  timeoutMs: number,
  requireTrue: boolean,
) {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(task)
        .then((result) => requireTrue ? result === true : true, () => false),
      new Promise<boolean>((resolve) => {
        timeoutId = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function releaseChatVoiceAudioResources(input: ChatVoiceAudioReleaseInput) {
  const teardownSucceeded = await waitForChatVoiceReleaseStage(
    input.teardown,
    input.stageTimeoutMs,
    true,
  );
  const recordingModeExited = await waitForChatVoiceReleaseStage(
    input.exitRecordingMode,
    input.stageTimeoutMs,
    false,
  );
  if (!teardownSucceeded || !recordingModeExited) return false;
  try {
    return input.isQuiet();
  } catch {
    return false;
  }
}

export function isChatVoicePrewarmDesired(input: {
  captureAllowed: boolean;
  configLoaded: boolean;
  hasDraft: boolean;
  replyBusy: boolean;
  voiceMode: boolean;
}) {
  return input.captureAllowed
    && input.configLoaded
    && !input.hasDraft
    && !input.replyBusy
    && input.voiceMode;
}

export function canCommitChatVoiceOperation(input: {
  cancelRequested: boolean;
  captureAllowed: boolean;
  currentLifecycleToken: number;
  currentOperationToken: number;
  lifecycleToken: number;
  operationToken: number;
}) {
  return input.captureAllowed
    && !input.cancelRequested
    && input.currentLifecycleToken === input.lifecycleToken
    && input.currentOperationToken === input.operationToken;
}

export function shouldRestoreChatPlaybackMode(input: { voiceCallAudioActive: boolean }) {
  return !input.voiceCallAudioActive;
}
