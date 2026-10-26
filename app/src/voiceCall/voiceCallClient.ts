import { AndroidAudioTypePresets, AudioSession } from '@livekit/react-native';
import { requestRecordingPermissionsAsync, setAudioModeAsync } from 'expo-audio';
import { AudioPresets, ConnectionState, ParticipantEvent, Room, RoomEvent, Track } from 'livekit-client';

import {
  createVoiceCallAttempt,
  raceVoiceCallRequestWithTimeout,
  VoiceCallAttemptCancelledError,
  type VoiceCallAttempt,
  type VoiceCallAttemptOperations,
} from './voiceCallAttempt';
import { VoiceCallAudioStream } from './voiceCallAudioStream';
import { buildLiveKitUrlCandidates } from './voiceCallLiveKitUrls';
import { normalizeVoiceCallPlaybackEvent } from './voiceCallPlaybackEvent';
import {
  fetchVoiceCallToken,
  VoiceCallTokenError,
  type VoiceCallEmotionConfidenceLevel,
  type VoiceCallEmotionSignalEvent,
  type VoiceCallEmotionState,
  type VoiceCallPlaybackEvent,
  type VoiceCallPlaybackState,
  type VoiceCallSTTState,
  type VoiceCallTranscriptEvent,
  type VoiceCallTranscriptStatus,
  type VoiceCallVADStatus,
} from './voiceCallRoomClient';
import { loadVoiceCallSettings } from './voiceCallSettings';
import {
  appendVoiceCallDiagnostic,
  beginVoiceCallDiagnostic,
  bindVoiceCallDiagnostic,
  finishVoiceCallDiagnostic,
} from './voiceCallDiagnostics';

export type VoiceCallRoomStatus =
  | 'idle'
  | 'requesting-permission'
  | 'fetching-token'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'disconnecting'
  | 'failed';

export type VoiceCallRoomSnapshot = {
  audioPlaybackAllowed: boolean;
  callId?: string;
  disconnectReason?: string;
  emotion2vecEnabled: boolean;
  emotionConfidenceLevel?: VoiceCallEmotionConfidenceLevel;
  emotionLabel?: string;
  emotionLatencyMs: number;
  emotionMessage: string;
  emotionScore: number;
  emotionState: VoiceCallEmotionState | 'idle';
  error?: string;
  lastRoomEvent: string;
  livekitUrl?: string;
  localAudioLevel: number;
  localMicEnabled: boolean;
  localSpeaking: boolean;
  lastTranscript: string;
  lastTranscriptStatus?: VoiceCallTranscriptStatus;
  nativeAec?: boolean;
  nativeAgc?: boolean;
  nativeAudioSource?: string;
  nativeNoiseSuppression?: boolean;
  lastMicPeak: number;
  lastMicRms: number;
  message: string;
  micFrames: number;
  participantIdentity?: string;
  playbackId?: string;
  playbackState?: VoiceCallPlaybackState;
  remoteAudioPublished: boolean;
  remoteAudioSubscribed: boolean;
  remoteSpeaking: boolean;
  sourceTurnId?: string;
  remoteAudioSubscriptionError?: string;
  remoteParticipants: number;
  roomName?: string;
  status: VoiceCallRoomStatus;
  sttLatencyMs: number;
  sttMessage: string;
  sttState: VoiceCallSTTState | 'idle';
  uplinkMode?: 'livekit' | 'native';
  vadConfidence: number;
  vadState: string;
  vadTurns: number;
  vadVolume: number;
};

type SnapshotListener = (snapshot: VoiceCallRoomSnapshot) => void;
export type VoiceCallTurnEvent =
  | VoiceCallEmotionSignalEvent
  | VoiceCallPlaybackEvent
  | VoiceCallTranscriptEvent;
type TurnEventListener = (event: VoiceCallTurnEvent) => void;

export type PreparedVoiceCallAttempt = Readonly<{
  attemptId: number;
  cancel: () => void;
  operations: VoiceCallAttemptOperations;
}>;

type RemoteAudioVolumeTrack = {
  kind?: unknown;
  setVolume: (volume: number) => void;
  sid?: string;
};

type ActiveVoiceCallAttempt = {
  attemptId: number;
  audioStream: VoiceCallAudioStream;
  prepared: PreparedVoiceCallAttempt;
  playbackEventStates: Map<string, VoiceCallPlaybackState>;
  playbackRequestAt: Map<string, number>;
  remoteAudioTracks: Map<string, RemoteAudioVolumeTrack>;
  runtime: VoiceCallAttempt<Room>;
};

const REMOTE_AUDIO_READY_MESSAGE = 'junluo.voice-call.remote-audio-ready.v1';
export const VOICE_CALL_PLAYBACK_TOPIC = 'junluo.voice-call.playback.v1';
const REMOTE_AUDIO_READY_PAYLOAD = Uint8Array.from(
  Array.from(REMOTE_AUDIO_READY_MESSAGE, (character) => character.charCodeAt(0)),
);

const microphoneCaptureOptions = {
  autoGainControl: true,
  channelCount: 1,
  echoCancellation: true,
  noiseSuppression: true,
  sampleRate: 48000,
  voiceIsolation: false,
};
const microphonePublishOptions = {
  audioPreset: AudioPresets.speech,
  dtx: false,
  forceStereo: false,
  red: false,
};
const VOICE_CALL_TOKEN_REQUEST_TIMEOUT_MS = 10_000;

