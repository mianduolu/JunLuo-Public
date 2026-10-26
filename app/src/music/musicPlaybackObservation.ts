/** Persisted facts only. Never store a stream URL, audio, lyrics or a model judgement. */
export type MusicPlaybackObservation = {
  id: string;
  occurredAt: number;
  action: 'play' | 'pause' | 'resume' | 'stop' | 'finish';
  songId: string;
  songName: string;
  artist?: string;
  evidenceCallId?: string;
};

const actions = new Set(['play', 'pause', 'resume', 'stop', 'finish']);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : undefined;

export function normalizeMusicPlaybackObservations(value: unknown): MusicPlaybackObservation[] {
  if (!Array.isArray(value)) return [];
  const events = new Map<string, MusicPlaybackObservation>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || !text(item.id) || !text(item.songId)
      || !text(item.songName) || !actions.has(item.action)
      || !Number.isSafeInteger(item.occurredAt) || item.occurredAt < 0) continue;
    const event: MusicPlaybackObservation = {
      id: item.id.trim(), occurredAt: item.occurredAt, action: item.action,
      songId: item.songId.trim(), songName: item.songName.trim(),
      ...(text(item.artist) ? { artist: text(item.artist) } : {}),
      ...(text(item.evidenceCallId) ? { evidenceCallId: text(item.evidenceCallId) } : {}),
    };
    const prior = events.get(event.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(event)) throw new Error('MUSIC_OBSERVATION_ID_CONFLICT');
    events.set(event.id, event);
  }
  return [...events.values()].sort((a, b) => a.occurredAt - b.occurredAt || a.id.localeCompare(b.id));
}

export function mergeMusicPlaybackObservations(
  left?: readonly MusicPlaybackObservation[], right?: readonly MusicPlaybackObservation[],
) {
  return normalizeMusicPlaybackObservations([...(left ?? []), ...(right ?? [])]);
}

export function musicPlaybackObservationsEqual(
  left?: readonly MusicPlaybackObservation[], right?: readonly MusicPlaybackObservation[],
) {
  return JSON.stringify(normalizeMusicPlaybackObservations(left)) === JSON.stringify(normalizeMusicPlaybackObservations(right));
}
