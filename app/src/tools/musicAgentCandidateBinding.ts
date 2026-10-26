import type { MusicSong } from '../ai/subjectiveMessages';
import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { JunLuoToolResult } from './toolTypes';

export type MusicAgentCandidateBinding = {
  rememberSearchResult: (result: JunLuoToolResult) => void;
  bindPlayInvocation: (invocation: JunLuoToolInvocation) =>
    | { kind: 'ready'; input: Record<string, unknown>; song: MusicSong }
    | { kind: 'rejected' };
  listCandidateIds: () => string[];
};

function readMusicSong(value: unknown): MusicSong | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const song = value as Record<string, unknown>;
  if (typeof song.id !== 'string' || !song.id.trim()) return undefined;
  if (typeof song.name !== 'string' || !song.name.trim()) return undefined;
  return {
    id: song.id.trim(),
    name: song.name.trim(),
    artist: typeof song.artist === 'string' ? song.artist : '',
    album: typeof song.album === 'string' ? song.album : '',
    cover: typeof song.cover === 'string' ? song.cover : '',
    duration: typeof song.duration === 'number' && Number.isFinite(song.duration)
      ? song.duration
      : 0,
  };
}

export function createMusicAgentCandidateBinding(): MusicAgentCandidateBinding {
  const candidates = new Map<string, MusicSong>();
  return {
    rememberSearchResult(result) {
      if (!result.ok || result.toolId !== 'music.search_candidates') return;
      const data = result.data as Record<string, unknown> | undefined;
      const songs = [
        readMusicSong(data?.song),
        ...(Array.isArray(data?.candidates) ? data.candidates.map(readMusicSong) : []),
      ].filter((song): song is MusicSong => !!song);
      songs.forEach((song) => candidates.set(song.id, song));
    },
    bindPlayInvocation(invocation) {
      if (invocation.toolId !== 'music.play') return { kind: 'rejected' };
      const requested = readMusicSong(invocation.input.song);
      if (!requested) return { kind: 'rejected' };
      const canonical = candidates.get(requested.id);
      if (!canonical) return { kind: 'rejected' };
      return {
        kind: 'ready',
        input: { ...invocation.input, song: { ...canonical } },
        song: { ...canonical },
      };
    },
    listCandidateIds() {
      return [...candidates.keys()];
    },
  };
}