const idleSnapshot: VoiceCallRoomSnapshot = {
  audioPlaybackAllowed: true,
  emotion2vecEnabled: false,
  emotionLatencyMs: 0,
  emotionMessage: '本地声音情绪识别还没有连接。',
  emotionScore: 0,
  emotionState: 'idle',
  lastRoomEvent: 'idle',
  localAudioLevel: 0,
  localMicEnabled: false,
  localSpeaking: false,
  lastTranscript: '',
  lastMicPeak: 0,
  lastMicRms: 0,
  message: '电话线还没有接通。',
  micFrames: 0,
  remoteAudioPublished: false,
  remoteAudioSubscribed: false,
  remoteParticipants: 0,
  remoteSpeaking: false,
  status: 'idle',
  sttLatencyMs: 0,
  sttMessage: '本地语音识别还没有连接。',
  sttState: 'idle',
  vadConfidence: 0,
  vadState: 'idle',
  vadTurns: 0,
  vadVolume: 0,
};

function connectionStateToStatus(state: ConnectionState): VoiceCallRoomStatus {
  if (state === ConnectionState.Connected) return 'connected';
  if (state === ConnectionState.Reconnecting) return 'reconnecting';
  if (state === ConnectionState.Disconnected) return 'idle';
  return 'connecting';
}

function messageForStatus(status: VoiceCallRoomStatus) {
  switch (status) {
    case 'requesting-permission':
      return '正在准备麦克风。';
    case 'fetching-token':
      return '正在向后端请求电话线。';
    case 'connecting':
      return '电话线正在接通。';
    case 'connected':
      return '电话线已接通。';
    case 'reconnecting':
      return '电话线正在重连。';
    case 'disconnecting':
      return '正在挂断电话线。';
    case 'failed':
      return '电话线没有接上。';
    case 'idle':
    default:
      return '电话线还没有接通。';
  }
}

function hasAudioKind(track: unknown) {
  return typeof track === 'object'
    && track !== null
    && (track as { kind?: unknown }).kind === Track.Kind.Audio;
}

function isRemoteAudioTrack(track: unknown): track is RemoteAudioVolumeTrack {
  return hasAudioKind(track)
    && typeof (track as { setVolume?: unknown }).setVolume === 'function';
}

export function parseVoiceCallPlaybackEvent({
  callId,
  participantIdentity,
  payload,
  topic,
}: {
  callId: string;
  participantIdentity?: string;
  payload: Uint8Array;
  topic?: string;
}): VoiceCallPlaybackEvent | null {
  if (
    topic !== VOICE_CALL_PLAYBACK_TOPIC
    || participantIdentity !== `baiyun-agent-${callId}`
  ) return null;
  try {
    return normalizeVoiceCallPlaybackEvent(JSON.parse(
      Array.from(payload, (byte) => String.fromCharCode(byte)).join(''),
    ), callId);
  } catch {
    return null;
  }
}

export function describeVoiceCallAttemptError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (/signal connection|Network request failed/i.test(message)) {
    return '电话线没接上：手机连不上 LiveKit。请确认后端管理室里的电话线已启动，手机和电脑在同一网络。';
  }
  return message || '电话线连接失败。';
}

async function restoreExpoAudioMode() {
  await setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: 'doNotMix',
    playsInSilentMode: true,
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
  });
}

export class VoiceCallRoomBridge {
  private activeAttempt: ActiveVoiceCallAttempt | null = null;
  private attemptId = 0;
  private listener?: SnapshotListener;
  private pendingPrepareAbortController: AbortController | null = null;
  private snapshot: VoiceCallRoomSnapshot = idleSnapshot;
  private readonly turnEventListeners = new Set<TurnEventListener>();

  getSnapshot() {
    return this.snapshot;
  }

  subscribeTurnEvents(listener: TurnEventListener) {
    this.turnEventListeners.add(listener);
    return () => {
      this.turnEventListeners.delete(listener);
    };
  }

  private emitTurnEvent(event: VoiceCallTurnEvent) {
    this.turnEventListeners.forEach((listener) => listener(event));
  }

  sendDiagnostic(
    event: string,
    details: Record<string, boolean | number | string | null | undefined> = {},
  ) {
    if (this.activeAttempt) this.activeAttempt.audioStream.sendDiagnostic(event, details);
    else appendVoiceCallDiagnostic(event, details);
  }

