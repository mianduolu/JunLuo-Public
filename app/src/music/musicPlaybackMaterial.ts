import { loadRecentToolCalls } from '../tools/toolAuditStore';
import { innerMaterialKey } from '../chat/chatAfterglowState';
import { formatChatAfterglowMessageTime } from '../chat/chatAfterglowProbe';
import { normalizeMusicPlaybackObservations, type MusicPlaybackObservation } from './musicPlaybackObservation';

export type MusicPlaybackMaterialEvent = {
  id: string; createdAt: number; revision: string; observation: MusicPlaybackObservation;
};
type Reference = { id: string; createdAt: number; revision: string };
const prefix = 'music-playback:';
export const isMusicPlaybackMaterialId = (id: string) => id.startsWith(prefix);
const actions = { play: '开始播放', pause: '暂停播放', resume: '继续播放', stop: '停止播放', finish: '播放结束' };

async function loadEvents(): Promise<MusicPlaybackMaterialEvent[]> {
  const records = await loadRecentToolCalls(200);
  const events = normalizeMusicPlaybackObservations(records.flatMap(record => record.musicPlayback ?? []));
  return events.map(observation => ({ id: `${prefix}${observation.id}`, createdAt: observation.occurredAt,
    revision: innerMaterialKey(observation), observation }));
}

export async function prepareMusicPlaybackMaterial(input: {
  from: number; through: number; read?: Record<string, string>;
  refs?: readonly Reference[]; excludeToolCallIds?: readonly string[];
}): Promise<MusicPlaybackMaterialEvent[]> {
  const events = await loadEvents();
  // Retries use precisely the originally selected events, never a newly appended player state.
  if (input.refs) return input.refs.filter(ref => isMusicPlaybackMaterialId(ref.id)).flatMap(ref => {
    const event = events.find(item => item.id === ref.id && item.revision === ref.revision && item.createdAt === ref.createdAt);
    return event ? [event] : [];
  });
  if (!Number.isFinite(input.from) || !Number.isFinite(input.through) || input.through < input.from) return [];
  const eligible = events.filter(event => event.createdAt <= input.through);
  const notProvided = (event: MusicPlaybackMaterialEvent) => input.read?.[event.id] !== event.revision
    && !(event.observation.evidenceCallId && input.excludeToolCallIds?.includes(event.observation.evidenceCallId));
  const preceding = eligible.filter(event => event.createdAt < input.from).slice(-1).filter(notProvided);
  const current = eligible.filter(event => event.createdAt >= input.from).filter(notProvided);
  return [...preceding, ...current].slice(-6);
}

export function formatMusicPlaybackMaterial(events: readonly MusicPlaybackMaterialEvent[]): string {
  if (!events.length) return '';
  return `【听歌记录】\n\n${events.map(({ observation: event }) =>
    `${formatChatAfterglowMessageTime(event.occurredAt)}｜${actions[event.action]}：《${event.songName}》${event.artist ? `—${event.artist}` : ''}`
  ).join('\n')}`;
}

export function musicPlaybackMaterialRefs(events: readonly MusicPlaybackMaterialEvent[]) {
  return events.map(({ id, createdAt, revision }) => ({ kind: 'life' as const, id, createdAt, revision }));
}

export async function musicPlaybackMaterialSourcesMatch(refs: readonly Reference[]): Promise<boolean> {
  const music = refs.filter(ref => isMusicPlaybackMaterialId(ref.id));
  if (!music.length) return true;
  const events = await loadEvents();
  return music.every(ref => events.some(event => event.id === ref.id && event.revision === ref.revision && event.createdAt === ref.createdAt));
}
