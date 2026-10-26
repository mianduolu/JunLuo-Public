import type { JunLuoToolInvocation } from './toolCallProtocol';
import type { JunLuoToolResult } from './toolTypes';

const MUSIC_AGENT_TOOL_IDS = new Set([
  'music.search_candidates',
  'music.play',
  'music.control',
]);

export function isMusicAgentToolId(toolId: string) {
  return MUSIC_AGENT_TOOL_IDS.has(toolId);
}

export function projectMusicAgentResultForModel(
  invocation: Pick<JunLuoToolInvocation, 'toolId'>,
  fullResult: JunLuoToolResult,
): JunLuoToolResult {
  if (!isMusicAgentToolId(invocation.toolId)) return fullResult;
  if (!fullResult.ok) return { ...fullResult, summary: '', data: undefined };
  const data = asRecord(fullResult.data);
  if (!data) return { ...fullResult, summary: '', data: undefined };
  if (invocation.toolId === 'music.search_candidates') {
    return {
      ...fullResult,
      summary: '',
      data: compactRecord({
        song: projectSong(data.song, true),
        candidates: projectSongs(data.candidates),
        duplicateAvoided: data.duplicateAvoided,
      }),
    };
  }
  if (invocation.toolId === 'music.play') {
    return {
      ...fullResult,
      summary: '',
      data: compactRecord({
        song: projectSong(data.song ?? data),
        playbackState: data.playbackState,
        confirmedAt: data.confirmedAt,
      }),
    };
  }
  return {
    ...fullResult,
    summary: '',
    data: compactRecord({
      action: data.action,
      playbackState: data.playbackState,
      currentSong: projectSong(data.currentSong),
      confirmedAt: data.confirmedAt,
    }),
  };
}

function projectSongs(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map(song => projectSong(song, true))
    .filter((song): song is Record<string, unknown> => !!song);
}

function projectSong(value: unknown, includeId = false) {
  const song = asRecord(value);
  if (!song) return undefined;
  return compactRecord({
    id: includeId ? song.id : undefined,
    name: song.name,
    artist: song.artist,
    album: song.album,
    duration: song.duration,
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function compactRecord(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined),
  );
}
