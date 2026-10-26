import type { VoiceCallPlaybackEvent } from './voiceCallRoomClient';

const playbackStates = new Set(['started', 'completed', 'interrupted', 'failed']);
const playbackReasons = new Set(['user_started_speaking', 'call_ended', 'worker_failed']);

export function normalizeVoiceCallPlaybackEvent(
  payload: unknown,
  expectedCallId: string,
): VoiceCallPlaybackEvent | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const candidate = payload as Partial<VoiceCallPlaybackEvent> & {
    reason?: unknown;
    sourceTurnId?: unknown;
  };
  if (
    candidate.type !== 'voice_call_playback'
    || candidate.callId !== expectedCallId
    || typeof candidate.playbackId !== 'string'
    || !playbackStates.has(candidate.state ?? '')
    || typeof candidate.at !== 'number'
    || (
      candidate.sourceTurnId !== undefined
      && candidate.sourceTurnId !== null
      && typeof candidate.sourceTurnId !== 'string'
    )
    || (candidate.reason !== undefined && !playbackReasons.has(candidate.reason))
  ) return null;
  return {
    ...candidate,
    sourceTurnId: typeof candidate.sourceTurnId === 'string'
      ? candidate.sourceTurnId
      : undefined,
  } as VoiceCallPlaybackEvent;
}
