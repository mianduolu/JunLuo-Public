import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  AudioModule,
  getRecordingPermissionsAsync,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';

import type { MessageVoice } from '../ai/subjectiveMessages';
import {
  canCommitBackupRestoreDataEpoch,
  captureBackupRestoreDataEpoch,
  runBackupRestoreDataEpochCommit,
} from '../backup/backupRestoreCoordinator';
import { copyFileSafely } from '../storage/safeFileWrite';
import {
  CHAT_VOICE_AUDIO_RELEASE_STAGE_TIMEOUT_MS,
  canCommitChatVoiceOperation,
  isChatVoiceAudioQuiet,
  isChatVoiceCaptureAllowed,
  isChatVoicePrewarmDesired,
  releaseChatVoiceAudioResources,
  shouldRestoreChatPlaybackMode,
} from './chatVoiceLifecycle';
import {
  cancelNativeSpeechRecognition,
  startNativeSpeechRecognition,
  stopNativeSpeechRecognition,
} from './nativeSpeechRecognition';

const VOICE_MESSAGE_MIN_DURATION_MS = 800;
const VOICE_MESSAGE_MAX_DURATION_MS = 60_000;
const VOICE_MESSAGE_STOP_GRACE_MS = 700;
const VOICE_RECORDER_STOP_TIMEOUT_MS = 2_500;
const VOICE_NATIVE_TRANSCRIPT_TIMEOUT_MS = 2_500;
const VOICE_TEARDOWN_WAIT_TIMEOUT_MS = 3_000;
const VOICE_MESSAGE_MIME_TYPE = 'audio/mp4';
const VOICE_MESSAGE_EXTENSION = 'm4a';

const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  android: {
    ...RecordingPresets.HIGH_QUALITY.android,
    audioEncoder: 'aac' as const,
    outputFormat: 'mpeg4' as const,
  },
  isMeteringEnabled: false,
};

type VoiceTranscriptionResult = {
  ok: boolean;
  data?: unknown;
  summary: string;
};

type SendVoiceMessageInput = {
  text: string;
  voice: MessageVoice;
  duplicateKey: string;
  onAccepted: () => void;
  prepareAfterPersist: () => Promise<{ text: string; voice: MessageVoice }>;
};

export type UseChatVoiceRecorderOptions = {
  active: boolean;
  configLoaded: boolean;
  hasDraft: boolean;
  replyBusy: boolean;
  voiceCallAudioActive?: boolean;
  onBeforeStart: () => void;
  onError: (message: string | null) => void;
  onNotice: (message: string, durationMs: number) => void;
  sendVoiceMessage: (input: SendVoiceMessageInput) => Promise<void>;
  transcribeVoice: (input: { durationMs: number; transcript: string }) => Promise<VoiceTranscriptionResult>;
};

export type ReleaseChatVoiceAudioForCall = () => Promise<boolean>;
export type ResumeChatVoiceAudioAfterCall = () => void;

