import type { MusicSong } from '../ai/subjectiveMessages';
import type { JunLuoToolCall } from '../tools/toolTypes';
import type { MusicPlaybackObservation } from './musicPlaybackObservation';

export type MusicPlaybackObservationOwner = { call: JunLuoToolCall; dataEpoch: number };

/** One instance belongs to the live player, not to a card or React render. */
export function createMusicPlaybackObserver(
  save: (owner: MusicPlaybackObservationOwner, event: MusicPlaybackObservation) => void,
  now: () => number = Date.now,
) {
  let owner: MusicPlaybackObservationOwner | undefined;
  let song: MusicSong | undefined;
  let phase: 'playing' | 'paused' | 'stopped' | 'finished' = 'stopped';
  let sequence = 0;
  const emit = (action: MusicPlaybackObservation['action'], evidenceCallId?: string) => {
    if (!owner || !song) return;
    const event: MusicPlaybackObservation = {
      id: `${owner.call.callId}:playback:${++sequence}`, occurredAt: now(), action,
      songId: song.id, songName: song.name,
      ...(song.artist.trim() ? { artist: song.artist.trim() } : {}),
      ...(evidenceCallId ? { evidenceCallId } : {}),
    };
    save(owner, event);
  };
  return {
    confirmPlay(nextOwner: MusicPlaybackObservationOwner | undefined, nextSong: MusicSong) {
      if (nextOwner && owner?.call.callId === nextOwner.call.callId) return;
      owner = nextOwner;
      song = nextSong;
      phase = 'playing';
      sequence = 0;
      emit('play', owner?.call.callId);
    },
    observe(input: { isLoaded: boolean; playing: boolean; didJustFinish?: boolean;
      stopped?: boolean; evidenceCallId?: string }) {
      if (!owner || !song) return;
      if (input.stopped) {
        if (phase !== 'stopped') { phase = 'stopped'; emit('stop', input.evidenceCallId); }
      } else if (input.didJustFinish) {
        if (phase !== 'finished' && phase !== 'stopped') { phase = 'finished'; emit('finish'); }
      } else if (input.isLoaded && input.playing && phase !== 'playing') {
        phase = 'playing'; emit('resume', input.evidenceCallId);
      } else if (input.isLoaded && !input.playing && phase === 'playing') {
        phase = 'paused'; emit('pause', input.evidenceCallId);
      }
    },
  };
}