  private updateSnapshot(patch: Partial<VoiceCallRoomSnapshot>) {
    const activeAttempt = this.activeAttempt;
    const room = activeAttempt?.runtime.getCurrentRoom() ?? null;
    const status = patch.status ?? this.snapshot.status;
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      localAudioLevel: patch.localAudioLevel ?? this.snapshot.localAudioLevel,
      localMicEnabled: patch.localMicEnabled ?? this.snapshot.localMicEnabled,
      localSpeaking: patch.localSpeaking ?? this.snapshot.localSpeaking,
      message: patch.message ?? messageForStatus(status),
      remoteAudioSubscribed:
        patch.remoteAudioSubscribed ?? (activeAttempt?.remoteAudioTracks.size ?? 0) > 0,
      remoteParticipants:
        patch.remoteParticipants ?? room?.remoteParticipants.size ?? this.snapshot.remoteParticipants,
      status,
    };
  }

  private emit(patch: Partial<VoiceCallRoomSnapshot>) {
    const before = this.snapshot;
    this.updateSnapshot(patch);
    if (before.status !== this.snapshot.status || before.localMicEnabled !== this.snapshot.localMicEnabled
        || before.remoteAudioSubscribed !== this.snapshot.remoteAudioSubscribed
        || before.vadState !== this.snapshot.vadState || before.vadTurns !== this.snapshot.vadTurns
        || before.sttState !== this.snapshot.sttState || before.emotionState !== this.snapshot.emotionState) {
      appendVoiceCallDiagnostic('room_snapshot', {
        state: this.snapshot.status,
        localMicEnabled: this.snapshot.localMicEnabled,
        turns: this.snapshot.vadTurns,
        roomStatus: this.snapshot.status,
      });
    }
    this.listener?.(this.snapshot);
  }

  private isActive(attempt: ActiveVoiceCallAttempt) {
    return this.activeAttempt === attempt
      && this.attemptId === attempt.attemptId
      && !attempt.runtime.isCancelled();
  }

  private isCurrentRoom(attempt: ActiveVoiceCallAttempt, room: Room) {
    return this.isActive(attempt) && attempt.runtime.getCurrentRoom() === room;
  }

  private emitForAttempt(attempt: ActiveVoiceCallAttempt, patch: Partial<VoiceCallRoomSnapshot>) {
    if (this.isActive(attempt)) this.emit(patch);
  }

  private refreshForAttempt(attempt: ActiveVoiceCallAttempt, patch: Partial<VoiceCallRoomSnapshot>) {
    if (this.isActive(attempt)) this.updateSnapshot(patch);
  }

  private setRemoteAudioVolume(attempt: ActiveVoiceCallAttempt, volume: number) {
    if (!this.isActive(attempt)) return;
    attempt.remoteAudioTracks.forEach((track) => {
      try {
        track.setVolume(volume);
      } catch {
        // A disappearing LiveKit track must not block interruption or hangup.
      }
    });
  }

  private sendRemoteAudioReady(
    attempt: ActiveVoiceCallAttempt,
    reason: 'playback_started' | 'track_subscribed',
    destinationIdentity?: string,
    trackSid?: string,
  ) {
    if (!this.isActive(attempt)) return;
    const room = attempt.runtime.getCurrentRoom();
    if (!room || room.state === ConnectionState.Disconnected) return;
    const options = {
      ...(destinationIdentity ? { destinationIdentities: [destinationIdentity] } : {}),
      reliable: true,
      topic: 'junluo.voice-call.control',
    };
    void room.localParticipant.publishData(REMOTE_AUDIO_READY_PAYLOAD, options).then(() => {
      attempt.audioStream.sendDiagnostic('remote_audio_ready_sent', {
        identity: destinationIdentity,
        reason,
        trackSid,
      });
    }).catch((caught) => {
      attempt.audioStream.sendDiagnostic('remote_audio_ready_send_failed', {
        error: caught instanceof Error ? caught.message : String(caught),
        identity: destinationIdentity,
        reason,
        trackSid,
      });
    });
  }

  private handlePlaybackEvent(
    attempt: ActiveVoiceCallAttempt,
    event: VoiceCallPlaybackEvent,
  ) {
    if (!this.isActive(attempt) || event.callId !== this.snapshot.callId) return;
    const previousState = attempt.playbackEventStates.get(event.playbackId);
    if (previousState === event.state) return;
    if (
      previousState === 'completed'
      || previousState === 'failed'
      || previousState === 'interrupted'
    ) return;
    attempt.playbackEventStates.set(event.playbackId, event.state);
    const requestAt = attempt.playbackRequestAt.get(event.playbackId);
    if (event.state !== 'started') attempt.playbackRequestAt.delete(event.playbackId);
    if (event.state === 'started') {
      this.setRemoteAudioVolume(attempt, this.snapshot.localSpeaking ? 0 : 1);
      this.sendRemoteAudioReady(attempt, 'playback_started');
      setTimeout(() => {
        this.sendRemoteAudioReady(attempt, 'playback_started');
      }, 300);
    } else if (event.state === 'interrupted') {
      this.setRemoteAudioVolume(attempt, 0);
    }
    attempt.audioStream.sendDiagnostic('playback_' + event.state, {
      playbackId: event.playbackId,
      reason: event.reason,
      sourceTurnId: event.sourceTurnId,
      ...(event.state === 'started' && requestAt ? { latencyMs: Date.now() - requestAt } : {}),
    });
    this.emitTurnEvent(event);
    this.emitForAttempt(attempt, {
      playbackId: event.playbackId,
      playbackState: event.state,
      remoteSpeaking: event.state === 'started' && !this.snapshot.localSpeaking,
      sourceTurnId: event.sourceTurnId,
    });
  }

  registerQueuedPlayback({
    callId,
    playbackId,
    requestStartedAt,
    sourceTurnId,
  }: {
    callId: string;
    playbackId: string;
    requestStartedAt?: number;
    sourceTurnId?: string;
  }) {
    if (!this.activeAttempt || this.snapshot.callId !== callId) return false;
    if (
      this.snapshot.playbackId === playbackId
      && this.snapshot.playbackState
      && this.snapshot.playbackState !== 'queued'
    ) return true;
    this.activeAttempt.playbackEventStates.set(playbackId, 'queued');
    if (requestStartedAt) this.activeAttempt.playbackRequestAt.set(playbackId, requestStartedAt);
    this.activeAttempt.audioStream.sendDiagnostic('playback_queued', { playbackId, sourceTurnId });
    this.emit({
      playbackId,
      playbackState: 'queued',
      remoteSpeaking: false,
      sourceTurnId,
    });
    return true;
  }

  private shouldPublishVadStatus(status: VoiceCallVADStatus) {
    return this.snapshot.localSpeaking !== status.active
      || this.snapshot.vadState !== status.state
      || this.snapshot.vadTurns !== status.turns
      || (this.snapshot.micFrames === 0 && (status.micFrames ?? 0) > 0);
  }

  private attachRoomEvents(attempt: ActiveVoiceCallAttempt, room: Room) {
    const recordRoomEvent = (
      event: string,
      details: Record<string, boolean | number | string | null | undefined> = {},
    ) => {
      console.info('[VoiceCall] ' + event, details);
      attempt.audioStream.sendDiagnostic(event, details);
    };
    const refreshConnected = (status?: VoiceCallRoomStatus) => {
      if (!this.isCurrentRoom(attempt, room)) return;
      this.emit({ status: status ?? connectionStateToStatus(room.state) });
    };
    const refreshLocalAudioLevel = () => {
      if (!this.isCurrentRoom(attempt, room)) return;
      const local = room.localParticipant;
      this.emit({
        localAudioLevel: local.audioLevel ?? 0,
        status: connectionStateToStatus(room.state),
      });
    };

    room
      .on(RoomEvent.ConnectionStateChanged, (state) => {
        recordRoomEvent('room_connection_state', { state });
        if (state !== ConnectionState.Disconnected) refreshConnected(connectionStateToStatus(state));
      })
      .on(RoomEvent.SignalReconnecting, () => {
        recordRoomEvent('room_signal_reconnecting');
      })
      .on(RoomEvent.Reconnecting, () => {
        recordRoomEvent('room_reconnecting');
        refreshConnected('reconnecting');
      })
      .on(RoomEvent.Reconnected, () => {
        recordRoomEvent('room_reconnected');
        refreshConnected('connected');
      })
      .on(RoomEvent.Disconnected, (reason) => {
        if (!this.isCurrentRoom(attempt, room)) return;
        const disconnectReason = reason === undefined ? 'unknown' : String(reason);
        recordRoomEvent('room_disconnected', { reason: disconnectReason });
        attempt.remoteAudioTracks.clear();
        const message = '电话线意外断开（LiveKit 原因 ' + disconnectReason + '）。';
        this.emit({
          audioPlaybackAllowed: room.canPlaybackAudio,
          disconnectReason,
          error: message,
          lastRoomEvent: 'room_disconnected',
          localAudioLevel: 0,
          localMicEnabled: false,
          localSpeaking: false,
          lastMicPeak: 0,
          lastMicRms: 0,
          micFrames: 0,
          playbackId: undefined,
          playbackState: undefined,
          remoteAudioPublished: false,
          remoteAudioSubscribed: false,
          remoteSpeaking: false,
          sourceTurnId: undefined,
          status: 'failed',
        });
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        recordRoomEvent('remote_participant_connected', { identity: participant.identity });
        this.emitForAttempt(attempt, { lastRoomEvent: 'remote_participant_connected' });
        refreshConnected();
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        recordRoomEvent('remote_participant_disconnected', { identity: participant.identity });
        this.emitForAttempt(attempt, { lastRoomEvent: 'remote_participant_disconnected' });
        refreshConnected();
      })
      .on(RoomEvent.DataReceived, (payload, participant, _kind, topic) => {
        if (!this.isCurrentRoom(attempt, room)) return;
        const event = parseVoiceCallPlaybackEvent({
          callId: this.snapshot.callId ?? '',
          participantIdentity: participant?.identity,
          payload,
          topic,
        });
        if (!event) return;
        this.handlePlaybackEvent(attempt, event);
      })
      .on(RoomEvent.TrackPublished, (publication, participant) => {
        if (!this.isCurrentRoom(attempt, room) || !hasAudioKind(publication)) return;
        recordRoomEvent('remote_audio_published', {
          identity: participant.identity,
          trackSid: publication.trackSid,
        });
        this.emit({
          lastRoomEvent: 'remote_audio_published',
          remoteAudioPublished: true,
          remoteAudioSubscriptionError: undefined,
          status: 'connected',
        });
      })
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        if (!this.isCurrentRoom(attempt, room)) return;
        if (isRemoteAudioTrack(track)) {
          const trackSid = track.sid ?? publication.trackSid;
          attempt.remoteAudioTracks.set(trackSid, track);
          if (
            this.snapshot.localSpeaking
            || this.snapshot.playbackState === 'interrupted'
          ) track.setVolume(0);
          recordRoomEvent('remote_audio_subscribed', {
            audioPlaybackAllowed: room.canPlaybackAudio,
            identity: participant.identity,
            trackSid: publication.trackSid,
          });
          this.emit({
            audioPlaybackAllowed: room.canPlaybackAudio,
            lastRoomEvent: 'remote_audio_subscribed',
            remoteAudioPublished: true,
            remoteAudioSubscriptionError: undefined,
          });
          this.sendRemoteAudioReady(
            attempt,
            'track_subscribed',
            participant.identity,
            publication.trackSid,
          );
        }
        refreshConnected('connected');
      })
      .on(RoomEvent.TrackSubscriptionFailed, (trackSid, participant, reason) => {
        if (!this.isCurrentRoom(attempt, room)) return;
        const subscriptionError = reason === undefined ? 'unknown' : String(reason);
        recordRoomEvent('remote_audio_subscription_failed', {
          identity: participant.identity,
          reason: subscriptionError,
          trackSid,
        });
        this.emit({
          lastRoomEvent: 'remote_audio_subscription_failed',
          remoteAudioPublished: true,
          remoteAudioSubscriptionError: subscriptionError,
        });
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        if (!this.isCurrentRoom(attempt, room)) return;
        if (isRemoteAudioTrack(track)) {
          attempt.remoteAudioTracks.delete(track.sid ?? publication.trackSid);
          recordRoomEvent('remote_audio_unsubscribed', {
            identity: participant.identity,
            trackSid: publication.trackSid,
          });
          this.emit({ lastRoomEvent: 'remote_audio_unsubscribed' });
        }
        refreshConnected('connected');
      })
      .on(RoomEvent.AudioPlaybackStatusChanged, (playing) => {
        recordRoomEvent('audio_playback_status', { playing });
        this.emitForAttempt(attempt, {
          audioPlaybackAllowed: playing,
          lastRoomEvent: 'audio_playback_status',
        });
      })
      .on(RoomEvent.LocalTrackPublished, () => refreshConnected())
      .on(RoomEvent.LocalTrackUnpublished, () => refreshConnected())
      .on(RoomEvent.ActiveSpeakersChanged, () => refreshLocalAudioLevel());

    room.localParticipant.on(ParticipantEvent.IsSpeakingChanged, () => refreshLocalAudioLevel());
  }

  async prepareAttempt(
    listener: SnapshotListener,
    callId?: string,
    direction: 'incoming' | 'outgoing' | 'test' = 'test',
  ): Promise<PreparedVoiceCallAttempt> {
    if (this.activeAttempt) throw new Error('Voice call audio is already active');
    this.pendingPrepareAbortController?.abort();
    const abortController = new AbortController();
    this.pendingPrepareAbortController = abortController;
    const attemptId = this.attemptId + 1;
    this.attemptId = attemptId;
    this.listener = listener;
    this.snapshot = { ...idleSnapshot };
    beginVoiceCallDiagnostic(direction, callId);
    this.emit({ status: 'requesting-permission' });

    try {
      const permissionStartedAt = Date.now();
      let permission: Awaited<ReturnType<typeof requestRecordingPermissionsAsync>>;
      try {
        permission = await requestRecordingPermissionsAsync();
      } catch (caught) {
        appendVoiceCallDiagnostic('microphone_permission_failed', { latencyMs: Date.now() - permissionStartedAt, errorCode: 'permission_request_failed' });
        finishVoiceCallDiagnostic('permission_denied', 'permission_request_failed');
        throw caught;
      }
      if (attemptId !== this.attemptId) throw new VoiceCallAttemptCancelledError();
      appendVoiceCallDiagnostic('microphone_permission_result', {
        status: permission.granted ? 'granted' : 'denied',
        latencyMs: Date.now() - permissionStartedAt,
      });
      if (!permission.granted) {
        const error = new Error('需要麦克风权限才能接进语音通话。');
        this.emit({ error: error.message, status: 'failed' });
        finishVoiceCallDiagnostic('permission_denied', 'microphone_permission_denied');
        throw error;
      }

      this.emit({ status: 'fetching-token' });
      const { settings: voiceCallSettings } = await loadVoiceCallSettings();
      const tokenStartedAt = Date.now();
      let tokenResult: Awaited<ReturnType<typeof fetchVoiceCallToken>>;
      try {
        tokenResult = await raceVoiceCallRequestWithTimeout(
          fetchVoiceCallToken(
            {
              callId,
              direction,
              emotion2vecEnabled: voiceCallSettings.emotion2vecEnabled,
              uplinkMode: voiceCallSettings.uplinkMode,
            },
            abortController.signal,
          ),
          {
            abort: () => abortController.abort(),
            timeoutError: new VoiceCallTokenError('电话线请求超时。'),
            timeoutMs: VOICE_CALL_TOKEN_REQUEST_TIMEOUT_MS,
          },
        );
      } catch (caught) {
        if (attemptId !== this.attemptId) throw new VoiceCallAttemptCancelledError();
        appendVoiceCallDiagnostic('backend_token_failed', { latencyMs: Date.now() - tokenStartedAt,
          errorCode: caught instanceof VoiceCallTokenError ? caught.code ?? `http_${caught.status ?? 0}` : 'backend_unreachable' });
        const message = caught instanceof VoiceCallTokenError ? caught.message : '电话线请求失败。';
        this.emit({ error: message, message, status: 'failed' });
        finishVoiceCallDiagnostic('token_failed', caught instanceof VoiceCallTokenError
          ? caught.code ?? `http_${caught.status ?? 0}` : 'backend_unreachable');
        throw caught;
      }
      if (attemptId !== this.attemptId) throw new VoiceCallAttemptCancelledError();

      bindVoiceCallDiagnostic(tokenResult.data.callId);
      appendVoiceCallDiagnostic('backend_token_received', { latencyMs: Date.now() - tokenStartedAt });

      return this.createPreparedAttempt(attemptId, tokenResult.data, tokenResult.baseUrl);
    } finally {
      if (this.pendingPrepareAbortController === abortController) {
        this.pendingPrepareAbortController = null;
      }
    }
  }

  private createPreparedAttempt(
    attemptId: number,
    token: Awaited<ReturnType<typeof fetchVoiceCallToken>>['data'],
    backendBaseUrl: string,
  ) {
    const livekitUrls = buildLiveKitUrlCandidates(token.livekitUrl, backendBaseUrl);
    let attempt!: ActiveVoiceCallAttempt;
    const audioStream = new VoiceCallAudioStream({
      backendBaseUrl,
      callId: token.callId,
      emotion2vecEnabled: token.emotion2vecEnabled,
      onError: (message, code) => {
        const nativeStreamClosed = code === 'NATIVE_AUDIO_STREAM_CLOSED';
        this.emitForAttempt(attempt, {
          error: message,
          message,
          ...(nativeStreamClosed ? {
            status: 'failed' as const,
            localAudioLevel: 0,
            localMicEnabled: false,
            localSpeaking: false,
            lastMicPeak: 0,
            lastMicRms: 0,
            micFrames: 0,
          } : {}),
        });
        if (nativeStreamClosed) attempt.runtime.cancel();
      },
      onEmotionStatus: (status) => {
        this.emitForAttempt(attempt, {
          emotionMessage: status.message,
          emotionState: status.state,
        });
      },
      onEmotionSignal: (event) => {
        if (event.callId !== token.callId) return;
        audioStream.sendDiagnostic('emotion_received', {
          turnId: event.turnId, status: event.status, label: event.label,
          score: event.score, latencyMs: event.latencyMs, durationMs: event.durationMs,
          errorCode: event.errorCode ?? undefined,
        });
        this.emitTurnEvent(event);
        this.emitForAttempt(attempt, {
          emotionConfidenceLevel: event.confidenceLevel,
          emotionLabel: event.label,
          emotionLatencyMs: event.latencyMs,
          emotionMessage:
            event.status === 'failed'
              ? '这句话的声音情绪线索没有完成。'
              : event.status === 'uncertain'
                ? '这句话没有可靠的声音情绪倾向。'
                : '这句话的声音情绪线索已经收到。',
          emotionScore: event.score,
        });
      },
      onPlaybackEvent: (event) => {
        this.handlePlaybackEvent(attempt, event);
      },
      onVad: (status) => {
        const startedSpeaking = status.active && !this.snapshot.localSpeaking;
        const playbackCanBeInterrupted =
          this.snapshot.playbackState === 'queued'
          || this.snapshot.playbackState === 'started';
        if (startedSpeaking && playbackCanBeInterrupted) {
          this.setRemoteAudioVolume(attempt, 0);
          audioStream.sendDiagnostic('interruption_local_mute', {
            playbackId: this.snapshot.playbackId,
            sourceTurnId: this.snapshot.sourceTurnId,
          });
        }
        const patch: Partial<VoiceCallRoomSnapshot> = {
          lastMicPeak: status.lastPeak ?? 0,
          lastMicRms: status.lastRms ?? 0,
          localSpeaking: status.active,
          micFrames: status.micFrames ?? 0,
          ...(startedSpeaking && playbackCanBeInterrupted ? { remoteSpeaking: false } : {}),
          vadConfidence: status.lastConfidence ?? 0,
          vadState: status.state,
          vadTurns: status.turns,
          vadVolume: status.lastVadVolume ?? 0,
        };
        if (this.shouldPublishVadStatus(status)) {
          this.emitForAttempt(attempt, patch);
        } else {
          this.refreshForAttempt(attempt, patch);
        }
      },
      onSttStatus: (status) => {
        this.emitForAttempt(attempt, {
          sttMessage: status.message,
          sttState: status.state,
          ...(status.state === 'transcribing'
            ? { lastTranscript: '', lastTranscriptStatus: undefined, sttLatencyMs: 0 }
            : {}),
        });
      },
      onTranscript: (event) => {
        if (event.callId !== token.callId || !event.isFinal) return;
        audioStream.sendDiagnostic('stt_received', {
          turnId: event.turnId, status: event.status, provider: event.provider,
          latencyMs: event.latencyMs, durationMs: event.durationMs,
          fallback: event.fallback, errorCode: event.errorCode ?? undefined,
        });
        this.emitTurnEvent(event);
        this.emitForAttempt(attempt, {
          lastTranscript: event.text,
          lastTranscriptStatus: event.status,
          sttLatencyMs: event.latencyMs,
          sttMessage:
            event.status === 'ok'
              ? '这句话已经识别完成。'
              : event.status === 'not_heard'
                ? '这句没有识别出文字。'
                : '本地语音识别这次没有完成。',
        });
      },
      sessionTicket: token.sessionTicket,
      uplinkMode: token.uplinkMode,
    });
    const runtime = createVoiceCallAttempt<Room>(livekitUrls, {
      configureAudio: async () => {
        await AudioSession.configureAudio({
          android: {
            audioTypeOptions: AndroidAudioTypePresets.communication,
            preferredOutputList: ['bluetooth', 'headset', 'speaker', 'earpiece'],
          },
          ios: { defaultOutput: 'speaker' },
        });
      },
      startAudioSession: async () => {
        await AudioSession.startAudioSession();
      },
      createRoom: () => new Room({
        adaptiveStream: false,
        dynacast: false,
        publishDefaults: microphonePublishOptions,
      }),
      connectRoom: async (room, livekitUrl) => {
        const connectStartedAt = Date.now();
        try {
          await room.connect(livekitUrl, token.token, {
            autoSubscribe: true,
            maxRetries: 0,
            peerConnectionTimeout: 8_000,
            websocketTimeout: 4_000,
          });
        } catch (caught) {
          audioStream.sendDiagnostic('room_connect_failed', { latencyMs: Date.now() - connectStartedAt, errorCode: 'room_connect_failed' });
          throw caught;
        }
        audioStream.sendDiagnostic('room_connect_resolved', {
          audioPlaybackAllowed: room.canPlaybackAudio,
          latencyMs: Date.now() - connectStartedAt,
          livekitUrl,
          roomState: room.state,
        });
      },
      enableMicrophone: async (room) => {
        await audioStream.connect();
        if (token.uplinkMode === 'native') {
          const info = await audioStream.startNativeMicrophone();
          if (info) {
            audioStream.sendDiagnostic('native_microphone_started', {
              aec: info.aec,
              agc: info.agc,
              channels: info.channels,
              frameBytes: info.frameBytes,
              noiseSuppression: info.noiseSuppression,
              sampleRate: info.sampleRate,
              source: info.source,
              transport: info.transport,
            });
            this.emitForAttempt(attempt, {
              nativeAec: info.aec,
              nativeAgc: info.agc,
              nativeAudioSource: info.source,
              nativeNoiseSuppression: info.noiseSuppression,
            });
          }
        } else {
          await room.localParticipant.setMicrophoneEnabled(
            true,
            microphoneCaptureOptions,
            microphonePublishOptions,
          );
        }
      },
      disableMicrophone: async (room) => {
        if (token.uplinkMode === 'livekit' && room.localParticipant.isMicrophoneEnabled) {
          await room.localParticipant.setMicrophoneEnabled(false);
        }
        await audioStream.stop();
      },
      disconnectRoom: async (room) => {
        if (room.state === ConnectionState.Disconnected) return;
        await room.disconnect();
      },
      stopAudioSession: async () => {
        await AudioSession.stopAudioSession();
      },
      restoreAudioMode: restoreExpoAudioMode,
    }, {
      onRoomSelected: (room, livekitUrl) => {
        if (!this.isActive(attempt)) return;
        attempt.remoteAudioTracks.clear();
        this.attachRoomEvents(attempt, room);
        this.emit({
          callId: token.callId,
          emotion2vecEnabled: token.emotion2vecEnabled,
          emotionConfidenceLevel: undefined,
          emotionLabel: undefined,
          emotionLatencyMs: 0,
          emotionMessage: token.emotion2vecEnabled
            ? '正在连接本地声音情绪识别。'
            : '本次通话没有开启声音情绪识别。',
          emotionScore: 0,
          emotionState: token.emotion2vecEnabled ? 'loading' : 'disabled',
          livekitUrl,
          participantIdentity: token.participantIdentity,
          playbackId: undefined,
          playbackState: undefined,
          remoteAudioSubscribed: false,
          remoteSpeaking: false,
          sourceTurnId: undefined,
          remoteParticipants: 0,
          roomName: token.roomName,
          status: 'connecting',
          lastTranscript: '',
          lastTranscriptStatus: undefined,
          sttLatencyMs: 0,
          sttMessage: '正在连接本地语音识别。',
          sttState: 'loading',
          uplinkMode: token.uplinkMode,
          vadConfidence: 0,
          vadState: 'listening',
          vadTurns: 0,
          vadVolume: 0,
        });
        audioStream.sendDiagnostic('room_candidate_selected', {
          livekitUrl,
          uplinkMode: token.uplinkMode,
        });
      },
    });

    const operations: VoiceCallAttemptOperations = {
      configureAudio: runtime.operations.configureAudio,
      startAudioSession: runtime.operations.startAudioSession,
      connectRoom: runtime.operations.connectRoom,
      enableMicrophone: async () => {
        await runtime.operations.enableMicrophone();
        const room = runtime.getCurrentRoom();
        if (!room || room.state === ConnectionState.Disconnected) {
          throw new Error('电话线在开启麦克风时已经断开。');
        }
        this.emitForAttempt(attempt, {
          localAudioLevel: room.localParticipant.audioLevel ?? 0,
          localMicEnabled: true,
          localSpeaking: false,
          status: connectionStateToStatus(room.state),
          uplinkMode: token.uplinkMode,
        });
      },
      disableMicrophone: async () => {
        await runtime.operations.disableMicrophone();
        this.emitForAttempt(attempt, {
          localAudioLevel: 0,
          localMicEnabled: false,
          localSpeaking: false,
          lastMicPeak: 0,
          lastMicRms: 0,
          micFrames: 0,
        });
      },
      disconnectRoom: async () => {
        this.emitForAttempt(attempt, { status: 'disconnecting' });
        await runtime.operations.disconnectRoom();
      },
      stopAudioSession: runtime.operations.stopAudioSession,
      restoreAudioMode: runtime.operations.restoreAudioMode,
    };
    const prepared: PreparedVoiceCallAttempt = Object.freeze({
      attemptId,
      cancel: runtime.cancel,
      operations: Object.freeze(operations),
    });
    attempt = {
      attemptId,
      audioStream,
      prepared,
      playbackEventStates: new Map<string, VoiceCallPlaybackState>(),
      playbackRequestAt: new Map<string, number>(),
      remoteAudioTracks: new Map<string, RemoteAudioVolumeTrack>(),
      runtime,
    };
    this.activeAttempt = attempt;
    return prepared;
  }

  finalizeAttempt(
    prepared: PreparedVoiceCallAttempt,
    options: { error?: string; keepListener?: boolean } = {},
  ) {
    const activeAttempt = this.activeAttempt;
    if (!activeAttempt || activeAttempt.prepared !== prepared) return false;
    activeAttempt.runtime.cancel();
    this.attemptId += 1;
    this.activeAttempt = null;
    this.snapshot = options.error
      ? {
        ...idleSnapshot,
        error: options.error,
        message: options.error,
        status: 'failed',
      }
      : { ...idleSnapshot };
    if (options.keepListener) {
      this.listener?.(this.snapshot);
    } else {
      this.listener = undefined;
    }
    return true;
  }

  async connect(listener: SnapshotListener, callId?: string) {
    await this.disconnect();
    let prepared: PreparedVoiceCallAttempt;
    try {
      prepared = await this.prepareAttempt(listener, callId);
    } catch (caught) {
      if (caught instanceof VoiceCallAttemptCancelledError) return;
      return;
    }

    try {
      await prepared.operations.configureAudio();
      await prepared.operations.startAudioSession();
      await prepared.operations.connectRoom();
      await prepared.operations.enableMicrophone();
    } catch (caught) {
      const activeAttempt = this.activeAttempt;
      if (
        caught instanceof VoiceCallAttemptCancelledError
        || !activeAttempt
        || activeAttempt.prepared !== prepared
        || activeAttempt.runtime.isCancelled()
        || this.attemptId !== activeAttempt.attemptId
      ) return;
      const message = describeVoiceCallAttemptError(caught);
      await this.disconnect({ error: message, keepListener: true, nextStatus: 'failed' });
    }
  }

  private async cleanUpAttempt(prepared: PreparedVoiceCallAttempt) {
    prepared.cancel();
    const errors: unknown[] = [];
    for (const operation of [
      prepared.operations.disableMicrophone,
      prepared.operations.disconnectRoom,
      prepared.operations.stopAudioSession,
      prepared.operations.restoreAudioMode,
    ]) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  async disconnect(options: { error?: string; keepListener?: boolean; nextStatus?: VoiceCallRoomStatus } = {}) {
    const attempt = this.activeAttempt;
    if (attempt && this.isActive(attempt)) this.emit({ status: 'disconnecting' });
    this.attemptId += 1;
    this.pendingPrepareAbortController?.abort();
    this.pendingPrepareAbortController = null;
    attempt?.runtime.cancel();

    const cleanupErrors = attempt ? await this.cleanUpAttempt(attempt.prepared) : [];
    if (this.activeAttempt !== attempt) return;
    this.activeAttempt = null;

    const cleanupErrorMessage = cleanupErrors.length > 0
      ? '电话线已结束，但音频资源没有完全释放。'
      : undefined;
    const error = options.error
      ? cleanupErrorMessage
        ? `${options.error} ${cleanupErrorMessage}`
        : options.error
      : cleanupErrorMessage;
    const nextStatus = options.nextStatus ?? (cleanupErrors.length > 0 ? 'failed' : 'idle');
    finishVoiceCallDiagnostic(nextStatus === 'failed' ? 'connection_failed' : 'call_closed',
      cleanupErrors.length ? 'audio_release_failed' : undefined);
    this.snapshot = {
      ...idleSnapshot,
      error,
      status: nextStatus,
      message: nextStatus === 'failed' && cleanupErrorMessage
        ? cleanupErrorMessage
        : messageForStatus(nextStatus),
    };
    if (options.keepListener) {
      this.listener?.(this.snapshot);
    } else {
      this.listener = undefined;
    }
  }
}

export const voiceCallRoomBridge = new VoiceCallRoomBridge();