export function useChatVoiceRecorder(options: UseChatVoiceRecorderOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [voiceStarting, setVoiceStarting] = useState(false);
  const [voiceRecordStartedAt, setVoiceRecordStartedAt] = useState<number | null>(null);
  const [nativeSpeechActive, setNativeSpeechActive] = useState(false);

  const voiceStartingStateRef = useRef(voiceStarting);
  const voiceRecordStartedAtStateRef = useRef(voiceRecordStartedAt);
  const voiceRecorderRef = useRef<InstanceType<typeof AudioModule.AudioRecorder> | null>(null);
  const voiceRecordStartedAtRef = useRef<number | null>(null);
  const voiceStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceBusyRef = useRef(false);
  const voiceStartingRef = useRef(false);
  const voiceRecordingRef = useRef(false);
  const voiceFinishingRef = useRef(false);
  const voiceFinishPromiseRef = useRef<Promise<void> | null>(null);
  const voiceCancelRequestedRef = useRef(false);
  const voiceRecordedUriRef = useRef<string | null>(null);
  const voiceRecorderPreparedRef = useRef(false);
  const voiceRecorderPrewarmPromiseRef = useRef<Promise<boolean> | null>(null);
  const voiceResponderActionAtRef = useRef(0);
  const voiceStartTokenRef = useRef(0);
  const voiceLifecycleTokenRef = useRef(0);
  const voiceDataEpochRef = useRef<number | null>(null);
  const voiceTeardownPromiseRef = useRef<Promise<boolean> | null>(null);
  const nativeSpeechActiveRef = useRef(false);
  const nativeSpeechStartPromiseRef = useRef<Promise<boolean> | null>(null);
  const voiceAudioReleaseForCallRef = useRef(!!options.voiceCallAudioActive);
  const voiceCallAudioWasActiveRef = useRef(!!options.voiceCallAudioActive);
  const appStateRef = useRef(AppState.currentState);
  const mountedRef = useRef(true);
  voiceStartingStateRef.current = voiceStarting;
  voiceRecordStartedAtStateRef.current = voiceRecordStartedAt;
  if (options.voiceCallAudioActive) {
    voiceAudioReleaseForCallRef.current = true;
    voiceCallAudioWasActiveRef.current = true;
  }

  const isVoiceCaptureAllowed = useCallback(() => isChatVoiceCaptureAllowed({
    appState: appStateRef.current,
    mounted: mountedRef.current,
    screenActive: optionsRef.current.active,
    voiceAudioReleaseForCallActive: voiceAudioReleaseForCallRef.current,
    voiceCallAudioActive: !!optionsRef.current.voiceCallAudioActive,
  }), []);

  const isVoiceLifecycleCurrent = useCallback((lifecycleToken: number) => (
    voiceLifecycleTokenRef.current === lifecycleToken
    && isVoiceCaptureAllowed()
  ), [isVoiceCaptureAllowed]);

  const canCommitVoiceOperation = useCallback((
    operationToken: number,
    lifecycleToken: number,
  ) => canCommitChatVoiceOperation({
    cancelRequested: voiceCancelRequestedRef.current,
    captureAllowed: isVoiceCaptureAllowed(),
    currentLifecycleToken: voiceLifecycleTokenRef.current,
    currentOperationToken: voiceStartTokenRef.current,
    lifecycleToken,
    operationToken,
  }) && canCommitBackupRestoreDataEpoch(voiceDataEpochRef.current), [isVoiceCaptureAllowed]);

  const persistVoiceRecording = useCallback(async (sourceUri: string) => {
    const committed = await runBackupRestoreDataEpochCommit(voiceDataEpochRef.current, async () => {
      if (!FileSystem.documentDirectory) return sourceUri;
      const voiceDirectory = `${FileSystem.documentDirectory}voice-messages/`;
      const persistentUri = `${voiceDirectory}voice-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}.${VOICE_MESSAGE_EXTENSION}`;
      await copyFileSafely({ from: sourceUri, to: persistentUri });
      return persistentUri;
    });
    return committed.committed ? committed.value : null;
  }, []);

  const getVoiceRecorder = useCallback(() => {
    if (!voiceRecorderRef.current) {
      voiceRecorderRef.current = new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS);
    }
    return voiceRecorderRef.current;
  }, []);

  const releaseVoiceRecorder = useCallback(() => {
    const recorder = voiceRecorderRef.current;
    voiceRecorderRef.current = null;
    voiceRecorderPreparedRef.current = false;
    voiceRecorderPrewarmPromiseRef.current = null;
    if (!recorder) return;
    try {
      (recorder as unknown as { remove?: () => void }).remove?.();
    } catch {
      // Native recorder cleanup is best-effort across app/activity lifecycle edges.
    }
  }, []);

  const releaseSpecificVoiceRecorder = useCallback((
    recorder: InstanceType<typeof AudioModule.AudioRecorder> | null,
  ) => {
    if (!recorder) return;
    if (voiceRecorderRef.current === recorder) {
      releaseVoiceRecorder();
      return;
    }
    try {
      (recorder as unknown as { remove?: () => void }).remove?.();
    } catch {
      // A stale prepare may already have been released by lifecycle teardown.
    }
  }, [releaseVoiceRecorder]);

  const clearVoiceStopTimer = useCallback(() => {
    if (!voiceStopTimerRef.current) return;
    clearTimeout(voiceStopTimerRef.current);
    voiceStopTimerRef.current = null;
  }, []);

  const setVoiceBusyState = useCallback((busy: boolean) => {
    voiceBusyRef.current = busy;
    if (mountedRef.current) setVoiceBusy(busy);
  }, []);

  const clearVoiceRecorderUri = useCallback(() => {
    voiceRecordedUriRef.current = null;
    const recorder = voiceRecorderRef.current;
    if (!recorder) return;
    try {
      recorder.uri = null;
    } catch {
      // expo-audio exposes uri as a property, but keep cleanup tolerant across runtimes.
    }
  }, []);

  const deleteVoiceFileSafely = useCallback(async (
    uri: string | null | undefined,
    dataEpoch = voiceDataEpochRef.current,
  ) => {
    if (!uri) return;
    const voiceDirectory = FileSystem.documentDirectory
      ? `${FileSystem.documentDirectory}voice-messages/`
      : undefined;
    if (voiceDirectory && uri.startsWith(voiceDirectory)) {
      await runBackupRestoreDataEpochCommit(dataEpoch, () => (
        FileSystem.deleteAsync(uri, { idempotent: true })
      )).catch(() => undefined);
      return;
    }
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => undefined);
  }, []);

  const exitRecordingModeForVoiceCall = useCallback(async () => {
    await setAudioModeAsync({
      allowsRecording: false,
      interruptionMode: 'doNotMix',
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      shouldRouteThroughEarpiece: false,
    });
  }, []);

  const restoreChatPlaybackMode = useCallback(async () => {
    if (!shouldRestoreChatPlaybackMode({
      voiceCallAudioActive: !!optionsRef.current.voiceCallAudioActive,
    })) return true;
    try {
      await exitRecordingModeForVoiceCall();
      return true;
    } catch {
      return false;
    }
  }, [exitRecordingModeForVoiceCall]);

  const waitForPendingVoiceOperation = useCallback(async (
    promise: Promise<unknown> | null,
  ) => {
    if (!promise) return true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise.then(() => true, () => false),
        new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => resolve(false), VOICE_TEARDOWN_WAIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }, []);

  const waitForPendingVoiceBooleanOperation = useCallback(async (
    promise: Promise<boolean> | null,
  ) => {
    if (!promise) return true;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        promise.then((result) => result === true, () => false),
        new Promise<boolean>((resolve) => {
          timeoutId = setTimeout(() => resolve(false), VOICE_TEARDOWN_WAIT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }, []);

  const ensureVoiceRecorderReady = useCallback(async (readyOptions: { requestPermission: boolean; showErrors: boolean }) => {
    const lifecycleToken = voiceLifecycleTokenRef.current;
    if (
      !isVoiceLifecycleCurrent(lifecycleToken)
      || voiceFinishingRef.current
      || voiceTeardownPromiseRef.current
    ) return false;
    if (voiceRecorderPreparedRef.current) return true;
    if (voiceRecorderPrewarmPromiseRef.current) {
      const ready = await voiceRecorderPrewarmPromiseRef.current;
      if (ready || !readyOptions.requestPermission || !isVoiceLifecycleCurrent(lifecycleToken)) {
        return ready && isVoiceLifecycleCurrent(lifecycleToken);
      }
    }

    let preparedRecorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
    let readyPromise!: Promise<boolean>;
    const restorePreparedAudioMode = async () => {
      const anotherLifecycleOwnsAudio = voiceLifecycleTokenRef.current !== lifecycleToken && (
        voiceStartingRef.current
        || voiceRecordingRef.current
        || voiceRecorderPreparedRef.current
        || (
          !!voiceRecorderPrewarmPromiseRef.current
          && voiceRecorderPrewarmPromiseRef.current !== readyPromise
        )
      );
      if (!anotherLifecycleOwnsAudio) await restoreChatPlaybackMode();
    };
    const preparePromise = (async () => {
      const permission = readyOptions.requestPermission
        ? await requestRecordingPermissionsAsync()
        : await getRecordingPermissionsAsync();
      if (!isVoiceLifecycleCurrent(lifecycleToken)) return false;
      if (!permission.granted) {
        if (readyOptions.showErrors && mountedRef.current) {
          optionsRef.current.onError('需要麦克风权限，才能给白云小姐发语音。');
        }
        return false;
      }
      await setAudioModeAsync({
        allowsRecording: true,
        interruptionMode: 'doNotMix',
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        shouldRouteThroughEarpiece: false,
      });
      if (!isVoiceLifecycleCurrent(lifecycleToken)) {
        await restorePreparedAudioMode();
        return false;
      }
      clearVoiceRecorderUri();
      preparedRecorder = getVoiceRecorder();
      await preparedRecorder.prepareToRecordAsync(VOICE_RECORDING_OPTIONS);
      if (!isVoiceLifecycleCurrent(lifecycleToken) || preparedRecorder !== voiceRecorderRef.current) {
        releaseSpecificVoiceRecorder(preparedRecorder);
        await restorePreparedAudioMode();
        return false;
      }
      voiceRecorderPreparedRef.current = true;
      return true;
    })();
    readyPromise = preparePromise.catch(async (caught) => {
      const failedRecorder = preparedRecorder as InstanceType<typeof AudioModule.AudioRecorder> | null;
      const failedUri = failedRecorder?.uri;
      releaseSpecificVoiceRecorder(failedRecorder);
      await deleteVoiceFileSafely(failedUri);
      await restorePreparedAudioMode();
      if (readyOptions.showErrors && isVoiceLifecycleCurrent(lifecycleToken)) {
        optionsRef.current.onError(caught instanceof Error ? caught.message : '录音启动失败。');
      }
      return false;
    });

    voiceRecorderPrewarmPromiseRef.current = readyPromise;
    try {
      return await readyPromise;
    } finally {
      if (voiceRecorderPrewarmPromiseRef.current === readyPromise) {
        voiceRecorderPrewarmPromiseRef.current = null;
      }
    }
  }, [
    clearVoiceRecorderUri,
    deleteVoiceFileSafely,
    getVoiceRecorder,
    isVoiceLifecycleCurrent,
    releaseSpecificVoiceRecorder,
    restoreChatPlaybackMode,
  ]);

  useEffect(() => {
    if (
      !isChatVoicePrewarmDesired({
        captureAllowed: isVoiceCaptureAllowed(),
        configLoaded: options.configLoaded,
        hasDraft: options.hasDraft,
        replyBusy: options.replyBusy,
        voiceMode,
      })
      || voiceBusy
      || voiceFinishingRef.current
      || voiceTeardownPromiseRef.current
      || voiceRecordingRef.current
      || voiceStartingRef.current
    ) return;
    void ensureVoiceRecorderReady({ requestPermission: false, showErrors: false });
  }, [
    ensureVoiceRecorderReady,
    isVoiceCaptureAllowed,
    options.active,
    options.configLoaded,
    options.hasDraft,
    options.replyBusy,
    options.voiceCallAudioActive,
    voiceBusy,
    voiceMode,
  ]);

  const markVoiceRecordingStopped = useCallback(() => {
    clearVoiceStopTimer();
    voiceStartingRef.current = false;
    voiceRecordingRef.current = false;
    voiceRecordStartedAtRef.current = null;
    if (mountedRef.current) {
      setVoiceStarting(false);
      setVoiceRecordStartedAt(null);
    }
  }, [clearVoiceStopTimer]);

  const stopNativeSpeechRecognitionSafely = useCallback(async () => {
    if (!nativeSpeechActiveRef.current) return '';
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        stopNativeSpeechRecognition(),
        new Promise<string>((resolve) => {
          timeoutId = setTimeout(() => {
            void cancelNativeSpeechRecognition();
            resolve('');
          }, VOICE_NATIVE_TRANSCRIPT_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return '';
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      nativeSpeechActiveRef.current = false;
      if (mountedRef.current) setNativeSpeechActive(false);
    }
  }, []);

  const stopVoiceRecorderSafely = useCallback(async () => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const recorder = voiceRecorderRef.current;
    let stopped = !recorder;
    try {
      stopped = await Promise.race([
        recorder?.stop().then(() => true) ?? Promise.resolve(true),
        new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, VOICE_RECORDER_STOP_TIMEOUT_MS);
        }).then(() => false),
      ]);
    } catch {
      // Stop can throw if Android already finalized or interrupted the recorder.
      stopped = false;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
      if (recorder?.uri) {
        voiceRecordedUriRef.current = recorder.uri;
      }
      voiceRecorderPreparedRef.current = false;
      releaseVoiceRecorder();
    }
    return stopped;
  }, [releaseVoiceRecorder]);

  const runVoiceResponderAction = useCallback((action: () => void) => {
    const now = Date.now();
    if (now - voiceResponderActionAtRef.current < 250) return;
    voiceResponderActionAtRef.current = now;
    action();
  }, []);

  const waitForNextFrame = useCallback(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  }), []);

  const finishVoiceRecording = useCallback(async (): Promise<void> => {
    if (__DEV__ && process.env.EXPO_PUBLIC_JUNLUO_RUNTIME_DIAGNOSTICS === '1') {
      console.log('[voice] finish pressed', {
        hasUri: !!voiceRecorderRef.current?.uri,
        isFinishing: voiceFinishingRef.current,
        isRecording: voiceRecordingRef.current,
        isStarting: voiceStartingRef.current,
        recordingRef: voiceRecordingRef.current,
      });
    }
    if (voiceFinishPromiseRef.current) return voiceFinishPromiseRef.current;
    if (!voiceRecordingRef.current && !voiceRecordStartedAtRef.current) return;

    let finishPromise!: Promise<void>;
    finishPromise = (async () => {
      voiceCancelRequestedRef.current = false;
      voiceStartTokenRef.current += 1;
      const finishToken = voiceStartTokenRef.current;
      const lifecycleToken = voiceLifecycleTokenRef.current;
      const dataEpoch = voiceDataEpochRef.current;
      voiceFinishingRef.current = true;
      const startedAt = voiceRecordStartedAtRef.current ?? voiceRecordStartedAtStateRef.current ?? Date.now();
      const shouldStopRecorder = voiceRecordingRef.current || voiceRecordStartedAtRef.current !== null;
      let unsentUri: string | null = null;
      let voiceFileOwned = false;
      const ownsCurrentOperation = () => (
        voiceStartTokenRef.current === finishToken
        && voiceLifecycleTokenRef.current === lifecycleToken
      );
      setVoiceBusyState(true);
      markVoiceRecordingStopped();
      try {
        if (shouldStopRecorder) {
          await stopVoiceRecorderSafely();
        }
        if (voiceRecorderRef.current?.uri) {
          voiceRecordedUriRef.current = voiceRecorderRef.current.uri;
        }
        unsentUri = voiceRecordedUriRef.current;
        const nativeTranscript = await stopNativeSpeechRecognitionSafely();
        if (!canCommitVoiceOperation(finishToken, lifecycleToken)) return;
        await restoreChatPlaybackMode();
        if (!canCommitVoiceOperation(finishToken, lifecycleToken)) return;
        const sourceUri = voiceRecordedUriRef.current;
        const durationMs = Math.max(0, Date.now() - startedAt);
        if (!sourceUri || durationMs < VOICE_MESSAGE_MIN_DURATION_MS) {
          if (mountedRef.current) {
            optionsRef.current.onError('这段语音太短啦，按住稍微久一点再发。');
          }
          return;
        }
        const uri = await persistVoiceRecording(sourceUri);
        if (!uri) return;
        unsentUri = uri;
        if (uri !== sourceUri) {
          await deleteVoiceFileSafely(sourceUri);
        }
        if (!canCommitVoiceOperation(finishToken, lifecycleToken)) return;
        const transcript = nativeTranscript.trim();
        const fallbackText = '（小仓鼠发来一段语音，但暂时没有转成文字。）';
        const voice: MessageVoice = {
          durationMs,
          transcript: transcript || undefined,
          transcriptionStatus: 'pending',
          uri,
        };
        await optionsRef.current.sendVoiceMessage({
          duplicateKey: `voice:${uri}`,
          onAccepted: () => {
            voiceFileOwned = true;
            unsentUri = null;
          },
          prepareAfterPersist: async () => {
            const transcriptionResult = await optionsRef.current.transcribeVoice({ durationMs, transcript });
            const toolTranscript = transcriptionResult.ok && typeof transcriptionResult.data === 'object' && transcriptionResult.data
              ? (transcriptionResult.data as { transcript?: unknown }).transcript
              : undefined;
            const finalTranscript = typeof toolTranscript === 'string' && toolTranscript.trim() ? toolTranscript.trim() : transcript;
            return {
              text: finalTranscript || fallbackText,
              voice: {
                ...voice,
                transcript: finalTranscript || undefined,
                transcriptionError: transcriptionResult.ok ? undefined : transcriptionResult.summary,
                transcriptionStatus: transcriptionResult.ok ? 'ready' : 'error',
              },
            };
          },
          text: transcript || fallbackText,
          voice,
        });
        if (voiceFileOwned && !transcript && mountedRef.current) {
          optionsRef.current.onNotice('语音已发出；手机这次没有识别出文字。', 2600);
        }
      } catch (caught) {
        if (ownsCurrentOperation()) {
          void cancelNativeSpeechRecognition();
          nativeSpeechActiveRef.current = false;
          if (mountedRef.current) setNativeSpeechActive(false);
          if (!voiceFileOwned && !voiceCancelRequestedRef.current && mountedRef.current) {
            optionsRef.current.onError(caught instanceof Error ? caught.message : '语音发送失败。');
          }
        }
      } finally {
        if (!voiceFileOwned) await deleteVoiceFileSafely(unsentUri, dataEpoch);
        if (ownsCurrentOperation()) {
          voiceDataEpochRef.current = null;
          markVoiceRecordingStopped();
          clearVoiceRecorderUri();
          voiceFinishingRef.current = false;
          setVoiceBusyState(false);
        }
        if (voiceFinishPromiseRef.current === finishPromise) {
          voiceFinishPromiseRef.current = null;
        }
      }
    })();
    voiceFinishPromiseRef.current = finishPromise;
    return finishPromise;
  }, [
    canCommitVoiceOperation,
    clearVoiceRecorderUri,
    deleteVoiceFileSafely,
    markVoiceRecordingStopped,
    persistVoiceRecording,
    restoreChatPlaybackMode,
    setVoiceBusyState,
    stopNativeSpeechRecognitionSafely,
    stopVoiceRecorderSafely,
  ]);

  const startVoiceRecording = useCallback(async () => {
    if (optionsRef.current.voiceCallAudioActive) {
      optionsRef.current.onError('通话里正在占用麦克风，挂断后再发语音。');
      return;
    }
    if (!isVoiceCaptureAllowed()) return;
    const pendingTeardown = voiceTeardownPromiseRef.current;
    if (pendingTeardown) {
      await pendingTeardown;
      if (!isVoiceCaptureAllowed()) return;
    }
    if (
      voiceBusyRef.current
      || voiceStartingStateRef.current
      || voiceFinishingRef.current
      || voiceRecordingRef.current
      || optionsRef.current.replyBusy
      || !optionsRef.current.configLoaded
    ) return;
    const dataEpoch = captureBackupRestoreDataEpoch();
    if (dataEpoch === null) return;
    voiceDataEpochRef.current = dataEpoch;
    voiceCancelRequestedRef.current = false;
    voiceRecordingRef.current = true;
    voiceStartingRef.current = true;
    if (mountedRef.current) setVoiceStarting(true);
    const startToken = voiceStartTokenRef.current + 1;
    voiceStartTokenRef.current = startToken;
    const lifecycleToken = voiceLifecycleTokenRef.current;
    optionsRef.current.onBeforeStart();
    const recorderReady = await ensureVoiceRecorderReady({ requestPermission: true, showErrors: true });
    if (
      !recorderReady
      || !voiceRecordingRef.current
      || !canCommitVoiceOperation(startToken, lifecycleToken)
    ) {
      voiceDataEpochRef.current = null;
      markVoiceRecordingStopped();
      return;
    }
    const startedAt = Date.now();
    voiceRecordStartedAtRef.current = startedAt;
    if (mountedRef.current) {
      setVoiceStarting(false);
      setVoiceRecordStartedAt(startedAt);
    }
    clearVoiceStopTimer();
    voiceStopTimerRef.current = setTimeout(() => {
      void finishVoiceRecording();
    }, VOICE_MESSAGE_MAX_DURATION_MS + VOICE_MESSAGE_STOP_GRACE_MS);
    await waitForNextFrame();
    if (
      !voiceRecordingRef.current
      || !canCommitVoiceOperation(startToken, lifecycleToken)
    ) return;
    try {
      getVoiceRecorder().record();
      voiceRecorderPreparedRef.current = false;
      let nativeStartPromise!: Promise<boolean>;
      nativeStartPromise = startNativeSpeechRecognition('zh-CN')
        .then(async (nativeStarted) => {
          if (
            !voiceRecordingRef.current
            || !canCommitVoiceOperation(startToken, lifecycleToken)
          ) {
            if (nativeStarted) {
              return await cancelNativeSpeechRecognition();
            }
            return true;
          }
          nativeSpeechActiveRef.current = nativeStarted;
          if (mountedRef.current) setNativeSpeechActive(nativeStarted);
          return true;
        })
        .catch(() => {
          nativeSpeechActiveRef.current = false;
          if (mountedRef.current) setNativeSpeechActive(false);
          return false;
        })
        .finally(() => {
          if (nativeSpeechStartPromiseRef.current === nativeStartPromise) {
            nativeSpeechStartPromiseRef.current = null;
          }
        });
      nativeSpeechStartPromiseRef.current = nativeStartPromise;
      void nativeStartPromise;
      optionsRef.current.onError(null);
    } catch (caught) {
      void cancelNativeSpeechRecognition();
      nativeSpeechActiveRef.current = false;
      if (mountedRef.current) setNativeSpeechActive(false);
      releaseVoiceRecorder();
      await restoreChatPlaybackMode();
      voiceDataEpochRef.current = null;
      markVoiceRecordingStopped();
      if (canCommitVoiceOperation(startToken, lifecycleToken) && mountedRef.current) {
        optionsRef.current.onError(caught instanceof Error ? caught.message : '录音启动失败。');
      }
    }
  }, [
    canCommitVoiceOperation,
    clearVoiceStopTimer,
    ensureVoiceRecorderReady,
    finishVoiceRecording,
    getVoiceRecorder,
    isVoiceCaptureAllowed,
    markVoiceRecordingStopped,
    releaseVoiceRecorder,
    restoreChatPlaybackMode,
    waitForNextFrame,
  ]);

  const cancelVoiceRecording = useCallback(async (cancelOptions: { showNotice?: boolean } = {}) => {
    if (__DEV__ && process.env.EXPO_PUBLIC_JUNLUO_RUNTIME_DIAGNOSTICS === '1') {
      console.log('[voice] cancel pressed', {
        hasUri: !!voiceRecorderRef.current?.uri,
        isFinishing: voiceFinishingRef.current,
        isRecording: voiceRecordingRef.current,
        isStarting: voiceStartingRef.current,
        recordingRef: voiceRecordingRef.current,
      });
    }
    const showNotice = cancelOptions.showNotice ?? true;
    const pendingTeardown = voiceTeardownPromiseRef.current;
    if (pendingTeardown) return pendingTeardown;
    const pendingPrewarm = voiceRecorderPrewarmPromiseRef.current;
    const pendingFinish = voiceFinishPromiseRef.current;
    const pendingNativeSpeechStart = nativeSpeechStartPromiseRef.current;
    const dataEpoch = voiceDataEpochRef.current;
    const shouldCancelNativeSpeech = nativeSpeechActiveRef.current;
    const hadVoiceOperation = !!(
      voiceStartingRef.current
      || voiceRecordingRef.current
      || voiceRecordStartedAtRef.current !== null
      || voiceBusyRef.current
      || voiceFinishingRef.current
      || nativeSpeechActiveRef.current
      || nativeSpeechStartPromiseRef.current
      || voiceRecorderPreparedRef.current
      || voiceRecorderRef.current
      || pendingPrewarm
      || pendingFinish
    );
    voiceCancelRequestedRef.current = true;
    voiceStartTokenRef.current += 1;
    voiceLifecycleTokenRef.current += 1;
    voiceDataEpochRef.current = null;
    clearVoiceStopTimer();
    if (!hadVoiceOperation) return true;
    const shouldStopRecorder = !!(
      voiceRecordingRef.current
      || voiceRecordStartedAtRef.current !== null
      || voiceRecorderPreparedRef.current
      || voiceRecorderRef.current
    );
    voiceFinishingRef.current = true;
    markVoiceRecordingStopped();
    setVoiceBusyState(true);

    let teardownPromise!: Promise<boolean>;
    teardownPromise = (async () => {
      let recorderStopped = true;
      try {
        if (shouldStopRecorder) {
          recorderStopped = await stopVoiceRecorderSafely();
        }
        const recordedUri = voiceRecordedUriRef.current;
        clearVoiceRecorderUri();
        await deleteVoiceFileSafely(recordedUri, dataEpoch);
        const [
          nativeSpeechSettled,
          nativeSpeechStartSettled,
          prewarmSettled,
          finishSettled,
        ] = await Promise.all([
          waitForPendingVoiceBooleanOperation(
            shouldCancelNativeSpeech ? cancelNativeSpeechRecognition() : null,
          ),
          waitForPendingVoiceBooleanOperation(pendingNativeSpeechStart),
          waitForPendingVoiceOperation(pendingPrewarm),
          waitForPendingVoiceOperation(pendingFinish),
        ]);
        nativeSpeechActiveRef.current = false;
        if (mountedRef.current) setNativeSpeechActive(false);
        if (
          !prewarmSettled
          && voiceRecorderPrewarmPromiseRef.current === pendingPrewarm
        ) {
          voiceRecorderPrewarmPromiseRef.current = null;
        }
        if (!finishSettled && voiceFinishPromiseRef.current === pendingFinish) {
          voiceFinishPromiseRef.current = null;
        }
        const playbackModeRestored = await restoreChatPlaybackMode();
        if (showNotice && mountedRef.current && optionsRef.current.active) {
          optionsRef.current.onNotice('已取消这段语音。', 1600);
        }
        return recorderStopped
          && nativeSpeechSettled
          && nativeSpeechStartSettled
          && prewarmSettled
          && finishSettled
          && playbackModeRestored;
      } finally {
        const remainingUri = voiceRecordedUriRef.current;
        clearVoiceRecorderUri();
        await deleteVoiceFileSafely(remainingUri, dataEpoch);
        voiceFinishingRef.current = false;
        setVoiceBusyState(false);
        if (voiceTeardownPromiseRef.current === teardownPromise) {
          voiceTeardownPromiseRef.current = null;
        }
      }
    })();
    voiceTeardownPromiseRef.current = teardownPromise;
    return teardownPromise;
  }, [
    clearVoiceStopTimer,
    clearVoiceRecorderUri,
    deleteVoiceFileSafely,
    markVoiceRecordingStopped,
    restoreChatPlaybackMode,
    setVoiceBusyState,
    stopVoiceRecorderSafely,
    waitForPendingVoiceBooleanOperation,
    waitForPendingVoiceOperation,
  ]);

  const releaseVoiceAudioForCall = useCallback<ReleaseChatVoiceAudioForCall>(async () => {
    voiceAudioReleaseForCallRef.current = true;
    voiceCancelRequestedRef.current = true;
    voiceStartTokenRef.current += 1;
    voiceLifecycleTokenRef.current += 1;
    voiceDataEpochRef.current = null;
    clearVoiceStopTimer();

    return await releaseChatVoiceAudioResources({
      exitRecordingMode: exitRecordingModeForVoiceCall,
      isQuiet: () => isChatVoiceAudioQuiet({
        busy: voiceBusyRef.current,
        finishing: voiceFinishingRef.current,
        hasFinishPromise: !!voiceFinishPromiseRef.current,
        hasNativeSpeechPromise: !!nativeSpeechStartPromiseRef.current,
        hasPrewarmPromise: !!voiceRecorderPrewarmPromiseRef.current,
        hasRecorder: !!voiceRecorderRef.current,
        hasTeardownPromise: !!voiceTeardownPromiseRef.current,
        nativeSpeechActive: nativeSpeechActiveRef.current,
        recorderPrepared: voiceRecorderPreparedRef.current,
        recording: voiceRecordingRef.current,
        recordingStarted: voiceRecordStartedAtRef.current !== null,
        starting: voiceStartingRef.current,
      }),
      stageTimeoutMs: CHAT_VOICE_AUDIO_RELEASE_STAGE_TIMEOUT_MS,
      teardown: async () => await cancelVoiceRecording({ showNotice: false }),
    });
  }, [
    cancelVoiceRecording,
    clearVoiceStopTimer,
    exitRecordingModeForVoiceCall,
  ]);

  const resumeVoiceAudioAfterCall = useCallback<ResumeChatVoiceAudioAfterCall>(() => {
    voiceAudioReleaseForCallRef.current = false;
    voiceCallAudioWasActiveRef.current = false;
  }, []);

  const deactivateVoiceCapture = useCallback(() => {
    void cancelVoiceRecording({ showNotice: false });
  }, [cancelVoiceRecording]);

  useEffect(() => {
    if (options.voiceCallAudioActive) {
      voiceAudioReleaseForCallRef.current = true;
      voiceCallAudioWasActiveRef.current = true;
      return;
    }
    if (voiceCallAudioWasActiveRef.current) {
      voiceCallAudioWasActiveRef.current = false;
      voiceAudioReleaseForCallRef.current = false;
    }
  }, [options.voiceCallAudioActive]);

  useEffect(() => {
    if (!options.active || options.voiceCallAudioActive) {
      deactivateVoiceCapture();
      return;
    }
  }, [deactivateVoiceCapture, options.active, options.voiceCallAudioActive]);

  useEffect(() => {
    if (isChatVoicePrewarmDesired({
      captureAllowed: isVoiceCaptureAllowed(),
      configLoaded: options.configLoaded,
      hasDraft: options.hasDraft,
      replyBusy: options.replyBusy,
      voiceMode,
    })) return;
    if (
      voiceStartingRef.current
      || voiceRecordingRef.current
      || voiceRecordStartedAtRef.current !== null
      || voiceBusyRef.current
      || voiceFinishingRef.current
      || nativeSpeechActiveRef.current
    ) return;
    deactivateVoiceCapture();
  }, [
    deactivateVoiceCapture,
    isVoiceCaptureAllowed,
    options.configLoaded,
    options.hasDraft,
    options.replyBusy,
    voiceBusy,
    voiceMode,
  ]);

  useEffect(() => {
    appStateRef.current = AppState.currentState;
    const subscription = AppState.addEventListener('change', (nextState) => {
      appStateRef.current = nextState;
      if (nextState !== 'active') deactivateVoiceCapture();
    });
    return () => subscription.remove();
  }, [deactivateVoiceCapture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      deactivateVoiceCapture();
    };
  }, [deactivateVoiceCapture]);

  const toggleVoiceMode = useCallback(() => {
    setVoiceMode((current) => !current);
  }, []);

  const disableVoiceMode = useCallback(() => {
    setVoiceMode(false);
  }, []);

  const hasActiveVoiceCapture = useCallback(() => (
    voiceStartingRef.current
    || voiceRecordingRef.current
    || voiceRecordStartedAtRef.current !== null
  ), []);

  const hasActiveVoiceOperation = useCallback(() => (
    voiceStartingRef.current
    || voiceRecordingRef.current
    || voiceRecordStartedAtRef.current !== null
    || voiceBusyRef.current
    || nativeSpeechActiveRef.current
    || voiceFinishingRef.current
  ), []);

  const voiceRecordingVisible = voiceRecordStartedAt !== null || voiceRecordingRef.current;
  const voiceCaptureActive = voiceStarting || voiceRecordingVisible;
  const voiceCancelAvailable = voiceCaptureActive || voiceBusy;
  const voiceSendMode = voiceMode && !options.hasDraft;
  const voiceSendAvailable = voiceSendMode && voiceCaptureActive && !voiceFinishingRef.current;

  return {
    cancelVoiceRecording,
    disableVoiceMode,
    finishVoiceRecording,
    hasActiveVoiceCapture,
    hasActiveVoiceOperation,
    nativeSpeechActive,
    releaseVoiceAudioForCall,
    resumeVoiceAudioAfterCall,
    runVoiceResponderAction,
    startVoiceRecording,
    toggleVoiceMode,
    voiceBusy,
    voiceCancelAvailable,
    voiceCaptureActive,
    voiceMode,
    voiceRecordStartedAt,
    voiceRecordingVisible,
    voiceSendAvailable,
    voiceStarting,
  };
}
