import type { MusicPlaybackState } from './musicPlaybackBridge';
import type { JunLuoRegisteredToolDefinition } from './toolTypes';

export function chatMusicPlayDefinition(tool: JunLuoRegisteredToolDefinition): JunLuoRegisteredToolDefinition {
  return {
    ...tool,
    description: 'I 想把一首歌和 you 一起听。I 选好歌，把歌名和歌手或演奏者填在这里，交给播放器去找。等结果回来，I 再接着和 you 聊。',
    inputSchema: {
      type: 'object',
      required: ['title', 'artist'],
      properties: {
        title: { type: 'string', description: 'I 想递给 you 的那首歌叫什么。' },
        artist: { type: 'string', description: '这首歌是谁唱的，或是谁演奏的。' },
      },
    },
  };
}

export function chatMusicSearchKeyword(input: Record<string, unknown>) {
  if (Object.keys(input).some((key) => key !== 'title' && key !== 'artist')) return undefined;
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const artist = typeof input.artist === 'string' ? input.artist.trim() : '';
  return title && artist ? `${title} ${artist}` : undefined;
}

export type MusicAgentPreferenceSnapshot = {
  musicEnabled: boolean;
  musicAutoplay: boolean;
  musicMultipleCardsEnabled: boolean;
};

export type MusicAgentPlaybackContext = {
  currentSongId?: string;
  currentState: MusicPlaybackState;
  hasUniqueRecentMusicCard: boolean;
};
