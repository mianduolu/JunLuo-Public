import type { EmitterSubscription } from 'react-native';

import {
  sendNativeVoiceAudioText,
  startNativeVoiceAudio,
  stopNativeVoiceAudio,
  type NativeVoiceAudioStartResult,
} from './nativeVoiceCallAudio';
import type {
  VoiceCallEmotionSignalEvent,
  VoiceCallEmotionStatus,
  VoiceCallPlaybackEvent,
  VoiceCallSTTStatus,
  VoiceCallTranscriptEvent,
  VoiceCallUplinkMode,
  VoiceCallVADStatus,
} from './voiceCallRoomClient';
import { normalizeVoiceCallPlaybackEvent } from './voiceCallPlaybackEvent';
import { appendVoiceCallDiagnostic, filterVoiceCallDiagnosticDetails } from './voiceCallDiagnostics';
import { VoiceCallAttemptCancelledError } from './voiceCallAttempt';


type VoiceCallAudioStreamOptions = {
  backendBaseUrl: string;
  callId: string;
  onError: (message: string, code?: string) => void;
  onEmotionSignal: (event: VoiceCallEmotionSignalEvent) => void;
  onEmotionStatus: (status: VoiceCallEmotionStatus) => void;
  onPlaybackEvent: (event: VoiceCallPlaybackEvent) => void;
  onSttStatus: (status: VoiceCallSTTStatus) => void;
  onTranscript: (event: VoiceCallTranscriptEvent) => void;
  onVad: (status: VoiceCallVADStatus) => void;
  sessionTicket: string;
  uplinkMode: Exclude<VoiceCallUplinkMode, 'auto'>;
  emotion2vecEnabled: boolean;
};

const CONNECT_TIMEOUT_MS = 5000;

function buildAudioStreamUrl(
  baseUrl: string,
  callId: string,
  sessionTicket: string,
  emotion2vecEnabled: boolean,
) {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  const url = new URL(normalized);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/api/voice-call/audio-stream';
  url.search = '';
  url.searchParams.set('callId', callId);
  url.searchParams.set('sessionTicket', sessionTicket);
  if (emotion2vecEnabled) url.searchParams.set('emotionEnabled', 'true');
  return url.toString();
}

export class VoiceCallAudioStream {
  private nativeInfo: NativeVoiceAudioStartResult | null = null;
  private nativeSubscription: EmitterSubscription | null = null;
  private pendingDiagnostics: string[] = [];
  private socket: WebSocket | null = null;
  private cancelConnect: (() => void) | null = null;
  private stopped = false;

  constructor(private readonly options: VoiceCallAudioStreamOptions) {}

  getNativeInfo() {
    return this.nativeInfo;
  }

