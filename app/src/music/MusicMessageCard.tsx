import { Image, Pressable, StyleSheet, View } from 'react-native';

import type { MessageMusicCard, MusicSong } from '../ai/subjectiveMessages';
import { AppText as Text } from '../components/AppText';
import type { MusicControlAction } from '../tools/musicPlaybackBridge';

type Props = {
  card: MessageMusicCard;
  currentSongId?: string;
  isPlaying?: boolean;
  onRetry: () => void;
  onError: (message: string) => void;
  onControl: (action: MusicControlAction) => Promise<void>;
  onPlaySong: (song: MusicSong) => Promise<void>;
  showCandidates?: boolean;
};

function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

export function MusicMessageCard({ card, currentSongId, isPlaying, onControl, onError, onPlaySong, onRetry, showCandidates = true }: Props) {
  const song = card.song;
  const isCurrent = !!song && currentSongId === song.id;
  const playing = isCurrent && isPlaying === true;
  const candidates = showCandidates
    ? (card.candidates || []).filter((candidate) => candidate.id !== song?.id).slice(0, 3)
    : [];

  const play = async (nextSong: MusicSong) => {
    try {
      await onPlaySong(nextSong);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : '歌曲暂时播放不了。');
    }
  };

  const toggleCurrent = async () => {
    try {
      if (!isCurrent) return await onPlaySong(song!);
      await onControl(playing ? 'pause' : 'resume');
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : 'EXECUTION_FAILED');
    }
  };

  if (card.status === 'loading') {
    return (
      <View style={styles.card}>
        <View style={styles.loadingDisc}><Text style={styles.note}>♪</Text></View>
        <View style={styles.mainText}>
          <Text style={styles.eyebrow}>我正在找歌</Text>
          <Text numberOfLines={1} style={styles.keyword}>{card.keyword}</Text>
        </View>
      </View>
    );
  }

  if (card.status === 'error' || !song) {
    return (
      <View style={styles.card}>
        <View style={styles.loadingDisc}><Text style={styles.note}>♪</Text></View>
        <View style={styles.mainText}>
          <Text style={styles.eyebrow}>这首歌暂时没找到</Text>
          <Text style={styles.errorText}>{card.error || '可以稍后再试一次。'}</Text>
        </View>
        <Pressable onPress={onRetry} style={styles.retryButton}><Text style={styles.retryText}>重试</Text></Pressable>
      </View>
    );
  }

  return (
    <View style={styles.readyCard}>
      <View style={styles.primaryRow}>
        {song.cover ? <Image source={{ uri: song.cover }} style={styles.cover} /> : <View style={styles.loadingDisc}><Text style={styles.note}>♪</Text></View>}
        <View style={styles.mainText}>
          <Text numberOfLines={1} style={styles.songName}>{song.name}</Text>
          <Text numberOfLines={1} style={styles.songMeta}>{song.artist} · {song.album}</Text>
          {card.duplicateAvoided ? (
            <Text numberOfLines={1} style={styles.avoidanceText}>避开了刚点过的歌</Text>
          ) : null}
          {card.error ? <Text numberOfLines={2} style={styles.errorText}>{card.error}</Text> : null}
          <Text style={styles.duration}>{formatDuration(song.duration)}</Text>
        </View>
        <Pressable accessibilityLabel={playing ? '暂停歌曲' : '播放歌曲'} onPress={() => void toggleCurrent()} style={styles.playButton}>
          <Text style={styles.playText}>{playing ? 'Ⅱ' : '▶'}</Text>
        </Pressable>
      </View>
      {candidates.length ? (
        <View style={styles.candidateList}>
          <Text style={styles.candidateTitle}>不是这首？</Text>
          {candidates.map((candidate) => (
            <Pressable key={candidate.id} onPress={() => void play(candidate)} style={styles.candidateRow}>
              <Text numberOfLines={1} style={styles.candidateName}>{candidate.name}</Text>
              <Text numberOfLines={1} style={styles.candidateMeta}>{candidate.artist}</Text>
              <Text style={styles.candidatePlay}>▶</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 8,
    borderRadius: 18,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,250,247,0.93)',
    borderWidth: 1,
    borderColor: 'rgba(233,216,208,0.86)',
  },
  readyCard: {
    marginTop: 8,
    borderRadius: 20,
    padding: 12,
    backgroundColor: 'rgba(255,250,247,0.95)',
    borderWidth: 1,
    borderColor: 'rgba(233,216,208,0.88)',
  },
  primaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  loadingDisc: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F1E0D8',
  },
  note: {
    color: '#C87564',
    fontSize: 21,
  },
  cover: {
    width: 54,
    height: 54,
    borderRadius: 15,
    backgroundColor: '#E9EEF1',
  },
  mainText: {
    flex: 1,
    paddingHorizontal: 10,
  },
  eyebrow: {
    color: '#71818D',
    fontSize: 11,
  },
  keyword: {
    color: '#435463',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 4,
  },
  songName: {
    color: '#40515F',
    fontSize: 15,
    fontWeight: '800',
  },
  songMeta: {
    color: '#7D8C96',
    fontSize: 11,
    marginTop: 3,
  },
  duration: {
    color: '#A4ADB2',
    fontSize: 10,
    marginTop: 3,
  },
  avoidanceText: {
    color: '#C86655',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 3,
  },
  playButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F3D4CA',
  },
  playText: {
    color: '#C86655',
    fontWeight: '800',
  },
  candidateList: {
    marginTop: 10,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: 'rgba(220,204,196,0.64)',
  },
  candidateTitle: {
    color: '#8B9AA3',
    fontSize: 11,
    marginBottom: 5,
  },
  candidateRow: {
    minHeight: 30,
    borderRadius: 10,
    paddingHorizontal: 8,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(246,239,235,0.72)',
    marginTop: 5,
  },
  candidateName: {
    flex: 1.1,
    color: '#526371',
    fontSize: 12,
    fontWeight: '700',
  },
  candidateMeta: {
    flex: 0.9,
    color: '#82909A',
    fontSize: 11,
    marginLeft: 6,
  },
  candidatePlay: {
    color: '#C86655',
    fontSize: 12,
    fontWeight: '800',
    marginLeft: 8,
  },
  errorText: {
    color: '#9A7770',
    fontSize: 11,
    lineHeight: 16,
    marginTop: 3,
  },
  retryButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 14,
    backgroundColor: '#EEF4F7',
  },
  retryText: {
    color: '#66859D',
    fontSize: 12,
    fontWeight: '700',
  },
});