  sendDiagnostic(
    event: string,
    details: Record<string, boolean | number | string | null | undefined> = {},
  ) {
    if (this.stopped) return;
    const local = appendVoiceCallDiagnostic(event, details, this.options.callId);
    const payload = JSON.stringify({
      type: 'diagnostic', event, details: filterVoiceCallDiagnosticDetails(details),
      at: local?.at ?? Date.now(), eventId: local?.eventId,
    });
    if (this.options.uplinkMode === 'native' && this.nativeInfo) {
      void sendNativeVoiceAudioText(payload);
      return;
    }
    if (this.socket?.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(payload);
      } catch {
        // Diagnostics must never interfere with the call itself.
      }
      return;
    }
    this.pendingDiagnostics.push(payload);
    if (this.pendingDiagnostics.length > 50) this.pendingDiagnostics.shift();
  }

  private flushDiagnostics() {
    if (this.options.uplinkMode === 'native' && this.nativeInfo) {
      for (const payload of this.pendingDiagnostics.splice(0)) {
        void sendNativeVoiceAudioText(payload);
      }
      return;
    }
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    for (const payload of this.pendingDiagnostics.splice(0)) {
      try {
        this.socket.send(payload);
      } catch {
        // The socket lifecycle remains authoritative; diagnostics are best effort.
      }
    }
  }

  async connect() {
    if (this.stopped) throw new VoiceCallAttemptCancelledError();
    if (this.socket) return;
    if (this.options.uplinkMode === 'native') {
      return;
    }
    const socket = new WebSocket(
      buildAudioStreamUrl(
        this.options.backendBaseUrl,
        this.options.callId,
        this.options.sessionTicket,
        this.options.emotion2vecEnabled,
      ),
    );
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        this.cancelConnect = null;
        action();
      };
      this.cancelConnect = () => finish(() => reject(new VoiceCallAttemptCancelledError()));
      timeout = setTimeout(() => finish(() => {
        socket.close();
        reject(new Error('麦克风状态通道连接超时。'));
      }), CONNECT_TIMEOUT_MS);
      socket.onerror = () => finish(() => reject(new Error('麦克风状态通道没有接上。')));
      socket.onclose = () => {
        if (!this.stopped) {
          finish(() => reject(new Error('麦克风状态通道提前断开。')));
          this.options.onError('麦克风状态通道断开了。');
          void this.stop();
        }
      };
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') this.handleServerMessage(event.data, finish, resolve);
      };
    });
  }

  async startNativeMicrophone() {
    if (this.stopped) throw new VoiceCallAttemptCancelledError();
    if (this.options.uplinkMode !== 'native') return null;
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      if (this.options.uplinkMode !== 'native') {
        throw new Error('麦克风状态通道还没有准备好。');
      }
    }
    const started = await startNativeVoiceAudio(
      buildAudioStreamUrl(
        this.options.backendBaseUrl,
        this.options.callId,
        this.options.sessionTicket,
        this.options.emotion2vecEnabled,
      ),
      (message) => this.handleServerMessage(message),
    );
    if (this.stopped) {
      started.subscription.remove();
      return null;
    }
    this.nativeInfo = started.info;
    this.nativeSubscription = started.subscription;
    this.flushDiagnostics();
    return started.info;
  }

  private handleServerMessage(
    message: string,
    finish?: (action: () => void) => void,
    resolve?: () => void,
  ) {
    if (this.stopped) return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(message) as Record<string, unknown>;
    } catch {
      return;
    }
    if (payload.type === 'ready') {
      this.flushDiagnostics();
      if (finish && resolve) finish(resolve);
      return;
    }
    if (payload.type === 'vad') {
      this.options.onVad(payload as unknown as VoiceCallVADStatus);
      return;
    }
    if (payload.type === 'stt_status') {
      this.options.onSttStatus(payload as unknown as VoiceCallSTTStatus);
      return;
    }
    if (payload.type === 'transcript') {
      this.options.onTranscript(payload as unknown as VoiceCallTranscriptEvent);
      return;
    }
    if (payload.type === 'emotion_status') {
      this.options.onEmotionStatus(payload as unknown as VoiceCallEmotionStatus);
      return;
    }
    if (payload.type === 'emotion_signal') {
      this.options.onEmotionSignal(payload as unknown as VoiceCallEmotionSignalEvent);
      return;
    }
    if (payload.type === 'voice_call_playback') {
      const event = normalizeVoiceCallPlaybackEvent(payload, this.options.callId);
      if (event) this.options.onPlaybackEvent(event);
      return;
    }
    if (payload.type === 'error' && !this.stopped) {
      this.options.onError(
        typeof payload.message === 'string' ? payload.message : '麦克风音频流暂时不可用。',
        typeof payload.code === 'string' ? payload.code : undefined,
      );
    }
  }

  async stop() {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelConnect?.();
    const subscription = this.nativeSubscription;
    this.nativeSubscription = null;
    this.nativeInfo = null;
    await stopNativeVoiceAudio(subscription).catch(() => undefined);
    const socket = this.socket;
    this.socket = null;
    this.pendingDiagnostics = [];
    if (socket?.readyState === WebSocket.OPEN) {
      try {
        socket.send(JSON.stringify({ type: 'end' }));
      } catch {
        // The close below remains authoritative.
      }
    }
    socket?.close();
  }
}
